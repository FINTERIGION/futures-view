import { createContext, useContext, type ReactNode } from 'react'
import { useJob } from '../hooks/useJob'

export type JobSlot = 'backtest' | 'data' | 'alert'
export type Job = ReturnType<typeof useJob>

const JobsContext = createContext<Record<JobSlot, Job> | null>(null)

/**
 * Named, always-mounted `useJob()` instances, so a running backtest or
 * alert preview keeps streaming while the drawer tab showing it is switched
 * away from and back.
 *
 * `useJob` takes no arguments and is driven imperatively via `start(id)` --
 * nothing binds a given instance to a page or a job kind. Calling it once
 * per slot gives independent EventSource connections that live for as long
 * as this provider does (mounted once, at the top of the workspace, above
 * the bottom drawer), rather than for as long as whichever panel happens to
 * be showing. The hook itself is untouched -- `useJob.test.ts`'s cases
 * exercise it exactly as before.
 */
export function JobsProvider({ children }: { children: ReactNode }) {
  const backtest = useJob()
  const data = useJob()
  const alert = useJob()
  return <JobsContext.Provider value={{ backtest, data, alert }}>{children}</JobsContext.Provider>
}

export function useJobs(): Record<JobSlot, Job> {
  const ctx = useContext(JobsContext)
  if (!ctx) throw new Error('useJobs must be used within a JobsProvider')
  return ctx
}

export function useJobSlot(slot: JobSlot): Job {
  return useJobs()[slot]
}
