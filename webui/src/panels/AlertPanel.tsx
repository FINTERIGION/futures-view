import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../api/client'
import { alertsApi, strategiesApi } from '../api/endpoints'
import type { AlertLevel, AlertSnapshot, AlertSymbolRow, StrategyInfo } from '../api/types'
import { Card } from '../components/Card'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Icon } from '../components/Icon'
import { JobProgress } from '../components/JobProgress'
import { Table } from '../components/Table'
import type { Column } from '../components/Table'
import { effectiveParams, paramSummary, seedParamDraft, type ParamFieldErrors } from '../chart/indicatorParams'
import { useStickyState } from '../hooks/useStickyState'
import { useJobSlot } from '../shell/JobsProvider'
import { useWorkspace } from '../shell/WorkspaceContext'
import { StrategyParamFields } from './StrategyParamFields'

export interface AlertEntry {
  id: string
  strategy: string
  /** Universe snapshotted at save. An older entry that never stored one
   * previews against the live sidebar so it still opens. */
  symbols: string[]
  params: Record<string, unknown>
  createdAt: number
}

/** Survives the panel unmounting (tab switch, collapsed drawer) so a finished
 * preview is still there when the user comes back, and an in-flight one is
 * not started a second time. Keyed by entry + the universe that preview
 * actually ran: a saved pool must not be shown for a different one. */
const previewCache = new Map<string, AlertSnapshot>()
let inflight: { cacheKey: string; entryId: string; jobId: string } | null = null

function previewKey(entryId: string, symbols: string[]): string {
  return `${entryId}::${symbols.join(',')}`
}

export function resetAlertPreviewState() {
  previewCache.clear()
  inflight = null
}

function cachedPreview(entryId: string, symbols: string[]): AlertSnapshot | undefined {
  return previewCache.get(previewKey(entryId, symbols))
}

function rememberPreview(cacheKey: string, snap: AlertSnapshot) {
  previewCache.set(cacheKey, snap)
  inflight = null
}

function dropPreview(entryId: string) {
  for (const key of [...previewCache.keys()]) {
    if (key === entryId || key.startsWith(`${entryId}::`)) previewCache.delete(key)
  }
  if (inflight?.entryId === entryId) inflight = null
}

function markInflight(cacheKey: string, entryId: string, jobId: string) {
  inflight = { cacheKey, entryId, jobId }
}

function inflightFor(cacheKey: string): { cacheKey: string; entryId: string; jobId: string } | null {
  return inflight?.cacheKey === cacheKey ? inflight : null
}

function inflightJob(jobId: string): { cacheKey: string; entryId: string; jobId: string } | null {
  return inflight?.jobId === jobId ? inflight : null
}

function clearInflight() {
  inflight = null
}

function asSymbolList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((s): s is string => typeof s === 'string' && s.length > 0)
}

function asEntries(value: unknown): AlertEntry[] {
  if (!Array.isArray(value)) return []
  const out: AlertEntry[] = []
  for (const row of value) {
    if (!row || typeof row !== 'object') continue
    const r = row as Partial<AlertEntry>
    if (typeof r.id !== 'string' || typeof r.strategy !== 'string') continue
    const params = r.params && typeof r.params === 'object' && !Array.isArray(r.params) ? r.params : {}
    out.push({
      id: r.id,
      strategy: r.strategy,
      symbols: asSymbolList(r.symbols),
      params,
      createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
    })
  }
  return out
}

/** An entry that stored a universe keeps it; one that never did (older
 * localStorage) falls back to the live sidebar so it still previews. */
function previewSymbols(entry: AlertEntry, liveUniverse: string[]): string[] {
  return entry.symbols.length > 0 ? entry.symbols : liveUniverse
}

function rememberedParams(strategyKey: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem('ft.strategyParams')
    if (!raw) return {}
    const map = JSON.parse(raw) as unknown
    if (!map || typeof map !== 'object' || Array.isArray(map)) return {}
    const bag = (map as Record<string, unknown>)[strategyKey]
    if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return {}
    return bag as Record<string, unknown>
  } catch {
    return {}
  }
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function isAlertSnapshot(value: unknown): value is AlertSnapshot {
  return Boolean(value) && typeof value === 'object' && Array.isArray((value as AlertSnapshot).symbols)
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

function formatLevel(level: AlertLevel, distanceLabel: (distance: string) => string): string {
  if (level.price != null) return formatNumber(level.price)
  if (level.distance != null) return distanceLabel(formatNumber(level.distance))
  return '—'
}

function lockedParamSummary(strategy: StrategyInfo | undefined, params: Record<string, unknown>): string {
  if (strategy) return paramSummary(strategy, params)
  return Object.entries(params)
    .map(([name, value]) => `${name}=${value}`)
    .join(', ')
}

function UniverseStrip({
  universe,
  hint,
}: {
  universe: string[]
  hint: string
}) {
  const { t } = useTranslation()
  return (
    <div className="field">
      <label>
        {t('common.symbols')} ({universe.length})
      </label>
      <div className="toolbar">
        {universe.length === 0 ? (
          <span className="badge badge-neutral">{t('workspace.noProducts')}</span>
        ) : (
          universe.map((sym, i) => (
            <span key={sym} className={`badge ${i === 0 ? 'badge-accent' : 'badge-neutral'}`}>
              {sym}
            </span>
          ))
        )}
      </div>
      <p className="field-hint">{hint}</p>
    </div>
  )
}

/**
 * The drawer's Alert tab: a history-style list of saved strategies. Creating
 * one edits that strategy's params the same way the Backtest tab does, then
 * freezes the params and the sidebar universe on the row (params live in
 * that row, not on a second title). Selecting a row expands the per-product
 * contract / next action / stop / take-profit table immediately under it.
 */
export function AlertPanel() {
  const { t } = useTranslation()
  const { universe } = useWorkspace()
  const job = useJobSlot('alert')
  const jobRef = useRef(job)
  const previewingKeyRef = useRef<string | null>(null)
  const entriesRef = useRef<AlertEntry[]>([])
  const universeRef = useRef(universe)

  const { data: strategies } = useQuery({ queryKey: ['strategies'], queryFn: strategiesApi.list })

  const [entriesRaw, setEntriesRaw] = useStickyState<AlertEntry[]>('alertEntries', [])
  const entries = asEntries(entriesRaw)
  const [activeId, setActiveId] = useStickyState('alertActiveId', '')
  const [composing, setComposing] = useState(false)
  const [draftStrategy, setDraftStrategy] = useState('')
  const [paramDraft, setParamDraft] = useState<Record<string, string>>({})
  const [seededKey, setSeededKey] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<AlertEntry | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cacheRev, setCacheRev] = useState(0)

  // Nothing is selected until a row is clicked (or a new one is saved).
  // Defaulting to `entries[0]` would expand the first row on every visit.
  const resolvedActiveId = entries.some((e) => e.id === activeId) ? activeId : ''
  const activeEntry = entries.find((e) => e.id === resolvedActiveId) ?? null
  void cacheRev
  const activeSymbols = activeEntry ? previewSymbols(activeEntry, universe) : []
  const firstRunnable = strategies?.find((s) => s.errors.length === 0)?.key ?? ''
  const strategyKey =
    strategies !== undefined && (!draftStrategy || !strategies.some((s) => s.key === draftStrategy))
      ? firstRunnable
      : draftStrategy
  const composeStrategy = strategies?.find((s) => s.key === strategyKey)
  useEffect(() => {
    jobRef.current = job
    entriesRef.current = entries
    universeRef.current = universe
  })

  const startPreview = useCallback(async (entry: AlertEntry) => {
    const symbols = previewSymbols(entry, universeRef.current)
    if (symbols.length === 0) return
    const cacheKey = previewKey(entry.id, symbols)
    previewingKeyRef.current = cacheKey
    setError(null)
    if (inflightFor(cacheKey) && jobRef.current.isActive) return
    jobRef.current.reset()
    try {
      const { job_id } = await alertsApi.preview({
        strategy: entry.strategy,
        symbols,
        params: entry.params,
      })
      if (previewingKeyRef.current !== cacheKey) return
      markInflight(cacheKey, entry.id, job_id)
      jobRef.current.start(job_id)
      setCacheRev((n) => n + 1)
    } catch (err) {
      if (previewingKeyRef.current === cacheKey) {
        clearInflight()
        setError(errorMessage(err))
        setCacheRev((n) => n + 1)
      }
    }
  }, [])

  const previewSymbolsKey = activeSymbols.join(',')
  useEffect(() => {
    if (!resolvedActiveId || composing) return
    if (activeSymbols.length === 0) return
    if (cachedPreview(resolvedActiveId, activeSymbols)) return
    if (inflightFor(previewKey(resolvedActiveId, activeSymbols))) return
    const entry = entriesRef.current.find((e) => e.id === resolvedActiveId)
    if (entry) void startPreview(entry)
  }, [resolvedActiveId, previewSymbolsKey, composing, startPreview, activeSymbols.length])

  useEffect(() => {
    const state = job.state
    const tracked = state ? inflightJob(state.id) : null
    if (!state || !tracked) return
    if (state.status === 'done' && isAlertSnapshot(state.result)) {
      rememberPreview(tracked.cacheKey, state.result)
      setCacheRev((n) => n + 1)
    } else if (state.status === 'error') {
      clearInflight()
      setCacheRev((n) => n + 1)
    }
  }, [job.state])

  let draft = paramDraft
  if (composing && composeStrategy && seededKey !== composeStrategy.key) {
    draft = seedParamDraft(composeStrategy, rememberedParams(composeStrategy.key))
    setSeededKey(composeStrategy.key)
    setParamDraft(draft)
  }

  const parsedParams = composeStrategy
    ? effectiveParams(composeStrategy, draft)
    : { ok: true as const, params: {} as Record<string, unknown>, errors: {} as ParamFieldErrors }

  const onParamDraftChange = (name: string, raw: string) => {
    if (!composeStrategy) return
    setParamDraft({ ...draft, [name]: raw })
  }

  const onResetParams = () => {
    if (!composeStrategy) return
    setParamDraft(seedParamDraft(composeStrategy, {}))
  }

  const strategyBroken = Boolean(composeStrategy?.errors.length)
  const canSave =
    Boolean(strategyKey) && !strategyBroken && parsedParams.ok && universe.length > 0

  const openCompose = () => {
    setDraftStrategy('')
    setSeededKey(null)
    setParamDraft({})
    setComposing(true)
  }

  const onSave = () => {
    if (!canSave || !parsedParams.ok) return
    const entry: AlertEntry = {
      id: newId(),
      strategy: strategyKey,
      symbols: [...universe],
      params: parsedParams.params,
      createdAt: Date.now(),
    }
    setEntriesRaw([entry, ...entries])
    setActiveId(entry.id)
    setComposing(false)
  }

  const onDelete = () => {
    if (!confirmDelete) return
    dropPreview(confirmDelete.id)
    const next = entries.filter((e) => e.id !== confirmDelete.id)
    setEntriesRaw(next)
    if (activeId === confirmDelete.id) setActiveId('')
    setConfirmDelete(null)
    setCacheRev((n) => n + 1)
  }

  const onRefresh = () => {
    if (!activeEntry) return
    dropPreview(activeEntry.id)
    setError(null)
    setCacheRev((n) => n + 1)
    void startPreview(activeEntry)
  }

  const paramsOf = (entry: AlertEntry) => {
    const info = strategies?.find((s) => s.key === entry.strategy)
    return lockedParamSummary(info, entry.params)
  }

  const entryColumns: Column<AlertEntry>[] = [
    { key: 'strategy', header: t('common.strategy'), render: (r) => r.strategy },
    {
      key: 'symbols',
      header: t('common.symbols'),
      render: (r) => (r.symbols.length > 0 ? r.symbols.join(', ') : '—'),
    },
    {
      key: 'params',
      header: t('alerts.params'),
      render: (r) => (
        <span title={t('alerts.paramsLocked')}>{paramsOf(r) || '—'}</span>
      ),
    },
    {
      key: 'created',
      header: t('runs.created'),
      render: (r) => (r.createdAt ? new Date(r.createdAt).toLocaleString() : '—'),
    },
    {
      key: 'actions',
      header: t('common.actions'),
      render: (r) => (
        <button
          className="btn btn-sm btn-danger btn-icon"
          aria-label={t('common.delete')}
          title={t('common.delete')}
          onClick={(e) => {
            e.stopPropagation()
            setConfirmDelete(r)
          }}
        >
          <Icon name="trash" size={14} />
        </button>
      ),
    },
  ]

  const symbolColumns: Column<AlertSymbolRow>[] = [
    { key: 'symbol', header: t('common.symbols'), render: (r) => r.symbol },
    { key: 'contract', header: t('alerts.contract'), render: (r) => r.contract || '—' },
    {
      key: 'operation',
      header: t('alerts.operation'),
      render: (r) => t(`alerts.operations.${r.operation}`),
    },
    {
      key: 'stop',
      header: t('alerts.stop'),
      numeric: true,
      render: (r) => formatLevel(r.stop, (d) => t('alerts.distanceFromNextOpen', { distance: d })),
    },
    {
      key: 'take_profit',
      header: t('alerts.takeProfit'),
      numeric: true,
      render: (r) => formatLevel(r.take_profit, (d) => t('alerts.distanceFromNextOpen', { distance: d })),
    },
  ]

  const shownError = error ?? (job.state?.status === 'error' ? job.state.error : null)

  const renderExpanded = (entry: AlertEntry) => {
    const symbols = previewSymbols(entry, universe)
    const snap = cachedPreview(entry.id, symbols)
    const expanding =
      symbols.length > 0 &&
      !snap &&
      !shownError &&
      job.state?.status !== 'error'
    return (
      <div className="alert-expand">
        {symbols.length === 0 && (
          <div className="empty-state">
            <span className="empty-state-title">{t('workspace.noProducts')}</span>
            <p className="empty-state-hint">{t('alerts.universeHint')}</p>
          </div>
        )}
        {expanding && job.state && (
          <div style={{ marginBottom: 8 }}>
            <JobProgress
              state={job.state}
              logs={job.logs}
              onCancel={job.cancel}
              streaming={job.streaming}
              lost={job.lost}
            />
          </div>
        )}
        {expanding && !job.state && (
          <div className="empty-state">
            <span className="spinner" />
            <span>{t('common.loading')}</span>
          </div>
        )}
        {shownError && (
          <div className="hint-banner warning">
            <strong>{t('alerts.previewFailed')}</strong> — {shownError}
          </div>
        )}
        {snap && (
          <>
            {snap.blown_up && (
              <div className="hint-banner danger">
                <strong>{t('backtest.blownUp')}</strong> — {t('alerts.blownUpHint')}
              </div>
            )}
            <div className="alert-expand-bar">
              {snap.asof && (
                <span className="field-hint" style={{ margin: 0 }}>
                  {t('alerts.asof', { date: snap.asof })}
                </span>
              )}
              <button type="button" className="btn btn-sm" onClick={onRefresh}>
                {t('alerts.refresh')}
              </button>
            </div>
            <Table columns={symbolColumns} rows={snap.symbols} rowKey={(r) => r.symbol} />
          </>
        )}
      </div>
    )
  }

  return (
    <div>
      <div className="toolbar">
        <button
          type="button"
          className={`btn btn-sm ${composing ? 'btn-primary' : ''}`}
          onClick={() => (composing ? setComposing(false) : openCompose())}
        >
          <Icon name="plus" size={14} />
          {t('alerts.add')}
        </button>
      </div>

      {composing && (
        <div style={{ marginTop: 12 }}>
          <Card title={t('alerts.addTitle')}>
            <div className="field">
              <label>{t('common.strategy')}</label>
              <select value={strategyKey} onChange={(e) => setDraftStrategy(e.target.value)}>
                {(strategies ?? []).map((s) => (
                  <option key={s.key} value={s.key} disabled={s.errors.length > 0}>
                    {s.errors.length > 0 ? `${s.key} (${t('backtest.strategyBroken')})` : s.key}
                  </option>
                ))}
              </select>
              <p className="field-hint">{t('alerts.paramsHint')}</p>
            </div>
            {composeStrategy && (
              <StrategyParamFields
                strategy={composeStrategy}
                paramDraft={draft}
                onParamDraftChange={onParamDraftChange}
                onResetParams={onResetParams}
                paramErrors={parsedParams.errors}
                idPrefix="alert-param"
              />
            )}
            <UniverseStrip universe={universe} hint={t('alerts.universeHint')} />
            <div className="toolbar" style={{ marginTop: 8 }}>
              <button type="button" className="btn btn-primary" onClick={onSave} disabled={!canSave}>
                {t('common.save')}
              </button>
              <button type="button" className="btn" onClick={() => setComposing(false)}>
                {t('common.cancel')}
              </button>
            </div>
          </Card>
        </div>
      )}

      {!composing && entries.length === 0 && (
        <div className="empty-state">
          <span className="empty-state-icon">
            <Icon name="alert" size={18} />
          </span>
          <span className="empty-state-title">{t('alerts.noEntries')}</span>
          <p className="empty-state-hint">{t('alerts.noEntriesHint')}</p>
        </div>
      )}

      {entries.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <Table
            columns={entryColumns}
            rows={entries}
            rowKey={(r) => r.id}
            emptyMessage={t('alerts.noEntries')}
            onRowClick={(r) => {
              setActiveId(r.id)
              setComposing(false)
            }}
            rowClassName={(r) =>
              [resolvedActiveId === r.id ? 'row-open' : '', 'row-selectable'].filter(Boolean).join(' ')
            }
            isExpanded={(r) => !composing && r.id === resolvedActiveId}
            renderExpanded={renderExpanded}
          />
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title={t('alerts.deleteConfirm', { strategy: confirmDelete?.strategy ?? '' })}
        onConfirm={onDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  )
}
