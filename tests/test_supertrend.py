"""SuperTrend math, chart split, and the MA-cross strategy that uses it as a filter."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
import talib

from core.engine import Engine
from indicators.base import IndicatorContext
from indicators.supertrend import SuperTrend, supertrend
from strategies import discover_strategies, load_strategy
from strategies.base import BarContext, SetupContext
from strategies.super_trend_filter import SuperTrendFilterStrategy
from tests.conftest import build_market, build_panel

# A short series that rises, breaks the lower band, then recaptures the upper.
# period=3, multiplier=2. Hand-checked against Wilder ATR + the ratchet/flip.
_HIGH = np.array([10., 11., 12., 13., 14., 15., 14., 12., 10., 9., 8., 9., 12., 14., 16.])
_LOW = np.array([9., 10., 11., 12., 13., 14., 11., 9., 7., 6., 5., 7., 10., 12., 14.])
_CLOSE = np.array([9.5, 10.8, 11.8, 12.8, 13.8, 14.5, 12.0, 10.0, 8.0, 7.0, 6.0, 8.5, 11.5, 13.5, 15.5])


def test_supertrend_matches_a_hand_computed_fixture():
    line, direction = supertrend(_HIGH, _LOW, _CLOSE, period=3, multiplier=2.0)
    atr = talib.ATR(_HIGH, _LOW, _CLOSE, 3)
    hl2 = (_HIGH + _LOW) / 2.0

    assert np.isnan(line[:3]).all() and np.isnan(direction[:3]).all()
    # First valid ATR bar: lower band, starts bullish.
    assert line[3] == pytest.approx(hl2[3] - 2.0 * atr[3])
    assert direction[3] == 1.0
    # Ratchet: the up-regime line does not fall on bars 3..5.
    assert direction[3:6].tolist() == [1.0, 1.0, 1.0]
    assert np.diff(line[3:6]).min() >= 0
    # Bar 6: close 12.0 crosses below the previous lower band (~12.011).
    assert _CLOSE[6] < line[5]
    assert direction[6] == -1.0
    assert line[6] == pytest.approx(15.1)
    # Recapture: close 13.5 crosses back above the previous upper band.
    assert direction[12] == -1.0
    assert _CLOSE[13] > line[12]
    assert direction[13] == 1.0


def test_supertrend_line_is_the_active_band():
    line, direction = supertrend(_HIGH, _LOW, _CLOSE, period=3, multiplier=2.0)
    hl2 = (_HIGH + _LOW) / 2.0
    up = direction > 0
    down = direction < 0
    assert (line[up] <= hl2[up]).all()
    assert (line[down] >= hl2[down]).all()


def test_supertrend_does_not_write_its_inputs():
    high, low, close = _HIGH.copy(), _LOW.copy(), _CLOSE.copy()
    high.flags.writeable = False
    low.flags.writeable = False
    close.flags.writeable = False
    supertrend(high, low, close, period=3, multiplier=2.0)
    np.testing.assert_array_equal(high, _HIGH)
    np.testing.assert_array_equal(low, _LOW)
    np.testing.assert_array_equal(close, _CLOSE)


def test_supertrend_rising_series_stays_bullish():
    close = 100.0 + np.arange(40, dtype='float64')
    _, direction = supertrend(close + 0.5, close - 0.5, close, period=10, multiplier=3.0)
    valid = direction[~np.isnan(direction)]
    assert valid.size and (valid == 1.0).all()


def test_chart_outputs_split_by_regime_and_union_is_dense():
    """Up/down take the candle colours; the inactive side is a gap the chart
    does not bridge. Together they are the continuous SuperTrend line."""
    df = pd.DataFrame(
        {'open': _CLOSE, 'high': _HIGH, 'low': _LOW, 'close': _CLOSE, 'settle': _CLOSE,
         'oi': np.full(len(_CLOSE), 1000.0), 'volume': np.full(len(_CLOSE), 500.0)},
        index=pd.date_range('2020-01-01', periods=len(_CLOSE), freq='D', name='date'),
    )
    out = SuperTrend(period=3, multiplier=2.0).compute(IndicatorContext(df, 'SA'), 'SA')
    line, direction = supertrend(_HIGH, _LOW, _CLOSE, period=3, multiplier=2.0)
    np.testing.assert_allclose(out['up'], np.where(direction > 0, line, np.nan), equal_nan=True)
    np.testing.assert_allclose(out['down'], np.where(direction < 0, line, np.nan), equal_nan=True)

    union = np.where(np.isfinite(out['up']), out['up'], out['down'])
    np.testing.assert_allclose(union, line, equal_nan=True)
    isnan = np.isnan(union)
    first = int(np.argmax(~isnan))
    assert not isnan[first:].any()


# ---------------------------------------------------------------------
# Strategy: SuperTrend as the big-trend filter
# ---------------------------------------------------------------------

def test_filter_strategy_is_discovered():
    assert 'super_trend_filter' in discover_strategies()
    assert load_strategy('super_trend_filter') is SuperTrendFilterStrategy


def _price_panel(symbol, close):
    close = np.asarray(close, dtype='float64')
    n = len(close)
    high, low = close + 0.5, close - 0.5
    weighted = {
        'open': close, 'high': high, 'low': low, 'close': close, 'settle': close,
        'oi': np.full(n, 100.0), 'volume': np.full(n, 100.0),
        'session': np.ones(n),
    }
    code = f'{symbol}509'
    contracts = {
        code: {
            i: (close[i], high[i], low[i], close[i], close[i], 100.0, 100.0)
            for i in range(n)
        },
    }
    return build_panel(
        symbol, n, weighted=weighted, contracts=contracts,
        contract_by_bar=[code] * n, first_bar=0,
    )


class _RecordingFilter(SuperTrendFilterStrategy):
    """Records SuperTrend direction vs the target queued this bar."""

    def __init__(self, **overrides):
        super().__init__(**overrides)
        self.rows = []

    def on_bar(self, ctx):
        super().on_bar(ctx)
        for sym in ctx.symbols:
            if not ctx.can_trade(sym):
                continue
            queued = ctx.queued_orders().get(sym, 0)
            self.rows.append((
                ctx.ind('st_dir', sym),
                ctx.position(sym) + queued,
                ctx.ind('fast', sym) > ctx.ind('slow', sym),
            ))


def _run(close, **params):
    close = np.asarray(close, dtype='float64')
    market = build_market({'SA': _price_panel('SA', close)}, len(close))
    strategy = _RecordingFilter(**params)
    engine = Engine(market, strategy, initial_cash=100_000.0)
    engine.run_backtest(SetupContext, BarContext)
    return engine, strategy


def test_filter_blocks_a_counter_trend_ma_cross():
    """A pullback deep enough to cross the MAs, but not SuperTrend, stays long.

    Wide multiplier so SuperTrend holds the uptrend through a 20-bar dip;
    fast SMA(3) vs slow SMA(15) does flip. Without the filter those bars
    would go short.
    """
    close = np.concatenate([
        100.0 + 2.0 * np.arange(60, dtype='float64'),
        218.0 - np.arange(1, 21, dtype='float64'),
        198.0 + 2.0 * np.arange(20, dtype='float64'),
    ])
    engine, strategy = _run(
        close, atr_period=10, multiplier=8.0, fast_period=3, slow_period=15, lots=1,
    )
    ma_wants_short_in_uptrend = [
        (direction, target, want_long)
        for direction, target, want_long in strategy.rows
        if direction > 0 and not want_long
    ]
    assert ma_wants_short_in_uptrend, 'fixture never produced a counter-trend MA cross'
    assert all(target >= 0 for _, target, _ in ma_wants_short_in_uptrend)
    assert engine.broker.net_position('SA') > 0
    assert all(entry['direction'] == 'buy' for entry in engine.signal_log)


def test_filter_never_holds_against_supertrend():
    """On any path, a long target requires a bullish SuperTrend and vice versa."""
    rng = np.random.default_rng(1)
    close = 1500 + np.cumsum(rng.normal(0, 8, 200))
    _engine, strategy = _run(close)
    for direction, target, _want_long in strategy.rows:
        if target > 0:
            assert direction > 0
        if target < 0:
            assert direction < 0


def test_rising_market_is_long_only_and_falling_is_short_only():
    n = 80
    up, _ = _run(100.0 + np.arange(n, dtype='float64'))
    assert up.broker.net_position('SA') > 0
    assert {e['direction'] for e in up.signal_log} == {'buy'}

    down, _ = _run(200.0 - np.arange(n, dtype='float64'))
    assert down.broker.net_position('SA') < 0
    assert {e['direction'] for e in down.signal_log} == {'sell'}
