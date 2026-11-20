import { useEffect, useRef } from 'react'

/** True on Apple platforms, where the modifier is ⌘ rather than Ctrl. Read
 * once: it cannot change while the tab is open. */
export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** Render a combo the way this platform writes it, for tooltips and the
 * shortcut sheet. */
export function formatCombo(combo: string): string[] {
  return combo.split('+').map((part) => {
    if (part === 'mod') return IS_MAC ? '⌘' : 'Ctrl'
    if (part === 'shift') return IS_MAC ? '⇧' : 'Shift'
    // A single character is a keycap ("b" -> "B"); anything longer is a named
    // key, which is written the way a keyboard prints it ("enter" -> "Enter").
    return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)
  })
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

function matches(combo: string, e: KeyboardEvent): boolean {
  const parts = combo.split('+')
  const key = parts[parts.length - 1]
  const wantsMod = parts.includes('mod')
  const wantsShift = parts.includes('shift')
  const hasMod = e.metaKey || e.ctrlKey
  if (wantsMod !== hasMod) return false
  // Shift is only checked when the combo asks for it: `?` is *produced* by
  // shift on most layouts, so requiring shift to be absent would make that
  // binding unreachable.
  if (wantsShift && !e.shiftKey) return false
  if (e.altKey) return false
  return e.key.toLowerCase() === key.toLowerCase()
}

/** The bindings the workspace registers, in the order they are worth
 * learning. Kept beside the hook rather than beside the sheet that renders
 * them, so a shortcut cannot be added without a line here describing it -- and
 * so the sheet stays a file that exports only a component. */
export const SHORTCUTS: { combo: string; key: string }[] = [
  { combo: 'mod+b', key: 'workspace.shortcutSidebar' },
  { combo: 'mod+j', key: 'workspace.shortcutDrawer' },
  { combo: '/', key: 'workspace.shortcutSearch' },
  { combo: 'mod+enter', key: 'workspace.shortcutRun' },
  { combo: '?', key: 'workspace.shortcutHelp' },
]

/**
 * Window-level keyboard shortcuts for the workspace.
 *
 * `bindings` is read through a ref rather than closed over, so the listener is
 * attached exactly once: the handlers here capture workspace state that
 * changes on nearly every interaction, and re-subscribing on each of those
 * would drop and re-add a window listener at typing speed.
 *
 * A bare key (no modifier) never fires while a field has focus -- `/` belongs
 * to whoever is typing. A modified combo still does: Ctrl/⌘+B is not
 * something any text input wants.
 */
function hasModalOpen(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null
}

export function useHotkeys(bindings: Record<string, (e: KeyboardEvent) => void>) {
  const ref = useRef(bindings)
  useEffect(() => {
    ref.current = bindings
  })

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (hasModalOpen()) return
      const editing = isEditable(e.target)
      for (const [combo, handler] of Object.entries(ref.current)) {
        if (editing && !combo.includes('mod')) continue
        if (!matches(combo, e)) continue
        e.preventDefault()
        handler(e)
        return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
