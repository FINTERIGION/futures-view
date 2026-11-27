import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../api/client'
import { indicatorsApi } from '../api/endpoints'
import type { BarSeries, IndicatorInfo } from '../api/types'
import { editableParams, parseParam, type ParamError, type ParamOverrides } from './indicatorParams'

const ERROR_KEYS: Record<ParamError, string> = {
  required: 'workspace.paramRequired',
  number: 'workspace.paramNotNumber',
  integer: 'workspace.paramNotInteger',
  range: 'workspace.paramOutOfRange',
  choice: 'workspace.paramNotAChoice',
}

export function IndicatorParamsEditor({
  info,
  overrides,
  chartSymbol,
  chartSeries = 'weighted',
  onApply,
  onCancel,
}: {
  info: IndicatorInfo
  overrides: ParamOverrides
  chartSymbol: string
  chartSeries?: BarSeries
  onApply: (overrides: ParamOverrides) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const idPrefix = useId()
  const rootRef = useRef<HTMLFormElement>(null)
  const names = editableParams(info)

  const valuesOf = (source: ParamOverrides) =>
    Object.fromEntries(names.map((name) => [name, String(name in source ? source[name] : info.params[name])]))

  const [draft, setDraft] = useState<Record<string, string>>(() => valuesOf(overrides))
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<string, ParamError>>>({})

  const check = useMutation({
    mutationFn: (next: ParamOverrides) =>
      chartSeries === 'weighted'
        ? indicatorsApi.values(chartSymbol, info.key, next)
        : indicatorsApi.values(chartSymbol, info.key, next, undefined, undefined, chartSeries),
  })

  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>('input, select')?.focus()
  }, [])

  const edit = (name: string, value: string) => {
    setDraft((d) => ({ ...d, [name]: value }))
    setFieldErrors((e) => ({ ...e, [name]: undefined }))
    check.reset()
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const next: ParamOverrides = {}
    const errors: Partial<Record<string, ParamError>> = {}
    for (const name of names) {
      const parsed = parseParam(draft[name] ?? '', info.params[name], info.space[name])
      if (!parsed.ok) errors[name] = parsed.error
      else if (parsed.value !== info.params[name]) next[name] = parsed.value
    }
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) return

    if (!chartSymbol) {
      onApply(next)
      return
    }
    check.mutate(next, {
      onSuccess: (values) => {
        queryClient.setQueryData(['indicator', chartSymbol, chartSeries, info.key, next], values)
        onApply(next)
      },
    })
  }

  return (
    <form className="indicator-params" ref={rootRef} onSubmit={submit} noValidate>
      <div className="indicator-params-grid">
        {names.map((name) => {
          const spec = info.space[name]
          const fallback = info.params[name]
          const id = `${idPrefix}-${name}`
          const error = fieldErrors[name]
          const ranged = spec && spec.kind !== 'categorical' && spec.low !== undefined && spec.high !== undefined
          const hint = ranged
            ? t('workspace.paramHint', { low: spec.low, high: spec.high, value: String(fallback) })
            : t('workspace.paramHintNoRange', { value: String(fallback) })
          const choices =
            spec?.kind === 'categorical' ? (spec.choices ?? []) : typeof fallback === 'boolean' ? [true, false] : null

          return (
            <div className="field" key={name}>
              <label htmlFor={id}>{name}</label>
              {choices ? (
                <select id={id} value={draft[name] ?? ''} onChange={(e) => edit(name, e.target.value)}>
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
                  value={draft[name] ?? ''}
                  className={error ? 'invalid' : undefined}
                  aria-invalid={Boolean(error)}
                  onChange={(e) => edit(name, e.target.value)}
                />
              )}
              {error ? (
                <span className="field-error">
                  {t(ERROR_KEYS[error], { low: spec?.low, high: spec?.high })}
                </span>
              ) : (
                <span className="field-hint">{hint}</span>
              )}
            </div>
          )
        })}
      </div>

      {check.error && <div className="field-error indicator-params-error">{errorMessage(check.error)}</div>}

      <div className="indicator-params-actions">
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => {
            setDraft(valuesOf({}))
            setFieldErrors({})
            check.reset()
          }}
        >
          {t('workspace.resetParams')}
        </button>
        <div className="spacer" />
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={check.isPending}>
          {check.isPending ? t('common.loading') : t('workspace.applyParams')}
        </button>
      </div>
    </form>
  )
}
