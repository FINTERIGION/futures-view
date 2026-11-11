import { useQueries, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError, errorMessage } from '../api/client'
import { indicatorsApi, productsApi, runsApi } from '../api/endpoints'
import type { IndicatorInfo, IndicatorValues, RunDetail } from '../api/types'
import { MAX_SUB_PANES, superChartOption, type IndicatorLayer, type PaneKey } from '../charts/superChartOption'
import { EChart } from '../components/EChart'
import { Icon } from '../components/Icon'
import { useIsDarkMode } from '../theme/useIsDarkMode'
import { useWorkspace } from '../shell/WorkspaceContext'
import { ChartToolbar } from './ChartToolbar'
import { activeOverrides } from './indicatorParams'

function combineIndicatorQueries(results: Array<{ data: IndicatorValues | undefined; error: Error | null }>) {
  return results.map((r) => ({ data: r.data, error: r.error }))
}

/**
 * The main screen: one product's OI-weighted daily candlestick, always
 * loaded from `/products/{code}/bars` (the full history) rather than a
 * run's own price arrays -- the chart's identity is "this product's daily
 * chart" whether or not a run is overlaid, so it must render before any run
 * exists and must not jump when one is added or cleared. A run contributes
 * only its fill signals and its window (shaded via `markArea`) -- its
 * equity curve and trade log render in the backtest panel instead (see
 * panels/ResultTables.tsx).
 */
export function SuperChart() {
  const { t } = useTranslation()
  const dark = useIsDarkMode()
  const { chartSymbol, setChartSymbol, showVolume, indicators, indicatorParams, setIndicatorParams, runId, setRunId } =
    useWorkspace()

  // The catalog is what says whether a selected indicator draws on the price
  // pane or in its own, so it is fetched whether or not anything is selected.
  const { data: catalog } = useQuery({
    queryKey: ['indicators'],
    queryFn: indicatorsApi.list,
    staleTime: 5 * 60 * 1000,
  })

  // Only indicators the catalog still knows about and can draw. A key left in
  // localStorage for a class the user has since deleted or broken is dropped
  // here rather than becoming an empty pane.
  const selected: IndicatorInfo[] = useMemo(
    () =>
      (indicators ?? [])
        .map((key) => (catalog ?? []).find((c) => c.key === key))
        .filter((info): info is IndicatorInfo => Boolean(info) && info!.errors.length === 0),
    [indicators, catalog],
  )

  // The params are part of the key, so each set is cached on its own and
  // flipping back to one already fetched redraws without a request. The
  // editor seeds this same key when its server check succeeds -- see
  // chart/IndicatorParamsEditor.tsx.
  const overridesOf = (info: IndicatorInfo) => activeOverrides(info, indicatorParams[info.key])
  const indicatorQueries = useMemo(
    () =>
      selected.map((info) => {
        const params = activeOverrides(info, indicatorParams[info.key])
        return {
          queryKey: ['indicator', chartSymbol, info.key, params],
          queryFn: () => indicatorsApi.values(chartSymbol, info.key, params),
          enabled: Boolean(chartSymbol),
          staleTime: 5 * 60 * 1000,
          retry: false,
        }
      }),
    [selected, indicatorParams, chartSymbol],
  )
  const values = useQueries({ queries: indicatorQueries, combine: combineIndicatorQueries })

  const layers: IndicatorLayer[] = useMemo(
    () =>
      selected.map((info, i) => ({
        info,
        params: { ...info.params, ...activeOverrides(info, indicatorParams[info.key]) },
        // `null` while in flight: the pane is laid out from the *selection*, so
        // panes do not shuffle as each query resolves one after another.
        values: values[i]?.data ?? null,
      })),
    [selected, indicatorParams, values],
  )

  // The router turns a user's raising `compute()` into a 422 carrying their
  // own exception message, which is the whole point of that handler -- with
  // `retry: false` and nothing reading `.error`, it would arrive and then be
  // thrown away, leaving a permanently blank pane and no explanation.
  const failed = selected
    .map((info, i) => ({ info, error: values[i]?.error ?? null }))
    .filter((e) => e.error !== null)

  // Derived, never persisted -- `pane` belongs to the Python class and can
  // change under a hot reload. Capped the same way the builder caps it, so
  // the "too many panes" message matches what is actually drawn.
  // Volume keeps the slot directly under the price pane whatever else is
  // ticked -- it is read against the candles, and it does not count against
  // `MAX_SUB_PANES`, which is about how many *indicator* panes still leave the
  // price pane readable.
  const subPanes = useMemo(
    () => selected.filter((info) => info.pane === 'sub').map((info) => `ind:${info.key}` as PaneKey),
    [selected],
  )
  const allPanes: PaneKey[] = useMemo(
    () => [
      ...(showVolume ? (['volume'] as PaneKey[]) : []),
      ...subPanes.slice(0, MAX_SUB_PANES),
    ],
    [showVolume, subPanes],
  )
  const hiddenPanes = Math.max(0, subPanes.length - MAX_SUB_PANES)

  // An indicator whose window is longer than the loaded history computes to
  // all-NaN and would otherwise draw nothing, with no hint as to why.
  const starved = layers
    .filter((l) => l.values && Object.values(l.values.outputs).every((o) => o.valid_from === null))
    .map((l) => l.info.label)

  const { data: barsData, isLoading: barsLoading, error: barsError } = useQuery({
    queryKey: ['product-bars', chartSymbol],
    queryFn: () => productsApi.bars(chartSymbol),
    enabled: Boolean(chartSymbol),
    staleTime: 5 * 60 * 1000,
  })
  const { data: rollData } = useQuery({
    queryKey: ['product-roll', chartSymbol],
    queryFn: () => productsApi.roll(chartSymbol),
    enabled: Boolean(chartSymbol),
    staleTime: 5 * 60 * 1000,
  })

  const { data: run, error: runError } = useQuery<RunDetail>({
    queryKey: ['run', runId],
    queryFn: () => runsApi.get(runId as string),
    enabled: runId !== null,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })

  // A run id that has aged out of the store (RUN_RETENTION rolls the index)
  // or was deleted 404s instead of loading -- strip it from the URL rather
  // than leaving a broken overlay chip pointing at nothing.
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
  const roll = rollData?.roll
  const signals = price?.signals
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
          })
        : null,
    [dark, bars, allPanes, roll, signals, runWindow, layers],
  )

  if (!chartSymbol) {
    return (
      <div className="chart-area">
        <ChartToolbar />
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

  // Before the loading branch, and checked on its own rather than folded into
  // it: a failed fetch leaves `barsData` undefined with `barsLoading` already
  // back to false, so `barsLoading || !barsData` matches a dead query just as
  // readily as a live one. A product whose history has never been downloaded
  // 404s here, and it sat under "Loading…" forever instead of saying so.
  if (barsError) {
    const isMissing = barsError instanceof ApiError && barsError.status === 404
    return (
      <div className="chart-area">
        <ChartToolbar />
        <div className="empty-state">
          <span className="empty-state-icon">
            <Icon name={isMissing ? 'download' : 'alert'} size={18} />
          </span>
          <span className="empty-state-title">
            {isMissing ? t('workspace.noDataForSymbol') : errorMessage(barsError)}
          </span>
          {isMissing && <p className="empty-state-hint">{t('workspace.noDataForSymbolHint')}</p>}
        </div>
      </div>
    )
  }

  if (barsLoading || !barsData || !option) {
    return (
      <div className="chart-area">
        <ChartToolbar />
        <div className="empty-state">
          <span className="spinner" />
          {t('common.loading')}
        </div>
      </div>
    )
  }

  return (
    <div className="chart-area">
      <ChartToolbar />
      {/* Every banner over the chart shares one gutter (.chart-notices) rather
          than carrying its own inline margin -- with four of them able to
          stack, the spacing had to be a property of the stack. */}
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
              {/* Saved params the class now refuses -- it narrowed a range
                  or added a constraint under a reload -- are the one cause
                  of this banner the user can clear from here. */}
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
        <EChart option={option} preserveDataZoom />
      </div>
    </div>
  )
}
