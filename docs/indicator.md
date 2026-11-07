# Writing an Indicator

Indicators subclass `indicators.base.Indicator`, compute full-series arrays over a product's OI-weighted bars, and declare how the Web UI renders them.

## Discovery & Naming

- **Location**: Drop `.py` modules into `indicators/` (see `indicators/my_indicator.py` template).
- **Short key**: Class name converted to `snake_case` with trailing `_indicator` stripped when an underscore remains (`Rsi` → `rsi`; name classes `Rsi`, `Macd`, not `RsiIndicator`).
- **Collision rule**: Duplicate short keys mark both modules as errored in the catalog until renamed.

## Minimal Template

```python
import talib
from .base import Indicator, Int, Output


class Rsi(Indicator):
    label = 'RSI'
    pane = 'sub'
    precision = 1
    value_range = (0, 100)
    guides = (30, 70)
    params = {'period': 14}
    space = {'period': Int(2, 100)}
    outputs = (Output('rsi', label='RSI', color=4),)

    def compute(self, ctx, sym):
        return {'rsi': talib.RSI(ctx.close(sym), self.p['period'])}
```

## Class Attributes

| Attribute | Type | Default | Description |
| --- | --- | --- | --- |
| `label` | `str` | `key.replace('_', ' ').upper()` | Display name in the indicator picker |
| `pane` | `'main' \| 'sub'` | `'main'` | `'main'` overlays on price candles; `'sub'` renders in a dedicated stacked pane (max 4 active) |
| `precision` | `int` | `2` | Decimal places in tooltips and sub-pane y-axis labels |
| `value_range` | `tuple[float \| None, float \| None] \| None` | `None` | Fixed `(min, max)` y-axis bounds (`pane='sub'` only; rejected on `'main'`) |
| `guides` | `tuple[float, ...]` | `()` | Horizontal reference lines on a sub-pane (e.g., `(30, 70)`) |
| `outputs` | `tuple[Output, ...]` | `()` | Non-empty tuple of `Output` declarations |
| `params` | `dict[str, Any]` | `{}` | Default parameter dict; instance values reside in `self.p` |
| `space` | `dict[str, Int \| Float \| Categorical]` | `{}` | Tunable parameter bounds (required for any param overridden via UI or URL) |
| `constraints` | `tuple[Callable[[dict], bool], ...]` | `()` | Cross-parameter invariants (e.g., `(lambda p: p['fast'] < p['slow'],)`) |

## `Output` Specification

`Output(key, label=None, kind='line', color=None, style='solid')`

| Field | Values | Description |
| --- | --- | --- |
| `key` | `str` | Key matching the dict returned by `compute(self, ctx, sym)` |
| `label` | `str \| None` | Series label in legend/tooltip (defaults to `key`) |
| `kind` | `'line' \| 'bar' \| 'area'` | ECharts series type |
| `color` | `Color` | Theme-aware color token resolved in the frontend (see table below) |
| `style` | `'solid' \| 'dashed' \| 'dotted'` | Line style (applies to `kind='line'` / `'area'`) |

### `Output.color` Values

| Value | Applies To | Description |
| --- | --- | --- |
| `None` | All | Auto-assigns next unused categorical palette slot |
| `0` … `7` | All | Categorical palette index (aligned across light/dark themes; **recommended**) |
| `'up'` / `'down'` | All | Chinese market candle colors (`'up'` = red, `'down'` = green) |
| `'muted'` / `'axis'` | All | Neutral grey tones for bands or baselines |
| `'#rrggbb'` | All | Literal hex color |
| `(pos_color, neg_color)` | `kind='bar'` only | Sign-colored histogram bars: `(>= 0, < 0)`, e.g., `('up', 'down')` |
| `'candle'` | `kind='bar'` only | Colors each bar by that day's price candle direction (`close >= open` → `'up'`, else `'down'`) |

## `compute(self, ctx, sym)` & `IndicatorContext`

- **Signature**: `compute(self, ctx: IndicatorContext, sym: str) -> dict[str, np.ndarray]`
- **Context accessors**: `ctx.open(sym=None)`, `ctx.high()`, `ctx.low()`, `ctx.close()`, `ctx.settle()`, `ctx.volume()`, `ctx.oi()`, `ctx.dates`, `len(ctx)`.
- **Read-only arrays**: Input arrays are shared read-only views (`float64`, guarded against embedded `NaN`). Never mutate in place (`c -= 1` raises `ValueError`); use out-of-place operations or `.copy()`.
- **Output shape & NaNs**: Every returned array must have length `len(ctx)`. Leading `NaN` values (warmup) and internal `NaN` gaps are rendered cleanly; all-`NaN` series trigger a `"needs more bars"` notice in the UI.

## HTTP API & Hot Reload

| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/indicators` | `GET` | Catalog of all discovered indicators, parameter spaces, and load/declaration `errors` |
| `/api/indicators/{key}` | `GET` | Single indicator metadata |
| `/api/products/{code}/indicators/{key}` | `GET` | Computed series (`dates`, per-output `values` and `valid_from`). Accepts `?p=name=value` (repeatable); returns `422` if out of `space` or violating `constraints` |
| `/api/indicators/reload` | `POST` | Re-imports all modules under `indicators/` (editing `indicators/base.py` requires a server restart) |
