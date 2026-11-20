import { createContext, useContext } from 'react'

export type ToastKind = 'success' | 'error' | 'info'

export interface Toast {
  id: number
  kind: ToastKind
  title: string
  message?: string
}

export interface ToastApi {
  /** Show a toast. Returns nothing on purpose -- a caller that wants to take
   * the message back should not have raised it as a toast. */
  push: (toast: Omit<Toast, 'id'>) => void
}

export const ToastContext = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within a ToastProvider')
  return ctx
}
