import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Bar, BarSeries, IndicatorInfo, Product, RunDetail } from '../api/types'
import { Icon } from '../components/Icon'
import { useJobLifecycle, useJobSlot } from '../shell/jobsStore'
import { useWorkspace } from '../shell/workspaceStore'
import { IndicatorPicker } from './IndicatorPicker'

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

function monthSeriesKey(month: number): BarSeries {
  return `m${String(month).padStart(2, '0')}` as BarSeries
}

function monthNumOf(series: BarSeries): number | null {
  if (!series.startsWith('m')) return null
  const n = Number(series.slice(1))
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null
}

export function ChartToolbar({
  product,
  latestBar,
  prevBar,
  activeContract,
  activeIndicators = [],
  run,
  onFocusRunWindow,
}: {
  product?: Product
  latestBar?: Bar | null
  prevBar?: Bar | null
  activeContract?: string | null
  activeIndicators?: IndicatorInfo[]
  run?: RunDetail | null
  onFocusRunWindow?: () => void
}) {
  const { t } = useTranslation()
  const { chartSymbol, setChartSymbol, chartSeries, setChartSeries, toggleIndicator, runId, setRunId } = useWorkspace()
  const job = useJobSlot('backtest')
  const lifecycle = useJobLifecycle()
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!moreOpen) return
    const onPointerDown = (e: MouseEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [moreOpen])

  const exitBacktest = () => {
    setRunId(null)
    if (!job.isActive) {
      lifecycle.clearPendingBacktestRun()
      job.reset()
    }
  }

  const mainMonths = product?.roll?.main_months ?? [1, 5, 9]
  const inlineMonths = mainMonths.length <= 4 ? mainMonths : []
  const selectedMonth = monthNumOf(chartSeries)
  const isMoreMonthActive = selectedMonth !== null && !inlineMonths.includes(selectedMonth)

  // Latest daily bar HUD figures
  const latestClose = typeof latestBar?.close === 'number' && Number.isFinite(latestBar.close) ? latestBar.close : null
  const refClose =
    typeof prevBar?.close === 'number' && Number.isFinite(prevBar.close)
      ? prevBar.close
      : typeof latestBar?.open === 'number' && Number.isFinite(latestBar.open)
        ? latestBar.open
        : null
  const pctChange =
    latestClose !== null && refClose !== null && refClose > 0 ? ((latestClose - refClose) / refClose) * 100 : null

  return (
    <div className="chart-toolbar">
      {chartSymbol && (
        <div className="series-switcher" role="group" aria-label={t('workspace.contractSeries')}>
          <button
            type="button"
            className={`series-btn ${chartSeries === 'weighted' ? 'active' : ''}`}
            aria-pressed={chartSeries === 'weighted'}
            onClick={() => setChartSeries('weighted')}
            title={t('workspace.seriesWeightedHint')}
          >
            {t('workspace.seriesWeighted')}
          </button>
          <button
            type="button"
            className={`series-btn ${chartSeries === 'main' ? 'active' : ''}`}
            aria-pressed={chartSeries === 'main'}
            onClick={() => setChartSeries('main')}
            title={t('workspace.seriesMainHint')}
          >
            {t('workspace.seriesMain')}
          </button>
          {inlineMonths.map((m) => {
            const key = monthSeriesKey(m)
            const mm = String(m).padStart(2, '0')
            return (
              <button
                key={key}
                type="button"
                className={`series-btn ${chartSeries === key ? 'active' : ''}`}
                aria-pressed={chartSeries === key}
                onClick={() => setChartSeries(key)}
                title={t('workspace.seriesMonthHint', { month: mm })}
              >
                {t('workspace.seriesMonthShort', { month: mm })}
              </button>
            )
          })}
          <div className="series-more" ref={moreRef}>
            <button
              type="button"
              className={`series-btn ${isMoreMonthActive ? 'active' : ''}`}
              aria-expanded={moreOpen}
              aria-haspopup="true"
              aria-label={t('workspace.seriesMoreMonths')}
              title={t('workspace.seriesMoreMonths')}
              onClick={() => setMoreOpen((v) => !v)}
            >
              {isMoreMonthActive && selectedMonth !== null
                ? t('workspace.seriesMonthShort', { month: String(selectedMonth).padStart(2, '0') })
                : inlineMonths.length === 0
                  ? t('workspace.seriesMonthSelect')
                  : null}
              <Icon name="chevron-down" size={12} />
            </button>
            {moreOpen && (
              <div className="series-more-menu" role="dialog" aria-label={t('workspace.seriesMoreMonths')}>
                <div className="series-more-title">{t('workspace.seriesMonthPickerTitle')}</div>
                <div className="series-month-grid">
                  {ALL_MONTHS.map((m) => {
                    const key = monthSeriesKey(m)
                    const mm = String(m).padStart(2, '0')
                    return (
                      <button
                        key={key}
                        type="button"
                        className={`series-month-opt ${chartSeries === key ? 'active' : ''}`}
                        onClick={() => {
                          setChartSeries(key)
                          setMoreOpen(false)
                        }}
                      >
                        {mm}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {latestClose !== null && (
        <div className="chart-hud" aria-label={t('workspace.latestBarSummary')}>
          {activeContract && <span className="chart-hud-contract">{activeContract}</span>}
          <span className="chart-hud-price num">{latestClose.toFixed(2)}</span>
          {pctChange !== null && (
            <span className={`chart-hud-change num ${pctChange >= 0 ? 'is-up' : 'is-down'}`}>
              {pctChange > 0 ? '+' : ''}
              {pctChange.toFixed(2)}%
            </span>
          )}
          {latestBar?.date && <span className="chart-hud-date">{latestBar.date}</span>}
        </div>
      )}

      <div className="spacer" />

      {activeIndicators.length > 0 && (
        <div className="chart-ind-chips">
          {activeIndicators.slice(0, 3).map((info) => (
            <button
              key={info.key}
              type="button"
              className="chart-ind-chip"
              title={t('workspace.removeIndicatorChip', { name: info.label })}
              onClick={() => toggleIndicator(info.key)}
            >
              <span>{info.label}</span>
              <Icon name="close" size={10} />
            </button>
          ))}
        </div>
      )}

      <IndicatorPicker />

      {runId && (
        <div className="run-overlay-pill">
          {run?.strategy && <span className="run-overlay-name" title={run.strategy}>{run.strategy}</span>}
          {run && run.symbols.length > 1 && (
            <select
              className="run-overlay-select"
              aria-label={t('workspace.switchRunSymbol')}
              value={run.symbols.includes(chartSymbol) ? chartSymbol : ''}
              onChange={(e) => {
                if (e.target.value) setChartSymbol(e.target.value)
              }}
            >
              {!run.symbols.includes(chartSymbol) && (
                <option value="" disabled>
                  {chartSymbol}
                </option>
              )}
              {run.symbols.map((sym) => (
                <option key={sym} value={sym}>
                  {sym}
                </option>
              ))}
            </select>
          )}
          {onFocusRunWindow && run?.start && run?.end && (
            <button
              type="button"
              className="btn btn-xs btn-ghost btn-icon"
              onClick={onFocusRunWindow}
              title={t('workspace.focusBacktestWindow')}
              aria-label={t('workspace.focusBacktestWindow')}
            >
              <Icon name="target" size={13} />
            </button>
          )}
          <button type="button" className="btn btn-xs btn-ghost" onClick={exitBacktest}>
            <Icon name="close" size={12} />
            {t('workspace.exitBacktest')}
          </button>
        </div>
      )}
    </div>
  )
}
