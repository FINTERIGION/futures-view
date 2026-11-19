import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../api/client'
import { alertsApi } from '../api/endpoints'
import type {
  AlertDelivery,
  AlertScheduleInput,
  NotifyChannel,
  NotifyChannelKind,
} from '../api/types'
import { Card } from '../components/Card'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Icon } from '../components/Icon'
import { JobProgress } from '../components/JobProgress'
import { Modal } from '../components/Modal'
import { Tabs, type TabItem } from '../components/Tabs'
import { useToast } from '../components/Toast'
import { useJobSlot } from '../shell/JobsProvider'

type NotifyTab = 'schedule' | 'channels' | 'history'

const COMMON_TIMEZONES = [
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Singapore',
  'UTC',
  'America/New_York',
  'Europe/London',
]

const WEBHOOK_PRESETS: Array<{ key: string; template: string }> = [
  { key: 'presetDefault', template: '' },
  {
    key: 'presetFeishu',
    template: JSON.stringify({ msg_type: 'text', content: { text: '{{text}}' } }, null, 2),
  },
  {
    key: 'presetDingtalk',
    template: JSON.stringify({ msgtype: 'text', text: { content: '{{text}}' } }, null, 2),
  },
  {
    key: 'presetWecom',
    template: JSON.stringify({ msgtype: 'text', text: { content: '{{text}}' } }, null, 2),
  },
  {
    key: 'presetDiscord',
    template: JSON.stringify({ content: '{{text}}' }, null, 2),
  },
]

const DEFAULT_SCHEDULE_DRAFT: AlertScheduleInput = {
  enabled: false,
  times: ['15:30'],
  timezone: 'Asia/Shanghai',
  weekdays_only: true,
  update_data: true,
  language: 'zh',
}

interface ChannelDraft {
  editingId: string | null
  kind: NotifyChannelKind
  name: string
  enabled: boolean
  // Telegram
  botToken: string
  hasBotToken: boolean
  botTokenPreview: string
  chatId: string
  apiBase: string
  threadId: string
  // Webhook
  url: string
  bearerToken: string
  hasBearerToken: boolean
  bearerTokenPreview: string
  clearBearerToken: boolean
  headersText: string
  payloadTemplate: string
  // Shared
  proxy: string
}

function emptyChannelDraft(kind: NotifyChannelKind = 'telegram'): ChannelDraft {
  return {
    editingId: null,
    kind,
    name: '',
    enabled: true,
    botToken: '',
    hasBotToken: false,
    botTokenPreview: '',
    chatId: '',
    apiBase: 'https://api.telegram.org',
    threadId: '',
    url: '',
    bearerToken: '',
    hasBearerToken: false,
    bearerTokenPreview: '',
    clearBearerToken: false,
    headersText: '',
    payloadTemplate: '',
    proxy: '',
  }
}

function draftFromChannel(ch: NotifyChannel): ChannelDraft {
  const cfg = ch.config ?? {}
  const headers = cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {}
  const hasHeaders = Object.keys(headers as Record<string, unknown>).length > 0
  return {
    editingId: ch.id,
    kind: ch.kind,
    name: ch.name,
    enabled: ch.enabled,
    botToken: '',
    hasBotToken: Boolean(cfg.has_bot_token),
    botTokenPreview: String(cfg.bot_token_preview ?? ''),
    chatId: String(cfg.chat_id ?? ''),
    apiBase: String(cfg.api_base ?? 'https://api.telegram.org'),
    threadId: cfg.message_thread_id != null ? String(cfg.message_thread_id) : '',
    url: String(cfg.url ?? ''),
    bearerToken: '',
    hasBearerToken: Boolean(cfg.has_bearer_token),
    bearerTokenPreview: String(cfg.bearer_token_preview ?? ''),
    clearBearerToken: false,
    headersText: hasHeaders ? JSON.stringify(headers, null, 2) : '',
    payloadTemplate: String(cfg.payload_template ?? ''),
    proxy: String(cfg.proxy ?? ''),
  }
}

function formatEpoch(sec: number): string {
  try {
    return new Date(sec * 1000).toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
  } catch {
    return String(sec)
  }
}

function formatIsoDisplay(iso: string): string {
  return iso.replace('T', ' ')
}

function deliveryStatusVariant(status: AlertDelivery['status']): string {
  if (status === 'ok') return 'badge-success'
  if (status === 'partial' || status === 'skipped') return 'badge-warning'
  if (status === 'error' || status === 'interrupted') return 'badge-danger'
  if (status === 'running') return 'badge-accent'
  return 'badge-neutral'
}

export function AlertNotifyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const dispatchJob = useJobSlot('dispatch')

  const [tab, setTab] = useState<NotifyTab>('schedule')
  const [scheduleDraft, setScheduleDraft] = useState<AlertScheduleInput>(DEFAULT_SCHEDULE_DRAFT)
  const [scheduleSeeded, setScheduleSeeded] = useState(false)
  const [scheduleError, setScheduleError] = useState<string | null>(null)
  const [dispatchStarting, setDispatchStarting] = useState(false)

  const [channelDraft, setChannelDraft] = useState<ChannelDraft | null>(null)
  const [channelError, setChannelError] = useState<string | null>(null)
  const [testingChannelId, setTestingChannelId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<NotifyChannel | null>(null)

  const lastHandledDispatchRef = useRef<string | null>(null)

  const { data: schedule } = useQuery({
    queryKey: ['alert-schedule'],
    queryFn: alertsApi.getSchedule,
    enabled: open,
  })
  const { data: channels = [] } = useQuery({
    queryKey: ['alert-channels'],
    queryFn: alertsApi.listChannels,
    enabled: open,
  })
  const { data: monitors = [] } = useQuery({
    queryKey: ['alert-monitors'],
    queryFn: alertsApi.listMonitors,
    enabled: open,
  })
  const {
    data: deliveries = [],
    refetch: refetchDeliveries,
    isFetching: deliveriesFetching,
  } = useQuery({
    queryKey: ['alert-deliveries'],
    queryFn: () => alertsApi.listDeliveries(30),
    enabled: open && tab === 'history',
  })

  // Seed schedule draft once per modal open from the latest server state.
  if (open && schedule && !scheduleSeeded) {
    setScheduleSeeded(true)
    setScheduleDraft({
      enabled: schedule.enabled,
      times: schedule.times.length > 0 ? [...schedule.times] : ['15:30'],
      timezone: schedule.timezone,
      weekdays_only: schedule.weekdays_only,
      update_data: schedule.update_data,
      language: schedule.language,
    })
  }

  // When a manual dispatch job finishes (even if the user closed the modal),
  // refresh monitors, deliveries, and products/coverage caches.
  useEffect(() => {
    const state = dispatchJob.state
    if (!state || !['done', 'error', 'cancelled'].includes(state.status)) return
    const key = `${state.id}:${state.status}`
    if (lastHandledDispatchRef.current === key) return
    if (state.status === 'done' && !('result' in state)) return
    lastHandledDispatchRef.current = key

    void queryClient.invalidateQueries({ queryKey: ['alert-monitors'] })
    void queryClient.invalidateQueries({ queryKey: ['alert-deliveries'] })
    void queryClient.invalidateQueries({ queryKey: ['alert-schedule'] })
    void queryClient.invalidateQueries({ queryKey: ['products'] })

    if (state.status === 'done') {
      const outcome = state.result as { status?: string; summary?: string } | undefined
      const kind = outcome?.status === 'ok' ? 'success' : outcome?.status === 'error' ? 'error' : 'info'
      toast.push({
        kind,
        title: outcome?.summary || t('alerts.notify.sendNowDone'),
      })
    } else if (state.status === 'error') {
      toast.push({
        kind: 'error',
        title: state.error || t('common.updateFailed'),
      })
    }
  }, [dispatchJob.state, queryClient, t, toast])

  function handleClose() {
    setScheduleSeeded(false)
    setScheduleError(null)
    setChannelDraft(null)
    setChannelError(null)
    setConfirmDelete(null)
    onClose()
  }

  const saveScheduleMutation = useMutation({
    mutationFn: (body: AlertScheduleInput) => alertsApi.updateSchedule(body),
    onSuccess: (saved) => {
      queryClient.setQueryData(['alert-schedule'], saved)
      setScheduleDraft({
        enabled: saved.enabled,
        times: saved.times.length > 0 ? [...saved.times] : ['15:30'],
        timezone: saved.timezone,
        weekdays_only: saved.weekdays_only,
        update_data: saved.update_data,
        language: saved.language,
      })
      setScheduleError(null)
      toast.push({ kind: 'success', title: t('alerts.notify.scheduleSaved') })
    },
    onError: (err: unknown) => {
      setScheduleError(errorMessage(err))
    },
  })

  const saveChannelMutation = useMutation({
    mutationFn: async (draft: ChannelDraft) => {
      const config: Record<string, unknown> =
        draft.kind === 'telegram'
          ? {
              bot_token: draft.botToken.trim(),
              chat_id: draft.chatId.trim(),
              api_base: draft.apiBase.trim(),
              proxy: draft.proxy.trim(),
              message_thread_id: draft.threadId.trim() ? Number(draft.threadId.trim()) : null,
            }
          : {
              url: draft.url.trim(),
              bearer_token: draft.bearerToken.trim(),
              clear_bearer_token: draft.clearBearerToken,
              headers: draft.headersText.trim() ? draft.headersText.trim() : {},
              proxy: draft.proxy.trim(),
              payload_template: draft.payloadTemplate.trim(),
            }
      const payload = {
        kind: draft.kind,
        name: draft.name.trim(),
        enabled: draft.enabled,
        config,
      }
      return draft.editingId
        ? alertsApi.updateChannel(draft.editingId, payload)
        : alertsApi.createChannel(payload)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['alert-channels'] })
      setChannelDraft(null)
      setChannelError(null)
      toast.push({ kind: 'success', title: t('alerts.notify.channelSaved') })
    },
    onError: (err: unknown) => {
      setChannelError(errorMessage(err))
    },
  })

  const toggleChannelMutation = useMutation({
    mutationFn: (ch: NotifyChannel) =>
      alertsApi.updateChannel(ch.id, {
        kind: ch.kind,
        name: ch.name,
        enabled: !ch.enabled,
        config: ch.config,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['alert-channels'] })
    },
    onError: (err: unknown) => {
      toast.push({ kind: 'error', title: errorMessage(err) })
    },
  })

  const deleteChannelMutation = useMutation({
    mutationFn: (id: string) => alertsApi.deleteChannel(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['alert-channels'] })
      setConfirmDelete(null)
      toast.push({ kind: 'success', title: t('alerts.notify.channelDeleted') })
    },
    onError: (err: unknown) => {
      toast.push({ kind: 'error', title: errorMessage(err) })
    },
  })

  async function handleTestChannel(ch: NotifyChannel) {
    setTestingChannelId(ch.id)
    try {
      const res = await alertsApi.testChannel(ch.id)
      await queryClient.invalidateQueries({ queryKey: ['alert-deliveries'] })
      toast.push({
        kind: res.ok ? 'success' : 'error',
        title: res.ok
          ? `${t('alerts.notify.testSuccess')} (${ch.name})`
          : `${t('alerts.notify.testFailed')} (${ch.name}): ${res.detail}`,
      })
    } catch (err) {
      toast.push({ kind: 'error', title: errorMessage(err) })
    } finally {
      setTestingChannelId(null)
    }
  }

  async function handleDispatchNow() {
    if (dispatchStarting || dispatchJob.isActive) return
    setDispatchStarting(true)
    setScheduleError(null)
    try {
      dispatchJob.reset()
      const { job_id } = await alertsApi.dispatch({ update_data: scheduleDraft.update_data })
      dispatchJob.start(job_id)
    } catch (err) {
      setScheduleError(errorMessage(err))
    } finally {
      setDispatchStarting(false)
    }
  }

  function handleSaveSchedule(e: FormEvent) {
    e.preventDefault()
    setScheduleError(null)
    saveScheduleMutation.mutate(scheduleDraft)
  }

  function handleSaveChannel(e: FormEvent) {
    e.preventDefault()
    if (!channelDraft) return
    setChannelError(null)
    saveChannelMutation.mutate(channelDraft)
  }

  const tabs: TabItem[] = [
    { key: 'schedule', label: t('alerts.notify.tabSchedule') },
    {
      key: 'channels',
      label:
        channels.length > 0
          ? `${t('alerts.notify.tabChannels')} (${channels.length})`
          : t('alerts.notify.tabChannels'),
    },
    { key: 'history', label: t('alerts.notify.tabHistory') },
  ]

  const includedMonitors = monitors.filter((m) => m.notify_enabled).length
  const enabledChannels = channels.filter((c) => c.enabled).length
  const tzOptions = COMMON_TIMEZONES.includes(scheduleDraft.timezone)
    ? COMMON_TIMEZONES
    : [scheduleDraft.timezone, ...COMMON_TIMEZONES]

  return (
    <>
      <Modal
        open={open}
        onClose={handleClose}
        title={t('alerts.notify.title')}
        size="lg"
        closeOnEscape={confirmDelete === null}
      >
        <div className="notify-modal">
          <div className="tabs-bar notify-tabs">
            <Tabs items={tabs} active={tab} onChange={(k) => setTab(k as NotifyTab)} />
          </div>

          {tab === 'schedule' && (
            <form className="notify-section" onSubmit={handleSaveSchedule}>
              <div className="notify-status-box">
                <div className="notify-status-line">
                  <Icon name="clock" size={15} />
                  <span>
                    {schedule?.enabled && schedule.next_run_at
                      ? t('alerts.notify.nextRun', { time: formatIsoDisplay(schedule.next_run_at) })
                      : t('alerts.notify.scheduleDisabled')}
                  </span>
                </div>
                <span className="field-hint">
                  {t('alerts.notify.summaryCounts', {
                    monitors: includedMonitors,
                    channels: enabledChannels,
                  })}
                </span>
              </div>

              {includedMonitors === 0 && (
                <div className="hint-banner warning">
                  <Icon name="alert" />
                  <span>{t('alerts.notify.missingMonitorsWarn')}</span>
                </div>
              )}
              {enabledChannels === 0 && (
                <div className="hint-banner warning">
                  <Icon name="alert" />
                  <span>{t('alerts.notify.missingChannelsWarn')}</span>
                </div>
              )}

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={scheduleDraft.enabled}
                  onChange={(e) => setScheduleDraft({ ...scheduleDraft, enabled: e.target.checked })}
                />
                <span>{t('alerts.notify.enableSchedule')}</span>
              </label>

              <div className="field">
                <div className="field-label-row">
                  <label>{t('alerts.notify.times')}</label>
                  {scheduleDraft.times.length < 6 && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() =>
                        setScheduleDraft({
                          ...scheduleDraft,
                          times: [...scheduleDraft.times, '20:30'],
                        })
                      }
                    >
                      <Icon name="plus" size={13} />
                      {t('alerts.notify.addTime')}
                    </button>
                  )}
                </div>
                <div className="notify-time-list">
                  {scheduleDraft.times.map((tm, idx) => (
                    <div className="notify-time-chip" key={`${idx}-${tm}`}>
                      <input
                        type="time"
                        aria-label={`${t('alerts.notify.times')} ${idx + 1}`}
                        value={tm}
                        onChange={(e) => {
                          const next = [...scheduleDraft.times]
                          next[idx] = e.target.value
                          setScheduleDraft({ ...scheduleDraft, times: next })
                        }}
                      />
                      {scheduleDraft.times.length > 1 && (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost btn-icon"
                          aria-label={t('alerts.notify.removeTime')}
                          title={t('alerts.notify.removeTime')}
                          onClick={() =>
                            setScheduleDraft({
                              ...scheduleDraft,
                              times: scheduleDraft.times.filter((_, i) => i !== idx),
                            })
                          }
                        >
                          <Icon name="close" size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <p className="field-hint">{t('alerts.notify.timesHint')}</p>
              </div>

              <div className="notify-grid-2">
                <div className="field">
                  <label htmlFor="notify-tz">{t('alerts.notify.timezone')}</label>
                  <select
                    id="notify-tz"
                    value={scheduleDraft.timezone}
                    onChange={(e) => setScheduleDraft({ ...scheduleDraft, timezone: e.target.value })}
                  >
                    {tzOptions.map((tz) => (
                      <option key={tz} value={tz}>
                        {tz}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label htmlFor="notify-lang">{t('alerts.notify.language')}</label>
                  <select
                    id="notify-lang"
                    value={scheduleDraft.language}
                    onChange={(e) =>
                      setScheduleDraft({
                        ...scheduleDraft,
                        language: e.target.value === 'en' ? 'en' : 'zh',
                      })
                    }
                  >
                    <option value="zh">{t('alerts.notify.langZh')}</option>
                    <option value="en">{t('alerts.notify.langEn')}</option>
                  </select>
                </div>
              </div>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={scheduleDraft.weekdays_only}
                  onChange={(e) => setScheduleDraft({ ...scheduleDraft, weekdays_only: e.target.checked })}
                />
                <span>{t('alerts.notify.weekdaysOnly')}</span>
              </label>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={scheduleDraft.update_data}
                  onChange={(e) => setScheduleDraft({ ...scheduleDraft, update_data: e.target.checked })}
                />
                <span>{t('alerts.notify.updateDataBeforeSend')}</span>
              </label>

              {scheduleError && <p className="field-error">{scheduleError}</p>}

              <div className="toolbar notify-actions">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={saveScheduleMutation.isPending}
                >
                  {t('alerts.notify.saveSchedule')}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={dispatchStarting || dispatchJob.isActive || includedMonitors === 0 || enabledChannels === 0}
                  onClick={() => void handleDispatchNow()}
                >
                  <Icon name="send" size={14} />
                  {t('alerts.notify.sendNow')}
                </button>
              </div>

              {dispatchJob.state && (
                <JobProgress
                  state={dispatchJob.state}
                  logs={dispatchJob.logs}
                  onCancel={dispatchJob.cancel}
                  streaming={dispatchJob.streaming}
                  lost={dispatchJob.lost}
                />
              )}
            </form>
          )}

          {tab === 'channels' && (
            <div className="notify-section">
              <div className="toolbar">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => {
                    setChannelError(null)
                    setChannelDraft(emptyChannelDraft('telegram'))
                  }}
                >
                  <Icon name="plus" size={14} />
                  {t('alerts.notify.addChannel')}
                </button>
              </div>

              {channelDraft && (
                <Card
                  title={channelDraft.editingId ? t('alerts.notify.editChannel') : t('alerts.notify.newChannel')}
                >
                  <form className="notify-channel-form" onSubmit={handleSaveChannel}>
                    <div className="notify-grid-2">
                      <div className="field">
                        <label htmlFor="ch-kind">{t('alerts.notify.channelKind')}</label>
                        <select
                          id="ch-kind"
                          value={channelDraft.kind}
                          disabled={channelDraft.editingId !== null}
                          onChange={(e) =>
                            setChannelDraft({
                              ...emptyChannelDraft(e.target.value as NotifyChannelKind),
                              name: channelDraft.name,
                              enabled: channelDraft.enabled,
                            })
                          }
                        >
                          <option value="telegram">{t('alerts.notify.kindTelegram')}</option>
                          <option value="webhook">{t('alerts.notify.kindWebhook')}</option>
                        </select>
                      </div>
                      <div className="field">
                        <label htmlFor="ch-name">{t('alerts.notify.channelName')}</label>
                        <input
                          id="ch-name"
                          type="text"
                          required
                          value={channelDraft.name}
                          onChange={(e) => setChannelDraft({ ...channelDraft, name: e.target.value })}
                          placeholder={channelDraft.kind === 'telegram' ? 'My Telegram' : 'My Webhook'}
                        />
                      </div>
                    </div>

                    {channelDraft.kind === 'telegram' ? (
                      <>
                        <div className="hint-banner">
                          <Icon name="info" />
                          <span>{t('alerts.notify.telegramHint')}</span>
                        </div>
                        <div className="field">
                          <label htmlFor="ch-tg-token">{t('alerts.notify.botToken')}</label>
                          <input
                            id="ch-tg-token"
                            type="password"
                            autoComplete="off"
                            required={!channelDraft.hasBotToken}
                            value={channelDraft.botToken}
                            onChange={(e) => setChannelDraft({ ...channelDraft, botToken: e.target.value })}
                            placeholder={
                              channelDraft.hasBotToken
                                ? t('alerts.notify.botTokenKeepPlaceholder', {
                                    preview: channelDraft.botTokenPreview || '••••',
                                  })
                                : t('alerts.notify.botTokenPlaceholder')
                            }
                          />
                        </div>
                        <div className="notify-grid-2">
                          <div className="field">
                            <label htmlFor="ch-tg-chat">{t('alerts.notify.chatId')}</label>
                            <input
                              id="ch-tg-chat"
                              type="text"
                              required
                              value={channelDraft.chatId}
                              onChange={(e) => setChannelDraft({ ...channelDraft, chatId: e.target.value })}
                              placeholder={t('alerts.notify.chatIdPlaceholder')}
                            />
                          </div>
                          <div className="field">
                            <label htmlFor="ch-tg-thread">{t('alerts.notify.threadId')}</label>
                            <input
                              id="ch-tg-thread"
                              type="number"
                              min={1}
                              value={channelDraft.threadId}
                              onChange={(e) => setChannelDraft({ ...channelDraft, threadId: e.target.value })}
                            />
                          </div>
                        </div>
                        <div className="field">
                          <label htmlFor="ch-tg-base">{t('alerts.notify.apiBase')}</label>
                          <input
                            id="ch-tg-base"
                            type="text"
                            value={channelDraft.apiBase}
                            onChange={(e) => setChannelDraft({ ...channelDraft, apiBase: e.target.value })}
                          />
                          <p className="field-hint">{t('alerts.notify.apiBaseHint')}</p>
                        </div>
                        <div className="field">
                          <label htmlFor="ch-tg-proxy">{t('alerts.notify.proxy')}</label>
                          <input
                            id="ch-tg-proxy"
                            type="text"
                            value={channelDraft.proxy}
                            onChange={(e) => setChannelDraft({ ...channelDraft, proxy: e.target.value })}
                            placeholder={t('alerts.notify.proxyPlaceholder')}
                          />
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="field">
                          <label htmlFor="ch-wh-url">{t('alerts.notify.webhookUrl')}</label>
                          <input
                            id="ch-wh-url"
                            type="url"
                            required
                            value={channelDraft.url}
                            onChange={(e) => setChannelDraft({ ...channelDraft, url: e.target.value })}
                            placeholder={t('alerts.notify.webhookUrlPlaceholder')}
                          />
                        </div>
                        <div className="notify-grid-2">
                          <div className="field">
                            <label htmlFor="ch-wh-bearer">{t('alerts.notify.bearerToken')}</label>
                            <input
                              id="ch-wh-bearer"
                              type="password"
                              autoComplete="off"
                              value={channelDraft.bearerToken}
                              onChange={(e) =>
                                setChannelDraft({
                                  ...channelDraft,
                                  bearerToken: e.target.value,
                                  clearBearerToken: false,
                                })
                              }
                              placeholder={
                                channelDraft.hasBearerToken
                                  ? t('alerts.notify.bearerTokenKeepPlaceholder', {
                                      preview: channelDraft.bearerTokenPreview || '••••',
                                    })
                                  : ''
                              }
                            />
                            {channelDraft.hasBearerToken && (
                              <label className="checkbox-row notify-inline-check">
                                <input
                                  type="checkbox"
                                  checked={channelDraft.clearBearerToken}
                                  onChange={(e) =>
                                    setChannelDraft({
                                      ...channelDraft,
                                      clearBearerToken: e.target.checked,
                                      bearerToken: e.target.checked ? '' : channelDraft.bearerToken,
                                    })
                                  }
                                />
                                <span>{t('alerts.notify.clearBearerToken')}</span>
                              </label>
                            )}
                          </div>
                          <div className="field">
                            <label htmlFor="ch-wh-proxy">{t('alerts.notify.proxy')}</label>
                            <input
                              id="ch-wh-proxy"
                              type="text"
                              value={channelDraft.proxy}
                              onChange={(e) => setChannelDraft({ ...channelDraft, proxy: e.target.value })}
                              placeholder={t('alerts.notify.proxyPlaceholder')}
                            />
                          </div>
                        </div>
                        <div className="field">
                          <label htmlFor="ch-wh-headers">{t('alerts.notify.customHeaders')}</label>
                          <textarea
                            id="ch-wh-headers"
                            rows={2}
                            value={channelDraft.headersText}
                            onChange={(e) => setChannelDraft({ ...channelDraft, headersText: e.target.value })}
                            placeholder={t('alerts.notify.customHeadersPlaceholder')}
                          />
                        </div>
                        <div className="field">
                          <label htmlFor="ch-wh-template">{t('alerts.notify.payloadTemplate')}</label>
                          <div className="notify-presets">
                            <span className="field-hint">{t('alerts.notify.presetsLabel')}</span>
                            {WEBHOOK_PRESETS.map((preset) => (
                              <button
                                key={preset.key}
                                type="button"
                                className="btn btn-sm btn-ghost"
                                onClick={() =>
                                  setChannelDraft({ ...channelDraft, payloadTemplate: preset.template })
                                }
                              >
                                {t(`alerts.notify.${preset.key}`)}
                              </button>
                            ))}
                          </div>
                          <textarea
                            id="ch-wh-template"
                            rows={4}
                            value={channelDraft.payloadTemplate}
                            onChange={(e) => setChannelDraft({ ...channelDraft, payloadTemplate: e.target.value })}
                          />
                          <p className="field-hint">{t('alerts.notify.payloadTemplateHint')}</p>
                        </div>
                      </>
                    )}

                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={channelDraft.enabled}
                        onChange={(e) => setChannelDraft({ ...channelDraft, enabled: e.target.checked })}
                      />
                      <span>{t('alerts.notify.channelEnabled')}</span>
                    </label>

                    {channelError && <p className="field-error">{channelError}</p>}

                    <div className="toolbar">
                      <button
                        type="submit"
                        className="btn btn-primary"
                        disabled={saveChannelMutation.isPending}
                      >
                        {t('common.save')}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          setChannelDraft(null)
                          setChannelError(null)
                        }}
                      >
                        {t('common.cancel')}
                      </button>
                    </div>
                  </form>
                </Card>
              )}

              {!channelDraft && channels.length === 0 && (
                <div className="empty-state">
                  <span className="empty-state-icon">
                    <Icon name="bell" size={18} />
                  </span>
                  <span className="empty-state-title">{t('alerts.notify.noChannels')}</span>
                  <p className="empty-state-hint">{t('alerts.notify.noChannelsHint')}</p>
                </div>
              )}

              {channels.length > 0 && (
                <div className="notify-list">
                  {channels.map((ch) => {
                    const summary =
                      ch.kind === 'telegram'
                        ? `Chat: ${String(ch.config.chat_id ?? '')}`
                        : String(ch.config.url ?? '')
                    return (
                      <div className="notify-item" key={ch.id}>
                        <div className="notify-item-main">
                          <div className="notify-item-head">
                            <strong>{ch.name}</strong>
                            <span className="badge badge-neutral">
                              {ch.kind === 'telegram'
                                ? t('alerts.notify.kindTelegram')
                                : t('alerts.notify.kindWebhook')}
                            </span>
                            <span className={`badge ${ch.enabled ? 'badge-success' : 'badge-neutral'}`}>
                              {ch.enabled ? t('alerts.notify.channelEnabled') : t('common.none')}
                            </span>
                          </div>
                          <span className="notify-item-meta" title={summary}>
                            {summary}
                          </span>
                        </div>
                        <div className="notify-item-actions">
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={testingChannelId === ch.id}
                            onClick={() => void handleTestChannel(ch)}
                          >
                            <Icon name="send" size={13} />
                            {t('alerts.notify.testSend')}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost btn-icon"
                            title={ch.enabled ? t('alerts.notify.channelEnabled') : t('common.none')}
                            aria-label={ch.enabled ? t('alerts.notify.channelEnabled') : t('common.none')}
                            onClick={() => toggleChannelMutation.mutate(ch)}
                          >
                            <Icon name={ch.enabled ? 'bell' : 'bell-off'} size={14} />
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost btn-icon"
                            title={t('alerts.edit')}
                            aria-label={t('alerts.edit')}
                            onClick={() => {
                              setChannelError(null)
                              setChannelDraft(draftFromChannel(ch))
                            }}
                          >
                            <Icon name="pencil" size={14} />
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-danger btn-icon"
                            title={t('common.delete')}
                            aria-label={t('common.delete')}
                            onClick={() => setConfirmDelete(ch)}
                          >
                            <Icon name="trash" size={14} />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {tab === 'history' && (
            <div className="notify-section">
              <div className="toolbar">
                <div className="spacer" />
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={deliveriesFetching}
                  onClick={() => void refetchDeliveries()}
                >
                  <Icon name="refresh" size={13} />
                  {t('alerts.notify.refreshHistory')}
                </button>
              </div>

              {deliveries.length === 0 ? (
                <div className="empty-state">
                  <span className="empty-state-icon">
                    <Icon name="clock" size={18} />
                  </span>
                  <span className="empty-state-title">{t('alerts.notify.noDeliveries')}</span>
                  <p className="empty-state-hint">{t('alerts.notify.noDeliveriesHint')}</p>
                </div>
              ) : (
                <div className="notify-list">
                  {deliveries.map((d) => (
                    <div className="notify-delivery" key={d.id}>
                      <div className="notify-item-head">
                        <span className={`badge ${deliveryStatusVariant(d.status)}`}>
                          {t(`alerts.notify.deliveryStatus.${d.status}`, { defaultValue: d.status })}
                        </span>
                        <span className="badge badge-neutral">
                          {t(`alerts.notify.trigger.${d.trigger}`, { defaultValue: d.trigger })}
                        </span>
                        <span className="notify-item-meta">{formatEpoch(d.created_at)}</span>
                        {d.scheduled_slot && <span className="notify-slot">{d.scheduled_slot}</span>}
                      </div>
                      {d.summary && <div className="notify-delivery-summary">{d.summary}</div>}
                      <div className="notify-delivery-meta">
                        {d.monitor_count > 0 && (
                          <span>{t('alerts.notify.monitorsChecked', { count: d.monitor_count })}</span>
                        )}
                        {d.symbols_updated.length > 0 && (
                          <span>{t('alerts.notify.updatedCount', { count: d.symbols_updated.length })}</span>
                        )}
                      </div>
                      {d.data_warnings.length > 0 && (
                        <div className="hint-banner warning notify-warn-compact">
                          {d.data_warnings.join(' · ')}
                        </div>
                      )}
                      {d.error && <p className="field-error">{d.error}</p>}
                      {d.results.length > 0 && (
                        <div className="notify-result-list">
                          {d.results.map((r, i) => (
                            <span
                              key={`${r.channel_id}-${i}`}
                              className={`badge ${r.ok ? 'badge-success' : 'badge-danger'}`}
                              title={r.detail}
                            >
                              {r.channel_name}: {r.detail || (r.ok ? 'OK' : 'Error')}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmDelete !== null}
        title={t('alerts.notify.deleteChannelTitle')}
        body={t('alerts.notify.deleteChannelConfirm', { name: confirmDelete?.name ?? '' })}
        confirmLabel={t('common.delete')}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) deleteChannelMutation.mutate(confirmDelete.id)
        }}
      />
    </>
  )
}
