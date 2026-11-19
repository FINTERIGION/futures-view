"""Backend tests for persistent alert monitors, third-party notification channels
(Telegram + Generic Webhook), weekday scheduler, and alert HTTP endpoints.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import httpx
import pytest
from fastapi.testclient import TestClient

import web.alert_service as alert_service
import web.auth as auth_module
import web.marketcache as marketcache_module
import web.notifiers as notifiers
import web.store as store_module
from tests.conftest import build_trending_market
from web.app import app
from web.scheduler import AlertScheduler


@pytest.fixture
def client():
    return TestClient(app, base_url='http://localhost')


@pytest.fixture(autouse=True)
def isolated_env(tmp_path, monkeypatch):
    monkeypatch.setattr(store_module, 'DB_PATH', str(tmp_path / 'alert_test.db'))
    monkeypatch.setattr(store_module, 'WEB_RESULTS_DIR', str(tmp_path / 'web_results'))
    monkeypatch.setattr(store_module, '_conn', None)
    monkeypatch.setattr(notifiers, '_HTTP_TRANSPORT', None)

    built = {}

    def fake_get(symbols, start, end, update=False):
        key = tuple(sorted(symbols))
        if key not in built:
            built[key] = build_trending_market(key)
        return built[key]

    monkeypatch.setattr(marketcache_module.cache, 'get', fake_get)
    yield
    monkeypatch.setattr(store_module, '_conn', None)
    monkeypatch.setattr(notifiers, '_HTTP_TRANSPORT', None)


# ---------------------------------------------------------------------
# Store & deduplication
# ---------------------------------------------------------------------

def test_delivery_slot_claim_is_unique_and_orphans_are_adopted():
    first = store_module.claim_alert_delivery(trigger='schedule', scheduled_slot='2026-11-19 15:30')
    assert first is not None
    second = store_module.claim_alert_delivery(trigger='schedule', scheduled_slot='2026-11-19 15:30')
    assert second is None

    # Simulate server restart while `first` is still 'running'.
    store_module._conn.close()
    store_module._conn = None
    deliveries = store_module.list_alert_deliveries()
    assert len(deliveries) == 1
    assert deliveries[0]['id'] == first
    assert deliveries[0]['status'] == 'interrupted'
    assert deliveries[0]['finished_at'] is not None


# ---------------------------------------------------------------------
# Providers: Telegram & Generic Webhook
# ---------------------------------------------------------------------

def test_telegram_provider_formats_html_chunks_and_sends(monkeypatch):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((str(request.url), json.loads(request.content.decode('utf-8'))))
        return httpx.Response(200, json={'ok': True, 'result': {'message_id': 42}})

    monkeypatch.setattr(notifiers, '_HTTP_TRANSPORT', httpx.MockTransport(handler))
    provider = notifiers.get_provider('telegram')
    cfg = provider.validate_config({
        'bot_token': '123456:ABCDEF_SECRET_TOKEN',
        'chat_id': '-10012345',
        'api_base': 'https://tg-proxy.example.com/',
        'message_thread_id': 7,
    })
    assert cfg['api_base'] == 'https://tg-proxy.example.com'
    masked = provider.mask_config(cfg)
    assert masked['bot_token'] == ''
    assert masked['has_bot_token'] is True
    assert 'SECRET' not in masked['bot_token_preview']

    # Omitting token on update preserves the existing secret.
    kept = provider.validate_config({'chat_id': '-10099999'}, existing=cfg)
    assert kept['bot_token'] == '123456:ABCDEF_SECRET_TOKEN'
    assert kept['chat_id'] == '-10099999'

    report = {
        'event': 'futuresview.alert_report',
        'trigger': 'schedule',
        'generated_at': '2026-11-19T15:30:00+08:00',
        'run_date': '2026-11-19',
        'run_time_label': '2026-11-19 15:30',
        'data_update': {'skipped': False, 'updated': ['SA', 'CF', 'FG'], 'stale': [], 'failed': {}},
        'data_warnings': ['FG 数据更新失败：timeout <retry>'],
        'monitors': [{
            'id': 'm1',
            'name': '趋势 <测试>',
            'strategy': 'double_ma',
            'params': {'fast_period': 5, 'slow_period': 20},
            'asof': '2026-11-18',
            'blown_up': False,
            'error': None,
            'symbols': [
                {
                    'symbol': 'CF', 'name_zh': '棉花', 'contract': 'CF605',
                    'holding': 'long', 'operation': 'reverse',
                    'entry_price': 14100.0, 'last_price': 14250.5,
                    'stop': {'price': None, 'distance': 120.0},
                    'take_profit': {'price': None, 'distance': None},
                },
                {
                    'symbol': 'SA', 'name_zh': '纯碱', 'contract': 'SA509',
                    'holding': 'short', 'operation': 'hold',
                    'entry_price': 1550.0, 'last_price': 1510.0,
                    'stop': {'price': 1580.0, 'distance': None},
                    'take_profit': {'price': 1450.0, 'distance': None},
                },
                {
                    'symbol': 'FG', 'name_zh': '玻璃', 'contract': 'FG601',
                    'holding': 'flat', 'operation': 'flat',
                    'entry_price': None, 'last_price': 1280.0,
                    'stop': {'price': None, 'distance': None},
                    'take_profit': {'price': None, 'distance': None},
                },
            ],
        }],
    }

    res = provider.send('c1', 'My TG', cfg, report, language='zh')
    assert res.ok is True
    assert len(seen) == 1
    url, body = seen[0]
    assert url == 'https://tg-proxy.example.com/bot123456:ABCDEF_SECRET_TOKEN/sendMessage'
    assert body['chat_id'] == '-10012345'
    assert body['parse_mode'] == 'HTML'
    assert body['message_thread_id'] == 7
    text = body['text']
    assert '趋势 &lt;测试&gt;' in text
    assert '反手（多→空）' in text
    assert '持有（空头）' in text
    assert 'FG(玻璃) [FG601]：空仓（最新 1280）' in text
    assert '早于今日 2026-11-19' in text
    assert '距下一开盘 ±120' in text
    assert '1580' in text and '1450' in text


def test_telegram_splits_messages_over_limit():
    long_text = '\n'.join(f'line-{i}: ' + ('x' * 120) for i in range(60))
    chunks = notifiers.split_message_chunks(long_text, max_len=1000)
    assert len(chunks) > 1
    assert all(len(c) <= 1000 for c in chunks)
    assert '\n'.join(chunks) == long_text


def test_webhook_provider_default_json_and_ast_template(monkeypatch):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((dict(request.headers), json.loads(request.content.decode('utf-8'))))
        return httpx.Response(200, json={'ok': True})

    monkeypatch.setattr(notifiers, '_HTTP_TRANSPORT', httpx.MockTransport(handler))
    provider = notifiers.get_provider('webhook')

    # Invalid template rejected
    with pytest.raises(ValueError, match='payload_template'):
        provider.validate_config({'url': 'https://hook.example.com/a', 'payload_template': '{bad'})

    cfg = provider.validate_config({
        'url': 'https://hook.example.com/a',
        'bearer_token': 'super-secret-token',
        'headers': {'X-Custom': 'yes'},
        'payload_template': json.dumps({
            'msg_type': 'text',
            'content': {'text': '{{title}}\n{{text}}'},
            'raw': '{{report}}',
        }),
    })
    masked = provider.mask_config(cfg)
    assert masked['bearer_token'] == ''
    assert masked['has_bearer_token'] is True
    assert 'super-secret' not in masked['bearer_token_preview']

    # Clear bearer token explicitly
    cleared = provider.validate_config(
        {'url': 'https://hook.example.com/a', 'clear_bearer_token': True}, existing=cfg,
    )
    assert cleared['bearer_token'] == ''

    report = {
        'event': 'futuresview.alert_report',
        'trigger': 'manual',
        'generated_at': '2026-11-19T15:30:00+08:00',
        'run_date': '2026-11-19',
        'run_time_label': '2026-11-19 15:30',
        'data_update': {'skipped': True, 'updated': [], 'stale': [], 'failed': {}},
        'data_warnings': ['quote "test"'],
        'monitors': [],
    }
    res = provider.send('w1', 'Feishu Hook', cfg, report, language='zh')
    assert res.ok is True
    headers, payload = seen[0]
    assert headers['authorization'] == 'Bearer super-secret-token'
    assert headers['x-custom'] == 'yes'
    assert payload['msg_type'] == 'text'
    assert 'quote "test"' in payload['content']['text']
    assert payload['raw']['event'] == 'futuresview.alert_report'


# ---------------------------------------------------------------------
# Scheduler & next-run computation
# ---------------------------------------------------------------------

def test_scheduler_weekdays_only_window_and_idempotency():
    alert_service.save_schedule({
        'enabled': True,
        'times': ['15:30', '20:30'],
        'timezone': 'Asia/Shanghai',
        'weekdays_only': True,
        'update_data': True,
        'language': 'zh',
    })
    sh = ZoneInfo('Asia/Shanghai')
    dispatched = []
    sched = AlertScheduler(
        grace_seconds=120.0,
        dispatch_fn=lambda **kw: dispatched.append(kw),
    )

    # Saturday 2026-11-21 15:30 -> skipped
    assert sched.tick(now=datetime(2026, 11, 21, 15, 30, 5, tzinfo=sh)) == []
    assert dispatched == []

    # Thursday 2026-11-19 15:29 -> too early
    assert sched.tick(now=datetime(2026, 11, 19, 15, 29, 59, tzinfo=sh)) == []

    # Thursday 2026-11-19 15:30:10 -> fires once
    assert sched.tick(now=datetime(2026, 11, 19, 15, 30, 10, tzinfo=sh)) == ['2026-11-19 15:30']
    assert len(dispatched) == 1

    # Same slot 30 seconds later -> deduplicated by SQLite scheduled_slot
    assert sched.tick(now=datetime(2026, 11, 19, 15, 30, 40, tzinfo=sh)) == []
    assert len(dispatched) == 1

    # After grace window (15:35) for a slot never fired -> does not fire retroactively
    alert_service.save_schedule({
        'enabled': True,
        'times': ['14:00', '20:30'],
        'timezone': 'Asia/Shanghai',
        'weekdays_only': True,
        'update_data': True,
        'language': 'zh',
    })
    assert sched.tick(now=datetime(2026, 11, 19, 15, 35, 0, tzinfo=sh)) == []

    # Second slot 20:30 fires cleanly
    assert sched.tick(now=datetime(2026, 11, 19, 20, 30, 15, tzinfo=sh)) == ['2026-11-19 20:30']
    assert len(dispatched) == 2


def test_compute_next_run_skips_weekend():
    sh = ZoneInfo('Asia/Shanghai')
    schedule = alert_service.validate_schedule({
        'enabled': True,
        'times': ['15:30'],
        'timezone': 'Asia/Shanghai',
        'weekdays_only': True,
        'update_data': True,
        'language': 'zh',
    })
    # Friday 2026-11-20 16:00 -> next weekday is Monday 2026-11-23 15:30
    nxt = alert_service.compute_next_run(schedule, now=datetime(2026, 11, 20, 16, 0, tzinfo=sh))
    assert nxt == '2026-11-23T15:30:00+08:00'


# ---------------------------------------------------------------------
# End-to-end alert_service pipeline
# ---------------------------------------------------------------------

def test_dispatch_deduplicates_updates_and_isolates_failures(monkeypatch):
    updated_syms = []

    class FakeDataUpdate:
        def __init__(self, sym):
            self.sym = sym
            self.stale_keys = []

        def update(self, force=False, rebuild_only=False):
            updated_syms.append(self.sym)
            if self.sym == 'CF':
                raise RuntimeError('exchange timeout')

    monkeypatch.setattr(alert_service, 'DataUpdate', FakeDataUpdate)

    def handler(request: httpx.Request) -> httpx.Response:
        if 'fail.example.com' in str(request.url):
            return httpx.Response(500, text='boom')
        return httpx.Response(200, json={'ok': True})

    monkeypatch.setattr(notifiers, '_HTTP_TRANSPORT', httpx.MockTransport(handler))

    m1 = store_module.create_alert_monitor(
        name='M1', strategy='double_ma', symbols=['SA', 'CF'], params={}, notify_enabled=True,
    )
    m2 = store_module.create_alert_monitor(
        name='M2', strategy='double_ma', symbols=['SA'], params={}, notify_enabled=True,
    )
    store_module.create_alert_monitor(
        name='Muted', strategy='double_ma', symbols=['FG'], params={}, notify_enabled=False,
    )
    store_module.create_notify_channel(
        kind='webhook', name='Good Hook', config={'url': 'https://ok.example.com/hook'}, enabled=True,
    )
    store_module.create_notify_channel(
        kind='webhook', name='Bad Hook', config={'url': 'https://fail.example.com/hook'}, enabled=True,
    )

    out = alert_service.run_alert_dispatch(
        trigger='manual',
        update_data=True,
        now=datetime(2026, 11, 19, 15, 30, tzinfo=timezone.utc),
    )
    # SA + CF deduplicated once each; FG belonged only to notify_enabled=False monitor.
    assert updated_syms == ['SA', 'CF']
    assert out['status'] == 'partial'
    assert out['monitor_count'] == 2
    assert any('CF' in w for w in out['data_warnings'])
    assert len(out['results']) == 2
    assert sum(1 for r in out['results'] if r['ok']) == 1

    # Snapshots were persisted onto monitors
    reloaded = store_module.get_alert_monitor(m1['id'])
    assert reloaded['last_snapshot'] is not None
    assert reloaded['last_snapshot']['symbols'][0]['holding'] in ('flat', 'long', 'short')
    assert store_module.get_alert_monitor(m2['id'])['last_snapshot'] is not None


# ---------------------------------------------------------------------
# HTTP API endpoints
# ---------------------------------------------------------------------

def test_monitors_channels_schedule_and_dispatch_api(client, monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={'ok': True, 'result': {'message_id': 1}})

    monkeypatch.setattr(notifiers, '_HTTP_TRANSPORT', httpx.MockTransport(handler))

    # Create monitor
    r = client.post('/api/alerts/monitors', json={
        'name': '主力双均线',
        'strategy': 'double_ma',
        'symbols': ['SA', 'CF'],
        'params': {'fast_period': 5, 'slow_period': 20},
        'notify_enabled': True,
    })
    assert r.status_code == 201, r.text
    mon = r.json()
    assert mon['strategy'] == 'double_ma'
    assert mon['notify_enabled'] is True

    # Import skips existing ID and invalid strategies
    imp = client.post('/api/alerts/monitors/import', json={
        'entries': [
            {'id': mon['id'], 'strategy': 'double_ma', 'symbols': ['SA'], 'params': {}},
            {'id': 'legacy-1', 'strategy': 'double_ma', 'symbols': ['SA'], 'params': {}, 'created_at': 1700000000000},
            {'id': 'bad-1', 'strategy': 'no_such_strategy', 'symbols': ['SA'], 'params': {}},
        ],
    })
    assert imp.status_code == 200
    assert len(imp.json()['imported']) == 1
    assert imp.json()['skipped'] == 2
    assert imp.json()['imported'][0]['created_at'] == pytest.approx(1700000000.0)

    # Preview with monitor_id persists snapshot
    prev = client.post('/api/alerts/preview', json={
        'strategy': 'double_ma',
        'symbols': ['SA', 'CF'],
        'params': {'fast_period': 5, 'slow_period': 20},
        'monitor_id': mon['id'],
    })
    assert prev.status_code == 200
    job_id = prev.json()['job_id']
    for _ in range(100):
        st = client.get(f'/api/jobs/{job_id}').json()
        if st['status'] in ('done', 'error'):
            break
        time.sleep(0.02)
    assert st['status'] == 'done'
    assert 'holding' in st['result']['symbols'][0]

    # Toggling notify_enabled alone preserves saved snapshot
    upd = client.put(f"/api/alerts/monitors/{mon['id']}", json={
        'name': '主力双均线',
        'strategy': 'double_ma',
        'symbols': ['SA', 'CF'],
        'params': {'fast_period': 5, 'slow_period': 20},
        'notify_enabled': False,
    })
    assert upd.status_code == 200
    assert upd.json()['notify_enabled'] is False
    assert upd.json()['last_snapshot'] is not None

    # Create Telegram channel -> secret masked
    ch_res = client.post('/api/alerts/channels', json={
        'kind': 'telegram',
        'name': 'Personal TG',
        'enabled': True,
        'config': {'bot_token': '123456:SECRET_ABC', 'chat_id': '99999'},
    })
    assert ch_res.status_code == 201, ch_res.text
    ch = ch_res.json()
    assert ch['config']['bot_token'] == ''
    assert ch['config']['has_bot_token'] is True
    assert 'SECRET_ABC' not in json.dumps(ch)

    # Test channel send
    test_res = client.post(f"/api/alerts/channels/{ch['id']}/test")
    assert test_res.status_code == 200
    assert test_res.json()['ok'] is True

    # Schedule validation & update
    bad_sched = client.put('/api/alerts/schedule', json={
        'enabled': True, 'times': [], 'timezone': 'Asia/Shanghai',
        'weekdays_only': True, 'update_data': True, 'language': 'zh',
    })
    assert bad_sched.status_code == 422

    ok_sched = client.put('/api/alerts/schedule', json={
        'enabled': True, 'times': ['20:30', '15:30', '15:30'], 'timezone': 'Asia/Shanghai',
        'weekdays_only': True, 'update_data': False, 'language': 'zh',
    })
    assert ok_sched.status_code == 200
    assert ok_sched.json()['times'] == ['15:30', '20:30']
    assert ok_sched.json()['next_run_at'] is not None

    # Manual dispatch job
    disp = client.post('/api/alerts/dispatch', json={'update_data': False})
    assert disp.status_code == 200
    d_job = disp.json()['job_id']
    for _ in range(100):
        st = client.get(f'/api/jobs/{d_job}').json()
        if st['status'] in ('done', 'error'):
            break
        time.sleep(0.02)
    assert st['status'] == 'done'
    assert st['result']['status'] == 'ok'

    # Delivery audit log recorded both test + manual
    logs = client.get('/api/alerts/deliveries').json()
    assert len(logs) >= 2
    assert {row['trigger'] for row in logs} >= {'test', 'manual'}

    # Auth gate protects all new routes when password is set
    auth_module.set_password('correct-horse')
    assert client.get('/api/alerts/monitors').status_code == 401
    assert client.get('/api/alerts/channels').status_code == 401
    assert client.get('/api/alerts/schedule').status_code == 401
    assert client.post('/api/alerts/dispatch', json={}).status_code == 401
