import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { alertsApi, backtestApi, dataApi, indicatorsApi, jobsApi, productsApi, runsApi, strategiesApi } from '../api/endpoints'
import { MockEventSource } from '../test/setup'
import { INDICATORS, PRODUCTS, STRATEGIES, renderWorkspace, runDetail, runRow } from '../test/utils'
import { resetAlertPreviewState } from '../panels/AlertPanel'
import { ChartWorkspace } from './ChartWorkspace'

vi.mock('../api/endpoints', () => ({
  productsApi: { list: vi.fn(), bars: vi.fn(), roll: vi.fn(), get: vi.fn(), exchanges: vi.fn() },
  dataApi: { update: vi.fn() },
  strategiesApi: { list: vi.fn() },
  backtestApi: { start: vi.fn() },
  alertsApi: { preview: vi.fn() },
  runsApi: { list: vi.fn(), get: vi.fn(), price: vi.fn(), remove: vi.fn() },
  jobsApi: { get: vi.fn(), cancel: vi.fn(), streamUrl: (id: string) => `/api/jobs/${id}/stream` },
  indicatorsApi: { list: vi.fn(), get: vi.fn(), values: vi.fn(), reload: vi.fn() },
}))

// Canvas-backed and irrelevant to the logic under test.
vi.mock('../components/EChart', () => ({ EChart: () => <div data-testid="chart" /> }))

beforeEach(() => {
  resetAlertPreviewState()
  vi.mocked(productsApi.list).mockResolvedValue(PRODUCTS)
  vi.mocked(indicatorsApi.list).mockResolvedValue(INDICATORS)
  vi.mocked(productsApi.bars).mockResolvedValue({ symbol: 'SA', bars: [] })
  vi.mocked(productsApi.roll).mockResolvedValue({ symbol: 'SA', roll: [] })
  vi.mocked(strategiesApi.list).mockResolvedValue(STRATEGIES)
  vi.mocked(runsApi.list).mockResolvedValue([runRow('run-a', ['SA', 'CF']), runRow('run-b', ['AG'])])
  vi.mocked(runsApi.get).mockImplementation(async (id: string) =>
    id === 'run-a' ? runDetail('run-a', ['SA', 'CF']) : runDetail('run-b', ['AG']),
  )
  vi.mocked(runsApi.price).mockResolvedValue({
    symbol: 'X', dates: [], open: [], high: [], low: [], close: [], volume: [], oi: [], signals: [],
  } as never)
})

describe('opening a past run from the workspace history tab', () => {
  it("re-charts to the opened run's first symbol and never mixes the old symbol with the new run in its price fetch", async () => {
    // Opening a run prefills its universe too (see HistoryPanel/
    // WorkspaceContext.prefillBacktest), so the chart follows the run
    // rather than staying on whatever was charted before -- the price call
    // that fires must pair the *new* run with the *new* symbol, never the
    // old symbol with the new run id or vice versa.
    const user = userEvent.setup()
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA&tab=runs' })

    // Row 0 is the header; the two runs follow in the order the API listed them.
    const [, rowA] = await screen.findAllByRole('row')

    await user.click(rowA)
    await waitFor(() => expect(runsApi.price).toHaveBeenCalledWith('run-a', 'SA'))

    vi.mocked(runsApi.price).mockClear()
    // Opening a row also prefills the Backtest tab and switches to it, so
    // reaching the next row means going back to History first -- the same
    // thing a user comparing two runs would do.
    await user.click(screen.getByRole('tab', { name: 'Backtest History' }))
    const [, , freshRowB] = await screen.findAllByRole('row')
    await user.click(freshRowB)

    // run-b's own symbols are ['AG'] -- opening it re-charts to AG (its
    // first symbol) instead of leaving the chart on SA, which run-b never
    // traded and would otherwise have 404'd the price fetch.
    await waitFor(() => expect(runsApi.price).toHaveBeenCalledWith('run-b', 'AG'))
    expect(runsApi.price).not.toHaveBeenCalledWith('run-b', 'SA')
    expect(runsApi.price).not.toHaveBeenCalledWith('run-a', 'AG')

    // The base series never depended on the run's price call -- it always
    // comes from /products/{code}/bars, so the chart is still on screen.
    expect(screen.getAllByTestId('chart').length).toBeGreaterThan(0)
  })
})

describe('driving the workspace from the keyboard', () => {
  it('focuses the product search on "/" and charts a filtered product on Enter, without the mouse', async () => {
    // The sidebar is a sibling subtree of whatever holds focus when the key is
    // pressed, so this exercises the one part that cannot be unit-tested in
    // isolation: the shortcut reaching an input it does not own.
    const user = userEvent.setup()
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA' })
    const list = await screen.findByRole('listbox')
    await findProductRow(list, 'CF')

    await user.keyboard('/')
    const search = screen.getByPlaceholderText('Search products…')
    await waitFor(() => expect(search).toHaveFocus())

    // `/` opened the box rather than being typed into it.
    expect(search).toHaveValue('')

    await user.keyboard('CF{Enter}')

    await waitFor(() => {
      const charted = document.querySelector('.product-row.is-charted .code')
      expect(charted?.textContent).toBe('CF')
    })
  })

  it('collapses and reopens the product sidebar on Ctrl+B', async () => {
    const user = userEvent.setup()
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA' })
    await screen.findByRole('listbox')

    await user.keyboard('{Control>}b{/Control}')
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())

    await user.keyboard('{Control>}b{/Control}')
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())
  })
})

/** A row's `.code` and `.name` cells both read e.g. "SA" in the test
 * fixtures (PRODUCTS derives `name` from `code`), so `getByText` alone is
 * ambiguous within one row. Find the row by its `.code` cell specifically. */
async function findProductRow(list: HTMLElement, code: string) {
  return waitFor(() => {
    const row = Array.from(list.querySelectorAll('.product-row')).find(
      (r) => r.querySelector('.code')?.textContent === code,
    )
    if (!row) throw new Error(`no product row for ${code}`)
    return row as HTMLElement
  })
}

describe('the product sidebar', () => {
  it('single-clicking charts a product without changing the universe selection', async () => {
    const user = userEvent.setup()
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA&tab=backtest' })

    const list = await screen.findByRole('listbox')
    const cfRow = await findProductRow(list, 'CF')
    expect(cfRow).toHaveAttribute('aria-selected', 'false')

    await user.click(cfRow)
    expect(cfRow).toHaveAttribute('aria-selected', 'true')
    expect(within(cfRow).getByRole('checkbox')).not.toBeChecked()
    const rail = document.querySelector('.panel-rail')!
    expect(within(rail as HTMLElement).queryByText('CF')).not.toBeInTheDocument()

    const saRow = await findProductRow(list, 'SA')
    await user.click(saRow)
    expect(saRow).toHaveAttribute('aria-selected', 'true')
    expect(cfRow).toHaveAttribute('aria-selected', 'false')
    expect(within(cfRow).getByRole('checkbox')).not.toBeChecked()
  })

  it('uses the checkbox independently for universe membership without locking the charted product', async () => {
    const user = userEvent.setup()
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA&tab=backtest' })

    const list = await screen.findByRole('listbox')
    const cfRow = await findProductRow(list, 'CF')
    const checkbox = within(cfRow).getByRole('checkbox')
    const rail = document.querySelector('.panel-rail')!

    await user.click(checkbox)
    expect(checkbox).toBeChecked()
    expect(cfRow).toHaveAttribute('aria-selected', 'false')
    await waitFor(() => expect(within(rail as HTMLElement).getByText('CF')).toBeInTheDocument())

    await user.click(checkbox)
    expect(checkbox).not.toBeChecked()
    expect(within(rail as HTMLElement).queryByText('CF')).not.toBeInTheDocument()

    const saRow = await findProductRow(list, 'SA')
    const saCheckbox = within(saRow).getByRole('checkbox')
    expect(saCheckbox).toBeChecked()
    expect(saCheckbox).toBeEnabled()

    await user.click(saCheckbox)
    expect(saCheckbox).not.toBeChecked()
    expect(within(rail as HTMLElement).queryByText('SA')).not.toBeInTheDocument()
  })

  it('selects and clears all products in the universe from the sidebar action buttons', async () => {
    const user = userEvent.setup()
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA&tab=backtest' })

    const list = await screen.findByRole('listbox')
    const selectAllBtn = screen.getByRole('button', { name: 'Select all' })
    const clearBtn = screen.getByRole('button', { name: 'Clear' })

    await user.click(selectAllBtn)
    const checkboxes = within(list).getAllByRole('checkbox')
    checkboxes.forEach((cb) => expect(cb).toBeChecked())
    expect(selectAllBtn).toBeDisabled()

    await user.click(clearBtn)
    checkboxes.forEach((cb) => expect(cb).not.toBeChecked())
    expect(clearBtn).toBeDisabled()
  })

  it('selects only filtered products when a search query is active and disables on empty match', async () => {
    const user = userEvent.setup()
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA&tab=backtest' })

    const searchInput = screen.getByPlaceholderText(/search/i)
    const selectAllBtn = screen.getByRole('button', { name: 'Select all' })
    const clearBtn = screen.getByRole('button', { name: 'Clear' })

    // First clear any selections
    await user.click(clearBtn)
    expect(clearBtn).toBeDisabled()

    // Type "CF" into search
    await user.type(searchInput, 'CF')
    expect(selectAllBtn).toBeEnabled()

    // Click select all - only CF should be selected
    await user.click(selectAllBtn)
    expect(selectAllBtn).toBeDisabled()

    // Clear search input
    await user.clear(searchInput)

    const list = await screen.findByRole('listbox')
    const saRow = await findProductRow(list, 'SA')
    const cfRow = await findProductRow(list, 'CF')
    expect(within(cfRow).getByRole('checkbox')).toBeChecked()
    expect(within(saRow).getByRole('checkbox')).not.toBeChecked()

    // Typing non-matching query disables select all
    await user.type(searchInput, 'XYZNONEXISTENT')
    expect(selectAllBtn).toBeDisabled()
  })

  it('uses checked products as the next signal monitor universe', async () => {
    const user = userEvent.setup()
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA&tab=alerts' })

    const list = await screen.findByRole('listbox')
    const cfRow = await findProductRow(list, 'CF')
    await user.click(within(cfRow).getByRole('checkbox'))
    expect(cfRow).toHaveAttribute('aria-selected', 'false')

    await user.click(await screen.findByRole('button', { name: 'New signal' }))
    const drawer = document.querySelector('.bdrawer-body')!
    await waitFor(() => expect(within(drawer as HTMLElement).getByText('CF')).toBeInTheDocument())
  })

  it('puts Backtest first in the drawer tab bar', async () => {
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA&tab=backtest' })
    await screen.findByRole('tab', { name: 'Signals' })
    const labels = Array.from(document.querySelectorAll('.bdrawer-tabbar .tab')).map((el) => el.textContent)
    expect(labels).toEqual(['Backtest', 'Signals', 'Backtest History'])
  })

  it('does not calculate a saved alert when the sidebar universe changes', async () => {
    const user = userEvent.setup()
    localStorage.setItem(
      'ft.alertEntries',
      JSON.stringify([{ id: 'e1', strategy: 'double_ma', symbols: ['SA'], params: {}, createdAt: 1 }]),
    )
    localStorage.setItem('ft.alertActiveId', JSON.stringify('e1'))

    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA&tab=alerts' })
    await screen.findByText('double_ma')
    const list = await screen.findByRole('listbox')
    const cfRow = await findProductRow(list, 'CF')
    await user.click(within(cfRow).getByRole('checkbox'))

    expect(within(cfRow).getByRole('checkbox')).toBeChecked()
    expect(alertsApi.preview).not.toHaveBeenCalled()
  })

  it('single-clicking another product switches the main chart without altering universe checkboxes', async () => {
    const user = userEvent.setup()
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA' })

    const list = await screen.findByRole('listbox')
    const saRow = await findProductRow(list, 'SA')
    expect(saRow.className).toContain('is-charted')
    expect(within(saRow).getByRole('checkbox')).toBeEnabled()
    expect(within(saRow).getByRole('checkbox')).toBeChecked()

    const cfRow = await findProductRow(list, 'CF')
    expect(within(cfRow).getByRole('checkbox')).toBeEnabled()
    expect(within(cfRow).getByRole('checkbox')).not.toBeChecked()

    await user.click(cfRow)
    expect(cfRow.className).toContain('is-charted')
    expect(within(cfRow).getByRole('checkbox')).not.toBeChecked()
    expect(saRow.className).not.toContain('is-charted')
    expect(within(saRow).getByRole('checkbox')).toBeChecked()
  })

  it('closes the narrow sidebar on Escape, backdrop click and after charting a product', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 900px)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    }))
    const user = userEvent.setup()
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA' })
    await screen.findByRole('listbox')

    const search = screen.getByRole('textbox', { name: 'Search products…' })
    await user.click(search)
    await user.keyboard('CF{Escape}')
    expect(search).toHaveValue('')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    await user.keyboard('{Escape}{Escape}')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Products' }))
    const list = await screen.findByRole('listbox')
    await user.click(await findProductRow(list, 'CF'))
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Products' }))
    await screen.findByRole('listbox')
    fireEvent.click(document.querySelector('.sidebar-backdrop')!)
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
  })
})

describe('workspace navigation', () => {
  it('keeps tabs available while collapsed and expands the selected one', async () => {
    const user = userEvent.setup()
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA&tab=backtest' })
    await screen.findByRole('tab', { name: 'Backtest' })

    await user.click(document.querySelector('.bdrawer-toggle')!)
    expect(document.querySelector('.bdrawer')).toHaveClass('bdrawer-collapsed')
    expect(screen.getByRole('tab', { name: 'Signals' })).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Signals' }))
    expect(document.querySelector('.bdrawer')).not.toHaveClass('bdrawer-collapsed')
    expect(screen.getByRole('tab', { name: 'Signals' })).toHaveAttribute('aria-selected', 'true')
  })

  it('opens the running backtest panel from its top-bar progress pill', async () => {
    const user = userEvent.setup()
    vi.mocked(backtestApi.start).mockResolvedValue({ job_id: 'j-nav', run_id: 'run-a' })
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA&tab=backtest' })

    const run = await screen.findByRole('button', { name: 'Run Backtest' })
    await waitFor(() => expect(run).toBeEnabled())
    await user.click(run)
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))
    MockEventSource.instances[0].emit({ type: 'state', status: 'running', progress: 0.25, message: 'Running' })
    const pill = await screen.findByRole('button', { name: 'Backtest 25%' })

    await user.click(screen.getByRole('tab', { name: 'Signals' }))
    await user.click(pill)
    expect(screen.getByRole('tab', { name: 'Backtest' })).toHaveAttribute('aria-selected', 'true')
    expect(document.querySelector('.bdrawer')).not.toHaveClass('bdrawer-collapsed')
  })
})

describe('exiting a finished backtest', () => {
  /** Run one backtest to completion, leaving its run overlaid on the chart
   * the way the panel does on its own. */
  async function runToCompletion(user: ReturnType<typeof userEvent.setup>) {
    const button = await screen.findByRole('button', { name: 'Run Backtest' })
    await waitFor(() => expect(button).toBeEnabled())
    await user.click(button)

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))
    MockEventSource.instances[0].emit({ type: 'state', status: 'done', progress: 1, message: 'Done' })

    // The run reaches the chart: its fills are fetched for the charted
    // product, and the toolbar offers the way back out.
    await waitFor(() => expect(runsApi.price).toHaveBeenCalledWith('run-a', 'SA'))
    return screen.findByRole('button', { name: 'Exit backtest' })
  }

  beforeEach(() => {
    vi.mocked(backtestApi.start).mockResolvedValue({ job_id: 'j1', run_id: 'run-a' })
    vi.mocked(jobsApi.get).mockResolvedValue({
      id: 'j1', kind: 'backtest', status: 'done', progress: 1, message: 'Done', error: null,
      created_at: 0, started_at: 0, finished_at: 0, cancel_requested: false, result: {},
    })
  })

  it('takes the run off the chart for good, rather than letting the finished job put it straight back', async () => {
    // The regression: the panel re-overlays a *done* job's run whenever
    // `setRunId` is rebuilt, and react-router rebuilds it on every URL
    // change -- including the one this very click makes. Clearing the `run`
    // param therefore undid itself within the same click, and the button
    // read as dead.
    const user = userEvent.setup()
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA&tab=backtest' })

    await user.click(await runToCompletion(user))

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Exit backtest' })).not.toBeInTheDocument())
  })

  it('stays exited across later navigation that has nothing to do with the run', async () => {
    // Same cause, later trigger: re-charting writes `symbol` to the URL,
    // which rebuilt `setRunId` again and brought the exited run back.
    const user = userEvent.setup()
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA&tab=backtest' })

    await user.click(await runToCompletion(user))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Exit backtest' })).not.toBeInTheDocument())

    const list = await screen.findByRole('listbox')
    const cfRow = await findProductRow(list, 'CF')
    await user.click(cfRow)

    expect(cfRow.className).toContain('is-charted')
    expect(screen.queryByRole('button', { name: 'Exit backtest' })).not.toBeInTheDocument()
  })
})

describe('a finished data update', () => {
  it('refetches indicator values along with the bars they are computed from', async () => {
    // The regression: only the bars were invalidated, so the candles gained
    // the new days while every indicator stopped short of them for the rest
    // of its staleTime.
    localStorage.setItem('ft.indicators', JSON.stringify(['rsi']))
    vi.mocked(indicatorsApi.values).mockResolvedValue({
      symbol: 'SA',
      indicator: 'rsi',
      params: { period: 14 },
      dates: [],
      outputs: { rsi: { values: [], valid_from: null } },
    })
    vi.mocked(dataApi.update).mockResolvedValue({ job_id: 'd1' })
    vi.mocked(jobsApi.get).mockResolvedValue({
      id: 'd1', kind: 'data_update', status: 'done', progress: 1, message: 'Done', error: null,
      created_at: 0, started_at: 0, finished_at: 0, cancel_requested: false, result: {},
    })

    const user = userEvent.setup()
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA' })
    await waitFor(() => expect(indicatorsApi.values).toHaveBeenCalledTimes(1))

    await user.click(await screen.findByRole('button', { name: 'Update All' }))
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))
    MockEventSource.instances[0].emit({ type: 'state', status: 'done', progress: 1, message: 'Done' })

    await waitFor(() => expect(indicatorsApi.values).toHaveBeenCalledTimes(2))
  })

  it('refetches after an update that failed partway, without calling it finished', async () => {
    // The products before the failing one were already rewritten, so their
    // chart data is stale all the same -- only `done` used to invalidate it.
    localStorage.setItem('ft.indicators', JSON.stringify(['rsi']))
    vi.mocked(indicatorsApi.values).mockClear()
    vi.mocked(indicatorsApi.values).mockResolvedValue({
      symbol: 'SA',
      indicator: 'rsi',
      params: { period: 14 },
      dates: [],
      outputs: { rsi: { values: [], valid_from: null } },
    })
    vi.mocked(dataApi.update).mockResolvedValue({ job_id: 'd2' })
    vi.mocked(jobsApi.get).mockResolvedValue({
      id: 'd2', kind: 'data_update', status: 'error', progress: 0.5, message: '', error: 'exchange said no',
      created_at: 0, started_at: 0, finished_at: 0, cancel_requested: false, result: null,
    })

    const user = userEvent.setup()
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA' })
    await waitFor(() => expect(indicatorsApi.values).toHaveBeenCalledTimes(1))

    await user.click(await screen.findByRole('button', { name: 'Update All' }))
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))
    MockEventSource.instances[0].emit({ type: 'state', status: 'error', progress: 0.5, message: '', error: 'exchange said no' })

    await waitFor(() => expect(indicatorsApi.values).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Data update finished')).not.toBeInTheDocument()
  })
})
