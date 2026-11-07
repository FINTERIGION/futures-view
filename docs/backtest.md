# Backtesting

Runs a strategy over historical data using a four-phase daily execution loop and outputs a trade log, performance metrics, and charts.

## CLI

```bash
python main.py backtest --symbols CF FG --start 2020-01-01 --end 2026-12-31 --strategy double_ma --cash 100000
```

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--symbols` | `str...` | `SA FG CF C` | Products to load |
| `--start` / `--end` | `YYYY-MM-DD` | `2020-01-01` / `2026-12-31` | Backtest date window |
| `--cash` | `float > 0` | `100000` | Initial account equity (CNY) |
| `--strategy` | `str` | `double_ma` | Discovered short name or `module.path:ClassName` |
| `--slippage` | `float >= 0` | `0` | Slippage in ticks (`slippage * tick_size` per fill) |
| `--lots` | `int` | `1` | Override `params['lots']` |
| `--param` | `NAME=VALUE` | — | Override strategy parameter (repeatable; casts `int` → `float` → `bool` → `str`) |
| `--update-data` | `flag` | `False` | Run data sync before backtest |
| `--results-dir` | `path` | `results/` | Output directory |
| `--keep-last` | `int` | `None` | Retain only the `N` most recent run outputs |
| `--quiet` / `--verbose` | `flag` | `INFO` | Set log level to `WARNING` / `DEBUG` |

## Execution Model

Signals compute on `{SYMBOL}_weighted.csv`; orders fill on `{SYMBOL}.csv` against the calendar main contract. Each trading day executes four phases in order:

| Phase | Operations |
| --- | --- |
| `OPEN` | 1. Roll open position if calendar contract changed.<br>2. Fill yesterday's queued orders at today's open (± slippage) after margin check.<br>3. Arm or update resting stop / take-profit levels. |
| `INTRABAR` | Check armed stop and take-profit against contract `high` / `low`:<br>- Gap past level at open fills at open.<br>- If both hit on the same bar, **stop** wins.<br>- Stop pays slippage; take-profit fills as a limit order (no slippage). |
| `SIGNAL` | Run `strategy.on_bar(ctx)`. Orders queued here never fill on the current bar. |
| `SETTLE` | Mark positions to settlement price. If `available < 0`, force-liquidate all positions at settle (± slippage). If `equity <= 0` after liquidation, set `blown_up = True` and terminate run. |

## Engine Rules

### Contract Rolls
- **Single-leg invariant**: Each product holds at most one contract at a time. Rolling closes the old contract and opens the new contract at their respective open prices.
- **Dark old contract (still active)**: Roll defers until the old contract prints a session; queued orders remain targeted at the old leg and defer with it.
- **Dark old contract (expired/delisted)**: Position closes at its last carried settlement mark, opens on the new contract at open, and increments `stranded_rolls`.
- **Bracket re-anchoring**: `distance` specs re-resolve from the new leg's `avg_entry`; `price` specs shift by the realized roll basis.

### Margin & Capital Guards
- **Pre-fill margin check**: At `OPEN`, orders that increase margin requirements beyond current equity are rejected (`n_rejected_orders` increments; orders are not replayed). Risk-reducing orders (closes, partial reductions, flips to lower-margin exposure), rolls, and forced liquidations bypass this check.
- **Account blow-up**: If `equity <= 0` after `SETTLE` forced liquidation, remaining bars are skipped and `blown_up = True`.
- **Slippage**: Applied as `slippage * tick_size` against market-style fills (open orders, both legs of a roll, triggered stops, forced liquidations). Take-profit fills are unslipped.

## Outputs

Saved to `--results-dir` with timestamp `<ts>` (`YYYYMMDD_HHMMSS`):

| File | Description |
| --- | --- |
| `<Strategy>_trades_<ts>.csv` | Closed logical trades (rolls folded into the parent trade) |
| `<Strategy>_equity_<ts>.png` | Equity and drawdown curve |
| `<Strategy>_returns_<ts>.png` | Cumulative return curve |
| `<Strategy>_position_<ts>.png` | Net position exposure over time |
| `<Strategy>_signals_<ts>.png` | Price series with entry/exit markers |
| `<Strategy>_summary_<ts>.png` | Metrics summary panel |

### Trade Log Columns (`TRADE_LOG_FIELDS`)
`trade_id`, `open_date`, `close_date`, `direction`, `symbol`, `contract`, `contracts`, `n_rolls`, `open_price`, `close_price`, `size`, `gross_pnl`, `commission`, `net_pnl`, `margin_used`, `open_at_end`, `forced`, `exit_reason`, `open_bar`, `close_bar`.

## Metrics (`core.metrics.compute_metrics`)

| Category | Keys |
| --- | --- |
| **Account & Returns** | `initial_cash`, `final_equity`, `total_return` (%), `annualized_return` (%), `annualized_volatility` (%) |
| **Risk-Adjusted** | `sharpe_ratio`, `sortino_ratio`, `calmar_ratio` (excess over `DEFAULT_RISK_FREE_RATE = 0.03`, annualized by actual bars/year) |
| **Drawdown** | `max_drawdown` (%), `max_drawdown_recovery_days` (`int \| None`) |
| **Trades** | `n_trades`, `n_winning`, `n_losing`, `win_rate` (%), `profit_loss_ratio`, `profit_factor`, `expectancy`, `avg_win`, `avg_loss`, `avg_holding_days` |
| **Capital & Health** | `capital_exposure` (%), `turnover` (x), `n_forced_liquidations`, `n_rejected_orders`, `blown_up`, `reconciliation_drift` |
| **Breakdowns** | `by_symbol` (`{sym: {n_trades, win_rate, net_pnl, expectancy}}`), `by_exit_reason` (`{reason: {n_trades, share, win_rate, net_pnl, expectancy}}`) |
