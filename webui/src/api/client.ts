// Thin fetch wrapper. The dev server proxies /api to the FastAPI backend
// (see vite.config.ts); a production build is served by that same backend
// process, so a relative path works in both cases.

export class ApiError extends Error {
  status: number
  detail: unknown

  constructor(status: number, detail: unknown) {
    super(typeof detail === 'string' ? detail : JSON.stringify(detail))
    this.status = status
    this.detail = detail
  }
}

/** Called when any request other than login comes back 401. The auth gate
 * registers this so an expired session swaps the workspace for the login
 * screen instead of leaving every panel on a failed query. */
let onUnauthorized: (() => void) | null = null

export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!resp.ok) {
    let detail: unknown = resp.statusText
    try {
      const body = await resp.json()
      detail = body.detail ?? body
    } catch {
      // no JSON body
    }
    // Login's own 401 is "wrong password", not a lost session -- firing the
    // handler there would remount the form mid-submit.
    if (resp.status === 401 && path !== '/auth/login') onUnauthorized?.()
    throw new ApiError(resp.status, detail)
  }
  if (resp.status === 204) return undefined as T
  return (await resp.json()) as T
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body !== undefined ? JSON.stringify(body) : undefined }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

/** Detail message extraction that copes with FastAPI's validation-error shape
 * (a list of {loc, msg} objects) as well as our own plain-string HTTPException
 * details. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (typeof err.detail === 'string') return err.detail
    if (Array.isArray(err.detail)) {
      return err.detail
        .map((d: { loc?: unknown[]; msg?: string }) => `${(d.loc ?? []).join('.')}: ${d.msg ?? ''}`)
        .join('; ')
    }
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}
