import { useTranslation } from 'react-i18next'
import { Icon } from '../components/Icon'
import { ThemeToggle } from '../components/ThemeToggle'
import { useJobs } from './JobsProvider'
import { useWorkspace } from './WorkspaceContext'

const LANGS: { code: string; label: string }[] = [
  { code: 'en', label: 'EN' },
  { code: 'zh', label: '中文' },
]

const SLOT_LABEL_KEY = {
  backtest: 'workspace.tabBacktest',
  data: 'data.title',
  alert: 'workspace.tabAlert',
} as const

export function WorkspaceTopBar({
  productName,
  onShowShortcuts,
}: {
  productName?: string
  onShowShortcuts: () => void
}) {
  const { t, i18n } = useTranslation()
  const { chartSymbol } = useWorkspace()
  const jobs = useJobs()

  const activePills = (['backtest', 'data', 'alert'] as const)
    .map((slot) => ({ slot, state: jobs[slot].state }))
    .filter((j) => j.state && ['queued', 'running'].includes(j.state.status))

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <span className="brand">
          <span className="brand-mark">
            <Icon name="candles" size={15} />
          </span>
          FuturesView
        </span>

        {chartSymbol && (
          <>
            <span className="topbar-divider" />
            <span className="topbar-symbol">
              <strong>{chartSymbol}</strong>
              {productName && <span className="topbar-symbol-name">{productName}</span>}
            </span>
          </>
        )}

        <div className="spacer" />

        {/* A job's own panel may be behind a collapsed drawer or a tab that is
            not showing, so this is the one place its progress is always
            visible. The bar carries the number; the label never reflows. */}
        {activePills.map(({ slot, state }) => (
          <div key={slot} className="job-pill" title={state!.message}>
            <span className="job-pill-head">
              <span className={`badge ${state!.status === 'running' ? 'badge-accent' : 'badge-neutral'}`}>
                <span className="dot" />
              </span>
              {t(SLOT_LABEL_KEY[slot])}
              <span className="job-pill-pct">{Math.round(state!.progress * 100)}%</span>
            </span>
            <span className="progress-bar">
              <span className="fill" style={{ width: `${Math.round(state!.progress * 100)}%` }} />
            </span>
          </div>
        ))}

        <button
          className="btn btn-sm btn-ghost btn-icon"
          onClick={onShowShortcuts}
          title={t('workspace.shortcuts')}
          aria-label={t('workspace.shortcuts')}
        >
          <Icon name="keyboard" />
        </button>

        <ThemeToggle />

        <div className="segmented" role="group" aria-label={t('workspace.language')}>
          {LANGS.map((l) => (
            <button
              key={l.code}
              type="button"
              className={`segmented-btn ${i18n.resolvedLanguage === l.code ? 'active' : ''}`}
              aria-pressed={i18n.resolvedLanguage === l.code}
              onClick={() => void i18n.changeLanguage(l.code)}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>
    </header>
  )
}
