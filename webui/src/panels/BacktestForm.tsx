import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { StrategyInfo } from '../api/types'
import type { ParamFieldErrors } from '../chart/indicatorParams'
import { Icon } from '../components/Icon'
import { StrategyParamFields } from './StrategyParamFields'

const RANGE_PRESETS = [1, 3, 5, 10]

function localIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function isoYearRange(years: number): { start: string; end: string } {
  const end = new Date()
  const start = new Date(end)
  start.setFullYear(start.getFullYear() - years)
  return { start: localIsoDate(start), end: localIsoDate(end) }
}

export function BacktestForm({
  strategies,
  strategyKey,
  onStrategyChange,
  onReloadStrategies,
  reloadingStrategies,
  canReloadStrategies,
  paramDraft,
  onParamDraftChange,
  onResetParams,
  paramErrors,
  universe,
  onToggleUniverse,
  onManageUniverse,
  start,
  onStartChange,
  end,
  onEndChange,
  cash,
  onCashChange,
  slippage,
  onSlippageChange,
  slippageValid,
  cashValid,
  windowValid,
}: {
  strategies: StrategyInfo[]
  strategyKey: string
  onStrategyChange: (key: string) => void
  onReloadStrategies: () => void
  reloadingStrategies: boolean
  canReloadStrategies: boolean
  paramDraft: Record<string, string>
  onParamDraftChange: (name: string, value: string) => void
  onResetParams: () => void
  paramErrors: ParamFieldErrors
  universe: string[]
  onToggleUniverse: (symbol: string) => void
  onManageUniverse: () => void
  start: string
  onStartChange: (v: string) => void
  end: string
  onEndChange: (v: string) => void
  cash: number
  onCashChange: (v: number) => void
  slippage: number
  onSlippageChange: (v: number) => void
  slippageValid: boolean
  cashValid: boolean
  windowValid: boolean
}) {
  const { t } = useTranslation()
  const idPrefix = useId()
  const broken = strategies.filter((s) => s.errors.length > 0)
  const strategy = strategies.find((s) => s.key === strategyKey)

  return (
    <div className="backtest-form">
      <section className="form-section">
        <div className="field">
          <label htmlFor={`${idPrefix}-strategy`}>{t('common.strategy')}</label>
          <div className="field-row">
            <select id={`${idPrefix}-strategy`} value={strategyKey} onChange={(e) => onStrategyChange(e.target.value)}>
              {strategies.map((s) => (
                <option key={s.key} value={s.key} disabled={s.errors.length > 0}>
                  {s.errors.length > 0 ? `${s.key} (${t('backtest.strategyBroken')})` : s.key}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-icon"
              disabled={!canReloadStrategies || reloadingStrategies}
              onClick={onReloadStrategies}
              title={t('backtest.reloadStrategiesHint')}
              aria-label={t('backtest.reloadStrategies')}
            >
              {reloadingStrategies ? <span className="spinner" /> : <Icon name="refresh" size={14} />}
            </button>
          </div>
          {broken.length > 0 && (
            <div className="field-error">
              {t('backtest.strategyBrokenHint')}
              {broken.map((s) => (
                <div key={s.key}>
                  <code>{s.module}</code>: {s.errors.join('; ')}
                </div>
              ))}
            </div>
          )}
        </div>

        {strategy && (
          <StrategyParamFields
            strategy={strategy}
            paramDraft={paramDraft}
            onParamDraftChange={onParamDraftChange}
            onResetParams={onResetParams}
            paramErrors={paramErrors}
          />
        )}
      </section>

      <section className="form-section">
        <div className="form-section-head">
          <h3 className="form-section-title">{`${t('common.symbols')} (${universe.length})`}</h3>
          <button type="button" className="btn btn-xs btn-ghost" onClick={onManageUniverse}>
            {t('workspace.manageProducts')}
          </button>
        </div>
        <div className="universe-chip-list">
          {universe.length === 0 ? (
            <span className="badge badge-neutral">{t('workspace.noProducts')}</span>
          ) : (
            universe.map((sym) => (
              <button
                key={sym}
                type="button"
                className="universe-chip"
                title={t('workspace.removeFromUniverse', { symbol: sym })}
                aria-label={t('workspace.removeFromUniverse', { symbol: sym })}
                onClick={() => onToggleUniverse(sym)}
              >
                {sym}
                <Icon name="close" size={10} />
              </button>
            ))
          )}
        </div>
      </section>

      <section className="form-section">
        <div className="form-section-head">
          <h3 className="form-section-title">{t('backtest.range')}</h3>
          <div className="range-pills">
            {RANGE_PRESETS.map((years) => {
              const range = isoYearRange(years)
              const active = start === range.start && end === range.end
              return (
                <button
                  key={years}
                  type="button"
                  className={`range-pill ${active ? 'active' : ''}`}
                  title={t('backtest.lastYears', { n: years })}
                  onClick={() => {
                    onStartChange(range.start)
                    onEndChange(range.end)
                  }}
                >
                  {years}Y
                </button>
              )
            })}
          </div>
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor={`${idPrefix}-start`}>{t('common.start')}</label>
            <input
              id={`${idPrefix}-start`}
              type="date"
              value={start}
              className={windowValid ? undefined : 'invalid'}
              onChange={(e) => onStartChange(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={`${idPrefix}-end`}>{t('common.end')}</label>
            <input
              id={`${idPrefix}-end`}
              type="date"
              value={end}
              className={windowValid ? undefined : 'invalid'}
              onChange={(e) => onEndChange(e.target.value)}
            />
          </div>
        </div>
      </section>

      <section className="form-section">
        <div className="form-grid">
          <div className="field">
            <label htmlFor={`${idPrefix}-cash`}>{t('common.cash')}</label>
            <input
              id={`${idPrefix}-cash`}
              type="number"
              className={cashValid ? undefined : 'invalid'}
              value={typeof cash === 'number' && Number.isFinite(cash) ? cash : ''}
              onChange={(e) => onCashChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
            />
          </div>
          <div className="field">
            <label htmlFor={`${idPrefix}-slippage`}>{t('common.slippage')}</label>
            <input
              id={`${idPrefix}-slippage`}
              type="number"
              step="any"
              min="0"
              className={slippageValid ? undefined : 'invalid'}
              value={typeof slippage === 'number' && Number.isFinite(slippage) ? slippage : ''}
              onChange={(e) => onSlippageChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
            />
          </div>
        </div>
      </section>
    </div>
  )
}
