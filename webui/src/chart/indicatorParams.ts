import type { SpaceSpec } from '../api/types'

/** One indicator's user-set params, `{name: value}`. Only values that differ
 * from the class's declared defaults are kept -- see `setIndicatorParams` in
 * shell/WorkspaceContext.tsx. */
export type ParamOverrides = Record<string, unknown>

/** A catalog entry the param editors can read: an indicator or a strategy. */
export type ParamCatalog = {
  params: Record<string, unknown>
  /** Exactly the tunable params. One left out runs at its class default. */
  space: Record<string, SpaceSpec>
}

/** Params the panel lets a user set: the ones in `space`, in `params` order,
 * whose default an input can hold. A `None` or list default has no editor
 * that would mean anything, so it is left to the class. The indicator picker
 * and the backtest form both use this list. */
export function editableParams(info: ParamCatalog): string[] {
  return Object.keys(info.params).filter((name) => {
    const spec = info.space[name]
    if (!spec) return false
    const value = info.params[name]
    return (
      spec.kind === 'categorical' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'string'
    )
  })
}

/** The stored overrides that still apply to `info` as the catalog now
 * declares it.
 *
 * The class can change under a hot reload. An override for a param it has
 * since renamed or dropped would be refused by the server with a 422 and
 * blank the indicator, for a value the user can no longer even see in the
 * editor. So it is dropped here instead. A value the class still declares
 * but now bounds more tightly is kept, and its 422 reaches the chart's
 * banner, because the user can fix that one. */
export function activeOverrides(info: ParamCatalog, stored: unknown): ParamOverrides {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
  const editable = new Set(editableParams(info))
  return Object.fromEntries(Object.entries(stored as ParamOverrides).filter(([name]) => editable.has(name)))
}

/** `"9, 3, 3"`: every editable param's effective value, in declared order. */
export function paramSummary(info: ParamCatalog, overrides: ParamOverrides): string {
  return editableParams(info)
    .map((name) => String(name in overrides ? overrides[name] : info.params[name]))
    .join(', ')
}

export type ParamError = 'required' | 'number' | 'integer' | 'range' | 'choice'

export type ParsedParam = { ok: true; value: unknown } | { ok: false; error: ParamError }

/** One field of the editor, from its input text back to a typed value.
 *
 * Checks what the catalog says about the param: its kind and declared
 * range. What it cannot check are the class's `constraints` (`fast < slow`).
 * Those are Python lambdas, so the editor has the server evaluate them
 * before a value is kept. */
export function parseParam(raw: string, defaultValue: unknown, spec: SpaceSpec | undefined): ParsedParam {
  if (spec?.kind === 'categorical') {
    const choice = (spec.choices ?? []).find((c) => String(c) === raw)
    return choice === undefined ? { ok: false, error: 'choice' } : { ok: true, value: choice }
  }
  if (typeof defaultValue === 'boolean') {
    if (raw !== 'true' && raw !== 'false') return { ok: false, error: 'choice' }
    return { ok: true, value: raw === 'true' }
  }
  if (typeof defaultValue !== 'number' && spec?.kind !== 'int' && spec?.kind !== 'float') {
    return { ok: true, value: raw }
  }

  const text = raw.trim()
  if (text === '') return { ok: false, error: 'required' }
  const value = Number(text)
  if (!Number.isFinite(value)) return { ok: false, error: 'number' }
  if (spec?.kind === 'int' && !Number.isInteger(value)) return { ok: false, error: 'integer' }
  if ((spec?.low !== undefined && value < spec.low) || (spec?.high !== undefined && value > spec.high)) {
    return { ok: false, error: 'range' }
  }
  return { ok: true, value }
}

/** Text for each editable field. A stored key the class no longer lists in
 * `space` is ignored; a missing key shows the class default. */
export function seedParamDraft(info: ParamCatalog, stored: unknown): Record<string, string> {
  const bag =
    stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {}
  return Object.fromEntries(
    editableParams(info).map((name) => [
      name,
      String(name in bag && bag[name] !== undefined ? bag[name] : info.params[name]),
    ]),
  )
}

export type ParamFieldErrors = Partial<Record<string, ParamError>>

/** The values a run should send: every editable param, defaults included,
 * so history can reopen onto exactly this set. A param outside `space` is
 * left out; the class default applies. `null` when a field does not parse —
 * the caller keeps the previous saved set and blocks the run. */
export function effectiveParams(
  info: ParamCatalog,
  draft: Record<string, string>,
): { ok: true; params: ParamOverrides; errors: ParamFieldErrors } | { ok: false; params: null; errors: ParamFieldErrors } {
  const params: ParamOverrides = {}
  const errors: ParamFieldErrors = {}
  for (const name of editableParams(info)) {
    const parsed = parseParam(draft[name] ?? '', info.params[name], info.space[name])
    if (!parsed.ok) errors[name] = parsed.error
    else params[name] = parsed.value
  }
  return Object.keys(errors).length > 0 ? { ok: false, params: null, errors } : { ok: true, params, errors }
}
