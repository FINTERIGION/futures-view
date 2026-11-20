import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../api/client'
import { jobsApi } from '../api/endpoints'
import type { JobState } from '../api/types'

export interface LogLine {
  level: string
  message: string
}

/** Job statuses that will never change again. Exported because JobProgress
 * needs the same list to decide whether a lost job's last known status was
 * already an answer. */
export const TERMINAL = ['done', 'error', 'cancelled']

/** How often to ask the server directly once the event stream has dropped. */
const POLL_MS = 3000

/** Drives one job's SSE stream (see web/routers/jobs.py) and exposes its live
 * state + accumulated log.
 *
 * The connection itself can drop -- a restarted backend, a sleeping laptop, a
 * proxy timing out. That used to end the job as far as the UI was concerned:
 * `onerror` closed the stream and nothing ever asked again, so a job that had
 * long since finished sat at "running" forever. On error we fall back to
 * polling `jobsApi.get`, which is enough to carry progress and the terminal
 * result even with no stream at all.
 *
 * Polling has to tell two failures apart, though. A network error means the
 * backend may be mid-restart and is worth retrying. A 404 means the job is not
 * coming back: the registry is an in-memory dict (see web/jobs.py), so a
 * restart empties it, and `JobManager._prune` drops finished jobs past
 * `JOB_RETENTION` besides. Retrying that forever polled a job that could never
 * answer, every 3s for the life of the tab, while the UI sat on "running" --
 * and `isActive` stayed true, so the Run button never came back either. A 404
 * stops the poll and raises `lost` instead.
 */
export function useJob() {
  const [jobId, setJobId] = useState<string | null>(null)
  const [state, setState] = useState<JobState | null>(null)
  const [logs, setLogs] = useState<LogLine[]>([])
  const [streaming, setStreaming] = useState(false)
  const [lost, setLost] = useState(false)
  const sourceRef = useRef<EventSource | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const genRef = useRef(0)

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const stop = useCallback(() => {
    sourceRef.current?.close()
    sourceRef.current = null
    stopPolling()
    setStreaming(false)
  }, [stopPolling])

  /** A stream frame and a plain GET carry the same fields, except that only
   * the GET includes `result` and SSE frames omit `id` -- always inject the
   * known job id so `state.id` is stable from the very first frame. */
  const applyState = useCallback((id: string, payload: Partial<JobState> & { status: string }) => {
    setState({ ...(payload as JobState), id: payload.id ?? id })
  }, [])

  const startPolling = useCallback(
    (id: string, gen: number) => {
      if (pollRef.current !== null) return
      const tick = () => {
        void jobsApi
          .get(id)
          .then((job) => {
            if (genRef.current !== gen) return
            applyState(id, job)
            if (TERMINAL.includes(job.status)) stopPolling()
          })
          .catch((err: unknown) => {
            if (genRef.current !== gen) return
            if (err instanceof ApiError && err.status === 404) {
              stopPolling()
              setLost(true)
              return
            }
            /* anything else: keep polling, the backend may just be restarting */
          })
      }
      tick()
      pollRef.current = setInterval(tick, POLL_MS)
    },
    [applyState, stopPolling],
  )

  const reset = useCallback(() => {
    genRef.current += 1
    stop()
    setJobId(null)
    setState(null)
    setLogs([])
    setLost(false)
  }, [stop])

  const start = useCallback(
    (id: string) => {
      reset()
      const gen = ++genRef.current
      setJobId(id)

      const source = new EventSource(jobsApi.streamUrl(id))
      sourceRef.current = source
      setStreaming(true)

      source.onopen = () => {
        if (genRef.current !== gen) return
        setStreaming(true)
        stopPolling()          // the stream is authoritative again
      }

      source.onmessage = (evt) => {
        if (genRef.current !== gen) return
        try {
          const payload = JSON.parse(evt.data)
          if (payload.type === 'log') {
            setLogs((prev) => [...prev, { level: payload.level, message: payload.message }])
          } else if (payload.type === 'state') {
            applyState(id, payload)
            if (TERMINAL.includes(payload.status)) {
              source.close()
              sourceRef.current = null
              setStreaming(false)
              // Fetch the terminal job record once so `result` is populated.
              // On failure, still settle `result` (or `lost` on 404) so
              // consumers waiting on `'result' in state` never deadlock.
              void jobsApi
                .get(id)
                .then((job) => {
                  if (genRef.current !== gen) return
                  applyState(id, job)
                })
                .catch((err: unknown) => {
                  if (genRef.current !== gen) return
                  if (err instanceof ApiError && err.status === 404) {
                    setLost(true)
                    return
                  }
                  setState((prev) => (prev ? { ...prev, result: undefined } : prev))
                })
            }
          }
        } catch {
          // ignore malformed frame
        }
      }

      source.onerror = () => {
        if (genRef.current !== gen) return
        source.close()
        sourceRef.current = null
        setStreaming(false)
        startPolling(id, gen)
      }
    },
    [applyState, reset, startPolling, stopPolling],
  )

  useEffect(() => stop, [stop])

  const cancel = useCallback(() => {
    if (!jobId) return
    const gen = genRef.current
    void jobsApi.cancel(jobId).catch(() => {
      if (genRef.current !== gen) return
      void jobsApi
        .get(jobId)
        .then((job) => {
          if (genRef.current !== gen) return
          applyState(jobId, job)
        })
        .catch((err: unknown) => {
          if (genRef.current !== gen) return
          if (err instanceof ApiError && err.status === 404) setLost(true)
        })
    })
  }, [applyState, jobId])

  return {
    jobId,
    state,
    logs,
    start,
    cancel,
    reset,
    streaming,
    lost,
    // Treat the brief handshake between `start(id)` and the first SSE frame as
    // active too so double-clicks cannot submit a duplicate job in that gap.
    isActive: !lost && (state ? ['queued', 'running'].includes(state.status) : jobId !== null),
  }
}
