import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { productsApi } from '../api/endpoints'
import { AccessDrawer } from '../auth/AccessDrawer'
import { SuperChart } from '../chart/SuperChart'
import { Icon } from '../components/Icon'
import { useToast } from '../components/toastStore'
import { AlertNotifyModal } from '../panels/AlertNotifyModal'
import { ProductDrawer } from '../products/ProductDrawer'
import { BottomDrawer } from './BottomDrawer'
import { useJobLifecycle, useJobs } from './jobsStore'
import { ShortcutsSheet } from './ShortcutsSheet'
import { SymbolSidebar } from './SymbolSidebar'
import { useHotkeys } from './useHotkeys'
import { useWorkspace } from './workspaceStore'
import { WorkspaceTopBar } from './WorkspaceTopBar'

function CollapsedSidebarRail({ onExpand, universeCount }: { onExpand: () => void; universeCount: number }) {
  const { t } = useTranslation()
  return (
    <div className="sidebar-rail">
      <button
        className="btn btn-sm btn-ghost btn-icon"
        onClick={onExpand}
        title={t('workspace.expandSidebar')}
        aria-label={t('workspace.expandSidebar')}
      >
        <Icon name="panel" />
      </button>
      {universeCount > 0 && <span className="sidebar-rail-count">{universeCount}</span>}
    </div>
  )
}

export function ChartWorkspace() {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const toast = useToast()
  const jobs = useJobs()
  const lifecycle = useJobLifecycle()
  const {
    sidebarOpen,
    setSidebarOpen,
    drawerCollapsed,
    setDrawerCollapsed,
    drawerMaximized,
    drawerHeight,
    chartSymbol,
    chartSeries,
    setChartSeries,
    universe,
    setRunId,
    editingProduct,
    setEditingProduct,
  } = useWorkspace()
  const { data: products } = useQuery({ queryKey: ['products'], queryFn: productsApi.list })
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [accessOpen, setAccessOpen] = useState(false)
  const [notifyOpen, setNotifyOpen] = useState(false)
  const isZh = i18n.resolvedLanguage === 'zh'
  const chartedProduct = products?.find((p) => p.code === chartSymbol)
  const productName = chartedProduct ? (isZh ? chartedProduct.name_zh : chartedProduct.name) : undefined

  // When switching to a different product, gracefully fall back to weighted if
  // the previously chosen month continuous series is not in the new product's
  // main delivery months (e.g. SA m09 -> AU [6, 12]).
  const prevSymbolRef = useRef(chartSymbol)
  useEffect(() => {
    if (prevSymbolRef.current === chartSymbol) return
    prevSymbolRef.current = chartSymbol
    if (!chartedProduct || !chartSeries.startsWith('m')) return
    const monthNum = Number(chartSeries.slice(1))
    const mainMonths = chartedProduct.roll?.main_months ?? []
    if (mainMonths.length > 0 && !mainMonths.includes(monthNum)) {
      setChartSeries('weighted')
    }
  }, [chartSymbol, chartSeries, chartedProduct, setChartSeries])

  const focusProductSearch = useCallback(() => {
    setSidebarOpen(true)
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>('input[data-product-search]')
      input?.focus()
      input?.select()
    })
  }, [setSidebarOpen])

  useHotkeys({
    'mod+b': () => setSidebarOpen(!sidebarOpen),
    'mod+j': () => setDrawerCollapsed(!drawerCollapsed),
    '/': focusProductSearch,
    'mod+k': focusProductSearch,
    '?': () => setShortcutsOpen(true),
  })

  const backtestState = jobs.backtest.state
  useEffect(() => {
    if (!backtestState || !['done', 'error'].includes(backtestState.status)) return
    if (lifecycle.claimAnnouncement(`backtest:${backtestState.id}`)) {
      if (backtestState.status === 'done') void queryClient.invalidateQueries({ queryKey: ['runs'] })
      if (backtestState.status === 'error') {
        toast.push({ kind: 'error', title: t('backtest.runFailed'), message: backtestState.error ?? undefined })
      } else {
        toast.push({ kind: 'success', title: t('backtest.runFinished') })
      }
    }
    if (backtestState.status === 'done') {
      const fallbackRunId = (backtestState.result as { run_id?: string } | undefined)?.run_id ?? null
      const overlayRunId = lifecycle.claimBacktestOverlay(fallbackRunId)
      if (overlayRunId) setRunId(overlayRunId)
    }
  }, [backtestState, lifecycle, queryClient, setRunId, toast, t])

  const dataState = jobs.data.state
  useEffect(() => {
    if (!dataState || !['done', 'error', 'cancelled'].includes(dataState.status)) return
    if (!lifecycle.claimAnnouncement(`data:${dataState.id}:${dataState.status}`)) return
    void queryClient.invalidateQueries({ queryKey: ['products'] })
    void queryClient.invalidateQueries({ queryKey: ['product-bars'] })
    void queryClient.invalidateQueries({ queryKey: ['product-roll'] })
    void queryClient.invalidateQueries({ queryKey: ['indicator'] })
    if (dataState.status === 'done') {
      toast.push({ kind: 'success', title: t('data.updateDone') })
    }
  }, [dataState, lifecycle, queryClient, toast, t])

  useEffect(() => {
    if (!sidebarOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !document.querySelector('[role="dialog"][aria-modal="true"]') &&
        window.matchMedia?.('(max-width: 900px)').matches
      ) {
        setSidebarOpen(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [sidebarOpen, setSidebarOpen])

  const style = {
    '--sidebar-w': sidebarOpen ? '292px' : '42px',
    '--drawer-h': drawerCollapsed ? '38px' : drawerMaximized ? '74vh' : `${drawerHeight}px`,
  } as CSSProperties

  return (
    <div className="workspace-root">
      <WorkspaceTopBar
        productName={productName}
        onFocusSearch={focusProductSearch}
        onShowNotify={() => setNotifyOpen(true)}
        onShowShortcuts={() => setShortcutsOpen(true)}
        onShowAccess={() => setAccessOpen(true)}
      />
      <div className="workspace" style={style}>
        <SuperChart />
        {sidebarOpen ? (
          <>
            <button
              type="button"
              className="sidebar-backdrop"
              aria-label={t('workspace.collapseSidebar')}
              onClick={() => setSidebarOpen(false)}
            />
            <SymbolSidebar />
          </>
        ) : (
          <CollapsedSidebarRail onExpand={() => setSidebarOpen(true)} universeCount={universe.length} />
        )}
        <BottomDrawer />
      </div>
      {editingProduct !== null && (
        <ProductDrawer code={editingProduct === 'new' ? null : editingProduct} onClose={() => setEditingProduct(null)} />
      )}
      <ShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <AccessDrawer open={accessOpen} onClose={() => setAccessOpen(false)} />
      <AlertNotifyModal open={notifyOpen} onClose={() => setNotifyOpen(false)} />
    </div>
  )
}
