import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../api/client'
import { alertsApi, dataApi, strategiesApi } from '../api/endpoints'
import type { AlertLevel, AlertOperation, AlertSnapshot, AlertSymbolRow, StrategyInfo } from '../api/types'
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
  symbols: string[]
  params: Record<string, unknown>
  createdAt: number
}

interface ComposerState {
  mode: 'new' | 'edit' | 'copy'
  entryId?: string
}

interface InflightPreview {
  cacheKey: string
  entryId: string
  jobId: string
  batch: boolean
}

/** Snapshots survive tab switches. Params are part of the key so an edit can
 * never mistake an older configuration's result for its own. */
const previewCache = new Map<string, AlertSnapshot>()
const previewErrors = new Map<string, string>()
const stalePreviews = new Set<string>()
let inflight: InflightPreview | null = null
let starting = false

function previewKey(entry: AlertEntry, symbols: string[]): string {
  return `${entry.id}::${symbols.join(',')}::${JSON.stringify(entry.params)}`
}

export function resetAlertPreviewState() {
  previewCache.clear()
  previewErrors.clear()
  stalePreviews.clear()
  inflight = null
  starting = false
}

function cachedPreview(entry: AlertEntry, symbols: string[]): AlertSnapshot | undefined {
  return previewCache.get(previewKey(entry, symbols))
}

function dropPreview(entryId: string) {
  for (const key of [...previewCache.keys()]) {
    if (key.startsWith(`${entryId}::`)) previewCache.delete(key)
  }
  for (const key of [...previewErrors.keys()]) {
    if (key.startsWith(`${entryId}::`)) previewErrors.delete(key)
  }
  for (const key of [...stalePreviews]) {
    if (key.startsWith(`${entryId}::`)) stalePreviews.delete(key)
  }
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

const ACTIONABLE = new Set<AlertOperation>(['open_long', 'open_short', 'close', 'reverse', 'add', 'reduce'])

function operationCounts(snapshot: AlertSnapshot | undefined): Array<[AlertOperation, number]> {
  if (!snapshot) return []
  const counts = new Map<AlertOperation, number>()
  for (const row of snapshot.symbols) {
    if (!ACTIONABLE.has(row.operation)) continue
    counts.set(row.operation, (counts.get(row.operation) ?? 0) + 1)
  }
  return [...counts.entries()]
}

function UniverseStrip({
  value,
  liveUniverse,
  onChange,
  onManage,
}: {
  value: string[]
  liveUniverse: string[]
  onChange: (symbols: string[]) => void
  onManage: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="field">
      <div className="field-label-row">
        <label>{`${t('common.symbols')} (${value.length})`}</label>
        <div className="toolbar">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange([...liveUniverse])}>
            {t('alerts.useLiveUniverse')}
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onManage}>
            {t('workspace.manageProducts')}
          </button>
        </div>
      </div>
      <div className="universe-chip-list">
        {value.length === 0 ? (
          <span className="badge badge-neutral">{t('workspace.noProducts')}</span>
        ) : (
          value.map((symbol) => (
            <button
              key={symbol}
              type="button"
              className="universe-chip"
              title={t('workspace.removeFromUniverse', { symbol })}
              aria-label={t('workspace.removeFromUniverse', { symbol })}
              onClick={() => onChange(value.filter((s) => s !== symbol))}
            >
              {symbol}
              <Icon name="close" size={11} />
            </button>
          ))
        )}
      </div>
      <p className="field-hint">{t('alerts.universeHint')}</p>
    </div>
  )
}

/** Saved strategy configurations with on-demand, per-row signal snapshots.
 * Expanding a row never starts a job; explicit refreshes share the existing
 * alert job slot and additional requests wait in a sequential queue. */
export function AlertPanel() {
  const { t } = useTranslation()
  const { universe, setChartSymbol, setSidebarOpen } = useWorkspace()
  const job = useJobSlot('alert')
  const dataJob = useJobSlot('data')
  const jobRef = useRef(job)
  const entriesRef = useRef<AlertEntry[]>([])
  const universeRef = useRef(universe)
  const pendingRef = useRef<string[]>([])

  const { data: strategies } = useQuery({ queryKey: ['strategies'], queryFn: strategiesApi.list })

  const [entriesRaw, setEntriesRaw] = useStickyState<AlertEntry[]>('alertEntries', [])
  const entries = asEntries(entriesRaw)
  const [activeId, setActiveId] = useStickyState('alertActiveId', '')
  const [composer, setComposer] = useState<ComposerState | null>(null)
  const [composeSeq, setComposeSeq] = useState(0)
  const [composeInitialParams, setComposeInitialParams] = useState<Record<string, unknown>>({})
  const [draftStrategy, setDraftStrategy] = useState('')
  const [draftUniverse, setDraftUniverse] = useState<string[]>([])
  const [paramDraft, setParamDraft] = useState<Record<string, string>>({})
  const [seededKey, setSeededKey] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<AlertEntry | null>(null)
  const [pendingOnly, setPendingOnly] = useState(false)
  const [dataStarting, setDataStarting] = useState(false)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [pendingIds, setPendingIds] = useState<string[]>([])
  const [batchTotal, setBatchTotal] = useState(0)
  const [cacheRev, setCacheRev] = useState(0)
  void cacheRev

  const resolvedActiveId = entries.some((e) => e.id === activeId) ? activeId : ''
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

  const enqueue = useCallback((ids: string[]) => {
    const additions = ids.filter((id) => !pendingRef.current.includes(id))
    if (additions.length === 0) return
    pendingRef.current = [...pendingRef.current, ...additions]
    setPendingIds(pendingRef.current)
  }, [setPendingIds])

  const startPreview = useCallback(
    async (entry: AlertEntry, batch = false) => {
      const symbols = previewSymbols(entry, universeRef.current)
      if (symbols.length === 0) return
      const cacheKey = previewKey(entry, symbols)
      if (inflight?.cacheKey === cacheKey && jobRef.current.isActive) return
      if (starting || jobRef.current.isActive || inflight) {
        enqueue([entry.id])
        return
      }

      starting = true
      previewErrors.delete(cacheKey)
      stalePreviews.delete(cacheKey)
      jobRef.current.reset()
      setCacheRev((n) => n + 1)
      try {
        const { job_id } = await alertsApi.preview({
          strategy: entry.strategy,
          symbols,
          params: entry.params,
        })
        inflight = { cacheKey, entryId: entry.id, jobId: job_id, batch }
        jobRef.current.start(job_id)
      } catch (err) {
        previewErrors.set(cacheKey, errorMessage(err))
      } finally {
        starting = false
        setCacheRev((n) => n + 1)
      }
    },
    [enqueue, setCacheRev],
  )

  useEffect(() => {
    const state = job.state
    const tracked = state && inflight?.jobId === state.id ? inflight : null
    if (!tracked) return
    if (job.lost) {
      previewErrors.set(tracked.cacheKey, t('jobs.lost'))
      inflight = null
      setCacheRev((n) => n + 1)
      return
    }
    if (state?.status === 'done' && isAlertSnapshot(state.result)) {
      previewCache.set(tracked.cacheKey, state.result)
      previewErrors.delete(tracked.cacheKey)
      stalePreviews.delete(tracked.cacheKey)
      inflight = null
      setCacheRev((n) => n + 1)
    } else if (state?.status === 'done' && 'result' in state) {
      // SSE terminal frames deliberately omit `result`; useJob follows them
      // with a GET that carries it. Only a completed response with an invalid
      // result is a failure -- the frame in between must keep the queue held.
      previewErrors.set(tracked.cacheKey, t('alerts.previewFailed'))
      inflight = null
      setCacheRev((n) => n + 1)
    } else if (state?.status === 'error' || state?.status === 'cancelled') {
      if (state.status !== 'cancelled') previewErrors.set(tracked.cacheKey, state.error ?? t('alerts.previewFailed'))
      inflight = null
      setCacheRev((n) => n + 1)
    }
  }, [job.state, job.lost, t])

  useEffect(() => {
    if (starting || job.isActive || inflight) return
    if (pendingIds.length === 0) {
      if (batchTotal > 0) setBatchTotal(0)
      return
    }
    const [nextId, ...rest] = pendingIds
    pendingRef.current = rest
    setPendingIds(rest)
    const entry = entriesRef.current.find((e) => e.id === nextId)
    if (entry) void startPreview(entry, batchTotal > 0)
  }, [job.isActive, pendingIds, batchTotal, cacheRev, startPreview])

  const announcedDataJob = useRef<string | null>(null)
  useEffect(() => {
    const state = dataJob.state
    if (state?.status !== 'done' || announcedDataJob.current === state.id) return
    announcedDataJob.current = state.id
    for (const key of previewCache.keys()) stalePreviews.add(key)
    setCacheRev((n) => n + 1)
  }, [dataJob.state])

  let draft = paramDraft
  const composeSeedKey = composer && composeStrategy ? `${composeSeq}:${composeStrategy.key}` : null
  if (composer && composeStrategy && composeSeedKey && seededKey !== composeSeedKey) {
    const initial = composer.mode === 'new' ? rememberedParams(composeStrategy.key) : composeInitialParams
    draft = seedParamDraft(composeStrategy, initial)
    setSeededKey(composeSeedKey)
    setParamDraft(draft)
  }

  const parsedParams = composeStrategy
    ? effectiveParams(composeStrategy, draft)
    : { ok: true as const, params: {} as Record<string, unknown>, errors: {} as ParamFieldErrors }
  const strategyBroken = Boolean(composeStrategy?.errors.length)
  const canSave = Boolean(composer && strategyKey) && !strategyBroken && parsedParams.ok && draftUniverse.length > 0

  const openCompose = (mode: ComposerState['mode'], entry?: AlertEntry) => {
    const info = entry ? strategies?.find((s) => s.key === entry.strategy) : undefined
    setComposer({ mode, entryId: mode === 'edit' ? entry?.id : undefined })
    setComposeSeq((n) => n + 1)
    setDraftStrategy(entry?.strategy ?? '')
    setComposeInitialParams(entry?.params ?? {})
    setParamDraft(entry && info ? seedParamDraft(info, entry.params) : {})
    setDraftUniverse(mode === 'new' ? [...universe] : (entry ? [...previewSymbols(entry, universe)] : [...universe]))
    setSeededKey(null)
  }

  const onSave = () => {
    if (!composer || !canSave || !parsedParams.ok) return
    const previous = composer.entryId ? entries.find((e) => e.id === composer.entryId) : undefined
    const entry: AlertEntry = {
      id: previous?.id ?? newId(),
      strategy: strategyKey,
      symbols: [...draftUniverse],
      params: parsedParams.params,
      createdAt: previous?.createdAt ?? Date.now(),
    }
    const next = previous ? entries.map((e) => (e.id === entry.id ? entry : e)) : [entry, ...entries]
    dropPreview(entry.id)
    setEntriesRaw(next)
    setActiveId(entry.id)
    setComposer(null)
    void startPreview(entry)
  }

  const onDelete = () => {
    if (!confirmDelete) return
    dropPreview(confirmDelete.id)
    pendingRef.current = pendingRef.current.filter((id) => id !== confirmDelete.id)
    setPendingIds(pendingRef.current)
    setEntriesRaw(entries.filter((e) => e.id !== confirmDelete.id))
    if (activeId === confirmDelete.id) setActiveId('')
    setConfirmDelete(null)
    setCacheRev((n) => n + 1)
  }

  const refreshAll = () => {
    const ids = entries.filter((e) => previewSymbols(e, universe).length > 0 && inflight?.entryId !== e.id).map((e) => e.id)
    if (ids.length === 0) return
    setBatchTotal(ids.length)
    enqueue(ids)
  }

  const cancelBatch = () => {
    pendingRef.current = []
    setPendingIds([])
    setBatchTotal(0)
  }

  const runDataUpdate = async (entry: AlertEntry) => {
    const symbols = previewSymbols(entry, universe)
    if (symbols.length === 0 || dataStarting || dataJob.isActive) return
    setUpdateError(null)
    setDataStarting(true)
    try {
      const { job_id } = await dataApi.update(symbols, false, false)
      dataJob.start(job_id)
    } catch (err) {
      setUpdateError(errorMessage(err))
    } finally {
      setDataStarting(false)
    }
  }

  const paramsOf = (entry: AlertEntry) => {
    const info = strategies?.find((s) => s.key === entry.strategy)
    return lockedParamSummary(info, entry.params)
  }

  const statusOf = (entry: AlertEntry): 'idle' | 'queued' | 'running' | 'ready' | 'stale' | 'error' => {
    const symbols = previewSymbols(entry, universe)
    const key = previewKey(entry, symbols)
    if (inflight?.cacheKey === key && job.isActive) return 'running'
    if (pendingIds.includes(entry.id)) return 'queued'
    if (previewErrors.has(key)) return 'error'
    if (!previewCache.has(key)) return 'idle'
    return stalePreviews.has(key) ? 'stale' : 'ready'
  }

  const statusBadge = (entry: AlertEntry) => {
    const status = statusOf(entry)
    const variant = status === 'ready' ? 'badge-success' : status === 'error' ? 'badge-danger' : status === 'stale' ? 'badge-warning' : status === 'running' ? 'badge-accent' : 'badge-neutral'
    return <span className={`badge ${variant}`}>{t(`alerts.status.${status}`)}</span>
  }

  const signalSummary = (entry: AlertEntry) => {
    const snap = cachedPreview(entry, previewSymbols(entry, universe))
    const counts = operationCounts(snap)
    if (!snap) return <span className="alert-summary-empty">—</span>
    if (counts.length === 0) return <span className="alert-no-action">{t('alerts.noPendingActions')}</span>
    return (
      <div className="alert-signal-summary">
        {counts.map(([operation, count]) => (
          <span key={operation} className={`alert-signal op-${operation}`}>
            {t(`alerts.operations.${operation}`)} {count}
          </span>
        ))}
      </div>
    )
  }

  const rowActions = (entry: AlertEntry) => (
    <div className="alert-row-actions">
      <button
        type="button"
        className="btn btn-sm btn-ghost btn-icon"
        title={t('alerts.updateData')}
        aria-label={t('alerts.updateData')}
        disabled={dataStarting || dataJob.isActive || previewSymbols(entry, universe).length === 0}
        onClick={(e) => { e.stopPropagation(); void runDataUpdate(entry) }}
      >
        <Icon name="download" size={14} />
      </button>
      <button type="button" className="btn btn-sm btn-ghost btn-icon" title={t('alerts.refresh')} aria-label={t('alerts.refresh')} onClick={(e) => { e.stopPropagation(); void startPreview(entry) }}>
        <Icon name="refresh" size={14} />
      </button>
      <button type="button" className="btn btn-sm btn-ghost btn-icon" title={t('alerts.edit')} aria-label={t('alerts.edit')} onClick={(e) => { e.stopPropagation(); openCompose('edit', entry) }}>
        <Icon name="pencil" size={14} />
      </button>
      <button type="button" className="btn btn-sm btn-ghost btn-icon" title={t('alerts.copy')} aria-label={t('alerts.copy')} onClick={(e) => { e.stopPropagation(); openCompose('copy', entry) }}>
        <Icon name="copy" size={14} />
      </button>
      <button type="button" className="btn btn-sm btn-danger btn-icon" title={t('common.delete')} aria-label={t('common.delete')} onClick={(e) => { e.stopPropagation(); setConfirmDelete(entry) }}>
        <Icon name="trash" size={14} />
      </button>
    </div>
  )

  const entryColumns: Column<AlertEntry>[] = [
    { key: 'strategy', header: t('common.strategy'), render: (r) => <strong className="alert-strategy">{r.strategy}</strong> },
    { key: 'symbols', header: t('common.symbols'), render: (r) => (r.symbols.length > 0 ? r.symbols.join(', ') : '—') },
    { key: 'signals', header: t('alerts.latestSignals'), render: signalSummary },
    { key: 'asof', header: t('alerts.asofColumn'), render: (r) => cachedPreview(r, previewSymbols(r, universe))?.asof ?? '—' },
    { key: 'status', header: t('common.status'), render: statusBadge },
    { key: 'actions', header: t('common.actions'), render: rowActions },
  ]

  const symbolColumns: Column<AlertSymbolRow>[] = [
    { key: 'symbol', header: t('common.symbols'), render: (r) => r.symbol },
    { key: 'contract', header: t('alerts.contract'), render: (r) => r.contract || '—' },
    {
      key: 'operation',
      header: t('alerts.operation'),
      render: (r) => <span className={ACTIONABLE.has(r.operation) ? `alert-operation op-${r.operation}` : 'alert-operation'}>{t(`alerts.operations.${r.operation}`)}</span>,
    },
    { key: 'stop', header: t('alerts.stop'), numeric: true, render: (r) => formatLevel(r.stop, (d) => t('alerts.distanceFromNextOpen', { distance: d })) },
    { key: 'take_profit', header: t('alerts.takeProfit'), numeric: true, render: (r) => formatLevel(r.take_profit, (d) => t('alerts.distanceFromNextOpen', { distance: d })) },
    {
      key: 'chart',
      header: '',
      render: (r) => (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setChartSymbol(r.symbol)}>
          <Icon name="line-chart" size={13} />
          {t('alerts.viewChart')}
        </button>
      ),
    },
  ]

  const renderExpanded = (entry: AlertEntry) => {
    const symbols = previewSymbols(entry, universe)
    const key = previewKey(entry, symbols)
    const snap = previewCache.get(key)
    const error = previewErrors.get(key)
    const running = inflight?.cacheKey === key && job.state
    return (
      <div className="alert-expand">
        <div className="alert-expand-bar">
          <span className="alert-params-summary" title={paramsOf(entry)}>{paramsOf(entry) || t('alerts.defaultParams')}</span>
          <div className="spacer" />
          {snap?.asof && <span className="field-hint">{t('alerts.asof', { date: snap.asof })}</span>}
          <button type="button" className="btn btn-sm btn-primary" disabled={symbols.length === 0} onClick={() => void startPreview(entry)}>
            <Icon name="refresh" size={13} />
            {snap ? t('alerts.refresh') : t('alerts.computeNow')}
          </button>
        </div>
        {running && (
          <JobProgress state={job.state!} logs={job.logs} onCancel={job.cancel} streaming={job.streaming} lost={job.lost} />
        )}
        {pendingIds.includes(entry.id) && !running && <div className="hint-banner">{t('alerts.queuedHint')}</div>}
        {error && <div className="hint-banner warning"><strong>{t('alerts.previewFailed')}</strong> — {error}</div>}
        {snap?.blown_up && <div className="hint-banner danger"><strong>{t('backtest.blownUp')}</strong> — {t('alerts.blownUpHint')}</div>}
        {snap && <Table columns={symbolColumns} rows={snap.symbols} rowKey={(r) => r.symbol} />}
        {!snap && !running && !error && symbols.length > 0 && (
          <div className="empty-state alert-empty-preview">
            <span className="empty-state-title">{t('alerts.noSnapshot')}</span>
            <p className="empty-state-hint">{t('alerts.noSnapshotHint')}</p>
          </div>
        )}
        {symbols.length === 0 && <div className="hint-banner warning">{t('alerts.universeRequired')}</div>}
      </div>
    )
  }

  const visibleEntries = pendingOnly
    ? entries.filter((entry) => operationCounts(cachedPreview(entry, previewSymbols(entry, universe))).length > 0)
    : entries
  const batchRunning = batchTotal > 0 && (pendingIds.length > 0 || Boolean(inflight?.batch))
  const batchDone = Math.max(0, batchTotal - pendingIds.length - (inflight?.batch ? 1 : 0))

  return (
    <div className="alerts-panel">
      <div className="toolbar alerts-toolbar">
        <button type="button" className={`btn btn-sm ${composer?.mode === 'new' ? 'btn-primary' : ''}`} onClick={() => (composer?.mode === 'new' ? setComposer(null) : openCompose('new'))}>
          <Icon name="plus" size={14} />
          {t('alerts.add')}
        </button>
        <button type="button" className={`btn btn-sm ${pendingOnly ? 'btn-primary' : ''}`} aria-pressed={pendingOnly} onClick={() => setPendingOnly((v) => !v)}>
          {t('alerts.pendingOnly')}
        </button>
        <div className="spacer" />
        {batchRunning && <span className="alert-batch-progress">{t('alerts.batchProgress', { done: batchDone, total: batchTotal })}</span>}
        {pendingIds.length > 0 && batchTotal > 0 && <button type="button" className="btn btn-sm" onClick={cancelBatch}>{t('alerts.cancelQueue')}</button>}
        <button type="button" className="btn btn-sm" disabled={entries.length === 0} onClick={refreshAll}>
          <Icon name="refresh" size={13} />
          {t('alerts.refreshAll')}
        </button>
      </div>

      {updateError && <div className="hint-banner warning">{t('common.updateFailed')} — {updateError}</div>}

      {composer && (
        <Card title={t(`alerts.${composer.mode}Title`)} className="alert-composer">
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
              onParamDraftChange={(name, raw) => setParamDraft({ ...draft, [name]: raw })}
              onResetParams={() => composeStrategy && setParamDraft(seedParamDraft(composeStrategy, {}))}
              paramErrors={parsedParams.errors}
              idPrefix="alert-param"
            />
          )}
          <UniverseStrip value={draftUniverse} liveUniverse={universe} onChange={setDraftUniverse} onManage={() => setSidebarOpen(true)} />
          <div className="toolbar alert-composer-actions">
            <button type="button" className="btn btn-primary" onClick={onSave} disabled={!canSave}>
              {t('alerts.saveAndCompute')}
            </button>
            <button type="button" className="btn" onClick={() => setComposer(null)}>{t('common.cancel')}</button>
          </div>
        </Card>
      )}

      {!composer && entries.length === 0 && (
        <div className="empty-state">
          <span className="empty-state-icon"><Icon name="alert" size={18} /></span>
          <span className="empty-state-title">{t('alerts.noEntries')}</span>
          <p className="empty-state-hint">{t('alerts.noEntriesHint')}</p>
        </div>
      )}

      {entries.length > 0 && (
        <Table
          columns={entryColumns}
          rows={visibleEntries}
          rowKey={(r) => r.id}
          emptyMessage={pendingOnly ? t('alerts.noPendingEntries') : t('alerts.noEntries')}
          onRowClick={(r) => {
            setActiveId(resolvedActiveId === r.id ? '' : r.id)
            setComposer(null)
          }}
          rowClassName={(r) => [resolvedActiveId === r.id ? 'row-open' : '', 'row-selectable'].filter(Boolean).join(' ')}
          isExpanded={(r) => !composer && r.id === resolvedActiveId}
          renderExpanded={renderExpanded}
        />
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
