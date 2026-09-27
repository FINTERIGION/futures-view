"""MA-crossover entries gated by SuperTrend as the higher-level trend filter."""

import talib

from indicators.supertrend import supertrend

from .base import Float, Int, Strategy


class SuperTrendFilterStrategy(Strategy):
    """Fast/slow MA cross, allowed only in the SuperTrend regime.

    SuperTrend is the big-trend filter, not the entry: longs are taken only
    while it is bullish (close in the up regime / line below price), shorts
    only while bearish. A fast/slow MA cross that fights SuperTrend is
    ignored; a SuperTrend flip against the position exits it. ``set_target``
    still flips in one order when the MA and SuperTrend agree on a reversal.
    """

    params = {
        'atr_period': 10,
        'multiplier': 3.0,
        'fast_period': 5,
        'slow_period': 20,
        'lots': 1,
    }
    space = {
        'atr_period': Int(2, 50),
        'multiplier': Float(0.5, 8.0),
        'fast_period': Int(3, 30),
        'slow_period': Int(10, 150),
        'lots': Int(1, 20),
    }

    def setup(self, ctx):
        period = self.p['atr_period']
        mult = self.p['multiplier']
        fast = self.p['fast_period']
        slow = self.p['slow_period']
        for sym in ctx.symbols:
            close = ctx.close(sym)
            _, direction = supertrend(
                ctx.high(sym), ctx.low(sym), close, period, mult,
            )
            ctx.add_indicator('st_dir', sym, direction)
            ctx.add_indicator('fast', sym, talib.SMA(close, fast))
            ctx.add_indicator('slow', sym, talib.SMA(close, slow))

    def on_bar(self, ctx):
        lots = self.p['lots']
        for sym in ctx.symbols:
            if not ctx.can_trade(sym):
                continue
            bullish = ctx.ind('st_dir', sym) > 0
            want_long = ctx.ind('fast', sym) > ctx.ind('slow', sym)
            pos = ctx.position(sym)

            if bullish and want_long:
                ctx.set_target(sym, lots)
            elif (not bullish) and (not want_long):
                ctx.set_target(sym, -lots)
            elif pos > 0 and not bullish:
                ctx.close(sym)
            elif pos < 0 and bullish:
                ctx.close(sym)
