"""Login, logout, and the optional web-access password."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from web.auth import (
    attach_cleared_cookie, attach_session_cookie, check_password, clear_password,
    client_id, cookie_secure, issue_session, is_authenticated, login_allowed,
    password_is_set, record_login_failure, reset_login_failures, revoke_session,
    set_password, token_from_request,
)
from web.schemas import LoginRequest, PasswordUpdateRequest

router = APIRouter(prefix='/api/auth', tags=['auth'])


@router.get('/status')
def status(request: Request):
    token = token_from_request(request)
    return {
        'password_set': password_is_set(),
        'authenticated': is_authenticated(token),
    }


@router.post('/login')
def login(body: LoginRequest, request: Request):
    identity = client_id(request)
    if not login_allowed(identity):
        raise HTTPException(
            status_code=429,
            detail='Too many attempts; wait a minute and try again.',
        )
    if not password_is_set():
        raise HTTPException(status_code=400, detail='No access password is set.')
    if not check_password(body.password):
        record_login_failure(identity)
        raise HTTPException(status_code=401, detail='Wrong password')
    reset_login_failures(identity)
    token = issue_session()
    response = JSONResponse({'ok': True})
    attach_session_cookie(response, token, secure=cookie_secure(request))
    return response


@router.post('/logout')
def logout(request: Request):
    revoke_session(token_from_request(request))
    response = JSONResponse({'ok': True})
    attach_cleared_cookie(response, secure=cookie_secure(request))
    return response


@router.put('/password')
def update_password(body: PasswordUpdateRequest, request: Request):
    """Set, change, or clear the access password.

    First set is unauthenticated on purpose: the panel is already open to
    whoever can reach it. After that, the middleware requires a session and
    this handler still checks ``current``, so a stolen cookie alone cannot
    replace the password.
    """
    if password_is_set():
        if body.current is None:
            raise HTTPException(status_code=400, detail='Current password is required.')
        if not check_password(body.current):
            raise HTTPException(status_code=403, detail='Current password is wrong.')
    elif body.password is None:
        return {'password_set': False}

    if body.password is None:
        clear_password()
        response = JSONResponse({'password_set': False})
        attach_cleared_cookie(response, secure=cookie_secure(request))
        return response

    try:
        set_password(body.password)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    token = issue_session()
    response = JSONResponse({'password_set': True})
    attach_session_cookie(response, token, secure=cookie_secure(request))
    return response
