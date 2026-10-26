import { useTranslation } from 'react-i18next'
import type { StrategyInfo } from '../api/types'
import { editableParams, type ParamError, type ParamFieldErrors } from '../chart/indicatorParams'

const PARAM_ERROR_KEYS: Record<ParamError, string> = {
  required: 'workspace.paramRequired',
  number: 'workspace.paramNotNumber',
  integer: 'workspace.paramNotInteger',
  range: 'workspace.paramOutOfRange',
  choice: 'workspace.paramNotAChoice',
}

/**
 * The declared `space` fields of one strategy, the same inputs the Backtest
 * tab and the Alert compose form share. A strategy with nothing editable
 * renders nothing — there is no empty grid to explain.
 */
export function StrategyParamFields({
  strategy,
  paramDraft,
  onParamDraftChange,
  onResetParams,
  paramErrors,
  idPrefix = 'param',
}: {
  strategy: StrategyInfo
  paramDraft: Record<string, string>
  onParamDraftChange: (name: string, value: string) => void
  onResetParams: () => void
  paramErrors: ParamFieldErrors
  /** Distinguishes two forms on the same page; defaults keep the backtest
   * field ids (`param-fast`) that its tests already reach through the label. */
  idPrefix?: string
}) {
  const { t } = useTranslation()
  const paramNames = editableParams(strategy)
  if (paramNames.length === 0) return null

  const paramsAtDefaults = paramNames.every(
    (name) => (paramDraft[name] ?? '') === String(strategy.params[name]),
  )

  return (
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
        const id = `${idPrefix}-${name}`
        return (
          <div className="field" key={name}>
            <label htmlFor={id}>{name}</label>
            {choices ? (
              <select id={id} value={paramDraft[name] ?? ''} onChange={(e) => onParamDraftChange(name, e.target.value)}>
                {choices.map((c) => (
                  <option key={String(c)} value={String(c)}>
                    {String(c)}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={id}
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
  )
}
