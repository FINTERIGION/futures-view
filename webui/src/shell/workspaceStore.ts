import { createContext, useContext } from 'react'
import type { BarSeries } from '../api/types'

export type DrawerTab = 'alerts' | 'backtest' | 'runs'

export interface BacktestPrefill {
  strategy: string
  symbols?: string[]
  start?: string
  end?: string
  cash?: number
  slippage?: number
  params: Record<string, unknown>
}

export interface AlertPrefill {
  strategy: string
  symbols: string[]
  params: Record<string, unknown>
}

export interface ChartFocusRange {
  symbol: string
  startDate: string
  endDate: string
}

export interface Sequenced<T> {
  seq: number
  value: T
}

export interface WorkspaceState {
  chartSymbol: string
  setChartSymbol: (symbol: string) => void

  chartSeries: BarSeries
  setChartSeries: (series: BarSeries) => void

  chartFocus: Sequenced<ChartFocusRange> | null
  focusChartRange: (range: ChartFocusRange) => void

  universe: string[]
  setUniverse: (symbols: string[] | ((prev: string[]) => string[])) => void
  toggleUniverse: (symbol: string) => void

  runId: string | null
  setRunId: (id: string | null, options?: { openBacktestTab?: boolean }) => void

  drawerTab: DrawerTab
  setDrawerTab: (tab: DrawerTab) => void
  drawerCollapsed: boolean
  setDrawerCollapsed: (v: boolean) => void
  drawerMaximized: boolean
  setDrawerMaximized: (v: boolean) => void
  drawerHeight: number
  setDrawerHeight: (h: number) => void

  sidebarOpen: boolean
  setSidebarOpen: (v: boolean) => void

  showVolume: boolean
  setShowVolume: (v: boolean) => void

  indicators: string[]
  toggleIndicator: (key: string) => void
  clearIndicators: () => void

  indicatorParams: Record<string, Record<string, unknown>>
  setIndicatorParams: (key: string, overrides: Record<string, unknown>) => void

  editingProduct: string | 'new' | null
  setEditingProduct: (code: string | 'new' | null) => void

  backtestPrefill: Sequenced<BacktestPrefill> | null
  prefillBacktest: (value: BacktestPrefill, runId?: string) => void

  alertPrefill: Sequenced<AlertPrefill> | null
  prefillAlert: (value: AlertPrefill) => void
}

export const WorkspaceContext = createContext<WorkspaceState | null>(null)

export function useOptionalWorkspace(): WorkspaceState | null {
  return useContext(WorkspaceContext)
}

export function useWorkspace(): WorkspaceState {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error('useWorkspace must be used within a WorkspaceProvider')
  return ctx
}
