"""Declarative parameter ranges, and the helpers that read them.

Deliberately stdlib-only so ``strategies/`` and ``indicators/`` can import it
freely. A ``Strategy`` or ``Indicator`` subclass declares the range each param
is plausible over with a class-level
``space: dict[str, Int | Float | Categorical]`` alongside its ``params``
defaults. The web panel lists those ranges in its catalogs and refuses a
param override — from an indicator URL or a backtest request — that falls
outside them. ``validated_overrides`` is that check.

A param listed in ``space`` is tunable; one that is not stays at its
default for every web request. Nothing here knows about any concrete class --
``resolve_space`` works off ``params`` / ``space`` alone, so it applies
unchanged to anything ``strategies.discover_strategies()`` or the indicator
registry finds.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from typing import Tuple, Union

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Int:
    low: int
    high: int
    step: int = 1
    log: bool = False


@dataclass(frozen=True)
class Float:
    low: float
    high: float
    step: float | None = None
    log: bool = False


@dataclass(frozen=True)
class Categorical:
    choices: Tuple[object, ...]

    def __init__(self, choices):
        object.__setattr__(self, 'choices', tuple(choices))


Spec = Union[Int, Float, Categorical]


def spec_to_json(spec: Spec) -> dict:
    """Render one range spec as a JSON-safe dict.

    Shared by the web panel's strategy and indicator catalogs, so every place a
    parameter surface is shown describes it identically.
    """
    if isinstance(spec, Int):
        return {'kind': 'int', 'low': spec.low, 'high': spec.high, 'step': spec.step, 'log': spec.log}
    if isinstance(spec, Float):
        return {'kind': 'float', 'low': spec.low, 'high': spec.high, 'step': spec.step, 'log': spec.log}
    if isinstance(spec, Categorical):
        return {'kind': 'categorical', 'choices': list(spec.choices)}
    raise TypeError(f'Unknown space spec: {spec!r}')


def resolve_space(cls: type) -> dict:
    """``{param_name: Spec}`` for the tunable params of ``cls``, in ``params``
    order.

    Only what ``space`` declares. An empty result is not an error: a class
    with no tunable params simply runs at its defaults. A ``space`` key with
    no matching ``params`` entry raises ``ValueError``: it is nearly always a
    typo, and dropping it would quietly pin the param the author meant to
    tune.
    """
    declared = dict(getattr(cls, 'space', {}) or {})
    defaults = dict(getattr(cls, 'params', {}) or {})
    unknown = [name for name in declared if name not in defaults]
    if unknown:
        raise ValueError(
            f'{cls.__name__}.space names {", ".join(map(repr, unknown))}, not in '
            f'`params` ({", ".join(map(repr, defaults)) or "none"}); fix the name '
            f'or give it a default'
        )
    return {name: declared[name] for name in defaults if name in declared}


def check_constraints(cls: type, params: dict) -> bool:
    """True iff every ``cls.constraints`` predicate accepts ``params``."""
    return all(fn(params) for fn in (getattr(cls, 'constraints', ()) or ()))


# ---------------------------------------------------------------------
# Concrete parameter *values* (as opposed to the ranges above)
# ---------------------------------------------------------------------

def parse_param_value(raw: str) -> tuple:
    """Parse one ``--param name=value`` CLI token into ``(name, value)``,
    casting the value to int, then float, then bool, else leaving it a string.
    """
    if '=' not in raw:
        raise ValueError(f"Invalid --param {raw!r}; expected name=value")
    name, value = raw.split('=', 1)
    for caster in (int, float):
        try:
            return name, caster(value)
        except ValueError:
            continue
    if value.lower() in ('true', 'false'):
        return name, value.lower() == 'true'
    return name, value


def resolve_params(strategy_cls: type, args) -> dict:
    """Build the ``strategy_cls(**overrides)`` dict from the CLI: ``--lots``,
    then ``--param`` on top. Only what the user actually asked to change is
    returned -- ``Strategy.__init__`` merges the class's own ``params``
    defaults under it -- so an untouched run behaves exactly as before.
    """
    params: dict = {}
    if getattr(args, 'lots', None) is not None:
        params['lots'] = args.lots
    for raw in getattr(args, 'param', None) or []:
        name, value = parse_param_value(raw)
        params[name] = value

    known = set(getattr(strategy_cls, 'params', {}) or {})
    unknown = sorted(set(params) - known)
    if unknown:
        # Not fatal: `Strategy.__init__` merges anything into `self.p`, and
        # `--lots` is documented as harmless for strategies that ignore it.
        # But a typo would otherwise vanish without a trace, so say so.
        logger.warning(
            '%s declares no param(s) %s -- passing them through, but the strategy '
            'will not read them (declared params: %s).',
            strategy_cls.__name__, unknown, sorted(known) or '<none>',
        )
    return params


def coerce_param(name: str, default, spec: Spec, value):
    """One override value, pinned to the default's type and ``spec``, the
    param's declared ``Int`` / ``Float`` / ``Categorical``.

    Raises ``ValueError`` naming the param. The range check is the
    load-bearing part: ``period=99999999999`` reaching ``talib.SMA`` is the
    only real way to hurt this process from a request.
    """
    if isinstance(default, bool):
        if not isinstance(value, bool):
            raise ValueError(f'{name!r} expects true or false')
        return value

    if isinstance(spec, Categorical):
        # Compare as strings: `parse_param_value` may have cast the token
        # (`'12'` -> `12`) to a type the choice was not declared as. Then hand
        # back the declared object rather than the parsed one.
        for choice in spec.choices:
            if str(choice) == str(value):
                return choice
        raise ValueError(f'{name!r} must be one of {[str(c) for c in spec.choices]}')

    # `spec` is an Int or a Float from here on, so the value has to be a
    # number whatever the default's type: a `None` default ("pick a window
    # yourself") still reaches TA-Lib as one.
    is_int = isinstance(default, int)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f'{name!r} expects {"an integer" if is_int else "a number"}')
    # `parse_param_value('period=1e400')` casts cleanly to inf, and
    # `'period=nan'` to NaN; both would reach TA-Lib as a valid float.
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError(f'{name!r} must be a finite number')
    if is_int:
        if value != int(value):
            raise ValueError(f'{name!r} expects an integer')
        value = int(value)
    elif isinstance(default, float):
        value = float(value)

    if not (spec.low <= value <= spec.high):
        raise ValueError(
            f'{name}={value} is outside its declared range {spec.low}..{spec.high}'
        )
    return value


def validated_overrides(cls: type, overrides: dict) -> dict:
    """``overrides`` checked against ``cls``'s declared params, space and
    constraints, returned coerced.

    An empty dict is the class's own defaults and is not an error, even when
    ``space`` itself cannot be read -- nothing is being overridden. A name the
    class does not declare, one it declares but left out of ``space``, a value
    outside its range, or a set that fails ``constraints`` raises
    ``ValueError``. Callers that speak HTTP turn that into a 422.
    """
    if not overrides:
        return {}

    declared = dict(getattr(cls, 'params', {}) or {})
    try:
        space = resolve_space(cls)
    except Exception as e:
        raise ValueError(
            f'{cls.__name__}.space could not be read ({type(e).__name__}: {e}); '
            f'fix it before overriding params'
        ) from e

    out: dict = {}
    for name, value in overrides.items():
        if name not in declared:
            raise ValueError(
                f'{cls.__name__} has no param {name!r}; '
                f'it declares {sorted(declared) or "none"}'
            )
        spec = space.get(name)
        if spec is None:
            raise ValueError(
                f'{cls.__name__}.{name} is not in its `space`, so it stays at its '
                f'default {declared[name]!r}; declare a range for it to make it tunable'
            )
        # `resolve_space` passes a declared entry through unchecked, so
        # `space = {'period': (2, 100)}` arrives here as a tuple.
        if not isinstance(spec, (Int, Float, Categorical)):
            raise ValueError(
                f'{cls.__name__}.space[{name!r}] is {spec!r}, not an Int/Float/'
                f'Categorical; fix it before overriding {name!r}'
            )
        out[name] = coerce_param(name, declared[name], spec, value)

    merged = {**declared, **out}
    try:
        satisfied = check_constraints(cls, merged)
    except Exception as e:
        raise ValueError(
            f'{cls.__name__}: one of its declared constraints raised '
            f'{type(e).__name__}: {e}'
        ) from e
    if not satisfied:
        raise ValueError(
            f'{cls.__name__}: those params violate one of its declared constraints'
        )
    return out
