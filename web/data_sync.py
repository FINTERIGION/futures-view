"""Symbol-level download coordinator shared between manual data updates
(``web.routers.data``) and scheduled alert dispatches (``web.alert_service``).

Manual ``POST /api/data/update`` requests fail fast with 409 when a product is
already downloading. Scheduled alert dispatches wait cooperatively for an
in-flight download of the same product to finish before taking their turn, so
two writers never interleave ``{sym}.csv`` / ``{sym}_weighted.csv`` /
``{sym}.meta.json``.
"""

from __future__ import annotations

import contextlib
import threading
import time
from typing import Optional

from web.routers import data as _data_router


@contextlib.contextmanager
def acquire_symbol(
    symbol: str,
    *,
    cancel_event: Optional[threading.Event] = None,
    timeout: float = 300.0,
):
    """Wait until ``symbol`` is not being updated elsewhere, then claim it."""
    deadline = time.monotonic() + max(0.0, timeout)
    cond = _data_router._inflight_lock
    with cond:
        while symbol in _data_router._inflight:
            if cancel_event is not None and cancel_event.is_set():
                raise RuntimeError(f'Cancelled while waiting for {symbol} update')
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(
                    f'Timed out waiting for another {symbol} data update to finish',
                )
            cond.wait(timeout=min(0.5, remaining))
        _data_router._inflight.add(symbol)

    try:
        yield
    finally:
        with cond:
            _data_router._inflight.discard(symbol)
            cond.notify_all()
