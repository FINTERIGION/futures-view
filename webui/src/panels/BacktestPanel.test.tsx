import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { backtestApi, indicatorsApi, runsApi, strategiesApi } from '../api/endpoints'
import { INDICATORS, STRATEGIES, renderWorkspace } from '../test/utils'
import type { BacktestFieldsPrefill } from './BacktestPanel'
import { BacktestPanel } from './BacktestPanel'

vi.mock('../api/endpoints', () => ({
  strategiesApi: { list: vi.fn(), reload: vi.fn() },
  backtestApi: { start: vi.fn() },
  runsApi: { list: vi.fn(), get: vi.fn(), price: vi.fn(), remove: vi.fn() },
  jobsApi: { get: vi.fn(), cancel: vi.fn(), streamUrl: (id: string) => `/api/jobs/${id}/stream` },
  indicatorsApi: { list: vi.fn(), get: vi.fn(), values: vi.fn(), reload: vi.fn() },
}))

/** The form's inputs carry no htmlFor, so reach them through the field their
 * label names. */
function fieldInput(label: string) {
  const field = screen.getByText(label).closest('.field')!
  return within(field as HTMLElement).getByRole('spinbutton')
}

beforeEach(() => {
  // Call history too, not just the resolved values: one test below asserts
  // the run was never started, and another one before it does start a run.
  vi.clearAllMocks()
  vi.mocked(strategiesApi.list).mockResolvedValue(STRATEGIES)
  vi.mocked(indicatorsApi.list).mockResolvedValue(INDICATORS)
  vi.mocked(backtestApi.start).mockResolvedValue({ job_id: 'j1', run_id: 'r1' })
  vi.mocked(runsApi.get).mockResolvedValue({
    id: 'r1', kind: 'backtest', created_at: 0, strategy: null, symbols: [], start: null, end: null,
    cash: null, slippage: null, status: 'done', params: {}, metrics: null, error: null,
    equity_records: [], trade_logs: [], deferred: {}, symbols_with_price: [],
  })
})

function renderPanel(prefill?: BacktestFieldsPrefill) {
  return renderWorkspace(<BacktestPanel prefill={prefill} />, { path: '/?symbol=SA' })
}

describe('prefill from a past run', () => {
  it('applies the prefilled strategy over the remembered one', async () => {
    // The ordinary case: the sticky strategy is whatever was run last, and
    // the run being reopened used something else.
    localStorage.setItem('ft.strategy', JSON.stringify('double_ma'))

    renderPanel({ strategy: 'chan_theory', start: '2020-01-01', end: '2024-01-01' })

    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('chan_theory'))
  })

  it('carries the cost assumptions the run was made under', async () => {
    // The panel's own default cash is 100000. A remembered 200000 must not
    // survive opening a run that was made at 100000 / 1.5.
    localStorage.setItem('ft.cash', JSON.stringify(200000))
    localStorage.setItem('ft.slippage', JSON.stringify(0))

    renderPanel({ strategy: 'chan_theory', cash: 100000, slippage: 1.5 })

    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('chan_theory'))
    expect(fieldInput('Cash')).toHaveValue(100000)
    expect(fieldInput('Slippage')).toHaveValue(1.5)
  })
})

describe('strategy parameters', () => {
  it('offers only the params in `space`, and does not send the rest', async () => {
    // `lots` is declared but left out of `space`: it runs at its default,
    // even when an older run had remembered a value for it.
    const user = userEvent.setup()
    vi.mocked(strategiesApi.list).mockResolvedValue([
      { ...STRATEGIES[0], params: { fast: 10, slow: 30, lots: 1 } },
      STRATEGIES[1],
    ])
    localStorage.setItem('ft.strategy', JSON.stringify('double_ma'))
    localStorage.setItem('ft.strategyParams', JSON.stringify({ double_ma: { fast: 12, lots: 4 } }))
    renderPanel()

    await waitFor(() => expect(fieldInput('fast')).toHaveValue(12))
    expect(screen.queryByText('lots')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /run backtest/i }))
    await waitFor(() => expect(backtestApi.start).toHaveBeenCalled())
    expect(vi.mocked(backtestApi.start).mock.calls[0][0].params).toEqual({ fast: 12, slow: 30 })
  })

  it('edits the declared params and sends the effective values', async () => {
    const user = userEvent.setup()
    localStorage.setItem('ft.strategy', JSON.stringify('double_ma'))
    renderPanel()

    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('double_ma'))
    expect(fieldInput('fast')).toHaveValue(10)
    expect(fieldInput('slow')).toHaveValue(30)
    expect(fieldInput('Cash')).toHaveValue(100000)

    fireEvent.change(fieldInput('fast'), { target: { value: '12' } })
    await user.click(screen.getByRole('button', { name: /run backtest/i }))
    await waitFor(() => expect(backtestApi.start).toHaveBeenCalled())
    expect(vi.mocked(backtestApi.start).mock.calls[0][0]).toMatchObject({
      params: { fast: 12, slow: 30 },
    })
  })

  it('keeps each strategy’s parameters separate, and drops a name the class no longer declares', async () => {
    const user = userEvent.setup()
    localStorage.setItem('ft.strategyParams', JSON.stringify({ chan_theory: { atr_mult: 3 } }))
    renderPanel({ strategy: 'double_ma', params: { fast: 7, slow: 40, retired: 9 } })

    await waitFor(() => expect(fieldInput('fast')).toHaveValue(7))
    expect(fieldInput('slow')).toHaveValue(40)
    expect(screen.queryByText('retired')).not.toBeInTheDocument()

    await user.selectOptions(screen.getByRole('combobox'), 'chan_theory')
    expect(fieldInput('atr_mult')).toHaveValue(3)
  })

  it('restores the class defaults and keeps them after switching strategy', async () => {
    const user = userEvent.setup()
    localStorage.setItem('ft.strategy', JSON.stringify('double_ma'))
    renderPanel()

    await waitFor(() => expect(fieldInput('fast')).toHaveValue(10))
    const reset = screen.getByRole('button', { name: 'Defaults' })
    expect(reset).toBeDisabled()

    fireEvent.change(fieldInput('fast'), { target: { value: '12' } })
    expect(reset).toBeEnabled()
    await user.click(reset)

    expect(fieldInput('fast')).toHaveValue(10)
    expect(fieldInput('slow')).toHaveValue(30)
    expect(reset).toBeDisabled()
    expect(JSON.parse(localStorage.getItem('ft.strategyParams')!)).toMatchObject({
      double_ma: { fast: 10, slow: 30 },
    })

    await user.selectOptions(screen.getByRole('combobox'), 'chan_theory')
    await user.selectOptions(screen.getByRole('combobox'), 'double_ma')
    expect(fieldInput('fast')).toHaveValue(10)
  })

  it('puts an out-of-range parameter back inside its range', async () => {
    const user = userEvent.setup()
    localStorage.setItem('ft.strategy', JSON.stringify('double_ma'))
    renderPanel()
    const runButton = await screen.findByRole('button', { name: /run backtest/i })
    await waitFor(() => expect(runButton).toBeEnabled())

    fireEvent.change(fieldInput('fast'), { target: { value: '101' } })
    await waitFor(() => expect(runButton).toBeDisabled())

    await user.click(screen.getByRole('button', { name: 'Defaults' }))
    expect(fieldInput('fast')).toHaveValue(10)
    expect(screen.queryByText(/must be between 2 and 100/i)).not.toBeInTheDocument()
    expect(runButton).toBeEnabled()
  })

  it('blocks the run when a parameter is outside its declared range', async () => {
    localStorage.setItem('ft.strategy', JSON.stringify('double_ma'))
    renderPanel()
    const runButton = await screen.findByRole('button', { name: /run backtest/i })
    await waitFor(() => expect(runButton).toBeEnabled())

    fireEvent.change(fieldInput('fast'), { target: { value: '101' } })
    await waitFor(() => expect(runButton).toBeDisabled())
    expect(screen.getByText(/must be between 2 and 100/i)).toBeInTheDocument()
    expect(backtestApi.start).not.toHaveBeenCalled()
  })
})

describe('slippage validation', () => {
  it('blocks the run and explains why when slippage is negative', async () => {
    localStorage.setItem('ft.strategy', JSON.stringify('double_ma'))
    renderPanel()

    const runButton = await screen.findByRole('button', { name: /run backtest/i })
    await waitFor(() => expect(runButton).toBeEnabled())

    // `fireEvent.change` rather than `user.type`: jsdom discards a number
    // input's value while it is transiently invalid, so typing "-5" a
    // character at a time lands on 5, not -5. A real browser keeps the minus.
    fireEvent.change(fieldInput('Slippage'), { target: { value: '-5' } })

    await waitFor(() => expect(runButton).toBeDisabled())
    expect(screen.getByText(/cannot be negative/i)).toBeInTheDocument()
    expect(backtestApi.start).not.toHaveBeenCalled()
  })
})

describe('cash and window validation', () => {
  it('blocks the run when cash is not greater than zero', async () => {
    localStorage.setItem('ft.strategy', JSON.stringify('double_ma'))
    renderPanel()
    const runButton = await screen.findByRole('button', { name: /run backtest/i })
    await waitFor(() => expect(runButton).toBeEnabled())

    fireEvent.change(fieldInput('Cash'), { target: { value: '0' } })
    await waitFor(() => expect(runButton).toBeDisabled())
    expect(screen.getByText(/greater than zero/i)).toBeInTheDocument()
    expect(backtestApi.start).not.toHaveBeenCalled()
  })

  it('blocks the run when the start date is after the end date', async () => {
    localStorage.setItem('ft.strategy', JSON.stringify('double_ma'))
    renderPanel()
    const runButton = await screen.findByRole('button', { name: /run backtest/i })
    await waitFor(() => expect(runButton).toBeEnabled())

    const dateInput = (label: string) =>
      screen.getByText(label).closest('.field')!.querySelector('input') as HTMLInputElement
    fireEvent.change(dateInput('Start'), { target: { value: '2024-06-01' } })
    fireEvent.change(dateInput('End'), { target: { value: '2024-01-01' } })

    await waitFor(() => expect(runButton).toBeDisabled())
    expect(screen.getByText(/start date on or before the end date/i)).toBeInTheDocument()
    expect(backtestApi.start).not.toHaveBeenCalled()
  })
})

describe('a strategy whose file failed to load', () => {
  const BROKEN = {
    ...STRATEGIES[0],
    key: 'ftk_typo',
    class_name: '',
    module: 'strategies.ftk_typo',
    file: '',
    params: {},
    space: {},
    errors: ["SyntaxError: '(' was never closed (ftk_typo.py, line 1)"],
  }

  it('is listed disabled with its error, and never picked by default', async () => {
    // Listed first, so a default of `strategies[0]` would have landed on it.
    vi.mocked(strategiesApi.list).mockResolvedValue([BROKEN, ...STRATEGIES])
    renderPanel()

    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('double_ma'))
    const option = screen.getByRole('option', { name: /ftk_typo/ }) as HTMLOptionElement
    expect(option.disabled).toBe(true)
    expect(screen.getByText(/was never closed/)).toBeInTheDocument()
  })

  it('cannot be run when it is the remembered pick', async () => {
    vi.mocked(strategiesApi.list).mockResolvedValue([...STRATEGIES, BROKEN])
    localStorage.setItem('ft.strategy', JSON.stringify('ftk_typo'))
    renderPanel()

    await screen.findByText(/was never closed/)
    expect(screen.getByRole('button', { name: /run backtest/i })).toBeDisabled()
  })
})

describe('the reload button', () => {
  const RENAMED = { ...STRATEGIES[0], key: 'double_ma_v2', class_name: 'DoubleMaV2Strategy' }

  it('re-imports strategies/ and refetches the dropdown', async () => {
    const user = userEvent.setup()
    localStorage.setItem('ft.strategy', JSON.stringify('double_ma'))
    renderPanel()
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('double_ma'))

    vi.mocked(strategiesApi.list).mockResolvedValue([...STRATEGIES, RENAMED])
    vi.mocked(strategiesApi.reload).mockResolvedValue({
      reloaded: true, strategies: [...STRATEGIES, RENAMED].map((s) => s.key), failed: {},
    })
    await user.click(screen.getByRole('button', { name: /^reload$/i }))

    expect(strategiesApi.reload).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('option', { name: 'double_ma_v2' })).toBeInTheDocument()
    expect(screen.getByText(/reloaded 3 strategies/i)).toBeInTheDocument()
  })

  it('moves off a pick whose class the reload removed', async () => {
    // Renaming the class renames its key. Left on the stale key, the select
    // showed another strategy while the run sent the one that is gone.
    const user = userEvent.setup()
    localStorage.setItem('ft.strategy', JSON.stringify('double_ma'))
    renderPanel()
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('double_ma'))

    const after = [RENAMED, ...STRATEGIES.slice(1)]
    vi.mocked(strategiesApi.list).mockResolvedValue(after)
    vi.mocked(strategiesApi.reload).mockResolvedValue({
      reloaded: true, strategies: after.map((s) => s.key), failed: {},
    })
    await user.click(screen.getByRole('button', { name: /^reload$/i }))

    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('double_ma_v2'))
  })

  it("says why when the server refuses, and keeps the list it had", async () => {
    const user = userEvent.setup()
    renderPanel()
    await screen.findByRole('option', { name: 'double_ma' })

    vi.mocked(strategiesApi.reload).mockRejectedValue(new ApiError(409, 'A job is running'))
    await user.click(screen.getByRole('button', { name: /^reload$/i }))

    expect(await screen.findByText(/could not reload strategies/i)).toBeInTheDocument()
    expect(screen.getByText(/a job is running/i)).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'double_ma' })).toBeInTheDocument()
  })
})

describe('the window presets', () => {
  it('end on today in the local calendar, not on the UTC date', async () => {
    // 01:30 on 24 September in Beijing is still the 23rd in UTC, and
    // `toISOString()` handed the preset that stale end date.
    vi.stubEnv('TZ', 'Asia/Shanghai')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-23T17:30:00Z'))
    try {
      renderPanel()
      fireEvent.click(await screen.findByRole('button', { name: '1Y' }))

      const input = (label: string) =>
        screen.getByText(label).closest('.field')!.querySelector('input') as HTMLInputElement
      expect(input('End').value).toBe('2026-09-24')
      expect(input('Start').value).toBe('2025-09-24')
    } finally {
      vi.useRealTimers()
      vi.unstubAllEnvs()
    }
  })
})
