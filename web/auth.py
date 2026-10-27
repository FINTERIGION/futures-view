"""Optional web-access password for the panel.

Unset, the API is as it always was: anyone who can reach the process can
drive it. That is the local-research default, and it is why ``main.py web``
binds to loopback.

Set (from the lock icon in the panel, or cleared again the same way), every
``/api`` route except the handful that have to stay public -- health, the
status probe the login screen reads, login itself, and logout -- needs a
session cookie this module issued. The SPA stays public so that screen can
load. Host-header and Origin checks in ``web.app`` still apply; this is the
layer that stops another *machine*, not another *page*.

The hash lives in the same SQLite file as run history (``web.store``), so a
restart does not drop the password. Session tokens are stored hashed: a copy
of the database is not a list of live cookies.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import threading
import time
from typing import Optional

from starlette.requests import Request
from starlette.responses import Response

from web import store

logger = logging.getLogger('futuresview.web')

PASSWORD_KEY = 'password_hash'
PASSWORD_MIN = 8
PASSWORD_MAX = 256

# scrypt parameters are part of the stored string, so a later bump does not
# invalidate existing hashes. n=2**14 is a fraction of a second on a laptop
# and is the cost of a guessed password.
SCRYPT_N = 2 ** 14
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 32

SESSION_TTL = 14 * 24 * 3600
COOKIE_NAME = 'fv_session'

LOGIN_WINDOW_S = 300
LOGIN_MAX_FAILURES = 8

_fail_lock = threading.Lock()
_failures: dict[str, list[float]] = {}


# ---------------------------------------------------------------------
# Password
# ---------------------------------------------------------------------

def hash_password(password: str) -> str:
    if len(password) < PASSWORD_MIN:
        raise ValueError(f'Password must be at least {PASSWORD_MIN} characters.')
    if len(password) > PASSWORD_MAX:
        raise ValueError(f'Password must be at most {PASSWORD_MAX} characters.')
    salt = secrets.token_bytes(16)
    key = hashlib.scrypt(
        password.encode('utf-8'), salt=salt,
        n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=SCRYPT_DKLEN,
    )
    return f'scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${key.hex()}'


def _verify_stored(password: str, stored: str) -> bool:
    try:
        kind, n_s, r_s, p_s, salt_hex, key_hex = stored.split('$')
        if kind != 'scrypt':
            return False
        key = hashlib.scrypt(
            password.encode('utf-8'),
            salt=bytes.fromhex(salt_hex),
            n=int(n_s), r=int(r_s), p=int(p_s), dklen=len(bytes.fromhex(key_hex)),
        )
        return hmac.compare_digest(key, bytes.fromhex(key_hex))
    except (ValueError, TypeError, OSError):
        return False


def password_is_set() -> bool:
    stored = store.get_setting(PASSWORD_KEY)
    return bool(stored)


def check_password(password: str) -> bool:
    stored = store.get_setting(PASSWORD_KEY)
    if not stored:
        return False
    return _verify_stored(password, stored)


def set_password(password: str) -> None:
    """Hash and store ``password``, dropping every existing session.

    A change has to invalidate the other browsers: otherwise a stolen
    cookie would outlive the password it was issued under. The caller
    issues a fresh session for the browser that just set it.
    """
    stored = hash_password(password)
    store.set_setting(PASSWORD_KEY, stored)
    store.delete_all_sessions()


def clear_password() -> None:
    store.set_setting(PASSWORD_KEY, None)
    store.delete_all_sessions()
    logger.info('Web access password cleared; every login session has been dropped.')


# ---------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------

def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode('ascii')).hexdigest()


def issue_session() -> str:
    token = secrets.token_urlsafe(32)
    now = time.time()
    store.put_session(_token_hash(token), now, now + SESSION_TTL)
    return token


def session_valid(token: Optional[str]) -> bool:
    if not token:
        return False
    expires = store.session_expires_at(_token_hash(token))
    if expires is None:
        return False
    return expires > time.time()


def revoke_session(token: Optional[str]) -> None:
    if not token:
        return
    store.delete_session(_token_hash(token))


def is_authenticated(token: Optional[str]) -> bool:
    """Whether this request may use the panel.

    No password means the panel is open, the same as before this module
    existed -- ``authenticated`` is then true even without a cookie, so the
    frontend does not have to special-case the unset state.
    """
    if not password_is_set():
        return True
    return session_valid(token)


# ---------------------------------------------------------------------
# Cookies / request
# ---------------------------------------------------------------------

def token_from_request(request: Request) -> Optional[str]:
    return request.cookies.get(COOKIE_NAME)


def cookie_secure(request: Request) -> bool:
    """True when the browser reached us over HTTPS.

    The cookie is usable on a LAN over plain HTTP (the usual
    ``--host 0.0.0.0`` case), so ``Secure`` is only set when the request
    itself was HTTPS -- including behind a reverse proxy that sets
    ``X-Forwarded-Proto``.
    """
    proto = (request.headers.get('x-forwarded-proto') or '').split(',', 1)[0].strip()
    if proto:
        return proto.lower() == 'https'
    return request.url.scheme == 'https'


def attach_session_cookie(response: Response, token: str, *, secure: bool) -> None:
    response.set_cookie(
        COOKIE_NAME, token,
        max_age=SESSION_TTL,
        httponly=True,
        samesite='lax',
        secure=secure,
        path='/',
    )


def attach_cleared_cookie(response: Response, *, secure: bool) -> None:
    response.delete_cookie(
        COOKIE_NAME, path='/', httponly=True, samesite='lax', secure=secure,
    )


def client_id(request: Request) -> str:
    if request.client is None:
        return 'unknown'
    return request.client.host


# ---------------------------------------------------------------------
# Login rate limit
# ---------------------------------------------------------------------

def login_allowed(identity: str) -> bool:
    now = time.time()
    with _fail_lock:
        stamps = [t for t in _failures.get(identity, []) if now - t < LOGIN_WINDOW_S]
        if stamps:
            _failures[identity] = stamps
        else:
            _failures.pop(identity, None)
        return len(stamps) < LOGIN_MAX_FAILURES


def record_login_failure(identity: str) -> None:
    with _fail_lock:
        _failures.setdefault(identity, []).append(time.time())


def reset_login_failures(identity: str) -> None:
    with _fail_lock:
        _failures.pop(identity, None)


def reset_rate_limits() -> None:
    """Drop in-memory lockouts. Tests call this; production never does."""
    with _fail_lock:
        _failures.clear()


# ---------------------------------------------------------------------
# Path gate
# ---------------------------------------------------------------------

# Exact paths that must work before a session exists. Logout is here so a
# stale cookie can be dropped without first refreshing it. The Origin check
# on POST still stops a third-party page from signing the user out.
_PUBLIC_EXACT = frozenset({
    '/api/health',
    '/api/auth/status',
    '/api/auth/login',
    '/api/auth/logout',
})


def is_public_path(path: str) -> bool:
    """Paths that do not need a session even when a password is set.

    Everything under ``/api`` and the OpenAPI docs are gated. The built
    frontend is not: the login screen *is* that frontend, and it has to
    load before anyone can type a password.
    """
    normalised = path.rstrip('/') or '/'
    if normalised in _PUBLIC_EXACT:
        return True
    if normalised.startswith('/api'):
        return False
    if normalised == '/openapi.json':
        return False
    if normalised.startswith('/docs') or normalised.startswith('/redoc'):
        return False
    return True
