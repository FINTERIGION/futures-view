import { useTranslation } from 'react-i18next'
import type { Metrics } from '../api/types'
import { formatMetricValue, metricTone } from './metricFormat'

const PRIMARY_KEYS = ['total_return', 'max_drawdown', 'sharpe_ratio', 'win_rate'] as const
const SECONDARY_KEYS = [
  'annualized_return',
  'sortino_ratio',
  'calmar_ratio',
  'profit_factor',
  'n_trades',
  'final_equity',
  'turnover',
  'expectancy',
] as const
const FLAG_KEYS = ['n_forced_liquidations', 'n_rejected_orders'] as const

const HEADLINE_KEYS: string[] = [...PRIMARY_KEYS, ...SECONDARY_KEYS, ...FLAG_KEYS]

export function MetricStats({
  metrics,
  keys,
  highlightPrimary = false,
}: {
  metrics: Metrics
  keys?: string[]
  highlightPrimary?: boolean
}) {
  const { t } = useTranslation()
  const infLabel = t('common.infinity')
  const naLabel = t('common.na')

  const fmt = (key: string) =>
    formatMetricValue(key, metrics[key], Boolean(metrics[`${key}_is_inf`]), infLabel, naLabel)

  if (highlightPrimary && !keys) {
    return (
      <div className="kpi-stack">
        <div className="kpi-hero">
          {PRIMARY_KEYS.map((key) => {
            const cls = metricTone(key, metrics[key])
            return (
              <div className="kpi-hero-item" key={key}>
                <div className="kpi-label">{t(`backtest.metrics.${key}`, key)}</div>
                <div className={`kpi-value ${cls}`}>{fmt(key)}</div>
              </div>
            )
          })}
        </div>

        <div className="kpi-secondary">
          {SECONDARY_KEYS.map((key) => {
            const cls = metricTone(key, metrics[key])
            return (
              <div className="kpi-sec-item" key={key}>
                <span className="kpi-label">{t(`backtest.metrics.${key}`, key)}</span>
                <span className={`kpi-value ${cls}`}>{fmt(key)}</span>
              </div>
            )
          })}
        </div>

        <div className="kpi-flags">
          {FLAG_KEYS.map((key) => {
            const raw = metrics[key]
            const alert = typeof raw === 'number' && raw > 0
            return (
              <span className={`kpi-flag${alert ? ' is-alert' : ''}`} key={key}>
                <span>{t(`backtest.metrics.${key}`, key)}</span>
                <strong>{fmt(key)}</strong>
              </span>
            )
          })}
        </div>
      </div>
    )
  }

  const list = keys ?? HEADLINE_KEYS
  return (
    <div className="stat-grid">
      {list.map((key) => {
        const cls = metricTone(key, metrics[key])
        return (
          <div className="stat-tile" key={key}>
            <div className="label">{t(`backtest.metrics.${key}`, key)}</div>
            <div className={`value ${cls}`}>{fmt(key)}</div>
          </div>
        )
      })}
    </div>
  )
}
