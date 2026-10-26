import { Fragment, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from './Icon'

export interface Column<T> {
  key: string
  header: ReactNode
  render: (row: T) => ReactNode
  width?: string
  /** Figures rather than words. Aligns the column on its right edge and locks
   * the digits to one width, so a column of numbers can be scanned down
   * instead of read across. */
  numeric?: boolean
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  rowClassName,
  emptyMessage,
  maxHeight,
  isExpanded,
  renderExpanded,
}: {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
  rowClassName?: (row: T) => string | undefined
  emptyMessage?: string
  maxHeight?: number | string
  /** When true, `renderExpanded` is drawn as a full-width row immediately
   * under this one — the selected alert's product list sits here, not in a
   * second card that repeats the strategy name. */
  isExpanded?: (row: T) => boolean
  renderExpanded?: (row: T) => ReactNode
}) {
  const { t } = useTranslation()
  if (rows.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-state-icon">
          <Icon name="inbox" size={18} />
        </span>
        <span>{emptyMessage ?? t('common.none')}</span>
      </div>
    )
  }
  return (
    <div className="dtable-wrap" style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined}>
      <table className="dtable">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} className={col.numeric ? 'col-num' : undefined} style={{ width: col.width }}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row)
            const expanded = Boolean(isExpanded?.(row) && renderExpanded)
            return (
              <Fragment key={key}>
                <tr
                  className={rowClassName?.(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  style={onRowClick ? { cursor: 'pointer' } : undefined}
                >
                  {columns.map((col) => (
                    <td key={col.key} className={col.numeric ? 'col-num' : undefined}>
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
                {expanded && (
                  <tr className="row-expand">
                    <td colSpan={columns.length}>{renderExpanded!(row)}</td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
