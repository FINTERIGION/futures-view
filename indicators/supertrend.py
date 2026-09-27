"""SuperTrend (ATR bands that ratchet and flip with the close)."""

import numpy as np
import talib

from .base import Float, Indicator, Int, Output


def supertrend(high, low, close, period: int, multiplier: float):
    """SuperTrend line and direction; NaN until the first full ATR window.

    Standard construction (Kivanc Ozbilgic / the usual charting form):

    * ATR of ``period`` (Wilder, via TA-Lib) around the bar's midpoint
    * a lower band at ``hl2 - multiplier * ATR`` and an upper at
      ``hl2 + multiplier * ATR``
    * each band ratchets: the lower never falls while close holds above it,
      the upper never rises while close holds below it
    * the line is the lower band in an uptrend and the upper in a downtrend,
      and the regime flips when close crosses the *previous* band

    ``direction`` is ``+1`` (bullish) or ``-1`` (bearish). The first valid
    bar starts bullish; later bars follow the close. Input arrays are not
    written to.
    """
    high = np.asarray(high, dtype='float64')
    low = np.asarray(low, dtype='float64')
    close = np.asarray(close, dtype='float64')
    n = len(close)
    line = np.full(n, np.nan)
    direction = np.full(n, np.nan)
    if n == 0:
        return line, direction

    atr = talib.ATR(high, low, close, period)
    valid = ~np.isnan(atr)
    if not valid.any():
        return line, direction

    hl2 = (high + low) * 0.5
    basic_lower = hl2 - multiplier * atr
    basic_upper = hl2 + multiplier * atr
    final_lower = np.full(n, np.nan)
    final_upper = np.full(n, np.nan)

    start = int(np.argmax(valid))
    final_lower[start] = basic_lower[start]
    final_upper[start] = basic_upper[start]
    direction[start] = 1.0
    line[start] = final_lower[start]

    for i in range(start + 1, n):
        prev_lower = final_lower[i - 1]
        prev_upper = final_upper[i - 1]
        prev_close = close[i - 1]

        # Ratchet off yesterday's close vs yesterday's final bands, then
        # flip off today's close vs those same previous bands.
        if basic_lower[i] > prev_lower or prev_close < prev_lower:
            final_lower[i] = basic_lower[i]
        else:
            final_lower[i] = prev_lower

        if basic_upper[i] < prev_upper or prev_close > prev_upper:
            final_upper[i] = basic_upper[i]
        else:
            final_upper[i] = prev_upper

        if direction[i - 1] > 0:
            direction[i] = -1.0 if close[i] < prev_lower else 1.0
        else:
            direction[i] = 1.0 if close[i] > prev_upper else -1.0

        line[i] = final_lower[i] if direction[i] > 0 else final_upper[i]

    return line, direction


class SuperTrend(Indicator):
    """ATR-based SuperTrend drawn on the price pane.

    The line sits under the candles in an uptrend and over them in a
    downtrend, and is split across two outputs so each regime takes the
    matching Chinese candle colour (red rose / green fell). Gaps on the
    inactive side are the regime, not missing data -- the chart leaves them
    unbridged.
    """

    label = 'SuperTrend'
    pane = 'main'
    precision = 2
    params = {'period': 10, 'multiplier': 3.0}
    space = {'period': Int(2, 100), 'multiplier': Float(0.5, 8.0)}
    outputs = (
        Output('up', label='Up', color='up'),
        Output('down', label='Down', color='down'),
    )

    def compute(self, ctx, sym):
        line, direction = supertrend(
            ctx.high(sym), ctx.low(sym), ctx.close(sym),
            self.p['period'], self.p['multiplier'],
        )
        up = np.where(direction > 0, line, np.nan)
        down = np.where(direction < 0, line, np.nan)
        return {'up': up, 'down': down}
