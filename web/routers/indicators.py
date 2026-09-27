"""Indicator catalog and values for the chart.

Two kinds of route live here, which is why the prefix is ``/api`` rather than
``/api/indicators``: the catalog sits under ``/api/indicators``, but the values
route is addressed by *product* (``/api/products/{code}/indicators/{key}``) and
could not sit under an indicators prefix.

Values are computed standalone, off the same ``DataManager`` frame the chart's
candles come from -- no backtest, no engine. See ``indicators/base.py`` for the
class contract and ``docs/indicator.md`` for the user-facing version.
"""

from __future__ import annotations

import inspect

import numpy as np
from fastapi import APIRouter, HTTPException, Query

from datafeed.products import PRODUCTS, normalize_symbol
from indicators import discover_indicators, load_registered_indicator
from indicators.base import (
    Indicator,
    IndicatorContext,
    declared_outputs,
    describe_errors,
    output_json,
    value_range_json,
)

from core.params import parse_param_value, resolve_space, spec_to_json, validated_overrides
from core.registry import reload_package

from web.barscache import cache as bars_cache
from web.serialize import jsonable

router = APIRouter(prefix='/api', tags=['indicators'])

#: Caps on the override query string. Not a security boundary on their own --
#: ``validated_overrides`` bounds every *value* against the class's declared
#: ``space``, which is what actually stops a huge period reaching TA-Lib --
#: but they keep a pathological URL from being parsed at all.
MAX_PARAMS = 32
MAX_RAW = 128


def _describe(key: str, cls: type) -> dict:
    """One catalog entry. Never raises for a badly declared class.

    ``list_indicators`` has to keep working while the user is halfway through
    editing one, so every per-class failure lands in ``errors`` (or
    ``space_error``) and the entry is still returned -- the same bargain
    ``web.routers.strategies._describe`` makes with ``resolve_space``.
    """
    try:
        space = {k: spec_to_json(v) for k, v in resolve_space(cls).items()}
        space_error = None
    except ValueError as e:  # a `space` key that is not in `params`
        space, space_error = {}, str(e)
    except Exception as e:  # noqa: BLE001 -- e.g. `space = {'period': (2, 100)}`
        space, space_error = {}, f'{cls.__name__}.space: {type(e).__name__}: {e}'

    # Everything below reads attributes a user typed, so each coercion that
    # could fail on a wrong type is wrapped. The whole point of this function
    # is that one badly declared class costs one entry -- an exception escaping
    # here would 500 the catalog and take every healthy indicator off the
    # picker with it.
    def _safe(label: str, fn, fallback):
        nonlocal errors
        try:
            return fn()
        except Exception as e:  # noqa: BLE001 -- user declaration, not our bug
            errors.append(f'{cls.__name__}.{label}: {type(e).__name__}: {e}')
            return fallback

    errors: list = []
    try:
        errors = describe_errors(cls)
    except Exception as e:  # noqa: BLE001
        errors = [f'{cls.__name__}: {type(e).__name__}: {e}']
    # The picker shows `errors`, not `space_error`: without this a typo in
    # `space` just leaves the row with no editable params and no reason.
    if space_error:
        errors.append(space_error)

    return {
        'key': key,
        'label': _safe('label', lambda: str(getattr(cls, 'label', '') or '') or key.replace('_', ' ').upper(), key),
        'class_name': cls.__name__,
        'module': cls.__module__,
        'file': _safe('file', lambda: inspect.getfile(cls), ''),
        'docstring': inspect.getdoc(cls) or '',
        'pane': 'sub' if getattr(cls, 'pane', 'main') == 'sub' else 'main',
        'precision': _safe('precision', lambda: int(getattr(cls, 'precision', 2)), 2),
        'value_range': _safe('value_range', lambda: value_range_json(cls), None),
        'guides': _safe('guides', lambda: [float(g) for g in getattr(cls, 'guides', ()) or ()], []),
        'outputs': _safe('outputs', lambda: [output_json(o) for o in declared_outputs(cls)], []),
        'params': _safe('params', lambda: dict(getattr(cls, 'params', {}) or {}), {}),
        'space': space,
        'space_error': space_error,
        'errors': errors,
    }


def _broken_entry(module_name: str, message: str, taken: set) -> dict:
    """A module that would not even import, or whose class clashed with
    another's short name, rendered as a catalog entry.

    Shown disabled in the picker. Without this the module simply vanishes, and
    a user who just introduced a typo sees their indicator silently disappear
    with nowhere to read why.

    Keyed by the short module name, so a broken ``ma.py`` sits where ``Ma``
    sat, still ticked if it was ticked -- unless a working class already holds
    that key (``taken``), as it can when the module's *other* classes are
    fine. Then the dotted module name, which no class key can ever be: the
    picker keys its rows and checkboxes on this, and two rows sharing one
    would tick and untick together.
    """
    short = module_name.rsplit('.', 1)[-1]
    key = module_name if short in taken else short
    return {
        'key': key,
        'label': short.replace('_', ' ').upper(),
        'class_name': '',
        'module': module_name,
        'file': '',
        'docstring': '',
        'pane': 'main',
        'precision': 2,
        'value_range': None,
        'guides': [],
        'outputs': [],
        'params': {},
        'space': {},
        'space_error': None,
        'errors': [message],
    }


def _catalog() -> list:
    import_errors: dict = {}
    found = discover_indicators(errors=import_errors)
    entries = [_describe(key, cls) for key, cls in sorted(found.items())]
    entries.extend(
        _broken_entry(mod, msg, set(found)) for mod, msg in sorted(import_errors.items())
    )
    return entries


@router.get('/indicators')
def list_indicators():
    return jsonable(_catalog())


@router.get('/indicators/{key}')
def get_indicator(key: str):
    try:
        cls = load_registered_indicator(key)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    return jsonable(_describe(key, cls))


@router.post('/indicators/reload')
def reload_indicators():
    """Re-import every module under ``indicators/`` so an edit shows up
    without restarting the server.

    Deliberately *not* guarded by the ``any_active()`` 409 that
    ``strategies/reload`` uses. That guard exists because a running backtest
    holds a ``Strategy`` class object and reloading would swap it mid-run;
    nothing holds an ``Indicator`` across a request, so refusing while a data
    download happens to be running would be a restriction with no reason
    behind it.

    ``indicators.base`` is kept, and a renamed or deleted class really goes
    away -- see :func:`core.registry.reload_package` for both. A module that
    fails to import is reported in ``failed`` rather than 500ing the reload,
    and stays out of ``sys.modules``, so the catalog reports it broken rather
    than going on drawing the pre-edit version -- the opposite of what someone
    clicking Reload is asking for.
    """
    failed: dict = {}

    def record(mod_name: str, exc: Exception) -> None:
        failed[mod_name] = f'{type(exc).__name__}: {exc}'

    reload_package('indicators', Indicator, on_error=record)

    found = discover_indicators()
    return jsonable({'reloaded': True, 'indicators': sorted(found), 'failed': failed})


# ---------------------------------------------------------------------
# Values
# ---------------------------------------------------------------------

def _overrides(cls: type, raw_list: list) -> dict:
    """``['fast=12', 'slow=26']`` -> ``{'fast': 12, 'slow': 26}``, validated.

    The token is literally the ``--param name=value`` CLI token and goes
    through the same ``parse_param_value``, so the two paths cannot drift in
    how they cast a value. What differs is what happens to an *unknown* name:
    ``core.params.resolve_params`` warns and passes it through, which is
    right for an argv already running as the user, but over HTTP an unknown key
    is a typo or a probe. The bounds themselves live in
    ``core.params.validated_overrides``, shared with the backtest route.
    """
    if not raw_list:
        return {}
    if len(raw_list) > MAX_PARAMS:
        raise HTTPException(status_code=422, detail=f'At most {MAX_PARAMS} param overrides')

    parsed: dict = {}
    for raw in raw_list:
        if len(raw) > MAX_RAW:
            raise HTTPException(status_code=422, detail='Param override is too long')
        try:
            name, value = parse_param_value(raw)
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
        parsed[name] = value

    try:
        return validated_overrides(cls, parsed)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


def _series_json(cls: type, key: str, array, n_bars: int) -> dict:
    """One output's values plus where its warmup ends.

    Validated structurally -- length and dtype -- and not with
    ``core.indicators.guard``. ``guard`` rejects a NaN *inside* the series
    because the engine assumes density after warmup and would otherwise trade
    off a hole; a chart has no such assumption, and a hole drawn as a hole is
    both correct and informative. See ``SetupContext.add_indicator``'s
    ``allow_gaps`` note for the same distinction from the other side.
    """
    try:
        arr = np.asarray(array, dtype='float64')
    except (TypeError, ValueError) as e:
        raise HTTPException(
            status_code=422,
            detail=f'{cls.__name__}.{key} did not return numbers: {e}',
        ) from e
    if arr.shape != (n_bars,):
        raise HTTPException(
            status_code=422,
            detail=f'{cls.__name__}.{key} returned shape {arr.shape}, expected ({n_bars},)',
        )

    valid = ~np.isnan(arr)
    # `null` rather than 0 when nothing is valid: the UI tells the user the
    # window is longer than the loaded range, instead of drawing a blank pane.
    valid_from = int(np.argmax(valid)) if valid.any() else None
    return {'values': arr, 'valid_from': valid_from}


@router.get('/products/{code}/indicators/{key}')
def product_indicator(
    code: str,
    key: str,
    start: str = None,
    end: str = None,
    p: list[str] = Query(default_factory=list),
):
    """Indicator values for one product, over the same bars the chart draws.

    Overrides arrive as repeated ``p=name=value``. Namespacing them under one
    key (rather than accepting bare ``?fast=12``) keeps them declarable to
    FastAPI and means a param can never collide with ``start``/``end`` or
    anything reserved later.
    """
    code = normalize_symbol(code)
    if code not in PRODUCTS:
        raise HTTPException(status_code=404, detail=f'Unknown product {code!r}')

    try:
        cls = load_registered_indicator(key)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e

    params = _overrides(cls, p)

    try:
        df = bars_cache.get(code, start, end)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    ctx = IndicatorContext(df, code)
    # Wrapped narrowly around the user's own code, and reported as a 422 with
    # their exception's message: they wrote this five seconds ago and the
    # message is their feedback loop, not something to bury in a traceback.
    try:
        computed = cls(**params).compute(ctx, code)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(
            status_code=422,
            detail=f'{cls.__name__}.compute raised {type(e).__name__}: {e}',
        ) from e

    if not isinstance(computed, dict):
        raise HTTPException(
            status_code=422,
            detail=f'{cls.__name__}.compute returned {type(computed).__name__}, expected a dict',
        )

    n_bars = len(df)
    outputs = {}
    for out in declared_outputs(cls):
        if out.key not in computed:
            raise HTTPException(
                status_code=422,
                detail=f'{cls.__name__} declares output {out.key!r} but compute '
                       f'returned {sorted(computed)}',
            )
        outputs[out.key] = _series_json(cls, out.key, computed[out.key], n_bars)

    return jsonable({
        'symbol': code,
        'indicator': key,
        'params': {**dict(getattr(cls, 'params', {}) or {}), **params},
        # Dates travel with the values so the chart can align by date rather
        # than by position: bars and values are two requests with independently
        # defaulted start/end, and positional alignment would misplace every
        # point by a row the first time they disagreed.
        'dates': [str(d.date()) for d in df.index],
        'outputs': outputs,
    })
