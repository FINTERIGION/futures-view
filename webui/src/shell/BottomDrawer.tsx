import { useTranslation } from 'react-i18next'
import { Icon } from '../components/Icon'
import type { TabItem } from '../components/Tabs'
import { Tabs } from '../components/Tabs'
import { AlertPanel } from '../panels/AlertPanel'
import { BacktestPanel } from '../panels/BacktestPanel'
import { HistoryPanel } from '../panels/HistoryPanel'
import { useDrawerResize } from './useDrawerResize'
import type { DrawerTab } from './WorkspaceContext'
import { useWorkspace } from './WorkspaceContext'

/**
 * Not a variant of `components/Drawer` -- that one is a modal, right-side
 * portal with a backdrop, and the bottom drawer must never be modal: the
 * chart above it stays interactive (zoomable, hoverable) while this is
 * open. Alert, Backtest and History are tabs here rather than routes, so switching
 * between them no longer costs whatever the previous tab's page held in
 * state -- notably a live job's SSE stream, now held one level up in
 * `JobsProvider` instead of inside whichever panel started it.
 */
export function BottomDrawer() {
  const { t } = useTranslation()
  const { drawerTab, setDrawerTab, drawerCollapsed, setDrawerCollapsed, drawerHeight, setDrawerHeight, backtestPrefill } =
    useWorkspace()
  const { onPointerDown, onHandleKeyDown } = useDrawerResize(drawerHeight, setDrawerHeight)

  const tabs: TabItem[] = [
    { key: 'alerts', label: t('workspace.tabAlert') },
    { key: 'backtest', label: t('workspace.tabBacktest') },
    { key: 'runs', label: t('workspace.tabRuns') },
  ]

  // The toggle button stays in the exact same slot (far right of this row)
  // whether collapsed or not, and just flips via CSS rotation -- so
  // collapsing and expanding read as one reversible action, not two
  // differently-placed controls.
  if (drawerCollapsed) {
    return (
      <div className="bdrawer bdrawer-collapsed">
        <div className="bdrawer-tabbar">
          <span className="bdrawer-collapsed-label">{tabs.find((x) => x.key === drawerTab)?.label}</span>
          <div className="spacer" />
          <button
            className="btn btn-sm btn-ghost btn-icon bdrawer-toggle is-collapsed"
            onClick={() => setDrawerCollapsed(false)}
            title={t('workspace.expandDrawer')}
            aria-label={t('workspace.expandDrawer')}
          >
            <Icon name="chevron-down" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="bdrawer" style={{ height: 'var(--drawer-h)' }}>
      {/* A real button, not a bare div: the drag target is also the only way
          to resize this from a keyboard, and arrow keys on it move the edge
          the same way the pointer does. */}
      <button
        type="button"
        className="bdrawer-handle"
        onPointerDown={onPointerDown}
        onKeyDown={onHandleKeyDown}
        title={t('workspace.resizeDrawer')}
        aria-label={t('workspace.resizeDrawer')}
        role="separator"
        aria-orientation="horizontal"
        aria-valuenow={Math.round(drawerHeight)}
      />
      <div className="bdrawer-tabbar">
        <Tabs items={tabs} active={drawerTab} onChange={(k) => setDrawerTab(k as DrawerTab)} />
        <div className="spacer" />
        <button
          className="btn btn-sm btn-ghost btn-icon bdrawer-toggle"
          onClick={() => setDrawerCollapsed(true)}
          title={t('workspace.collapseDrawer')}
          aria-label={t('workspace.collapseDrawer')}
        >
          <Icon name="chevron-down" />
        </button>
      </div>
      <div className="bdrawer-body">
        {/* Remounted (`key={seq}`) whenever a new prefill arrives -- see
            BacktestPanel's own doc comment for why that has to be a remount
            rather than a prop change an effect reacts to. */}
        {drawerTab === 'backtest' && <BacktestPanel key={backtestPrefill?.seq ?? 0} prefill={backtestPrefill?.value} />}
        {drawerTab === 'alerts' && <AlertPanel />}
        {drawerTab === 'runs' && <HistoryPanel />}
      </div>
    </div>
  )
}
