# FuturesView web panel frontend

The browser UI for FuturesView, built with Vite, React, TypeScript, and ECharts. It is a client of the FastAPI backend in `../web/`. What the panel does, and how its API is laid out, is described in [Web Panel](../docs/web.md).

Requires Node.js `^20.19` or `>=22.12` (Vite 8).

## Develop

Start the backend from the repo root, then the Vite dev server here:

```bash
python main.py web      # API on http://127.0.0.1:8888
```

```bash
cd webui
npm install             # first time only
npm run dev             # http://localhost:5173, hot reload
```

The dev server proxies `/api` to `127.0.0.1:8888` (see `vite.config.ts`), and the backend accepts writes from the dev server's origin, so the UI works the same as when it is served by the backend.

## Build

```bash
npm run build           # tsc -b, then vite build into ../web/static
```

`python main.py web` serves whatever is in `../web/static/`. That directory is gitignored, so rebuild after pulling frontend changes.

## Check

```bash
npm run lint            # oxlint
npm test                # vitest, jsdom
npm run build           # also typechecks the tests
```

CI runs all three.

## Layout

| Path | Contents |
| --- | --- |
| `src/api/` | Typed fetch client and endpoint functions |
| `src/chart/` | The main chart, its toolbar, the indicator picker and params editor |
| `src/charts/` | ECharts option builders |
| `src/shell/` | Workspace shell: top bar, sidebar, bottom drawer, shortcuts |
| `src/panels/` | Contents of the bottom drawer's tabs |
| `src/components/` | Shared UI pieces |
| `src/theme/` | Light/dark mode and the chart palette |
| `src/i18n/` | English and Chinese strings |
