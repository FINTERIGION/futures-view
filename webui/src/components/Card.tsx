import type { ReactNode } from 'react'

export function Card({
  title,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`card ${className}`.trim()}>
      {title && (
        <div className="card-header">
          <h3>{title}</h3>
          {actions}
        </div>
      )}
      <div className="card-body">{children}</div>
    </div>
  )
}
