"""Strategy catalog: params, declared param ranges, and a hot-reload hook so
a strategy edited in the editor (the private, gitignored modules under
``strategies/``) appears without restarting the server.
"""

from __future__ import annotations

import inspect

from fastapi import APIRouter, HTTPException

from core.registry import reload_package
from core.params import resolve_space, spec_to_json
from strategies import Strategy, discover_strategies, load_registered_strategy

from web.jobs import manager as job_manager
from web.serialize import jsonable

router = APIRouter(prefix='/api/strategies', tags=['strategies'])


def _describe(key: str, cls: type) -> dict:
    """One catalog entry. Never raises for a badly declared class.

    Every field below is one a user typed, and ``space = 5`` or
    ``space = {'period': (2, 100)}`` raises ``TypeError`` on the way out.
    Letting that through 500'd the whole list and emptied the backtest form's
    dropdown over one private file. Failures land in ``space_error`` /
    ``errors`` instead, the same bargain ``web.routers.indicators._describe``
    makes.

    ``space`` lists exactly the tunable params: the ones the backtest form
    offers to edit. A ``space`` that cannot be read is in ``errors`` too, so
    the form lists the strategy disabled with the reason: the panel shows
    ``errors`` and nothing else, and a form missing the fields the author
    declared would give no hint why.
    """
    try:
        space = {k: spec_to_json(v) for k, v in resolve_space(cls).items()}
        space_error = None
    except ValueError as e:
        space, space_error = {}, str(e)
    except Exception as e:  # noqa: BLE001 -- a malformed declaration, not our bug
        space, space_error = {}, f'{cls.__name__}.space: {type(e).__name__}: {e}'

    errors: list = [space_error] if space_error else []

    def _safe(label: str, fn, fallback):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001 -- user declaration, not our bug
            errors.append(f'{cls.__name__}.{label}: {type(e).__name__}: {e}')
            return fallback

    return {
        'key': key,
        'class_name': cls.__name__,
        'module': cls.__module__,
        'file': _safe('file', lambda: inspect.getfile(cls), ''),
        'docstring': inspect.getdoc(cls) or '',
        'params': _safe('params', lambda: dict(getattr(cls, 'params', {}) or {}), {}),
        'space': space,
        'space_error': space_error,
        'errors': errors,
    }


def _broken_entry(module_name: str, message: str, taken: set) -> dict:
    """A module that would not import, or whose class clashed with another's
    short name, as a catalog entry the form shows disabled with its error.

    Without it the strategy just vanishes from the dropdown, and whoever saved
    the typo has nowhere to read why. Keyed like
    ``web.routers.indicators._broken_entry``: by the short module name, or the
    dotted one when a healthy class already holds that key.
    """
    short = module_name.rsplit('.', 1)[-1]
    return {
        'key': module_name if short in taken else short,
        'class_name': '',
        'module': module_name,
        'file': '',
        'docstring': '',
        'params': {},
        'space': {},
        'space_error': None,
        'errors': [message],
    }


@router.get('')
def list_strategies():
    import_errors: dict = {}
    found = discover_strategies(errors=import_errors)
    entries = [_describe(key, cls) for key, cls in sorted(found.items())]
    entries.extend(
        _broken_entry(mod, msg, set(found)) for mod, msg in sorted(import_errors.items())
    )
    return entries


@router.get('/{key}')
def get_strategy(key: str):
    try:
        cls = load_registered_strategy(key)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    return _describe(key, cls)


@router.post('/reload')
def reload_strategies():
    """Re-import every module under ``strategies/``.

    The job check and the reload run inside ``hold_starts``, as a registry
    write does in ``web.routers.products``: checked on its own, a backtest
    submitted between the check and the reload could still start mid-reload.

    ``strategies.base`` is kept (editing the shared framework module, unlike
    a strategy, needs a restart), and a renamed or deleted strategy class
    really goes away -- see ``reload_package`` for both. A module that fails
    to import, or clashes with another's short name, is reported in
    ``failed`` rather than 500ing the reload with no message at all.
    """
    failed: dict = {}

    def record(mod_name: str, exc: Exception) -> None:
        failed[mod_name] = f'{type(exc).__name__}: {exc}'

    with job_manager.hold_starts():
        if job_manager.any_active():
            raise HTTPException(
                status_code=409,
                detail='A job is running; reloading strategy modules mid-run could '
                       'swap the class object out from under it.',
            )
        reload_package('strategies', Strategy, on_error=record)

    # Discovery re-tries a module that failed above (it is out of
    # `sys.modules`), so only add what it found that the reload did not --
    # a name clash, which only shows up once the classes are compared.
    discovery_errors: dict = {}
    found = discover_strategies(errors=discovery_errors)
    for mod_name, message in discovery_errors.items():
        failed.setdefault(mod_name, message)
    return jsonable({'reloaded': True, 'strategies': sorted(found), 'failed': failed})
