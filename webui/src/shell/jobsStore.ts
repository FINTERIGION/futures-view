import { createContext, useContext } from 'react'
import type { useJob } from '../hooks/useJob'

export type JobSlot = 'backtest' | 'data' | 'alert' | 'dispatch'
export type Job = ReturnType<typeof useJob>

/** Shared completion tracking owned by the always-mounted `JobsProvider` so
 * panels that unmount across tab switches or sidebar/drawer collapses neither
 * drop finished runs nor emit duplicate completion toasts/refetches on remount. */
export interface JobLifecycleTracker {
  claimAnnouncement: (key: string) => boolean
  trackBacktestRun: (runId: string) => void
  clearPendingBacktestRun: () => void
  claimBacktestOverlay: (fallbackRunId: string | null) => string | null
}

export interface JobsContextValue {
  slots: Record<JobSlot, Job>
  lifecycle: JobLifecycleTracker
}

export const JobsContext = createContext<JobsContextValue | null>(null)

export function useJobs(): Record<JobSlot, Job> {
  const ctx = useContext(JobsContext)
  if (!ctx) throw new Error('useJobs must be used within a JobsProvider')
  return ctx.slots
}

export function useJobSlot(slot: JobSlot): Job {
  return useJobs()[slot]
}

export function useJobLifecycle(): JobLifecycleTracker {
  const ctx = useContext(JobsContext)
  if (!ctx) throw new Error('useJobLifecycle must be used within a JobsProvider')
  return ctx.lifecycle
}
