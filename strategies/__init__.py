"""Strategies package: base class + public examples.

Put private research modules in this folder (gitignored). They are picked
up automatically by :func:`discover_strategies` -- no registration needed.
"""

from __future__ import annotations

import importlib
import inspect
import logging

from core.registry import discover_subclasses, snake_name

from .base import BarContext, SetupContext, Strategy
from .cross_sectional_momentum import CrossSectionalMomentumStrategy
from .double_ma import DoubleMaStrategy
from .my_strategy import MyStrategy
from .rsi_mean_reversion import RsiMeanReversionStrategy
from .super_trend_filter import SuperTrendFilterStrategy

__all__ = [
    'Strategy', 'SetupContext', 'BarContext',
    'DoubleMaStrategy', 'RsiMeanReversionStrategy', 'MyStrategy',
    'CrossSectionalMomentumStrategy', 'SuperTrendFilterStrategy',
    'discover_strategies', 'load_strategy', 'load_registered_strategy', 'name_for',
]

logger = logging.getLogger(__name__)

def name_for(cls: type) -> str:
    """``DoubleMaStrategy`` -> ``'double_ma'``: snake_case the class name,
    then drop a redundant trailing ``_strategy`` -- unless doing so would
    leave a single, uninformative word (``MyStrategy`` -> ``'my_strategy'``,
    not ``'my'``). Matches the CLI names already documented in README.md."""
    return snake_name(cls, 'strategy')


def discover_strategies(errors: dict | None = None) -> dict:
    """Scan every module in this package and return ``{short_name: cls}`` for
    every concrete ``Strategy`` subclass found (``Strategy`` itself excluded).

    A strategy is included regardless of which module defines it, so long as
    it lives somewhere under ``strategies/`` -- private, gitignored modules
    are discovered the same as the bundled examples.

    By default a module that fails to import raises rather than being
    skipped, and so do two classes sharing a short name: a silent skip would
    report a syntax error as "unknown strategy" -- or, for a clash, run
    whichever class happened to be scanned last.

    Pass ``errors`` to degrade instead: each failure is logged, recorded as
    ``{module_name: message}``, and the scan goes on without it -- clashing
    classes are left out on both sides, never resolved by scan order. That is
    for callers that can put the failure in front of the user themselves:
    the panel's catalog, where one private module saved mid-edit should cost
    one entry rather than the whole dropdown, and
    :func:`load_registered_strategy`, which names the failures when the
    strategy asked for is not found. Same shape as
    ``indicators.discover_indicators``.
    """
    if errors is None:
        return discover_subclasses(__name__, Strategy, 'strategy')

    def record(mod_name: str, exc: Exception) -> None:
        message = f'{type(exc).__name__}: {exc}'
        logger.warning('strategies: %s -- %s', mod_name, message)
        errors[mod_name] = f'{errors[mod_name]}\n{message}' if mod_name in errors else message

    return discover_subclasses(__name__, Strategy, 'strategy', on_error=record)


def load_registered_strategy(name: str) -> type:
    """Resolve ``name`` against :func:`discover_strategies` and nothing else.

    Deliberately does *not* accept :func:`load_strategy`'s
    ``'module.path:ClassName'`` form. That form calls
    ``importlib.import_module`` on whatever it names, which runs that
    module's top-level code before anything checks the result is even a
    ``Strategy`` -- fine for a CLI argv, which is already running as the
    user, but not for a string that arrived over HTTP. The web panel has no
    authentication and is bindable to a non-loopback address (``main.py web
    --host``), so anything reachable from a request body has to stay inside
    the registry. Private strategies lose nothing by it: they live under
    ``strategies/`` and are discovered automatically.

    Raises ``KeyError`` for an unknown name -- the only failure mode, which
    is what lets the routers map it to one clean 4xx instead of letting an
    import error surface as a 500.

    A module elsewhere under ``strategies/`` that fails to import does not
    stop a healthy strategy from loading. It used to: one private file saved
    mid-edit made every backtest fail, through the CLI and the panel alike,
    whichever strategy was asked for. When ``name`` is not found, the
    ``KeyError`` names every module that failed, so a strategy whose own file
    is broken is reported with its error rather than as merely unknown.
    """
    failed: dict = {}
    registry = discover_strategies(errors=failed)
    if name in registry:
        return registry[name]
    message = f"Unknown strategy {name!r}. Available: {', '.join(sorted(registry))}"
    if failed:
        # One line: the routers put `str(KeyError)` -- its repr -- in the
        # response, where a newline would arrive as a literal backslash-n.
        message += '. Failed to load: ' + '; '.join(
            f"{mod} ({msg.replace(chr(10), '; ')})" for mod, msg in sorted(failed.items())
        )
    raise KeyError(message)


def load_strategy(spec: str) -> type:
    """Resolve ``spec`` to a ``Strategy`` subclass.

    ``spec`` is either a short name from :func:`discover_strategies` (e.g.
    ``'double_ma'``) or a ``'module.path:ClassName'`` reference to a strategy
    living outside this package. Callers handling untrusted input want
    :func:`load_registered_strategy` instead -- see there for why.
    """
    if ':' in spec:
        module_name, class_name = spec.split(':', 1)
        module = importlib.import_module(module_name)
        cls = getattr(module, class_name)
        if not (inspect.isclass(cls) and issubclass(cls, Strategy)):
            raise TypeError(f"{spec!r} is not a Strategy subclass")
        return cls
    return load_registered_strategy(spec)
