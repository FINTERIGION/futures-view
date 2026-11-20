import { useMemo, useRef, type ReactNode } from 'react'
import { useJob } from '../hooks/useJob'
import { JobsContext, type JobLifecycleTracker } from './jobsStore'

interface LifecycleState {
  announced: Set<string>
  pendingBacktestRunId: string | null
  overlaidBacktestRunId: string | null
}

export function JobsProvider({ children }: { children: ReactNode }) {
  const backtest = useJob()
  const data = useJob()
  const alert = useJob()
  const dispatch = useJob()
  const lifecycleRef = useRef<LifecycleState>({
    announced: new Set<string>(),
    pendingBacktestRunId: null,
    overlaidBacktestRunId: null,
  })

  const lifecycle = useMemo<JobLifecycleTracker>(
    () => ({
      claimAnnouncement: (key: string) => {
        if (lifecycleRef.current.announced.has(key)) return false
        lifecycleRef.current.announced.add(key)
        return true
      },
      trackBacktestRun: (runId: string) => {
        lifecycleRef.current.pendingBacktestRunId = runId
        lifecycleRef.current.overlaidBacktestRunId = null
      },
      clearPendingBacktestRun: () => {
        lifecycleRef.current.pendingBacktestRunId = null
      },
      claimBacktestOverlay: (fallbackRunId: string | null) => {
        const resolved = lifecycleRef.current.pendingBacktestRunId ?? fallbackRunId
        if (!resolved || lifecycleRef.current.overlaidBacktestRunId === resolved) return null
        lifecycleRef.current.overlaidBacktestRunId = resolved
        return resolved
      },
    }),
    [],
  )

  const value = useMemo(
    () => ({
      slots: { backtest, data, alert, dispatch },
      lifecycle,
    }),
    [backtest, data, alert, dispatch, lifecycle],
  )
  return <JobsContext.Provider value={value}>{children}</JobsContext.Provider>
}
