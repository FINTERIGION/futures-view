import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../api/client'
import { indicatorsApi } from '../api/endpoints'
import type { IndicatorInfo } from '../api/types'
import { Icon } from '../components/Icon'
import { useWorkspace } from '../shell/workspaceStore'
import { IndicatorParamsEditor } from './IndicatorParamsEditor'
import { activeOverrides, editableParams, paramSummary } from './indicatorParams'

export function IndicatorPicker() {
  const { t } = useTranslation()
  const {
    chartSymbol,
    chartSeries,
    indicators,
    toggleIndicator,
    clearIndicators,
    showVolume,
    setShowVolume,
    indicatorParams,
    setIndicatorParams,
  } = useWorkspace()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const { data: catalog, isLoading, error } = useQuery({
    queryKey: ['indicators'],
    queryFn: indicatorsApi.list,
    staleTime: 5 * 60 * 1000,
  })

  const reload = useMutation({
    mutationFn: indicatorsApi.reload,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['indicators'] })
      void queryClient.invalidateQueries({ queryKey: ['indicator'] })
    },
  })

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (editing) setEditing(null)
      else if (query) setQuery('')
      else close()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, editing, query])

  function close() {
    setOpen(false)
    setEditing(null)
    setQuery('')
  }

  const activeIndicatorCount = catalog
    ? indicators.filter((k) => catalog.some((c) => c.key === k && c.errors.length === 0)).length
    : indicators.length
  const count = activeIndicatorCount + (showVolume ? 1 : 0)

  const q = query.trim().toLowerCase()
  const matchesQuery = (info: IndicatorInfo) => {
    if (!q) return true
    return (
      info.label.toLowerCase().includes(q) ||
      info.key.toLowerCase().includes(q) ||
      info.docstring.toLowerCase().includes(q)
    )
  }
  const volumeLabel = t('workspace.paneVolume')
  const showVolumeRow = !q || volumeLabel.toLowerCase().includes(q) || 'volume'.includes(q)

  const mainRows = (catalog ?? []).filter((info) => info.pane !== 'sub' && matchesQuery(info))
  const subRows = (catalog ?? []).filter((info) => info.pane === 'sub' && matchesQuery(info))

  const catalogRow = (info: IndicatorInfo) => {
    const broken = info.errors.length > 0
    const editable = !broken && editableParams(info).length > 0
    const overrides = activeOverrides(info, indicatorParams[info.key])
    const custom = Object.keys(overrides).length > 0
    const isEditing = editing === info.key
    return (
      <Fragment key={info.key}>
        <div className={`indicator-row${broken ? ' is-broken' : ''}${isEditing ? ' is-editing' : ''}`}>
          <label className="indicator-row-main" title={broken ? info.errors.join('\n') : info.docstring}>
            <input
              type="checkbox"
              disabled={broken}
              checked={indicators.includes(info.key)}
              onChange={() => toggleIndicator(info.key)}
            />
            <span className="indicator-row-label">{info.label}</span>
            {editable && (
              <span
                className={`indicator-row-params${custom ? ' is-custom' : ''}`}
                title={custom ? t('workspace.customParams') : undefined}
              >
                {paramSummary(info, overrides)}
              </span>
            )}
            <span className="indicator-row-pane">
              {info.pane === 'sub' ? t('workspace.paneSub') : t('workspace.paneMain')}
            </span>
            {broken && <span className="indicator-row-error">{t('workspace.indicatorBroken')}</span>}
          </label>
          {editable ? (
            <button
              type="button"
              className={`btn btn-sm btn-ghost btn-icon indicator-row-edit${custom ? ' is-custom' : ''}`}
              title={t('workspace.editIndicatorParams', { name: info.label })}
              aria-label={t('workspace.editIndicatorParams', { name: info.label })}
              aria-expanded={isEditing}
              onClick={() => setEditing(isEditing ? null : info.key)}
            >
              <Icon name="pencil" size={13} />
            </button>
          ) : (
            <span className="indicator-row-edit-slot" aria-hidden="true" />
          )}
        </div>
        {isEditing && (
          <IndicatorParamsEditor
            info={info}
            overrides={overrides}
            chartSymbol={chartSymbol}
            chartSeries={chartSeries}
            onCancel={() => setEditing(null)}
            onApply={(next) => {
              setIndicatorParams(info.key, next)
              if (!indicators.includes(info.key)) toggleIndicator(info.key)
              setEditing(null)
            }}
          />
        )}
      </Fragment>
    )
  }

  return (
    <div className="indicator-picker" ref={rootRef}>
      <button
        type="button"
        className={`btn btn-sm ${count ? 'btn-soft' : ''}`}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => {
          if (open) close()
          else {
            setOpen(true)
            requestAnimationFrame(() => searchRef.current?.focus())
          }
        }}
      >
        <Icon name="layers" size={14} />
        {count ? t('workspace.indicatorsWithCount', { count }) : t('workspace.indicators')}
        <Icon name="chevron-down" size={13} />
      </button>

      {open && (
        <div className="indicator-menu" role="dialog" aria-label={t('workspace.indicators')}>
          <div className="indicator-menu-head">
            <span>{t('workspace.indicators')}</span>
            <div className="toolbar" style={{ gap: 4 }}>
              {activeIndicatorCount > 0 && (
                <button type="button" className="btn btn-xs btn-ghost" onClick={clearIndicators}>
                  {t('common.clear')}
                </button>
              )}
              <button
                type="button"
                className="btn btn-xs"
                disabled={reload.isPending}
                onClick={() => reload.mutate()}
                title={t('workspace.reloadIndicatorsHint')}
              >
                {reload.isPending ? t('common.loading') : t('workspace.reloadIndicators')}
              </button>
            </div>
          </div>

          <div className="indicator-menu-search">
            <div className="search">
              <span className="search-icon">
                <Icon name="search" size={13} />
              </span>
              <input
                ref={searchRef}
                type="text"
                className="sidebar-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('workspace.searchIndicators')}
                aria-label={t('workspace.searchIndicators')}
              />
              {query && (
                <button
                  type="button"
                  className="search-clear"
                  onClick={() => setQuery('')}
                  aria-label={t('common.clear')}
                >
                  <Icon name="close" size={11} />
                </button>
              )}
            </div>
          </div>

          <div className="indicator-menu-list">
            {Object.entries(reload.data?.failed ?? {}).map(([module, message]) => (
              <div key={module} className="indicator-menu-empty indicator-row-error">
                {module}: {message}
              </div>
            ))}
            {reload.error && (
              <div className="indicator-menu-empty indicator-row-error">{errorMessage(reload.error)}</div>
            )}

            {isLoading && <div className="indicator-menu-empty">{t('common.loading')}</div>}
            {error && <div className="indicator-menu-empty">{errorMessage(error)}</div>}
            {catalog && catalog.length === 0 && (
              <div className="indicator-menu-empty">{t('workspace.noIndicators')}</div>
            )}

            {mainRows.map(catalogRow)}

            {mainRows.length > 0 && (showVolumeRow || subRows.length > 0) && <div className="indicator-menu-rule" />}

            {showVolumeRow && (
              <div className="indicator-row">
                <label className="indicator-row-main" title={t('workspace.volumeHint')}>
                  <input type="checkbox" checked={showVolume} onChange={() => setShowVolume(!showVolume)} />
                  <span className="indicator-row-label">{volumeLabel}</span>
                  <span className="indicator-row-pane">{t('workspace.paneSub')}</span>
                </label>
                <span className="indicator-row-edit-slot" aria-hidden="true" />
              </div>
            )}
            {subRows.map(catalogRow)}

            {q && mainRows.length === 0 && subRows.length === 0 && !showVolumeRow && (
              <div className="indicator-menu-empty">{t('workspace.noIndicatorsForQuery', { query })}</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
