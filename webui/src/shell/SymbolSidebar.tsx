import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../api/client'
import { dataApi, productsApi } from '../api/endpoints'
import { Icon } from '../components/Icon'
import { JobProgress } from '../components/JobProgress'
import { useToast } from '../components/Toast'
import { useJobSlot } from './JobsProvider'
import { ProductRow } from './ProductRow'
import { useWorkspace } from './WorkspaceContext'

/** Placeholder rows, shaped like the real ones, for the first load. An empty
 * panel that suddenly fills is harder to read than one that was already the
 * right shape. */
function SidebarSkeleton() {
  return (
    <div aria-hidden="true">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div className="product-row-skeleton" key={i}>
          <span className="skeleton" style={{ width: 28 }} />
          <span className="skeleton" style={{ flex: 1, opacity: 1 - i * 0.12 }} />
        </div>
      ))}
    </div>
  )
}

/**
 * The right-hand product panel: search + list (click to chart, a checkbox
 * for the backtest universe, coverage badges, per-row download/edit)
 * on top, bulk data download at the bottom. This absorbs what used to be the
 * standalone Products and Data pages -- coverage comes straight off
 * `Product.coverage` (no separate `/data/coverage` fetch), and "Update
 * Selected" acts on the backtest universe.
 *
 * The search box is also the list's keyboard: ↑/↓ move a highlight through
 * the filtered rows and Enter charts the highlighted one, so finding a
 * product and opening it never needs the mouse. That is why the highlight
 * (`activeCode`) is a third state alongside charted and universe membership
 * -- it marks where Enter would land, and selects nothing by itself.
 */
export function SymbolSidebar() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const toast = useToast()
  const job = useJobSlot('data')
  const [query, setQuery] = useState('')
  const [activeCode, setActiveCode] = useState<string | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const { chartSymbol, setChartSymbol, universe, setUniverse, toggleUniverse, setEditingProduct, setSidebarOpen } =
    useWorkspace()

  const { data: products, isLoading } = useQuery({ queryKey: ['products'], queryFn: productsApi.list })

  // Seed the chart with a product that actually has data downloaded, once,
  // the first time the catalog loads with nothing picked yet -- the same
  // rule the old BacktestPage used to seed its universe with. Exactly once,
  // so it doesn't fight a symbol the user has already chosen.
  useEffect(() => {
    if (chartSymbol || !products || products.length === 0) return
    const withData = products.filter((p) => p.coverage.has_data)
    setChartSymbol((withData[0] ?? products[0]).code)
  }, [chartSymbol, products, setChartSymbol])

  // The last job this panel has already announced. Re-invalidating a query is
  // idempotent, but raising a toast is not: this effect re-runs on every
  // render while the status sits at `done`, which would otherwise stack one
  // notice per render until the next job started.
  const announcedJob = useRef<string | null>(null)

  useEffect(() => {
    // Every terminal status, not just `done`: a run that fails or is
    // cancelled partway has already rewritten the products before that
    // point, and the backend drops its own caches on every exit too.
    const state = job.state
    if (!state || !['done', 'error', 'cancelled'].includes(state.status)) return
    void queryClient.invalidateQueries({ queryKey: ['products'] })
    void queryClient.invalidateQueries({ queryKey: ['product-bars'] })
    void queryClient.invalidateQueries({ queryKey: ['product-roll'] })
    // Indicator values are computed off those same bars. Left cached, the
    // candles gain the new days while every indicator stops short of them
    // for the rest of its staleTime.
    void queryClient.invalidateQueries({ queryKey: ['indicator'] })
    if (state.status !== 'done' || announcedJob.current === state.id) return
    announcedJob.current = state.id
    // The sidebar's own progress block clears with the next job, and the
    // sidebar may be collapsed to its rail, so say so where it can be seen.
    toast.push({ kind: 'success', title: t('data.updateDone') })
  }, [job.state, queryClient, toast, t])

  const runUpdate = async (symbols: string[]) => {
    // This request really can be refused, and used to be refused in
    // silence: the backend claims each symbol in `_inflight` and answers 409
    // while a download of it is already running (web/routers/data.py).
    setUpdateError(null)
    try {
      const { job_id } = await dataApi.update(symbols, false, false)
      job.start(job_id)
    } catch (err) {
      setUpdateError(errorMessage(err))
    }
  }

  const filtered = (products ?? []).filter((p) => {
    if (!query) return true
    const q = query.toLowerCase()
    return p.code.toLowerCase().includes(q) || p.name.toLowerCase().includes(q) || p.name_zh.includes(query)
  })

  // The highlight is derived, not stored: a filter change can strip the row
  // it pointed at, and a dangling `activeCode` would leave Enter charting
  // something no longer on screen.
  const active = filtered.some((p) => p.code === activeCode) ? activeCode : (filtered[0]?.code ?? null)

  const chartProduct = (code: string) => {
    setChartSymbol(code)
    if (window.matchMedia?.('(max-width: 900px)').matches) setSidebarOpen(false)
  }

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (filtered.length === 0) return
      const at = filtered.findIndex((p) => p.code === active)
      const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length
      setActiveCode(filtered[next].code)
      document.getElementById(`product-row-${filtered[next].code}`)?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter' && active) {
      chartProduct(active)
    } else if (e.key === 'Escape') {
      // First press clears the filter, second gives the keyboard back to the
      // chart -- Escape on an already-empty box that did nothing would read
      // as a dead key. The workspace also closes a narrow overlay on Escape,
      // so keep this more local interaction from bubbling up to it.
      e.stopPropagation()
      if (query) setQuery('')
      else searchRef.current?.blur()
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="search">
          <span className="search-icon">
            <Icon name="search" size={14} />
          </span>
          <input
            ref={searchRef}
            // Read by the workspace's `/` shortcut, which has to find this
            // input across subtrees -- see ChartWorkspace.focusProductSearch.
            data-product-search
            className="sidebar-search"
            placeholder={t('workspace.searchProducts')}
            aria-label={t('workspace.searchProducts')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
          />
          {query ? (
            <button className="search-clear" onClick={() => setQuery('')} aria-label={t('common.clear')}>
              <Icon name="close" size={12} />
            </button>
          ) : (
            <kbd className="kbd search-hint" aria-hidden="true">
              /
            </kbd>
          )}
        </div>
        <button
          className="btn btn-sm btn-icon"
          onClick={() => setEditingProduct('new')}
          title={t('products.addProduct')}
          aria-label={t('products.addProduct')}
        >
          <Icon name="plus" />
        </button>
        <button
          className="btn btn-sm btn-ghost btn-icon"
          onClick={() => setSidebarOpen(false)}
          title={t('workspace.collapseSidebar')}
          aria-label={t('workspace.collapseSidebar')}
        >
          <Icon name="panel" />
        </button>
      </div>

      {/* What the list is currently showing, and how wide the next backtest
          is. Both were previously only countable by eye. */}
      {(() => {
        const targetProducts = query ? filtered : (products ?? [])
        const allTargetSelected =
          targetProducts.length === 0 || targetProducts.every((p) => universe.includes(p.code))
        const handleSelectAll = () => {
          if (targetProducts.length === 0) return
          if (query) {
            setUniverse((prev) => Array.from(new Set([...prev, ...filtered.map((p) => p.code)])))
          } else {
            setUniverse((products ?? []).map((p) => p.code))
          }
        }
        return (
          <div className="sidebar-meta">
            <span>{t('workspace.productCount', { count: filtered.length })}</span>
            <div className="spacer" />
            <span>{t('workspace.universeCount', { count: universe.length })}</span>
            <button
              type="button"
              className="btn btn-sm btn-ghost sidebar-action"
              disabled={allTargetSelected}
              onClick={handleSelectAll}
              title={t('common.selectAll')}
              aria-label={t('common.selectAll')}
            >
              {t('common.selectAll')}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost sidebar-clear"
              disabled={universe.length === 0}
              onClick={() => setUniverse([])}
              title={t('common.clear')}
              aria-label={t('common.clear')}
            >
              {t('common.clear')}
            </button>
          </div>
        )
      })()}

      <div className="sidebar-list" role="listbox" aria-activedescendant={active ? `product-row-${active}` : undefined}>
        {isLoading && <SidebarSkeleton />}
        {filtered.map((p) => (
          <ProductRow
            key={p.code}
            product={p}
            isCharted={p.code === chartSymbol}
            inUniverse={universe.includes(p.code)}
            isActive={p.code === active && Boolean(query)}
            onSetChart={() => chartProduct(p.code)}
            onToggleUniverse={() => toggleUniverse(p.code)}
            onEdit={() => setEditingProduct(p.code)}
            onDownload={() => void runUpdate([p.code])}
            downloadDisabled={job.isActive}
          />
        ))}
        {products && filtered.length === 0 && (
          <div className="empty-state">
            <span className="empty-state-icon">
              <Icon name="inbox" size={18} />
            </span>
            <span className="empty-state-title">{t('workspace.noProducts')}</span>
            {query && <p className="empty-state-hint">{t('workspace.noProductsForQuery', { query })}</p>}
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        {updateError && (
          <div className="hint-banner warning">
            {t('common.updateFailed')} — {updateError}
          </div>
        )}
        <div className="toolbar">
          <button
            className="btn btn-sm btn-primary"
            style={{ flex: 1 }}
            onClick={() => void runUpdate(universe)}
            disabled={universe.length === 0 || job.isActive}
          >
            <Icon name="download" size={14} />
            {t('data.update')} ({universe.length})
          </button>
          <button className="btn btn-sm" onClick={() => void runUpdate((products ?? []).map((p) => p.code))} disabled={job.isActive}>
            {t('data.updateAll')}
          </button>
        </div>
        {job.state && (
          <JobProgress state={job.state} logs={job.logs} onCancel={job.cancel} streaming={job.streaming} lost={job.lost} />
        )}
      </div>
    </aside>
  )
}
