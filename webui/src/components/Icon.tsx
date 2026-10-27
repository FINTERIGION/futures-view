/**
 * The panel's whole icon set, inline.
 *
 * It replaces the glyphs the shell used to draw with text (`☰`, `▾`, `✎`,
 * `✕`, `+`): those render in whatever the user's emoji or CJK font decides,
 * at a size and weight nothing here controls, and several of them are
 * genuinely different shapes across platforms. These are 16px stroked paths
 * on one grid, drawn in `currentColor` -- so an icon inside a button follows
 * that button through every variant, hover and disabled state without a
 * single colour rule of its own.
 *
 * Deliberately not a dependency: a full icon package is far more than the
 * dozen shapes this app needs, and paying a runtime import for it would be
 * the only npm dependency here that renders nothing on its own.
 */
export type IconName =
  | 'search'
  | 'close'
  | 'plus'
  | 'pencil'
  | 'chevron-down'
  | 'panel'
  | 'sun'
  | 'moon'
  | 'auto'
  | 'check'
  | 'trash'
  | 'alert'
  | 'success'
  | 'info'
  | 'keyboard'
  | 'candles'
  | 'download'
  | 'layers'
  | 'inbox'
  | 'line-chart'
  | 'lock'
  | 'unlock'

/** Path data only -- every icon shares the viewBox, stroke and cap settings
 * set on the <svg> below, which is what keeps the set looking like a set. */
const PATHS: Record<IconName, string> = {
  search: 'M7 2.6a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8M10.4 10.4 13.8 13.8',
  close: 'M4 4 12 12M12 4 4 12',
  plus: 'M8 3.2V12.8M3.2 8H12.8',
  pencil: 'M2.8 13.2l.7-2.8 7-7 2.1 2.1-7 7-2.8.7M9.6 3.8l2.1 2.1',
  'chevron-down': 'M4 6.2 8 10.2 12 6.2',
  panel: 'M2.4 3.4h11.2v9.2H2.4zM10 3.4v9.2',
  sun: 'M8 5.3a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4M8 1.4v1.3M8 13.3v1.3M1.4 8h1.3M13.3 8h1.3M3.3 3.3l.9.9M11.8 11.8l.9.9M12.7 3.3l-.9.9M4.2 11.8l-.9.9',
  moon: 'M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8',
  auto: 'M2.4 3.4h11.2v7.2H2.4zM6 13.4h4M8 10.6v2.8',
  check: 'M3.4 8.4 6.4 11.4 12.6 4.6',
  trash: 'M2.8 4.4h10.4M6.2 4.4V2.8h3.6v1.6M4.4 4.4l.6 8.8h6l.6-8.8M6.6 6.8v4.4M9.4 6.8v4.4',
  alert: 'M8 2.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 8 2.2M8 4.9v3.6M8 10.7v.1',
  success: 'M8 2.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 8 2.2M5.3 8.2 7.2 10.1 10.7 6',
  info: 'M8 2.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 8 2.2M8 7.3v3.9M8 4.9v.1',
  keyboard: 'M1.6 4h12.8v8H1.6zM4.2 6.4h.1M6.6 6.4h.1M9 6.4h.1M11.4 6.4h.1M4.2 9.6h7.6',
  candles: 'M5 2.4v11.2M5 4.6h.01M3.4 4.6h3.2v6.4H3.4zM11 2.4v11.2M9.4 6.2h3.2v4.8H9.4z',
  download: 'M8 2.6v6.8M5.2 6.8 8 9.6l2.8-2.8M2.8 12.8h10.4',
  layers: 'M8 2.4 14 5.6 8 8.8 2 5.6zM2 10.4 8 13.6 14 10.4',
  inbox: 'M2.2 9.2h3.4l1 2h2.8l1-2h3.4M3.9 3.4h8.2l1.6 5.8v3.4H2.3V9.2z',
  'line-chart': 'M2.2 12.4 6.2 7.8 9 10.2 13.8 4',
  lock: 'M5.2 7.2V5.4a2.8 2.8 0 0 1 5.6 0v1.8M3.6 7.2h8.8v6.4H3.6z',
  unlock: 'M5.2 7.2V5.4a2.8 2.8 0 0 1 5.2-1.4M3.6 7.2h8.8v6.4H3.6z',
}

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName
  size?: number
  className?: string
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      // Every icon here sits next to a label or inside a control that already
      // carries its own accessible name, so none of them should be announced
      // a second time.
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
