import { useTranslation } from 'react-i18next'
import type { Product } from '../api/types'
import { Icon } from '../components/Icon'

/**
 * One row in the product sidebar. Clicking the row charts the product; the
 * independent checkbox controls backtest-universe membership. Chart view
 * and universe membership are independent: a product can be charted without
 * being in the universe, or checked into the universe without being charted.
 */
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
  /** Highlighted by the search box's arrow keys -- not a selection of its
   * own, just where Enter would land. */
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
    : `${cov.stale_keys.length > 0 ? t('data.stale') : t('data.fresh')} · ${cov.n_rows} ${t('products.rows')}`

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
          <Icon name="check" size={11} />
        </span>
      </label>
      <span className="code">{product.code}</span>
      <span className="name">{name}</span>
      {/* Three coverage states in a 300px row: a dot reads down the column at
          a glance where three differently-sized word badges did not. The text
          it replaced lives on in the title, alongside the row count that used
          to be hidden there anyway. */}
      <span className={`coverage-dot ${coverageState}`} title={coverageTitle} role="img" aria-label={coverageTitle} />
      <div className="row-actions">
        {/* Downloading one product used to mean checking it into the universe
            first, then using the bulk button in the footer -- and unchecking
            it afterwards. */}
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
          <Icon name="download" size={14} />
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
          <Icon name="pencil" size={14} />
        </button>
      </div>
    </div>
  )
}
