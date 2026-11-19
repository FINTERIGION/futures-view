import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { alertsApi, jobsApi } from '../api/endpoints'
import type { AlertDelivery, AlertMonitor, AlertSchedule, NotifyChannel } from '../api/types'
import { MockEventSource } from '../test/setup'
import { renderWorkspace } from '../test/utils'
import { AlertNotifyModal } from './AlertNotifyModal'

vi.mock('../api/endpoints', () => ({
  alertsApi: {
    getSchedule: vi.fn(),
    updateSchedule: vi.fn(),
    listChannels: vi.fn(),
    createChannel: vi.fn(),
    updateChannel: vi.fn(),
    deleteChannel: vi.fn(),
    testChannel: vi.fn(),
    listMonitors: vi.fn(),
    dispatch: vi.fn(),
    listDeliveries: vi.fn(),
  },
  jobsApi: { get: vi.fn(), cancel: vi.fn(), streamUrl: (id: string) => `/api/jobs/${id}/stream` },
}))

const SCHEDULE: AlertSchedule = {
  enabled: true,
  times: ['15:30'],
  timezone: 'Asia/Shanghai',
  weekdays_only: true,
  update_data: true,
  language: 'zh',
  next_run_at: '2026-11-20T15:30:00+08:00',
  server_now: '2026-11-19T20:00:00+08:00',
  scheduler_running: true,
}

const CHANNEL: NotifyChannel = {
  id: 'ch1',
  kind: 'telegram',
  name: 'My Telegram',
  enabled: true,
  config: {
    bot_token: '',
    has_bot_token: true,
    bot_token_preview: '1234…ABCD',
    chat_id: '-100999',
    api_base: 'https://api.telegram.org',
    proxy: '',
    message_thread_id: null,
  },
  created_at: 1,
  updated_at: 1,
}

const MONITOR: AlertMonitor = {
  id: 'm1',
  name: '',
  strategy: 'double_ma',
  symbols: ['SA'],
  params: {},
  notify_enabled: true,
  created_at: 1,
  updated_at: 1,
  last_snapshot: null,
  last_checked_at: null,
  last_error: null,
}

const DELIVERY: AlertDelivery = {
  id: 'd1',
  trigger: 'schedule',
  scheduled_slot: '2026-11-19 15:30',
  created_at: 1_700_000_000,
  finished_at: 1_700_000_005,
  status: 'ok',
  monitor_count: 1,
  symbols_updated: ['SA'],
  data_warnings: [],
  results: [
    {
      channel_id: 'ch1',
      channel_name: 'My Telegram',
      kind: 'telegram',
      ok: true,
      detail: 'Sent (1 message)',
      status_code: 200,
    },
  ],
  summary: 'Checked 1 monitor(s); delivered to 1/1 channel(s)',
  error: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(alertsApi.getSchedule).mockResolvedValue(SCHEDULE)
  vi.mocked(alertsApi.updateSchedule).mockImplementation(async (body) => ({ ...SCHEDULE, ...body }))
  vi.mocked(alertsApi.listChannels).mockResolvedValue([CHANNEL])
  vi.mocked(alertsApi.listMonitors).mockResolvedValue([MONITOR])
  vi.mocked(alertsApi.listDeliveries).mockResolvedValue([DELIVERY])
  vi.mocked(alertsApi.createChannel).mockResolvedValue(CHANNEL)
  vi.mocked(alertsApi.deleteChannel).mockResolvedValue({ deleted: 'ch1' })
  vi.mocked(alertsApi.testChannel).mockResolvedValue({
    channel_id: 'ch1',
    channel_name: 'My Telegram',
    kind: 'telegram',
    ok: true,
    detail: 'Sent (1 message)',
    status_code: 200,
  })
  vi.mocked(alertsApi.dispatch).mockResolvedValue({ job_id: 'disp-1' })
  vi.mocked(jobsApi.get).mockResolvedValue({
    id: 'disp-1',
    kind: 'alert_dispatch',
    status: 'done',
    progress: 1,
    message: 'Done',
    error: null,
    created_at: 0,
    started_at: 0,
    finished_at: 0,
    cancel_requested: false,
    result: { status: 'ok', summary: 'Checked 1 monitor(s); delivered to 1/1 channel(s)' },
  })
})

describe('AlertNotifyModal (centered floating dialog)', () => {
  it('renders centered with schedule settings, saves changes, and triggers manual dispatch', async () => {
    const user = userEvent.setup()
    renderWorkspace(<AlertNotifyModal open onClose={() => {}} />)

    const dialog = await screen.findByRole('dialog', { name: 'Alert Notifications' })
    expect(dialog).toHaveClass('modal')
    expect(await screen.findByText(/Next run: 2026-11-20 15:30/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save schedule' }))
    await waitFor(() =>
      expect(alertsApi.updateSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true, times: ['15:30'], weekdays_only: true }),
      ),
    )

    await user.click(screen.getByRole('button', { name: 'Update & send now' }))
    await waitFor(() => expect(alertsApi.dispatch).toHaveBeenCalledWith({ update_data: true }))
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))
    MockEventSource.instances[0].emit({ type: 'state', status: 'done', progress: 1, message: 'Done' })
    expect(await screen.findByText('Checked 1 monitor(s); delivered to 1/1 channel(s)')).toBeInTheDocument()
  })

  it('creates a webhook channel with preset, tests a channel, and confirms delete above the modal', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderWorkspace(<AlertNotifyModal open onClose={onClose} />)

    await user.click(await screen.findByRole('tab', { name: /Channels/ }))
    expect(await screen.findByText('My Telegram')).toBeInTheDocument()

    // Test existing channel
    await user.click(screen.getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(alertsApi.testChannel).toHaveBeenCalledWith('ch1'))

    // Add a generic webhook with Feishu preset
    await user.click(screen.getByRole('button', { name: 'Add channel' }))
    await user.selectOptions(screen.getByLabelText('Platform'), 'webhook')
    await user.type(screen.getByLabelText('Name'), 'Feishu Bot')
    await user.type(screen.getByLabelText('Webhook URL'), 'https://open.feishu.cn/open-apis/bot/v2/hook/abc')
    await user.click(screen.getByRole('button', { name: 'Feishu' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(alertsApi.createChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'webhook',
          name: 'Feishu Bot',
          config: expect.objectContaining({
            url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc',
            payload_template: expect.stringContaining('"msg_type": "text"'),
          }),
        }),
      ),
    )

    // Delete opens nested ConfirmDialog; Escape closes only the confirm dialog, not the parent modal
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    const confirm = screen.getByRole('dialog', { name: 'Delete channel' })
    expect(confirm).toHaveClass('modal-confirm')
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    const confirmAgain = screen.getByRole('dialog', { name: 'Delete channel' })
    await user.click(within(confirmAgain).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(alertsApi.deleteChannel).toHaveBeenCalledWith('ch1'))
  })

  it('displays delivery history tab with channel results', async () => {
    const user = userEvent.setup()
    renderWorkspace(<AlertNotifyModal open onClose={() => {}} />)

    await user.click(await screen.findByRole('tab', { name: 'History' }))
    expect(await screen.findByText('2026-11-19 15:30')).toBeInTheDocument()
    expect(screen.getByText('My Telegram: Sent (1 message)')).toBeInTheDocument()
  })
})
