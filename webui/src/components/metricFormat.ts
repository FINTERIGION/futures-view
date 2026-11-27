const PERCENT_KEYS = new Set([
  'total_return',
  'annualized_return',
  'max_drawdown',
  'win_rate',
  'annualized_volatility',
  'capital_exposure',
  'share',
])
const NEGATIVE_IS_BAD = new Set(['max_drawdown'])
const POSITIVE_IS_BAD = new Set(['n_forced_liquidations', 'n_rejected_orders'])
const NEUTRAL_KEYS = new Set(['final_equity', 'n_trades', 'turnover', 'share'])

export function formatMetricValue(
  key: string,
  value: unknown,
  isInf: boolean,
  infLabel: string,
  naLabel: string,
): string {
  if (isInf) return infLabel
  if (value === null || value === undefined) return naLabel
  if (typeof value !== 'number') return String(value)
  if (PERCENT_KEYS.has(key)) return `${value.toFixed(2)}%`
  if (key === 'final_equity' || key === 'expectancy' || key === 'net_pnl') {
    return value.toLocaleString(undefined, { maximumFractionDigits: 0 })
  }
  return value.toFixed(4).replace(/\.?0+$/, '') || '0'
}

export function metricTone(key: string, raw: unknown): '' | 'positive' | 'negative' {
  const numeric = typeof raw === 'number' ? raw : null
  if (numeric === null || numeric === 0 || NEUTRAL_KEYS.has(key)) return ''
  const goodDirection = NEGATIVE_IS_BAD.has(key) || POSITIVE_IS_BAD.has(key) ? -1 : 1
  return numeric * goodDirection > 0 ? 'positive' : 'negative'
}
