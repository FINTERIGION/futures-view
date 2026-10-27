import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { LoginScreen } from './LoginScreen'

describe('the login screen', () => {
  it('submits the typed password and keeps the form up when the server refuses', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockRejectedValue(new ApiError(401, 'Wrong password'))
    render(<LoginScreen onSubmit={onSubmit} />)

    await user.type(screen.getByLabelText('Password'), 'guess-wrong')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(onSubmit).toHaveBeenCalledWith('guess-wrong')
    expect(await screen.findByText('Wrong password')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
  })

  it('explains a 429 instead of echoing the server sentence', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockRejectedValue(new ApiError(429, 'Too many attempts; wait a minute and try again.'))
    render(<LoginScreen onSubmit={onSubmit} />)

    await user.type(screen.getByLabelText('Password'), 'guess-wrong')
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Too many attempts. Wait a minute and try again.')).toBeInTheDocument()
  })
})
