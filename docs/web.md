# Web Panel

A local browser UI over the same engine the CLI uses: manage the product registry, download data, run backtests with live progress and interactive charts, and browse run history. Writing or editing a strategy stays in the editor.

```bash
pip install -e ".[web]"
python main.py web
```

That serves the pre-built frontend from `web/static/`. To change the frontend, rebuild it:

```bash
cd webui
npm install           # first time only
npm run build         # writes to ../web/static
```

`python main.py web --host 0.0.0.0` binds beyond localhost. The API is open to whoever can reach the process, which is the local-research default. Set an access password (optional) first, then expose it past this machine. If you forget the password, stop the server and start it with `python main.py web --clear-password`. That drops the hash and every login session, then serves the panel open again so you can set a new one.

## What it does


| Where           | What it does                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product sidebar | Every registered product with its data coverage, a per-product download and edit, and Update All. Adding or editing a product opens a drawer with the registry form and a candlestick chart with a roll-contract overlay                                                                                                                                         |
| Main chart      | The charted product's OI-weighted daily candles and roll points, the indicators ticked in the picker, and the fills and window of the run currently opened                                                                                                                                                                                                       |
| Signals tab     | Saved strategy configurations with per-row signal snapshots. Each row shows its monitored products, actionable-operation summary, as-of date and status. New, edit and copy share the Backtest strategy-parameter form; saving computes the first or replacement snapshot. Expanding a row only reveals its existing snapshot, with explicit Compute now / Refresh, per-product chart links, stops and take-profits. Refresh All runs sequentially through the single alert job slot. |
| Backtest tab    | Run any discovered strategy over the sidebar's universe and a date range; key metrics, equity curve, trade log, per-symbol and per-exit-reason breakdowns. Grouped fields edit exactly the params the strategy lists in `space`; the rest run at the class default. Product chips can be removed directly. Opening a past run refills the fields with the values that run used                                      |
| History tab     | Past runs: open one to overlay it on the chart and refill the backtest form, or delete it                                                                                                                                                                                                                                                                        |
| Indicators      | The chart toolbar's picker lists every class under `indicators/`; ticking one overlays it on the price pane or gives it a sub-pane, per the class's own declaration. Each row shows its current params, and the pencil that appears on hover edits them in place; see [Editing params](#editing-indicator-params) below and [Writing an Indicator](indicator.md) |




## Getting around

The panel is one screen, not a set of routed pages: a chart filling the width, a product sidebar down the right, and a tabbed drawer along the bottom. Both side panels collapse, and the drawer's top edge is draggable (or resizable with the arrow keys once its handle has focus). Collapsed drawer tabs remain visible; choosing one opens that panel. On narrow screens the product sidebar overlays the chart, closes when its backdrop is clicked or Escape is pressed, and retracts after a product is charted.


|             |                                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product row | Click or press Enter/Space on the row to chart it; use its checkbox independently to add or remove it from the backtest universe. The dot on the right is coverage — filled green fresh, amber stale, hollow never downloaded. Per-product download and edit buttons appear on hover/focus and stay available on touch layouts |
| Search      | `/` jumps to it from anywhere; ↑/↓ move a highlight through the matches and Enter charts the highlighted one. Escape clears the filter, then gives the keyboard back to the chart                                                                                                                                                                                 |
| Theme       | Light, dark, or follow the OS — the switch in the top bar. The choice is remembered per browser, and the charts follow it, since their colours are baked into the canvas rather than read from CSS                                                                                                                                                                |
| Web access  | The lock icon in the top bar. Optional password for reaching the panel from another machine or the public internet; this browser stays signed in after you set it. A forgotten password is cleared with `python main.py web --clear-password`                                                                                                                     |
| Shortcuts   | `Ctrl/⌘+B` sidebar, `Ctrl/⌘+J` bottom drawer, `Ctrl/⌘+Enter` run the backtest, `?` for the full list                                                                                                                                                                                                                                                              |


A job's progress also rides in the top bar while it runs. Click its pill to open the Backtest or Signals tab, or the product sidebar for a data update. A finished run or data update raises a toast — either can finish while the panel that started it is collapsed or behind another tab. After new market data arrives, existing signal snapshots are marked stale rather than recalculated automatically.

## Editing indicator params

Hover a row in the indicator picker and click its pencil to edit that indicator's params. The form lists every param the class declares in `space`, with its declared range and default under each field.

**Apply** checks the values in two steps before keeping them:

1. The browser checks each value against the class's `space`: kind (int or float) and range. A bad value is flagged on its own field.
2. If a product is charted, the values route computes the indicator with the new params. That is where the class's `constraints` (`fast < slow`) run. If the server refuses, its message stays in the editor and nothing is saved.

Applied params are drawn at once, the row's summary turns accent-coloured, and the pane title shows the new values (`KDJ(14, 3, 3)`). Applying also ticks the row if it wasn't ticked. **Defaults** refills the form with the class's defaults, and applying them removes the override.

Overrides are stored per browser (`ft.indicatorParams` in `localStorage`), and only for params that differ from the default. So if the author later changes a default in Python, it still applies wherever the user never touched that param. An override for a param the class no longer lists in `space` is ignored. If a reload narrows a range so a saved value is now refused, the chart's warning banner names the problem and offers **Reset parameters**.

## Architecture

```
web/                      FastAPI backend
  app.py                    App + SPA static mount + Host / Origin / optional-password middleware
  config.py                 Paths, host/port defaults
  auth.py                   Password hash, session cookies, login rate limit
  jobs.py                   Background job manager (thread pool + SSE)
  marketcache.py            load_market + an LRU over it
  barscache.py              LRU over DataManager.load_dataframe (chart + indicator reads)
  store.py                  SQLite run-history index + access-password rows (results/webpanel.db)
  serialize.py              JSON-safe conversion (inf/NaN/date/numpy)
  schemas.py                Pydantic request models
  routers/                  auth, products, data, strategies, indicators, backtest, alerts, runs, jobs

webui/                    Vite + React + TypeScript frontend
  src/api/                   Typed fetch client + endpoint functions
  src/charts/                ECharts option builders (the main chart, candlestick, line)
  src/chart/                 The main super chart, its toolbar and indicator picker
  src/auth/                  Optional access-password gate, login screen, settings drawer
  src/shell/                 Workspace shell: top bar, sidebar, bottom drawer, shortcuts
  src/panels/                What the bottom drawer's tabs hold (backtest form, results, alerts, history)
  src/components/            Card, Table, Drawer, Tabs, EChart, JobProgress, Toast, Icon, ...
  src/theme/                 Light/dark mode + the chart colour palette
  src/index.css              Design tokens -- every colour, space and radius below it
  src/i18n/                  en / zh resource files
```

The backend is a thin layer: every route calls the same functions the CLI calls (`run_single_backtest`, `DataManager`, `discover_strategies`).

### Strategies

`GET /api/strategies` lists every class under `strategies/`. A module that fails to import, or whose class shares a short name with another, stays in the list as an entry carrying `errors`, and the backtest form offers it disabled with the message. The rest of the list, and backtests of every other strategy, are unaffected.

`POST /api/strategies/reload` re-imports every module under `strategies/` and reports the ones that failed in `failed`. It is refused with 409 while a job is running, checked while no new job can start.

### Indicators

`GET /api/products/{code}/indicators/{key}` computes a chart indicator standalone, over the same `DataManager` frame the candles come from — no backtest, no engine. Parameter overrides arrive as repeated `p=name=value`, the same token as the CLI's `--param`, and are bounded by the class's declared `space` before they reach TA-Lib.

`POST /api/indicators/reload` re-imports every module under `indicators/`. Unlike `strategies/reload` it is *not* refused while a job runs: that 409 exists because a running backtest holds a `Strategy` class object, and nothing holds an `Indicator` across a request.

### Product registry

`datafeed/products.json` is the registry — `datafeed/products.py` loads it, validates writes (`validate_product`/`save_registry`), and keeps every existing helper (`product_costs`, `roll_rule`, `list_products`, ...) unchanged.

Product writes are refused with 409 while any job is running: the engine reads costs and roll rules live, per fill, so an edit landing mid-backtest would silently corrupt that run's numbers. The check and the write happen while no new job can start, so one cannot slip in between them, and any work that runs inline rather than on the pool registers with the job manager for its duration so the guard sees it too.

A data update refuses with 409 if any of its symbols is already being downloaded: the two jobs write the same CSVs from independent fetches, and the loser would overwrite the winner.