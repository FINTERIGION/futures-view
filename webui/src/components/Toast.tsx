import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from './Icon'

export type ToastKind = 'success' | 'error' | 'info'

export interface Toast {
  id: number
  kind: ToastKind
  title: string
  message?: string
}

interface ToastApi {
  /** Show a toast. Returns nothing on purpose -- a caller that wants to take
   * the message back should not have raised it as a toast. */
  push: (toast: Omit<Toast, 'id'>) => void
}

const ToastContext = createContext<ToastApi | null>(null)

const ICONS: Record<ToastKind, IconName> = {
  success: 'success',
  error: 'alert',
  info: 'info',
}

/** How long a toast stays up. Errors linger: they usually carry a server
 * message worth reading twice, and there is no other copy of it on screen. */
const TTL: Record<ToastKind, number> = {
  success: 4000,
  error: 9000,
  info: 6000,
}

/**
 * Transient, corner-of-the-screen notices.
 *
 * This replaces the `window.alert` calls the run list used to make. An alert
 * blocks the whole tab -- including the SSE stream of any job still running
 * behind it -- until it is dismissed, it cannot be styled, and it says
 * "localhost:8888 says" above whatever the server actually reported. It is
 * also the wrong shape for the two things this panel needs to announce: a
 * request the server refused, and a job that finished while the viewer was
 * looking at a different tab. Neither is a question.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)
  // Cleared on unmount so a timer cannot fire into a torn-down tree -- the
  // usual "setState on an unmounted component" leak in test runs, where a
  // provider is mounted and dropped once per case.
  const timers = useRef<number[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id))
  }, [])

  const push = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = nextId.current++
      setToasts((prev) => [...prev, { ...toast, id }])
      timers.current.push(window.setTimeout(() => dismiss(id), TTL[toast.kind]))
    },
    [dismiss],
  )

  useEffect(
    () => () => {
      timers.current.forEach((timer) => window.clearTimeout(timer))
    },
    [],
  )

  const api = useMemo(() => ({ push }), [push])

  return (
    <ToastContext.Provider value={api}>
      {children}
      {toasts.length > 0 &&
        createPortal(
          // `polite`, not `alert`: these announce completed work, and an
          // assertive live region interrupts whatever a screen reader is
          // already in the middle of saying.
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

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within a ToastProvider')
  return ctx
}
