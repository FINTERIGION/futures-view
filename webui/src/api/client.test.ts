import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, errorMessage, setUnauthorizedHandler } from './client'

describe('client api request', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    setUnauthorizedHandler(null)
  })

  it('sets default Content-Type to application/json', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )

    await api.get('/test')
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0]
    const headers = init?.headers as Headers
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it('merges custom headers while keeping default Content-Type', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )

    await api.post('/test', { foo: 'bar' })
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0]
    const headers = init?.headers as Headers
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it('allows overriding Content-Type', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )

    // Call request through custom header
    await fetch('/api/test', {
      headers: new Headers({ 'Content-Type': 'application/x-custom', 'X-Trace': '123' }),
    })
  })

  it('handles 204 No Content returning undefined', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(null, { status: 204 }))
    const res = await api.del('/item/1')
    expect(res).toBeUndefined()
  })

  it('triggers onUnauthorized on 401 for non-login endpoints', async () => {
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: 'Session expired' }), { status: 401 }),
    )

    await expect(api.get('/secure')).rejects.toThrow(ApiError)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('does not trigger onUnauthorized on 401 for /auth/login', async () => {
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: 'Wrong password' }), { status: 401 }),
    )

    await expect(api.post('/auth/login', { password: 'bad' })).rejects.toThrow(ApiError)
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('formats error messages correctly', () => {
    expect(errorMessage(new ApiError(400, 'Plain error'))).toBe('Plain error')
    expect(errorMessage(new ApiError(422, [{ loc: ['body', 'param'], msg: 'field required' }]))).toBe('body.param: field required')
    expect(errorMessage(new Error('Normal error'))).toBe('Normal error')
  })
})

