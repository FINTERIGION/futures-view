import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../api/client'
import { dataApi, productsApi } from '../api/endpoints'
import type { Product } from '../api/types'
import { Icon } from '../components/Icon'
import { JobProgress } from '../components/JobProgress'
import { useToast } from '../components/toastStore'
import { useJobLifecycle, useJobSlot } from './jobsStore'
import { ProductRow } from './ProductRow'
import { useWorkspace } from './workspaceStore'

type SidebarFilter = 'all' | 'universe' | 'needsUpdate'

function needsDataUpdate(p: Product): boolean {
  return !p.coverage.has_data || p.coverage.stale_keys.length > 0
}

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

export function SymbolSidebar() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const toast = useToast()
  const job = useJobSlot('data')
  const lifecycle = useJobLifecycle()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<SidebarFilter>('all')
  const [activeCode, setActiveCode] = useState<string | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const { chartSymbol, setChartSymbol, universe, setUniverse, toggleUniverse, setEditingProduct, setSidebarOpen } =
    useWorkspace()

  const { data: products, isLoading } = useQuery({ queryKey: ['products'], queryFn: productsApi.list })

  useEffect(() => {
    if (chartSymbol || !products || products.length === 0) return
    const withData = products.filter((p) => p.coverage.has_data)
    setChartSymbol((withData[0] ?? products[0]).code)
  }, [chartSymbol, products, setChartSymbol])

  useEffect(() => {
    const state = job.state
    if (!state || !['done', 'error', 'cancelled'].includes(state.status)) return
    if (!lifecycle.claimAnnouncement(`data:${state.id}:${state.status}`)) return
    void queryClient.invalidateQueries({ queryKey: ['products'] })
    void queryClient.invalidateQueries({ queryKey: ['product-bars'] })
    void queryClient.invalidateQueries({ queryKey: ['product-roll'] })
    void queryClient.invalidateQueries({ queryKey: ['indicator'] })
    if (state.status === 'done') {
      toast.push({ kind: 'success', title: t('data.updateDone') })
    }
  }, [job.state, lifecycle, queryClient, toast, t])

  const runUpdate = async (symbols: string[]) => {
    setUpdateError(null)
    try {
      const { job_id } = await dataApi.update(symbols, false, false)
      job.start(job_id)
    } catch (err) {
      setUpdateError(errorMessage(err))
    }
  }

  const allProducts = products ?? []
  const staleCount = allProducts.filter(needsDataUpdate).length

  const filtered = allProducts.filter((p) => {
    if (filter === 'universe' && !universe.includes(p.code)) return false
    if (filter === 'needsUpdate' && !needsDataUpdate(p)) return false
    if (!query) return true
    const q = query.toLowerCase()
    return (
      p.code.toLowerCase().includes(q) ||
      p.name.toLowerCase().includes(q) ||
      p.name_zh.includes(query) ||
      p.exchange.toLowerCase().includes(q)
    )
  })

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
      if (e.shiftKey) {
        e.preventDefault()
        toggleUniverse(active)
      } else {
        chartProduct(active)
      }
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      if (query) setQuery('')
      else searchRef.current?.blur()
    }
  }

  const hasSubFilter = Boolean(query) || filter !== 'all'
  const targetProducts = hasSubFilter ? filtered : allProducts
  const allTargetSelected =
    targetProducts.length === 0 || targetProducts.every((p) => universe.includes(p.code))
  const handleSelectAll = () => {
    if (targetProducts.length === 0) return
    if (hasSubFilter) {
      setUniverse((prev) => Array.from(new Set([...prev, ...filtered.map((p) => p.code)])))
    } else {
      setUniverse(allProducts.map((p) => p.code))
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="search">
          <span className="search-icon">
            <Icon name="search" size={13} />
          </span>
          <input
            ref={searchRef}
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
              <Icon name="close" size={11} />
            </button>
          ) : (
            <kbd className="kbd search-hint" aria-hidden="true">
              /
            </kbd>
          )}
        </div>
        <button
          className="btn btn-sm btn-ghost btn-icon"
          onClick={() => setEditingProduct('new')}
          title={t('products.addProduct')}
          aria-label={t('products.addProduct')}
        >
          <Icon name="plus" size={14} />
        </button>
        <button
          className="btn btn-sm btn-ghost btn-icon"
          onClick={() => setSidebarOpen(false)}
          title={t('workspace.collapseSidebar')}
          aria-label={t('workspace.collapseSidebar')}
        >
          <Icon name="panel" size={14} />
        </button>
      </div>

      <div className="sidebar-filters" role="group" aria-label={t('workspace.filterProducts')}>
        <button
          type="button"
          className={`sidebar-filter-btn ${filter === 'all' ? 'active' : ''}`}
          aria-pressed={filter === 'all'}
          onClick={() => setFilter('all')}
        >
          {t('workspace.filterAll')}
        </button>
        <button
          type="button"
          className={`sidebar-filter-btn ${filter === 'universe' ? 'active' : ''}`}
          aria-pressed={filter === 'universe'}
          onClick={() => setFilter('universe')}
        >
          {t('workspace.filterSelected')} ({universe.length})
        </button>
        {staleCount > 0 && (
          <button
            type="button"
            className={`sidebar-filter-btn ${filter === 'needsUpdate' ? 'active' : ''}`}
            aria-pressed={filter === 'needsUpdate'}
            onClick={() => setFilter('needsUpdate')}
          >
            <span className="sidebar-filter-warn">{t('workspace.filterNeedsUpdate')}</span> ({staleCount})
          </button>
        )}
      </div>

      <div className="sidebar-meta">
        <span>{t('workspace.productCount', { count: filtered.length })}</span>
        <div className="spacer" />
        <button
          type="button"
          className="btn btn-xs btn-ghost sidebar-action"
          disabled={allTargetSelected}
          onClick={handleSelectAll}
          title={t('common.selectAll')}
          aria-label={t('common.selectAll')}
        >
          {t('common.selectAll')}
        </button>
        <button
          type="button"
          className="btn btn-xs btn-ghost sidebar-clear"
          disabled={universe.length === 0}
          onClick={() => setUniverse([])}
          title={t('common.clear')}
          aria-label={t('common.clear')}
        >
          {t('common.clear')}
        </button>
      </div>

      <div className="sidebar-list" role="listbox" aria-activedescendant={active ? `product-row-${active}` : undefined}>
        {isLoading && <SidebarSkeleton />}
        {filtered.map((p) => (
          <ProductRow
            key={p.code}
            product={p}
            isCharted={p.code === chartSymbol}
            inUniverse={universe.includes(p.code)}
            isActive={p.code === active && (Boolean(query) || activeCode !== null)}
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
            className="btn btn-sm"
            style={{ flex: 1 }}
            onClick={() => void runUpdate(universe)}
            disabled={universe.length === 0 || job.isActive}
          >
            <Icon name="download" size={13} />
            {t('data.update')} ({universe.length})
          </button>
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => void runUpdate(allProducts.map((p) => p.code))}
            disabled={job.isActive || allProducts.length === 0}
          >
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
