"""Last-bar alert snapshot: pending action, contract, stop / take-profit.

Lots are computed internally (a risk sizer would otherwise flatten) and must
not appear in the payload.
"""

from __future__ import annotations

import numpy as np
import pytest

from core.alert import classify_operation, run_alert_snapshot
from strategies.base import Strategy
from strategies.double_ma import DoubleMaStrategy
from tests.conftest import build_market, build_panel


def _flat_market(n_bars, price=100.0, symbol='SA', contract='SA509'):
    close = np.full(n_bars, price, dtype='float64')
    return _price_market(close, symbol=symbol, contract=contract)


def _price_market(closes, symbol='SA', contract='SA509'):
    close = np.asarray(closes, dtype='float64')
    n = len(close)
    contracts = {
        contract: {
            i: (close[i], close[i] + 1, close[i] - 1, close[i], close[i], 1.0, 1.0)
            for i in range(n)
        },
    }
    panel = build_panel(
        symbol, n,
        weighted={
            'open': close, 'high': close + 1.0, 'low': close - 1.0,
            'close': close, 'settle': close,
            'oi': np.ones(n), 'volume': np.ones(n),
            'session': np.ones(n),
        },
        contracts=contracts,
        contract_by_bar=[contract] * n,
    )
    return build_market({symbol: panel}, n)


def _row(snap, symbol='SA'):
    return next(r for r in snap['symbols'] if r['symbol'] == symbol)


def _assert_no_lots(snap):
    forbidden = {'size', 'lots', 'pending', 'position', 'cash'}
    stack = [snap]
    while stack:
        obj = stack.pop()
        if isinstance(obj, dict):
            assert forbidden.isdisjoint(obj), obj.keys()
            stack.extend(obj.values())
        elif isinstance(obj, list):
            stack.extend(obj)


class _TargetStrategy(Strategy):
    """``{bar_index: lots}`` via ``set_target``. Missing bars hold whatever is live."""

    def __init__(self, script, **kwargs):
        super().__init__(**kwargs)
        self.script = script

    def setup(self, ctx):
        pass

    def on_bar(self, ctx):
        target = self.script.get(ctx.i)
        if target is not None:
            ctx.set_target('SA', target)


class _StopDistanceStrategy(Strategy):
    def setup(self, ctx):
        pass

    def on_bar(self, ctx):
        for sym in ctx.symbols:
            if not ctx.can_trade(sym):
                continue
            ctx.set_target(sym, 1)
            ctx.set_stop(sym, distance=5.0)
            ctx.set_take_profit(sym, distance=10.0)


@pytest.mark.parametrize('position, pending, want', [
    (0, 0, 'flat'),
    (1, 0, 'hold'),
    (-2, 0, 'hold'),
    (0, 1, 'open_long'),
    (0, -3, 'open_short'),
    (2, -2, 'close'),
    (-1, 1, 'close'),
    (1, -2, 'reverse'),
    (-2, 3, 'reverse'),
    (1, 1, 'add'),
    (-1, -2, 'add'),
    (3, -1, 'reduce'),
    (-4, 2, 'reduce'),
])
def test_classify_operation(position, pending, want):
    assert classify_operation(position, pending) == want


def test_double_ma_first_signal_on_an_uptrend_is_open_long():
    # slow=5 is valid from bar 4. Five rising closes make the fast SMA sit
    # above the slow one on that first tradable bar, with no prior fill.
    closes = [10.0, 11.0, 12.0, 13.0, 14.0]
    snap = run_alert_snapshot(
        _price_market(closes), DoubleMaStrategy,
        {'fast_period': 3, 'slow_period': 5},
    )
    row = _row(snap)
    assert row['operation'] == 'open_long'
    assert row['contract'] == 'SA509'
    assert snap['asof'] == '2024-01-05'
    assert snap['blown_up'] is False
    _assert_no_lots(snap)


def test_double_ma_stays_hold_after_the_uptrend_is_already_on():
    closes = [10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0, 17.0]
    snap = run_alert_snapshot(
        _price_market(closes), DoubleMaStrategy,
        {'fast_period': 3, 'slow_period': 5},
    )
    assert _row(snap)['operation'] == 'hold'
    _assert_no_lots(snap)


def test_double_ma_first_signal_on_a_downtrend_is_open_short():
    closes = [20.0, 19.0, 18.0, 17.0, 16.0]
    snap = run_alert_snapshot(
        _price_market(closes), DoubleMaStrategy,
        {'fast_period': 3, 'slow_period': 5},
    )
    assert _row(snap)['operation'] == 'open_short'
    _assert_no_lots(snap)


def test_double_ma_cross_to_the_other_side_is_a_reverse():
    # Flat, then a last-bar spike: the always-in-market strategy is short
    # through the warmup (fast is not strictly above slow) and flips long
    # on the spike, which is one reverse order, not a flat-then-open.
    closes = [100.0] * 8 + [200.0]
    snap = run_alert_snapshot(
        _price_market(closes), DoubleMaStrategy,
        {'fast_period': 3, 'slow_period': 5},
    )
    assert _row(snap)['operation'] == 'reverse'
    _assert_no_lots(snap)


def test_scripted_close_and_add_and_reduce():
    # Two bars: bar 0 opens the position, bar 1's SIGNAL is the leftover pending.
    market = _flat_market(2)

    closed = run_alert_snapshot(market, _TargetStrategy, {'script': {0: 1, 1: 0}})
    assert _row(closed)['operation'] == 'close'

    added = run_alert_snapshot(market, _TargetStrategy, {'script': {0: 1, 1: 2}})
    assert _row(added)['operation'] == 'add'

    reduced = run_alert_snapshot(market, _TargetStrategy, {'script': {0: 2, 1: 1}})
    assert _row(reduced)['operation'] == 'reduce'


def test_new_entry_reports_stop_distance_not_a_price():
    # One bar: SIGNAL queues the open, the stop has not armed against a fill.
    snap = run_alert_snapshot(_flat_market(1), _StopDistanceStrategy, {})
    row = _row(snap)
    assert row['operation'] == 'open_long'
    assert row['stop'] == {'price': None, 'distance': 5.0}
    assert row['take_profit'] == {'price': None, 'distance': 10.0}
    _assert_no_lots(snap)


def test_resting_bracket_is_an_absolute_price_once_the_entry_has_filled():
    # Bar 0 signals; bar 1 OPEN fills at 100 and arms distance-5 / distance-10.
    snap = run_alert_snapshot(_flat_market(2), _StopDistanceStrategy, {})
    row = _row(snap)
    assert row['operation'] == 'hold'
    assert row['stop']['price'] == pytest.approx(95.0)
    assert row['stop']['distance'] is None
    assert row['take_profit']['price'] == pytest.approx(110.0)
    assert row['take_profit']['distance'] is None
    _assert_no_lots(snap)


def test_empty_strategy_is_flat_with_the_calendar_contract():
    class _Idle(Strategy):
        def setup(self, ctx):
            pass

        def on_bar(self, ctx):
            pass

    snap = run_alert_snapshot(_flat_market(4, contract='SAC1'), _Idle, {})
    row = _row(snap)
    assert row['operation'] == 'flat'
    assert row['contract'] == 'SAC1'
    assert row['stop'] == {'price': None, 'distance': None}
    assert row['take_profit'] == {'price': None, 'distance': None}
    _assert_no_lots(snap)
