import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { alertsApi } from '../api/endpoints'
import { Icon } from '../components/Icon'
import { ThemeToggle } from '../components/ThemeToggle'
import { useJobs, type JobSlot } from './jobsStore'
import { useWorkspace } from './workspaceStore'

const LANGS: { code: string; label: string }[] = [
  { code: 'en', label: 'EN' },
  { code: 'zh', label: '中文' },
]

const SLOT_LABEL_KEY: Record<JobSlot, string> = {
  backtest: 'workspace.tabBacktest',
  data: 'data.title',
  alert: 'workspace.tabAlert',
  dispatch: 'alerts.notify.jobLabel',
}

export function WorkspaceTopBar({
  productName,
  onShowNotify,
  onShowShortcuts,
  onShowAccess,
}: {
  productName?: string
  onShowNotify: () => void
  onShowShortcuts: () => void
  onShowAccess: () => void
}) {
  const { t, i18n } = useTranslation()
  const { chartSymbol, setDrawerTab, setDrawerCollapsed, setSidebarOpen } = useWorkspace()
  const jobs = useJobs()
  const { data: schedule } = useQuery({
    queryKey: ['alert-schedule'],
    queryFn: alertsApi.getSchedule,
  })

  const activePills = (['backtest', 'data', 'alert', 'dispatch'] as const)
    .map((slot) => ({ slot, state: jobs[slot].state, lost: jobs[slot].lost }))
    .filter((j) => !j.lost && j.state && ['queued', 'running'].includes(j.state.status))

  const openJob = (slot: JobSlot) => {
    if (slot === 'data') {
      setSidebarOpen(true)
      return
    }
    if (slot === 'dispatch') {
      onShowNotify()
      return
    }
    setDrawerTab(slot === 'backtest' ? 'backtest' : 'alerts')
    setDrawerCollapsed(false)
  }

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <span className="brand">
          <span className="brand-mark">
            <Icon name="candles" size={15} />
          </span>
          <span className="brand-name">FuturesView</span>
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
        <div className="topbar-jobs">
          {activePills.map(({ slot, state }) => (
            <button
              type="button"
              key={slot}
              className="job-pill"
              title={state!.message}
              aria-label={`${t(SLOT_LABEL_KEY[slot])} ${Math.round(state!.progress * 100)}%`}
              onClick={() => openJob(slot)}
            >
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
            </button>
          ))}
        </div>

        <div className="topbar-actions">
          <button
            className="btn btn-sm btn-ghost btn-icon topbar-notify-btn"
            onClick={onShowNotify}
            title={
              schedule?.enabled && schedule.times.length > 0
                ? t('alerts.notify.topbarActive', { times: schedule.times.join(', ') })
                : t('alerts.notify.topbarTitle')
            }
            aria-label={t('alerts.notify.topbarTitle')}
          >
            <Icon name="bell" />
            {schedule?.enabled && <span className="topbar-icon-dot" aria-hidden="true" />}
          </button>

          <button
            className="btn btn-sm btn-ghost btn-icon"
            onClick={onShowAccess}
            title={t('auth.access')}
            aria-label={t('auth.access')}
          >
            <Icon name="lock" />
          </button>

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
      </div>
    </header>
  )
}
