import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from './Icon'
import { ToastContext, type Toast, type ToastKind } from './toastStore'

const ICONS: Record<ToastKind, IconName> = {
  success: 'success',
  error: 'alert',
  info: 'info',
}

const TTL: Record<ToastKind, number> = {
  success: 4000,
  error: 9000,
  info: 6000,
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)
  const timers = useRef<Map<number, number>>(new Map())

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timers.current.delete(id)
    }
    setToasts((prev) => prev.filter((toast) => toast.id !== id))
  }, [])

  const push = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = nextId.current++
      setToasts((prev) => [...prev, { ...toast, id }])
      const timer = window.setTimeout(() => {
        timers.current.delete(id)
        setToasts((prev) => prev.filter((t) => t.id !== id))
      }, TTL[toast.kind])
      timers.current.set(id, timer)
    },
    [],
  )

  useEffect(
    () => () => {
      timers.current.forEach((timer) => window.clearTimeout(timer))
      timers.current.clear()
    },
    [],
  )

  const api = useMemo(() => ({ push }), [push])

  return (
    <ToastContext.Provider value={api}>
      {children}
      {toasts.length > 0 &&
        createPortal(
          <div className="toast-stack" role="status" aria-live="polite">
            {toasts.map((toast) => (
              <div key={toast.id} className={`toast toast-${toast.kind}`} onClick={() => dismiss(toast.id)}>
                <span className="toast-icon">
                  <Icon name={ICONS[toast.kind]} />
                </span>
                <span className="toast-text">
                  <span className="toast-title">{toast.title}</span>
                  {toast.message && <span className="toast-message"> {toast.message}</span>}
                </span>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  )
}
