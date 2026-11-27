import { useTranslation } from 'react-i18next'
import type { Product } from '../api/types'
import { Icon } from '../components/Icon'

function shortDate(iso: string | null): string {
  if (!iso) return ''
  // '2026-10-22' -> '10-22'
  return iso.length >= 10 ? iso.slice(5, 10) : iso
}

export function ProductRow({
  product,
  isCharted,
  inUniverse,
  isActive,
  onSetChart,
  onToggleUniverse,
  onEdit,
  onDownload,
  downloadDisabled,
}: {
  product: Product
  isCharted: boolean
  inUniverse: boolean
  isActive?: boolean
  onSetChart: () => void
  onToggleUniverse: () => void
  onEdit: () => void
  onDownload: () => void
  downloadDisabled?: boolean
}) {
  const { t, i18n } = useTranslation()
  const isZh = i18n.resolvedLanguage === 'zh'
  const name = isZh ? product.name_zh : product.name
  const cov = product.coverage

  const coverageState = !cov.has_data ? 'is-empty' : cov.stale_keys.length > 0 ? 'is-stale' : 'is-fresh'
  const coverageTitle = !cov.has_data
    ? t('products.noData')
    : `${cov.stale_keys.length > 0 ? t('data.stale') : t('data.fresh')} · ${cov.last_date ?? ''} · ${cov.n_rows} ${t('products.rows')}`

  return (
    <div
      id={`product-row-${product.code}`}
      className={[
        'product-row',
        isCharted ? 'is-charted' : '',
        inUniverse ? 'is-in-universe' : '',
        isActive ? 'is-active' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      role="option"
      aria-selected={isCharted}
      tabIndex={0}
      onClick={onSetChart}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSetChart()
        }
      }}
    >
      <label
        className="universe-toggle"
        title={t('workspace.inUniverse')}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={inUniverse}
          aria-label={t('workspace.inUniverse')}
          onChange={onToggleUniverse}
        />
        <span className="universe-box" aria-hidden="true">
          <Icon name="check" size={10} />
        </span>
      </label>
      <span className="code">{product.code}</span>
      <span className="name">{name}</span>
      <span className="product-row-meta">
        {cov.has_data && cov.last_date && <span className="product-row-date">{shortDate(cov.last_date)}</span>}
        <span className={`coverage-dot ${coverageState}`} title={coverageTitle} role="img" aria-label={coverageTitle} />
      </span>
      <div className="row-actions">
        <button
          className="btn btn-sm btn-ghost btn-icon"
          title={t('data.updateOne', { code: product.code })}
          aria-label={t('data.updateOne', { code: product.code })}
          disabled={downloadDisabled}
          onClick={(e) => {
            e.stopPropagation()
            onDownload()
          }}
        >
          <Icon name="download" size={13} />
        </button>
        <button
          className="btn btn-sm btn-ghost btn-icon"
          title={t('products.editProduct')}
          aria-label={t('products.editProduct')}
          onClick={(e) => {
            e.stopPropagation()
            onEdit()
          }}
        >
          <Icon name="pencil" size={13} />
        </button>
      </div>
    </div>
  )
}
