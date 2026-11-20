import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useStickyState } from '../hooks/useStickyState'
import {
  WorkspaceContext,
  type BacktestPrefill,
  type DrawerTab,
  type Sequenced,
  type WorkspaceState,
} from './workspaceStore'

const DRAWER_TABS: DrawerTab[] = ['alerts', 'backtest', 'runs']

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [searchParams, setSearchParams] = useSearchParams()

  const [stickyChartSymbol, setStickyChartSymbol] = useStickyState('chartSymbol', 'SA')
  const chartSymbol = searchParams.get('symbol') ?? stickyChartSymbol

  const [universe, setUniverse] = useStickyState<string[]>('universe', () => {
    try {
      const extraRaw = localStorage.getItem('ft.extraSymbols')
      const chartRaw = localStorage.getItem('ft.chartSymbol')
      if (extraRaw !== null || chartRaw !== null) {
        const extra = extraRaw ? JSON.parse(extraRaw) : []
        const chart = chartRaw ? JSON.parse(chartRaw) : chartSymbol
        const merged = Array.from(new Set([chart, ...(Array.isArray(extra) ? extra : [])].filter(Boolean)))
        if (merged.length > 0) return merged
      }
    } catch {}
    return chartSymbol ? [chartSymbol] : ['SA']
  })

  const [stickyDrawerTab, setStickyDrawerTab] = useStickyState<DrawerTab>('drawerTab', 'backtest')
  const tabParam = searchParams.get('tab')
  const drawerTab = tabParam && DRAWER_TABS.includes(tabParam as DrawerTab) ? (tabParam as DrawerTab) : stickyDrawerTab

  const [drawerCollapsed, setDrawerCollapsed] = useStickyState('drawerCollapsed', false)
  const [drawerHeight, setDrawerHeight] = useStickyState('drawerHeight', 360)
  const [sidebarOpen, setSidebarOpen] = useStickyState('sidebarOpen', true)
  const [showVolume, setShowVolume] = useStickyState('showVolume', true)
  const [indicators, setIndicators] = useStickyState<string[]>('indicators', [])
  const [indicatorParamsRaw, setIndicatorParamsRaw] = useStickyState<Record<string, Record<string, unknown>>>(
    'indicatorParams',
    {},
  )
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
      setIndicators((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
    },
    [setIndicators],
  )

  const setIndicatorParams = useCallback(
    (key: string, overrides: Record<string, unknown>) => {
      setIndicatorParamsRaw((prev) => {
        const safe = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {}
        const next = { ...safe }
        if (Object.keys(overrides).length > 0) next[key] = overrides
        else delete next[key]
        return next
      })
    },
    [setIndicatorParamsRaw],
  )

  const runId = searchParams.get('run')

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
    [setStickyChartSymbol, setSearchParams],
  )

  const toggleUniverse = useCallback(
    (symbol: string) => {
      setUniverse((prev) => (prev.includes(symbol) ? prev.filter((s) => s !== symbol) : [...prev, symbol]))
    },
    [setUniverse],
  )

  const setRunId = useCallback(
    (id: string | null, options?: { openBacktestTab?: boolean }) => {
      if (options?.openBacktestTab) {
        setStickyDrawerTab('backtest')
        setDrawerCollapsed(false)
      }
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (id) next.set('run', id)
          else next.delete('run')
          if (options?.openBacktestTab) next.set('tab', 'backtest')
          return next
        },
        { replace: true },
      )
    },
    [setStickyDrawerTab, setDrawerCollapsed, setSearchParams],
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

  const prefillBacktest = useCallback(
    (value: BacktestPrefill, targetRunId?: string) => {
      setBacktestPrefill((p) => ({ seq: (p?.seq ?? 0) + 1, value }))
      if (value.symbols?.[0]) setStickyChartSymbol(value.symbols[0])
      if (value.symbols) setUniverse(value.symbols)
      setStickyDrawerTab('backtest')
      setDrawerCollapsed(false)
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (value.symbols?.[0]) next.set('symbol', value.symbols[0])
          next.set('tab', 'backtest')
          if (targetRunId) next.set('run', targetRunId)
          return next
        },
        { replace: true },
      )
    },
    [setStickyChartSymbol, setUniverse, setStickyDrawerTab, setDrawerCollapsed, setSearchParams],
  )

  const value = useMemo<WorkspaceState>(
    () => ({
      chartSymbol,
      setChartSymbol,
      universe,
      setUniverse,
      toggleUniverse,
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
    }),
    [
      chartSymbol,
      setChartSymbol,
      universe,
      setUniverse,
      toggleUniverse,
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
      backtestPrefill,
      prefillBacktest,
    ],
  )

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}
