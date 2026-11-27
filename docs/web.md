# Web Panel

Local FastAPI + React research workspace over the core backtest engine, data pipeline, indicator catalog, and SQLite run history.

## CLI & Build

```bash
pip install -e ".[web]"
python main.py web [--host 127.0.0.1] [--port 8888] [--reload] [--clear-password]
python main.py alert [--no-update]   # run one-shot data update + signal check + third-party push
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
| **Product Sidebar** | View product data coverage (fresh / stale / empty), select charted product, toggle backtest universe checkboxes, trigger per-product or full data sync, add/edit product specs (`datafeed/products.json`). |
| **Main Chart** | Daily candlesticks across contract series (`weighted` OI-weighted continuous, `main` roll-calendar continuous, or `m01`–`m12` month continuous), latest daily HUD, roll markers, up to 4 stacked sub-pane indicators, and active backtest fills & run-window overlay. |
| **Indicators Picker** | Toggle discovered indicators, hot-reload `indicators/`, and edit tunable `space` parameters in place (persisted in browser `localStorage` under `ft.indicatorParams`). |
| **Signals Tab** | Save strategy configurations in SQLite (`results/webpanel.db`) and compute last-bar signal snapshots (`core.alert.run_alert_snapshot`): holding side, pending action, entry/last reference price, stop, and take-profit per product. Toggle per-row inclusion in scheduled push. |
| **Alert Notifications Modal** | Opened from the top-right bell button (centered floating dialog alongside Web Access and Keyboard Shortcuts). Configure global weekday reminder time(s), Telegram Bot (with optional reverse-proxy API base & proxy) or Generic JSON Webhook channels, trigger manual update & push, and inspect delivery history. |
| **Backtest Tab** | Run discovered strategies over selected universe and date window; view metrics, equity curve, trade log, and breakdowns by symbol and exit reason. |
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
| `/api/meta/exchanges` | `GET` | Supported exchange codes and default roll rules |
| `/api/products`, `/api/products/{code}` | `GET, POST, PUT, DELETE` | Product registry CRUD (`datafeed/products.json`) |
| `/api/products/{code}/{bars,roll}` | `GET` | Daily OHLCV bars (`?series=weighted\|main\|m01..m12`) and roll calendar map |
| `/api/data/{coverage,update}` | `GET, POST` | On-disk CSV coverage and background data download jobs |
| `/api/strategies`, `/api/strategies/{key}`, `/api/strategies/reload` | `GET, POST` | Strategy catalog, single-strategy metadata, parameter spaces, and module hot-reload |
| `/api/indicators`, `/api/indicators/{key}`, `/api/indicators/reload` | `GET, POST` | Indicator catalog, single-indicator metadata, and module hot-reload |
| `/api/products/{code}/indicators/{key}` | `GET` | Standalone indicator calculation (`?series=weighted\|main\|m01..m12&p=name=value`) |
| `/api/backtest` | `POST` | Start background backtest job |
| `/api/alerts/preview` | `POST` | Compute last-bar signal snapshot (optionally persisting onto a saved monitor) |
| `/api/alerts/monitors`, `/api/alerts/monitors/{id}` | `GET, POST, PUT, DELETE` | Persistent signal monitor configurations (plus `POST /import` for legacy browser entries) |
| `/api/alerts/channels`, `/api/alerts/channels/providers`, `/api/alerts/channels/{id}` | `GET, POST, PUT, DELETE` | Pluggable third-party notification providers & channels (Telegram Bot, Generic Webhook; secrets masked on read) |
| `/api/alerts/channels/{id}/test` | `POST` | Send a sample test message through a configured channel |
| `/api/alerts/schedule` | `GET, PUT` | Global weekday reminder times, timezone, data-sync option, and message language |
| `/api/alerts/dispatch`, `/api/alerts/deliveries` | `POST, GET` | Trigger manual update-and-notify job and browse recent delivery audit logs |
| `/api/runs`, `/api/runs/{run_id}` | `GET, DELETE` | Saved backtest runs |
| `/api/runs/{run_id}/price/{symbol}` | `GET` | Per-symbol weighted/contract close series, fill signals, and roll dates for a saved run |
| `/api/jobs`, `/api/jobs/{job_id}`, `/api/jobs/{job_id}/{stream,cancel}` | `GET, POST` | Background job list/status, SSE progress stream, and cancellation |

## Security & Concurrency Guards

- **Host, Origin, and Session protection**: `HostHeaderMiddleware` validates `Host` against allowed hosts (`FT_WEB_ALLOWED_HOSTS`); `WriteOriginMiddleware` blocks cross-origin state-changing requests (`POST`/`PUT`/`DELETE`/`PATCH`) outside `FT_WEB_ALLOWED_ORIGINS`; `AuthMiddleware` enforces the optional access-password `fv_session` cookie on `/api` routes when a password is set.
- **Environment variables**: `FT_WEB_ALLOWED_HOSTS` (extra allowed `Host` values), `FT_WEB_ALLOWED_ORIGINS` (extra allowed CORS/write origins), `FT_WEB_PORT` (listening port set by `main.py web`), and `FT_DISABLE_SCHEDULER` (set truthy to disable the in-process alert scheduler).
- **Outbound notification guard**: Telegram `api_base` and Webhook `url` reject cloud metadata/link-local addresses (`169.254.0.0/16`, `fe80::/10`, `metadata.google.internal`, etc.) and the local panel's own listening port (`FT_WEB_PORT`), while allowing other localhost/LAN webhook targets. Changing a channel's destination URL/proxy requires re-entering stored secrets so masked credentials cannot be redirected.
- **Parameter validation (`422`)**: Strategy and indicator parameter overrides must be declared in `space`, match the `Int`/`Float`/`Categorical` bounds, and satisfy `constraints`. Out-of-tree `module:Class` references are not accepted over HTTP.
- **Job conflict guards (`409 Conflict`)**:
  - `POST /api/strategies/reload` and product registry writes (`POST`/`PUT`/`DELETE /api/products/{code}`) are rejected while any job or inline task is active.
  - `POST /api/data/update` is rejected if any requested symbol is already being updated by a running manual job; per-symbol data writes are serialized across manual updates and scheduled alert dispatches via `web/data_sync.py`.
  - `DELETE /api/runs/{run_id}` is rejected while the run is still `running`.
  - `POST /api/indicators/reload` is stateless across requests and permitted while jobs run.
