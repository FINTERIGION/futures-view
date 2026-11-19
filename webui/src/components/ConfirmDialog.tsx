import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

/**
 * A small modal for destructive confirmations, in place of `window.confirm`.
 *
 * Same reasoning as the toasts: the native dialog freezes the tab (a backtest
 * streaming behind it stops receiving events until it is answered), cannot
 * say which button is the dangerous one, and prefixes the question with the
 * page's origin. This one opens with focus on Cancel, so a stray Enter on a
 * keyboard-driven delete does not confirm it.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  body?: ReactNode
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    cancelRef.current?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onCancel])

  if (!open) return null

  return createPortal(
    <>
      <div className="drawer-backdrop backdrop-confirm" onClick={onCancel} />
      <div className="modal modal-confirm" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-body">
          <h3>{title}</h3>
          {body && <p>{body}</p>}
        </div>
        <div className="modal-footer">
          <button className="btn" ref={cancelRef} onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-danger" onClick={onConfirm}>
            {confirmLabel ?? t('common.delete')}
          </button>
        </div>
      </div>
    </>,
    document.body,
  )
}
