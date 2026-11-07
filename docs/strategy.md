# Writing a Strategy

Strategies subclass `strategies.base.Strategy`, precompute indicators on the OI-weighted series in `setup`, and emit target or delta orders in `on_bar`.

## Discovery & Naming

- **Location**: Drop `.py` modules into `strategies/` (see `strategies/my_strategy.py` template).
- **Short key**: Class name converted to `snake_case` with trailing `_strategy` stripped (e.g., `DoubleMaStrategy` → `double_ma`).
- **Collision rule**: Duplicate short keys raise an error on discovery rather than shadowing.

## Minimal Template

```python
import talib
from .base import Int, Strategy


class MyStrategy(Strategy):
    params = {'period': 20, 'lots': 1}
    space = {'period': Int(5, 120)}

    def setup(self, ctx):
        for sym in ctx.symbols:
            ctx.add_indicator('sma', sym, talib.SMA(ctx.close(sym), self.p['period']))

    def on_bar(self, ctx):
        for sym in ctx.symbols:
            if not ctx.can_trade(sym):
                continue
            pos = ctx.position(sym)
            close = ctx.bar(sym).close
            if pos == 0 and close > ctx.ind('sma', sym):
                ctx.set_target(sym, self.p['lots'])
            elif pos > 0 and close < ctx.ind('sma', sym):
                ctx.close(sym)
```

## Class Attributes & Lifecycle

| Member | Type / Signature | Description |
| --- | --- | --- |
| `params` | `dict[str, Any]` | Default parameter values; merged with overrides into `self.p` |
| `space` | `dict[str, Int \| Float \| Categorical]` | Tunable parameter bounds exposed in Web UI and validated on requests (keys must exist in `params`) |
| `setup(self, ctx)` | `SetupContext -> None` | Called once before the day loop to register full-series indicators |
| `on_bar(self, ctx)` | `BarContext -> None` | Called once per bar at `SIGNAL` phase; queued orders fill at the next `OPEN` |
| `on_finish(self, engine)` | `Engine -> None` | Optional hook called once after the day loop completes |

## `SetupContext` API

| Attribute / Method | Return Type | Description |
| --- | --- | --- |
| `ctx.symbols` | `list[str]` | Symbols loaded in the current universe |
| `ctx.dates` | `np.ndarray` | Array of trading dates |
| `ctx.market` | `MarketData` | Full panel data for cross-sectional precomputation |
| `ctx.open/high/low/close/settle/volume/oi(sym)` | `np.ndarray[float64]` | Full-series OI-weighted array, guarded against embedded `NaN` |
| `ctx.add_indicator(name, sym, array, *, allow_gaps=False)` | `None` | Registers indicator array and advances `sym`'s warmup to its first non-`NaN` index. Set `allow_gaps=True` to allow internal `NaN` values |

## `BarContext` API

| Attribute / Method | Return Type | Description |
| --- | --- | --- |
| `ctx.i` / `ctx.date` / `ctx.symbols` | `int` / `date` / `list[str]` | Current bar index, date, and universe symbols |
| `ctx.bar(sym)` | `Bar` | Current weighted bar (`open, high, low, close, settle, volume, oi`) |
| `ctx.ind(name, sym)` | `float` | Value of registered indicator `name` at `ctx.i` |
| `ctx.can_trade(sym)` | `bool` | `True` if `sym` warmup is complete, listed, printed today, and its mapped contract is tradable |
| `ctx.position(sym)` | `int` | Current settled net lots (signed; excludes deferred orders in flight) |
| `ctx.contract(sym)` | `str` | Active calendar contract code for `sym` on this bar (e.g., `'SA509'`) |
| `ctx.equity` / `cash` / `margin_used` / `available` | `float` | Current mark-to-market account balances |
| `ctx.queued_orders()` | `dict[str, int]` | Copy of `{symbol: lot_delta}` queued so far on this bar |
| `ctx.set_target(sym, lots)` | `None` | Queue delta to reach `lots` net position (accounts for held position + `deferred` orders; idempotent per bar) |
| `ctx.close(sym)` | `None` | Alias for `ctx.set_target(sym, 0)` |
| `ctx.buy(sym, lots=1)` / `ctx.sell(sym, lots=1)` | `None` | Add signed delta (`+lots` / `-lots`) to this bar's queued order |
| `ctx.set_stop(sym, price=None, distance=None)` | `None` | Arm/update protective stop at next `OPEN` (pass `price` or `distance`) |
| `ctx.cancel_stop(sym)` | `None` | Remove pending and live stop for `sym` |
| `ctx.stop_price(sym)` | `float \| None` | Currently armed stop price on the held contract (roll-adjusted) |
| `ctx.extreme(sym)` | `float \| None` | Highest high (long) or lowest low (short) on the execution contract since entry (roll-adjusted) |
| `ctx.set_take_profit(sym, price=None, distance=None)` | `None` | Arm/update intrabar limit target at next `OPEN` (pass `price` or `distance`) |
| `ctx.cancel_take_profit(sym)` | `None` | Remove pending and live take-profit for `sym` |
| `ctx.size_for_risk(sym, stop_distance, risk_pct)` | `int` | `int((equity * risk_pct) // (stop_distance * multiplier))` (`0` if `< 1` lot) |

## Protective Bracket Rules

- **OCO execution**: `set_stop` and `set_take_profit` form an OCO pair armed at `OPEN` and checked at `INTRABAR`. Filling either flattens the position and cancels the other.
- **`distance` vs `price` persistence**:
  - `distance`: Anchored to actual fill `avg_entry` (cancels weighted-vs-contract basis). Persists across trades unless cancelled via `cancel_stop` / `cancel_take_profit`.
  - `price`: Scoped to a single logical trade; automatically cleared when the trade closes, flips, or liquidates.
- **Dynamic re-resolution**: At `OPEN`, active legs update if the strategy called `set_stop`/`set_take_profit` again (trailing stop), if scale-in fills changed `avg_entry`, if the position flipped, or if the contract rolled.

## Conventions

- Always check `if not ctx.can_trade(sym): continue` before reading indicators or placing orders; orders placed during warmup are dropped and counted in `warmup_skips`.
- Prefer `ctx.set_target(sym, lots)` over `buy`/`sell` to avoid stacking duplicate signals across bars or deferred sessions.
- Prefer `distance=` over `price=` for stops and targets so basis between the weighted series and execution contract does not skew trigger levels.
- Include `'lots': 1` in `params` to support the CLI `--lots` flag.
