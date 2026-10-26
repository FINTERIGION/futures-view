"""Last-bar snapshot of a strategy: pending action, contract, and brackets.

A backtest records fills. An alert needs the orders that have *not* filled
yet -- the SIGNAL-phase delta sitting in ``pending`` / ``deferred``, which
the next open will take -- plus whichever stop / take-profit is resting or
still only a rule. ``run_single_backtest`` throws the engine away after
scoring, so those fields never reach a run artifact; this module keeps the
engine long enough to read them and then discards it the same way.

The engine still has to walk every bar. There is no signal-only shortcut:
path-dependent strategies (a mean-reversion that keys off the live position,
a walk-forward fit) would lie if we only evaluated the last close.

Lots are computed -- ``size_for_risk`` needs a funded account or it flattens
the signal -- but they are not returned. The snapshot names a direction and
levels, not a size.
"""

from __future__ import annotations

from typing import Optional

import pandas as pd

from core.engine import Engine
from core.market import MarketData
from strategies.base import BarContext, SetupContext

# Large enough that a risk-based sizer will not refuse a signal for want of
# margin. The number never leaves this module.
ALERT_CASH = 10_000_000.0

OPERATIONS = (
    'flat', 'hold', 'open_long', 'open_short',
    'close', 'reverse', 'add', 'reduce',
)

__all__ = [
    'ALERT_CASH', 'OPERATIONS',
    'classify_operation', 'run_alert_snapshot',
]


def classify_operation(position: int, pending: int) -> str:
    """Name the action implied by ``position`` plus a leftover SIGNAL delta.

    ``pending`` is the signed lots that will fill at the next open (engine
    ``pending`` plus any ``deferred`` still waiting on a live session). A
    zero delta is not an action: the account is either already in the
    market (``hold``) or out of it (``flat``).
    """
    if pending == 0:
        return 'hold' if position else 'flat'
    after = position + pending
    if position == 0:
        return 'open_long' if after > 0 else 'open_short'
    if after == 0:
        return 'close'
    if (position > 0) != (after > 0):
        return 'reverse'
    if abs(after) > abs(position):
        return 'add'
    return 'reduce'


def _as_date(np_date):
    return pd.Timestamp(np_date).date()


def _bracket_level(live: Optional[dict], spec: Optional[dict]) -> dict:
    """Prefer a resting absolute price; otherwise report the unarmed rule.

    A distance that has not armed yet (a new position still sitting in
    ``pending``) cannot be a price -- the fill has not happened -- so it
    is returned as ``distance`` and the UI prints it as "next open ±d".
    """
    if live and live.get('price') is not None:
        return {'price': float(live['price']), 'distance': None}
    if not spec:
        return {'price': None, 'distance': None}
    if 'price' in spec:
        return {'price': float(spec['price']), 'distance': None}
    if 'distance' in spec:
        return {'price': None, 'distance': float(spec['distance'])}
    return {'price': None, 'distance': None}


def _trading_contract(engine: Engine, sym: str, last_i: Optional[int]) -> str:
    """The contract a fill would land on: the held leg, else the calendar main."""
    held = engine._current_contract(sym)
    if held:
        return held
    if last_i is None:
        return ''
    panel = engine.market.products.get(sym)
    if panel is None:
        return ''
    return panel.active_contract(last_i) or ''


def _snapshot_from_engine(engine: Engine) -> dict:
    if engine.market.n_bars == 0:
        last_i = None
        asof = None
    elif engine.blown_up and engine.blown_up_bar is not None:
        last_i = engine.blown_up_bar
        asof = _as_date(engine.market.dates[last_i])
    else:
        last_i = engine.market.n_bars - 1
        asof = _as_date(engine.market.dates[last_i])

    rows = []
    for sym in engine.symbols:
        position = engine.broker.net_position(sym)
        pending = engine.pending.get(sym, 0) + engine.deferred.get(sym, 0)
        rows.append({
            'symbol': sym,
            'contract': _trading_contract(engine, sym, last_i),
            'operation': classify_operation(position, pending),
            'stop': _bracket_level(engine.live_stop.get(sym), engine.stop_spec.get(sym)),
            'take_profit': _bracket_level(engine.live_tp.get(sym), engine.tp_spec.get(sym)),
        })
    return {
        'asof': asof.isoformat() if asof is not None else None,
        'blown_up': bool(engine.blown_up),
        'symbols': rows,
    }


def run_alert_snapshot(market: MarketData, strategy_cls: type, params: dict) -> dict:
    """Replay ``strategy_cls`` over ``market`` and return the last-bar alert.

    Same day loop as a backtest, no metrics, no lots in the payload.
    """
    strategy = strategy_cls(**params)
    engine = Engine(market, strategy, initial_cash=ALERT_CASH, slippage=0.0)
    engine.run_backtest(SetupContext, BarContext)
    return _snapshot_from_engine(engine)
