"""Open interest (example indicator)."""

import talib

from .base import Indicator, Int, Output


class Oi(Indicator):
    """Open interest on the OI-weighted continuous series, with a moving
    average to read a rise or fall against recent history.

    Its own pane: the level is a contract count, and drawn over the candles
    it would sit on the price axis and disappear. Unlike OBV, the level
    itself is meaningful -- it is the contracts outstanding, summed across
    the contracts that make up the bar -- so it is read as a number as well
    as a slope.
    """

    label = 'OI'
    pane = 'sub'
    precision = 0
    params = {'period': 20}
    space = {'period': Int(2, 250)}
    outputs = (
        # Same mark as the volume pane: a bar per day, red when that day's
        # close rose and green when it fell. The height is the contract
        # count. The average stays a line to read the level against.
        Output('oi', label='OI', kind='bar', color='candle'),
        Output('ma', label='MA', color='muted', style='dashed'),
    )

    def compute(self, ctx, sym):
        oi = ctx.oi(sym)
        return {'oi': oi, 'ma': talib.SMA(oi, self.p['period'])}
