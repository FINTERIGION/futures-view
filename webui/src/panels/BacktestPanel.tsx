import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../api/client'
import { backtestApi, runsApi, strategiesApi } from '../api/endpoints'
import type { RunDetail } from '../api/types'
import { effectiveParams, seedParamDraft, type ParamFieldErrors } from '../chart/indicatorParams'
import { Icon } from '../components/Icon'
import { JobProgress } from '../components/JobProgress'
import { useToast } from '../components/toastStore'
import { useStickyState } from '../hooks/useStickyState'
import { useJobLifecycle, useJobs } from '../shell/jobsStore'
import { useHotkeys } from '../shell/useHotkeys'
import { useWorkspace } from '../shell/workspaceStore'
import { BacktestForm } from './BacktestForm'
import { ResultTables } from './ResultTables'
import { sharedFormDefaults } from './sharedFormDefaults'

type StrategyParamMap = Record<string, Record<string, unknown>>

function asParamMap(value: unknown): StrategyParamMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as StrategyParamMap
}

function mergedStrategyParams(prefill?: BacktestFieldsPrefill): StrategyParamMap | undefined {
  if (!prefill?.strategy || prefill.params === undefined) return undefined
  let stored: StrategyParamMap = {}
  try {
    const raw = localStorage.getItem('ft.strategyParams')
    if (raw) stored = asParamMap(JSON.parse(raw))
  } catch {
    stored = {}
  }
  return { ...stored, [prefill.strategy]: prefill.params }
}

export interface BacktestFieldsPrefill {
  strategy?: string
  start?: string
  end?: string
  cash?: number
  slippage?: number
  params?: Record<string, unknown>
}

export function BacktestPanel({ prefill }: { prefill?: BacktestFieldsPrefill }) {
  const { t } = useTranslation()
  const jobs = useJobs()
  const job = jobs.backtest
  const lifecycle = useJobLifecycle()
  const queryClient = useQueryClient()
  const toast = useToast()
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const { universe, toggleUniverse, setSidebarOpen, runId, setRunId, prefillAlert } = useWorkspace()

  const [initialPrefill] = useState<BacktestFieldsPrefill | undefined>(prefill)

  const { data: strategies } = useQuery({ queryKey: ['strategies'], queryFn: strategiesApi.list })

  const reloadStrategies = useMutation({
    mutationFn: strategiesApi.reload,
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['strategies'] })
      toast.push({ kind: 'success', title: t('backtest.reloadedStrategies', { count: data.strategies.length }) })
    },
    onError: (err) => {
      toast.push({ kind: 'error', title: t('backtest.reloadStrategiesFailed'), message: errorMessage(err) })
    },
  })

  const [strategyKey, setStrategyKey] = useStickyState('strategy', sharedFormDefaults.strategy, initialPrefill?.strategy)
  const [start, setStart] = useStickyState('start', sharedFormDefaults.start, initialPrefill?.start)
  const [end, setEnd] = useStickyState('end', sharedFormDefaults.end, initialPrefill?.end)
  const [cash, setCash] = useStickyState('cash', sharedFormDefaults.cash, initialPrefill?.cash)
  const [slippage, setSlippage] = useStickyState('slippage', sharedFormDefaults.slippage, initialPrefill?.slippage)
  const [prefilledParams] = useState(() => mergedStrategyParams(initialPrefill))
  const [strategyParams, setStrategyParams] = useStickyState<StrategyParamMap>('strategyParams', {}, prefilledParams)
  const paramMap = asParamMap(strategyParams)

  const [paramDraft, setParamDraft] = useState<Record<string, string>>({})
  const [seededKey, setSeededKey] = useState<string | null>(null)

  const slippageValid = typeof slippage === 'number' && Number.isFinite(slippage) && slippage >= 0
  const cashValid = typeof cash === 'number' && Number.isFinite(cash) && cash > 0
  const windowValid = start !== '' && end !== '' && start <= end

  useEffect(() => {
    const firstRunnable = strategies?.find((s) => s.errors.length === 0)
    const missing = strategies !== undefined && !strategies.some((s) => s.key === strategyKey)
    if (firstRunnable && (!strategyKey || missing)) {
      setStrategyKey(firstRunnable.key)
    }
  }, [strategies, strategyKey, setStrategyKey])

  const strategyBroken = Boolean(strategies?.find((s) => s.key === strategyKey)?.errors.length)
  const strategy = strategies?.find((s) => s.key === strategyKey)

  let draft = paramDraft
  if (strategy && seededKey !== strategy.key) {
    draft = seedParamDraft(strategy, paramMap[strategy.key])
    setSeededKey(strategy.key)
    setParamDraft(draft)
  }

  const parsedParams = strategy
    ? effectiveParams(strategy, draft)
    : { ok: true as const, params: {} as Record<string, unknown>, errors: {} as ParamFieldErrors }

  const onParamDraftChange = (name: string, raw: string) => {
    if (!strategy) return
    const next = { ...draft, [name]: raw }
    setParamDraft(next)
    const parsed = effectiveParams(strategy, next)
    if (parsed.ok) setStrategyParams({ ...paramMap, [strategy.key]: parsed.params })
  }

  const onResetParams = () => {
    if (!strategy) return
    const next = seedParamDraft(strategy, {})
    setParamDraft(next)
    const parsed = effectiveParams(strategy, next)
    if (parsed.ok) setStrategyParams({ ...paramMap, [strategy.key]: parsed.params })
  }

  useEffect(() => {
    const state = job.state
    if (!state || !['done', 'error'].includes(state.status)) return
    if (lifecycle.claimAnnouncement(`backtest:${state.id}`)) {
      if (state.status === 'done') void queryClient.invalidateQueries({ queryKey: ['runs'] })
      if (state.status === 'error') {
        toast.push({ kind: 'error', title: t('backtest.runFailed'), message: state.error ?? undefined })
      } else {
        toast.push({ kind: 'success', title: t('backtest.runFinished') })
      }
    }
    if (state.status === 'done') {
      const fallbackRunId = (state.result as { run_id?: string } | undefined)?.run_id ?? null
      const overlayRunId = lifecycle.claimBacktestOverlay(fallbackRunId)
      if (overlayRunId) setRunId(overlayRunId)
    }
  }, [job.state, lifecycle, queryClient, setRunId, toast, t])

  const anyJobActive =
    jobs.backtest.isActive || jobs.data.isActive || jobs.alert.isActive || jobs.dispatch.isActive

  const canRun =
    !submitting &&
    !job.isActive &&
    Boolean(strategyKey) &&
    !strategyBroken &&
    universe.length > 0 &&
    slippageValid &&
    cashValid &&
    windowValid &&
    parsedParams.ok

  const canSendToAlert = Boolean(strategyKey) && !strategyBroken && universe.length > 0 && parsedParams.ok

  const runBlockReason =
    submitting || job.isActive
      ? t('jobs.running')
      : !strategies
        ? t('common.loading')
        : !strategyKey || strategyBroken
          ? t('backtest.noRunnableStrategy')
          : universe.length === 0
            ? t('workspace.noProducts')
            : !slippageValid
              ? t('common.slippageNegative')
              : !cashValid
                ? t('common.cashNotPositive')
                : !windowValid
                  ? t('common.windowInverted')
                  : !parsedParams.ok
                    ? t('backtest.fixParams')
                    : null

  const runBacktest = async () => {
    if (!parsedParams.ok || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const { job_id, run_id } = await backtestApi.start({
        strategy: strategyKey,
        symbols: universe,
        start,
        end,
        cash,
        slippage,
        params: parsedParams.params,
      })
      lifecycle.trackBacktestRun(run_id)
      job.start(job_id)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  useHotkeys({
    'mod+enter': () => {
      if (canRun) void runBacktest()
    },
  })

  const jobMetrics = (job.state?.result as { metrics?: Record<string, unknown> } | undefined)?.metrics
  const jobBlownUp = Boolean(jobMetrics?.blown_up)

  const { data: run } = useQuery<RunDetail>({
    queryKey: ['run', runId],
    queryFn: () => runsApi.get(runId as string),
    enabled: runId !== null,
    staleTime: 5 * 60 * 1000,
  })

  return (
    <div className="panel-split">
      <div className="panel-rail">
        <div className="panel-rail-scroll">
          <BacktestForm
            strategies={strategies ?? []}
            strategyKey={strategyKey}
            onStrategyChange={setStrategyKey}
            onReloadStrategies={() => reloadStrategies.mutate()}
            reloadingStrategies={reloadStrategies.isPending}
            canReloadStrategies={!anyJobActive}
            paramDraft={draft}
            onParamDraftChange={onParamDraftChange}
            onResetParams={onResetParams}
            paramErrors={parsedParams.errors}
            universe={universe}
            onToggleUniverse={toggleUniverse}
            onManageUniverse={() => setSidebarOpen(true)}
            start={start}
            onStartChange={setStart}
            end={end}
            onEndChange={setEnd}
            cash={cash}
            onCashChange={setCash}
            slippage={slippage}
            onSlippageChange={setSlippage}
            slippageValid={slippageValid}
            cashValid={cashValid}
            windowValid={windowValid}
          />

          {error && <div className="hint-banner warning">{error}</div>}
          {!slippageValid && <div className="hint-banner warning">{t('common.slippageNegative')}</div>}
          {!cashValid && <div className="hint-banner warning">{t('common.cashNotPositive')}</div>}
          {!windowValid && <div className="hint-banner warning">{t('common.windowInverted')}</div>}

          {job.state && (
            <div className="job-progress-block">
              <JobProgress
                state={job.state}
                logs={job.logs}
                onCancel={job.cancel}
                streaming={job.streaming}
                blownUp={jobBlownUp}
                lost={job.lost}
              />
            </div>
          )}
        </div>

        <div className="backtest-run-dock">
          <div className="backtest-run-summary">
            <span>{t('backtest.runSummary', { count: universe.length })}</span>
            <span className="num">
              {start || '—'} → {end || '—'}
            </span>
          </div>
          <div className="backtest-run-actions">
            <button
              type="button"
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={() => void runBacktest()}
              disabled={!canRun}
              title={runBlockReason ?? t('backtest.runBacktestHint')}
            >
              {job.isActive ? <span className="spinner" /> : <Icon name="line-chart" size={14} />}
              {t('backtest.runBacktest')}
            </button>
            <button
              type="button"
              className="btn btn-icon"
              disabled={!canSendToAlert}
              title={t('backtest.saveToAlerts')}
              aria-label={t('backtest.saveToAlerts')}
              onClick={() => {
                if (!parsedParams.ok) return
                prefillAlert({
                  strategy: strategyKey,
                  symbols: [...universe],
                  params: parsedParams.params,
                })
              }}
            >
              <Icon name="bell" size={14} />
            </button>
          </div>
          {!canRun && runBlockReason && slippageValid && cashValid && windowValid && (
            <p className="run-block-reason">{runBlockReason}</p>
          )}
        </div>
      </div>

      <div className="panel-main">
        {run ? (
          <ResultTables run={run} />
        ) : (
          <div className="empty-state">
            <span className="empty-state-icon">
              <Icon name="line-chart" size={18} />
            </span>
            <span className="empty-state-title">{t('backtest.noRunYet')}</span>
            <p className="empty-state-hint">{t('backtest.noRunYetHint')}</p>
          </div>
        )}
      </div>
    </div>
  )
}
