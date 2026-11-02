import { useTranslation } from 'react-i18next'
import type { StrategyInfo } from '../api/types'
import type { ParamFieldErrors } from '../chart/indicatorParams'
import { Icon } from '../components/Icon'
import { StrategyParamFields } from './StrategyParamFields'

/** Windows worth one click. A backtest is nearly always run over "the last
 * few years", and typing two ISO dates to say so was the most repeated
 * keystroke in this form. */
const RANGE_PRESETS = [1, 3, 5, 10]

/** `YYYY-MM-DD` of `d` on the user's own calendar. Not `toISOString()`, which
 * is the UTC date: east of Greenwich that is still yesterday for the first
 * hours of every day -- until 08:00 in Beijing. */
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

/** The Backtest tab's run form: which strategy, that strategy's declared
 * parameters, the universe, and the run's own settings (window, cash,
 * slippage). */
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
  // Listed, not hidden: a strategy that vanished from the dropdown the moment
  // its file stopped compiling left whoever saved it nowhere to read why.
  const broken = strategies.filter((s) => s.errors.length > 0)
  const strategy = strategies.find((s) => s.key === strategyKey)
  return (
    <div className="backtest-form">
      <section className="form-section">
        <h3 className="form-section-title">{t('backtest.strategyAndParams')}</h3>
        <div className="field">
          <label>{t('common.strategy')}</label>
          <div className="field-row">
            <select value={strategyKey} onChange={(e) => onStrategyChange(e.target.value)}>
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
        <div className="field-label-row">
          <h3 className="form-section-title">{`${t('common.symbols')} (${universe.length})`}</h3>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onManageUniverse}>
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
                <Icon name="close" size={11} />
              </button>
            ))
          )}
        </div>
        <p className="field-hint">{t('workspace.universeFromSidebar')}</p>
      </section>

      <section className="form-section">
        <h3 className="form-section-title">{t('backtest.range')}</h3>
        <div className="field">
          <div className="toolbar">
            {RANGE_PRESETS.map((years) => {
              const range = isoYearRange(years)
              const active = start === range.start && end === range.end
              return (
                <button
                  key={years}
                  type="button"
                  className={`btn btn-sm ${active ? 'btn-primary' : ''}`}
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
            <label>{t('common.start')}</label>
            <input
              type="date"
              value={start}
              className={windowValid ? undefined : 'invalid'}
              onChange={(e) => onStartChange(e.target.value)}
            />
          </div>
          <div className="field">
            <label>{t('common.end')}</label>
            <input
              type="date"
              value={end}
              className={windowValid ? undefined : 'invalid'}
              onChange={(e) => onEndChange(e.target.value)}
            />
          </div>
        </div>
      </section>

      <section className="form-section">
        <h3 className="form-section-title">{t('backtest.cashAndCosts')}</h3>
        <div className="form-grid">
          <div className="field">
            <label>{t('common.cash')}</label>
            <input
              type="number"
              className={cashValid ? undefined : 'invalid'}
              value={cash}
              onChange={(e) => onCashChange(Number(e.target.value))}
            />
          </div>
          <div className="field">
            <label>{t('common.slippage')}</label>
            <input
              type="number"
              step="any"
              min="0"
              className={slippageValid ? undefined : 'invalid'}
              value={slippage}
              onChange={(e) => onSlippageChange(Number(e.target.value))}
            />
          </div>
        </div>
      </section>
    </div>
  )
}
