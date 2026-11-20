"""Alert scheduling configuration and end-to-end dispatch pipeline.

One shared pipeline serves all three entry points:
- Background weekday scheduler (``web.scheduler.AlertScheduler``)
- Manual "Update & send now" button in the WebUI (``POST /api/alerts/dispatch``)
- Optional CLI command (``python main.py alert``)
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, time as dt_time, timedelta, timezone
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from core.alert import run_alert_snapshot
from core.params import validated_overrides
from datafeed.data_update import DataUpdate
from datafeed.products import get_product, normalize_symbol, require_products
from strategies import load_registered_strategy

from web import store
from web.barscache import cache as bars_cache
from web.data_sync import acquire_symbol
from web.jobs import manager as job_manager
from web.marketcache import cache as market_cache
from web.notifiers import DeliveryResult, get_provider
from web.serialize import jsonable

logger = logging.getLogger('futuresview.web')

SCHEDULE_SETTING_KEY = 'alert_schedule'
ALERT_REPLAY_START = '2018-01-01'
MAX_SCHEDULE_TIMES = 6
_TIME_RE = re.compile(r'^([01]\d|2[0-3]):([0-5]\d)$')

DEFAULT_SCHEDULE: Dict[str, Any] = {
    'enabled': False,
    'times': ['15:30'],
    'timezone': 'Asia/Shanghai',
    'weekdays_only': True,
    'update_data': True,
    'language': 'zh',
}


# ---------------------------------------------------------------------
# Schedule config & timezone helpers
# ---------------------------------------------------------------------

def resolve_timezone(tz_name: str):
    """Resolve an IANA timezone name, with a fixed UTC+8 fallback for Asia/Shanghai
    when minimal containers omit system tzdata."""
    name = (tz_name or '').strip()
    if not name:
        raise ValueError('timezone is required')
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        if name == 'Asia/Shanghai':
            return timezone(timedelta(hours=8))
        if name == 'UTC':
            return timezone.utc
        raise ValueError(f'Unknown timezone {name!r}') from None


def validate_schedule(raw: dict) -> dict:
    if not isinstance(raw, dict):
        raise ValueError('schedule must be an object')

    enabled = bool(raw.get('enabled', False))
    weekdays_only = bool(raw.get('weekdays_only', True))
    update_data = bool(raw.get('update_data', True))

    language = str(raw.get('language') or 'zh').strip().lower()
    if language not in ('zh', 'en'):
        raise ValueError("language must be 'zh' or 'en'")

    tz_name = str(raw.get('timezone') or DEFAULT_SCHEDULE['timezone']).strip()
    resolve_timezone(tz_name)

    raw_times = raw.get('times')
    if raw_times is None:
        raw_times = list(DEFAULT_SCHEDULE['times'])
    if not isinstance(raw_times, list):
        raise ValueError('times must be a list of HH:MM strings')

    normalized: List[str] = []
    seen = set()
    for item in raw_times:
        text = str(item or '').strip()
        if not _TIME_RE.match(text):
            raise ValueError(f'Expected HH:MM (24-hour), got {item!r}')
        if text not in seen:
            seen.add(text)
            normalized.append(text)
    normalized.sort()

    if len(normalized) > MAX_SCHEDULE_TIMES:
        raise ValueError(f'At most {MAX_SCHEDULE_TIMES} reminder times are allowed')
    if enabled and not normalized:
        raise ValueError('Add at least one reminder time before enabling scheduled alerts')

    return {
        'enabled': enabled,
        'times': normalized,
        'timezone': tz_name,
        'weekdays_only': weekdays_only,
        'update_data': update_data,
        'language': language,
    }


def get_schedule() -> dict:
    raw = store.get_setting(SCHEDULE_SETTING_KEY)
    if not raw:
        return dict(DEFAULT_SCHEDULE, times=list(DEFAULT_SCHEDULE['times']))
    try:
        parsed = json.loads(raw)
        return validate_schedule({**DEFAULT_SCHEDULE, **parsed})
    except (ValueError, TypeError):
        logger.warning('Stored alert_schedule was unreadable; falling back to defaults.')
        return dict(DEFAULT_SCHEDULE, times=list(DEFAULT_SCHEDULE['times']))


def save_schedule(raw: dict) -> dict:
    cleaned = validate_schedule(raw)
    store.set_setting(SCHEDULE_SETTING_KEY, json.dumps(cleaned))
    return cleaned


def compute_next_run(schedule: dict, now: Optional[datetime] = None) -> Optional[str]:
    """Next scheduled timestamp in ISO-8601 (configured timezone), or ``None`` if disabled."""
    if not schedule.get('enabled') or not schedule.get('times'):
        return None
    tz = resolve_timezone(schedule.get('timezone', DEFAULT_SCHEDULE['timezone']))
    current = (now or datetime.now(timezone.utc)).astimezone(tz)
    weekdays_only = bool(schedule.get('weekdays_only', True))

    parsed_times: List[dt_time] = []
    for entry in schedule['times']:
        m = _TIME_RE.match(entry)
        if m:
            parsed_times.append(dt_time(int(m.group(1)), int(m.group(2))))
    if not parsed_times:
        return None

    for day_offset in range(0, 9):
        day = current.date() + timedelta(days=day_offset)
        if weekdays_only and day.weekday() >= 5:
            continue
        for t in parsed_times:
            candidate = datetime.combine(day, t, tzinfo=tz)
            if candidate > current:
                return candidate.isoformat(timespec='seconds')
    return None


def mask_channel(channel: dict) -> dict:
    provider = get_provider(channel['kind'])
    return {
        **channel,
        'config': provider.mask_config(channel.get('config') or {}),
    }


# ---------------------------------------------------------------------
# End-to-end dispatch pipeline
# ---------------------------------------------------------------------

def _dedup_symbols(monitors: List[dict], warnings: List[str]) -> List[str]:
    seen = set()
    ordered: List[str] = []
    for mon in monitors:
        for raw in mon.get('symbols') or []:
            try:
                sym = require_products([raw])[0]
            except (KeyError, ValueError) as exc:
                msg = f'Unknown product {raw!r} in monitor {mon.get("strategy")}: {exc}'
                if msg not in warnings:
                    warnings.append(msg)
                continue
            if sym not in seen:
                seen.add(sym)
                ordered.append(sym)
    return ordered


def _product_name_zh(symbol: str) -> str:
    try:
        return str(get_product(symbol).get('name_zh') or '')
    except KeyError:
        return ''


def _set_job_progress(job: Any, progress: float, message: str) -> None:
    if job is None:
        return
    job.progress = max(0.0, min(1.0, float(progress)))
    job.message = message
    job_manager.notify(job.id)


def run_alert_dispatch(
    *,
    trigger: str,
    scheduled_slot: Optional[str] = None,
    delivery_id: Optional[str] = None,
    update_data: Optional[bool] = None,
    monitor_ids: Optional[List[str]] = None,
    channel_ids: Optional[List[str]] = None,
    job: Any = None,
    now: Optional[datetime] = None,
) -> dict:
    """Update market data (optional), compute snapshots, and notify enabled channels."""
    schedule = get_schedule()
    language = schedule['language']
    tz = resolve_timezone(schedule['timezone'])
    local_now = (now or datetime.now(timezone.utc)).astimezone(tz)
    run_date = local_now.date().isoformat()
    run_time_label = local_now.strftime('%Y-%m-%d %H:%M')
    should_update = schedule['update_data'] if update_data is None else bool(update_data)

    if delivery_id is None:
        delivery_id = store.claim_alert_delivery(
            trigger=trigger,
            scheduled_slot=scheduled_slot,
            monitor_count=0,
        )
        if delivery_id is None:
            return {
                'delivery_id': None,
                'status': 'duplicate',
                'summary': f'Slot {scheduled_slot} already dispatched',
                'results': [],
            }

    try:
        all_monitors = store.list_alert_monitors(notify_only=(monitor_ids is None))
        if monitor_ids is not None:
            wanted = set(monitor_ids)
            monitors = [m for m in all_monitors if m['id'] in wanted]
        else:
            monitors = all_monitors

        all_channels = store.list_notify_channels(enabled_only=(channel_ids is None))
        if channel_ids is not None:
            wanted_ch = set(channel_ids)
            channels = [c for c in all_channels if c['id'] in wanted_ch]
        else:
            channels = all_channels

        if not monitors:
            summary = (
                '没有已启用推送的信号监控，已跳过本次推送'
                if language == 'zh' else 'Skipped: no enabled signal monitors'
            )
            store.finish_alert_delivery(
                delivery_id, status='skipped', monitor_count=0, summary=summary,
            )
            _set_job_progress(job, 1.0, summary)
            return {'delivery_id': delivery_id, 'status': 'skipped', 'summary': summary, 'results': []}

        if not channels:
            summary = (
                '没有已启用的第三方推送渠道，已跳过本次推送'
                if language == 'zh' else 'Skipped: no enabled notification channels'
            )
            store.finish_alert_delivery(
                delivery_id, status='skipped', monitor_count=len(monitors), summary=summary,
            )
            _set_job_progress(job, 1.0, summary)
            return {'delivery_id': delivery_id, 'status': 'skipped', 'summary': summary, 'results': []}

        data_warnings: List[str] = []
        symbols_to_update = _dedup_symbols(monitors, data_warnings)
        updated_symbols: List[str] = []
        stale_symbols: List[str] = []
        failed_symbols: Dict[str, str] = {}
        cancel_event = getattr(job, '_cancel_event', None)

        # 1. Incremental market data update (once across deduplicated symbols)
        if should_update and symbols_to_update:
            total_syms = len(symbols_to_update)
            touched_any = False
            try:
                for idx, sym in enumerate(symbols_to_update):
                    if job is not None and job.cancel_requested:
                        break
                    _set_job_progress(
                        job,
                        0.05 + 0.45 * (idx / max(total_syms, 1)),
                        f'Updating {sym} ({idx + 1}/{total_syms})',
                    )
                    try:
                        with acquire_symbol(sym, cancel_event=cancel_event):
                            touched_any = True
                            try:
                                updater = DataUpdate(normalize_symbol(sym))
                                updater.update(force=False, rebuild_only=False)
                                updated_symbols.append(sym)
                                if updater.stale_keys:
                                    stale_symbols.append(sym)
                                    data_warnings.append(
                                        f'{sym} 有 {len(updater.stale_keys)} 项历史缓存未能刷新，数据可能滞后'
                                        if language == 'zh' else
                                        f'{sym}: {len(updater.stale_keys)} cache unit(s) failed to refresh',
                                    )
                            finally:
                                # Invalidate before releasing the per-symbol write lock.
                                market_cache.invalidate()
                                bars_cache.invalidate()
                    except Exception as exc:  # noqa: BLE001 -- per-symbol isolation
                        logger.warning('Alert data update failed for %s: %s', sym, exc)
                        failed_symbols[sym] = str(exc)
                        data_warnings.append(
                            f'{sym} 数据更新失败：{exc}'
                            if language == 'zh' else f'{sym} data update failed: {exc}',
                        )
            finally:
                if touched_any:
                    market_cache.invalidate()
                    bars_cache.invalidate()

        if job is not None and job.cancel_requested:
            summary = '已取消推送任务' if language == 'zh' else 'Alert dispatch cancelled'
            store.finish_alert_delivery(
                delivery_id,
                status='cancelled',
                monitor_count=len(monitors),
                symbols_updated=updated_symbols,
                data_warnings=data_warnings,
                summary=summary,
            )
            return {'delivery_id': delivery_id, 'status': 'cancelled', 'summary': summary, 'results': []}

        # 2. Compute snapshots for each enabled monitor
        report_monitors: List[dict] = []
        total_mons = len(monitors)
        for idx, mon in enumerate(monitors):
            if job is not None and job.cancel_requested:
                break
            _set_job_progress(
                job,
                0.50 + 0.35 * (idx / max(total_mons, 1)),
                f'Checking {mon["strategy"]} ({idx + 1}/{total_mons})',
            )
            try:
                symbols = require_products(mon['symbols'])
                strategy_cls = load_registered_strategy(mon['strategy'])
                params = validated_overrides(strategy_cls, mon.get('params') or {})
                market = market_cache.get(symbols, ALERT_REPLAY_START, run_date)
                snapshot = run_alert_snapshot(market, strategy_cls, params)
                store.record_alert_monitor_result(mon['id'], snapshot=snapshot)
                enriched_rows = [
                    {**row, 'name_zh': _product_name_zh(row['symbol'])}
                    for row in snapshot.get('symbols') or []
                ]
                report_monitors.append({
                    'id': mon['id'],
                    'name': mon.get('name') or '',
                    'strategy': mon['strategy'],
                    'params': params,
                    'asof': snapshot.get('asof'),
                    'blown_up': bool(snapshot.get('blown_up')),
                    'error': None,
                    'symbols': enriched_rows,
                })
            except Exception as exc:  # noqa: BLE001 -- per-monitor isolation
                logger.warning('Alert snapshot failed for monitor %s (%s): %s', mon['id'], mon['strategy'], exc)
                store.record_alert_monitor_result(mon['id'], error=str(exc))
                report_monitors.append({
                    'id': mon['id'],
                    'name': mon.get('name') or '',
                    'strategy': mon['strategy'],
                    'params': mon.get('params') or {},
                    'asof': None,
                    'blown_up': False,
                    'error': str(exc),
                    'symbols': [],
                })

        if job is not None and job.cancel_requested:
            summary = '已取消推送任务' if language == 'zh' else 'Alert dispatch cancelled'
            store.finish_alert_delivery(
                delivery_id,
                status='cancelled',
                monitor_count=len(monitors),
                symbols_updated=updated_symbols,
                data_warnings=data_warnings,
                summary=summary,
            )
            return {'delivery_id': delivery_id, 'status': 'cancelled', 'summary': summary, 'results': []}

        # 3. Dispatch report to every enabled channel
        report = jsonable({
            'event': 'futuresview.alert_report',
            'trigger': trigger,
            'generated_at': local_now.isoformat(timespec='seconds'),
            'run_date': run_date,
            'run_time_label': run_time_label,
            'timezone': schedule['timezone'],
            'data_update': {
                'skipped': not should_update,
                'updated': updated_symbols,
                'stale': stale_symbols,
                'failed': failed_symbols,
            },
            'data_warnings': data_warnings,
            'monitors': report_monitors,
        })

        results: List[dict] = []
        total_ch = len(channels)
        for idx, ch in enumerate(channels):
            if job is not None and job.cancel_requested:
                break
            _set_job_progress(
                job,
                0.85 + 0.14 * (idx / max(total_ch, 1)),
                f'Sending to {ch["name"]} ({idx + 1}/{total_ch})',
            )
            try:
                provider = get_provider(ch['kind'])
                res = provider.send(
                    ch['id'], ch['name'], ch['config'], report, language=language,
                )
            except Exception as exc:  # noqa: BLE001 -- per-channel isolation
                logger.exception('Notification provider %s failed for %s', ch['kind'], ch['name'])
                res = DeliveryResult(
                    channel_id=ch['id'],
                    channel_name=ch['name'],
                    kind=ch['kind'],
                    ok=False,
                    detail=f'{type(exc).__name__}: {exc}',
                )
            results.append(res.to_dict())

        if job is not None and job.cancel_requested:
            summary = '已取消推送任务' if language == 'zh' else 'Alert dispatch cancelled'
            store.finish_alert_delivery(
                delivery_id,
                status='cancelled',
                monitor_count=len(monitors),
                symbols_updated=updated_symbols,
                data_warnings=data_warnings,
                results=results,
                summary=summary,
            )
            return {
                'delivery_id': delivery_id,
                'status': 'cancelled',
                'summary': summary,
                'results': results,
            }

        ok_count = sum(1 for r in results if r['ok'])
        if ok_count == len(results):
            status = 'ok'
        elif ok_count > 0:
            status = 'partial'
        else:
            status = 'error'

        summary = (
            f'检查 {len(monitors)} 条监控，推送成功 {ok_count}/{len(results)} 个渠道'
            if language == 'zh' else
            f'Checked {len(monitors)} monitor(s); delivered to {ok_count}/{len(results)} channel(s)'
        )
        store.finish_alert_delivery(
            delivery_id,
            status=status,
            monitor_count=len(monitors),
            symbols_updated=updated_symbols,
            data_warnings=data_warnings,
            results=results,
            summary=summary,
        )
        _set_job_progress(job, 1.0, summary)
        return {
            'delivery_id': delivery_id,
            'status': status,
            'summary': summary,
            'monitor_count': len(monitors),
            'symbols_updated': updated_symbols,
            'data_warnings': data_warnings,
            'results': results,
        }
    except Exception as exc:
        logger.exception('Alert dispatch %s failed unexpectedly', delivery_id)
        store.finish_alert_delivery(
            delivery_id,
            status='error',
            error=str(exc),
            summary=f'Dispatch failed: {exc}',
        )
        raise


def submit_alert_dispatch(
    *,
    trigger: str,
    scheduled_slot: Optional[str] = None,
    delivery_id: Optional[str] = None,
    update_data: Optional[bool] = None,
    monitor_ids: Optional[List[str]] = None,
    channel_ids: Optional[List[str]] = None,
):
    """Submit an alert dispatch onto ``web.jobs.manager`` so concurrency guards
    and SSE progress streaming apply uniformly."""
    def _run(job):
        return run_alert_dispatch(
            trigger=trigger,
            scheduled_slot=scheduled_slot,
            delivery_id=delivery_id,
            update_data=update_data,
            monitor_ids=monitor_ids,
            channel_ids=channel_ids,
            job=job,
        )

    try:
        return job_manager.submit('alert_dispatch', _run)
    except Exception as exc:
        if delivery_id is not None:
            store.finish_alert_delivery(
                delivery_id, status='error', error=str(exc), summary=f'Failed to submit job: {exc}',
            )
        raise
