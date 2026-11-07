# Web Panel

Local FastAPI + React research workspace over the core backtest engine, data pipeline, indicator catalog, and SQLite run history.

## CLI & Build

```bash
pip install -e ".[web]"
python main.py web [--host 127.0.0.1] [--port 8888] [--reload] [--clear-password]
```

| Flag | Default | Description |
| --- | --- | --- |
| `--host` | `127.0.0.1` | Bind address (binding off-loopback restricts `Host` header to interface IPs/hostname or `FT_WEB_ALLOWED_HOSTS`) |
| `--port` | `8888` | HTTP listen port |
| `--reload` | `False` | Enable uvicorn auto-reload for backend development |
| `--clear-password` | `False` | Clear stored web access password hash and active sessions on startup |

Frontend build & dev server (`webui/`, requires Node.js `^20.19` or `>=22.12`):

```bash
cd webui && npm install && npm run build   # production build -> ../web/static/
cd webui && npm run dev                    # Vite dev server on :5173 (proxies /api -> :8888)
```

## Workspace Modules

| Area | Capabilities |
| --- | --- |
| **Product Sidebar** | View product data coverage (fresh / stale / empty), select charted product, toggle backtest universe checkboxes, trigger per-product or full data sync, add/edit product specs (`datafeed/products.json`) with roll-contract preview chart. |
| **Main Chart** | OI-weighted daily candlesticks, roll markers, up to 4 stacked sub-pane indicators, and active backtest fills/equity overlay. |
| **Indicators Picker** | Toggle discovered indicators, hot-reload `indicators/`, and edit tunable `space` parameters in place (persisted in browser `localStorage` under `ft.indicatorParams`). |
| **Signals Tab** | Save strategy configurations and compute last-bar signal snapshots (`core.alert.run_alert_snapshot`): pending action, stop, and take-profit per product. Marked stale after data updates. |
| **Backtest Tab** | Run discovered strategies over selected universe and date window; view metrics, equity/drawdown curves, trade log, and breakdowns by symbol and exit reason. |
| **History Tab** | Browse past runs stored in `results/webpanel.db`; click to overlay fills on the chart and restore form parameters, or delete runs. |

## Keyboard Shortcuts

| Key | Action |
| --- | --- |
| `/` or `Ctrl/⌘ + K` | Focus product search (`↑`/`↓` navigate, `Enter` chart product, `Escape` clear) |
| `Ctrl/⌘ + B` | Toggle right product sidebar |
| `Ctrl/⌘ + J` | Toggle bottom drawer |
| `Ctrl/⌘ + Enter` | Run backtest |
| `?` | Open keyboard shortcuts modal |

## HTTP API Summary

| Prefix / Route | Methods | Description |
| --- | --- | --- |
| `/api/health` | `GET` | Service readiness probe |
| `/api/auth/{status,login,logout,password}` | `GET, POST, PUT` | Optional access password and `fv_session` cookie management |
| `/api/meta/exchanges` | `GET` | Supported exchange metadata and credential requirements |
| `/api/products`, `/api/products/{code}` | `GET, POST, PUT, DELETE` | Product registry CRUD (`datafeed/products.json`) |
| `/api/products/{code}/{bars,roll}` | `GET` | Weighted OHLCV bars and roll calendar map |
| `/api/data/{coverage,update}` | `GET, POST` | On-disk CSV coverage and background data download jobs |
| `/api/strategies`, `/api/strategies/reload` | `GET, POST` | Strategy catalog, parameter spaces, and module hot-reload |
| `/api/indicators`, `/api/indicators/reload` | `GET, POST` | Indicator catalog and module hot-reload |
| `/api/products/{code}/indicators/{key}` | `GET` | Standalone indicator calculation (`?p=name=value`) |
| `/api/backtest` | `POST` | Start background backtest job |
| `/api/alerts/preview` | `POST` | Compute last-bar signal snapshot |
| `/api/runs`, `/api/runs/{run_id}` | `GET, DELETE` | Saved backtest runs |
| `/api/runs/{run_id}/price/{symbol}` | `GET` | Per-symbol weighted and contract price series for a saved run |
| `/api/jobs`, `/api/jobs/{job_id}/{stream,cancel}` | `GET, POST` | Background job status, SSE progress stream, and cancellation |

## Security & Concurrency Guards

- **Host & Origin protection**: `HostHeaderMiddleware` validates `Host` against allowed hosts (`FT_WEB_ALLOWED_HOSTS`); `WriteOriginMiddleware` blocks cross-origin state-changing requests (`POST`/`PUT`/`DELETE`/`PATCH`).
- **Parameter validation (`422`)**: Strategy and indicator parameter overrides must be declared in `space`, match the `Int`/`Float`/`Categorical` bounds, and satisfy `constraints`. Out-of-tree `module:Class` references are not accepted over HTTP.
- **Job conflict guards (`409 Conflict`)**:
  - `POST /api/strategies/reload` and product registry writes (`POST`/`PUT`/`DELETE /api/products/{code}`) are rejected while any job or inline task is active.
  - `POST /api/data/update` is rejected if any requested symbol is already being updated by a running job.
  - `POST /api/indicators/reload` is stateless across requests and permitted while jobs run.
