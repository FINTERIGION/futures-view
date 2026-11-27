import type { MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../components/Icon'
import type { TabItem } from '../components/Tabs'
import { Tabs } from '../components/Tabs'
import { AlertPanel } from '../panels/AlertPanel'
import { BacktestPanel } from '../panels/BacktestPanel'
import { HistoryPanel } from '../panels/HistoryPanel'
import { useDrawerResize } from './useDrawerResize'
import { useWorkspace, type DrawerTab } from './workspaceStore'

export function BottomDrawer() {
  const { t } = useTranslation()
  const {
    drawerTab,
    setDrawerTab,
    drawerCollapsed,
    setDrawerCollapsed,
    drawerMaximized,
    setDrawerMaximized,
    drawerHeight,
    setDrawerHeight,
    backtestPrefill,
  } = useWorkspace()
  const { onPointerDown, onHandleKeyDown } = useDrawerResize(drawerHeight, (next) => {
    if (drawerMaximized) setDrawerMaximized(false)
    setDrawerHeight(next)
  })

  const tabs: TabItem[] = [
    { key: 'backtest', label: t('workspace.tabBacktest') },
    { key: 'alerts', label: t('workspace.tabAlert') },
    { key: 'runs', label: t('workspace.tabRuns') },
  ]

  const selectTab = (key: string) => {
    setDrawerTab(key as DrawerTab)
    if (drawerCollapsed) setDrawerCollapsed(false)
  }

  const onTabbarDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return
    setDrawerCollapsed(!drawerCollapsed)
  }

  if (drawerCollapsed) {
    return (
      <div className="bdrawer bdrawer-collapsed">
        <div className="bdrawer-tabbar" onDoubleClick={onTabbarDoubleClick}>
          <Tabs items={tabs} active={drawerTab} onChange={selectTab} />
          <div className="spacer" />
          <div className="bdrawer-controls">
            <button
              className="btn btn-sm btn-ghost btn-icon bdrawer-toggle is-collapsed"
              onClick={() => setDrawerCollapsed(false)}
              title={t('workspace.expandDrawer')}
              aria-label={t('workspace.expandDrawer')}
            >
              <Icon name="chevron-down" size={15} />
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="bdrawer" style={{ height: 'var(--drawer-h)' }}>
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
      <div className="bdrawer-tabbar" onDoubleClick={onTabbarDoubleClick}>
        <Tabs items={tabs} active={drawerTab} onChange={selectTab} />
        <div className="spacer" />
        <div className="bdrawer-controls">
          <button
            type="button"
            className="btn btn-sm btn-ghost btn-icon"
            onClick={() => setDrawerMaximized(!drawerMaximized)}
            title={drawerMaximized ? t('workspace.restoreDrawer') : t('workspace.maximizeDrawer')}
            aria-label={drawerMaximized ? t('workspace.restoreDrawer') : t('workspace.maximizeDrawer')}
          >
            <Icon name={drawerMaximized ? 'minimize' : 'maximize'} size={14} />
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost btn-icon bdrawer-toggle"
            onClick={() => setDrawerCollapsed(true)}
            title={t('workspace.collapseDrawer')}
            aria-label={t('workspace.collapseDrawer')}
          >
            <Icon name="chevron-down" size={15} />
          </button>
        </div>
      </div>
      <div className={`bdrawer-body${drawerTab === 'backtest' ? ' is-split' : ''}`}>
        {drawerTab === 'backtest' && <BacktestPanel key={backtestPrefill?.seq ?? 0} prefill={backtestPrefill?.value} />}
        {drawerTab === 'alerts' && <AlertPanel />}
        {drawerTab === 'runs' && <HistoryPanel />}
      </div>
    </div>
  )
}
