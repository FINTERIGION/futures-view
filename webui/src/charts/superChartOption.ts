import type { EChartsOption } from 'echarts'
import type { Bar, IndicatorInfo, IndicatorValues, RollPoint } from '../api/types'
import { CANDLE } from '../theme/palette'
import { nearestCategory } from './align'
import { lineDash, resolveBarColors, resolveColor } from './indicatorColor'
import { baseOption, categoryAxis, chartTokens, sliderZoomStyle, valueAxis } from './theme'

export type PaneKey = 'volume' | `ind:${string}`

const STATIC_WEIGHT: Record<string, number> = {
  price: 3.2,
  volume: 0.78,
}
const INDICATOR_WEIGHT = 1

const paneWeight = (pane: string): number => STATIC_WEIGHT[pane] ?? INDICATOR_WEIGHT

export const MAX_SUB_PANES = 4

export interface IndicatorLayer {
  info: IndicatorInfo
  values: IndicatorValues | null
  params?: Record<string, unknown>
}

export interface ChartTooltipLabels {
  open?: string
  close?: string
  low?: string
  high?: string
  volume?: string
}

export interface SuperChartInput {
  dark: boolean
  bars: Bar[]
  panes?: PaneKey[]
  roll?: RollPoint[]
  signals?: { date: string; direction: string }[]
  window?: { start: string; end: string } | null
  indicators?: IndicatorLayer[]
  labels?: ChartTooltipLabels
}

interface TooltipParam {
  seriesIndex: number
  seriesType: string
  seriesName?: string
  dataIndex: number
  marker?: string
  value: unknown
  axisValueLabel?: string
}

const dayBarStyle = (b: Bar) => ({
  color: (b.close ?? 0) >= (b.open ?? 0) ? CANDLE.up : CANDLE.down,
  opacity: 0.48,
})

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESCAPES[c])

export function superChartOption(input: SuperChartInput): EChartsOption {
  const { dark, bars } = input
  const { ink } = chartTokens(dark)
  const labels = {
    open: input.labels?.open ?? 'open',
    close: input.labels?.close ?? 'close',
    low: input.labels?.low ?? 'lowest',
    high: input.labels?.high ?? 'highest',
    volume: input.labels?.volume ?? 'volume',
  }

  const layers = input.indicators ?? []
  const layerByKey = new Map(layers.map((l) => [l.info.key, l]))

  let indicatorPanes = 0
  const knownPanes = (input.panes ?? []).filter((p): p is PaneKey => {
    if (p === 'volume') return true
    if (!p.startsWith('ind:')) return false
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

  // Roll boundaries: prefer explicit roll calendar when provided (weighted series),
  // otherwise derive directly from consecutive `bar.contract` transitions (main / m01..m12).
  const rollBoundaries: string[] = []
  if (input.roll && input.roll.length) {
    let prevContract = input.roll[0].contract
    for (const point of input.roll) {
      if (point.contract !== prevContract) {
        rollBoundaries.push(point.date)
        prevContract = point.contract
      }
    }
  } else {
    let prevContract: string | undefined
    for (const b of bars) {
      if (!b.contract) continue
      if (prevContract !== undefined && b.contract !== prevContract) {
        rollBoundaries.push(b.date)
      }
      prevContract = b.contract
    }
  }

  const dateIndex = new Map(dates.map((d, i) => [d, i]))
  const knownSignals = (input.signals ?? []).filter((s) => dateIndex.has(s.date))
  const buys = knownSignals.filter((s) => s.direction === 'buy').map((s) => s.date)
  const sells = knownSignals.filter((s) => s.direction === 'sell').map((s) => s.date)
  const lowAt = (d: string) => bars[dateIndex.get(d)!].low
  const highAt = (d: string) => bars[dateIndex.get(d)!].high

  const windowStart = input.window ? nearestCategory(dates, input.window.start, 'ceil') : null
  const windowEnd = input.window ? nearestCategory(dates, input.window.end, 'floor') : null

  const LEFT = 58
  const RIGHT = 18
  const TOP = 2.5
  const BOTTOM = 10.5
  const GAP = 2.2
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
    return valueAxis(dark, {
      gridIndex: i,
      splitNumber: 2,
      axisLabel: {
        formatter: (v: number) => (Math.abs(v) >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)),
      },
    })
  })

  const alignToBars = (values: IndicatorValues, outputKey: string): (number | null)[] => {
    const series = values.outputs[outputKey]
    if (!series) return dates.map(() => null)
    const at = new Map(values.dates.map((d, i) => [d, i]))
    return dates.map((d) => {
      const i = at.get(d)
      return i === undefined ? null : series.values[i]
    })
  }

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
        tooltip: {
          valueFormatter: (v: unknown) =>
            typeof v === 'number' ? v.toFixed(layer.info.precision) : '--',
        },
      }

      if (out.kind === 'bar') {
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
        ...(out.kind === 'area' ? { areaStyle: { color, opacity: 0.1 } } : {}),
      }
    })

  const series: unknown[] = []
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
                symbolSize: 11,
                data: [
                  ...buys.map((d) => ({
                    name: 'buy',
                    coord: [d, lowAt(d)],
                    symbol: 'triangle',
                    symbolRotate: 0,
                    symbolOffset: [0, 8],
                    itemStyle: { color: CANDLE.up },
                    label: { show: false },
                  })),
                  ...sells.map((d) => ({
                    name: 'sell',
                    coord: [d, highAt(d)],
                    symbol: 'triangle',
                    symbolRotate: 180,
                    symbolOffset: [0, -8],
                    itemStyle: { color: CANDLE.down },
                    label: { show: false },
                  })),
                ],
              }
            : undefined,
        markLine: rollBoundaries.length
          ? {
              symbol: 'none',
              silent: true,
              lineStyle: { color: ink.axis, type: 'dashed', width: 1, opacity: 0.45 },
              label: { show: false },
              data: rollBoundaries.map((d) => ({ xAxis: d })),
            }
          : undefined,
        markArea:
          windowStart && windowEnd
            ? {
                silent: true,
                itemStyle: { color: dark ? 'rgba(96,165,250,0.08)' : 'rgba(37,99,235,0.06)' },
                data: [[{ xAxis: windowStart }, { xAxis: windowEnd }]],
              }
            : undefined,
      })
      for (const layer of layers) {
        if (layer.info.pane !== 'main') continue
        series.push(...indicatorSeries(layer, i))
      }
    } else if (pane === 'volume') {
      series.push({
        name: labels.volume,
        type: 'bar',
        xAxisIndex: i,
        yAxisIndex: i,
        data: volumes,
        barMaxWidth: 6,
      })
    } else if (pane.startsWith('ind:')) {
      const layer = layerByKey.get(pane.slice(4))!
      series.push(...indicatorSeries(layer, i))
      const guides = layer.info.guides ?? []
      if (guides.length) {
        series.push({
          type: 'line',
          xAxisIndex: i,
          yAxisIndex: i,
          data: [],
          silent: true,
          markLine: {
            symbol: 'none',
            silent: true,
            lineStyle: { color: ink.axis, type: 'dashed', width: 1, opacity: 0.55 },
            label: { show: false },
            data: guides.map((value) => ({ yAxis: value })),
          },
          tooltip: { show: false },
        })
      }
    }
  })

  const paneTitles = allPanes.flatMap((pane, i) => {
    if (!pane.startsWith('ind:')) return []
    const { info, params } = layerByKey.get(pane.slice(4))!
    const args = Object.values(params ?? info.params)
    return [
      {
        text: args.length ? `${info.label}(${args.join(', ')})` : info.label,
        top: rects[i].top,
        left: LEFT + 4,
        textStyle: { color: ink.secondary, fontSize: 11, fontWeight: 'normal' as const },
      },
    ]
  })

  const nameCss = `font-size:12px;color:${ink.secondary};font-weight:400`
  const valueCss = `font-size:12px;color:${ink.primary};font-weight:600;font-variant-numeric:tabular-nums`
  const subDot = (color: string) =>
    '<span style="display:inline-block;vertical-align:middle;margin-right:7px;margin-left:2px;' +
    `border-radius:50%;width:5px;height:5px;background-color:${color}"></span>`
  const row = (marker: string, name: string, value: string) =>
    `<div style="margin:6px 0 0;line-height:1.15">${marker}` +
    (name ? `<span style="${nameCss};margin-left:2px">${esc(name)}</span>` : '') +
    `<span style="float:right;margin-left:${name ? 18 : 10}px;${valueCss}">${esc(value)}</span>` +
    '<div style="clear:both"></div></div>'

  const formatTooltip = (raw: unknown): string => {
    const params = (Array.isArray(raw) ? raw : [raw]) as TooltipParam[]
    if (!params.length) return ''
    let headerExtra = ''
    const rows = params.flatMap((p) => {
      if (p.seriesType === 'candlestick') {
        const b = bars[p.dataIndex]
        if (!b) return []
        const prev = p.dataIndex > 0 ? bars[p.dataIndex - 1] : null
        const refClose = prev?.close ?? b.open
        if (b.contract) {
          headerExtra += ` <span style="font-family:monospace;color:${ink.muted};margin-left:4px">${esc(b.contract)}</span>`
        }
        if (typeof b.close === 'number' && typeof refClose === 'number' && refClose > 0) {
          const pct = ((b.close - refClose) / refClose) * 100
          const sign = pct > 0 ? '+' : ''
          const pctColor = pct >= 0 ? CANDLE.up : CANDLE.down
          headerExtra += `<span style="float:right;margin-left:14px;font-weight:600;color:${pctColor};font-variant-numeric:tabular-nums">${sign}${pct.toFixed(2)}%</span>`
        }
        const dot = subDot((b.close ?? 0) >= (b.open ?? 0) ? CANDLE.up : CANDLE.down)
        const cells: [string, number | null][] = [
          [labels.open, b.open],
          [labels.close, b.close],
          [labels.low, b.low],
          [labels.high, b.high],
        ]
        return cells.map(([label, v]) =>
          row(dot, label, typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '--'),
        )
      }
      const s = series[p.seriesIndex] as { tooltip?: { valueFormatter?: (v: unknown) => unknown } } | undefined
      const fmt = s?.tooltip?.valueFormatter
      const value = fmt
        ? String(fmt(p.value))
        : typeof p.value === 'number'
          ? p.value.toLocaleString('en-US')
          : '--'
      return [row(p.marker ?? '', p.seriesName ?? '', value)]
    })
    return (
      `<div style="font-size:12px;color:${ink.primary};font-weight:600;line-height:1.2;margin-bottom:2px">` +
      `${esc(params[0].axisValueLabel ?? '')}${headerExtra}<div style="clear:both"></div></div>` +
      rows.join('')
    )
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
      { type: 'slider', xAxisIndex: xAxisIndexAll, ...sliderZoomStyle(dark) },
    ],
    series: series as EChartsOption['series'],
  }
}
