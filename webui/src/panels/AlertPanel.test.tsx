import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { alertsApi, dataApi, jobsApi, strategiesApi } from '../api/endpoints'
import type { AlertSnapshot } from '../api/types'
import { MockEventSource } from '../test/setup'
import { STRATEGIES, renderWorkspace } from '../test/utils'
import { AlertPanel, resetAlertPreviewState, type AlertEntry } from './AlertPanel'

vi.mock('../api/endpoints', () => ({
  strategiesApi: { list: vi.fn() },
  alertsApi: { preview: vi.fn() },
  dataApi: { update: vi.fn() },
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

function seedEntries(entries: Array<Partial<AlertEntry> & Pick<AlertEntry, 'id' | 'strategy'>>, activeId?: string) {
  localStorage.setItem(
    'ft.alertEntries',
    JSON.stringify(entries.map((entry) => ({ symbols: ['SA'], params: {}, createdAt: 1, ...entry }))),
  )
  if (activeId) localStorage.setItem('ft.alertActiveId', JSON.stringify(activeId))
}

async function finishLatestPreview(expectTable = true) {
  await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0))
  MockEventSource.instances.at(-1)!.emit({ type: 'state', status: 'done', progress: 1, message: 'Done' })
  if (expectTable) await waitFor(() => expect(screen.getByText('CF605')).toBeInTheDocument())
  else await waitFor(() => expect(screen.getByText('Up to date')).toBeInTheDocument())
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.search}</output>
}

beforeEach(() => {
  resetAlertPreviewState()
  vi.clearAllMocks()
  vi.mocked(strategiesApi.list).mockResolvedValue(STRATEGIES)
  vi.mocked(alertsApi.preview).mockResolvedValue({ job_id: 'aj1' })
  vi.mocked(dataApi.update).mockResolvedValue({ job_id: 'dj1' })
  vi.mocked(jobsApi.get).mockImplementation(async (id: string) => ({ ...DONE_JOB, id }))
})

function renderPanel(withLocation = false) {
  return renderWorkspace(
    withLocation ? (
      <>
        <LocationProbe />
        <AlertPanel />
      </>
    ) : (
      <AlertPanel />
    ),
    { path: '/?symbol=SA&tab=alerts' },
  )
}

describe('saving a signal monitor', () => {
  it('edits strategy params and starts the first calculation after save', async () => {
    const user = userEvent.setup()
    localStorage.setItem('ft.strategyParams', JSON.stringify({ double_ma: { fast: 8 } }))
    localStorage.setItem('ft.extraSymbols', JSON.stringify(['CF']))
    renderPanel()

    await user.click(await screen.findByRole('button', { name: 'New signal' }))
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('double_ma'))
    expect(fieldInput('fast')).toHaveValue(8)
    expect(fieldInput('slow')).toHaveValue(30)
    expect(screen.getByText('SA')).toBeInTheDocument()
    expect(screen.getByText('CF')).toBeInTheDocument()
    expect(alertsApi.preview).not.toHaveBeenCalled()

    fireEvent.change(fieldInput('fast'), { target: { value: '12' } })
    await user.click(screen.getByRole('button', { name: 'Save & calculate' }))

    expect(screen.queryByLabelText('fast')).not.toBeInTheDocument()
    expect(entryRow('double_ma')).toHaveTextContent('SA, CF')
    await waitFor(() =>
      expect(alertsApi.preview).toHaveBeenCalledWith({
        strategy: 'double_ma',
        symbols: ['SA', 'CF'],
        params: { fast: 12, slow: 30 },
      }),
    )
    expect(entryRow('double_ma').nextElementSibling).toHaveClass('row-expand')
  })

  it('does not save when the monitored universe is empty', async () => {
    const user = userEvent.setup()
    localStorage.setItem('ft.universe', JSON.stringify([]))
    renderWorkspace(<AlertPanel />, { path: '/?tab=alerts' })
    await user.click(await screen.findByRole('button', { name: 'New signal' }))
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('double_ma'))
    expect(screen.getByRole('button', { name: 'Save & calculate' })).toBeDisabled()
  })
})

describe('expanding and calculating a monitor', () => {
  it('expands without starting a job, then calculates explicitly over the stored universe', async () => {
    const user = userEvent.setup()
    seedEntries([{ id: 'e1', strategy: 'double_ma', symbols: ['CF', 'FG'] }])
    renderPanel()

    await user.click(entryRow('double_ma'))
    expect(screen.getByText('Not calculated yet')).toBeInTheDocument()
    expect(alertsApi.preview).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Calculate now' }))
    await waitFor(() =>
      expect(alertsApi.preview).toHaveBeenCalledWith({
        strategy: 'double_ma',
        symbols: ['CF', 'FG'],
        params: {},
      }),
    )
  })

  it('uses the live universe only for an older entry that never stored one', async () => {
    const user = userEvent.setup()
    localStorage.setItem(
      'ft.alertEntries',
      JSON.stringify([{ id: 'e1', strategy: 'double_ma', params: {}, createdAt: 1 }]),
    )
    renderPanel()

    await user.click(entryRow('double_ma'))
    await user.click(screen.getByRole('button', { name: 'Calculate now' }))
    await waitFor(() =>
      expect(alertsApi.preview).toHaveBeenCalledWith({
        strategy: 'double_ma',
        symbols: ['SA'],
        params: {},
      }),
    )
  })

  it('shows the saved snapshot on later expansion without calculating again', async () => {
    const user = userEvent.setup()
    seedEntries([{ id: 'e1', strategy: 'double_ma', params: { fast: 8 } }], 'e1')
    renderPanel()

    await user.click(screen.getByRole('button', { name: 'Calculate now' }))
    await finishLatestPreview()
    expect(screen.getByText('Open long')).toBeInTheDocument()
    expect(screen.getByText('Hold')).toBeInTheDocument()
    expect(screen.getByText('12340')).toBeInTheDocument()
    expect(screen.getByText('next open ±5')).toBeInTheDocument()
    expect(screen.getByText('As of 2026-10-24')).toBeInTheDocument()
    expect(document.querySelector('.alert-params-summary')).toHaveTextContent('8, 30')

    vi.mocked(alertsApi.preview).mockClear()
    await user.click(entryRow('double_ma'))
    expect(screen.queryByText('CF605')).not.toBeInTheDocument()
    await user.click(entryRow('double_ma'))
    expect(screen.getByText('CF605')).toBeInTheDocument()
    expect(alertsApi.preview).not.toHaveBeenCalled()
  })

  it('keeps a calculation failure on its own expanded row', async () => {
    const user = userEvent.setup()
    seedEntries([
      { id: 'e1', strategy: 'double_ma' },
      { id: 'e2', strategy: 'chan_theory' },
    ])
    vi.mocked(alertsApi.preview).mockRejectedValue(new Error('engine unavailable'))
    renderPanel()

    await user.click(entryRow('double_ma'))
    await user.click(screen.getByRole('button', { name: 'Calculate now' }))
    expect(await screen.findByText(/Could not compute this signal monitor/)).toBeInTheDocument()
    expect(screen.getByText(/engine unavailable/)).toBeInTheDocument()
    expect(entryRow('double_ma')).toHaveTextContent('Failed')
    expect(entryRow('chan_theory')).toHaveTextContent('Not calculated')
  })
})

describe('signal summaries and chart links', () => {
  it('filters to actionable configurations and charts a result without leaving Signals', async () => {
    const user = userEvent.setup()
    seedEntries(
      [
        { id: 'e1', strategy: 'double_ma', symbols: ['SA', 'CF'] },
        { id: 'e2', strategy: 'chan_theory' },
      ],
      'e1',
    )
    renderPanel(true)

    await user.click(screen.getByRole('button', { name: 'Calculate now' }))
    await finishLatestPreview()
    expect(entryRow('double_ma')).toHaveTextContent('Open long 1')
    expect(entryRow('double_ma')).toHaveTextContent('2026-10-24')

    await user.click(screen.getByRole('button', { name: 'Actionable only' }))
    expect(entryRow('double_ma')).toBeInTheDocument()
    expect(screen.queryByText('chan_theory')).not.toBeInTheDocument()

    const expanded = entryRow('double_ma').nextElementSibling as HTMLElement
    const cfRow = within(expanded).getByText('CF605').closest('tr')!
    await user.click(within(cfRow as HTMLElement).getByRole('button', { name: 'View chart' }))
    expect(screen.getByTestId('location')).toHaveTextContent('symbol=CF')
    expect(screen.getByTestId('location')).toHaveTextContent('tab=alerts')
    expect(screen.getByText('CF605')).toBeInTheDocument()
  })
})

describe('editing, duplicating and deleting', () => {
  it('invalidates an edited configuration and calculates its replacement params', async () => {
    const user = userEvent.setup()
    seedEntries([{ id: 'e1', strategy: 'double_ma', params: { fast: 8 } }], 'e1')
    renderPanel()
    await user.click(screen.getByRole('button', { name: 'Calculate now' }))
    await finishLatestPreview()

    await user.click(within(entryRow('double_ma')).getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('heading', { name: 'Edit signal monitor' })).toBeInTheDocument()
    fireEvent.change(fieldInput('fast'), { target: { value: '12' } })
    await user.click(screen.getByRole('button', { name: 'Save & calculate' }))

    await waitFor(() =>
      expect(alertsApi.preview).toHaveBeenLastCalledWith({
        strategy: 'double_ma',
        symbols: ['SA'],
        params: { fast: 12, slow: 30 },
      }),
    )
    expect(screen.queryByText('CF605')).not.toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('ft.alertEntries')!)).toHaveLength(1)
  })

  it('duplicates into an independent configuration', async () => {
    const user = userEvent.setup()
    seedEntries([{ id: 'e1', strategy: 'double_ma', params: { fast: 8 } }])
    renderPanel()

    await user.click(within(entryRow('double_ma')).getByRole('button', { name: 'Duplicate' }))
    expect(screen.getByRole('heading', { name: 'Copy signal monitor' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save & calculate' }))

    await waitFor(() => expect(alertsApi.preview).toHaveBeenCalledTimes(1))
    const entries = JSON.parse(localStorage.getItem('ft.alertEntries')!) as AlertEntry[]
    expect(entries).toHaveLength(2)
    expect(entries[0].id).not.toBe('e1')
    expect(entries[0].params).toEqual({ fast: 8, slow: 30 })
    expect(entries[1].id).toBe('e1')
  })

  it('asks before deleting and then removes only that row', async () => {
    const user = userEvent.setup()
    seedEntries([
      { id: 'e1', strategy: 'double_ma' },
      { id: 'e2', strategy: 'chan_theory' },
    ])
    renderPanel()

    await user.click(within(entryRow('double_ma')).getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(screen.queryByText('double_ma')).not.toBeInTheDocument())
    expect(entryRow('chan_theory')).toBeInTheDocument()
    expect(alertsApi.preview).not.toHaveBeenCalled()
  })
})

describe('refreshing', () => {
  it('refreshes one row explicitly', async () => {
    const user = userEvent.setup()
    seedEntries([{ id: 'e1', strategy: 'double_ma' }], 'e1')
    renderPanel()
    await user.click(screen.getByRole('button', { name: 'Calculate now' }))
    await finishLatestPreview()
    vi.mocked(alertsApi.preview).mockClear()

    await user.click(within(entryRow('double_ma')).getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(alertsApi.preview).toHaveBeenCalledTimes(1))
  })

  it('updates only the monitored products and marks the snapshot for refresh', async () => {
    const user = userEvent.setup()
    seedEntries([{ id: 'e1', strategy: 'double_ma', symbols: ['SA', 'CF'] }], 'e1')
    renderPanel()
    await user.click(screen.getByRole('button', { name: 'Calculate now' }))
    await finishLatestPreview()

    await user.click(within(entryRow('double_ma')).getByRole('button', { name: 'Update data' }))
    await waitFor(() => expect(dataApi.update).toHaveBeenCalledWith(['SA', 'CF'], false, false))
    await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(1))
    const source = MockEventSource.instances.at(-1)!
    source.emit({ type: 'state', status: 'running', progress: 0.5, message: 'Updating SA' })
    await waitFor(() =>
      expect(within(entryRow('double_ma')).getByRole('button', { name: 'Update data' })).toBeDisabled(),
    )

    source.emit({ type: 'state', status: 'done', progress: 1, message: 'Done' })
    await waitFor(() => expect(entryRow('double_ma')).toHaveTextContent('Refresh needed'))
    expect(alertsApi.preview).toHaveBeenCalledTimes(1)
  })

  it('keeps a refreshed snapshot up to date after switching tabs and remounting', async () => {
    const user = userEvent.setup()
    seedEntries([{ id: 'e1', strategy: 'double_ma', symbols: ['SA', 'CF'] }], 'e1')
    function TabHarness() {
      const [show, setShow] = useState(true)
      return (
        <>
          <button type="button" onClick={() => setShow((v) => !v)}>
            Toggle tab
          </button>
          {show && <AlertPanel />}
        </>
      )
    }
    renderWorkspace(<TabHarness />, { path: '/?symbol=SA&tab=alerts' })

    await user.click(screen.getByRole('button', { name: 'Calculate now' }))
    await finishLatestPreview()

    await user.click(within(entryRow('double_ma')).getByRole('button', { name: 'Update data' }))
    await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(1))
    MockEventSource.instances.at(-1)!.emit({ type: 'state', status: 'done', progress: 1, message: 'Done' })
    await waitFor(() => expect(entryRow('double_ma')).toHaveTextContent('Refresh needed'))

    vi.mocked(alertsApi.preview).mockResolvedValueOnce({ job_id: 'aj2' })
    await user.click(within(entryRow('double_ma')).getByRole('button', { name: 'Refresh' }))
    await finishLatestPreview()
    expect(entryRow('double_ma')).toHaveTextContent('Up to date')

    await user.click(screen.getByRole('button', { name: 'Toggle tab' }))
    expect(screen.queryByText('CF605')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Toggle tab' }))
    expect(entryRow('double_ma')).toHaveTextContent('Up to date')
    expect(entryRow('double_ma')).not.toHaveTextContent('Refresh needed')
    expect(screen.getByText('CF605')).toBeInTheDocument()
  })

  it('runs Refresh all sequentially through the single alert job slot', async () => {
    const user = userEvent.setup()
    seedEntries([
      { id: 'e1', strategy: 'double_ma', symbols: ['SA'] },
      { id: 'e2', strategy: 'chan_theory', symbols: ['CF'] },
    ])
    renderPanel()

    await user.click(screen.getByRole('button', { name: 'Refresh all' }))
    await waitFor(() => expect(alertsApi.preview).toHaveBeenCalledTimes(1))
    expect(alertsApi.preview).toHaveBeenNthCalledWith(1, expect.objectContaining({ symbols: ['SA'] }))
    expect(entryRow('chan_theory')).toHaveTextContent('Queued')
    expect(screen.getByText('Refreshing 0/2')).toBeInTheDocument()

    await finishLatestPreview(false)
    await waitFor(() => expect(alertsApi.preview).toHaveBeenCalledTimes(2))
    expect(alertsApi.preview).toHaveBeenNthCalledWith(2, expect.objectContaining({ symbols: ['CF'] }))
    expect(MockEventSource.instances).toHaveLength(2)
  })

  it('cancels queued refreshes without cancelling the running calculation', async () => {
    const user = userEvent.setup()
    seedEntries([
      { id: 'e1', strategy: 'double_ma', symbols: ['SA'] },
      { id: 'e2', strategy: 'chan_theory', symbols: ['CF'] },
      { id: 'e3', strategy: 'double_ma', symbols: ['FG'] },
    ])
    renderPanel()

    await user.click(screen.getByRole('button', { name: 'Refresh all' }))
    await waitFor(() => expect(alertsApi.preview).toHaveBeenCalledTimes(1))
    await user.click(screen.getByRole('button', { name: 'Cancel queued' }))
    expect(jobsApi.cancel).not.toHaveBeenCalled()

    await finishLatestPreview(false)
    await waitFor(() => expect(screen.queryByText('Queued')).not.toBeInTheDocument())
    expect(alertsApi.preview).toHaveBeenCalledTimes(1)
  })
})
