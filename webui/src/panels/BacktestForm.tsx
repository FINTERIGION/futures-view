import { useTranslation } from 'react-i18next'
import type { StrategyInfo } from '../api/types'
import { editableParams, type ParamError, type ParamFieldErrors } from '../chart/indicatorParams'

/** Windows worth one click. A backtest is nearly always run over "the last
 * few years", and typing two ISO dates to say so was the most repeated
 * keystroke in this form. */
const RANGE_PRESETS = [1, 3, 5, 10]

const PARAM_ERROR_KEYS: Record<ParamError, string> = {
  required: 'workspace.paramRequired',
  number: 'workspace.paramNotNumber',
  integer: 'workspace.paramNotInteger',
  range: 'workspace.paramOutOfRange',
  choice: 'workspace.paramNotAChoice',
}

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
  const paramNames = strategy ? editableParams(strategy) : []
  // The class defaults, as the inputs would show them. A field the user has
  // not touched matches; an out-of-range or half-typed value does not, so
  // the button stays available as the way back.
  const paramsAtDefaults =
    strategy !== undefined &&
    paramNames.every((name) => (paramDraft[name] ?? '') === String(strategy.params[name]))

  return (
    <>
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
            className="btn"
            disabled={!canReloadStrategies || reloadingStrategies}
            onClick={onReloadStrategies}
            title={t('backtest.reloadStrategiesHint')}
          >
            {reloadingStrategies ? t('common.loading') : t('backtest.reloadStrategies')}
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

      {strategy && paramNames.length > 0 && (
        <div className="form-grid">
          {paramNames.map((name) => {
            const spec = strategy.space[name]
            const fallback = strategy.params[name]
            const error = paramErrors[name]
            const ranged = spec && spec.kind !== 'categorical' && spec.low !== undefined && spec.high !== undefined
            const hint = ranged
              ? t('workspace.paramHint', { low: spec.low, high: spec.high, value: String(fallback) })
              : t('workspace.paramHintNoRange', { value: String(fallback) })
            const choices =
              spec?.kind === 'categorical' ? (spec.choices ?? []) : typeof fallback === 'boolean' ? [true, false] : null
            return (
              <div className="field" key={name}>
                <label htmlFor={`param-${name}`}>{name}</label>
                {choices ? (
                  <select
                    id={`param-${name}`}
                    value={paramDraft[name] ?? ''}
                    onChange={(e) => onParamDraftChange(name, e.target.value)}
                  >
                    {choices.map((c) => (
                      <option key={String(c)} value={String(c)}>
                        {String(c)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`param-${name}`}
                    type={typeof fallback === 'number' ? 'number' : 'text'}
                    step={spec?.kind === 'int' ? 1 : 'any'}
                    min={ranged ? spec.low : undefined}
                    max={ranged ? spec.high : undefined}
                    value={paramDraft[name] ?? ''}
                    className={error ? 'invalid' : undefined}
                    aria-invalid={Boolean(error)}
                    onChange={(e) => onParamDraftChange(name, e.target.value)}
                  />
                )}
                {error ? (
                  <span className="field-error">{t(PARAM_ERROR_KEYS[error], { low: spec?.low, high: spec?.high })}</span>
                ) : (
                  <span className="field-hint">{hint}</span>
                )}
              </div>
            )
          })}
          <div className="field field-wide">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={paramsAtDefaults}
              onClick={onResetParams}
              title={t('workspace.resetIndicatorParams')}
            >
              {t('workspace.resetParams')}
            </button>
          </div>
        </div>
      )}

      <div className="field">
        <label>
          {t('common.symbols')} ({universe.length})
        </label>
        <div className="toolbar">
          {universe.length === 0 ? (
            <span className="badge badge-neutral">{t('workspace.noProducts')}</span>
          ) : (
            universe.map((sym, i) => (
              // The first chip is the charted product, which is in this
              // universe structurally -- the accent says which one the main
              // chart is showing, not which one matters more to the run.
              <span key={sym} className={`badge ${i === 0 ? 'badge-accent' : 'badge-neutral'}`}>
                {sym}
              </span>
            ))
          )}
        </div>
        <p className="field-hint">{t('workspace.universeFromSidebar')}</p>
      </div>

      <div className="field">
        <label>{t('backtest.range')}</label>
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
    </>
  )
}
