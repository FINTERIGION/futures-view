import { useQueries, useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError, errorMessage } from '../api/client'
import { dataApi, indicatorsApi, productsApi, runsApi } from '../api/endpoints'
import type { IndicatorInfo, IndicatorValues, RunDetail } from '../api/types'
import { nearestCategory } from '../charts/align'
import {
  MAX_SUB_PANES,
  superChartOption,
  type ChartTooltipLabels,
  type IndicatorLayer,
  type PaneKey,
} from '../charts/superChartOption'
import { EChart, type ZoomCommand } from '../components/EChart'
import { Icon } from '../components/Icon'
import { useToast } from '../components/toastStore'
import { useJobSlot } from '../shell/jobsStore'
import { useWorkspace } from '../shell/workspaceStore'
import { useIsDarkMode } from '../theme/useIsDarkMode'
import { ChartToolbar } from './ChartToolbar'
import { activeOverrides } from './indicatorParams'

function combineIndicatorQueries(results: Array<{ data: IndicatorValues | undefined; error: Error | null }>) {
  return results.map((r) => ({ data: r.data, error: r.error }))
}

function dateWindowToPercent(dates: string[], startDate: string, endDate: string, padBars: number): { start: number; end: number } | null {
  if (dates.length === 0) return null
  const sCat = nearestCategory(dates, startDate, 'ceil') ?? dates[0]
  const eCat = nearestCategory(dates, endDate, 'floor') ?? dates[dates.length - 1]
  const sIdx = Math.max(0, dates.indexOf(sCat) - padBars)
  const eIdx = Math.min(dates.length - 1, Math.max(sIdx, dates.indexOf(eCat)) + padBars)
  const last = Math.max(1, dates.length - 1)
  return {
    start: (sIdx / last) * 100,
    end: (eIdx / last) * 100,
  }
}

export function SuperChart() {
  const { t, i18n } = useTranslation()
  const dark = useIsDarkMode()
  const toast = useToast()
  const dataJob = useJobSlot('data')
  const {
    chartSymbol,
    setChartSymbol,
    chartSeries,
    setChartSeries,
    chartFocus,
    showVolume,
    indicators,
    indicatorParams,
    setIndicatorParams,
    runId,
    setRunId,
  } = useWorkspace()

  const [zoomCommand, setZoomCommand] = useState<ZoomCommand | null>(null)
  const [downloading, setDownloading] = useState(false)
  const zoomSeqRef = useRef(0)
  const appliedFocusSeqRef = useRef(0)

  const { data: products } = useQuery({ queryKey: ['products'], queryFn: productsApi.list })
  const chartedProduct = useMemo(
    () => products?.find((p) => p.code === chartSymbol),
    [products, chartSymbol],
  )

  const { data: catalog } = useQuery({
    queryKey: ['indicators'],
    queryFn: indicatorsApi.list,
    staleTime: 5 * 60 * 1000,
  })

  const selected: IndicatorInfo[] = useMemo(
    () =>
      (indicators ?? [])
        .map((key) => (catalog ?? []).find((c) => c.key === key))
        .filter((info): info is IndicatorInfo => Boolean(info) && info!.errors.length === 0),
    [indicators, catalog],
  )

  const overridesOf = (info: IndicatorInfo) => activeOverrides(info, indicatorParams[info.key])
  const indicatorQueries = useMemo(
    () =>
      selected.map((info) => {
        const params = activeOverrides(info, indicatorParams[info.key])
        return {
          queryKey: ['indicator', chartSymbol, chartSeries, info.key, params],
          queryFn: () =>
            chartSeries === 'weighted'
              ? indicatorsApi.values(chartSymbol, info.key, params)
              : indicatorsApi.values(chartSymbol, info.key, params, undefined, undefined, chartSeries),
          enabled: Boolean(chartSymbol),
          staleTime: 5 * 60 * 1000,
          retry: false,
        }
      }),
    [selected, indicatorParams, chartSymbol, chartSeries],
  )
  const values = useQueries({ queries: indicatorQueries, combine: combineIndicatorQueries })

  const layers: IndicatorLayer[] = useMemo(
    () =>
      selected.map((info, i) => ({
        info,
        params: { ...info.params, ...activeOverrides(info, indicatorParams[info.key]) },
        values: values[i]?.data ?? null,
      })),
    [selected, indicatorParams, values],
  )

  const failed = selected
    .map((info, i) => ({ info, error: values[i]?.error ?? null }))
    .filter((e) => e.error !== null)

  const subPanes = useMemo(
    () => selected.filter((info) => info.pane === 'sub').map((info) => `ind:${info.key}` as PaneKey),
    [selected],
  )
  const allPanes: PaneKey[] = useMemo(
    () => [...(showVolume ? (['volume'] as PaneKey[]) : []), ...subPanes.slice(0, MAX_SUB_PANES)],
    [showVolume, subPanes],
  )
  const hiddenPanes = Math.max(0, subPanes.length - MAX_SUB_PANES)

  const starved = layers
    .filter((l) => l.values && Object.values(l.values.outputs).every((o) => o.valid_from === null))
    .map((l) => l.info.label)

  const { data: barsData, isLoading: barsLoading, error: barsError } = useQuery({
    queryKey: ['product-bars', chartSymbol, chartSeries],
    queryFn: () =>
      chartSeries === 'weighted'
        ? productsApi.bars(chartSymbol)
        : productsApi.bars(chartSymbol, undefined, undefined, chartSeries),
    enabled: Boolean(chartSymbol),
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
  const { data: rollData } = useQuery({
    queryKey: ['product-roll', chartSymbol],
    queryFn: () => productsApi.roll(chartSymbol),
    enabled: Boolean(chartSymbol) && chartSeries === 'weighted',
    staleTime: 5 * 60 * 1000,
  })

  const { data: run, error: runError } = useQuery<RunDetail>({
    queryKey: ['run', runId],
    queryFn: () => runsApi.get(runId as string),
    enabled: runId !== null,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })

  useEffect(() => {
    if (runError instanceof ApiError && runError.status === 404) setRunId(null)
  }, [runError, setRunId])

  const symbolHasPrice = Boolean(run?.symbols_with_price.includes(chartSymbol))
  const { data: price } = useQuery({
    queryKey: ['run-price', runId, chartSymbol],
    queryFn: () => runsApi.price(runId as string, chartSymbol),
    enabled: runId !== null && symbolHasPrice,
    staleTime: 5 * 60 * 1000,
  })

  const runStart = run?.start ?? null
  const runEnd = run?.end ?? null
  const runWindow = useMemo(
    () => (runStart && runEnd ? { start: runStart, end: runEnd } : null),
    [runStart, runEnd],
  )
  const bars = barsData?.bars
  const roll = chartSeries === 'weighted' ? rollData?.roll : undefined
  const signals = price?.signals

  const tooltipLabels: ChartTooltipLabels = useMemo(
    () => ({
      open: t('workspace.chartOpen'),
      close: t('workspace.chartClose'),
      low: t('workspace.chartLow'),
      high: t('workspace.chartHigh'),
      volume: t('workspace.paneVolume'),
    }),
    // Only recompute when active language changes so `option` stays stable across tab switches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [i18n.resolvedLanguage],
  )

  const option = useMemo(
    () =>
      bars
        ? superChartOption({
            dark,
            bars,
            panes: allPanes,
            roll,
            signals,
            window: runWindow,
            indicators: layers,
            labels: tooltipLabels,
          })
        : null,
    [dark, bars, allPanes, roll, signals, runWindow, layers, tooltipLabels],
  )

  // Apply cross-panel zoom request (e.g. clicking a trade row in Backtest Results)
  // once bars for the target symbol have arrived.
  useEffect(() => {
    if (!chartFocus || chartFocus.seq === appliedFocusSeqRef.current) return
    if (!bars || bars.length === 0 || barsData?.symbol !== chartFocus.value.symbol) return
    const range = dateWindowToPercent(
      bars.map((b) => b.date),
      chartFocus.value.startDate,
      chartFocus.value.endDate,
      18,
    )
    if (!range) return
    appliedFocusSeqRef.current = chartFocus.seq
    zoomSeqRef.current += 1
    setZoomCommand({ ...range, seq: zoomSeqRef.current })
  }, [chartFocus, bars, barsData?.symbol])

  const focusRunWindow = useCallback(() => {
    if (!bars || bars.length === 0 || !runWindow) return
    const range = dateWindowToPercent(
      bars.map((b) => b.date),
      runWindow.start,
      runWindow.end,
      10,
    )
    if (!range) return
    zoomSeqRef.current += 1
    setZoomCommand({ ...range, seq: zoomSeqRef.current })
  }, [bars, runWindow])

  const downloadMissing = async () => {
    if (!chartSymbol || downloading || dataJob.isActive) return
    setDownloading(true)
    try {
      const { job_id } = await dataApi.update([chartSymbol], false, false)
      dataJob.start(job_id)
    } catch (err) {
      toast.push({ kind: 'error', title: t('common.updateFailed'), message: errorMessage(err) })
    } finally {
      setDownloading(false)
    }
  }

  const latestBar = bars && bars.length > 0 ? bars[bars.length - 1] : null
  const prevBar = bars && bars.length > 1 ? bars[bars.length - 2] : null
  const activeContract =
    latestBar?.contract ?? (roll && roll.length > 0 ? roll[roll.length - 1].contract : null)

  const toolbar = (
    <ChartToolbar
      product={chartedProduct}
      latestBar={latestBar}
      prevBar={prevBar}
      activeContract={activeContract}
      activeIndicators={selected}
      run={run}
      onFocusRunWindow={runWindow && bars && bars.length > 0 ? focusRunWindow : undefined}
    />
  )

  if (!chartSymbol) {
    return (
      <div className="chart-area">
        {toolbar}
        <div className="empty-state">
          <span className="empty-state-icon">
            <Icon name="line-chart" size={18} />
          </span>
          <span className="empty-state-title">{t('workspace.noProducts')}</span>
          <p className="empty-state-hint">{t('workspace.noProductsHint')}</p>
        </div>
      </div>
    )
  }

  if (barsError) {
    const isMissing = barsError instanceof ApiError && barsError.status === 404
    const isSeriesUnavailable = chartSeries !== 'weighted' && barsError instanceof ApiError && barsError.status === 400
    return (
      <div className="chart-area">
        {toolbar}
        <div className="empty-state">
          <span className="empty-state-icon">
            <Icon name={isMissing ? 'download' : 'alert'} size={18} />
          </span>
          <span className="empty-state-title">
            {isMissing ? t('workspace.noDataForSymbol') : errorMessage(barsError)}
          </span>
          {isMissing && (
            <>
              <p className="empty-state-hint">{t('workspace.noDataForSymbolHint')}</p>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={downloading || dataJob.isActive}
                onClick={() => void downloadMissing()}
              >
                <Icon name="download" size={14} />
                {t('data.updateOne', { code: chartSymbol })}
              </button>
            </>
          )}
          {isSeriesUnavailable && (
            <button type="button" className="btn btn-sm" onClick={() => setChartSeries('weighted')}>
              {t('workspace.backToWeighted')}
            </button>
          )}
        </div>
      </div>
    )
  }

  if (barsLoading || !barsData || !option) {
    return (
      <div className="chart-area">
        {toolbar}
        <div className="empty-state">
          <span className="spinner" />
          {t('common.loading')}
        </div>
      </div>
    )
  }

  return (
    <div className="chart-area">
      {toolbar}
      {(Boolean(run && !symbolHasPrice) || failed.length > 0 || starved.length > 0 || hiddenPanes > 0) && (
        <div className="chart-notices">
          {run && !symbolHasPrice && (
            <div className="hint-banner">
              <Icon name="info" />
              <span>{t('workspace.runNotOnThisSymbol')}</span>
              {run.symbols[0] && (
                <button className="btn btn-sm" onClick={() => setChartSymbol(run.symbols[0])}>
                  {t('workspace.chartThisRunsSymbol', { symbol: run.symbols[0] })}
                </button>
              )}
            </div>
          )}
          {failed.map(({ info, error }) => (
            <div key={info.key} className="hint-banner warning">
              <Icon name="alert" />
              <span>{t('workspace.indicatorFailed', { name: info.label, message: errorMessage(error) })}</span>
              {Object.keys(overridesOf(info)).length > 0 && (
                <button className="btn btn-sm" onClick={() => setIndicatorParams(info.key, {})}>
                  {t('workspace.resetIndicatorParams')}
                </button>
              )}
            </div>
          ))}
          {starved.length > 0 && (
            <div className="hint-banner">
              <Icon name="info" />
              <span>{t('workspace.indicatorNeedsMoreBars', { names: starved.join(', ') })}</span>
            </div>
          )}
          {hiddenPanes > 0 && (
            <div className="hint-banner">
              <Icon name="info" />
              <span>{t('workspace.tooManyIndicatorPanes', { count: hiddenPanes, max: MAX_SUB_PANES })}</span>
            </div>
          )}
        </div>
      )}
      <div className="super-chart-canvas">
        <EChart option={option} preserveDataZoom zoomCommand={zoomCommand} />
      </div>
    </div>
  )
}
