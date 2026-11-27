// Validated categorical/status palette kept as plain hex/rgba literals because
// ECharts renders to canvas and cannot read CSS custom properties directly.
// Surface and ink colors match the Scheme A cool-neutral tokens in index.css.

export const CATEGORICAL_LIGHT = [
  '#2563eb', // 1 blue
  '#ea580c', // 2 orange
  '#0d9488', // 3 teal
  '#d97706', // 4 amber
  '#db2777', // 5 pink
  '#16a34a', // 6 green
  '#7c3aed', // 7 violet
  '#dc2626', // 8 red
]

export const CATEGORICAL_DARK = [
  '#60a5fa',
  '#fb923c',
  '#2dd4bf',
  '#fbbf24',
  '#f472b6',
  '#4ade80',
  '#a78bfa',
  '#f87171',
]

export const STATUS = {
  good: '#0d9448',
  warning: '#d97706',
  serious: '#ea580c',
  critical: '#dc2626',
}

// Chinese-market candlestick convention: red = price rose, green = price fell.
export const CANDLE = {
  up: '#e14948',
  down: '#12a572',
}

export const CHART_SURFACE = { light: '#ffffff', dark: '#111419' }
export const INK = {
  light: {
    primary: '#111318',
    secondary: '#525866',
    muted: '#868c98',
    grid: 'rgba(15, 23, 42, 0.06)',
    axis: 'rgba(15, 23, 42, 0.16)',
  },
  dark: {
    primary: '#f0f2f5',
    secondary: '#98a2b3',
    muted: '#667085',
    grid: 'rgba(255, 255, 255, 0.055)',
    axis: 'rgba(255, 255, 255, 0.14)',
  },
}
