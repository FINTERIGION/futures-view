# Writing an Indicator

Subclass `Indicator` from `indicators.base`, declare how it should be drawn, and compute the series in `compute`. Drop the file anywhere under `indicators/`, then modules are discovered automatically, and the short name is the class name snake-cased without a trailing `_indicator` (`Macd` → `macd`). The web panel's **Indicators** button lists whatever it finds; tick one and it goes on the chart.

An indicator is a *chart* object. It computes over a product's OI-weighted continuous bars — the same series a strategy sees — but it never places an order, and nothing about it touches the engine. Selecting one needs no backtest.

```python
import talib

from .base import Indicator, Int, Output


class Rsi(Indicator):
    """Relative Strength Index."""

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

Start from `indicators/my_indicator.py` if you want a template.

**Name the class for the indicator, not the base:** `Rsi`, `Macd`, `Bollinger` — not `RsiIndicator`. The suffix is only dropped when what is left still has an underscore (the rule that keeps `MyStrategy` from collapsing to `my`), so `RsiIndicator` would key as `rsi_indicator`.

**Short names must be unique.** Two classes that reduce to the same name — typically a copied template whose class was never renamed — are both left out, and the picker shows each module as an error until one is renamed. Neither silently wins.

## Class attributes

| Attribute | Meaning |
| --- | --- |
| `label` | Name shown in the picker; defaults to the short key upper-cased |
| `pane` | `'main'` draws over the candles, `'sub'` gets its own stacked pane |
| `precision` | Decimals in the tooltip, and on a sub-pane's axis labels |
| `value_range` | `(min, max)` y-bounds. **Sub-pane only** — on the price pane those bounds would rescale the axis the candles own, so they are ignored and the picker says so. Either end may be `None` |
| `guides` | Horizontal reference lines on a sub-pane, e.g. `(30, 70)` for RSI or `(0,)` for MACD |
| `outputs` | Tuple of `Output`, one per drawn series — see below |
| `params` | Dict of defaults; instance values live on `self.p`, overridden via `MyIndicator(**kw)` |
| `space` | The tunable params and the range each is plausible over, `{name: Int / Float / Categorical}` |
| `constraints` | Tuple of `callable(params) -> bool`, e.g. `lambda p: p['fast'] < p['slow']` |

Declare `space`. Besides documenting the parameter, it is what bounds a period arriving from the URL, so an absurd window never reaches TA-Lib. It is also the range the panel's params editor shows under each field and checks before sending anything (see [Web Panel](web.md#editing-indicator-params)). A param with no declared range cannot be overridden from the picker or a URL at all.

The editor offers every param in `space` that has a number, bool, or string default, or a `Categorical` space. It shows params by their Python names, the same names `p=name=value` takes.

## Outputs

One `Output` per series the indicator draws. `compute` returns a dict keyed by `Output.key`.

| Field | Meaning |
| --- | --- |
| `key` | Matches a key in `compute`'s returned dict |
| `label` | Tooltip text; defaults to `key` |
| `kind` | `'line'` (default), `'bar'`, or `'area'` |
| `color` | See below; `None` picks an unused palette slot |
| `style` | `'solid'` (default), `'dashed'`, or `'dotted'` |

### Colour

Colour is **declared** here and **resolved in the browser**, because the panel flips light/dark without refetching anything — a hex chosen in Python would be the light-theme colour still sitting on a dark chart.

| Declaration | Meaning |
| --- | --- |
| `0` … `7` | A slot in the categorical palette. The light and dark palettes are index-aligned by hue, so one number is right in both themes. **Prefer this** |
| `'up'` / `'down'` | The candle colours — red = rose, green = fell, per the Chinese-market convention this toolkit follows |
| `'muted'` / `'axis'` | Recessive greys, for a band or a reference series |
| `'#rrggbb'` | A literal. You are responsible for checking it in both themes |
| `('up', 'down')` | The `>= 0` / `< 0` pair of a sign-coloured bar. Only meaningful with `kind='bar'` — it is what makes a MACD histogram readable |
| `'candle'` | Each bar uses that day's candle colour: red when close ≥ open, green otherwise — the same rule as the volume pane. Only with `kind='bar'`. The height stays the series value |

## Computing

`compute(self, ctx, sym)` returns `{output key: array}`. Every array must be the same length as the loaded bars.

`ctx` offers the same per-symbol accessors a strategy's `setup` gets — `open`, `high`, `low`, `close`, `settle`, `volume`, `oi` — each a `float64` numpy array guarded against the embedded-NaN input that makes TA-Lib silently return all-NaN. The symbol argument is optional (`ctx.close()` and `ctx.close(sym)` are the same series), so a strategy's `setup` body pastes across unchanged:

```python
# in a strategy
ctx.add_indicator('sma', sym, talib.SMA(ctx.close(sym), 20))
# in an indicator
return {'sma': talib.SMA(ctx.close(sym), 20)}
```

**Treat the input arrays as read-only.** They are views of the same cached bars the candles and every other selected indicator read from, so an in-place edit such as `c -= c.mean()`, `c[c < 0] = 0` or `c.sort()` fails with `ValueError: assignment destination is read-only`, and the chart reports that indicator as failed. Use the non-in-place form (`c - c.mean()`, `np.where(c < 0, 0, c)`), or call `.copy()` first if you really need to modify one. Don't rely on an accessor that happens to accept a write: `volume` and `oi` are stored as integers and converted to `float64` on the way out, so today they arrive as writable copies, but that follows from the file's dtypes and is not guaranteed.

**Leading NaN is expected** — it is the warmup, and the chart simply starts the line where the indicator became valid. A gap *inside* the series is allowed too and is drawn as a gap, not bridged. If every value is NaN because the window is longer than the loaded history, the panel says "needs more bars" rather than showing an empty pane.

## Conventions

- One class per indicator, several outputs — not several classes. MACD is one class emitting `macd`/`signal`/`hist`, so the three share a pane and a tooltip. `Ma` ships three periods for the same reason.
- Put an oscillator on `'sub'` and anything in price units on `'main'`. A MACD spread drawn over the candles collapses to a flat line.
- Each selected sub-pane indicator gets its own pane, never a shared axis, and at most four fit under the price chart.
- Private indicators go in the same folder and are gitignored, exactly like private strategies.

## Editing while the panel is open

**Reload** in the indicator picker re-reads `indicators/` and refetches, so an edited class shows up without restarting the server. A module that fails to import stays listed, disabled, with the error on hover — an indicator that silently vanished mid-edit is the harder thing to debug.

Editing `indicators/base.py` itself needs a restart: reloading it would swap in a new `Indicator` class that every already-defined subclass no longer descends from, silently emptying the registry.

## HTTP

The panel uses three routes; they are also the quickest way to check a new class from a terminal.

| Route | Returns |
| --- | --- |
| `GET /api/indicators` | The catalog: every class's declaration, plus `errors` for one that will not load |
| `GET /api/products/{code}/indicators/{key}` | Values: `dates`, and per output `values` (NaN as `null`) with `valid_from` |
| `POST /api/indicators/reload` | Re-import every module under `indicators/` |

Values accept parameter overrides as repeated `p=name=value` — the same token as the CLI's `--param`:

```bash
curl 'localhost:8000/api/products/SA/indicators/macd?p=fast=5&p=slow=40'
```

An override is refused with 422 if the class never declared that param, if the value falls outside its declared `space` (or that `space` entry is not an `Int` / `Float` / `Categorical`), or if it breaks — or raises inside — a `constraints` predicate. A number sent for a param whose default is `None` or a string is bounded the same way. Only names the registry discovered are accepted — a `'module:Class'` path is not, for the reason [Writing a Strategy](strategy.md) gives: the panel has no authentication and is bindable beyond localhost.
