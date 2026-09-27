"""Indicator API: the base class, its per-symbol context, and the ``Output``
declaration that says how one series should be drawn.

An indicator is a *chart* object, not a trading one. It computes full-series
arrays off a product's OI-weighted continuous bars -- the same series
``SetupContext`` hands a strategy -- and declares how the panel should draw
them: colour, line style, decimals, value range, price pane or its own pane.
Nothing here places orders or knows about the engine.

The accessors deliberately mirror ``strategies.base.SetupContext`` so the body
of a strategy's ``setup()`` pastes into ``compute()`` unmodified:

    ctx.add_indicator('sma', sym, talib.SMA(ctx.close(sym), 20))   # strategy
    return {'sma': talib.SMA(ctx.close(sym), 20)}                  # indicator

See docs/indicator.md.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple, Union

import numpy as np

from core.indicators import guard
from core.params import Categorical, Float, Int, Spec

__all__ = [
    'Indicator', 'IndicatorContext', 'Output',
    'Int', 'Float', 'Categorical', 'Spec',
]

#: What ``Output.color`` accepts. Resolved by the frontend, never here -- see
#: the class docstring on ``Output``.
Color = Union[int, str, Tuple[Union[int, str], Union[int, str]], None]

KINDS = ('line', 'bar', 'area')
STYLES = ('solid', 'dashed', 'dotted')
PANES = ('main', 'sub')


@dataclass(frozen=True)
class Output:
    """One drawn series.

    ``color`` is declared here but resolved in the browser, because the panel
    is theme-aware and flips light/dark with no refetch -- a colour resolved
    server-side would be stale the moment the user toggled the theme. These
    forms, in rough order of preference:

    * ``int`` -- a slot in the categorical palette. The light and dark arrays
      are index-aligned by hue, so one index is right in both themes. This is
      the form to reach for: a Python author has no way to eyeball a hex
      against the dark chart surface.
    * ``'up'`` / ``'down'`` / ``'muted'`` / ``'axis'`` -- semantic tokens.
      ``up``/``down`` are the candle colours (red = rose, the Chinese-market
      convention this toolkit follows).
    * ``'#rrggbb'`` -- a literal; the author takes responsibility for both
      themes.
    * a 2-tuple of any of the above -- sign-coloured bars, ``(>= 0, < 0)``.
      Only meaningful with ``kind='bar'``; it is what makes a MACD histogram
      readable.
    * ``'candle'`` -- each bar takes that day's candle colour: red when
      close >= open, green otherwise, the same rule as the volume pane.
      Only meaningful with ``kind='bar'``. The height stays the series
      value; the colour comes from the price, not from the value's sign.

    ``None`` gets a palette slot assigned by the chart builder across every
    rendered output in order, so two indicators that both declared nothing
    don't collide on the same hue.
    """

    key: str                      #: matches a key in ``compute()``'s returned dict
    label: Optional[str] = None   #: tooltip/title text; defaults to ``key``
    kind: str = 'line'            #: one of ``KINDS``
    color: Color = None
    style: str = 'solid'          #: one of ``STYLES``; 1:1 with ECharts ``lineStyle.type``

    @property
    def display(self) -> str:
        return self.label or self.key


class Indicator:
    """Subclass and implement ``compute``. ``params`` is a class-level dict of
    defaults; instantiate with ``MyIndicator(**overrides)``.

    Declare the drawing contract as class attributes:

    ============= =================================================================
    ``label``     Human name for the picker; defaults to the discovered key
    ``pane``      ``'main'`` (over the candles) or ``'sub'`` (its own pane)
    ``precision`` Decimals in the tooltip, and on a sub-pane's axis labels
    ``value_range`` ``(min, max)`` y-bounds. Sub-pane only; ``None`` autoscales
    ``guides``    Horizontal reference lines on a sub-pane, e.g. ``(30, 70)``
    ``outputs``   Tuple of :class:`Output`, one per drawn series
    ============= =================================================================

    ``params`` / ``space`` work exactly as they do on
    ``Strategy`` and go through the same ``core.params`` helpers -- one
    parameter model for both, so nothing that reads one has to learn the
    other. ``constraints`` is indicator-only: a tuple of
    ``callable(params_dict) -> bool`` that a param override from a URL must
    satisfy, e.g. ``lambda p: p['fast'] < p['slow']``.

    ``space`` earns its keep here for a second reason: the values endpoint
    takes param overrides from a URL, and the declared bounds are what stop
    ``period=99999999999`` from reaching TA-Lib. A param left out of it
    cannot be overridden from the picker or a URL at all.
    """

    label: str = ''
    pane: str = 'main'
    precision: int = 2
    value_range: Optional[tuple] = None
    guides: tuple = ()
    outputs: tuple = ()

    params: dict = {}
    space: dict = {}
    constraints: tuple = ()

    def __init__(self, **overrides):
        self.p = {**type(self).params, **overrides}

    def compute(self, ctx: "IndicatorContext", sym: str) -> dict:
        """Return ``{output key: full-length array}``.

        One entry per declared ``Output``. Each array must be the same length
        as ``ctx.dates``; leading NaN is expected and is what the chart draws
        as the warmup.
        """
        raise NotImplementedError(
            f'{type(self).__name__} must implement compute(self, ctx, sym)'
        )


class IndicatorContext:
    """Full-series (numpy) view of one product, handed to ``Indicator.compute``.

    Built from the same ``DataManager.load_dataframe`` output the chart's
    candles come from, so an indicator always lines up with what is on screen.

    Every accessor takes the symbol as an *optional* argument. The values
    endpoint names one product, so ``ctx.close()`` is the natural spelling
    here; ``ctx.close(sym)`` is accepted unchanged so a strategy's ``setup()``
    body can be pasted in as-is, and so the argument is already there the day
    an indicator wants to see more than one product.
    """

    def __init__(self, df, symbol: str):
        self.symbol = symbol
        self.symbols = [symbol]
        self._df = df
        self.dates = df.index.to_numpy()

    def _column(self, field: str, sym: Optional[str]) -> np.ndarray:
        if sym is not None and sym != self.symbol:
            raise ValueError(
                f'{self.symbol!r} is the only product loaded here; asked for {sym!r}.'
            )
        if field not in self._df.columns:
            raise ValueError(
                f'{self.symbol} has no {field!r} column; got {list(self._df.columns)}'
            )
        return guard(self._df[field].to_numpy(dtype='float64'), name=f'{self.symbol}.{field}')

    def open(self, sym: Optional[str] = None) -> np.ndarray:
        return self._column('open', sym)

    def high(self, sym: Optional[str] = None) -> np.ndarray:
        return self._column('high', sym)

    def low(self, sym: Optional[str] = None) -> np.ndarray:
        return self._column('low', sym)

    def close(self, sym: Optional[str] = None) -> np.ndarray:
        return self._column('close', sym)

    def settle(self, sym: Optional[str] = None) -> np.ndarray:
        return self._column('settle', sym)

    def volume(self, sym: Optional[str] = None) -> np.ndarray:
        return self._column('volume', sym)

    def oi(self, sym: Optional[str] = None) -> np.ndarray:
        return self._column('oi', sym)

    def __len__(self) -> int:
        return len(self._df)


# ---------------------------------------------------------------------
# Declaration validation
# ---------------------------------------------------------------------

def describe_errors(cls: type) -> list:
    """Problems with ``cls``'s drawing declaration, as human-readable strings.

    Returns a list rather than raising, so one badly declared indicator costs
    one entry in the catalog instead of the whole list -- the same reason
    ``web.routers.strategies._describe`` reports ``space_error`` rather than
    letting ``resolve_space`` propagate.
    """
    errors: list = []
    name = cls.__name__

    pane = getattr(cls, 'pane', 'main')
    if pane not in PANES:
        errors.append(f'{name}.pane is {pane!r}; expected one of {PANES}.')

    # `outputs = Output('x')` -- a missing trailing comma -- is the single most
    # likely typo in this declaration, and a bare dataclass is not iterable. It
    # has to read as one reported error, not a TypeError escaping into the
    # catalog and taking every other indicator's entry down with it.
    outputs = getattr(cls, 'outputs', ()) or ()
    if isinstance(outputs, Output):
        errors.append(f'{name}.outputs is a single Output; it needs a tuple -- a trailing comma is missing.')
        outputs = (outputs,)
    elif not isinstance(outputs, (tuple, list)):
        errors.append(f'{name}.outputs is {type(outputs).__name__}; expected a tuple of Output.')
        outputs = ()
    elif not outputs:
        errors.append(f'{name} declares no outputs, so it would draw nothing.')

    seen = set()
    for out in outputs:
        if not isinstance(out, Output):
            errors.append(f'{name}.outputs contains {out!r}, which is not an Output.')
            continue
        if out.key in seen:
            errors.append(f'{name} declares two outputs keyed {out.key!r}.')
        seen.add(out.key)
        if out.kind not in KINDS:
            errors.append(f'{name}.{out.key}: kind {out.kind!r} is not one of {KINDS}.')
        if out.style not in STYLES:
            errors.append(f'{name}.{out.key}: style {out.style!r} is not one of {STYLES}.')
        if isinstance(out.color, tuple) and out.kind != 'bar':
            errors.append(
                f"{name}.{out.key}: a 2-tuple colour is the >=0 / <0 pair for "
                f"kind='bar', but this output is {out.kind!r}."
            )
        if out.color == 'candle' and out.kind != 'bar':
            errors.append(
                f"{name}.{out.key}: color 'candle' colours each bar by that day's "
                f"price direction, but this output is {out.kind!r}."
            )

    value_range = getattr(cls, 'value_range', None)
    if value_range is not None:
        if not (isinstance(value_range, (tuple, list)) and len(value_range) == 2):
            errors.append(f'{name}.value_range is {value_range!r}; expected a (min, max) pair.')
        elif pane == 'main':
            errors.append(
                f"{name} declares value_range with pane='main'; it is ignored, "
                f"because those bounds would rescale the price axis the candles own."
            )

    if not isinstance(getattr(cls, 'precision', 2), int):
        errors.append(f'{name}.precision must be an int.')

    guides = getattr(cls, 'guides', ()) or ()
    if not isinstance(guides, (tuple, list)):
        errors.append(f'{name}.guides is {type(guides).__name__}; expected a tuple of numbers.')
    elif any(not isinstance(g, (int, float)) or isinstance(g, bool) for g in guides):
        errors.append(f'{name}.guides must contain only numbers.')

    return errors


def declared_outputs(cls: type) -> tuple:
    """``cls.outputs`` as a tuple of real ``Output``s, dropping anything that
    is not one.

    The counterpart to :func:`describe_errors`: that function *reports* a
    malformed declaration, this one lets every other caller iterate without
    re-deriving the same guards. A class whose declaration is broken still
    reaches the catalog -- it just contributes nothing to draw.
    """
    outputs = getattr(cls, 'outputs', ()) or ()
    if isinstance(outputs, Output):
        outputs = (outputs,)
    elif not isinstance(outputs, (tuple, list)):
        return ()
    return tuple(o for o in outputs if isinstance(o, Output))


def value_range_json(cls: type) -> Optional[dict]:
    """``(0, 100)`` -> ``{'min': 0, 'max': 100}``; ``None`` -> ``None``.

    An object rather than a positional pair so ``(0, None)`` -- bounded below,
    autoscaled above -- reads unambiguously on the wire.
    """
    value_range = getattr(cls, 'value_range', None)
    if value_range is None or getattr(cls, 'pane', 'main') != 'sub':
        return None
    if not (isinstance(value_range, (tuple, list)) and len(value_range) == 2):
        return None
    low, high = value_range
    return {'min': low, 'max': high}


def output_json(out: Output) -> dict:
    """One ``Output`` as the frontend receives it -- ``color`` verbatim."""
    color = list(out.color) if isinstance(out.color, tuple) else out.color
    return {
        'key': out.key,
        'label': out.display,
        'kind': out.kind,
        'color': color,
        'style': out.style,
    }
