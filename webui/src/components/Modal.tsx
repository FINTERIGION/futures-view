import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Icon } from './Icon'

/**
 * Centered floating dialog with a sticky header/footer and scrollable body,
 * used for Keyboard Shortcuts, Web Access, and Alert Notifications.
 */
export function Modal({
  open,
  onClose,
  title,
  size = 'md',
  closeOnEscape = true,
  children,
  footer,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  size?: 'sm' | 'md' | 'lg'
  closeOnEscape?: boolean
  children: ReactNode
  footer?: ReactNode
}) {
  const { t } = useTranslation()
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  useEffect(() => {
    if (!open || !closeOnEscape) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, closeOnEscape])

  if (!open) return null

  const sizeClass = size === 'sm' ? '' : ` modal-${size}`
  return createPortal(
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div
        className={`modal modal-sheet${sizeClass}`}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
      >
        <div className="modal-header">
          <h3>{title}</h3>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label={t('common.close')}>
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </>,
    document.body,
  )
}
