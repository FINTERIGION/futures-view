"""Symbol-level download coordinator shared between manual data updates
(``web.routers.data``) and scheduled alert dispatches (``web.alert_service``).

Separates two concerns to prevent thread-pool deadlocks:
- ``_inflight`` (in ``web.routers.data``) tracks symbols belonging to a queued
  or running manual ``POST /api/data/update`` so a duplicate manual click fails
  fast with HTTP 409.
- ``_writing`` (here) tracks symbols currently executing ``DataUpdate.update``
  inside a worker thread, acquired per symbol only while actually writing disk
  files. That ensures a queued manual job waiting for a pool slot can never
  deadlock a running ``alert_dispatch`` worker.
"""

from __future__ import annotations

import contextlib
import threading
import time
from typing import Optional

_writing: set = set()
_writing_cond = threading.Condition()


@contextlib.contextmanager
def acquire_symbol(
    symbol: str,
    *,
    cancel_event: Optional[threading.Event] = None,
    timeout: float = 300.0,
):
    """Wait until no worker is currently writing ``symbol``'s files, then claim it."""
    deadline = time.monotonic() + max(0.0, timeout)
    with _writing_cond:
        while symbol in _writing:
            if cancel_event is not None and cancel_event.is_set():
                raise RuntimeError(f'Cancelled while waiting for {symbol} update')
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(
                    f'Timed out waiting for another {symbol} data update to finish',
                )
            _writing_cond.wait(timeout=min(0.5, remaining))
        _writing.add(symbol)

    try:
        yield
    finally:
        with _writing_cond:
            _writing.discard(symbol)
            _writing_cond.notify_all()
