import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { indicatorsApi, productsApi, runsApi, strategiesApi } from '../api/endpoints'
import type { IndicatorInfo, IndicatorValues } from '../api/types'
import { EMPTY_BARS, INDICATORS, PRODUCTS, STRATEGIES, renderWorkspace } from '../test/utils'
import { ChartWorkspace } from '../shell/ChartWorkspace'

vi.mock('../api/endpoints', () => ({
  productsApi: { list: vi.fn(), bars: vi.fn(), roll: vi.fn(), get: vi.fn(), exchanges: vi.fn() },
  dataApi: { update: vi.fn() },
  strategiesApi: { list: vi.fn() },
  backtestApi: { start: vi.fn() },
  runsApi: { list: vi.fn(), get: vi.fn(), price: vi.fn(), remove: vi.fn() },
  jobsApi: { get: vi.fn(), cancel: vi.fn(), streamUrl: (id: string) => `/api/jobs/${id}/stream` },
  indicatorsApi: { list: vi.fn(), get: vi.fn(), values: vi.fn(), reload: vi.fn() },
}))

// Canvas-backed and irrelevant to the states under test -- except for the
// pane count, which is the one thing about the built option these tests can
// see, and the only way to tell "volume is drawn" from "volume is ticked".
vi.mock('../components/EChart', () => ({
  EChart: ({ option }: { option: { grid?: unknown[] } }) => (
    <div data-testid="chart" data-panes={option.grid?.length ?? 0} />
  ),
}))

beforeEach(() => {
  vi.mocked(productsApi.list).mockResolvedValue(PRODUCTS)
  vi.mocked(productsApi.roll).mockRejectedValue(new ApiError(400, 'no roll calendar'))
  vi.mocked(strategiesApi.list).mockResolvedValue(STRATEGIES)
  vi.mocked(runsApi.list).mockResolvedValue([])
  vi.mocked(indicatorsApi.list).mockResolvedValue(INDICATORS)
})

/** `/products/{code}/bars` 404s for a product whose weighted CSV was never
 * built, which is every product on a fresh install. The chart's loading
 * branch keys off `!barsData`, and a failed query leaves that undefined
 * with `isLoading` already false -- so the state that reads as "still
 * fetching" is the same one a dead query lands in. */
describe('a product with no downloaded data', () => {
  it('says the data is missing instead of loading forever', async () => {
    vi.mocked(productsApi.bars).mockRejectedValue(new ApiError(404, 'Weighted data file not found'))
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA' })

    expect(await screen.findByText('No data downloaded for this product yet')).toBeInTheDocument()
    expect(
      screen.getByText('Download its history from the product sidebar, then come back to see the chart.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('shows the server’s own message for a failure that is not a missing file', async () => {
    vi.mocked(productsApi.bars).mockRejectedValue(new ApiError(500, 'roll calendar build failed'))
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA' })

    expect(await screen.findByText('roll calendar build failed')).toBeInTheDocument()
    // The download hint would be wrong here: the data is there, the build broke.
    expect(screen.queryByText('No data downloaded for this product yet')).toBeNull()
  })

  it('still charts normally once the bars load', async () => {
    vi.mocked(productsApi.bars).mockResolvedValue({ symbol: 'SA', bars: [] })
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA' })

    await waitFor(() => expect(screen.getAllByTestId('chart').length).toBeGreaterThan(0))
    expect(screen.queryByText('No data downloaded for this product yet')).toBeNull()
  })
})

/** The picker is the whole user-facing feature: tick a class the backend
 * discovered and it goes on the chart. These cover the wiring between the
 * two, which the option-builder tests (charts/superChartOption.test.ts)
 * cannot see. */
describe('the indicator picker', () => {
  beforeEach(() => {
    vi.mocked(productsApi.bars).mockResolvedValue(EMPTY_BARS)
    vi.mocked(indicatorsApi.values).mockResolvedValue({
      symbol: 'SA',
      indicator: 'rsi',
      params: { period: 14 },
      dates: [],
      outputs: { rsi: { values: [], valid_from: null } },
    })
  })

  it('lists what the backend discovered and fetches values for the one ticked', async () => {
    const user = userEvent.setup()
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA' })

    await user.click(await screen.findByRole('button', { name: /^Indicators/ }))
    expect(await screen.findByText('MA')).toBeInTheDocument()
    expect(screen.getByText('RSI')).toBeInTheDocument()

    // Ordered the way the panes stack, not the way the catalog arrived:
    // price-pane classes, then the rule, then everything with a pane of its
    // own -- volume first among those, because that is where it is drawn.
    const menu = screen.getByRole('dialog', { name: 'Indicators' })
    const rows = within(menu)
      .getAllByRole('checkbox')
      .map((box) => box.parentElement?.querySelector('.indicator-row-label')?.textContent)
    expect(rows).toEqual(['MA', 'Volume', 'RSI'])
    expect(menu.querySelector('.indicator-menu-rule')).not.toBeNull()

    expect(indicatorsApi.values).not.toHaveBeenCalled()
    await user.click(screen.getByRole('checkbox', { name: /RSI/ }))

    await waitFor(() => expect(indicatorsApi.values).toHaveBeenCalledWith('SA', 'rsi', {}))
    // The count on the button is how the user sees the selection while the
    // menu is shut. Two, not one: volume is ticked by default and is a row in
    // this same menu, so it counts like any other.
    expect(await screen.findByRole('button', { name: 'Indicators (2)' })).toBeInTheDocument()
  })

  /** Volume was a toolbar button of its own until it moved in here. It is
   * not a class under `indicators/` -- it is drawn straight from the bars --
   * so nothing in the catalog wiring covers it, and "the row is ticked" and
   * "the pane is drawn" are two different claims. */
  it('draws the volume pane from its row in the picker, and drops it when unticked', async () => {
    const user = userEvent.setup()
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA' })

    // Price + volume, on by default.
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveAttribute('data-panes', '2'))

    await user.click(await screen.findByRole('button', { name: /^Indicators/ }))
    const volume = screen.getByRole('checkbox', { name: /Volume/ })
    expect(volume).toBeChecked()

    await user.click(volume)
    await waitFor(() => expect(screen.getByTestId('chart')).toHaveAttribute('data-panes', '1'))
    expect(await screen.findByRole('button', { name: 'Indicators' })).toBeInTheDocument()
  })

  it('shows a class that failed to import, disabled, rather than dropping it', async () => {
    // A user who has just typed a syntax error needs to see *that*, not an
    // indicator that silently vanished.
    vi.mocked(indicatorsApi.list).mockResolvedValue([
      ...INDICATORS,
      { ...INDICATORS[0], key: 'broken', label: 'BROKEN', errors: ['SyntaxError: bad'] },
    ])
    const user = userEvent.setup()
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA' })

    await user.click(await screen.findByRole('button', { name: /^Indicators/ }))
    const row = await screen.findByRole('checkbox', { name: /BROKEN/ })
    expect(row).toBeDisabled()
    expect(screen.getByText('error')).toBeInTheDocument()
  })

  it('says so when an indicator needs more bars than the range holds', async () => {
    // All-NaN would otherwise draw nothing, with no hint as to why.
    vi.mocked(indicatorsApi.values).mockResolvedValue({
      symbol: 'SA',
      indicator: 'rsi',
      params: { period: 14 },
      dates: [],
      outputs: { rsi: { values: [], valid_from: null } },
    })
    const user = userEvent.setup()
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA' })

    await user.click(await screen.findByRole('button', { name: /^Indicators/ }))
    await user.click(screen.getByRole('checkbox', { name: /RSI/ }))

    expect(
      await screen.findByText(/needs more bars than this range has/),
    ).toBeInTheDocument()
  })
})

describe('an indicator that fails to compute', () => {
  it('shows the server’s message instead of a permanently blank pane', async () => {
    // The router turns a user's raising compute() into a 422 carrying their
    // own exception text; swallowing it would leave them nothing to debug.
    vi.mocked(productsApi.bars).mockResolvedValue(EMPTY_BARS)
    vi.mocked(indicatorsApi.values).mockRejectedValue(
      new ApiError(422, 'Rsi.compute raised RuntimeError: boom from user code'),
    )
    const user = userEvent.setup()
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA' })

    await user.click(await screen.findByRole('button', { name: /^Indicators/ }))
    await user.click(screen.getByRole('checkbox', { name: /RSI/ }))

    expect(await screen.findByText(/boom from user code/)).toBeInTheDocument()
  })
})

/** The pencil on a picker row. What a user sets there has to reach the
 * values request, survive a reload, and never be saved if the server would
 * refuse it -- a refused set blanks the indicator on every later visit. */
describe('editing an indicator’s params', () => {
  const CATALOG: IndicatorInfo[] = [
    {
      ...INDICATORS[0],
      space: { fast: { kind: 'int', low: 2, high: 60 }, slow: { kind: 'int', low: 5, high: 250 } },
    },
    { ...INDICATORS[1], space: { period: { kind: 'int', low: 2, high: 100 } } },
  ]
  const VALUES: IndicatorValues = {
    symbol: 'SA',
    indicator: 'rsi',
    params: {},
    dates: [],
    outputs: { rsi: { values: [], valid_from: 0 } },
  }
  const stored = () => JSON.parse(localStorage.getItem('ft.indicatorParams') ?? '{}')
  // The backtest drawer below the chart has its own `fast` field and
  // Defaults button, for the strategy's params.
  const picker = () => within(screen.getByRole('dialog', { name: 'Indicators' }))

  beforeEach(() => {
    vi.mocked(indicatorsApi.list).mockResolvedValue(CATALOG)
    vi.mocked(productsApi.bars).mockResolvedValue(EMPTY_BARS)
    vi.mocked(indicatorsApi.values).mockResolvedValue(VALUES)
  })

  async function openEditor(name: string) {
    const user = userEvent.setup()
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA' })
    await user.click(await screen.findByRole('button', { name: /^Indicators/ }))
    await user.click(await screen.findByRole('button', { name: `Edit ${name} parameters` }))
    return user
  }

  it('applies the new params to the chart, remembers them, and ticks the row', async () => {
    const user = await openEditor('RSI')
    const period = screen.getByLabelText('period')
    expect(period).toHaveValue(14)

    await user.clear(period)
    await user.type(period, '21')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(indicatorsApi.values).toHaveBeenCalledWith('SA', 'rsi', { period: 21 }))
    expect(screen.queryByLabelText('period')).toBeNull()
    expect(stored()).toEqual({ rsi: { period: 21 } })
    // Applying to an unticked row puts it on the chart: otherwise the edit
    // would change nothing the user can see.
    expect(screen.getByRole('checkbox', { name: /RSI/ })).toBeChecked()
    expect(screen.getByText('21')).toHaveClass('is-custom')
  })

  it('flags an out-of-range value on its own field without saving it', async () => {
    const user = await openEditor('RSI')
    const period = screen.getByLabelText('period')
    await user.clear(period)
    await user.type(period, '500')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    expect(await screen.findByText('Must be between 2 and 100')).toBeInTheDocument()
    expect(indicatorsApi.values).not.toHaveBeenCalledWith('SA', 'rsi', { period: 500 })
    expect(stored()).toEqual({})
  })

  it('keeps the editor open with the server’s message when a constraint refuses the params', async () => {
    // `fast < slow` is a Python lambda: the browser cannot check it, so the
    // server's refusal is the only thing standing between it and storage.
    vi.mocked(indicatorsApi.values).mockImplementation(async (_code, _key, params) => {
      if (params?.fast === 30) throw new ApiError(422, 'Ma: those params violate one of its declared constraints')
      return VALUES
    })
    const user = await openEditor('MA')
    const fast = picker().getByLabelText('fast')
    await user.clear(fast)
    await user.type(fast, '30')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    expect(await screen.findByText(/violate one of its declared constraints/)).toBeInTheDocument()
    expect(picker().getByLabelText('fast')).toHaveValue(30)
    expect(stored()).toEqual({})
  })

  it('puts the defaults back with Defaults, and applying them clears the override', async () => {
    localStorage.setItem('ft.indicators', JSON.stringify(['rsi']))
    localStorage.setItem('ft.indicatorParams', JSON.stringify({ rsi: { period: 21 } }))
    const user = await openEditor('RSI')
    await waitFor(() => expect(indicatorsApi.values).toHaveBeenCalledWith('SA', 'rsi', { period: 21 }))
    expect(screen.getByLabelText('period')).toHaveValue(21)

    await user.click(picker().getByRole('button', { name: 'Defaults' }))
    expect(screen.getByLabelText('period')).toHaveValue(14)
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(stored()).toEqual({}))
    expect(indicatorsApi.values).toHaveBeenCalledWith('SA', 'rsi', {})
  })

  it('drops a saved param the class no longer declares instead of sending it', async () => {
    // Renamed under a hot reload: the server would 422 on it, and the user
    // could not even see it in the editor to fix it.
    localStorage.setItem('ft.indicators', JSON.stringify(['rsi']))
    localStorage.setItem('ft.indicatorParams', JSON.stringify({ rsi: { window: 9 } }))
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA' })

    await waitFor(() => expect(indicatorsApi.values).toHaveBeenCalledWith('SA', 'rsi', {}))
  })

  it('offers a reset on the chart’s banner when saved params are refused', async () => {
    localStorage.setItem('ft.indicators', JSON.stringify(['rsi']))
    localStorage.setItem('ft.indicatorParams', JSON.stringify({ rsi: { period: 21 } }))
    vi.mocked(indicatorsApi.values).mockImplementation(async (_code, _key, params) => {
      if (params?.period === 21) throw new ApiError(422, 'period=21 is outside its declared range 2..20')
      return VALUES
    })
    const user = userEvent.setup()
    renderWorkspace(<ChartWorkspace />, { path: '/?symbol=SA' })

    expect(await screen.findByText(/outside its declared range/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reset parameters' }))

    await waitFor(() => expect(screen.queryByText(/outside its declared range/)).toBeNull())
    expect(indicatorsApi.values).toHaveBeenCalledWith('SA', 'rsi', {})
    expect(stored()).toEqual({})
  })
})
