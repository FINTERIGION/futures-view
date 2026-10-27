import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authApi } from '../api/auth'
import { ToastProvider } from '../components/Toast'
import { AccessDrawer } from './AccessDrawer'

vi.mock('../api/auth', () => ({
  AUTH_STATUS_KEY: ['auth', 'status'],
  authApi: {
    status: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    updatePassword: vi.fn(),
  },
}))

function renderDrawer() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <AccessDrawer open onClose={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  )
}

describe('the web-access drawer', () => {
  beforeEach(() => {
    vi.mocked(authApi.status).mockReset()
    vi.mocked(authApi.updatePassword).mockReset()
    vi.mocked(authApi.logout).mockReset()
  })

  it('sets a first password after the two fields agree', async () => {
    const user = userEvent.setup()
    vi.mocked(authApi.status).mockResolvedValue({ password_set: false, authenticated: true })
    vi.mocked(authApi.updatePassword).mockResolvedValue({ password_set: true })
    renderDrawer()

    expect(await screen.findByText('No password')).toBeInTheDocument()
    await user.type(screen.getByLabelText('New password'), 'correct-horse')
    await user.type(screen.getByLabelText('Confirm password'), 'different-one')
    await user.click(screen.getByRole('button', { name: 'Set password' }))
    expect(authApi.updatePassword).not.toHaveBeenCalled()
    expect(screen.getByText('The two passwords do not match.')).toBeInTheDocument()

    await user.clear(screen.getByLabelText('Confirm password'))
    await user.type(screen.getByLabelText('Confirm password'), 'correct-horse')
    await user.click(screen.getByRole('button', { name: 'Set password' }))

    await waitFor(() =>
      expect(vi.mocked(authApi.updatePassword).mock.calls[0][0]).toEqual({
        current: undefined,
        password: 'correct-horse',
      }),
    )
  })

  it('sends the current password when changing or removing one', async () => {
    const user = userEvent.setup()
    vi.mocked(authApi.status).mockResolvedValue({ password_set: true, authenticated: true })
    vi.mocked(authApi.updatePassword).mockResolvedValue({ password_set: true })
    renderDrawer()

    expect(await screen.findByText('Password is set')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Current password'), 'correct-horse')
    await user.type(screen.getByLabelText('New password'), 'new-password')
    await user.type(screen.getByLabelText('Confirm password'), 'new-password')
    await user.click(screen.getByRole('button', { name: 'Change password' }))

    await waitFor(() =>
      expect(vi.mocked(authApi.updatePassword).mock.calls[0][0]).toEqual({
        current: 'correct-horse',
        password: 'new-password',
      }),
    )
  })

  it('asks for the current password before removing it', async () => {
    const user = userEvent.setup()
    vi.mocked(authApi.status).mockResolvedValue({ password_set: true, authenticated: true })
    vi.mocked(authApi.updatePassword).mockResolvedValue({ password_set: false })
    renderDrawer()

    await screen.findByText('Password is set')
    await user.type(screen.getByLabelText('Current password'), 'correct-horse')
    await user.click(screen.getByRole('button', { name: 'Remove password' }))
    const dialog = screen.getByRole('dialog', { name: 'Remove password' })
    await user.click(within(dialog).getByRole('button', { name: 'Remove password' }))

    await waitFor(() =>
      expect(vi.mocked(authApi.updatePassword).mock.calls[0][0]).toEqual({
        current: 'correct-horse',
        password: null,
      }),
    )
  })
})
