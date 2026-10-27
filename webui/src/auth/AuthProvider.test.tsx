import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authApi } from '../api/auth'
import { AuthProvider } from './AuthProvider'

vi.mock('../api/auth', () => ({
  AUTH_STATUS_KEY: ['auth', 'status'],
  authApi: {
    status: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    updatePassword: vi.fn(),
  },
}))

function renderGated() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <div>workspace</div>
      </AuthProvider>
    </QueryClientProvider>,
  )
}

describe('the access-password gate', () => {
  beforeEach(() => {
    vi.mocked(authApi.status).mockReset()
    vi.mocked(authApi.login).mockReset()
  })

  it('shows the workspace when no password is set', async () => {
    vi.mocked(authApi.status).mockResolvedValue({ password_set: false, authenticated: true })
    renderGated()
    expect(await screen.findByText('workspace')).toBeInTheDocument()
  })

  it('asks for the password when one is set and this browser is not signed in', async () => {
    vi.mocked(authApi.status).mockResolvedValue({ password_set: true, authenticated: false })
    renderGated()
    expect(await screen.findByRole('heading', { name: 'This panel is password-protected' })).toBeInTheDocument()
    expect(screen.queryByText('workspace')).toBeNull()
  })

  it('lets the workspace through after a successful login', async () => {
    const user = userEvent.setup()
    vi.mocked(authApi.status)
      .mockResolvedValueOnce({ password_set: true, authenticated: false })
      .mockResolvedValue({ password_set: true, authenticated: true })
    vi.mocked(authApi.login).mockResolvedValue({ ok: true })

    renderGated()
    await screen.findByLabelText('Password')
    await user.type(screen.getByLabelText('Password'), 'correct-horse')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(authApi.login).toHaveBeenCalledWith('correct-horse'))
    expect(await screen.findByText('workspace')).toBeInTheDocument()
  })
})
