import type { EChartsOption } from 'echarts'
import { CATEGORICAL_DARK, CATEGORICAL_LIGHT, CHART_SURFACE, INK } from '../theme/palette'

export function chartTokens(dark: boolean) {
  const ink = dark ? INK.dark : INK.light
  return {
    surface: dark ? CHART_SURFACE.dark : CHART_SURFACE.light,
    categorical: dark ? CATEGORICAL_DARK : CATEGORICAL_LIGHT,
    ink,
  }
}

export function sliderZoomStyle(dark: boolean) {
  const { ink } = chartTokens(dark)
  const accent = dark ? '#60a5fa' : '#2563eb'
  return {
    height: 14,
    bottom: 4,
    borderColor: 'transparent',
    backgroundColor: dark ? 'rgba(255, 255, 255, 0.03)' : 'rgba(15, 23, 42, 0.03)',
    fillerColor: dark ? 'rgba(96, 165, 250, 0.16)' : 'rgba(37, 99, 235, 0.11)',
    handleSize: '72%',
    handleStyle: {
      color: dark ? '#2a313f' : '#ffffff',
      borderColor: ink.axis,
      borderWidth: 1,
    },
    moveHandleSize: 0,
    brushSelect: false,
    dataBackground: {
      lineStyle: { color: ink.axis, width: 1, opacity: 0.45 },
      areaStyle: { color: ink.axis, opacity: 0.07 },
    },
    selectedDataBackground: {
      lineStyle: { color: accent, width: 1, opacity: 0.65 },
      areaStyle: { color: accent, opacity: 0.11 },
    },
    textStyle: { color: ink.muted, fontSize: 10 },
  }
}

export function baseOption(dark: boolean): EChartsOption {
  const { categorical, ink } = chartTokens(dark)
  return {
    backgroundColor: 'transparent',
    color: categorical,
    textStyle: { color: ink.secondary, fontFamily: 'inherit' },
    grid: { left: 56, right: 20, top: 24, bottom: 40, containLabel: true },
    axisPointer: {
      lineStyle: { color: ink.axis, type: 'dashed' },
    },
    legend: {
      top: 0,
      textStyle: { color: ink.secondary, fontSize: 12 },
      itemWidth: 14,
      itemHeight: 8,
    },
    tooltip: {
      backgroundColor: dark ? 'rgba(23, 27, 34, 0.96)' : 'rgba(255, 255, 255, 0.97)',
      borderColor: ink.axis,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: ink.primary, fontSize: 12 },
      extraCssText:
        'box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18); border-radius: 8px; backdrop-filter: blur(6px);',
    },
  }
}

export function valueAxis(dark: boolean, overrides: Record<string, unknown> = {}) {
  const { ink } = chartTokens(dark)
  const { axisLabel, ...rest } = overrides as { axisLabel?: Record<string, unknown>; [key: string]: unknown }
  return {
    type: 'value' as const,
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: ink.grid, type: 'dashed' as const } },
    axisLabel: { color: ink.muted, fontSize: 11, ...axisLabel },
    ...rest,
  }
}

export function categoryAxis(dark: boolean, data: (string | number)[], overrides: Record<string, unknown> = {}) {
  const { ink } = chartTokens(dark)
  return {
    type: 'category' as const,
    data,
    boundaryGap: false,
    axisLine: { lineStyle: { color: ink.axis } },
    axisTick: { show: false },
    axisLabel: { color: ink.muted, fontSize: 11 },
    splitLine: { show: false },
    ...overrides,
  }
}
