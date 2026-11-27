import * as echarts from 'echarts/core'
import type { EChartsOption } from 'echarts'
import { BarChart, CandlestickChart, LineChart, ScatterChart } from 'echarts/charts'
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { useEffect, useRef } from 'react'
import { useIsDarkMode } from '../theme/useIsDarkMode'

echarts.use([
  BarChart,
  CandlestickChart,
  LineChart,
  ScatterChart,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  TitleComponent,
  TooltipComponent,
  CanvasRenderer,
])

export interface ZoomCommand {
  start: number
  end: number
  seq: number
}

function categoryLength(option: EChartsOption): number {
  const xAxis = option.xAxis
  const first = Array.isArray(xAxis) ? xAxis[0] : xAxis
  const data = (first as { data?: unknown[] } | undefined)?.data
  return Array.isArray(data) ? data.length : 0
}

export function EChart({
  option,
  height = '100%',
  className,
  preserveDataZoom = false,
  zoomCommand = null,
  onEvents,
}: {
  option: EChartsOption
  height?: number | string
  className?: string
  preserveDataZoom?: boolean
  /** Imperative zoom target (e.g. jump to a trade or backtest window) applied
   * without mutating `option`, keeping `option` references stable. */
  zoomCommand?: ZoomCommand | null
  onEvents?: Record<string, (params: unknown) => void>
}) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const dark = useIsDarkMode()
  const zoomRef = useRef<{ start: number; end: number; len: number } | null>(null)
  const optionRef = useRef(option)
  const lastZoomSeqRef = useRef<number>(0)

  useEffect(() => {
    if (!ref.current) return
    const chart = echarts.init(ref.current)
    chartRef.current = chart

    let rafId: number | null = null
    const observer = new ResizeObserver(() => {
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        chart.resize()
      })
    })
    observer.observe(ref.current)

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      observer.disconnect()
      chart.dispose()
      chartRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    optionRef.current = option
    chart.setOption(option, { notMerge: true })
    if (preserveDataZoom) {
      const len = categoryLength(option)
      const saved = zoomRef.current
      if (saved && saved.len === len) {
        chart.dispatchAction({ type: 'dataZoom', start: saved.start, end: saved.end })
      } else {
        zoomRef.current = { start: 0, end: 100, len }
      }
    }
  }, [option, preserveDataZoom, dark])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !zoomCommand || zoomCommand.seq === lastZoomSeqRef.current) return
    const len = categoryLength(optionRef.current)
    if (len === 0) return
    lastZoomSeqRef.current = zoomCommand.seq
    const start = Math.max(0, Math.min(100, zoomCommand.start))
    const end = Math.max(start, Math.min(100, zoomCommand.end))
    zoomRef.current = { start, end, len }
    chart.dispatchAction({ type: 'dataZoom', start, end })
  }, [zoomCommand, option, dark])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !preserveDataZoom) return
    const onZoom = () => {
      const zoom = (chart.getOption().dataZoom as Array<{ start: number; end: number }> | undefined)?.[0]
      if (zoom) zoomRef.current = { start: zoom.start, end: zoom.end, len: categoryLength(optionRef.current) }
    }
    chart.on('datazoom', onZoom)
    return () => {
      chart.off('datazoom', onZoom)
    }
  }, [preserveDataZoom, dark])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !onEvents) return
    const entries = Object.entries(onEvents)
    for (const [name, handler] of entries) {
      chart.on(name, handler)
    }
    return () => {
      for (const [name, handler] of entries) {
        chart.off(name, handler)
      }
    }
  }, [onEvents, dark])

  return <div ref={ref} className={className} style={{ width: '100%', height }} />
}
