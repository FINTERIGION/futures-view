"""Indicators package: base class + public examples.

Put private indicator modules in this folder (gitignored). They are picked up
automatically by :func:`discover_indicators` -- no registration needed.
"""

from __future__ import annotations

import importlib
import inspect
import logging

from core.registry import discover_subclasses, snake_name

from .atr import Atr
from .base import Indicator, IndicatorContext, Output
from .bollinger import Bollinger
from .cci import Cci
from .dmi import Dmi
from .donchian import Donchian
from .ema import Ema
from .kdj import Kdj
from .keltner import Keltner
from .ma import Ma
from .macd import Macd
from .obv import Obv
from .oi import Oi
from .rsi import Rsi

__all__ = [
    'Indicator', 'IndicatorContext', 'Output',
    'Ma', 'Ema', 'Macd', 'Rsi', 'Bollinger', 'Atr',
    'Kdj', 'Cci', 'Dmi', 'Donchian', 'Keltner', 'Obv', 'Oi',
    'discover_indicators', 'load_indicator', 'load_registered_indicator', 'name_for',
]

logger = logging.getLogger(__name__)


def name_for(cls: type) -> str:
    """``Macd`` -> ``'macd'``; a redundant trailing ``_indicator`` is dropped.

    Most indicator names are a single word, so name the class ``Rsi`` rather
    than ``RsiIndicator`` -- the suffix survives on a one-word stem (the rule
    that keeps ``MyStrategy`` from collapsing to ``my``), and
    ``RsiIndicator`` would key as ``'rsi_indicator'``.
    """
    return snake_name(cls, 'indicator')


def discover_indicators(errors: dict | None = None) -> dict:
    """Scan every module in this package and return ``{short_name: cls}`` for
    every concrete ``Indicator`` subclass found (``Indicator`` itself excluded).

    An indicator is included regardless of which module defines it, so long as
    it lives somewhere under ``indicators/`` -- private, gitignored modules are
    discovered the same as the bundled examples.

    Unlike :func:`strategies.discover_strategies`, a module that fails to
    import does *not* take the scan down with it: the failure is logged, and
    recorded in ``errors`` as ``{module_name: message}`` when a dict is passed.
    The two differ because of who is calling. A strategy scan runs from a CLI
    invocation that is about to use one of the classes, where swallowing a
    syntax error would report it as "unknown strategy". An indicator scan
    serves the panel's catalog, which is repopulated every time the user hits
    reload while editing -- there, one broken module should cost one entry and
    leave the other indicators on the chart.

    Two classes sharing a short name are both left out and recorded the same
    way, against each module involved -- see
    :func:`core.registry.discover_subclasses`. A module can therefore collect
    more than one message; they are joined by newlines.
    """

    def record(mod_name: str, exc: Exception) -> None:
        message = f'{type(exc).__name__}: {exc}'
        logger.warning('indicators: %s -- %s', mod_name, message)
        if errors is not None:
            errors[mod_name] = f'{errors[mod_name]}\n{message}' if mod_name in errors else message

    return discover_subclasses(__name__, Indicator, 'indicator', on_error=record)


def load_registered_indicator(name: str) -> type:
    """Resolve ``name`` against :func:`discover_indicators` and nothing else.

    Deliberately does *not* accept :func:`load_indicator`'s
    ``'module.path:ClassName'`` form. That form calls
    ``importlib.import_module`` on whatever it names, which runs that module's
    top-level code before anything checks the result is even an ``Indicator``
    -- fine for a CLI argv, which is already running as the user, but not for
    a string that arrived over HTTP. The web panel has no authentication and
    is bindable to a non-loopback address (``main.py web --host``), so anything
    reachable from a request has to stay inside the registry. Private
    indicators lose nothing by it: they live under ``indicators/`` and are
    discovered automatically.

    Raises ``KeyError`` for an unknown name -- the only failure mode, which is
    what lets the routers map it to one clean 4xx instead of letting an import
    error surface as a 500.
    """
    registry = discover_indicators()
    try:
        return registry[name]
    except KeyError:
        raise KeyError(
            f"Unknown indicator {name!r}. Available: {', '.join(sorted(registry))}"
        ) from None


def load_indicator(spec: str) -> type:
    """Resolve ``spec`` to an ``Indicator`` subclass.

    ``spec`` is either a short name from :func:`discover_indicators` (e.g.
    ``'macd'``) or a ``'module.path:ClassName'`` reference to an indicator
    living outside this package. Callers handling untrusted input want
    :func:`load_registered_indicator` instead -- see there for why.
    """
    if ':' in spec:
        module_name, class_name = spec.split(':', 1)
        module = importlib.import_module(module_name)
        cls = getattr(module, class_name)
        if not (inspect.isclass(cls) and issubclass(cls, Indicator)):
            raise TypeError(f"{spec!r} is not an Indicator subclass")
        return cls
    return load_registered_indicator(spec)
