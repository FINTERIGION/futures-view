import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { alertsApi, jobsApi, strategiesApi } from '../api/endpoints'
import type { AlertSnapshot } from '../api/types'
import { MockEventSource } from '../test/setup'
import { STRATEGIES, renderWorkspace } from '../test/utils'
import { AlertPanel, resetAlertPreviewState } from './AlertPanel'

vi.mock('../api/endpoints', () => ({
  strategiesApi: { list: vi.fn() },
  alertsApi: { preview: vi.fn() },
  jobsApi: { get: vi.fn(), cancel: vi.fn(), streamUrl: (id: string) => `/api/jobs/${id}/stream` },
}))

const SNAPSHOT: AlertSnapshot = {
  asof: '2026-10-24',
  blown_up: false,
  symbols: [
    {
      symbol: 'CF',
      contract: 'CF605',
      operation: 'open_long',
      stop: { price: 12340, distance: null },
      take_profit: { price: null, distance: null },
    },
    {
      symbol: 'SA',
      contract: 'SA509',
      operation: 'hold',
      stop: { price: null, distance: 5 },
      take_profit: { price: null, distance: null },
    },
  ],
}

const DONE_JOB = {
  id: 'aj1',
  kind: 'alert',
  status: 'done' as const,
  progress: 1,
  message: 'Done',
  error: null,
  created_at: 0,
  started_at: 0,
  finished_at: 0,
  cancel_requested: false,
  result: SNAPSHOT,
}

function fieldInput(label: string) {
  const field = screen.getByText(label).closest('.field')!
  return within(field as HTMLElement).getByRole('spinbutton')
}

function entryRow(strategy: string) {
  const cell = screen.getAllByText(strategy).find((el) => el.closest('tbody') && el.closest('tr'))
  const row = cell?.closest('tr')
  if (!row) throw new Error(`no row for ${strategy}`)
  return row
}

async function finishPreview() {
  await waitFor(() => expect(alertsApi.preview).toHaveBeenCalled())
  await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0))
  MockEventSource.instances.at(-1)!.emit({ type: 'state', status: 'done', progress: 1, message: 'Done' })
  await waitFor(() => expect(screen.getByText('CF605')).toBeInTheDocument())
}

beforeEach(() => {
  resetAlertPreviewState()
  vi.clearAllMocks()
  vi.mocked(strategiesApi.list).mockResolvedValue(STRATEGIES)
  vi.mocked(alertsApi.preview).mockResolvedValue({ job_id: 'aj1' })
  vi.mocked(jobsApi.get).mockResolvedValue(DONE_JOB)
})

function renderPanel() {
  return renderWorkspace(<AlertPanel />, { path: '/?symbol=SA&tab=alerts' })
}

describe('saving an alert entry', () => {
  it('lets the params be edited like the backtest form, then freezes them on the row', async () => {
    const user = userEvent.setup()
    localStorage.setItem('ft.strategyParams', JSON.stringify({ double_ma: { fast: 8 } }))
    localStorage.setItem('ft.extraSymbols', JSON.stringify(['CF']))
    renderPanel()
    await user.click(await screen.findByRole('button', { name: 'Add' }))
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('double_ma'))
    expect(fieldInput('fast')).toHaveValue(8)
    expect(fieldInput('slow')).toHaveValue(30)
    expect(screen.getByText('SA')).toBeInTheDocument()
    expect(screen.getByText('CF')).toBeInTheDocument()

    fireEvent.change(fieldInput('fast'), { target: { value: '12' } })
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.queryByLabelText('fast')).not.toBeInTheDocument()
    expect(entryRow('double_ma')).toHaveTextContent('SA, CF')
    expect(entryRow('double_ma')).toHaveTextContent('12, 30')
    await waitFor(() =>
      expect(alertsApi.preview).toHaveBeenCalledWith({
        strategy: 'double_ma',
        symbols: ['SA', 'CF'],
        params: { fast: 12, slow: 30 },
      }),
    )
  })

  it('does not save when the sidebar universe is empty', async () => {
    const user = userEvent.setup()
    renderWorkspace(<AlertPanel />, { path: '/?tab=alerts' })
    await user.click(await screen.findByRole('button', { name: 'Add' }))
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('double_ma'))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})

describe('selecting an entry', () => {
  it('does not expand or preview until a row is clicked', async () => {
    localStorage.setItem(
      'ft.alertEntries',
      JSON.stringify([{ id: 'e1', strategy: 'double_ma', symbols: ['SA'], params: {}, createdAt: 1 }]),
    )
    renderPanel()

    expect(await screen.findByText('double_ma')).toBeInTheDocument()
    expect(screen.queryByText('CF605')).not.toBeInTheDocument()
    expect(alertsApi.preview).not.toHaveBeenCalled()
  })

  it('expands the contract / action / stop table once the preview job finishes', async () => {
    const user = userEvent.setup()
    localStorage.setItem(
      'ft.alertEntries',
      JSON.stringify([{ id: 'e1', strategy: 'double_ma', symbols: ['SA', 'CF'], params: { fast: 8 }, createdAt: 1 }]),
    )
    renderPanel()

    await user.click(await screen.findByText('double_ma'))
    await finishPreview()

    expect(screen.getByText('Open long')).toBeInTheDocument()
    expect(screen.getByText('Hold')).toBeInTheDocument()
    expect(screen.getByText('12340')).toBeInTheDocument()
    expect(screen.getByText('next open ±5')).toBeInTheDocument()
    expect(screen.getByText('As of 2026-10-24')).toBeInTheDocument()
    expect(entryRow('double_ma')).toHaveTextContent('8, 30')
    expect(screen.queryByRole('heading', { name: 'double_ma' })).not.toBeInTheDocument()
    expect(entryRow('double_ma').nextElementSibling).toHaveClass('row-expand')
    expect(within(entryRow('double_ma').nextElementSibling as HTMLElement).getByText('CF605')).toBeInTheDocument()
    expect(screen.queryByText(/size/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('fast')).not.toBeInTheDocument()
  })

  it('previews the universe stored on the row, not the live sidebar', async () => {
    const user = userEvent.setup()
    localStorage.setItem(
      'ft.alertEntries',
      JSON.stringify([{ id: 'e1', strategy: 'double_ma', symbols: ['CF', 'FG'], params: {}, createdAt: 1 }]),
    )
    renderPanel()

    await user.click(await screen.findByText('double_ma'))
    await waitFor(() =>
      expect(alertsApi.preview).toHaveBeenCalledWith({
        strategy: 'double_ma',
        symbols: ['CF', 'FG'],
        params: {},
      }),
    )
  })

  it('still previews an older entry that never stored a universe against the live sidebar', async () => {
    const user = userEvent.setup()
    localStorage.setItem(
      'ft.alertEntries',
      JSON.stringify([{ id: 'e1', strategy: 'double_ma', params: {}, createdAt: 1 }]),
    )
    renderPanel()

    await user.click(await screen.findByText('double_ma'))
    await waitFor(() =>
      expect(alertsApi.preview).toHaveBeenCalledWith({
        strategy: 'double_ma',
        symbols: ['SA'],
        params: {},
      }),
    )
  })

  it('does not start a second preview when the same row is selected again', async () => {
    const user = userEvent.setup()
    localStorage.setItem(
      'ft.alertEntries',
      JSON.stringify([{ id: 'e1', strategy: 'double_ma', symbols: ['SA'], params: {}, createdAt: 1 }]),
    )
    localStorage.setItem('ft.alertActiveId', JSON.stringify('e1'))
    renderPanel()
    await finishPreview()
    vi.mocked(alertsApi.preview).mockClear()

    await user.click(entryRow('double_ma'))
    expect(alertsApi.preview).not.toHaveBeenCalled()
    expect(screen.getByText('CF605')).toBeInTheDocument()
  })
})

describe('refresh and delete', () => {
  it('refresh drops the cached snapshot and asks again', async () => {
    const user = userEvent.setup()
    localStorage.setItem(
      'ft.alertEntries',
      JSON.stringify([{ id: 'e1', strategy: 'double_ma', symbols: ['SA'], params: {}, createdAt: 1 }]),
    )
    localStorage.setItem('ft.alertActiveId', JSON.stringify('e1'))
    renderPanel()
    await finishPreview()
    vi.mocked(alertsApi.preview).mockClear()

    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(alertsApi.preview).toHaveBeenCalledTimes(1))
  })

  it('delete asks first and then removes the row', async () => {
    const user = userEvent.setup()
    localStorage.setItem(
      'ft.alertEntries',
      JSON.stringify([{ id: 'e1', strategy: 'double_ma', symbols: ['SA'], params: {}, createdAt: 1 }]),
    )
    localStorage.setItem('ft.alertActiveId', JSON.stringify('e1'))
    renderPanel()
    await finishPreview()

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(screen.queryByText('double_ma')).not.toBeInTheDocument())
    expect(screen.getByText('No alerts yet')).toBeInTheDocument()
  })
})
