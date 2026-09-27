import type { IndicatorOutput } from '../api/types'
import { CANDLE } from '../theme/palette'
import { chartTokens } from './theme'

/**
 * Turn an indicator author's colour *declaration* into a hex for the current
 * theme.
 *
 * Resolution has to happen here rather than on the server: `useIsDarkMode`
 * flips the whole chart without refetching anything, so a hex chosen in
 * Python would be the light-theme colour still sitting on a dark surface.
 * What crosses the wire is therefore the declaration itself.
 *
 * Accepted forms, in the order an author should reach for them:
 *
 * - `number` — a slot in the categorical palette. `CATEGORICAL_LIGHT` and
 *   `CATEGORICAL_DARK` are index-aligned by hue, so one number is correct in
 *   both themes. This is the form to prefer, because a Python author has no
 *   way to eyeball a hex against the dark chart surface.
 * - `'up' | 'down' | 'muted' | 'axis'` — semantic tokens. `up`/`down` are the
 *   candle colours, which follow the Chinese-market convention (red = rose).
 * - `'#rrggbb'` — a literal, for an author who has checked both themes.
 * - `[a, b]` — the `>= 0` / `< 0` pair of a sign-coloured bar; `resolveColor`
 *   takes the first, and `resolveBarColors` returns both.
 * - `'candle'` is not resolved here. A bar that declares it is coloured per
 *   point from that day's price (see `dayBarStyle` in superChartOption),
 *   because the colour depends on the candle, not on one hex.
 *
 * `fallbackIndex` is assigned by the caller across every rendered output in
 * order, so two indicators that both declared nothing do not collide on the
 * same hue.
 */
export function resolveColor(
  decl: IndicatorOutput['color'],
  dark: boolean,
  fallbackIndex: number,
): string {
  const { categorical, ink } = chartTokens(dark)
  const slot = (i: number) => categorical[((i % categorical.length) + categorical.length) % categorical.length]

  if (Array.isArray(decl)) return resolveColor(decl[0] ?? null, dark, fallbackIndex)
  if (typeof decl === 'number' && Number.isFinite(decl)) return slot(decl)
  if (typeof decl === 'string') {
    if (decl.startsWith('#')) return decl
    const tokens: Record<string, string> = {
      up: CANDLE.up,
      down: CANDLE.down,
      muted: ink.muted,
      axis: ink.axis,
    }
    // An unrecognized token falls back rather than throwing: the author is
    // editing Python and hot-reloading, and a typo should cost them a colour,
    // not the chart.
    return tokens[decl] ?? slot(fallbackIndex)
  }
  return slot(fallbackIndex)
}

/** The `[>= 0, < 0]` colours of a sign-coloured bar. A declaration that is not
 * a pair uses the one colour for both, which is what a plain `kind: 'bar'`
 * asks for. */
export function resolveBarColors(
  decl: IndicatorOutput['color'],
  dark: boolean,
  fallbackIndex: number,
): [string, string] {
  if (Array.isArray(decl)) {
    return [
      resolveColor(decl[0] ?? null, dark, fallbackIndex),
      resolveColor(decl[1] ?? null, dark, fallbackIndex),
    ]
  }
  const one = resolveColor(decl, dark, fallbackIndex)
  return [one, one]
}

/** ECharts `lineStyle.type` for a declared style. */
export function lineDash(style: IndicatorOutput['style']): 'solid' | 'dashed' | 'dotted' {
  return style === 'dashed' || style === 'dotted' ? style : 'solid'
}
