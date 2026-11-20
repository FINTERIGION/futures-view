import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../api/client'
import { alertsApi, dataApi, strategiesApi } from '../api/endpoints'
import type {
  AlertHolding,
  AlertLevel,
  AlertMonitor,
  AlertMonitorImportItem,
  AlertOperation,
  AlertSnapshot,
  AlertSymbolRow,
  StrategyInfo,
} from '../api/types'
import { Card } from '../components/Card'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Icon } from '../components/Icon'
import { JobProgress } from '../components/JobProgress'
import { Table } from '../components/Table'
import type { Column } from '../components/Table'
import { useToast } from '../components/toastStore'
import { effectiveParams, paramSummary, seedParamDraft, type ParamFieldErrors } from '../chart/indicatorParams'
import { useStickyState } from '../hooks/useStickyState'
import { useJobSlot } from '../shell/jobsStore'
import { useWorkspace } from '../shell/workspaceStore'
import {
  alertPreviewStore,
  cachedError,
  cachedPreview,
  dropPreview,
  previewKey,
  setCachedPreview,
} from './alertPreviewStore'
import { StrategyParamFields } from './StrategyParamFields'

interface ComposerState {
  mode: 'new' | 'edit' | 'copy'
  entryId?: string
  initialStrategy?: string
}

const LEGACY_STORAGE_KEY = 'ft.alertEntries'
const LEGACY_MIGRATED_KEY = 'ft.alertEntriesMigrated'

function asSymbolList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((s): s is string => typeof s === 'string' && s.length > 0)
}

function readLegacyEntries(fallbackUniverse: string[]): AlertMonitorImportItem[] {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: AlertMonitorImportItem[] = []
    for (const row of parsed) {
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      if (typeof r.strategy !== 'string' || !r.strategy) continue
      const symbols = asSymbolList(r.symbols)
      const resolvedSymbols = symbols.length > 0 ? symbols : fallbackUniverse
      if (resolvedSymbols.length === 0) continue
      const params =
        r.params && typeof r.params === 'object' && !Array.isArray(r.params)
          ? (r.params as Record<string, unknown>)
          : {}
      out.push({
        id: typeof r.id === 'string' ? r.id : undefined,
        strategy: r.strategy,
        symbols: resolvedSymbols,
        params,
        notify_enabled: true,
        created_at: typeof r.createdAt === 'number' ? r.createdAt : undefined,
      })
    }
    return out
  } catch {
    return []
  }
}

function previewSymbols(entry: AlertMonitor, liveUniverse: string[]): string[] {
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

function isAlertSnapshot(value: unknown): value is AlertSnapshot {
  return Boolean(value) && typeof value === 'object' && Array.isArray((value as AlertSnapshot).symbols)
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : Number(n.toFixed(4)).toString()
}

function formatLevel(level: AlertLevel, distanceLabel: (distance: string) => string): string {
  if (level.price != null) return formatNumber(level.price)
  if (level.distance != null) return distanceLabel(formatNumber(level.distance))
  return '—'
}

function formatPriceRef(row: AlertSymbolRow): string {
  const entry = row.entry_price != null ? formatNumber(row.entry_price) : null
  const last = row.last_price != null ? formatNumber(row.last_price) : null
  if (entry && last) return `${entry} / ${last}`
  if (last) return `— / ${last}`
  if (entry) return `${entry} / —`
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

/** Saved strategy configurations (persisted in SQLite so scheduled reminders can
 * evaluate them headlessly) with on-demand, per-row signal snapshots. Expanding
 * a row never starts a job; explicit refreshes share the existing alert job slot
 * and additional requests wait in a sequential queue. */
export function AlertPanel() {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const { universe, setChartSymbol, setSidebarOpen } = useWorkspace()
  const job = useJobSlot('alert')
  const dataJob = useJobSlot('data')
  const jobRef = useRef(job)
  const entriesRef = useRef<AlertMonitor[]>([])
  const universeRef = useRef(universe)

  const { data: strategies } = useQuery({ queryKey: ['strategies'], queryFn: strategiesApi.list })
  const monitorsQuery = useQuery({
    queryKey: ['alert-monitors'],
    queryFn: alertsApi.listMonitors,
  })
  const entries = monitorsQuery.data ?? []

  const [activeId, setActiveId] = useStickyState('alertActiveId', '')
  const [composer, setComposer] = useState<ComposerState | null>(null)
  const [composeSeq, setComposeSeq] = useState(0)
  const [composeInitialParams, setComposeInitialParams] = useState<Record<string, unknown>>({})
  const [draftStrategy, setDraftStrategy] = useState('')
  const [draftUniverse, setDraftUniverse] = useState<string[]>([])
  const [paramDraft, setParamDraft] = useState<Record<string, string>>({})
  const [seededKey, setSeededKey] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<AlertMonitor | null>(null)
  const [pendingOnly, setPendingOnly] = useState(false)
  const [dataStarting, setDataStarting] = useState(false)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [pendingIds, setPendingIds] = useState<string[]>(() => [...alertPreviewStore.pendingIds])
  const [batchTotal, setBatchTotal] = useState<number>(() => alertPreviewStore.batchTotal)
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

  // Seamless one-time migration of legacy localStorage entries into SQLite.
  useEffect(() => {
    if (!monitorsQuery.isSuccess || alertPreviewStore.migrationStarted) return
    if (monitorsQuery.data.length > 0) return
    try {
      if (localStorage.getItem(LEGACY_MIGRATED_KEY)) return
    } catch {
      return
    }
    const legacy = readLegacyEntries(universeRef.current)
    if (legacy.length === 0) return
    alertPreviewStore.migrationStarted = true
    void alertsApi
      .importMonitors(legacy)
      .then(() => {
        try {
          localStorage.setItem(LEGACY_MIGRATED_KEY, '1')
        } catch {
          // ignore storage quota errors
        }
        return queryClient.invalidateQueries({ queryKey: ['alert-monitors'] })
      })
      .catch(() => {
        alertPreviewStore.migrationStarted = false
      })
  }, [monitorsQuery.isSuccess, monitorsQuery.data, queryClient])

  const enqueue = useCallback(
    (ids: string[]) => {
      const additions = ids.filter((id) => !alertPreviewStore.pendingIds.includes(id))
      if (additions.length === 0) return
      alertPreviewStore.pendingIds = [...alertPreviewStore.pendingIds, ...additions]
      setPendingIds(alertPreviewStore.pendingIds)
    },
    [setPendingIds],
  )

  const startPreview = useCallback(
    async (entry: AlertMonitor, batch = false) => {
      const symbols = previewSymbols(entry, universeRef.current)
      if (symbols.length === 0) return
      const cacheKey = previewKey(entry, symbols)
      if (alertPreviewStore.inflight?.cacheKey === cacheKey && jobRef.current.isActive) return
      if (alertPreviewStore.starting || jobRef.current.isActive || alertPreviewStore.inflight) {
        enqueue([entry.id])
        return
      }

      alertPreviewStore.starting = true
      alertPreviewStore.previewErrors.delete(cacheKey)
      alertPreviewStore.stalePreviews.delete(cacheKey)
      jobRef.current.reset()
      setCacheRev((n) => n + 1)
      try {
        const { job_id } = await alertsApi.preview({
          strategy: entry.strategy,
          symbols,
          params: entry.params,
          monitor_id: entry.id,
        })
        alertPreviewStore.inflight = { cacheKey, entryId: entry.id, jobId: job_id, batch }
        jobRef.current.start(job_id)
      } catch (err) {
        alertPreviewStore.previewErrors.set(cacheKey, errorMessage(err))
      } finally {
        alertPreviewStore.starting = false
        setCacheRev((n) => n + 1)
      }
    },
    [enqueue, setCacheRev],
  )

  useEffect(() => {
    const state = dataJob.state
    if (state?.status !== 'done' || alertPreviewStore.announcedDataJob === state.id) return
    alertPreviewStore.announcedDataJob = state.id
    for (const key of alertPreviewStore.previewCache.keys()) alertPreviewStore.stalePreviews.add(key)
    for (const entry of entriesRef.current) {
      if (entry.last_snapshot) {
        alertPreviewStore.stalePreviews.add(previewKey(entry, previewSymbols(entry, universeRef.current)))
      }
    }
    queueMicrotask(() => setCacheRev((n) => n + 1))
  }, [dataJob.state])

  useEffect(() => {
    const state = job.state
    const tracked = state && alertPreviewStore.inflight?.jobId === state.id ? alertPreviewStore.inflight : null
    if (!tracked) return
    const bump = () => queueMicrotask(() => setCacheRev((n) => n + 1))
    if (job.lost) {
      alertPreviewStore.previewErrors.set(tracked.cacheKey, t('jobs.lost'))
      alertPreviewStore.inflight = null
      bump()
      return
    }
    if (state?.status === 'done' && isAlertSnapshot(state.result)) {
      setCachedPreview(tracked.cacheKey, state.result)
      alertPreviewStore.previewErrors.delete(tracked.cacheKey)
      alertPreviewStore.stalePreviews.delete(tracked.cacheKey)
      alertPreviewStore.inflight = null
      void queryClient.invalidateQueries({ queryKey: ['alert-monitors'] })
      bump()
    } else if (state?.status === 'done' && 'result' in state) {
      alertPreviewStore.previewErrors.set(tracked.cacheKey, t('alerts.previewFailed'))
      alertPreviewStore.inflight = null
      bump()
    } else if (state?.status === 'error' || state?.status === 'cancelled') {
      if (state.status !== 'cancelled') {
        alertPreviewStore.previewErrors.set(tracked.cacheKey, state.error ?? t('alerts.previewFailed'))
      }
      alertPreviewStore.inflight = null
      bump()
    }
  }, [job.state, job.lost, queryClient, t])

  useEffect(() => {
    if (alertPreviewStore.starting || job.isActive || alertPreviewStore.inflight) return
    if (alertPreviewStore.pendingIds.length === 0) {
      if (alertPreviewStore.batchTotal > 0) {
        alertPreviewStore.batchTotal = 0
        queueMicrotask(() => setBatchTotal(0))
      }
      return
    }
    const [nextId, ...rest] = alertPreviewStore.pendingIds
    alertPreviewStore.pendingIds = rest
    queueMicrotask(() => {
      setPendingIds(rest)
      const entry = entriesRef.current.find((e) => e.id === nextId)
      if (entry) void startPreview(entry, alertPreviewStore.batchTotal > 0)
    })
  }, [job.isActive, pendingIds, batchTotal, cacheRev, startPreview])

  const saveMutation = useMutation({
    mutationFn: async (input: {
      editId?: string
      name?: string
      strategy: string
      symbols: string[]
      params: Record<string, unknown>
      notify_enabled: boolean
    }) => {
      const body = {
        name: input.name ?? '',
        strategy: input.strategy,
        symbols: input.symbols,
        params: input.params,
        notify_enabled: input.notify_enabled,
      }
      return input.editId
        ? alertsApi.updateMonitor(input.editId, body)
        : alertsApi.createMonitor(body)
    },
    onSuccess: (saved) => {
      dropPreview(saved.id)
      queryClient.setQueryData<AlertMonitor[]>(['alert-monitors'], (prev = []) => {
        const idx = prev.findIndex((m) => m.id === saved.id)
        if (idx >= 0) {
          const copy = [...prev]
          copy[idx] = saved
          return copy
        }
        return [saved, ...prev]
      })
      setActiveId(saved.id)
      setComposer(null)
      setSaveError(null)
      void startPreview(saved)
    },
    onError: (err: unknown) => {
      setSaveError(errorMessage(err))
    },
  })

  const toggleNotifyMutation = useMutation({
    mutationFn: (entry: AlertMonitor) =>
      alertsApi.updateMonitor(entry.id, {
        name: entry.name,
        strategy: entry.strategy,
        symbols: entry.symbols,
        params: entry.params,
        notify_enabled: !entry.notify_enabled,
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData<AlertMonitor[]>(['alert-monitors'], (prev = []) =>
        prev.map((m) => (m.id === updated.id ? updated : m)),
      )
    },
    onError: (err: unknown) => {
      toast.push({ kind: 'error', title: errorMessage(err) })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => alertsApi.deleteMonitor(id),
    onSuccess: (_res, deletedId) => {
      dropPreview(deletedId)
      if (alertPreviewStore.inflight?.entryId === deletedId) {
        alertPreviewStore.inflight = null
      }
      alertPreviewStore.pendingIds = alertPreviewStore.pendingIds.filter((id) => id !== deletedId)
      setPendingIds(alertPreviewStore.pendingIds)
      queryClient.setQueryData<AlertMonitor[]>(['alert-monitors'], (prev = []) =>
        prev.filter((e) => e.id !== deletedId),
      )
      setActiveId((prev) => (prev === deletedId ? '' : prev))
      setComposer((prev) => (prev?.entryId === deletedId ? null : prev))
      setConfirmDelete(null)
      setCacheRev((n) => n + 1)
    },
    onError: (err: unknown) => {
      toast.push({ kind: 'error', title: errorMessage(err) })
      setConfirmDelete(null)
    },
  })

  let draft = paramDraft
  const composeSeedKey = composer && composeStrategy ? `${composeSeq}:${composeStrategy.key}` : null
  if (composer && composeStrategy && composeSeedKey && seededKey !== composeSeedKey) {
    const initial =
      composer.mode === 'new' || composeStrategy.key !== composer.initialStrategy
        ? rememberedParams(composeStrategy.key)
        : composeInitialParams
    draft = seedParamDraft(composeStrategy, initial)
    setSeededKey(composeSeedKey)
    setParamDraft(draft)
  }

  const parsedParams = composeStrategy
    ? effectiveParams(composeStrategy, draft)
    : { ok: true as const, params: {} as Record<string, unknown>, errors: {} as ParamFieldErrors }
  const strategyBroken = Boolean(composeStrategy?.errors.length)
  const canSave =
    Boolean(composer && strategyKey) &&
    !strategyBroken &&
    parsedParams.ok &&
    draftUniverse.length > 0 &&
    !saveMutation.isPending

  const openCompose = (mode: ComposerState['mode'], entry?: AlertMonitor) => {
    const info = entry ? strategies?.find((s) => s.key === entry.strategy) : undefined
    setComposer({ mode, entryId: mode === 'edit' ? entry?.id : undefined, initialStrategy: entry?.strategy })
    setComposeSeq((n) => n + 1)
    setDraftStrategy(entry?.strategy ?? '')
    setComposeInitialParams(entry?.params ?? {})
    setParamDraft(entry && info ? seedParamDraft(info, entry.params) : {})
    setDraftUniverse(mode === 'new' ? [...universe] : entry ? [...previewSymbols(entry, universe)] : [...universe])
    setSeededKey(null)
    setSaveError(null)
  }

  const onSave = () => {
    if (!composer || !canSave || !parsedParams.ok) return
    const previous = composer.entryId ? entries.find((e) => e.id === composer.entryId) : undefined
    saveMutation.mutate({
      editId: previous?.id,
      name: previous?.name ?? '',
      strategy: strategyKey,
      symbols: [...draftUniverse],
      params: parsedParams.params,
      notify_enabled: previous?.notify_enabled ?? true,
    })
  }

  const onDelete = () => {
    if (!confirmDelete) return
    deleteMutation.mutate(confirmDelete.id)
  }

  const refreshAll = () => {
    const ids = entries
      .filter((e) => previewSymbols(e, universe).length > 0 && alertPreviewStore.inflight?.entryId !== e.id)
      .map((e) => e.id)
    if (ids.length === 0) return
    alertPreviewStore.batchTotal = ids.length
    setBatchTotal(ids.length)
    enqueue(ids)
  }

  const cancelBatch = () => {
    alertPreviewStore.pendingIds = []
    alertPreviewStore.batchTotal = 0
    setPendingIds([])
    setBatchTotal(0)
  }

  const runDataUpdate = async (entry: AlertMonitor) => {
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

  const paramsOf = (entry: AlertMonitor) => {
    const info = strategies?.find((s) => s.key === entry.strategy)
    return lockedParamSummary(info, entry.params)
  }

  const statusOf = (entry: AlertMonitor): 'idle' | 'queued' | 'running' | 'ready' | 'stale' | 'error' => {
    const symbols = previewSymbols(entry, universe)
    const key = previewKey(entry, symbols)
    if (alertPreviewStore.inflight?.cacheKey === key && job.isActive) return 'running'
    if (pendingIds.includes(entry.id)) return 'queued'
    if (cachedError(entry, symbols)) return 'error'
    const snap = cachedPreview(entry, symbols)
    if (!snap) return 'idle'
    return alertPreviewStore.stalePreviews.has(key) ? 'stale' : 'ready'
  }

  const statusBadge = (entry: AlertMonitor) => {
    const status = statusOf(entry)
    const variant =
      status === 'ready'
        ? 'badge-success'
        : status === 'error'
          ? 'badge-danger'
          : status === 'stale'
            ? 'badge-warning'
            : status === 'running'
              ? 'badge-accent'
              : 'badge-neutral'
    return <span className={`badge ${variant}`}>{t(`alerts.status.${status}`)}</span>
  }

  const signalSummary = (entry: AlertMonitor) => {
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

  const rowActions = (entry: AlertMonitor) => (
    <div className="alert-row-actions">
      <button
        type="button"
        className={`btn btn-sm btn-ghost btn-icon ${entry.notify_enabled ? 'alert-notify-on' : 'alert-notify-off'}`}
        title={entry.notify_enabled ? t('alerts.notifyIncluded') : t('alerts.notifyMuted')}
        aria-label={entry.notify_enabled ? t('alerts.notifyIncluded') : t('alerts.notifyMuted')}
        aria-pressed={entry.notify_enabled}
        disabled={toggleNotifyMutation.isPending}
        onClick={(e) => {
          e.stopPropagation()
          toggleNotifyMutation.mutate(entry)
        }}
      >
        <Icon name={entry.notify_enabled ? 'bell' : 'bell-off'} size={14} />
      </button>
      <button
        type="button"
        className="btn btn-sm btn-ghost btn-icon"
        title={t('alerts.updateData')}
        aria-label={t('alerts.updateData')}
        disabled={dataStarting || dataJob.isActive || previewSymbols(entry, universe).length === 0}
        onClick={(e) => {
          e.stopPropagation()
          void runDataUpdate(entry)
        }}
      >
        <Icon name="download" size={14} />
      </button>
      <button
        type="button"
        className="btn btn-sm btn-ghost btn-icon"
        title={t('alerts.refresh')}
        aria-label={t('alerts.refresh')}
        onClick={(e) => {
          e.stopPropagation()
          void startPreview(entry)
        }}
      >
        <Icon name="refresh" size={14} />
      </button>
      <button
        type="button"
        className="btn btn-sm btn-ghost btn-icon"
        title={t('alerts.edit')}
        aria-label={t('alerts.edit')}
        onClick={(e) => {
          e.stopPropagation()
          openCompose('edit', entry)
        }}
      >
        <Icon name="pencil" size={14} />
      </button>
      <button
        type="button"
        className="btn btn-sm btn-ghost btn-icon"
        title={t('alerts.copy')}
        aria-label={t('alerts.copy')}
        onClick={(e) => {
          e.stopPropagation()
          openCompose('copy', entry)
        }}
      >
        <Icon name="copy" size={14} />
      </button>
      <button
        type="button"
        className="btn btn-sm btn-danger btn-icon"
        title={t('common.delete')}
        aria-label={t('common.delete')}
        onClick={(e) => {
          e.stopPropagation()
          setConfirmDelete(entry)
        }}
      >
        <Icon name="trash" size={14} />
      </button>
    </div>
  )

  const entryColumns: Column<AlertMonitor>[] = [
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
      key: 'holding',
      header: t('alerts.holding'),
      render: (r) => {
        const h: AlertHolding = r.holding ?? 'flat'
        return <span className={`alert-holding holding-${h}`}>{t(`alerts.holdings.${h}`)}</span>
      },
    },
    {
      key: 'operation',
      header: t('alerts.operation'),
      render: (r) => (
        <span className={ACTIONABLE.has(r.operation) ? `alert-operation op-${r.operation}` : 'alert-operation'}>
          {t(`alerts.operations.${r.operation}`)}
        </span>
      ),
    },
    { key: 'price_ref', header: t('alerts.priceRef'), numeric: true, render: formatPriceRef },
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

  const renderExpanded = (entry: AlertMonitor) => {
    const symbols = previewSymbols(entry, universe)
    const key = previewKey(entry, symbols)
    const snap = cachedPreview(entry, symbols)
    const error = cachedError(entry, symbols)
    const running = alertPreviewStore.inflight?.cacheKey === key && job.state
    return (
      <div className="alert-expand">
        <div className="alert-expand-bar">
          <span className="alert-params-summary" title={paramsOf(entry)}>
            {paramsOf(entry) || t('alerts.defaultParams')}
          </span>
          <div className="spacer" />
          {snap?.asof && <span className="field-hint">{t('alerts.asof', { date: snap.asof })}</span>}
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={symbols.length === 0}
            onClick={() => void startPreview(entry)}
          >
            <Icon name="refresh" size={13} />
            {snap ? t('alerts.refresh') : t('alerts.computeNow')}
          </button>
        </div>
        {running && (
          <JobProgress state={job.state!} logs={job.logs} onCancel={job.cancel} streaming={job.streaming} lost={job.lost} />
        )}
        {pendingIds.includes(entry.id) && !running && <div className="hint-banner">{t('alerts.queuedHint')}</div>}
        {error && (
          <div className="hint-banner warning">
            <strong>{t('alerts.previewFailed')}</strong> — {error}
          </div>
        )}
        {snap?.blown_up && (
          <div className="hint-banner danger">
            <strong>{t('backtest.blownUp')}</strong> — {t('alerts.blownUpHint')}
          </div>
        )}
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
  const batchRunning = batchTotal > 0 && (pendingIds.length > 0 || Boolean(alertPreviewStore.inflight?.batch))
  const batchDone = Math.max(0, batchTotal - pendingIds.length - (alertPreviewStore.inflight?.batch ? 1 : 0))

  return (
    <div className="alerts-panel">
      <div className="toolbar alerts-toolbar">
        <button
          type="button"
          className={`btn btn-sm ${composer?.mode === 'new' ? 'btn-primary' : ''}`}
          onClick={() => (composer?.mode === 'new' ? setComposer(null) : openCompose('new'))}
        >
          <Icon name="plus" size={14} />
          {t('alerts.add')}
        </button>
        <button
          type="button"
          className={`btn btn-sm ${pendingOnly ? 'btn-primary' : ''}`}
          aria-pressed={pendingOnly}
          onClick={() => setPendingOnly((v) => !v)}
        >
          {t('alerts.pendingOnly')}
        </button>
        <div className="spacer" />
        {batchRunning && (
          <span className="alert-batch-progress">{t('alerts.batchProgress', { done: batchDone, total: batchTotal })}</span>
        )}
        {pendingIds.length > 0 && batchTotal > 0 && (
          <button type="button" className="btn btn-sm" onClick={cancelBatch}>
            {t('alerts.cancelQueue')}
          </button>
        )}
        <button type="button" className="btn btn-sm" disabled={entries.length === 0} onClick={refreshAll}>
          <Icon name="refresh" size={13} />
          {t('alerts.refreshAll')}
        </button>
      </div>

      {updateError && (
        <div className="hint-banner warning">
          {t('common.updateFailed')} — {updateError}
        </div>
      )}

      {composer && (
        <Card title={t(`alerts.${composer.mode}Title`)} className="alert-composer">
          <div className="field">
            <label htmlFor="alert-composer-strategy">{t('common.strategy')}</label>
            <select id="alert-composer-strategy" value={strategyKey} onChange={(e) => setDraftStrategy(e.target.value)}>
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
          <UniverseStrip
            value={draftUniverse}
            liveUniverse={universe}
            onChange={setDraftUniverse}
            onManage={() => setSidebarOpen(true)}
          />
          {saveError && <p className="field-error">{saveError}</p>}
          <div className="toolbar alert-composer-actions">
            <button type="button" className="btn btn-primary" onClick={onSave} disabled={!canSave}>
              {t('alerts.saveAndCompute')}
            </button>
            <button type="button" className="btn" onClick={() => setComposer(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </Card>
      )}

      {!composer && entries.length === 0 && (
        <div className="empty-state">
          <span className="empty-state-icon">
            <Icon name="alert" size={18} />
          </span>
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
