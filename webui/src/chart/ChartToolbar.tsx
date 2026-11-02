import { useTranslation } from 'react-i18next'
import { Icon } from '../components/Icon'
import { useJobSlot } from '../shell/JobsProvider'
import { useWorkspace } from '../shell/WorkspaceContext'
import { IndicatorPicker } from './IndicatorPicker'

export function ChartToolbar() {
  const { t } = useTranslation()
  const { runId, setRunId } = useWorkspace()
  const job = useJobSlot('backtest')

  /** Leave the backtest view entirely: the run comes off the chart, and the
   * drawer's result tables and finished-job block go with it. Dropping the
   * job is what makes the button hold. BacktestPanel puts a *done* job's run
   * back on the chart on its own (that is how a run just launched gets
   * overlaid at all), so clearing only the `run` URL param left a finished
   * job behind to re-apply it -- the button looked dead. A job still running
   * is left alone: it has a result on the way and overlays it when it lands.
   */
  const exitBacktest = () => {
    setRunId(null)
    if (!job.isActive) job.reset()
  }

  return (
    <div className="chart-toolbar">
      <div className="spacer" />
      {/* Volume used to be a toolbar button of its own, next to this picker.
          It is a tick inside the picker now: from the reader's side it is one
          more series on the chart, so "what is drawn here" is one list and
          one button, not a list plus a stray toggle. */}
      <IndicatorPicker />
      {runId && (
        <button className="btn btn-sm" onClick={exitBacktest}>
          <Icon name="close" size={13} />
          {t('workspace.exitBacktest')}
        </button>
      )}
    </div>
  )
}
