import { describe, expect, it } from 'vitest'
import type { Bar, IndicatorInfo, IndicatorValues, RollPoint } from '../api/types'
import { CANDLE } from '../theme/palette'
import { MAX_SUB_PANES, superChartOption, type IndicatorLayer } from './superChartOption'

function bar(date: string, o: number, h: number, l: number, c: number, v = 100): Bar {
  return { date, open: o, high: h, low: l, close: c, settle: c, oi: 1000, volume: v }
}

const BARS: Bar[] = [
  bar('2024-01-02', 10, 11, 9, 10.5),
  bar('2024-01-03', 10.5, 12, 10, 11.5),
  bar('2024-01-04', 11.5, 12.5, 11, 12),
  bar('2024-01-05', 12, 13, 11.5, 12.8),
]
const DATES = BARS.map((b) => b.date)

function grids(option: ReturnType<typeof superChartOption>) {
  return option.grid as Array<{ top: string; height: string }>
}

describe('superChartOption grid layout', () => {
  it('has one grid per pane, none overlapping, all within the usable height', () => {
    for (const panes of [[], ['volume']] as const) {
      const option = superChartOption({ dark: false, bars: BARS, panes: [...panes] })
      const g = grids(option)
      expect(g).toHaveLength(panes.length + 1) // + the always-present price pane
      let prevBottom = 0
      for (const rect of g) {
        const top = parseFloat(rect.top)
        const height = parseFloat(rect.height)
        expect(top).toBeGreaterThanOrEqual(prevBottom)
        expect(top + height).toBeLessThanOrEqual(100 - 10) // leaves room for the slider + labels
        prevBottom = top + height
      }
    }
  })

  it('drops a pane key it does not recognize, instead of corrupting the layout math', () => {
    // Guards a returning user whose browser still has an older pane
    // (equity/position/drawdown) stored in `ft.panes` from before it was
    // retired -- an unrecognized key must not reach `PANE_WEIGHT` at all.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const option = superChartOption({ dark: false, bars: BARS, panes: ['volume', 'equity'] as any })
    expect(grids(option)).toHaveLength(2) // price + volume only
  })

  it('lists every axis index in both dataZoom entries, for any pane count', () => {
    const option = superChartOption({ dark: false, bars: BARS, panes: ['volume'] })
    const dz = option.dataZoom as Array<{ xAxisIndex: number[] }>
    expect(dz).toHaveLength(2)
    for (const entry of dz) expect(entry.xAxisIndex).toEqual([0, 1])
  })

  it('gives every pane the same category axis, so the linked axisPointer and dataZoom stay in sync', () => {
    const option = superChartOption({ dark: false, bars: BARS, panes: ['volume'] })
    const xAxis = option.xAxis as Array<{ data: string[] }>
    for (const axis of xAxis) expect(axis.data).toEqual(DATES)
  })

  it('only shows date labels on the bottom-most pane', () => {
    const option = superChartOption({ dark: false, bars: BARS, panes: ['volume'] })
    const xAxis = option.xAxis as Array<{ axisLabel: { show: boolean } }>
    expect(xAxis.map((a) => a.axisLabel.show)).toEqual([false, true])
  })
})

describe('superChartOption overlay data', () => {
  it('draws one markLine per contract change, not one per row', () => {
    const roll: RollPoint[] = [
      { date: '2024-01-02', contract: 'SA401', close: 10 },
      { date: '2024-01-03', contract: 'SA401', close: 11 },
      { date: '2024-01-04', contract: 'SA405', close: 12 },
      { date: '2024-01-05', contract: 'SA405', close: 12.5 },
    ]
    const option = superChartOption({ dark: false, bars: BARS, roll })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const price = (option.series as any[])[0]
    expect(price.markLine.data).toEqual([{ xAxis: '2024-01-04' }])
  })

  it('drops a signal whose date has no bar, instead of pinning it to the first bar', () => {
    const option = superChartOption({
      dark: false,
      bars: BARS,
      signals: [
        { date: '2024-01-03', direction: 'buy' },
        { date: '2023-06-01', direction: 'sell' }, // not in BARS
      ],
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const price = (option.series as any[])[0]
    const coords = price.markPoint.data.map((d: { coord: [string, number] }) => d.coord[0])
    expect(coords).toEqual(['2024-01-03'])
  })

  it('clamps a window that starts before the first bar to the first category', () => {
    const option = superChartOption({
      dark: false,
      bars: BARS,
      window: { start: '2020-01-01', end: '2024-01-03' },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const price = (option.series as any[])[0]
    expect(price.markArea.data[0][0].xAxis).toBe('2024-01-02')
    expect(price.markArea.data[0][1].xAxis).toBe('2024-01-03')
  })

  it('renders no markArea when the window falls entirely outside the bars', () => {
    const option = superChartOption({
      dark: false,
      bars: BARS,
      window: { start: '2030-01-01', end: '2030-02-01' },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const price = (option.series as any[])[0]
    expect(price.markArea).toBeUndefined()
  })
})

// -------------------------------------------------------------------------

function indicator(over: Partial<IndicatorInfo> = {}): IndicatorInfo {
  return {
    key: 'rsi',
    label: 'RSI',
    class_name: 'Rsi',
    module: 'indicators.rsi',
    file: 'indicators/rsi.py',
    docstring: '',
    pane: 'sub',
    precision: 1,
    value_range: { min: 0, max: 100 },
    guides: [30, 70],
    outputs: [{ key: 'rsi', label: 'RSI', kind: 'line', color: 4, style: 'solid' }],
    params: { period: 14 },
    space: {},
    space_error: null,
    errors: [],
    ...over,
  }
}

function values(over: Partial<IndicatorValues> = {}): IndicatorValues {
  return {
    symbol: 'SA',
    indicator: 'rsi',
    params: { period: 14 },
    dates: DATES,
    outputs: { rsi: { values: [null, 40, 55, 72], valid_from: 1 } },
    ...over,
  }
}

function layer(info: IndicatorInfo, vals: IndicatorValues | null): IndicatorLayer {
  return { info, values: vals }
}

describe('superChartOption indicators', () => {
  it('gives each sub-pane indicator its own pane rather than sharing an axis', () => {
    const atr = indicator({ key: 'atr', label: 'ATR', value_range: null, guides: [] })
    const option = superChartOption({
      dark: false,
      bars: BARS,
      panes: ['volume', 'ind:rsi', 'ind:atr'],
      indicators: [layer(indicator(), values()), layer(atr, null)],
    })
    // price + volume + rsi + atr
    expect(grids(option)).toHaveLength(4)
  })

  it('lays out a pane for a selected indicator whose values have not arrived yet', () => {
    // Otherwise every pane relayouts as each query resolves, one after another.
    const option = superChartOption({
      dark: false,
      bars: BARS,
      panes: ['ind:rsi'],
      indicators: [layer(indicator(), null)],
    })
    expect(grids(option)).toHaveLength(2)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const series = (option.series as any[]).find((s) => s.name === 'RSI RSI')
    expect(series.data).toEqual([null, null, null, null])
  })

  it('drops an ind: pane whose indicator is no longer in the catalog', () => {
    // The class was deleted or has an error; a pane with nothing in it is
    // just an empty band of chart.
    const option = superChartOption({
      dark: false,
      bars: BARS,
      panes: ['volume', 'ind:deleted'],
      indicators: [],
    })
    expect(grids(option)).toHaveLength(2) // price + volume
  })

  it('caps the number of sub-panes so the price pane stays readable', () => {
    const keys = ['a', 'b', 'c', 'd', 'e', 'f']
    const option = superChartOption({
      dark: false,
      bars: BARS,
      panes: keys.map((k) => `ind:${k}` as const),
      indicators: keys.map((k) => layer(indicator({ key: k, label: k.toUpperCase() }), null)),
    })
    expect(grids(option)).toHaveLength(MAX_SUB_PANES + 1)
  })

  it('does not let the volume pane eat one of the indicator slots', () => {
    // Volume is on by default, so counting it against the cap would silently
    // drop the fourth indicator the user ticked -- while SuperChart's
    // "panes hidden" banner, which counts indicators, said nothing was wrong.
    const keys = ['a', 'b', 'c', 'd']
    const option = superChartOption({
      dark: false,
      bars: BARS,
      panes: ['volume', ...keys.map((k) => `ind:${k}` as const)],
      indicators: keys.map((k) => layer(indicator({ key: k, label: k.toUpperCase() }), null)),
    })
    // price + volume + all four indicators
    expect(grids(option)).toHaveLength(6)
  })

  it('pins a declared value_range on the sub-pane axis and autoscales without one', () => {
    const option = superChartOption({
      dark: false,
      bars: BARS,
      panes: ['ind:rsi', 'ind:atr'],
      indicators: [
        layer(indicator(), values()),
        layer(indicator({ key: 'atr', label: 'ATR', value_range: null, guides: [] }), null),
      ],
    })
    const yAxis = option.yAxis as Array<{ min?: number; max?: number; scale?: boolean }>
    expect(yAxis[1].min).toBe(0)
    expect(yAxis[1].max).toBe(100)
    expect(yAxis[2].min).toBeUndefined()
    expect(yAxis[2].scale).toBe(true)
  })

  it('overlays a main-pane indicator on the price axis instead of adding a pane', () => {
    const ma = indicator({
      key: 'ma',
      label: 'MA',
      pane: 'main',
      value_range: null,
      guides: [],
      outputs: [{ key: 'fast', label: 'fast', kind: 'line', color: 0, style: 'dashed' }],
    })
    const option = superChartOption({
      dark: false,
      bars: BARS,
      panes: ['volume'],
      indicators: [layer(ma, values({ indicator: 'ma', outputs: { fast: { values: [1, 2, 3, 4], valid_from: 0 } } }))],
    })
    expect(grids(option)).toHaveLength(2) // price + volume; no pane for MA
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const series = (option.series as any[]).find((s) => s.name === 'MA fast')
    expect(series.xAxisIndex).toBe(0)
    expect(series.yAxisIndex).toBe(0)
    expect(series.lineStyle.type).toBe('dashed')
  })

  it('places values by date, so a values range that differs from the bars cannot shift the series', () => {
    // Bars and values are two requests with independently defaulted
    // start/end; positional alignment would misplace every point by a row.
    const option = superChartOption({
      dark: false,
      bars: BARS,
      panes: ['ind:rsi'],
      indicators: [
        layer(
          indicator(),
          values({
            dates: ['2023-12-29', '2024-01-03', '2024-01-05'],
            outputs: { rsi: { values: [10, 50, 80], valid_from: 0 } },
          }),
        ),
      ],
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const series = (option.series as any[]).find((s) => s.name === 'RSI RSI')
    // 2023-12-29 has no bar and is dropped; the two that match land on their
    // own dates, and the bars they do not cover stay null.
    expect(series.data).toEqual([null, 50, null, 80])
    expect(series.data).toHaveLength(BARS.length)
  })

  it('draws declared guides as a markLine on the indicator pane', () => {
    const option = superChartOption({
      dark: false,
      bars: BARS,
      panes: ['ind:rsi'],
      indicators: [layer(indicator(), values())],
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guide = (option.series as any[]).find((s) => s.markLine)
    expect(guide.markLine.data).toEqual([{ yAxis: 30 }, { yAxis: 70 }])
    expect(guide.yAxisIndex).toBe(1)
  })

  it('colours a sign-coloured bar per point', () => {
    const macd = indicator({
      key: 'macd',
      label: 'MACD',
      value_range: null,
      guides: [],
      outputs: [{ key: 'hist', label: 'hist', kind: 'bar', color: ['up', 'down'], style: 'solid' }],
    })
    const option = superChartOption({
      dark: false,
      bars: BARS,
      panes: ['ind:macd'],
      indicators: [
        layer(macd, values({ indicator: 'macd', outputs: { hist: { values: [-1, 2, -3, 4], valid_from: 0 } } })),
      ],
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const series = (option.series as any[]).find((s) => s.name === 'MACD hist')
    const colors = series.data.map((d: { itemStyle: { color: string } }) => d.itemStyle.color)
    expect(colors[0]).toBe(colors[2]) // both negative
    expect(colors[1]).toBe(colors[3]) // both positive
    expect(colors[0]).not.toBe(colors[1])
  })

  it('colours a candle-declared bar the same way as volume', () => {
    // Red when the day rose or held, green when it fell. Open interest is
    // always positive, so colouring by the value's sign would paint one hue.
    const days = [
      bar('2024-01-02', 10, 11, 9, 10.5), // rose
      bar('2024-01-03', 11, 11.2, 9, 10), // fell
      bar('2024-01-04', 10, 10.4, 9.6, 10), // held: close == open counts as up
    ]
    const oi = indicator({
      key: 'oi',
      label: 'OI',
      precision: 0,
      value_range: null,
      guides: [],
      outputs: [{ key: 'oi', label: 'OI', kind: 'bar', color: 'candle', style: 'solid' }],
    })
    const option = superChartOption({
      dark: false,
      bars: days,
      panes: ['volume', 'ind:oi'],
      indicators: [
        layer(
          oi,
          values({
            indicator: 'oi',
            dates: days.map((b) => b.date),
            outputs: { oi: { values: [1000, 1100, 1050], valid_from: 0 } },
          }),
        ),
      ],
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const series = option.series as any[]
    const volume = series.find((s) => s.name === 'volume')
    const oiSeries = series.find((s) => s.name === 'OI OI')
    const style = (s: { data: Array<{ itemStyle: { color: string; opacity: number } }> }, i: number) =>
      s.data[i].itemStyle
    expect(style(oiSeries, 0)).toEqual(style(volume, 0))
    expect(style(oiSeries, 1)).toEqual(style(volume, 1))
    expect(style(oiSeries, 2)).toEqual(style(volume, 2))
    expect(style(oiSeries, 0).color).toBe(CANDLE.up)
    expect(style(oiSeries, 1).color).toBe(CANDLE.down)
    expect(style(oiSeries, 2).color).toBe(CANDLE.up)
  })

  it('titles each indicator pane instead of turning on a legend', () => {
    // A real legend sits at top:0, colliding with the layout's TOP band and
    // offering a click-to-hide that desyncs from the toolbar toggles.
    const option = superChartOption({
      dark: false,
      bars: BARS,
      panes: ['ind:rsi'],
      indicators: [layer(indicator(), values())],
    })
    expect((option.legend as { show: boolean }).show).toBe(false)
    const titles = option.title as Array<{ text: string }>
    expect(titles).toHaveLength(1)
    expect(titles[0].text).toBe('RSI(14)')
  })

  it('titles the pane with the params the user set, not the class defaults', () => {
    const option = superChartOption({
      dark: false,
      bars: BARS,
      panes: ['ind:rsi'],
      indicators: [{ ...layer(indicator(), values()), params: { period: 21 } }],
    })
    expect((option.title as Array<{ text: string }>)[0].text).toBe('RSI(21)')
  })

  it('keeps the existing panes working when no indicator is selected', () => {
    const option = superChartOption({ dark: false, bars: BARS, panes: ['volume'], indicators: [] })
    expect(grids(option)).toHaveLength(2)
    expect(option.title).toEqual([])
  })
})

describe('superChartOption indicator pane guards', () => {
  it('never gives a main-pane indicator a pane of its own, even if asked', () => {
    // `pane` belongs to the Python class; honouring an `ind:` key that
    // disagrees with it would draw the indicator twice.
    const ma = indicator({ key: 'ma', label: 'MA', pane: 'main', value_range: null, guides: [] })
    const option = superChartOption({
      dark: false,
      bars: BARS,
      panes: ['ind:ma'],
      indicators: [layer(ma, values({ indicator: 'ma', outputs: { rsi: { values: [1, 2, 3, 4], valid_from: 0 } } }))],
    })
    expect(grids(option)).toHaveLength(1) // price only
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((option.series as any[]).filter((s) => s.name === 'MA RSI')).toHaveLength(1)
  })
})

describe('superChartOption tooltip', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function format(option: ReturnType<typeof superChartOption>, params: any[]): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const formatter = (option.tooltip as any).formatter as (p: unknown) => string
    return formatter(params)
  }

  const candleParam = { seriesIndex: 0, seriesType: 'candlestick', dataIndex: 1, value: [1, 10.5, 11.5, 10, 12] }

  it('lists the bar under the cursor without the nameless marker row ECharts adds', () => {
    // The candlestick series has no name and keeps its values in sub-rows, so
    // the default formatter opened the tooltip with a bare dot.
    const option = superChartOption({ dark: false, bars: BARS })
    const html = format(option, [{ ...candleParam, axisValueLabel: '2024-01-03', marker: '<span id="m"></span>' }])
    expect(html).toContain('2024-01-03')
    for (const [label, value] of [['open', '10.50'], ['close', '11.50'], ['lowest', '10.00'], ['highest', '12.00']]) {
      expect(html).toContain(`>${label}<`)
      expect(html).toContain(`>${value}<`)
    }
    expect(html).not.toContain('id="m"') // the series' own marker row is gone
    expect(html.match(/background-color/g)).toHaveLength(4) // one dot per value, no spare
  })

  it('formats an indicator value at the precision its class declared', () => {
    const option = superChartOption({
      dark: false,
      bars: BARS,
      panes: ['ind:rsi'],
      indicators: [layer(indicator(), values())],
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rsiIndex = (option.series as any[]).findIndex((s) => s.name === 'RSI RSI')
    const html = format(option, [
      candleParam,
      { seriesIndex: rsiIndex, seriesType: 'line', seriesName: 'RSI RSI', dataIndex: 3, value: 72 },
    ])
    expect(html).toContain('RSI RSI')
    expect(html).toContain('>72.0<') // precision 1
  })

  it('escapes a series name instead of pasting it into the tooltip as markup', () => {
    const evil = indicator({ key: 'x', label: '<img src=x>', outputs: [{ key: 'v', label: 'V', kind: 'line', color: 1, style: 'solid' }] })
    const option = superChartOption({
      dark: false,
      bars: BARS,
      panes: ['ind:x'],
      indicators: [layer(evil, null)],
    })
    const html = format(option, [
      { seriesIndex: 1, seriesType: 'line', seriesName: '<img src=x> V', dataIndex: 0, value: null },
    ])
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x&gt; V')
  })
})
