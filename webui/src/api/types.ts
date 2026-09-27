// Shapes mirror what the FastAPI backend actually returns (see web/routers/*.py
// and web/serialize.py on the Python side). Kept loose (optional fields,
// index signatures for metrics) rather than a strict 1:1 mirror, because the
// engine's own metrics dict (core/metrics.py) is the source of truth and this
// layer should not have to change every time a field is added there.

export interface ProductCosts {
  multiplier: number
  margin_rate: number
  commission_mode: 'rate' | 'per_lot'
  commission_rate: number | null
  commission_per_lot: number | null
}

export interface RollRule {
  main_months: number[]
  lead_months: number
}

export interface Coverage {
  symbol: string
  has_data: boolean
  n_rows: number
  first_date: string | null
  last_date: string | null
  last_refresh: string | null
  stale_keys: string[]
}

export interface Product {
  code: string
  exchange: string
  name: string
  name_zh: string
  start_year: number
  multiplier: number
  tick_size: number
  margin_rate?: number
  commission_rate?: number | null
  commission_per_lot?: number | null
  main_months?: number[]
  roll_lead_months?: number
  costs: ProductCosts
  roll: RollRule
  coverage: Coverage
}

export interface ProductInput {
  exchange: string
  name: string
  name_zh: string
  start_year: number
  multiplier: number
  tick_size: number
  margin_rate?: number | null
  commission_rate?: number | null
  commission_per_lot?: number | null
  main_months?: number[] | null
  roll_lead_months?: number | null
}

export interface ExchangeMeta {
  exchanges: string[]
  default_main_months: number[]
  default_roll_lead_months: number
}

export interface Bar {
  date: string
  open: number
  high: number
  low: number
  close: number
  settle: number
  oi: number
  volume: number
}

export interface RollPoint {
  date: string
  contract: string
  close: number
}

// -------------------------------------------------------------------------

export interface SpaceSpec {
  kind: 'int' | 'float' | 'categorical'
  low?: number
  high?: number
  step?: number | null
  log?: boolean
  choices?: unknown[]
}

export interface StrategyInfo {
  key: string
  class_name: string
  module: string
  file: string
  docstring: string
  params: Record<string, unknown>
  /** The tunable params and their ranges: exactly what the backtest form
   * edits. A param left out runs at its default. */
  space: Record<string, SpaceSpec>
  space_error: string | null
  /** Why this entry cannot run: its module failed to import, its class
   * clashed with another's short name, or a declaration could not be read.
   * Non-empty means the form offers it disabled, with these messages. */
  errors: string[]
}

// -------------------------------------------------------------------------

/** How one of an indicator's series should be drawn.
 *
 * `color` is the author's *declaration*, not a resolved colour: a number is a
 * slot in the categorical palette, a bare word is a semantic token, a `#hex`
 * is a literal, and a pair is the `>= 0` / `< 0` colours of a sign-coloured
 * bar. `resolveColor` (charts/indicatorColor.ts) turns it into a hex against
 * the live theme -- the panel flips light/dark with no refetch, so a colour
 * resolved server-side would be stale the moment the user toggled it. */
export interface IndicatorOutput {
  key: string
  label: string
  kind: 'line' | 'bar' | 'area'
  color: number | string | [number | string, number | string] | null
  style: 'solid' | 'dashed' | 'dotted'
}

export interface IndicatorInfo {
  key: string
  label: string
  class_name: string
  module: string
  file: string
  docstring: string
  /** `'main'` draws over the candles; `'sub'` gets its own stacked pane. */
  pane: 'main' | 'sub'
  precision: number
  /** Sub-pane y-axis bounds; `null` autoscales. Either end may be `null`. */
  value_range: { min: number | null; max: number | null } | null
  guides: number[]
  outputs: IndicatorOutput[]
  params: Record<string, unknown>
  space: Record<string, SpaceSpec>
  space_error: string | null
  /** Problems with the class's declaration, or the import error for a module
   * that would not load. A non-empty list means the picker shows it disabled
   * rather than dropping it silently. */
  errors: string[]
}

export interface IndicatorSeries {
  values: (number | null)[]
  /** Index of the first non-null value -- the end of the warmup. `null` when
   * the whole series is null, i.e. the window is longer than the loaded
   * range, which the UI reports rather than drawing an empty pane. */
  valid_from: number | null
}

export interface IndicatorValues {
  symbol: string
  indicator: string
  params: Record<string, unknown>
  /** Values carry their own dates so the chart aligns by date, not position. */
  dates: string[]
  outputs: Record<string, IndicatorSeries>
}

// -------------------------------------------------------------------------

export type Metrics = Record<string, unknown>

export interface EquityRecord {
  date: string
  equity: number
  daily_return: number
  margin_used: number
  available: number
  position: Record<string, number>
}

export interface TradeLog {
  trade_id: number
  open_date: string
  close_date: string | null
  direction: string
  symbol: string
  contract: string
  contracts: string[]
  n_rolls: number
  open_price: number
  close_price: number | null
  size: number
  gross_pnl: number
  commission: number
  net_pnl: number
  margin_used: number
  open_at_end: boolean
  forced: boolean
  exit_reason: string
  open_bar: number
  close_bar: number | null
}

export interface RunSummary {
  id: string
  kind: string
  created_at: number
  strategy: string | null
  symbols: string[]
  start: string | null
  end: string | null
  cash: number | null
  slippage: number | null
  status: string
  params: Record<string, unknown>
  metrics: Metrics | null
  error: string | null
}

export interface RunDetail extends RunSummary {
  equity_records: EquityRecord[]
  trade_logs: TradeLog[]
  deferred: Record<string, number>
  symbols_with_price: string[]
}

export interface RunPrice {
  symbol: string
  dates: string[]
  open: number[]
  high: number[]
  low: number[]
  close: number[]
  volume: number[]
  oi: number[]
  signals: Array<{ date: string; price: number; direction: string; size: number; comm: number; symbol: string }>
}

// -------------------------------------------------------------------------

export interface JobState {
  id: string
  kind: string
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  progress: number
  message: string
  error: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
  cancel_requested: boolean
  result?: unknown
}

