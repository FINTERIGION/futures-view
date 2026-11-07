# Data Pipeline

Downloads historical daily bars from `CZCE`, `SHFE`, and `DCE`, caches raw exchange payloads, and generates contract-level CSVs plus open-interest–weighted continuous series.

## CLI

```bash
python main.py data [symbols ...] [--force] [--rebuild-only]
```

| Argument | Type | Default | Description |
| --- | --- | --- | --- |
| `symbols` | `str...` | All registered | Product codes to sync (e.g., `SA CF`) |
| `--force` | `flag` | `False` | Ignore local cache and re-download all history |
| `--rebuild-only` | `flag` | `False` | Rebuild CSVs from local `cache/` without network requests |

- **Credentials**: `DCE` requires `DCE_API_KEY` and `DCE_SECRET` environment variables.
- **Cache granularity**: `CZCE` caches 1 file/year; `SHFE` and `DCE` cache 1 payload/trading day.

## Outputs

| Path | Format | Usage |
| --- | --- | --- |
| `cache/{CZCE,SHFE,DCE}/` | Raw venue payloads | Local download cache |
| `data/{SYMBOL}.csv` | Daily contract bars (`open,high,low,close,settle,volume,oi`) | Order fills, roll execution, mark-to-market |
| `data/{SYMBOL}_weighted.csv` | OI-weighted continuous daily series | Strategy signals (`SetupContext` / `BarContext`) and chart candles |

## Product Registry (`datafeed/products.json`)

Loaded at import into `datafeed.products.PRODUCTS`. Managed via `list_products()`, `get_product()`, `require_products()`, `product_costs()`, `tick_size()`, `roll_rule()`, `validate_product()`, `parse_product()`, `save_registry()`, and `reload_registry()`.

| Field | Type | Description |
| --- | --- | --- |
| `exchange` | `'CZCE' \| 'SHFE' \| 'DCE'` | Exchange adapter selector |
| `name` / `name_zh` | `str` | English and Chinese display names |
| `start_year` | `int` | Earliest year to fetch |
| `multiplier` | `int \| float` | Contract multiplier (units per lot) |
| `tick_size` | `float` | Minimum price fluctuation |
| `margin_rate` | `float` | Initial margin ratio (fraction of notional) |
| `commission_rate` | `float` (optional) | Commission as fraction of notional |
| `commission_per_lot` | `float` (optional) | Fixed commission in CNY per lot |
| `main_months` | `list[int]` | Active delivery months (e.g., `[1, 5, 9]`) |
| `roll_lead_months` | `int` | Months before delivery month to roll out (rolls on the 1st calendar day of `delivery_month - roll_lead_months`) |
