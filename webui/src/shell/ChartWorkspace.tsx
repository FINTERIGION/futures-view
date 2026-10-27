import { useQuery } from '@tanstack/react-query'
import { useCallback, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { productsApi } from '../api/endpoints'
import { AccessDrawer } from '../auth/AccessDrawer'
import { SuperChart } from '../chart/SuperChart'
import { Icon } from '../components/Icon'
import { ProductDrawer } from '../products/ProductDrawer'
import { BottomDrawer } from './BottomDrawer'
import { ShortcutsSheet } from './ShortcutsSheet'
import { SymbolSidebar } from './SymbolSidebar'
import { useHotkeys } from './useHotkeys'
import { useWorkspace } from './WorkspaceContext'
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
      {/* The count is the reason to reopen the rail: it says how wide the next
          backtest is without costing the chart 300px to find out. */}
      {universeCount > 0 && <span className="sidebar-rail-count">{universeCount}</span>}
    </div>
  )
}

/**
 * The whole screen: a top bar, the super chart filling the remaining width,
 * a product sidebar on the right, and a resizable tabbed drawer along the
 * bottom. Everything else in this app used to be four routed pages; this is
 * the single composition root that replaces them (see BottomDrawer,
 * SymbolSidebar, chart/SuperChart).
 */
export function ChartWorkspace() {
  const { i18n } = useTranslation()
  const {
    sidebarOpen,
    setSidebarOpen,
    drawerCollapsed,
    setDrawerCollapsed,
    drawerHeight,
    chartSymbol,
    universe,
    editingProduct,
    setEditingProduct,
  } = useWorkspace()
  const { data: products } = useQuery({ queryKey: ['products'], queryFn: productsApi.list })
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [accessOpen, setAccessOpen] = useState(false)
  const isZh = i18n.resolvedLanguage === 'zh'
  const chartedProduct = products?.find((p) => p.code === chartSymbol)
  const productName = chartedProduct ? (isZh ? chartedProduct.name_zh : chartedProduct.name) : undefined

  // The search box belongs to a sibling subtree that may not even be mounted
  // when the shortcut fires (a collapsed sidebar renders the rail instead), so
  // this opens the sidebar and then finds the input in the DOM on the next
  // frame. Threading a ref down through the workspace context for one
  // keystroke would put a piece of imperative focus plumbing into the state
  // every panel reads.
  const focusProductSearch = useCallback(() => {
    setSidebarOpen(true)
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>('input[data-product-search]')
      // Focus *and* select: focusing alone leaves the caret after whatever was
      // typed last, so the shortcut would append to a stale filter instead of
      // starting a new search.
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

  // The grid row must actually shrink on collapse, not just the drawer's own
  // content -- otherwise the row stays reserved at the last resized height
  // (drawerHeight) and the chart above never grows into the freed space.
  const style = {
    '--sidebar-w': sidebarOpen ? '300px' : '44px',
    '--drawer-h': drawerCollapsed ? '40px' : `${drawerHeight}px`,
  } as CSSProperties

  return (
    <div className="workspace-root">
      <WorkspaceTopBar
        productName={productName}
        onShowShortcuts={() => setShortcutsOpen(true)}
        onShowAccess={() => setAccessOpen(true)}
      />
      <div className="workspace" style={style}>
        <SuperChart productName={productName} />
        {sidebarOpen ? (
          <SymbolSidebar />
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
    </div>
  )
}
