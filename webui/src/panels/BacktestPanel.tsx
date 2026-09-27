import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../api/client'
import { backtestApi, runsApi, strategiesApi } from '../api/endpoints'
import type { RunDetail } from '../api/types'
import { Icon } from '../components/Icon'
import { JobProgress } from '../components/JobProgress'
import { useToast } from '../components/Toast'
import { effectiveParams, seedParamDraft, type ParamFieldErrors } from '../chart/indicatorParams'
import { useJobSlot } from '../shell/JobsProvider'
import { useHotkeys } from '../shell/useHotkeys'
import { useStickyState } from '../hooks/useStickyState'
import { useWorkspace } from '../shell/WorkspaceContext'
import { BacktestForm } from './BacktestForm'
import { ResultTables } from './ResultTables'
import { sharedFormDefaults } from './sharedFormDefaults'

type StrategyParamMap = Record<string, Record<string, unknown>>

function asParamMap(value: unknown): StrategyParamMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as StrategyParamMap
}

/** Prefill replaces one strategy's bag and keeps every other strategy's.
 * Reading storage here, rather than letting `useStickyState`'s override
 * replace the whole map, is what stops opening a double-ma run from
 * forgetting the parameters remembered for another strategy. */
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

/** What this panel itself reads out of a prefill -- deliberately narrower
 * than `WorkspaceContext.BacktestPrefill`, which also carries `symbols`: the
 * universe is a shell-level concern (`prefillBacktest` sets `chartSymbol` /
 * `extraSymbols` directly), not something this panel seeds. Every field is
 * optional because a prefill applies whatever it names and leaves the rest
 * at their sticky values -- a prefill carrying only a strategy and symbols,
 * for instance, has no cash/slippage to name. */
export interface BacktestFieldsPrefill {
  strategy?: string
  start?: string
  end?: string
  cash?: number
  slippage?: number
  /** Effective parameter values from the run being reopened. `{}` means that
   * run used the class defaults, and replaces whatever this strategy had
   * remembered. Omitted leaves the remembered values alone. */
  params?: Record<string, unknown>
}

/**
 * The drawer's Backtest tab. Ported from the old `BacktestPage` essentially
 * unchanged: the sticky-state fields and the one-shot `useState(() =>
 * prefill)` read are the same load-bearing behavior -- only the prefill's
 * source changed, from `useLocation().state` to a prop the shell remounts
 * this component on (`key={seq}` at the call site, see BottomDrawer.tsx).
 * The universe is no longer picked here: it comes from
 * `WorkspaceContext.universe`, the same list the sidebar's checkboxes edit.
 *
 * Each strategy's parameters live in `ft.strategyParams`, one bag per key.
 * A run sends the effective values (defaults overlaid with what the form
 * shows). Opening a past run replaces that strategy's bag with the values
 * the run stored, which is why this panel is remounted on a prefill.
 */
export function BacktestPanel({ prefill }: { prefill?: BacktestFieldsPrefill }) {
  const { t } = useTranslation()
  const job = useJobSlot('backtest')
  const queryClient = useQueryClient()
  const toast = useToast()
  const [error, setError] = useState<string | null>(null)
  const { universe, runId, setRunId } = useWorkspace()

  // Read once, the way BacktestPage's router-state prefill was: applying it
  // in an effect instead left one render where the form still showed the
  // *stored* value while it was already meant to show the prefilled one, and
  // an effect keyed on the field then fired on a change that was never a
  // user edit. This component is remounted (`key={seq}`) whenever a new
  // prefill arrives, so "once, in the initializer" is still correct.
  const [initialPrefill] = useState<BacktestFieldsPrefill | undefined>(prefill)

  const { data: strategies } = useQuery({ queryKey: ['strategies'], queryFn: strategiesApi.list })

  // Re-imports strategies/ on the server so an edited file shows up without a
  // restart. Broken modules need no separate report here: the refetched
  // catalog lists them disabled with their error, below the dropdown.
  const reloadStrategies = useMutation({
    mutationFn: strategiesApi.reload,
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['strategies'] })
      toast.push({ kind: 'success', title: t('backtest.reloadedStrategies', { count: data.strategies.length }) })
    },
    // Mostly the server's 409: it refuses while any job is running, since
    // swapping a class object mid-run would pull it out from under the job.
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

  // Slippage is a cost and cannot be negative -- a negative one fills every
  // trade better than the market and inflates the whole run. Cash has to be
  // a finite amount the account can actually start with. The window has to
  // name both ends, in order. The API rejects each of these too
  // (web/schemas.py); blocking them here is so the user is told before they
  // wait for a job.
  const slippageValid = slippage >= 0
  const cashValid = Number.isFinite(cash) && cash > 0
  const windowValid = start !== '' && end !== '' && start <= end

  // Also covers a pick that is no longer in the catalog -- a class renamed or
  // deleted and then reloaded. Left alone, the select would show the first
  // option while the run sent the stale key and failed on the server.
  useEffect(() => {
    const firstRunnable = strategies?.find((s) => s.errors.length === 0)
    const missing = strategies !== undefined && !strategies.some((s) => s.key === strategyKey)
    if (firstRunnable && (!strategyKey || missing)) {
      setStrategyKey(firstRunnable.key)
    }
  }, [strategies, strategyKey, setStrategyKey])

  // The remembered pick can be a strategy whose file has since broken; the
  // form lists it disabled with its error, and there is nothing to run.
  const strategyBroken = Boolean(strategies?.find((s) => s.key === strategyKey)?.errors.length)
  const strategy = strategies?.find((s) => s.key === strategyKey)

  // The draft is per strategy. Switching (or the catalog arriving) reseeds
  // from that strategy's bag before paint, so a frame of empty fields cannot
  // flash a "required" error or enable a run against values the user cannot
  // see. A prefill remounts this panel, so the bag it wrote is what the
  // first seed reads. Later edits must not reseed: that would put back the
  // value just typed and wipe a field that does not parse yet.
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

  // Same write as an edit: the class defaults go into this strategy's bag,
  // so switching away and back reseeds from them instead of the values just
  // cleared. The class's own `params` are not touched.
  const onResetParams = () => {
    if (!strategy) return
    const next = seedParamDraft(strategy, {})
    setParamDraft(next)
    const parsed = effectiveParams(strategy, next)
    if (parsed.ok) setStrategyParams({ ...paramMap, [strategy.key]: parsed.params })
  }

  // The run whose outcome has already been announced. A toast is not
  // idempotent the way `invalidateQueries` is, and this effect re-runs on
  // every render while the status sits terminal.
  const announcedJob = useRef<string | null>(null)

  useEffect(() => {
    const state = job.state
    if (!state || !['done', 'error'].includes(state.status)) return
    if (state.status === 'done') void queryClient.invalidateQueries({ queryKey: ['runs'] })
    if (announcedJob.current === state.id) return
    announcedJob.current = state.id
    // Said out here as well as in the progress block below, because a run
    // takes long enough that the drawer is often collapsed or on the History
    // tab by the time it lands.
    if (state.status === 'error') {
      toast.push({ kind: 'error', title: t('backtest.runFailed'), message: state.error ?? undefined })
    } else {
      toast.push({ kind: 'success', title: t('backtest.runFinished') })
    }
  }, [job.state, queryClient, toast, t])

  const canRun =
    !job.isActive &&
    Boolean(strategyKey) &&
    !strategyBroken &&
    universe.length > 0 &&
    slippageValid &&
    cashValid &&
    windowValid &&
    parsedParams.ok

  const runBacktest = async () => {
    if (!parsedParams.ok) return
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
      job.start(job_id)
      // A fresh run gets its own overlay even if the server hands back an id
      // this panel has charted before.
      overlaidRunId.current = null
      setLastRunId(run_id)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  // Ctrl/⌘+Enter launches the run from anywhere in the workspace -- the form
  // is a handful of remembered fields that rarely change between runs, so the
  // common case is "open the drawer, press it again".
  useHotkeys({
    'mod+enter': () => {
      if (canRun) void runBacktest()
    },
  })

  const [lastRunId, setLastRunId] = useState<string | null>(null)
  /** The run this panel has already put on the chart. Each finished run is
   * overlaid once, by id, rather than re-applied on every render the effect
   * below happens to re-run on: `setRunId` is rebuilt on every URL change
   * (react-router rebuilds `setSearchParams` from the current
   * `searchParams`), so depending on it alone re-fires the effect on
   * navigation that has nothing to do with this run -- including the URL
   * change made by the toolbar's own "exit backtest", which is how that
   * button came to undo itself. */
  const overlaidRunId = useRef<string | null>(null)

  // The job result carries this run's metrics, and `blown_up` among them.
  const jobMetrics = (job.state?.result as { metrics?: Record<string, unknown> } | undefined)?.metrics
  const jobBlownUp = Boolean(jobMetrics?.blown_up)

  // A finished run overlays the chart automatically -- see the effect below --
  // so once the job is done, the chart's own `runId` is what this panel's
  // result table follows too, not a separate "last run I started" id. That
  // keeps a run reopened from the History tab and a run just launched here
  // showing through the exact same path.
  useEffect(() => {
    if (job.state?.status !== 'done' || !lastRunId) return
    if (overlaidRunId.current === lastRunId) return
    overlaidRunId.current = lastRunId
    setRunId(lastRunId)
  }, [job.state?.status, lastRunId, setRunId])

  const { data: run } = useQuery<RunDetail>({
    queryKey: ['run', runId],
    queryFn: () => runsApi.get(runId as string),
    enabled: runId !== null,
  })

  return (
    <div className="panel-split">
      <div className="panel-rail">
        <BacktestForm
          strategies={strategies ?? []}
          strategyKey={strategyKey}
          onStrategyChange={setStrategyKey}
          onReloadStrategies={() => reloadStrategies.mutate()}
          reloadingStrategies={reloadStrategies.isPending}
          canReloadStrategies={!job.isActive}
          paramDraft={draft}
          onParamDraftChange={onParamDraftChange}
          onResetParams={onResetParams}
          paramErrors={parsedParams.errors}
          universe={universe}
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

        <button
          className="btn btn-primary btn-block"
          onClick={() => void runBacktest()}
          disabled={!canRun}
          style={{ marginTop: 8 }}
          title={t('backtest.runBacktestHint')}
        >
          {job.isActive ? <span className="spinner" /> : <Icon name="line-chart" size={14} />}
          {t('backtest.runBacktest')}
        </button>

        {job.state && (
          <div style={{ marginTop: 16 }}>
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

      <div className="panel-main">
        {run ? (
          <ResultTables run={run} />
        ) : (
          // The results half is the larger of the two columns and sat blank
          // until a run landed, which read as something failing to load rather
          // than as nothing having been asked for yet.
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
