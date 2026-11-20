import { useCallback, useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'

const MIN_HEIGHT = 160
const MAX_RATIO = 0.7
const KEY_STEP = 24

export function clampDrawerHeight(height: number, viewportHeight: number): number {
  const max = Math.max(MIN_HEIGHT, viewportHeight * MAX_RATIO)
  return Math.min(Math.max(height, MIN_HEIGHT), max)
}

export function useDrawerResize(height: number, onCommit: (height: number) => void) {
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(
    () => () => {
      cleanupRef.current?.()
      cleanupRef.current = null
    },
    [],
  )

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      cleanupRef.current?.()
      const handle = e.currentTarget
      const pointerId = e.pointerId
      const startY = e.clientY
      const startHeight = height
      const grid = handle.closest<HTMLElement>('.workspace') ?? document.documentElement
      try {
        handle.setPointerCapture(pointerId)
      } catch {
        // synthetic or unsupported pointer capture
      }
      document.body.classList.add('drawer-resizing')

      const apply = (clientY: number) => {
        const next = clampDrawerHeight(startHeight + (startY - clientY), window.innerHeight)
        grid.style.setProperty('--drawer-h', `${next}px`)
        return next
      }

      const move = (ev: PointerEvent) => {
        apply(ev.clientY)
      }

      const teardown = () => {
        try {
          if (handle.hasPointerCapture?.(pointerId)) {
            handle.releasePointerCapture(pointerId)
          }
        } catch {
          // capture already lost
        }
        document.body.classList.remove('drawer-resizing')
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', cancel)
        cleanupRef.current = null
      }

      const up = (ev: PointerEvent) => {
        teardown()
        onCommit(apply(ev.clientY))
      }

      const cancel = () => {
        teardown()
        grid.style.setProperty('--drawer-h', `${startHeight}px`)
      }

      cleanupRef.current = teardown
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', cancel)
    },
    [height, onCommit],
  )

  const onHandleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>) => {
      const step = e.key === 'ArrowUp' ? KEY_STEP : e.key === 'ArrowDown' ? -KEY_STEP : 0
      if (step === 0) return
      e.preventDefault()
      onCommit(clampDrawerHeight(height + step, window.innerHeight))
    },
    [height, onCommit],
  )

  return { onPointerDown, onHandleKeyDown }
}
