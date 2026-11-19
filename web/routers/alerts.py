"""Signal monitors, last-bar alert previews, third-party notification channels,
global weekday reminder schedule, and delivery audit logs.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from core.alert import run_alert_snapshot
from core.params import validated_overrides
from datafeed.products import require_products
from strategies import load_registered_strategy

from web import store
from web.alert_service import (
    compute_next_run,
    get_schedule,
    mask_channel,
    resolve_timezone,
    save_schedule,
    submit_alert_dispatch,
)
from web.jobs import manager as job_manager
from web.marketcache import cache as market_cache
from web.notifiers import get_provider, list_providers
from web.scheduler import scheduler as alert_scheduler
from web.schemas import (
    AlertDispatchRequest,
    AlertMonitorImportRequest,
    AlertMonitorRequest,
    AlertPreviewRequest,
    AlertScheduleRequest,
    NotifyChannelRequest,
)
from web.serialize import jsonable

router = APIRouter(prefix='/api', tags=['alerts'])


def _validate_monitor_fields(strategy: str, symbols_in: list, params_in: dict):
    symbols = require_products(symbols_in)
    strategy_cls = load_registered_strategy(strategy)
    params = validated_overrides(strategy_cls, params_in)
    return symbols, strategy_cls, params


def _schedule_payload(schedule: dict) -> dict:
    tz = resolve_timezone(schedule['timezone'])
    now = datetime.now(timezone.utc)
    return {
        **schedule,
        'next_run_at': compute_next_run(schedule, now=now),
        'server_now': now.astimezone(tz).isoformat(timespec='seconds'),
        'scheduler_running': alert_scheduler.is_running,
    }


# ---------------------------------------------------------------------
# On-demand preview (preserves existing contract)
# ---------------------------------------------------------------------

@router.post('/alerts/preview')
def start_alert_preview(body: AlertPreviewRequest):
    try:
        symbols, strategy_cls, params = _validate_monitor_fields(
            body.strategy, body.symbols, body.params,
        )
    except (KeyError, ValueError) as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    monitor_id = body.monitor_id

    def run(job):
        job.message = 'Loading market data'
        try:
            # Both ends are filled by ``AlertPreviewRequest``'s validator.
            market = market_cache.get(symbols, body.start or '', body.end or '')
            job.progress = 0.3
            job.message = f'Previewing {strategy_cls.__name__}'
            snapshot = run_alert_snapshot(market, strategy_cls, params)
            if monitor_id:
                store.record_alert_monitor_result(monitor_id, snapshot=snapshot)
            job.progress = 1.0
            return jsonable(snapshot)
        except Exception as exc:
            if monitor_id:
                store.record_alert_monitor_result(monitor_id, error=str(exc))
            raise

    job = job_manager.submit('alert', run)
    return {'job_id': job.id}


# ---------------------------------------------------------------------
# Persistent signal monitors
# ---------------------------------------------------------------------

@router.get('/alerts/monitors')
def list_monitors():
    return jsonable(store.list_alert_monitors())


@router.post('/alerts/monitors/import')
def import_monitors(body: AlertMonitorImportRequest):
    """One-time migration helper for legacy browser localStorage entries."""
    imported = []
    skipped = 0
    for item in body.entries:
        if item.id and store.get_alert_monitor(item.id) is not None:
            skipped += 1
            continue
        if not item.symbols:
            skipped += 1
            continue
        try:
            symbols, _, params = _validate_monitor_fields(
                item.strategy, item.symbols, item.params,
            )
        except (KeyError, ValueError):
            skipped += 1
            continue
        created_at = item.created_at
        if created_at is not None and created_at > 1e12:
            # Browser Date.now() is milliseconds; store uses UNIX seconds.
            created_at = created_at / 1000.0
        row = store.create_alert_monitor(
            monitor_id=item.id,
            name=item.name,
            strategy=item.strategy,
            symbols=symbols,
            params=params,
            notify_enabled=item.notify_enabled,
            created_at=created_at,
        )
        imported.append(row)
    return jsonable({'imported': imported, 'skipped': skipped})


@router.post('/alerts/monitors', status_code=201)
def create_monitor(body: AlertMonitorRequest):
    try:
        symbols, _, params = _validate_monitor_fields(
            body.strategy, body.symbols, body.params,
        )
    except (KeyError, ValueError) as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    row = store.create_alert_monitor(
        name=body.name,
        strategy=body.strategy,
        symbols=symbols,
        params=params,
        notify_enabled=body.notify_enabled,
    )
    return jsonable(row)


@router.put('/alerts/monitors/{monitor_id}')
def update_monitor(monitor_id: str, body: AlertMonitorRequest):
    existing = store.get_alert_monitor(monitor_id)
    if existing is None:
        raise HTTPException(status_code=404, detail=f'Unknown alert monitor {monitor_id!r}')
    try:
        symbols, _, params = _validate_monitor_fields(
            body.strategy, body.symbols, body.params,
        )
    except (KeyError, ValueError) as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    changed = (
        existing['strategy'] != body.strategy
        or existing['symbols'] != symbols
        or existing['params'] != params
    )
    row = store.update_alert_monitor(
        monitor_id,
        name=body.name,
        strategy=body.strategy,
        symbols=symbols,
        params=params,
        notify_enabled=body.notify_enabled,
        clear_snapshot=changed,
    )
    return jsonable(row)


@router.delete('/alerts/monitors/{monitor_id}')
def delete_monitor(monitor_id: str):
    if not store.delete_alert_monitor(monitor_id):
        raise HTTPException(status_code=404, detail=f'Unknown alert monitor {monitor_id!r}')
    return {'deleted': monitor_id}


# ---------------------------------------------------------------------
# Third-party notification channels
# ---------------------------------------------------------------------

@router.get('/alerts/channels/providers')
def channel_providers():
    return list_providers()


@router.get('/alerts/channels')
def list_channels():
    return jsonable([mask_channel(c) for c in store.list_notify_channels()])


@router.post('/alerts/channels', status_code=201)
def create_channel(body: NotifyChannelRequest):
    try:
        provider = get_provider(body.kind)
        cleaned = provider.validate_config(body.config)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    channel = store.create_notify_channel(
        kind=provider.kind,
        name=body.name,
        config=cleaned,
        enabled=body.enabled,
    )
    return jsonable(mask_channel(channel))


@router.put('/alerts/channels/{channel_id}')
def update_channel(channel_id: str, body: NotifyChannelRequest):
    existing = store.get_notify_channel(channel_id)
    if existing is None:
        raise HTTPException(status_code=404, detail=f'Unknown notification channel {channel_id!r}')
    try:
        provider = get_provider(body.kind)
        prior_cfg = existing['config'] if existing['kind'] == provider.kind else None
        cleaned = provider.validate_config(body.config, existing=prior_cfg)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    channel = store.update_notify_channel(
        channel_id,
        kind=provider.kind,
        name=body.name,
        config=cleaned,
        enabled=body.enabled,
    )
    return jsonable(mask_channel(channel))


@router.delete('/alerts/channels/{channel_id}')
def delete_channel(channel_id: str):
    if not store.delete_notify_channel(channel_id):
        raise HTTPException(status_code=404, detail=f'Unknown notification channel {channel_id!r}')
    return {'deleted': channel_id}


@router.post('/alerts/channels/{channel_id}/test')
def test_channel(channel_id: str):
    channel = store.get_notify_channel(channel_id)
    if channel is None:
        raise HTTPException(status_code=404, detail=f'Unknown notification channel {channel_id!r}')

    schedule = get_schedule()
    language = schedule['language']
    delivery_id = store.claim_alert_delivery(trigger='test', monitor_count=0)
    try:
        provider = get_provider(channel['kind'])
        result = provider.send_test(
            channel['id'], channel['name'], channel['config'], language=language,
        )
    except Exception as exc:  # noqa: BLE001
        if delivery_id is not None:
            store.finish_alert_delivery(
                delivery_id,
                status='error',
                error=str(exc),
                summary=f'Test failed for {channel["name"]}: {exc}',
            )
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    result_dict = result.to_dict()
    if delivery_id is not None:
        summary = (
            f'测试推送 {channel["name"]}：{"成功" if result.ok else "失败"}'
            if language == 'zh' else
            f'Test {channel["name"]}: {"ok" if result.ok else "failed"}'
        )
        store.finish_alert_delivery(
            delivery_id,
            status='ok' if result.ok else 'error',
            results=[result_dict],
            summary=summary,
            error=None if result.ok else result.detail,
        )
    return jsonable(result_dict)


# ---------------------------------------------------------------------
# Global schedule, manual dispatch, and delivery history
# ---------------------------------------------------------------------

@router.get('/alerts/schedule')
def read_schedule():
    return jsonable(_schedule_payload(get_schedule()))


@router.put('/alerts/schedule')
def write_schedule(body: AlertScheduleRequest):
    try:
        saved = save_schedule(body.model_dump())
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    alert_scheduler.notify_config_changed()
    return jsonable(_schedule_payload(saved))


@router.post('/alerts/dispatch')
def start_alert_dispatch(body: Optional[AlertDispatchRequest] = None):
    req = body or AlertDispatchRequest()
    job = submit_alert_dispatch(
        trigger='manual',
        update_data=req.update_data,
        monitor_ids=req.monitor_ids,
        channel_ids=req.channel_ids,
    )
    return {'job_id': job.id}


@router.get('/alerts/deliveries')
def list_deliveries(limit: int = Query(30, ge=1, le=200)):
    return jsonable(store.list_alert_deliveries(limit=limit))
