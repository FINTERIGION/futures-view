import type { EChartsOption } from 'echarts'
import type { Bar, IndicatorInfo, IndicatorValues, RollPoint } from '../api/types'
import { CANDLE } from '../theme/palette'
import { nearestCategory } from './align'
import { lineDash, resolveBarColors, resolveColor } from './indicatorColor'
import { baseOption, categoryAxis, chartTokens, valueAxis } from './theme'

/** Panes beyond the always-present price pane, in the order they should
 * stack. `superChartOption` prepends `'price'` itself -- callers only name
 * what they want *added*. Equity/position/drawdown used to live here as run
 * overlays; the equity curve now renders in the backtest panel instead (see
 * panels/ResultTables.tsx), and a run's only contribution to this chart is
 * its buy/sell markers on the price pane.
 *
 * `ind:<key>` is one selected sub-pane indicator. One pane each, never
 * shared: RSI is 0-100, ATR is in price units, and a shared y-axis would
 * flatten one of them against the floor. */
export type PaneKey = 'volume' | `ind:${string}`

const STATIC_WEIGHT: Record<string, number> = {
  price: 3,
  volume: 0.8,
}
const INDICATOR_WEIGHT = 1

/** Vertical weight of one pane -- price gets roughly 3-4x a sub-pane's share
 * of the usable height, regardless of how many sub-panes are open.
 *
 * Deliberately a total function rather than a `Record` lookup: indicator pane
 * keys are open-ended, and a missing entry used to feed `undefined` into the
 * height math and turn the whole layout into NaN. */
const paneWeight = (pane: string): number => STATIC_WEIGHT[pane] ?? INDICATOR_WEIGHT

/** Past this the price pane is too short to read. */
export const MAX_SUB_PANES = 4

/** One selected indicator: what it declared, and its values once they land. */
export interface IndicatorLayer {
  info: IndicatorInfo
  /** `null` while the request is in flight. The pane is still laid out -- it
   * is the *selection* that decides the layout, so panes do not jump around
   * as each query resolves. */
  values: IndicatorValues | null
  /** What it is computed with: the class's defaults with the user's
   * overrides on top, in declared order. Titles its pane; `info.params`
   * when omitted. Passed in rather than read off `values`, so the title is
   * already right while a new set's values are still in flight. */
  params?: Record<string, unknown>
}

export interface SuperChartInput {
  dark: boolean
  /** The charted product's own full-history bars -- always the base series,
   * whether or not a run is overlaid (see chart/SuperChart.tsx). */
  bars: Bar[]
  /** Sub-panes stacked under the always-present price pane, in display order. */
  panes?: PaneKey[]
  roll?: RollPoint[]
  signals?: { date: string; direction: string }[]
  /** The overlaid run's backtest window, shaded on the price pane. */
  window?: { start: string; end: string } | null
  /** Selected indicators, in display order. A `pane: 'main'` entry overlays
   * the price pane; a `pane: 'sub'` entry needs a matching `ind:<key>` in
   * `panes` to be drawn at all. */
  indicators?: IndicatorLayer[]
}

/** The slice of ECharts' `trigger: 'axis'` tooltip params the formatter below
 * reads. ECharts' own `TopLevelFormatterParams` is a union covering every
 * trigger mode, and narrowing it buys nothing here. */
interface TooltipParam {
  seriesIndex: number
  seriesType: string
  seriesName?: string
  dataIndex: number
  marker?: string
  value: unknown
  axisValueLabel?: string
}

/** One day's bar colour, shared by the volume pane and any indicator bar that
 * declares `color: 'candle'`. Red when the close rose or held (close >= open),
 * green when it fell — the Chinese-market candle convention — at the same
 * half opacity the volume bars use. */
const dayBarStyle = (b: Bar) => ({
  color: b.close >= b.open ? CANDLE.up : CANDLE.down,
  opacity: 0.5,
})

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
/** Series names reach the tooltip as raw HTML, and they come from whatever an
 * indicator class declared -- so they are escaped, exactly as ECharts' own
 * markup builder does. */
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESCAPES[c])

/** The single super-chart builder: OHLC + volume, buy/sell markers and the
 * backtest window shading, all sharing one category axis, one linked
 * axisPointer, and one dataZoom. `candlestickOption` below is a thin wrapper
 * kept for the two callers (ProductForm's preview, ProductDrawer.test.tsx)
 * that only ever wanted price+volume. */
export function superChartOption(input: SuperChartInput): EChartsOption {
  const { dark, bars } = input
  const { ink } = chartTokens(dark)

  const layers = input.indicators ?? []
  const layerByKey = new Map(layers.map((l) => [l.info.key, l]))

  // Guards against a pane key that cannot be drawn: one a returning user's
  // browser still has stored from before a pane was retired (`ft.panes` in
  // localStorage), or an `ind:` key whose indicator class the user has since
  // deleted or broken. Either would previously have left `PANE_WEIGHT[p]`
  // undefined and turned the whole layout's height math into NaN; `paneWeight`
  // now closes that hole, but a pane with nothing to put in it is still just
  // an empty band of chart.
  // The cap counts indicator panes only. Slicing the combined list would let
  // `volume` -- on by default -- consume one of the four slots, silently
  // dropping the last indicator the user ticked while SuperChart's "panes
  // hidden" banner (which counts indicators) said nothing was missing.
  let indicatorPanes = 0
  const knownPanes = (input.panes ?? []).filter((p): p is PaneKey => {
    if (p === 'volume') return true
    if (!p.startsWith('ind:')) return false
    // `pane` is the class's own declaration, so a main-pane indicator is
    // drawn over the candles and must not also get a pane here -- otherwise
    // a caller passing both spellings draws it twice.
    if (layerByKey.get(p.slice(4))?.info.pane !== 'sub') return false
    return ++indicatorPanes <= MAX_SUB_PANES
  })
  const allPanes: (PaneKey | 'price')[] = ['price', ...knownPanes]
  const dates = bars.map((b) => b.date)
  const ohlc = bars.map((b) => [b.open, b.close, b.low, b.high])
  const volumes = bars.map((b) => ({
    value: b.volume,
    itemStyle: dayBarStyle(b),
  }))

  const rollBoundaries: string[] = []
  if (input.roll && input.roll.length) {
    let prevContract = input.roll[0].contract
    for (const point of input.roll) {
      if (point.contract !== prevContract) {
        rollBoundaries.push(point.date)
        prevContract = point.contract
      }
    }
  }

  // A signal whose date has no bar in this series is dropped rather than
  // pinned to bar 0 -- the old candlestickOption's `?? 0` fallback, which
  // silently mislocated any signal outside the loaded range.
  const dateIndex = new Map(dates.map((d, i) => [d, i]))
  const knownSignals = (input.signals ?? []).filter((s) => dateIndex.has(s.date))
  const buys = knownSignals.filter((s) => s.direction === 'buy').map((s) => s.date)
  const sells = knownSignals.filter((s) => s.direction === 'sell').map((s) => s.date)
  const priceAt = (d: string) => bars[dateIndex.get(d)!].low

  const windowStart = input.window ? nearestCategory(dates, input.window.start, 'ceil') : null
  const windowEnd = input.window ? nearestCategory(dates, input.window.end, 'floor') : null

  // Fixed pixel gutters on every grid (not `containLabel: true`) so all
  // panes' y-axes land on the same column regardless of label width --
  // percentage-height grids drift apart the moment containLabel resizes one
  // of them differently from the rest.
  const LEFT = 56
  const RIGHT = 20
  const TOP = 2
  const BOTTOM = 11
  const GAP = 2.5
  const totalWeight = allPanes.reduce((s, p) => s + paneWeight(p), 0)
  const usable = 100 - TOP - BOTTOM - GAP * (allPanes.length - 1)
  let cursor = TOP
  const rects = allPanes.map((p) => {
    const h = (paneWeight(p) / totalWeight) * usable
    const rect = { top: `${cursor}%`, height: `${h}%` }
    cursor += h + GAP
    return rect
  })

  const grid = allPanes.map((_, i) => ({ left: LEFT, right: RIGHT, containLabel: false, ...rects[i] }))
  const xAxisIndexAll = allPanes.map((_, i) => i)

  const xAxis = allPanes.map((_, i) =>
    categoryAxis(dark, dates, { gridIndex: i, axisLabel: { show: i === allPanes.length - 1 } }),
  )

  const yAxis = allPanes.map((pane, i) => {
    if (pane === 'price') {
      return valueAxis(dark, {
        gridIndex: i,
        scale: true,
        axisLabel: { formatter: (v: number) => v.toFixed(2) },
        axisPointer: { label: { formatter: (p: { value: number | string }) => Number(p.value).toFixed(2) } },
      })
    }
    if (pane.startsWith('ind:')) {
      const info = layerByKey.get(pane.slice(4))!.info
      // A declared range pins the axis; without one it autoscales. RSI spending
      // a quiet month between 45 and 55 would otherwise fill the pane and read
      // as violent, which is exactly what `value_range = (0, 100)` prevents.
      const range = info.value_range
      return valueAxis(dark, {
        gridIndex: i,
        splitNumber: 2,
        ...(range?.min != null ? { min: range.min } : {}),
        ...(range?.max != null ? { max: range.max } : {}),
        ...(range?.min == null && range?.max == null ? { scale: true } : {}),
        axisLabel: { formatter: (v: number) => v.toFixed(info.precision) },
      })
    }
    return valueAxis(dark, { gridIndex: i, splitNumber: 2 })
  })

  // Values arrive with their own dates, so they are placed by date rather than
  // by position: bars and values are two requests with independently defaulted
  // start/end, and positional alignment would silently shift every point by a
  // row the first time they disagreed. Keeping the result the same length as
  // `dates` is also what lets EChart's `preserveDataZoom` (which keys on the
  // category count) hold the viewer's window when an indicator is toggled.
  const alignToBars = (values: IndicatorValues, outputKey: string): (number | null)[] => {
    const series = values.outputs[outputKey]
    if (!series) return dates.map(() => null)
    const at = new Map(values.dates.map((d, i) => [d, i]))
    return dates.map((d) => {
      const i = at.get(d)
      return i === undefined ? null : series.values[i]
    })
  }

  // Assigned across every rendered output in order, so two indicators that
  // both declared no colour do not land on the same hue.
  let colorCursor = 0

  const indicatorSeries = (layer: IndicatorLayer, axisIndex: number) =>
    layer.info.outputs.map((out) => {
      const fallbackIndex = colorCursor++
      const data = layer.values ? alignToBars(layer.values, out.key) : dates.map(() => null)
      const name = `${layer.info.label} ${out.label}`
      const shared = {
        name,
        xAxisIndex: axisIndex,
        yAxisIndex: axisIndex,
        data,
        // The one place `precision` really earns its keep: the chart is a
        // single linked `trigger: 'axis'` tooltip across every pane, and
        // ECharts honours a per-series formatter inside it.
        tooltip: {
          valueFormatter: (v: unknown) =>
            typeof v === 'number' ? v.toFixed(layer.info.precision) : '--',
        },
      }

      if (out.kind === 'bar') {
        // 'candle' follows the price bar, not the series value: open interest
        // is always positive, so sign-colouring would paint every bar one hue.
        if (out.color === 'candle') {
          return {
            ...shared,
            type: 'bar',
            barMaxWidth: 6,
            data: data.map((v, i) => ({ value: v, itemStyle: dayBarStyle(bars[i]) })),
          }
        }
        const [up, down] = resolveBarColors(out.color, dark, fallbackIndex)
        return {
          ...shared,
          type: 'bar',
          barMaxWidth: 6,
          data: data.map((v) => ({
            value: v,
            itemStyle: { color: (v ?? 0) >= 0 ? up : down },
          })),
        }
      }

      const color = resolveColor(out.color, dark, fallbackIndex)
      return {
        ...shared,
        type: 'line',
        showSymbol: false,
        lineStyle: { color, width: 1.4, type: lineDash(out.style) },
        itemStyle: { color },
        // `connectNulls` is left false on purpose. Leading nulls are the
        // warmup, and the line should begin where the indicator became valid;
        // bridging a genuine gap would draw a straight segment that looks
        // like data the indicator never produced.
        ...(out.kind === 'area'
          ? { areaStyle: { color, opacity: 0.12 } }
          : {}),
      }
    })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const series: any[] = []
  allPanes.forEach((pane, i) => {
    if (pane === 'price') {
      series.push({
        type: 'candlestick',
        xAxisIndex: i,
        yAxisIndex: i,
        data: ohlc,
        itemStyle: { color: CANDLE.up, color0: CANDLE.down, borderColor: CANDLE.up, borderColor0: CANDLE.down },
        markPoint:
          buys.length || sells.length
            ? {
                symbolSize: 20,
                data: [
                  ...buys.map((d) => ({
                    name: 'buy', coord: [d, priceAt(d)], symbol: 'triangle', symbolRotate: 0,
                    itemStyle: { color: CANDLE.up }, label: { show: false },
                  })),
                  ...sells.map((d) => ({
                    name: 'sell', coord: [d, priceAt(d)], symbol: 'triangle', symbolRotate: 180,
                    itemStyle: { color: CANDLE.down }, label: { show: false },
                  })),
                ],
              }
            : undefined,
        markLine: rollBoundaries.length
          ? {
              symbol: 'none', silent: true,
              lineStyle: { color: ink.axis, type: 'solid', width: 1, opacity: 0.6 },
              label: { show: false },
              data: rollBoundaries.map((d) => ({ xAxis: d })),
            }
          : undefined,
        markArea:
          windowStart && windowEnd
            ? {
                silent: true,
                itemStyle: { color: dark ? 'rgba(91,139,240,0.10)' : 'rgba(37,99,235,0.07)' },
                data: [[{ xAxis: windowStart }, { xAxis: windowEnd }]],
              }
            : undefined,
      })
      // Main-pane indicators ride the price axis, so they are added here
      // rather than getting a pane of their own.
      for (const layer of layers) {
        if (layer.info.pane !== 'main') continue
        series.push(...indicatorSeries(layer, i))
      }
    } else if (pane === 'volume') {
      series.push({ name: 'volume', type: 'bar', xAxisIndex: i, yAxisIndex: i, data: volumes, barMaxWidth: 6 })
    } else if (pane.startsWith('ind:')) {
      const layer = layerByKey.get(pane.slice(4))!
      series.push(...indicatorSeries(layer, i))
      const guides = layer.info.guides ?? []
      if (guides.length) {
        // Reference lines (RSI's 30/70, MACD's 0) styled like the roll
        // boundaries on the price pane -- recessive, unlabelled, and clearly
        // not a series.
        series.push({
          type: 'line',
          xAxisIndex: i,
          yAxisIndex: i,
          data: [],
          silent: true,
          markLine: {
            symbol: 'none',
            silent: true,
            lineStyle: { color: ink.axis, type: 'dashed', width: 1, opacity: 0.6 },
            label: { show: false },
            data: guides.map((value) => ({ yAxis: value })),
          },
          tooltip: { show: false },
        })
      }
    }
  })

  // One label per sub-pane, inside the pane's own top-left corner. A real
  // ECharts `legend` would sit at `top: 0` -- colliding with the layout's
  // `TOP` band, eating height from every pane, and offering a click-to-hide
  // that immediately desyncs from the toolbar's toggles under `notMerge`.
  const paneTitles = allPanes.flatMap((pane, i) => {
    if (!pane.startsWith('ind:')) return []
    const { info, params } = layerByKey.get(pane.slice(4))!
    const args = Object.values(params ?? info.params)
    return [{
      text: args.length ? `${info.label}(${args.join(', ')})` : info.label,
      top: rects[i].top,
      left: LEFT + 4,
      textStyle: { color: ink.secondary, fontSize: 11, fontWeight: 'normal' as const },
    }]
  })

  // ECharts' default axis tooltip opens every series' block with a
  // marker + series-name row, then lists any sub-values under it. The
  // candlestick has no name and keeps all four of its values in sub-rows, so
  // that row renders as a lone dot floating above `open` -- and its markup
  // builder only drops a row when it has *neither* a name nor a value, so no
  // option suppresses it. Formatting the whole tooltip here is the only way
  // to leave it out; the styles below mirror what the default builder emits
  // (10px row gaps, 900-weight values floated right) so nothing else moves.
  const nameCss = `font-size:12px;color:${ink.primary};font-weight:400`
  const valueCss = `font-size:12px;color:${ink.primary};font-weight:900`
  // ECharts' `subItem` marker -- the smaller dot the OHLC rows already used.
  const subDot = (color: string) =>
    '<span style="display:inline-block;vertical-align:middle;margin-right:8px;margin-left:3px;' +
    `border-radius:4px;width:4px;height:4px;background-color:${color}"></span>`
  const row = (marker: string, name: string, value: string) =>
    `<div style="margin:10px 0 0;line-height:1">${marker}` +
    (name ? `<span style="${nameCss};margin-left:2px">${esc(name)}</span>` : '') +
    `<span style="float:right;margin-left:${name ? 20 : 10}px;${valueCss}">${esc(value)}</span>` +
    '<div style="clear:both"></div></div>'

  const formatTooltip = (raw: unknown): string => {
    const params = (Array.isArray(raw) ? raw : [raw]) as TooltipParam[]
    if (!params.length) return ''
    const rows = params.flatMap((p) => {
      if (p.seriesType === 'candlestick') {
        // Read from `bars` rather than `p.value`, whose leading element is the
        // category index ECharts prepends -- one off-by-one away from showing
        // the wrong four numbers.
        const b = bars[p.dataIndex]
        if (!b) return []
        const dot = subDot(b.close >= b.open ? CANDLE.up : CANDLE.down)
        const cells: [string, number][] = [
          ['open', b.open], ['close', b.close], ['lowest', b.low], ['highest', b.high],
        ]
        return cells.map(([label, v]) => row(dot, label, v.toFixed(2)))
      }
      // Each series still declares its own precision through the
      // `valueFormatter` it was built with; a global formatter bypasses the
      // one ECharts would have applied, so it is applied here instead.
      const fmt = series[p.seriesIndex]?.tooltip?.valueFormatter
      const value = fmt
        ? String(fmt(p.value))
        : typeof p.value === 'number'
          ? p.value.toLocaleString('en-US')
          : '--'
      return [row(p.marker ?? '', p.seriesName ?? '', value)]
    })
    return `<div style="${nameCss};line-height:1">${esc(params[0].axisValueLabel ?? '')}</div>${rows.join('')}`
  }

  return {
    ...baseOption(dark),
    legend: { show: false },
    title: paneTitles,
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: { ...baseOption(dark).tooltip, trigger: 'axis', axisPointer: { type: 'cross' }, formatter: formatTooltip },
    grid,
    xAxis,
    yAxis,
    dataZoom: [
      { type: 'inside', xAxisIndex: xAxisIndexAll },
      { type: 'slider', xAxisIndex: xAxisIndexAll, height: 16, bottom: 4, borderColor: 'transparent' },
    ],
    series,
  }
}
