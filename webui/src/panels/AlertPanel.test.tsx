import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { alertsApi, dataApi, jobsApi, strategiesApi } from '../api/endpoints'
import type { AlertMonitor, AlertSnapshot } from '../api/types'
import { MockEventSource } from '../test/setup'
import { STRATEGIES, renderWorkspace } from '../test/utils'
import { AlertPanel } from './AlertPanel'
import { resetAlertPreviewState } from './alertPreviewStore'

vi.mock('../api/endpoints', () => ({
  strategiesApi: { list: vi.fn() },
  alertsApi: {
    preview: vi.fn(),
    listMonitors: vi.fn(),
    createMonitor: vi.fn(),
    updateMonitor: vi.fn(),
    deleteMonitor: vi.fn(),
    importMonitors: vi.fn(),
  },
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
      holding: 'flat',
      operation: 'open_long',
      entry_price: null,
      last_price: 14250,
      stop: { price: 12340, distance: null },
      take_profit: { price: null, distance: null },
    },
    {
      symbol: 'SA',
      contract: 'SA509',
      holding: 'long',
      operation: 'hold',
      entry_price: 1520,
      last_price: 1565,
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

let serverMonitors: AlertMonitor[] = []
let seq = 1

function makeMonitor(partial: Partial<AlertMonitor> & Pick<AlertMonitor, 'id' | 'strategy'>): AlertMonitor {
  return {
    name: '',
    symbols: ['SA'],
    params: {},
    notify_enabled: true,
    created_at: 1,
    updated_at: 1,
    last_snapshot: null,
    last_checked_at: null,
    last_error: null,
    ...partial,
  }
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

function seedMonitors(entries: Array<Partial<AlertMonitor> & Pick<AlertMonitor, 'id' | 'strategy'>>, activeId?: string) {
  serverMonitors = entries.map(makeMonitor)
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
  serverMonitors = []
  seq = 1
  vi.clearAllMocks()
  vi.mocked(strategiesApi.list).mockResolvedValue(STRATEGIES)
  vi.mocked(alertsApi.listMonitors).mockImplementation(async () => [...serverMonitors])
  vi.mocked(alertsApi.createMonitor).mockImplementation(async (body) => {
    const created = makeMonitor({
      id: `m-${seq++}`,
      name: body.name ?? '',
      strategy: body.strategy,
      symbols: [...body.symbols],
      params: { ...(body.params ?? {}) },
      notify_enabled: body.notify_enabled ?? true,
    })
    serverMonitors = [created, ...serverMonitors]
    return created
  })
  vi.mocked(alertsApi.updateMonitor).mockImplementation(async (id, body) => {
    const prev = serverMonitors.find((m) => m.id === id)
    const updated = makeMonitor({
      ...(prev ?? { id, strategy: body.strategy }),
      name: body.name ?? '',
      strategy: body.strategy,
      symbols: [...body.symbols],
      params: { ...(body.params ?? {}) },
      notify_enabled: body.notify_enabled ?? true,
    })
    serverMonitors = serverMonitors.map((m) => (m.id === id ? updated : m))
    return updated
  })
  vi.mocked(alertsApi.deleteMonitor).mockImplementation(async (id) => {
    serverMonitors = serverMonitors.filter((m) => m.id !== id)
    return { deleted: id }
  })
  vi.mocked(alertsApi.importMonitors).mockImplementation(async (items) => {
    const imported = items.map((item) =>
      makeMonitor({
        id: item.id ?? `imp-${seq++}`,
        strategy: item.strategy,
        symbols: [...item.symbols],
        params: { ...(item.params ?? {}) },
        notify_enabled: item.notify_enabled ?? true,
      }),
    )
    serverMonitors = [...imported, ...serverMonitors]
    return { imported, skipped: 0 }
  })
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

describe('saving and migrating signal monitors', () => {
  it('saves to the backend and starts the first calculation after save', async () => {
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

    await waitFor(() => expect(screen.queryByLabelText('fast')).not.toBeInTheDocument())
    expect(entryRow('double_ma')).toHaveTextContent('SA, CF')
    await waitFor(() =>
      expect(alertsApi.preview).toHaveBeenCalledWith({
        strategy: 'double_ma',
        symbols: ['SA', 'CF'],
        params: { fast: 12, slow: 30 },
        monitor_id: 'm-1',
      }),
    )
    expect(entryRow('double_ma').nextElementSibling).toHaveClass('row-expand')
  })

  it('migrates legacy browser localStorage entries once when backend has none', async () => {
    localStorage.setItem(
      'ft.alertEntries',
      JSON.stringify([{ id: 'legacy-1', strategy: 'double_ma', symbols: ['CF'], params: { fast: 5 }, createdAt: 10 }]),
    )
    renderPanel()

    await waitFor(() => expect(alertsApi.importMonitors).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('CF')).toBeInTheDocument()
    expect(localStorage.getItem('ft.alertEntriesMigrated')).toBe('1')
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

describe('expanding, holdings display, and push toggle', () => {
  it('expands without starting a job, then calculates and shows holding and reference prices', async () => {
    const user = userEvent.setup()
    seedMonitors([{ id: 'e1', strategy: 'double_ma', symbols: ['CF', 'SA'], params: { fast: 8 } }])
    renderPanel()

    await waitFor(() => expect(entryRow('double_ma')).toBeInTheDocument())
    await user.click(entryRow('double_ma'))
    expect(screen.getByText('Not calculated yet')).toBeInTheDocument()
    expect(alertsApi.preview).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Calculate now' }))
    await finishLatestPreview()
    expect(screen.getByText('Open long')).toBeInTheDocument()
    expect(screen.getByText('Hold')).toBeInTheDocument()
    expect(screen.getByText('Long')).toBeInTheDocument()
    expect(screen.getByText('Flat')).toBeInTheDocument()
    expect(screen.getByText('1520 / 1565')).toBeInTheDocument()
    expect(screen.getByText('— / 14250')).toBeInTheDocument()
    expect(screen.getByText('12340')).toBeInTheDocument()
    expect(screen.getByText('next open ±5')).toBeInTheDocument()
    expect(screen.getByText('As of 2026-10-24')).toBeInTheDocument()
  })

  it('toggles per-row scheduled notification inclusion without starting a preview', async () => {
    const user = userEvent.setup()
    seedMonitors([{ id: 'e1', strategy: 'double_ma', notify_enabled: true }])
    renderPanel()

    const row = await waitFor(() => entryRow('double_ma'))
    const bellBtn = within(row).getByRole('button', { name: /Included in scheduled alerts/i })
    await user.click(bellBtn)

    await waitFor(() =>
      expect(alertsApi.updateMonitor).toHaveBeenCalledWith(
        'e1',
        expect.objectContaining({ notify_enabled: false }),
      ),
    )
    expect(alertsApi.preview).not.toHaveBeenCalled()
  })

  it('keeps a calculation failure on its own expanded row', async () => {
    const user = userEvent.setup()
    seedMonitors([
      { id: 'e1', strategy: 'double_ma' },
      { id: 'e2', strategy: 'chan_theory' },
    ])
    vi.mocked(alertsApi.preview).mockRejectedValue(new Error('engine unavailable'))
    renderPanel()

    await user.click(await waitFor(() => entryRow('double_ma')))
    await user.click(screen.getByRole('button', { name: 'Calculate now' }))
    expect(await screen.findByText(/Could not compute this signal monitor/)).toBeInTheDocument()
    expect(screen.getByText(/engine unavailable/)).toBeInTheDocument()
    expect(entryRow('double_ma')).toHaveTextContent('Failed')
    expect(entryRow('chan_theory')).toHaveTextContent('Not calculated')
  })
})

describe('signal summaries, editing, deleting, and refreshing', () => {
  it('filters to actionable configurations and charts a result without leaving Signals', async () => {
    const user = userEvent.setup()
    seedMonitors(
      [
        { id: 'e1', strategy: 'double_ma', symbols: ['SA', 'CF'], last_snapshot: SNAPSHOT },
        { id: 'e2', strategy: 'chan_theory' },
      ],
      'e1',
    )
    renderPanel(true)

    await waitFor(() => expect(entryRow('double_ma')).toHaveTextContent('Open long 1'))
    expect(entryRow('double_ma')).toHaveTextContent('2026-10-24')

    await user.click(screen.getByRole('button', { name: 'Actionable only' }))
    expect(entryRow('double_ma')).toBeInTheDocument()
    expect(screen.queryByText('chan_theory')).not.toBeInTheDocument()

    const expanded = entryRow('double_ma').nextElementSibling as HTMLElement
    const cfRow = within(expanded).getByText('CF605').closest('tr')!
    await user.click(within(cfRow as HTMLElement).getByRole('button', { name: 'View chart' }))
    expect(screen.getByTestId('location')).toHaveTextContent('symbol=CF')
    expect(screen.getByTestId('location')).toHaveTextContent('tab=alerts')
  })

  it('asks before deleting and removes only that row via the API', async () => {
    const user = userEvent.setup()
    seedMonitors([
      { id: 'e1', strategy: 'double_ma' },
      { id: 'e2', strategy: 'chan_theory' },
    ])
    renderPanel()

    await user.click(within(await waitFor(() => entryRow('double_ma'))).getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(alertsApi.deleteMonitor).toHaveBeenCalledWith('e1'))
    await waitFor(() => expect(screen.queryByText('double_ma')).not.toBeInTheDocument())
    expect(entryRow('chan_theory')).toBeInTheDocument()
  })

  it('updates monitored products and marks persisted snapshots for refresh', async () => {
    const user = userEvent.setup()
    seedMonitors([{ id: 'e1', strategy: 'double_ma', symbols: ['SA', 'CF'], last_snapshot: SNAPSHOT }], 'e1')
    renderPanel()

    const row = await waitFor(() => entryRow('double_ma'))
    expect(row).toHaveTextContent('Up to date')

    await user.click(within(row).getByRole('button', { name: 'Update data' }))
    await waitFor(() => expect(dataApi.update).toHaveBeenCalledWith(['SA', 'CF'], false, false))
    await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0))
    const source = MockEventSource.instances.at(-1)!
    source.emit({ type: 'state', status: 'done', progress: 1, message: 'Done' })
    await waitFor(() => expect(entryRow('double_ma')).toHaveTextContent('Refresh needed'))
  })

  it('keeps a refreshed snapshot up to date after switching tabs and remounting', async () => {
    const user = userEvent.setup()
    seedMonitors([{ id: 'e1', strategy: 'double_ma', symbols: ['SA', 'CF'] }], 'e1')
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

    await user.click(await screen.findByRole('button', { name: 'Calculate now' }))
    await finishLatestPreview()

    await user.click(screen.getByRole('button', { name: 'Toggle tab' }))
    expect(screen.queryByText('CF605')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Toggle tab' }))
    await waitFor(() => expect(screen.getByText('CF605')).toBeInTheDocument())
    expect(entryRow('double_ma')).toHaveTextContent('Up to date')
  })

  it('runs Refresh all sequentially and cancels queued refreshes without killing active job', async () => {
    const user = userEvent.setup()
    seedMonitors([
      { id: 'e1', strategy: 'double_ma', symbols: ['SA'] },
      { id: 'e2', strategy: 'chan_theory', symbols: ['CF'] },
      { id: 'e3', strategy: 'double_ma', symbols: ['FG'] },
    ])
    renderPanel()

    await waitFor(() => expect(entryRow('chan_theory')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Refresh all' }))
    await waitFor(() => expect(alertsApi.preview).toHaveBeenCalledTimes(1))
    await user.click(screen.getByRole('button', { name: 'Cancel queued' }))
    expect(jobsApi.cancel).not.toHaveBeenCalled()

    await finishLatestPreview(false)
    await waitFor(() => expect(screen.queryByText('Queued')).not.toBeInTheDocument())
    expect(alertsApi.preview).toHaveBeenCalledTimes(1)
  })

  it('recovers cleanly when the final terminal job fetch fails', async () => {
    const user = userEvent.setup()
    seedMonitors([{ id: 'e1', strategy: 'double_ma', symbols: ['SA', 'CF'] }], 'e1')
    vi.mocked(jobsApi.get).mockRejectedValueOnce(new Error('final fetch failed'))
    renderPanel()

    await user.click(await screen.findByRole('button', { name: 'Calculate now' }))
    await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0))
    MockEventSource.instances.at(-1)!.emit({ type: 'state', status: 'done', progress: 1, message: 'Done' })

    // Inflight state must clear so the refresh action becomes clickable again instead of deadlocking
    await waitFor(() => expect(screen.getByRole('button', { name: 'Calculate now' })).toBeEnabled())
  })

  it('prefers a newer server snapshot over an older cached preview', async () => {
    const user = userEvent.setup()
    seedMonitors([{ id: 'e1', strategy: 'double_ma', symbols: ['SA', 'CF'] }], 'e1')
    const first = renderPanel()

    await user.click(await screen.findByRole('button', { name: 'Calculate now' }))
    await finishLatestPreview()
    expect(entryRow('double_ma')).toHaveTextContent('2026-10-24')
    first.unmount()

    // Simulate backend scheduled dispatch writing a newer snapshot than the module-level previewCache
    const newerSnapshot = { ...SNAPSHOT, asof: '2026-11-19' }
    seedMonitors(
      [{ id: 'e1', strategy: 'double_ma', symbols: ['SA', 'CF'], last_snapshot: newerSnapshot, last_checked_at: Date.now() / 1000 + 60 }],
      'e1',
    )
    renderPanel()
    await waitFor(() => expect(entryRow('double_ma')).toHaveTextContent('2026-11-19'))
  })
})
