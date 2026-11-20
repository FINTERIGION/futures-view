import type { AlertMonitor, AlertSnapshot } from '../api/types'

export interface InflightPreview {
  cacheKey: string
  entryId: string
  jobId: string
  batch: boolean
}

interface CachedPreviewEntry {
  snapshot: AlertSnapshot
  /** `Date.now() / 1000` when this local preview finished, used to let newer
   * server-side snapshots (e.g. from scheduled/manual dispatch) win over older
   * in-tab previews instead of being permanently shadowed. */
  capturedAt: number
}

/** Live snapshots & batch queue survive tab switches and drawer collapses;
 * backend-persisted snapshots cover page reloads and headless scheduled runs. */
export const alertPreviewStore = {
  previewCache: new Map<string, CachedPreviewEntry>(),
  previewErrors: new Map<string, string>(),
  stalePreviews: new Set<string>(),
  announcedDataJob: null as string | null,
  inflight: null as InflightPreview | null,
  pendingIds: [] as string[],
  batchTotal: 0,
  starting: false,
  migrationStarted: false,
}

export function previewKey(entry: AlertMonitor, symbols: string[]): string {
  return `${entry.id}::${symbols.join(',')}::${JSON.stringify(entry.params)}`
}

export function resetAlertPreviewState() {
  alertPreviewStore.previewCache.clear()
  alertPreviewStore.previewErrors.clear()
  alertPreviewStore.stalePreviews.clear()
  alertPreviewStore.announcedDataJob = null
  alertPreviewStore.inflight = null
  alertPreviewStore.pendingIds = []
  alertPreviewStore.batchTotal = 0
  alertPreviewStore.starting = false
  alertPreviewStore.migrationStarted = false
}

/** Clear cached snapshots/stale markers (e.g. after a server-side alert dispatch
 * wrote fresher snapshots to SQLite, or on logout/401). */
export function invalidateAlertPreviewCache() {
  alertPreviewStore.previewCache.clear()
  alertPreviewStore.previewErrors.clear()
  alertPreviewStore.stalePreviews.clear()
}

export function cachedPreview(entry: AlertMonitor, symbols: string[]): AlertSnapshot | undefined {
  const key = previewKey(entry, symbols)
  const local = alertPreviewStore.previewCache.get(key)
  if (local) {
    // If the server computed a newer snapshot (e.g. scheduled/manual dispatch),
    // prefer it and evict the older in-memory entry.
    if (entry.last_snapshot && entry.last_checked_at !== null && entry.last_checked_at > local.capturedAt + 1) {
      alertPreviewStore.previewCache.delete(key)
      return entry.last_snapshot
    }
    return local.snapshot
  }
  return entry.last_snapshot ?? undefined
}

export function setCachedPreview(key: string, snapshot: AlertSnapshot) {
  alertPreviewStore.previewCache.set(key, { snapshot, capturedAt: Date.now() / 1000 })
}

export function cachedError(entry: AlertMonitor, symbols: string[]): string | undefined {
  return alertPreviewStore.previewErrors.get(previewKey(entry, symbols)) ?? entry.last_error ?? undefined
}

export function dropPreview(entryId: string) {
  for (const key of [...alertPreviewStore.previewCache.keys()]) {
    if (key.startsWith(`${entryId}::`)) alertPreviewStore.previewCache.delete(key)
  }
  for (const key of [...alertPreviewStore.previewErrors.keys()]) {
    if (key.startsWith(`${entryId}::`)) alertPreviewStore.previewErrors.delete(key)
  }
  for (const key of [...alertPreviewStore.stalePreviews]) {
    if (key.startsWith(`${entryId}::`)) alertPreviewStore.stalePreviews.delete(key)
  }
}
