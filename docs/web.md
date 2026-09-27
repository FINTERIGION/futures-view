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

`python main.py web --host 0.0.0.0` binds beyond localhost; the panel has no authentication and can rewrite the product registry and delete data files, so only do this on a network you trust.

Two checks stop a web page you have open from driving the API through your browser. Every request must carry a Host header naming the panel (`FT_WEB_ALLOWED_HOSTS` widens the list), and every write (POST/PUT/PATCH/DELETE) that carries an `Origin` must come from the panel's own address or the Vite dev server, or it is refused with 403. Behind a reverse proxy that rewrites the Host header, list the public origin in `FT_WEB_ALLOWED_ORIGINS`, e.g. `https://panel.example`.

## What it does


| Where           | What it does                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product sidebar | Every registered product with its data coverage, a per-product download and edit, and Update All. Adding or editing a product opens a drawer with the registry form and a candlestick chart with a roll-contract overlay                                                                                                                                         |
| Main chart      | The charted product's OI-weighted daily candles and roll points, the indicators ticked in the picker, and the fills and window of the run currently opened                                                                                                                                                                                                       |
| Backtest tab    | Run any discovered strategy over the sidebar's universe and a date range; metric tiles, equity curve, trade log, per-symbol and per-exit-reason breakdowns. The form edits exactly the params the strategy lists in `space`; the rest run at the class default. Opening a past run refills the fields with the values that run used                              |
| History tab     | Past runs: open one to overlay it on the chart and refill the backtest form, or delete it                                                                                                                                                                                                                                                                        |
| Indicators      | The chart toolbar's picker lists every class under `indicators/`; ticking one overlays it on the price pane or gives it a sub-pane, per the class's own declaration. Each row shows its current params, and the pencil that appears on hover edits them in place; see [Editing params](#editing-indicator-params) below and [Writing an Indicator](indicator.md) |




## Getting around

The panel is one screen, not a set of routed pages: a chart filling the width, a product sidebar down the right, and a tabbed drawer along the bottom. Both side panels collapse, and the drawer's top edge is draggable (or resizable with the arrow keys once its handle has focus).


|             |                                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product row | Click toggles it into the backtest universe (the tick box at the head of the row); double-click charts it. The charted product is always in the universe, so its box is drawn ticked and dimmed. The dot on the right is coverage — filled green fresh, amber stale, hollow never downloaded — and hovering the row reveals per-product download and edit buttons |
| Search      | `/` jumps to it from anywhere; ↑/↓ move a highlight through the matches and Enter charts the highlighted one. Escape clears the filter, then gives the keyboard back to the chart                                                                                                                                                                                 |
| Theme       | Light, dark, or follow the OS — the switch in the top bar. The choice is remembered per browser, and the charts follow it, since their colours are baked into the canvas rather than read from CSS                                                                                                                                                                |
| Shortcuts   | `Ctrl/⌘+B` sidebar, `Ctrl/⌘+J` bottom drawer, `Ctrl/⌘+Enter` run the backtest, `?` for the full list                                                                                                                                                                                                                                                              |


A job's progress also rides in the top bar while it runs, and a finished run or data update raises a toast — either can finish while the panel that started it is collapsed or behind another tab.

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
  app.py                    App + SPA static mount (launched by `main.py web`)
  config.py                 Paths, host/port defaults
  jobs.py                   Background job manager (thread pool + SSE)
  marketcache.py            load_market + an LRU over it
  barscache.py              LRU over DataManager.load_dataframe (chart + indicator reads)
  store.py                  SQLite run-history index (results/webpanel.db)
  serialize.py              JSON-safe conversion (inf/NaN/date/numpy)
  schemas.py                Pydantic request models
  routers/                  products, data, strategies, indicators, backtest, runs, jobs

webui/                    Vite + React + TypeScript frontend
  src/api/                   Typed fetch client + endpoint functions
  src/charts/                ECharts option builders (the main chart, candlestick, line)
  src/chart/                 The main super chart, its toolbar and indicator picker
  src/shell/                 Workspace shell: top bar, sidebar, bottom drawer, shortcuts
  src/panels/                What the bottom drawer's tabs hold (backtest form, results, history)
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