"""Run-history index: a small SQLite table, one row per backtest
run. Equity curves and trade logs are deliberately NOT stored here --
they go to ``results/web/{run_id}.json`` (see ``web.config.WEB_RESULTS_DIR``)
so the index stays a few KB per row and the history list is a plain
table scan, not a JSON blob scan.

``metrics_json`` is stored via a plain ``json.dumps``/``json.loads`` round
trip, deliberately *not* run through ``web.serialize.jsonable``: a handful of
``compute_metrics`` fields (``calmar_ratio``, ``profit_factor``,
``profit_loss_ratio``) can legitimately be ``float('inf')``, and Python's
``json`` module round-trips a bare ``Infinity`` token fine between two
``json.dumps``/``json.loads`` calls even though it is not valid JSON to send
to a browser. Nulling it out here, before the API layer's
``annotate_inf_metrics`` ever sees it, would permanently erase which fields
were infinite. Everything that does reach the browser goes through
``jsonable``/``annotate_inf_metrics`` in the router layer instead.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import sqlite3
import tempfile
import threading
import time
import uuid
from typing import Iterable, List, Optional

from web.config import ALERT_DELIVERY_RETENTION, DB_PATH, RUN_RETENTION, WEB_RESULTS_DIR
from web.serialize import jsonable

logger = logging.getLogger('futuresview.web')

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    created_at REAL NOT NULL,
    strategy TEXT,
    symbols TEXT,
    start TEXT,
    end TEXT,
    cash REAL,
    slippage REAL,
    params_json TEXT,
    status TEXT NOT NULL,
    metrics_json TEXT,
    artifact_path TEXT,
    error TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_kind ON runs(kind);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS alert_monitors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    strategy TEXT NOT NULL,
    symbols_json TEXT NOT NULL,
    params_json TEXT NOT NULL DEFAULT '{}',
    notify_enabled INTEGER NOT NULL DEFAULT 1,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    last_snapshot_json TEXT,
    last_checked_at REAL,
    last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_alert_monitors_created_at ON alert_monitors(created_at DESC);
CREATE TABLE IF NOT EXISTS notify_channels (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    config_json TEXT NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notify_channels_created_at ON notify_channels(created_at DESC);
CREATE TABLE IF NOT EXISTS alert_deliveries (
    id TEXT PRIMARY KEY,
    trigger TEXT NOT NULL,
    scheduled_slot TEXT,
    created_at REAL NOT NULL,
    finished_at REAL,
    status TEXT NOT NULL,
    monitor_count INTEGER NOT NULL DEFAULT 0,
    symbols_updated_json TEXT NOT NULL DEFAULT '[]',
    data_warnings_json TEXT NOT NULL DEFAULT '[]',
    results_json TEXT NOT NULL DEFAULT '[]',
    summary TEXT,
    error TEXT
);
CREATE INDEX IF NOT EXISTS idx_alert_deliveries_created_at ON alert_deliveries(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_deliveries_slot
    ON alert_deliveries(scheduled_slot) WHERE scheduled_slot IS NOT NULL;
"""

# Serialises every use of the shared connection, reads included. Python's
# sqlite3 statement cache is not safe when two threads call execute() on one
# connection; that race surfaces as InterfaceError ("bad parameter or other
# API misuse"). Deliberately NOT reentrant, and deliberately not the lock
# used to build the connection: `create_run`/`finish_run` call `_get_conn`
# while already holding this one.
_lock = threading.Lock()
_conn_lock = threading.Lock()
_adopt_orphans_on_connect = True


def set_adopt_orphans_on_connect(enabled: bool) -> None:
    """Toggle orphan-row adoption when opening the SQLite connection.

    One-shot CLI commands (``python main.py alert``) may run alongside a live
    web server sharing ``results/webpanel.db``; disabling adoption prevents
    them from marking the web server's active in-flight jobs as interrupted.
    """
    global _adopt_orphans_on_connect
    _adopt_orphans_on_connect = bool(enabled)


def _connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    existed = os.path.exists(DB_PATH)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    if not existed and os.name == 'posix':
        try:
            os.chmod(DB_PATH, 0o600)
        except OSError:
            pass
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.executescript(_SCHEMA)
    if _adopt_orphans_on_connect:
        _adopt_orphaned_runs(conn)
    return conn


def adopt_orphaned_runs() -> None:
    """Explicitly mark any leftover ``running`` rows as ``interrupted``."""
    with _lock:
        _adopt_orphaned_runs(_get_conn())


def close() -> None:
    """Close the shared SQLite connection cleanly (used on server shutdown)."""
    global _conn
    with _lock, _conn_lock:
        if _conn is not None:
            try:
                _conn.close()
            finally:
                _conn = None


@contextlib.contextmanager
def _write_tx():
    """Acquire ``_lock``, yield the connection, commit on success, rollback on error."""
    with _lock:
        conn = _get_conn()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise


def _adopt_orphaned_runs(conn: sqlite3.Connection) -> None:
    """Close out rows left ``running`` by a process that is no longer here.

    The job registry behind those rows is an in-memory dict in
    ``web.jobs`` -- it does not survive a restart, so nothing is left that
    could ever call ``finish_run`` on them. They were also the one status
    ``_prune_locked`` deliberately never deletes, so a server killed
    mid-backtest left a row that was both permanently ``running`` and
    permanently unprunable, and each one took a slot in the newest-N window
    that keeps real history alive.

    Safe to do at connect time precisely because of that in-memory registry:
    any row still ``running`` when this process first opens the index belongs
    to a previous one. The panel is single-process by design (see
    ``web/config.py``); two servers sharing one database would need a
    heartbeat rather than this.
    """
    cur = conn.execute(
        "UPDATE runs SET status='interrupted', error=? WHERE status='running'",
        ('The server exited while this run was still in flight; '
         'its result was never written.',),
    )
    cur_deliveries = conn.execute(
        "UPDATE alert_deliveries SET status='interrupted', finished_at=?, error=? "
        "WHERE status='running'",
        (
            time.time(),
            'The server exited while this alert dispatch was still in flight.',
        ),
    )
    conn.commit()
    if cur.rowcount:
        logger.warning(
            '%d run(s) were left in flight by a previous server process and have been '
            'marked interrupted.', cur.rowcount,
        )
    if cur_deliveries.rowcount:
        logger.warning(
            '%d alert delivery(ies) were left in flight by a previous server process '
            'and have been marked interrupted.', cur_deliveries.rowcount,
        )


_conn: Optional[sqlite3.Connection] = None


def _get_conn() -> sqlite3.Connection:
    """Build the shared connection once, under its own lock.

    Unguarded, two threads arriving together each opened one and the loser's
    was dropped on the floor still holding a WAL read lock. The lock has to be
    ``_conn_lock`` rather than ``_lock``: the write helpers call this while
    already inside ``with _lock``, so reusing that non-reentrant lock here
    deadlocks the first write of the process.
    """
    global _conn
    if _conn is None:
        with _conn_lock:
            if _conn is None:
                _conn = _connect()
    return _conn


def _artifact_file(stored: Optional[str]) -> Optional[str]:
    """Where a row's artifact lives, from what its ``artifact_path`` holds.

    The column holds the file's *name*, resolved against ``WEB_RESULTS_DIR``
    as it is now. Rows written before that held an absolute path, and moving
    or renaming the project directory left every one of them pointing at
    nothing: the history still listed the runs, but opened each with no
    equity curve or trades, and neither pruning nor Delete could find the file
    to remove it. Only the basename of such a path is used, so old rows
    follow the directory too.
    """
    if not stored:
        return None
    return os.path.join(WEB_RESULTS_DIR, os.path.basename(stored.replace('\\', '/')))


def _row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d['symbols'] = json.loads(d['symbols']) if d.get('symbols') else []
    d['params'] = json.loads(d.pop('params_json')) if d.get('params_json') else {}
    d['metrics'] = json.loads(d.pop('metrics_json')) if d.get('metrics_json') else None
    return d


def _prune_locked(conn: sqlite3.Connection) -> None:
    """Drop the oldest runs past ``RUN_RETENTION``, artifact files and all.

    Caller must already hold ``_lock``. The newest ``RUN_RETENTION`` rows are
    kept whatever their status, and anything older is kept anyway while it is
    still ``running`` -- a long backtest can outlive a few hundred quick ones
    queued behind it, and deleting the row it is about to ``finish_run`` would
    make that update a silent no-op.

    Artifact files go first: a row deleted with its JSON left behind is an
    orphan nothing can ever find again, whereas a file deleted with its row
    left behind is what ``get_artifact`` already handles (it returns ``None``
    for a missing path).
    """
    stale = conn.execute(
        "SELECT id, artifact_path FROM runs "
        "WHERE status != 'running' AND id NOT IN ("
        '    SELECT id FROM runs ORDER BY created_at DESC, rowid DESC LIMIT ?'
        ')',
        (RUN_RETENTION,),
    ).fetchall()
    if not stale:
        return
    for row in stale:
        path = _artifact_file(row['artifact_path'])
        if path and os.path.exists(path):
            try:
                os.remove(path)
            except OSError:
                # Not worth failing the run that triggered the prune over.
                pass
    conn.executemany('DELETE FROM runs WHERE id=?', [(row['id'],) for row in stale])


def create_run(
    *, kind: str, strategy: str = None, symbols: Iterable[str] = (),
    start: str = None, end: str = None, cash: float = None, slippage: float = None,
    params: dict = None,
) -> str:
    run_id = uuid.uuid4().hex[:12]
    with _write_tx() as conn:
        conn.execute(
            'INSERT INTO runs (id, kind, created_at, strategy, symbols, start, end, '
            'cash, slippage, params_json, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            (
                run_id, kind, time.time(), strategy, json.dumps(list(symbols)),
                start, end, cash, slippage, json.dumps(params or {}), 'running',
            ),
        )
        # On insert, so the history is bounded at the one point it can grow.
        _prune_locked(conn)
    return run_id


def finish_run(
    run_id: str, *, status: str, metrics: dict = None,
    artifact: dict = None, error: str = None,
) -> None:
    """``artifact`` (equity records, trade logs, per-symbol price+signal
    data -- whatever the run type produces) is written atomically to
    ``results/web/{run_id}.json`` rather than into the row itself.
    """
    artifact_name = None
    if artifact is not None:
        os.makedirs(WEB_RESULTS_DIR, exist_ok=True)
        artifact_name = f'{run_id}.json'
        target = _artifact_file(artifact_name)
        fd, tmp_path = tempfile.mkstemp(dir=WEB_RESULTS_DIR, prefix=f'.{run_id}.', suffix='.json.tmp')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump(jsonable(artifact), f)
            os.replace(tmp_path, target)
        except Exception:
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
            raise

    with _write_tx() as conn:
        conn.execute(
            'UPDATE runs SET status=?, metrics_json=?, artifact_path=?, error=? WHERE id=?',
            (status, json.dumps(metrics) if metrics is not None else None, artifact_name, error, run_id),
        )


def get_run(run_id: str) -> Optional[dict]:
    with _lock:
        conn = _get_conn()
        row = conn.execute('SELECT * FROM runs WHERE id=?', (run_id,)).fetchone()
        if row is None:
            return None
        return _row_to_dict(row)


def get_artifact(run_id: str) -> Optional[dict]:
    row = get_run(run_id)
    if row is None or not row.get('artifact_path'):
        return None
    path = _artifact_file(row['artifact_path'])
    if not path:
        return None
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning('Artifact %s for run %s could not be read: %s', path, run_id, exc)
        return None


def list_runs(*, kind: str = None, limit: int = 100) -> List[dict]:
    with _lock:
        conn = _get_conn()
        if kind:
            rows = conn.execute(
                'SELECT * FROM runs WHERE kind=? ORDER BY created_at DESC LIMIT ?', (kind, limit),
            ).fetchall()
        else:
            rows = conn.execute('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?', (limit,)).fetchall()
        return [_row_to_dict(r) for r in rows]


class RunInFlight(Exception):
    """``delete_run`` was asked for a run that is still ``running``."""


def delete_run(run_id: str) -> bool:
    """Delete a finished run and its artifact; ``False`` if there is no such run."""
    with _write_tx() as conn:
        row = conn.execute('SELECT status, artifact_path FROM runs WHERE id=?', (run_id,)).fetchone()
        if row is None:
            return False
        if row['status'] == 'running':
            raise RunInFlight(
                f'Run {run_id!r} is still running; wait for it to finish (or cancel its job) '
                f'before deleting it.'
            )
        path = _artifact_file(row['artifact_path'])
        if path:
            try:
                os.remove(path)
            except FileNotFoundError:
                pass
        conn.execute('DELETE FROM runs WHERE id=?', (run_id,))
    return True


# ---------------------------------------------------------------------
# Panel settings and login sessions
# ---------------------------------------------------------------------
# The same file as the run index, not a second database: the panel is one
# process and one install, and the web-access password has to survive a
# restart the same way history does. ``web.auth`` owns the hashing and the
# cookie; these helpers are the rows.

def get_setting(key: str) -> Optional[str]:
    with _lock:
        row = _get_conn().execute(
            'SELECT value FROM settings WHERE key=?', (key,),
        ).fetchone()
    return None if row is None else row['value']


def set_setting(key: str, value: Optional[str]) -> None:
    """Write ``value``, or delete the key when ``value`` is ``None``."""
    with _write_tx() as conn:
        if value is None:
            conn.execute('DELETE FROM settings WHERE key=?', (key,))
        else:
            conn.execute(
                'INSERT INTO settings (key, value) VALUES (?, ?) '
                'ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                (key, value),
            )


def set_setting_and_clear_sessions(key: str, value: Optional[str]) -> None:
    """Atomically update a setting (e.g. password hash) and drop all sessions."""
    with _write_tx() as conn:
        if value is None:
            conn.execute('DELETE FROM settings WHERE key=?', (key,))
        else:
            conn.execute(
                'INSERT INTO settings (key, value) VALUES (?, ?) '
                'ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                (key, value),
            )
        conn.execute('DELETE FROM sessions')


def check_auth_state(password_key: str, token_hash: Optional[str]) -> tuple:
    """Return ``(password_set, session_expires_at)`` in a single lock acquisition."""
    with _lock:
        conn = _get_conn()
        pw = conn.execute('SELECT value FROM settings WHERE key=?', (password_key,)).fetchone()
        if pw is None or not pw['value']:
            return False, None
        if not token_hash:
            return True, None
        sess = conn.execute(
            'SELECT expires_at FROM sessions WHERE token_hash=?', (token_hash,),
        ).fetchone()
        return True, (None if sess is None else float(sess['expires_at']))


def put_session(token_hash: str, created_at: float, expires_at: float) -> None:
    """Record a login session and drop any that have already expired."""
    with _write_tx() as conn:
        conn.execute('DELETE FROM sessions WHERE expires_at < ?', (created_at,))
        conn.execute(
            'INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)',
            (token_hash, created_at, expires_at),
        )


def session_expires_at(token_hash: str) -> Optional[float]:
    with _lock:
        row = _get_conn().execute(
            'SELECT expires_at FROM sessions WHERE token_hash=?', (token_hash,),
        ).fetchone()
    if row is None:
        return None
    return float(row['expires_at'])


def delete_session(token_hash: str) -> None:
    with _write_tx() as conn:
        conn.execute('DELETE FROM sessions WHERE token_hash=?', (token_hash,))


def delete_all_sessions() -> None:
    with _write_tx() as conn:
        conn.execute('DELETE FROM sessions')


# ---------------------------------------------------------------------
# Alert monitors, notification channels, and delivery logs
# ---------------------------------------------------------------------

def _monitor_to_dict(row: sqlite3.Row) -> dict:
    return {
        'id': row['id'],
        'name': row['name'] or '',
        'strategy': row['strategy'],
        'symbols': json.loads(row['symbols_json']) if row['symbols_json'] else [],
        'params': json.loads(row['params_json']) if row['params_json'] else {},
        'notify_enabled': bool(row['notify_enabled']),
        'created_at': float(row['created_at']),
        'updated_at': float(row['updated_at']),
        'last_snapshot': json.loads(row['last_snapshot_json']) if row['last_snapshot_json'] else None,
        'last_checked_at': float(row['last_checked_at']) if row['last_checked_at'] is not None else None,
        'last_error': row['last_error'],
    }


def list_alert_monitors(*, notify_only: bool = False) -> List[dict]:
    with _lock:
        conn = _get_conn()
        if notify_only:
            rows = conn.execute(
                'SELECT * FROM alert_monitors WHERE notify_enabled=1 ORDER BY created_at DESC',
            ).fetchall()
        else:
            rows = conn.execute(
                'SELECT * FROM alert_monitors ORDER BY created_at DESC',
            ).fetchall()
        return [_monitor_to_dict(r) for r in rows]


def get_alert_monitor(monitor_id: str) -> Optional[dict]:
    with _lock:
        row = _get_conn().execute(
            'SELECT * FROM alert_monitors WHERE id=?', (monitor_id,),
        ).fetchone()
    return None if row is None else _monitor_to_dict(row)


def create_alert_monitor(
    *,
    strategy: str,
    symbols: Iterable[str],
    params: dict = None,
    name: str = '',
    notify_enabled: bool = True,
    monitor_id: Optional[str] = None,
    created_at: Optional[float] = None,
) -> dict:
    now = time.time()
    mid = (monitor_id or '').strip() or uuid.uuid4().hex[:12]
    ts_created = float(created_at) if created_at is not None else now
    with _write_tx() as conn:
        conn.execute(
            'INSERT INTO alert_monitors '
            '(id, name, strategy, symbols_json, params_json, notify_enabled, created_at, updated_at) '
            'VALUES (?,?,?,?,?,?,?,?)',
            (
                mid,
                (name or '').strip(),
                strategy,
                json.dumps(list(symbols)),
                json.dumps(jsonable(params or {})),
                1 if notify_enabled else 0,
                ts_created,
                now,
            ),
        )
        row = conn.execute('SELECT * FROM alert_monitors WHERE id=?', (mid,)).fetchone()
    return _monitor_to_dict(row)


def update_alert_monitor(
    monitor_id: str,
    *,
    strategy: str,
    symbols: Iterable[str],
    params: dict,
    name: str = '',
    notify_enabled: bool = True,
    clear_snapshot: bool = False,
) -> Optional[dict]:
    now = time.time()
    with _write_tx() as conn:
        existing = conn.execute(
            'SELECT id FROM alert_monitors WHERE id=?', (monitor_id,),
        ).fetchone()
        if existing is None:
            return None
        if clear_snapshot:
            conn.execute(
                'UPDATE alert_monitors SET name=?, strategy=?, symbols_json=?, params_json=?, '
                'notify_enabled=?, updated_at=?, last_snapshot_json=NULL, '
                'last_checked_at=NULL, last_error=NULL WHERE id=?',
                (
                    (name or '').strip(),
                    strategy,
                    json.dumps(list(symbols)),
                    json.dumps(jsonable(params or {})),
                    1 if notify_enabled else 0,
                    now,
                    monitor_id,
                ),
            )
        else:
            conn.execute(
                'UPDATE alert_monitors SET name=?, strategy=?, symbols_json=?, params_json=?, '
                'notify_enabled=?, updated_at=? WHERE id=?',
                (
                    (name or '').strip(),
                    strategy,
                    json.dumps(list(symbols)),
                    json.dumps(jsonable(params or {})),
                    1 if notify_enabled else 0,
                    now,
                    monitor_id,
                ),
            )
        row = conn.execute('SELECT * FROM alert_monitors WHERE id=?', (monitor_id,)).fetchone()
    return _monitor_to_dict(row)


def record_alert_monitor_result(
    monitor_id: str,
    *,
    snapshot: Optional[dict] = None,
    error: Optional[str] = None,
    checked_at: Optional[float] = None,
) -> None:
    ts = float(checked_at) if checked_at is not None else time.time()
    with _write_tx() as conn:
        if snapshot is not None:
            conn.execute(
                'UPDATE alert_monitors SET last_snapshot_json=?, last_checked_at=?, last_error=NULL '
                'WHERE id=?',
                (json.dumps(jsonable(snapshot)), ts, monitor_id),
            )
        else:
            conn.execute(
                'UPDATE alert_monitors SET last_checked_at=?, last_error=? WHERE id=?',
                (ts, error, monitor_id),
            )


def delete_alert_monitor(monitor_id: str) -> bool:
    with _write_tx() as conn:
        cur = conn.execute('DELETE FROM alert_monitors WHERE id=?', (monitor_id,))
        return cur.rowcount > 0


def _channel_to_dict(row: sqlite3.Row) -> dict:
    return {
        'id': row['id'],
        'kind': row['kind'],
        'name': row['name'],
        'enabled': bool(row['enabled']),
        'config': json.loads(row['config_json']) if row['config_json'] else {},
        'created_at': float(row['created_at']),
        'updated_at': float(row['updated_at']),
    }


def list_notify_channels(*, enabled_only: bool = False) -> List[dict]:
    with _lock:
        conn = _get_conn()
        if enabled_only:
            rows = conn.execute(
                'SELECT * FROM notify_channels WHERE enabled=1 ORDER BY created_at DESC',
            ).fetchall()
        else:
            rows = conn.execute(
                'SELECT * FROM notify_channels ORDER BY created_at DESC',
            ).fetchall()
        return [_channel_to_dict(r) for r in rows]


def get_notify_channel(channel_id: str) -> Optional[dict]:
    with _lock:
        row = _get_conn().execute(
            'SELECT * FROM notify_channels WHERE id=?', (channel_id,),
        ).fetchone()
    return None if row is None else _channel_to_dict(row)


def create_notify_channel(
    *, kind: str, name: str, config: dict, enabled: bool = True,
) -> dict:
    cid = uuid.uuid4().hex[:12]
    now = time.time()
    with _write_tx() as conn:
        conn.execute(
            'INSERT INTO notify_channels '
            '(id, kind, name, enabled, config_json, created_at, updated_at) '
            'VALUES (?,?,?,?,?,?,?)',
            (
                cid,
                kind,
                name.strip(),
                1 if enabled else 0,
                json.dumps(jsonable(config)),
                now,
                now,
            ),
        )
        row = conn.execute('SELECT * FROM notify_channels WHERE id=?', (cid,)).fetchone()
    return _channel_to_dict(row)


def update_notify_channel(
    channel_id: str, *, kind: str, name: str, config: dict, enabled: bool,
) -> Optional[dict]:
    now = time.time()
    with _write_tx() as conn:
        existing = conn.execute(
            'SELECT id FROM notify_channels WHERE id=?', (channel_id,),
        ).fetchone()
        if existing is None:
            return None
        conn.execute(
            'UPDATE notify_channels SET kind=?, name=?, enabled=?, config_json=?, updated_at=? '
            'WHERE id=?',
            (
                kind,
                name.strip(),
                1 if enabled else 0,
                json.dumps(jsonable(config)),
                now,
                channel_id,
            ),
        )
        row = conn.execute('SELECT * FROM notify_channels WHERE id=?', (channel_id,)).fetchone()
    return _channel_to_dict(row)


def delete_notify_channel(channel_id: str) -> bool:
    with _write_tx() as conn:
        cur = conn.execute('DELETE FROM notify_channels WHERE id=?', (channel_id,))
        return cur.rowcount > 0


def _delivery_to_dict(row: sqlite3.Row) -> dict:
    return {
        'id': row['id'],
        'trigger': row['trigger'],
        'scheduled_slot': row['scheduled_slot'],
        'created_at': float(row['created_at']),
        'finished_at': float(row['finished_at']) if row['finished_at'] is not None else None,
        'status': row['status'],
        'monitor_count': int(row['monitor_count'] or 0),
        'symbols_updated': json.loads(row['symbols_updated_json']) if row['symbols_updated_json'] else [],
        'data_warnings': json.loads(row['data_warnings_json']) if row['data_warnings_json'] else [],
        'results': json.loads(row['results_json']) if row['results_json'] else [],
        'summary': row['summary'],
        'error': row['error'],
    }


def _prune_deliveries_locked(conn: sqlite3.Connection) -> None:
    conn.execute(
        "DELETE FROM alert_deliveries "
        "WHERE status != 'running' AND id NOT IN ("
        '    SELECT id FROM alert_deliveries ORDER BY created_at DESC, rowid DESC LIMIT ?'
        ')',
        (ALERT_DELIVERY_RETENTION,),
    )


def claim_alert_delivery(
    *, trigger: str, scheduled_slot: Optional[str] = None, monitor_count: int = 0,
) -> Optional[str]:
    """Create a delivery row; returns ``None`` if ``scheduled_slot`` is already claimed."""
    did = uuid.uuid4().hex[:12]
    now = time.time()
    with _lock:
        conn = _get_conn()
        try:
            conn.execute(
                'INSERT INTO alert_deliveries '
                '(id, trigger, scheduled_slot, created_at, status, monitor_count) '
                'VALUES (?,?,?,?,?,?)',
                (did, trigger, scheduled_slot, now, 'running', int(monitor_count)),
            )
            _prune_deliveries_locked(conn)
            conn.commit()
        except sqlite3.IntegrityError:
            conn.rollback()
            return None
    return did


def finish_alert_delivery(
    delivery_id: str,
    *,
    status: str,
    monitor_count: Optional[int] = None,
    symbols_updated: Iterable[str] = (),
    data_warnings: Iterable[str] = (),
    results: Iterable[dict] = (),
    summary: Optional[str] = None,
    error: Optional[str] = None,
) -> None:
    now = time.time()
    with _write_tx() as conn:
        if monitor_count is None:
            conn.execute(
                'UPDATE alert_deliveries SET finished_at=?, status=?, symbols_updated_json=?, '
                'data_warnings_json=?, results_json=?, summary=?, error=? WHERE id=?',
                (
                    now,
                    status,
                    json.dumps(list(symbols_updated)),
                    json.dumps(list(data_warnings)),
                    json.dumps(jsonable(list(results))),
                    summary,
                    error,
                    delivery_id,
                ),
            )
        else:
            conn.execute(
                'UPDATE alert_deliveries SET finished_at=?, status=?, monitor_count=?, '
                'symbols_updated_json=?, data_warnings_json=?, results_json=?, summary=?, '
                'error=? WHERE id=?',
                (
                    now,
                    status,
                    int(monitor_count),
                    json.dumps(list(symbols_updated)),
                    json.dumps(list(data_warnings)),
                    json.dumps(jsonable(list(results))),
                    summary,
                    error,
                    delivery_id,
                ),
            )


def list_alert_deliveries(limit: int = 30) -> List[dict]:
    with _lock:
        rows = _get_conn().execute(
            'SELECT * FROM alert_deliveries ORDER BY created_at DESC LIMIT ?',
            (max(1, min(int(limit), ALERT_DELIVERY_RETENTION)),),
        ).fetchall()
    return [_delivery_to_dict(r) for r in rows]
