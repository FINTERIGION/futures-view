# Project Layout

```
futures-view/
├── main.py                    # The CLI: data / backtest / web
├── plotting.py                # Chart generation
├── core/                      # Engine internals
│   ├── types.py               #   Bar / Order / Fill / OrderType / Reason
│   ├── market.py              #   MarketData / ProductPanel / ContractSeries
│   ├── broker.py              #   cash, positions, margin, commission, forced liquidation
│   ├── ledger.py              #   fill-driven logical trade ledger
│   ├── engine.py              #   four-phase day loop, rolls, stops, deferral
│   ├── backtest.py            #   run_single_backtest: one run, engine + metrics
│   ├── metrics.py             #   performance metrics
│   ├── indicators.py          #   TA-Lib NaN guard
│   ├── registry.py            #   folder-scan discovery shared by strategies/ and indicators/
│   └── params.py              #   Int / Float / Categorical ranges, range resolution, CLI param parsing
├── strategies/                # Strategy base + examples (tracked) + private modules (gitignored)
│   ├── base.py                #   Strategy / SetupContext / BarContext
│   ├── double_ma.py
│   ├── rsi_mean_reversion.py
│   ├── cross_sectional_momentum.py
│   ├── super_trend_filter.py
│   └── my_strategy.py
├── indicators/                # Chart indicators -- same deal as strategies/ -- see docs/indicator.md
│   ├── base.py                #   Indicator / IndicatorContext / Output
│   ├── ma.py  ema.py  bollinger.py  donchian.py  keltner.py
│   ├── macd.py  rsi.py  kdj.py  cci.py  dmi.py  atr.py  obv.py  oi.py
│   ├── supertrend.py
│   └── my_indicator.py
├── datafeed/                  # Data pipeline
│   ├── sources.py             #   per-exchange download & cache adapters (CZCE / SHFE / DCE)
│   ├── data_update.py         #   OI-weighted aggregation & CSV output (run_updates)
│   ├── data_manager.py        #   load / align / bundle data for the engine
│   ├── products.py            #   registry loader/validator over products.json (multiplier, margin, commission, roll months)
│   └── roll_calendar.py       #   date → main-month contract map (from products.py)
├── web/                       # Web panel backend (FastAPI) -- see docs/web.md
│   ├── app.py                 #   app + SPA static mount (launched by `main.py web`)
│   ├── config.py              #   paths, defaults, retention caps, path-containment check
│   ├── schemas.py             #   pydantic request models
│   ├── jobs.py                #   background job manager (thread pool + SSE)
│   ├── store.py               #   SQLite run-history index (results/webpanel.db)
│   ├── data_status.py         #   on-disk coverage per product
│   ├── serialize.py           #   JSON-safe conversion (inf/NaN/date/numpy)
│   ├── marketcache.py         #   load_market + an LRU over it
│   ├── barscache.py           #   LRU over DataManager.load_dataframe (chart + indicator reads)
│   ├── static/                #   built frontend (gitignored; `npm run build` writes here)
│   └── routers/               #   products, data, strategies, indicators, backtest, runs, jobs
├── webui/                     # Web panel frontend (Vite + React + TypeScript)
│   └── src/                   #   api client, ECharts option builders, workspace shell, panels, i18n (en/zh)
├── tests/                     # pytest suite (synthetic MarketData fixtures)
├── data/                      # Generated CSVs (gitignored)
├── cache/                     # Raw exchange payloads per venue: cache/{CZCE,SHFE,DCE}/ (gitignored)
└── results/                   # Backtest outputs (gitignored), incl. results/web
```

## Tests

```bash
pytest
```

Fixtures are synthetic `MarketData`, so the suite runs without any downloaded data.

## Lint

```bash
pip install -e ".[lint]"
ruff check .                 # rules in pyproject.toml: correctness only, not style
cd webui && npm run lint     # oxlint
```

CI runs both, alongside the tests.
