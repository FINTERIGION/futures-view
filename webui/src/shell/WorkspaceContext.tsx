import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useStickyState } from '../hooks/useStickyState'

export type DrawerTab = 'backtest' | 'runs'
const DRAWER_TABS: DrawerTab[] = ['backtest', 'runs']

export interface BacktestPrefill {
  strategy: string
  /** Sets the charted product to `symbols[0]` and the rest of the universe
   * to whatever follows -- replacing the universe outright, not merging
   * into it, so a prefill from a 2-symbol run doesn't leave a 4-symbol
   * universe's other two still checked in. Omitted (not just empty) leaves
   * the charted product and universe alone, for a prefill that has no
   * symbols of its own to name. */
  symbols?: string[]
  start: string
  end: string
  cash: number
  slippage: number
  /** Effective parameter values stored with the run. `{}` is a run that used
   * the strategy's defaults. The backtest form replaces that strategy's
   * remembered parameters with these. */
  params: Record<string, unknown>
}

interface Sequenced<T> {
  seq: number
  value: T
}

interface WorkspaceState {
  /** The product the main chart draws -- structurally always the first
   * member of `universe`, so it can never be unchecked out of a backtest. */
  chartSymbol: string
  setChartSymbol: (symbol: string) => void

  /** Products checked into the backtest universe in addition to the charted
   * one. Never contains `chartSymbol` itself -- see `universe`. */
  extraSymbols: string[]
  /** Check or uncheck a symbol into the universe. A no-op on the charted
   * symbol, which is always in; the UI additionally renders that row's
   * checkbox as checked-and-disabled so the rule is visible, not just
   * enforced. */
  toggleUniverse: (symbol: string) => void
  setExtraSymbols: (symbols: string[]) => void
  /** `[chartSymbol, ...extraSymbols]`, de-duplicated -- the only place this
   * union is computed, so a backtest run and the sidebar's checkboxes can
   * never disagree about who is in it. */
  universe: string[]

  /** The backtest run currently overlaid on the chart. URL-only
   * (no sticky fallback): a run id a week old is more likely to 404 (see
   * `RUN_RETENTION`) than to still be the one worth reopening, and a stale
   * overlay silently reappearing on a reload would be worse than an empty
   * chart. */
  runId: string | null
  setRunId: (id: string | null) => void

  drawerTab: DrawerTab
  setDrawerTab: (tab: DrawerTab) => void
  drawerCollapsed: boolean
  setDrawerCollapsed: (v: boolean) => void
  drawerHeight: number
  setDrawerHeight: (h: number) => void

  sidebarOpen: boolean
  setSidebarOpen: (v: boolean) => void

  /** Whether the volume sub-pane is drawn under the candles.
   *
   * A plain flag rather than a member of some `panes` list: volume is the
   * only built-in sub-pane left (equity/position/drawdown moved to the
   * backtest panel), and every other pane on the chart is derived from
   * `indicators`. It is ticked from the same picker those are -- see
   * `chart/IndicatorPicker.tsx` -- but kept out of `indicators` itself so a
   * user who writes their own `indicators/volume.py` does not collide with
   * it. */
  showVolume: boolean
  setShowVolume: (v: boolean) => void

  /** Keys of the indicators drawn on the chart, in display order.
   *
   * Only the *selection* is stored, never the derived `ind:` pane keys.
   * Whether an indicator draws over the candles or in its own pane is a
   * property of the Python class, which the user can edit and hot-reload --
   * persisting that here would be a second source of truth that goes stale
   * the moment they flip `pane`. `SuperChart` derives the panes from the
   * live catalog instead.
   *
   * Sticky rather than URL-borne: which indicators you like is a preference,
   * not a fact about the chart worth putting in a shared link. */
  indicators: string[]
  toggleIndicator: (key: string) => void

  /** Param overrides per indicator, `{indicator key: {param: value}}`.
   *
   * Only values that differ from the class's defaults are stored, so a
   * default the author later changes in Python still reaches every param
   * the user never touched. Sticky for the same reason `indicators` is: a
   * preferred period is a preference. Read it through
   * `chart/indicatorParams.ts`'s `activeOverrides`, which drops params the
   * class no longer declares. */
  indicatorParams: Record<string, Record<string, unknown>>
  /** Replace one indicator's overrides; `{}` puts it back on its defaults. */
  setIndicatorParams: (key: string, overrides: Record<string, unknown>) => void

  /** The product open in the sidebar's detail (create/edit) view; `'new'`
   * for the create form. `null` means the list view is showing. */
  editingProduct: string | 'new' | null
  setEditingProduct: (code: string | 'new' | null) => void

  /** "Send to Backtest", now that it lives as a tab in the drawer instead of
   * a separate routed page. Bumping `seq` remounts the receiving panel
   * (`key={seq}`), so its own read-once prefill initializer -- the pattern
   * BacktestPanel's params-owner logic depends on -- reruns exactly as it
   * did when the prefill arrived via router state. */
  backtestPrefill: Sequenced<BacktestPrefill> | null
  /** `runId`, when given, overlays that run in the same URL update as the
   * prefill -- see the implementation's comment on why this can't be a
   * separate `setRunId` call. */
  prefillBacktest: (value: BacktestPrefill, runId?: string) => void
}

const WorkspaceContext = createContext<WorkspaceState | null>(null)

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [searchParams, setSearchParams] = useSearchParams()

  const [stickyChartSymbol, setStickyChartSymbol] = useStickyState('chartSymbol', '')
  const chartSymbol = searchParams.get('symbol') ?? stickyChartSymbol

  const [extraSymbolsRaw, setExtraSymbolsRaw] = useStickyState<string[]>('extraSymbols', [])
  const extraSymbols = extraSymbolsRaw.filter((s) => s !== chartSymbol)
  const universe = [chartSymbol, ...extraSymbols].filter(Boolean)

  const [stickyDrawerTab, setStickyDrawerTab] = useStickyState<DrawerTab>('drawerTab', 'backtest')
  const tabParam = searchParams.get('tab')
  const drawerTab = (tabParam && DRAWER_TABS.includes(tabParam as DrawerTab) ? (tabParam as DrawerTab) : stickyDrawerTab)

  const [drawerCollapsed, setDrawerCollapsed] = useStickyState('drawerCollapsed', false)
  const [drawerHeight, setDrawerHeight] = useStickyState('drawerHeight', 360)
  const [sidebarOpen, setSidebarOpen] = useStickyState('sidebarOpen', true)
  const [showVolume, setShowVolume] = useStickyState('showVolume', true)
  const [indicators, setIndicators] = useStickyState<string[]>('indicators', [])
  const [indicatorParamsRaw, setIndicatorParamsRaw] = useStickyState<Record<string, Record<string, unknown>>>(
    'indicatorParams',
    {},
  )
  // Storage holds whatever an older build or a hand edit left there. Anything
  // but an object is treated as "no overrides" rather than crashing the chart.
  const indicatorParams = useMemo(
    () =>
      indicatorParamsRaw && typeof indicatorParamsRaw === 'object' && !Array.isArray(indicatorParamsRaw)
        ? indicatorParamsRaw
        : {},
    [indicatorParamsRaw],
  )
  const [editingProduct, setEditingProduct] = useState<string | 'new' | null>(null)

  const toggleIndicator = useCallback(
    (key: string) => {
      setIndicators(indicators.includes(key) ? indicators.filter((k) => k !== key) : [...indicators, key])
    },
    [indicators, setIndicators],
  )

  const setIndicatorParams = useCallback(
    (key: string, overrides: Record<string, unknown>) => {
      const next = { ...indicatorParams }
      if (Object.keys(overrides).length > 0) next[key] = overrides
      else delete next[key]
      setIndicatorParamsRaw(next)
    },
    [indicatorParams, setIndicatorParamsRaw],
  )

  const runId = searchParams.get('run')

  // Seed the URL from whatever a past session remembered, once, so a link
  // copied on first paint already names the chart and tab it shows -- the
  // sticky values otherwise never make it into the address bar at all.
  useEffect(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (!next.get('symbol') && stickyChartSymbol) next.set('symbol', stickyChartSymbol)
        if (!next.get('tab')) next.set('tab', stickyDrawerTab)
        return next
      },
      { replace: true },
    )
    // Runs once, at mount, deliberately -- this is a one-time seed of the
    // address bar, not a sync that should re-fire on every sticky change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setChartSymbol = useCallback(
    (symbol: string) => {
      setStickyChartSymbol(symbol)
      setExtraSymbolsRaw(extraSymbolsRaw.filter((s) => s !== symbol))
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (symbol) next.set('symbol', symbol)
          else next.delete('symbol')
          return next
        },
        { replace: true },
      )
    },
    [setStickyChartSymbol, extraSymbolsRaw, setExtraSymbolsRaw, setSearchParams],
  )

  const toggleUniverse = useCallback(
    (symbol: string) => {
      if (symbol === chartSymbol) return
      setExtraSymbolsRaw(
        extraSymbolsRaw.includes(symbol) ? extraSymbolsRaw.filter((s) => s !== symbol) : [...extraSymbolsRaw, symbol],
      )
    },
    [chartSymbol, extraSymbolsRaw, setExtraSymbolsRaw],
  )

  const setRunId = useCallback(
    (id: string | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (id) next.set('run', id)
          else next.delete('run')
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const setDrawerTab = useCallback(
    (tab: DrawerTab) => {
      setStickyDrawerTab(tab)
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set('tab', tab)
          return next
        },
        { replace: true },
      )
    },
    [setStickyDrawerTab, setSearchParams],
  )

  const [backtestPrefill, setBacktestPrefill] = useState<Sequenced<BacktestPrefill> | null>(null)

  // `runId` lets a caller (HistoryPanel, reopening a run) overlay that run
  // in the same call as the prefill, rather than a separate `setRunId`
  // before or after -- see the comment on the `setSearchParams` call below
  // for why that matters, not just for tidiness.
  const prefillBacktest = useCallback(
    (value: BacktestPrefill, runId?: string) => {
      setBacktestPrefill((p) => ({ seq: (p?.seq ?? 0) + 1, value }))
      if (value.symbols?.[0]) setStickyChartSymbol(value.symbols[0])
      // Not gated on `.length > 1`: a single-symbol prefill must still
      // clear a previously wider universe down to just that one symbol,
      // the same as a multi-symbol prefill replaces it with several.
      if (value.symbols) setExtraSymbolsRaw(value.symbols.slice(1))
      setStickyDrawerTab('backtest')
      setDrawerCollapsed(false)
      // One `setSearchParams` call for every URL field this prefill touches
      // (symbol/tab/run), rather than `setChartSymbol` + `setDrawerTab` +
      // `setRunId` called back to back: react-router's `setSearchParams`
      // computes `next` from the *current render's* `searchParams`, which
      // does not update until the next render -- so a second call made
      // synchronously after the first still reads the pre-first-call value
      // and its `navigate()` silently overwrites whatever the first call
      // had just set (reproduced by the History tab's "open a run" flow
      // losing the `run` param the moment it also switched tabs).
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (value.symbols?.[0]) next.set('symbol', value.symbols[0])
          next.set('tab', 'backtest')
          if (runId) next.set('run', runId)
          return next
        },
        { replace: true },
      )
    },
    [setStickyChartSymbol, setExtraSymbolsRaw, setStickyDrawerTab, setDrawerCollapsed, setSearchParams],
  )

  const value: WorkspaceState = {
    chartSymbol,
    setChartSymbol,
    extraSymbols,
    toggleUniverse,
    setExtraSymbols: setExtraSymbolsRaw,
    universe,
    runId,
    setRunId,
    drawerTab,
    setDrawerTab,
    drawerCollapsed,
    setDrawerCollapsed,
    drawerHeight,
    setDrawerHeight,
    sidebarOpen,
    setSidebarOpen,
    showVolume,
    setShowVolume,
    indicators,
    toggleIndicator,
    indicatorParams,
    setIndicatorParams,
    editingProduct,
    setEditingProduct,
    backtestPrefill,
    prefillBacktest,
  }

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace(): WorkspaceState {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error('useWorkspace must be used within a WorkspaceProvider')
  return ctx
}
