# FuturesView

**A chart-first research workspace for Chinese commodity futures** on **CZCE**, **SHFE**, and **DCE**, running locally in your browser on top of a self-built daily-bar backtesting engine.

Chart a product and run a backtest on that same picture. The panel and `main.py` share one engine, so a run gives the same numbers from either place.

## Features

- **OI-weighted chart, rolls marked.** The charted product's full open-interest–weighted daily history, with roll points on the candles. Built-in indicators draw on the price pane or in their own panes; drop a file in `indicators/` and reload.
- **Backtests on the same chart.** Fills land as markers, the test window is shaded, and the drawer shows equity, trades, and per-symbol / per-exit-reason breakdowns. Any past run reopens onto the chart.
- **Signals on the continuous series, fills on real contracts.** Orders execute on each product's rolling main contract, with its multiplier, margin, commission, and daily forced liquidation.
- **One pipeline for CZCE, SHFE, and DCE.** Contract-level OHLC is cleaned into the series both the panel and the CLI read. `main.py` runs the same downloads and backtests without a browser.

## Quick Start

Requirements: Python 3.11+, and Node.js 20.19+ to build the frontend.

Install the engine and the web server.

```bash
git clone https://github.com/FINTERIGION/futures-view.git
cd futures-view
pip install -e ".[web]"
```

Build the frontend once.

```bash
cd webui
npm install
npm run build
cd ..
```

DCE needs credentials ([apply here](http://www.dce.com.cn/dce/channel/list/7000198.html)) for historical data.

```bash
export DCE_API_KEY=...
export DCE_SECRET=...
```

Start the panel, then open [http://127.0.0.1:8000](http://127.0.0.1:8000).

```bash
python main.py web
```

## Command Line

The same data downloads and backtests also run without a browser. Backtest outputs (charts, trade log) land in `results/`.

```bash
python main.py data
python main.py backtest --symbols CF FG --start 2020-01-01 --end 2026-12-31 --strategy double_ma --cash 100000
```

| Subcommand | What it does                                              |
| ---------- | --------------------------------------------------------- |
| `data`     | Download exchange history, rebuild OI-weighted daily bars |
| `backtest` | Run one strategy over a date range                        |
| `web`      | Serve the browser panel                                   |


## Documentation


| Page                                      | Contents                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| [Data Pipeline](docs/data.md)             | Exchange downloads, `main.py data` flags, generated files, product registry          |
| [Backtesting](docs/backtest.md)           | `main.py backtest` flags, four-phase execution model, outputs, metrics               |
| [Writing a Strategy](docs/strategy.md)    | `Strategy` lifecycle, `SetupContext` / `BarContext` API, conventions                 |
| [Writing an Indicator](docs/indicator.md) | `Indicator` class, `Output` styling, panes and value ranges, the picker in the panel |
| [Web Panel](docs/web.md)                  | Browser UI for products, data, backtest, run history                                 |
| [Project Layout](docs/architecture.md)    | Directory map, tests                                                                 |
