import type { EChartsOption } from 'echarts'
import { baseOption, categoryAxis, chartTokens, sliderZoomStyle, valueAxis } from './theme'

export function lineSeriesOption(
  dark: boolean,
  dates: string[],
  series: { name: string; values: (number | null)[] }[],
  opts: { percent?: boolean; area?: boolean; money?: boolean } = {},
): EChartsOption {
  const { categorical } = chartTokens(dark)
  const showLegend = series.length > 1
  return {
    ...baseOption(dark),
    legend: showLegend ? { ...baseOption(dark).legend, data: series.map((s) => s.name) } : { show: false },
    grid: { ...(baseOption(dark).grid as object), top: showLegend ? 32 : 16, bottom: 38 },
    tooltip: {
      ...baseOption(dark).tooltip,
      trigger: 'axis',
      ...(opts.money
        ? {
            valueFormatter: (v: unknown) =>
              typeof v === 'number'
                ? v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : String(v),
          }
        : {}),
    },
    xAxis: categoryAxis(dark, dates),
    yAxis: valueAxis(
      dark,
      opts.percent
        ? { axisLabel: { formatter: '{value}%' } }
        : opts.money
          ? {
              scale: true,
              axisLabel: {
                formatter: (v: number) =>
                  Math.abs(v) >= 1_000_000
                    ? `${(v / 1_000_000).toFixed(1)}M`
                    : v.toLocaleString(undefined, { maximumFractionDigits: 0 }),
              },
            }
          : {},
    ),
    dataZoom: [
      { type: 'inside' },
      { type: 'slider', ...sliderZoomStyle(dark) },
    ],
    series: series.map((s, i) => ({
      name: s.name,
      type: 'line',
      data: s.values,
      showSymbol: false,
      lineStyle: { width: 1.8, color: categorical[i % categorical.length] },
      itemStyle: { color: categorical[i % categorical.length] },
      areaStyle: opts.area ? { color: categorical[i % categorical.length], opacity: 0.09 } : undefined,
      connectNulls: false,
    })),
  }
}
