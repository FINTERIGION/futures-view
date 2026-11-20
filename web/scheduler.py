"""Lightweight in-process weekday scheduler for daily alert dispatches.

Runs as a single daemon thread owned by FastAPI's lifespan. Slot deduplication
lives in SQLite (``alert_deliveries.scheduled_slot``), so a restart or reload
inside the grace window can never fire the same reminder twice.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, time as dt_time, timedelta, timezone
from typing import Callable, List, Optional

from web import store
from web.alert_service import (
    DEFAULT_SCHEDULE,
    get_schedule,
    resolve_timezone,
    submit_alert_dispatch,
)
from web.config import ALERT_SCHEDULER_GRACE_SECONDS, ALERT_SCHEDULER_POLL_SECONDS

logger = logging.getLogger('futuresview.web')


class AlertScheduler:
    def __init__(
        self,
        *,
        poll_seconds: float = ALERT_SCHEDULER_POLL_SECONDS,
        grace_seconds: float = ALERT_SCHEDULER_GRACE_SECONDS,
        now_fn: Optional[Callable[[], datetime]] = None,
        dispatch_fn: Callable[..., object] = submit_alert_dispatch,
    ):
        self._poll_seconds = float(poll_seconds)
        self._grace_seconds = float(grace_seconds)
        self._now_fn = now_fn or (lambda: datetime.now(timezone.utc))
        self._dispatch_fn = dispatch_fn
        self._stop_event = threading.Event()
        self._wake_event = threading.Event()
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None

    @property
    def is_running(self) -> bool:
        with self._lock:
            return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop_event.clear()
            self._wake_event.clear()
            self._thread = threading.Thread(
                target=self._loop, name='ftk-alert-scheduler', daemon=True,
            )
            self._thread.start()
            logger.info('Alert scheduler started (poll=%.1fs).', self._poll_seconds)

    def stop(self, timeout: float = 5.0) -> None:
        with self._lock:
            thread = self._thread
            self._stop_event.set()
            self._wake_event.set()
        if thread is not None and thread.is_alive():
            thread.join(timeout=timeout)
            logger.info('Alert scheduler stopped.')
        with self._lock:
            if self._thread is thread:
                self._thread = None

    def notify_config_changed(self) -> None:
        """Wake the loop promptly after schedule settings are edited."""
        self._wake_event.set()

    def tick(self, now: Optional[datetime] = None) -> List[str]:
        """Check current time against saved schedule and dispatch any due slot."""
        schedule = get_schedule()
        if not schedule.get('enabled') or not schedule.get('times'):
            return []

        tz_name = schedule['timezone']
        tz = resolve_timezone(tz_name)
        utc_now = (now or self._now_fn()).astimezone(timezone.utc)
        local_now = utc_now.astimezone(tz)
        weekdays_only = bool(schedule.get('weekdays_only', True))

        # Check today, plus yesterday when within the grace window of midnight
        # so late-night slots like 23:59 are never dropped after 00:00.
        today = local_now.date()
        candidate_dates = [today]
        midnight_utc = datetime.combine(today, dt_time(0, 0), tzinfo=tz).astimezone(timezone.utc)
        if (utc_now - midnight_utc).total_seconds() < self._grace_seconds:
            candidate_dates.insert(0, today - timedelta(days=1))

        fired: List[str] = []
        for slot_date in candidate_dates:
            if weekdays_only and slot_date.weekday() >= 5:
                continue
            for hhmm in schedule['times']:
                hour_s, min_s = hhmm.split(':', 1)
                slot_dt = datetime.combine(
                    slot_date, dt_time(int(hour_s), int(min_s)), tzinfo=tz,
                )
                # Subtract in UTC so PEP 495 DST fall-back transitions use true
                # elapsed seconds rather than ambiguous wall-clock arithmetic.
                delta = (utc_now - slot_dt.astimezone(timezone.utc)).total_seconds()
                if 0.0 <= delta < self._grace_seconds:
                    slot_key = (
                        f'{slot_date.isoformat()} {hhmm}'
                        if tz_name == DEFAULT_SCHEDULE['timezone']
                        else f'{slot_date.isoformat()} {hhmm} ({tz_name})'
                    )
                    delivery_id = store.claim_alert_delivery(
                        trigger='schedule', scheduled_slot=slot_key,
                    )
                    if delivery_id is None:
                        continue
                    logger.info('Alert scheduler firing slot %s (delivery=%s).', slot_key, delivery_id)
                    try:
                        self._dispatch_fn(
                            trigger='schedule',
                            scheduled_slot=slot_key,
                            delivery_id=delivery_id,
                        )
                    except Exception as exc:  # noqa: BLE001
                        logger.exception('Alert scheduler failed to dispatch slot %s', slot_key)
                        # Custom dispatch_fn may not have finalized the delivery row.
                        if self._dispatch_fn is not submit_alert_dispatch:
                            store.finish_alert_delivery(
                                delivery_id,
                                status='error',
                                error=str(exc),
                                summary=f'Failed to start scheduled dispatch: {exc}',
                            )
                        continue
                    fired.append(slot_key)
        return fired

    def _loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                self.tick()
            except Exception:  # noqa: BLE001 -- keep background thread alive
                logger.exception('Alert scheduler tick failed')
            self._wake_event.wait(timeout=self._poll_seconds)
            self._wake_event.clear()


scheduler = AlertScheduler()
