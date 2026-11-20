"""FastAPI app for the FuturesView web panel.

Run with ``python main.py web`` (which owns the CLI flags and the
bind-address warning) or ``uvicorn web.app:app`` (prod-ish, still
single-process/single-machine).
"""

from __future__ import annotations

import contextlib
import logging
import os
from typing import Optional

import anyio
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import Headers

from web import store
from web.auth import COOKIE_NAME, is_authenticated, is_public_path
from web.config import (
    DEV_ORIGINS, DISABLE_SCHEDULER_ENV, STATIC_DIR, UNSAFE_METHODS, allowed_hosts,
    allowed_origins, host_allowed, is_within, write_origin_allowed,
)
from web.routers import alerts, auth, backtest, data, indicators, jobs, products, runs, strategies
from web.scheduler import scheduler as alert_scheduler

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(name)s %(message)s')
# Prevent httpx/httpcore from logging full outbound URLs (which include
# Telegram bot tokens in the path) at INFO level.
logging.getLogger('httpx').setLevel(logging.WARNING)
logging.getLogger('httpcore').setLevel(logging.WARNING)


@contextlib.asynccontextmanager
async def _lifespan(_app: FastAPI):
    disabled = os.environ.get(DISABLE_SCHEDULER_ENV, '').strip().lower() in ('1', 'true', 'yes')
    if not disabled:
        alert_scheduler.start()
    try:
        yield
    finally:
        alert_scheduler.stop()
        store.close()


app = FastAPI(title='FuturesView Web Panel', lifespan=_lifespan)


class HostHeaderMiddleware:
    """Refuse any request whose ``Host`` header does not name this panel.

    Stands in for Starlette's ``TrustedHostMiddleware``, which matches on
    ``header.split(':')[0]`` and so reduces every IPv6 literal to ``[`` --
    see ``web.config.normalize_host``. The allowlist is read once, at import,
    the same as before; ``web.config.host_allowed`` owns the matching.
    """

    def __init__(self, app, allowed: list):
        self.app = app
        self.allowed = allowed

    async def __call__(self, scope, receive, send):
        if scope['type'] not in ('http', 'websocket'):
            await self.app(scope, receive, send)
            return
        if host_allowed(Headers(scope=scope).get('host', ''), self.allowed):
            await self.app(scope, receive, send)
            return
        if scope['type'] == 'websocket':
            # No websocket routes today, but denying rather than falling
            # through keeps the check total: a route added later is covered
            # by this without anyone having to remember it.
            await send({'type': 'websocket.close', 'code': 1008})
            return
        await PlainTextResponse('Invalid host header', status_code=400)(scope, receive, send)


class WriteOriginMiddleware:
    """Refuse a state-changing request a browser sent from another site.

    The complement to ``HostHeaderMiddleware``. That one stops a page that
    rebinds a hostname it owns onto this machine; this one stops a page that
    simply addresses ``127.0.0.1`` directly, whose Host header is therefore the
    panel's own. Reads are left alone -- CORS already keeps another origin from
    seeing a response. ``web.config.write_origin_allowed`` owns the rule.
    """

    def __init__(self, app, allowed: list):
        self.app = app
        self.allowed = allowed

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope['method'] not in UNSAFE_METHODS:
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        if write_origin_allowed(
            headers.get('origin'), headers.get('sec-fetch-site'), headers.get('host', ''), self.allowed,
        ):
            await self.app(scope, receive, send)
            return
        await PlainTextResponse('Cross-origin write refused', status_code=403)(scope, receive, send)


class AuthMiddleware:
    """Refuse an API request that has no session when a password is set.

    The password is optional. Unset, this is a no-op and the panel behaves
    as it always has. Set, every non-public path needs the ``fv_session``
    cookie ``web.auth`` issued -- the SPA itself stays public so the login
    form can load. ``web.auth.is_public_path`` owns the allowlist.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        scope_type = scope['type']
        if scope_type not in ('http', 'websocket'):
            await self.app(scope, receive, send)
            return
        if scope_type == 'http' and is_public_path(scope.get('path', '')):
            await self.app(scope, receive, send)
            return
        cookie_headers = Headers(scope=scope).getlist('cookie')
        token = _cookie_value('; '.join(cookie_headers), COOKIE_NAME)
        if await anyio.to_thread.run_sync(is_authenticated, token):
            await self.app(scope, receive, send)
            return
        if scope_type == 'websocket':
            await send({'type': 'websocket.close', 'code': 1008})
            return
        await JSONResponse({'detail': 'Authentication required'}, status_code=401)(
            scope, receive, send,
        )


def _cookie_value(header: str, name: str) -> Optional[str]:
    """Read the cookie named ``name`` from raw ``Cookie`` header text.

    Matches Starlette's ``Request.cookies`` semantics (last matching pair wins,
    surrounding quotes stripped) and accepts semicolon-joined HTTP/2 headers.
    """
    if not header:
        return None
    found: Optional[str] = None
    for part in header.split(';'):
        if '=' not in part:
            continue
        k, v = part.split('=', 1)
        if k.strip() != name:
            continue
        val = v.strip()
        if len(val) >= 2 and val[0] == '"' and val[-1] == '"':
            val = val[1:-1]
        found = val or None
    return found


# Starlette wraps middleware LIFO (last added executes first on incoming
# requests). Register inner-to-outer so every request traverses:
#   HostHeaderMiddleware -> CORSMiddleware -> WriteOriginMiddleware -> AuthMiddleware -> route
# This guarantees disallowed Host headers are refused with 400 immediately
# without answering CORS preflights or hitting SQLite for auth checks.
app.add_middleware(AuthMiddleware)
app.add_middleware(WriteOriginMiddleware, allowed=allowed_origins())
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(DEV_ORIGINS),
    allow_methods=['*'],
    allow_headers=['*'],
)

_ALLOWED_HOSTS = allowed_hosts()
app.add_middleware(HostHeaderMiddleware, allowed=_ALLOWED_HOSTS)
if '*' in _ALLOWED_HOSTS:
    logging.getLogger('futuresview.web').warning(
        'Host header check is OFF (%s contains "*"): this panel will answer to any '
        'hostname, including one an attacker points at it from a page the user has '
        'open. Name the hosts you serve it under instead.', 'FT_WEB_ALLOWED_HOSTS',
    )
else:
    logging.getLogger('futuresview.web').info(
        'Host header restricted to: %s', ', '.join(_ALLOWED_HOSTS),
    )

for router in (auth, products, data, strategies, indicators, backtest, alerts, runs, jobs):
    app.include_router(router.router)


@app.get('/api/health')
def health():
    return {'status': 'ok'}


@app.api_route(
    '/api/{rest:path}',
    methods=['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH'],
    include_in_schema=False,
)
def api_not_found(rest: str):
    """Catch anything under /api that no router claimed."""
    raise HTTPException(status_code=404, detail=f'No such endpoint: /api/{rest}')


if os.path.isdir(STATIC_DIR):
    _ASSETS_DIR = os.path.join(STATIC_DIR, 'assets')
    if os.path.isdir(_ASSETS_DIR):
        app.mount('/assets', StaticFiles(directory=_ASSETS_DIR), name='assets')

    _STATIC_ROOT = os.path.realpath(STATIC_DIR)
    _NO_CACHE = {'Cache-Control': 'no-cache'}

    @app.get('/{full_path:path}', include_in_schema=False)
    def spa(full_path: str):
        """Serve a built frontend file, falling back to index.html."""
        if '\x00' in full_path:
            raise HTTPException(status_code=404, detail='Not found')
        candidate = os.path.realpath(os.path.join(_STATIC_ROOT, full_path))
        if full_path and is_within(candidate, _STATIC_ROOT) and os.path.isfile(candidate):
            if os.path.basename(candidate) == 'index.html':
                return FileResponse(candidate, headers=_NO_CACHE)
            return FileResponse(candidate)
        return FileResponse(os.path.join(_STATIC_ROOT, 'index.html'), headers=_NO_CACHE)
