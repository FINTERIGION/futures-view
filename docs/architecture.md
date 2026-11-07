# Project Layout

Overview of the repository structure, module responsibilities, and verification commands.

## Directory Tree

```text
futures-view/
├── main.py                    # CLI entry point: data / backtest / web
├── plotting.py                # Matplotlib chart generator for CLI backtests
├── core/                      # Backtest engine & shared primitives
│   ├── types.py               #   Bar, Order, Fill, OrderType, Reason
│   ├── market.py              #   MarketData, ProductPanel, ContractSeries
│   ├── broker.py              #   Cash, positions, margin, commission, forced liquidation
│   ├── ledger.py              #   Fill-driven logical trade ledger (TRADE_LOG_FIELDS)
│   ├── engine.py              #   Four-phase daily loop (OPEN -> INTRABAR -> SIGNAL -> SETTLE)
│   ├── backtest.py            #   run_single_backtest: engine execution + metrics
│   ├── alert.py               #   run_alert_snapshot: last-bar pending action / SL / TP
│   ├── metrics.py             #   Performance metrics & symbol/exit-reason breakdowns
│   ├── indicators.py          #   TA-Lib embedded-NaN guard
│   ├── registry.py            #   Dynamic module discovery for strategies/ and indicators/
│   └── params.py              #   Int, Float, Categorical specs and override validation
├── strategies/                # Strategy plugins (tracked examples + gitignored private modules)
│   ├── base.py                #   Strategy, SetupContext, BarContext
│   ├── double_ma.py
│   ├── rsi_mean_reversion.py
│   ├── cross_sectional_momentum.py
│   └── my_strategy.py         #   Starter template
├── indicators/                # Chart indicator plugins (tracked + gitignored private modules)
│   ├── base.py                #   Indicator, IndicatorContext, Output
│   ├── ma.py  ema.py  bollinger.py  donchian.py  keltner.py
│   ├── macd.py  rsi.py  kdj.py  cci.py  dmi.py  atr.py  obv.py  oi.py
│   └── my_indicator.py        #   Starter template
├── datafeed/                  # Exchange data pipeline & product registry
│   ├── products.json          #   Product specifications (multiplier, margin, fees, roll months)
│   ├── products.py            #   Registry loader, validator, and cost/roll helpers
│   ├── roll_calendar.py       #   Trading date -> active main contract mapper
│   ├── sources.py             #   Exchange download & cache adapters (CZCE / SHFE / DCE)
│   ├── data_update.py         #   OI-weighted continuous series builder & CSV writer
│   └── data_manager.py        #   DataFrame loader and universe alignment for Engine
├── web/                       # FastAPI backend for the web panel
│   ├── app.py                 #   ASGI app, Host/Origin/Auth middlewares, static SPA mount
│   ├── config.py              #   Paths, host/port defaults, allowlists
│   ├── auth.py                #   Optional access password hashing, session cookies, rate limit
│   ├── schemas.py             #   Pydantic request/response models
│   ├── jobs.py                #   Thread-pool background job runner + SSE broadcaster
│   ├── store.py               #   SQLite persistence (results/webpanel.db)
│   ├── data_status.py         #   Per-product CSV coverage inspector
│   ├── serialize.py           #   JSON serializer (NaN/inf/date/numpy handling)
│   ├── marketcache.py         #   LRU cache over MarketData bundles
│   ├── barscache.py           #   LRU cache over DataManager DataFrames
│   ├── static/                #   Built frontend assets (gitignored; written by `npm run build`)
│   └── routers/               #   auth, products, data, strategies, indicators, backtest, alerts, runs, jobs
├── webui/                     # Frontend SPA (Vite + React + TypeScript + ECharts)
│   └── src/
│       ├── api/               #   Typed fetch client & endpoint wrappers
│       ├── auth/              #   Optional access-password gate, login screen, settings
│       ├── chart/             #   Main super chart, toolbar, indicator picker & param editor
│       ├── charts/            #   ECharts option builders
│       ├── components/        #   Shared UI primitives (Card, Table, Drawer, Tabs, Toast, ...)
│       ├── i18n/              #   en / zh locale resources
│       ├── panels/            #   Bottom drawer tabs (backtest form/results, signals, history)
│       ├── shell/             #   Workspace shell (top bar, sidebar, bottom drawer, shortcuts)
│       └── theme/             #   Light/dark mode & categorical chart palette
├── tests/                     # Pytest suite (runs on synthetic MarketData fixtures)
├── data/                      # Generated `{SYMBOL}.csv` and `{SYMBOL}_weighted.csv` (gitignored)
├── cache/                     # Raw exchange payloads `cache/{CZCE,SHFE,DCE}/` (gitignored)
└── results/                   # CLI outputs and `webpanel.db` (gitignored)
```

## Verification & Linting

```bash
# Run unit & API tests (uses synthetic fixtures; no downloaded data required)
pytest

# Python lint (correctness rules configured in pyproject.toml)
pip install -e ".[lint]"
ruff check .

# Frontend lint, unit tests, and typecheck
cd webui && npm run lint
cd webui && npm test
cd webui && npm run build
```
