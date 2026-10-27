"""Optional web-access password: hashing, sessions, the HTTP gate, and the
CLI warning that mentions it.

The fixtures here point the panel database at a tmp path the same way
``test_web_api`` does, so a test that sets a password cannot leave one in
``results/webpanel.db`` for the rest of the session (or the working tree).
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

import web.auth as auth_module
import web.store as store_module
from web.app import _cookie_value, app
from web.config import STATIC_DIR
from web.auth import (
    COOKIE_NAME, PASSWORD_MIN, SESSION_TTL, check_password, clear_password,
    cookie_secure, hash_password, is_public_path, issue_session, password_is_set,
    reset_rate_limits, session_valid, set_password,
)


@pytest.fixture
def client():
    return TestClient(app, base_url='http://localhost')


@pytest.fixture(autouse=True)
def isolated_auth_store(tmp_path, monkeypatch):
    monkeypatch.setattr(store_module, 'DB_PATH', str(tmp_path / 'webpanel_auth.db'))
    monkeypatch.setattr(store_module, '_conn', None)
    # Production scrypt is a noticeable pause per hash; these tests set and
    # check a password many times and only care that the round-trip holds.
    monkeypatch.setattr(auth_module, 'SCRYPT_N', 16)
    reset_rate_limits()
    yield
    monkeypatch.setattr(store_module, '_conn', None)
    reset_rate_limits()


def _set_cookie_header(response) -> str:
    # Starlette 0.45+ may emit several Set-Cookie headers; the session is
    # the one this module named.
    return response.headers.get('set-cookie') or ''


# ---------------------------------------------------------------------
# Hashing and sessions
# ---------------------------------------------------------------------

def test_password_round_trip_and_wrong_guess():
    stored = hash_password('correct-horse')
    assert stored.startswith('scrypt$')
    assert check_password('correct-horse') is False  # nothing stored yet
    store_module.set_setting(auth_module.PASSWORD_KEY, stored)
    assert password_is_set()
    assert check_password('correct-horse')
    assert not check_password('wrong-password')
    assert not check_password('')


def test_short_password_is_refused_before_it_is_stored():
    with pytest.raises(ValueError, match='at least'):
        hash_password('short')
    assert not password_is_set()


def test_a_corrupt_hash_never_matches():
    store_module.set_setting(auth_module.PASSWORD_KEY, 'not-a-hash')
    assert not check_password('anything-at-all')


def test_session_is_valid_until_it_expires(monkeypatch):
    clock = {'now': 1_000.0}
    monkeypatch.setattr(auth_module.time, 'time', lambda: clock['now'])
    token = issue_session()
    assert session_valid(token)
    assert not session_valid('not-the-token')
    assert not session_valid(None)

    clock['now'] = 1_000.0 + SESSION_TTL + 1
    assert not session_valid(token)


def test_set_password_drops_every_existing_session():
    set_password('first-password')
    token = issue_session()
    assert session_valid(token)
    set_password('second-password')
    assert not session_valid(token)
    assert check_password('second-password')


def test_is_public_path_keeps_the_login_surface_open():
    assert is_public_path('/api/health')
    assert is_public_path('/api/auth/status')
    assert is_public_path('/api/auth/login')
    assert is_public_path('/api/auth/logout')
    assert is_public_path('/api/auth/login/')
    assert not is_public_path('/api/auth/password')
    assert not is_public_path('/api/products')
    assert not is_public_path('/openapi.json')
    assert not is_public_path('/docs')
    assert not is_public_path('/docs/oauth2-redirect')
    assert is_public_path('/')
    assert is_public_path('/assets/index-abc.js')


def test_cookie_value_reads_the_named_pair():
    assert _cookie_value('', COOKIE_NAME) is None
    assert _cookie_value(f'{COOKIE_NAME}=abc; other=1', COOKIE_NAME) == 'abc'
    assert _cookie_value(f'other=1; {COOKIE_NAME}=xyz', COOKIE_NAME) == 'xyz'
    assert _cookie_value(f'{COOKIE_NAME}=', COOKIE_NAME) is None


def test_cookie_secure_follows_https_and_forwarded_proto():
    from starlette.requests import Request

    def req(scheme, headers=None):
        raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
        return Request({
            'type': 'http', 'method': 'GET', 'path': '/', 'headers': raw,
            'scheme': scheme, 'server': ('localhost', 80),
            'query_string': b'',
        })

    assert not cookie_secure(req('http'))
    assert cookie_secure(req('https'))
    assert cookie_secure(req('http', {'x-forwarded-proto': 'https'}))
    assert cookie_secure(req('http', {'x-forwarded-proto': 'https, http'}))
    assert not cookie_secure(req('https', {'x-forwarded-proto': 'http'}))


# ---------------------------------------------------------------------
# HTTP surface
# ---------------------------------------------------------------------

def test_status_is_open_when_no_password_is_set(client):
    body = client.get('/api/auth/status').json()
    assert body == {'password_set': False, 'authenticated': True}
    assert client.get('/api/health').status_code == 200
    assert client.get('/api/products').status_code == 200


def test_setting_a_password_gates_the_api_and_leaves_the_login_surface(client):
    resp = client.put('/api/auth/password', json={'password': 'correct-horse'})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {'password_set': True}
    # The setter is signed in so the page they just used keeps working.
    assert client.get('/api/products').status_code == 200
    assert 'HttpOnly' in _set_cookie_header(resp)
    assert COOKIE_NAME in _set_cookie_header(resp)

    stranger = TestClient(app, base_url='http://localhost')
    assert stranger.get('/api/products').status_code == 401
    assert stranger.get('/api/products').json()['detail'] == 'Authentication required'
    assert stranger.get('/api/health').status_code == 200
    status = stranger.get('/api/auth/status').json()
    assert status == {'password_set': True, 'authenticated': False}
    assert stranger.get('/openapi.json').status_code == 401


def test_login_rejects_a_wrong_password_and_accepts_the_right_one(client):
    client.put('/api/auth/password', json={'password': 'correct-horse'})
    stranger = TestClient(app, base_url='http://localhost')

    assert stranger.post('/api/auth/login', json={'password': 'nope-nope'}).status_code == 401
    assert stranger.get('/api/products').status_code == 401

    resp = stranger.post('/api/auth/login', json={'password': 'correct-horse'})
    assert resp.status_code == 200, resp.text
    assert stranger.get('/api/products').status_code == 200
    assert stranger.get('/api/auth/status').json()['authenticated'] is True


def test_login_without_a_password_is_a_client_error(client):
    resp = client.post('/api/auth/login', json={'password': 'correct-horse'})
    assert resp.status_code == 400
    assert 'No access password' in resp.json()['detail']


def test_logout_forgets_the_session(client):
    client.put('/api/auth/password', json={'password': 'correct-horse'})
    assert client.get('/api/products').status_code == 200
    assert client.post('/api/auth/logout').status_code == 200
    assert client.get('/api/products').status_code == 401


def test_changing_the_password_needs_the_current_one_and_drops_other_sessions(client):
    client.put('/api/auth/password', json={'password': 'correct-horse'})
    other = TestClient(app, base_url='http://localhost')
    assert other.post('/api/auth/login', json={'password': 'correct-horse'}).status_code == 200

    assert client.put('/api/auth/password', json={'password': 'new-password'}).status_code == 400
    assert client.put(
        '/api/auth/password', json={'current': 'wrong-password', 'password': 'new-password'},
    ).status_code == 403

    resp = client.put(
        '/api/auth/password', json={'current': 'correct-horse', 'password': 'new-password'},
    )
    assert resp.status_code == 200, resp.text
    # This browser was re-issued a session; the other one was not.
    assert client.get('/api/products').status_code == 200
    assert other.get('/api/products').status_code == 401
    assert other.post('/api/auth/login', json={'password': 'new-password'}).status_code == 200


def test_clearing_the_password_opens_the_panel_again(client):
    client.put('/api/auth/password', json={'password': 'correct-horse'})
    resp = client.put('/api/auth/password', json={'current': 'correct-horse'})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {'password_set': False}

    stranger = TestClient(app, base_url='http://localhost')
    assert stranger.get('/api/products').status_code == 200
    assert stranger.get('/api/auth/status').json() == {
        'password_set': False, 'authenticated': True,
    }


def test_a_too_short_password_is_a_422(client):
    resp = client.put('/api/auth/password', json={'password': 'short'})
    assert resp.status_code == 422
    assert str(PASSWORD_MIN) in resp.json()['detail']
    assert not password_is_set()


def test_login_is_rate_limited_after_repeated_failures(client):
    client.put('/api/auth/password', json={'password': 'correct-horse'})
    stranger = TestClient(app, base_url='http://localhost')
    for _ in range(auth_module.LOGIN_MAX_FAILURES):
        assert stranger.post('/api/auth/login', json={'password': 'nope-nope'}).status_code == 401
    resp = stranger.post('/api/auth/login', json={'password': 'nope-nope'})
    assert resp.status_code == 429
    # Even the right password is refused until the window slides.
    assert stranger.post('/api/auth/login', json={'password': 'correct-horse'}).status_code == 429


def test_a_cross_site_login_is_still_refused_by_the_origin_check(client):
    client.put('/api/auth/password', json={'password': 'correct-horse'})
    stranger = TestClient(app, base_url='http://localhost')
    resp = stranger.post(
        '/api/auth/login',
        json={'password': 'correct-horse'},
        headers={'origin': 'https://evil.example'},
    )
    assert resp.status_code == 403


@pytest.mark.skipif(not os.path.isdir(STATIC_DIR), reason='no built frontend in web/static')
def test_the_spa_stays_public_so_the_login_form_can_load(client):
    client.put('/api/auth/password', json={'password': 'correct-horse'})
    stranger = TestClient(app, base_url='http://localhost')
    resp = stranger.get('/')
    assert resp.status_code == 200
    assert 'html' in resp.headers.get('content-type', '').lower()


def test_clear_password_helper_forgets_the_hash():
    set_password('correct-horse')
    assert password_is_set()
    clear_password()
    assert not password_is_set()
    assert not check_password('correct-horse')


# ---------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------

def test_off_loopback_warning_names_the_lock_icon_when_no_password():
    import main

    text = main._off_loopback_warning('0.0.0.0', False, ' Host note.')
    assert 'no access password' in text
    assert 'lock icon' in text
    assert 'Host note.' in text

    text = main._off_loopback_warning('0.0.0.0', True, ' Host note.')
    assert 'password is set' in text
    assert 'Host note.' in text


def test_web_cli_accepts_clear_password():
    import main

    args = main._parse_args(['web', '--clear-password'])
    assert args.clear_password
    assert not main._parse_args(['web']).clear_password
