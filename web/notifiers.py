"""Pluggable third-party notification providers and alert report formatters.

Built-in providers:
- ``telegram``: Telegram Bot API (``sendMessage`` with HTML formatting,
  automatic 4096-char chunking, optional reverse-proxy ``api_base`` and
  optional HTTP/HTTPS/SOCKS ``proxy``).
- ``webhook``: Generic HTTP JSON webhook with optional ``bearer_token``,
  custom headers, optional proxy, and safe JSON-AST ``payload_template``
  substitution (compatible with Feishu, DingTalk, WeCom, Discord, Slack, etc.).

Adding a new platform later only requires implementing
:class:`NotificationProvider` and calling :func:`register_provider`.
"""

from __future__ import annotations

import abc
import dataclasses
import html
import json
import logging
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit

import httpx

logger = logging.getLogger('futuresview.web')

DEFAULT_TELEGRAM_API_BASE = 'https://api.telegram.org'
HTTP_TIMEOUT_SECONDS = 15.0
TELEGRAM_MAX_CHARS = 3900

# Optional transport hook for offline unit tests (``httpx.MockTransport``).
_HTTP_TRANSPORT: Optional[httpx.BaseTransport] = None

ACTIONABLE_OPS = frozenset({
    'open_long', 'open_short', 'close', 'reverse', 'add', 'reduce',
})


@dataclasses.dataclass
class DeliveryResult:
    channel_id: str
    channel_name: str
    kind: str
    ok: bool
    detail: str = ''
    status_code: Optional[int] = None

    def to_dict(self) -> dict:
        return {
            'channel_id': self.channel_id,
            'channel_name': self.channel_name,
            'kind': self.kind,
            'ok': self.ok,
            'detail': self.detail,
            'status_code': self.status_code,
        }


# ---------------------------------------------------------------------
# Validation, masking, and HTTP helpers
# ---------------------------------------------------------------------

def _mask_secret(value: Optional[str]) -> str:
    text = (value or '').strip()
    if not text:
        return ''
    if len(text) <= 8:
        return '••••'
    return f'{text[:4]}…{text[-4:]}'


def _validate_http_url(raw: str, *, field_name: str, allow_empty: bool = False) -> str:
    url = (raw or '').strip()
    if not url:
        if allow_empty:
            return ''
        raise ValueError(f'{field_name} is required')
    parts = urlsplit(url)
    if parts.scheme not in ('http', 'https') or not parts.netloc:
        raise ValueError(f'{field_name} must be an http:// or https:// URL')
    return url


def _validate_proxy_url(raw: Optional[str]) -> str:
    proxy = (raw or '').strip()
    if not proxy:
        return ''
    parts = urlsplit(proxy)
    if parts.scheme not in ('http', 'https', 'socks5', 'socks5h') or not parts.netloc:
        raise ValueError(
            'proxy must start with http://, https://, socks5://, or socks5h://',
        )
    return proxy


def _make_client(*, proxy: str = '', timeout: float = HTTP_TIMEOUT_SECONDS) -> httpx.Client:
    kwargs: Dict[str, Any] = {
        'timeout': timeout,
        'follow_redirects': False,
    }
    if _HTTP_TRANSPORT is not None:
        kwargs['transport'] = _HTTP_TRANSPORT
    elif proxy:
        kwargs['proxy'] = proxy
    try:
        return httpx.Client(**kwargs)
    except ImportError as exc:
        raise ValueError(
            f'Proxy {proxy!r} requires optional dependency (e.g. httpx[socks]): {exc}',
        ) from exc


# ---------------------------------------------------------------------
# Report formatting (plain text + Telegram HTML)
# ---------------------------------------------------------------------

def _format_price(value: Any) -> str:
    if value is None:
        return '—'
    try:
        num = float(value)
    except (TypeError, ValueError):
        return '—'
    if abs(num - round(num)) < 1e-9:
        return str(int(round(num)))
    return f'{num:.4f}'.rstrip('0').rstrip('.')


def _format_level(level: Optional[dict], language: str) -> str:
    if not isinstance(level, dict):
        return '—'
    if level.get('price') is not None:
        return _format_price(level['price'])
    if level.get('distance') is not None:
        dist = _format_price(level['distance'])
        return f'距下一开盘 ±{dist}' if language == 'zh' else f'next open ±{dist}'
    return '—'


def _holding_label(holding: str, language: str) -> str:
    if language == 'zh':
        return {'long': '多头', 'short': '空头', 'flat': '空仓'}.get(holding, '空仓')
    return {'long': 'Long', 'short': 'Short', 'flat': 'Flat'}.get(holding, 'Flat')


def _operation_label(operation: str, holding: str, language: str) -> str:
    if language == 'zh':
        if operation == 'reverse':
            if holding == 'long':
                return '反手（多→空）'
            if holding == 'short':
                return '反手（空→多）'
            return '反手'
        if operation == 'close':
            if holding == 'long':
                return '平多'
            if holding == 'short':
                return '平空'
            return '平仓'
        if operation == 'add':
            if holding == 'long':
                return '加多'
            if holding == 'short':
                return '加空'
            return '加仓'
        if operation == 'reduce':
            if holding == 'long':
                return '减多'
            if holding == 'short':
                return '减空'
            return '减仓'
        if operation == 'hold':
            if holding in ('long', 'short'):
                return f'持有（{_holding_label(holding, "zh")}）'
            return '持有'
        return {
            'flat': '空仓',
            'open_long': '开多',
            'open_short': '开空',
        }.get(operation, operation)

    if operation == 'reverse':
        if holding == 'long':
            return 'Reverse (Long -> Short)'
        if holding == 'short':
            return 'Reverse (Short -> Long)'
        return 'Reverse'
    if operation == 'close':
        if holding == 'long':
            return 'Close long'
        if holding == 'short':
            return 'Close short'
        return 'Close'
    if operation == 'add':
        if holding == 'long':
            return 'Add long'
        if holding == 'short':
            return 'Add short'
        return 'Add'
    if operation == 'reduce':
        if holding == 'long':
            return 'Reduce long'
        if holding == 'short':
            return 'Reduce short'
        return 'Reduce'
    if operation == 'hold':
        if holding in ('long', 'short'):
            return f'Hold ({_holding_label(holding, "en")})'
        return 'Hold'
    return {
        'flat': 'Flat',
        'open_long': 'Open long',
        'open_short': 'Open short',
    }.get(operation, operation)


def _param_summary(params: Optional[dict]) -> str:
    if not params:
        return ''
    return ', '.join(f'{k}={v}' for k, v in params.items())


def _report_title(report: dict, language: str) -> str:
    stamp = report.get('run_time_label') or report.get('run_date') or ''
    if language == 'zh':
        return f'期货交易提醒｜{stamp}'.rstrip('｜')
    return f'FuturesView Alert | {stamp}'.rstrip(' |')


def _symbol_tag(row: dict, language: str) -> str:
    sym = str(row.get('symbol') or '')
    contract = str(row.get('contract') or '')
    name_zh = str(row.get('name_zh') or '')
    head = f'{sym}({name_zh})' if language == 'zh' and name_zh else sym
    return f'{head} [{contract}]' if contract else head


def format_report_text(report: dict, *, language: str = 'zh', use_html: bool = False) -> str:
    """Format an alert report into scannable plain text or Telegram HTML."""
    zh = language == 'zh'
    esc = html.escape if use_html else (lambda s: s)

    def bold(text: str) -> str:
        return f'<b>{esc(text)}</b>' if use_html else text

    title = _report_title(report, language)
    lines: List[str] = [f'📊 {bold(title)}']

    data_info = report.get('data_update') or {}
    updated = data_info.get('updated') or []
    skipped_update = bool(data_info.get('skipped'))
    if skipped_update:
        lines.append('数据更新：未执行更新（使用本地缓存）' if zh else 'Data sync: skipped (local cache)')
    else:
        lines.append(
            f'数据更新：已检查更新 {len(updated)} 个品种'
            if zh else f'Data sync: checked {len(updated)} product(s)',
        )

    warnings = report.get('data_warnings') or []
    for warn in warnings:
        lines.append(f'⚠️ {esc(str(warn))}')

    run_date = report.get('run_date')
    monitors = report.get('monitors') or []
    if not monitors:
        lines.append('')
        lines.append('当前没有已启用推送的信号监控。' if zh else 'No enabled signal monitors.')
        return '\n'.join(lines)

    for mon in monitors:
        lines.append('')
        lines.append('━━━━━━━━━━━━━━━━')
        mon_name = (mon.get('name') or '').strip()
        strategy = str(mon.get('strategy') or '')
        p_sum = _param_summary(mon.get('params'))
        header = f'{mon_name} ({strategy})' if mon_name and mon_name != strategy else strategy
        if p_sum:
            header = f'{header} · {p_sum}'
        lines.append(f'📌 {bold(header)}')

        if mon.get('error'):
            prefix = '计算失败：' if zh else 'Error: '
            lines.append(f'❌ {esc(prefix + str(mon["error"]))}')
            continue

        asof = mon.get('asof')
        if asof:
            if run_date and asof < run_date:
                note = (
                    f'数据截至：{asof}（早于今日 {run_date}，可能休市或当日数据尚未公布）'
                    if zh else
                    f'Data as of: {asof} (behind {run_date}; holiday or exchange data not yet published)'
                )
                lines.append(f'⚠️ {esc(note)}')
            else:
                lines.append(esc(f'数据截至：{asof}' if zh else f'Data as of: {asof}'))

        if mon.get('blown_up'):
            lines.append(
                '⚠️ 回放中账户已爆仓，以下为停止当时的状态'
                if zh else '⚠️ Replay account blew up; showing state at halt',
            )

        rows = mon.get('symbols') or []
        actionable = [r for r in rows if r.get('operation') in ACTIONABLE_OPS]
        holdings = [
            r for r in rows
            if r.get('operation') not in ACTIONABLE_OPS and r.get('holding') in ('long', 'short')
        ]
        flats = [
            r for r in rows
            if r.get('operation') not in ACTIONABLE_OPS and r.get('holding') not in ('long', 'short')
        ]

        if actionable:
            lines.append('')
            sec = f'🔔 待执行操作（{len(actionable)}）' if zh else f'🔔 Actions Required ({len(actionable)})'
            lines.append(bold(sec))
            for r in actionable:
                holding = str(r.get('holding') or 'flat')
                op_text = _operation_label(str(r.get('operation') or ''), holding, language)
                tag = _symbol_tag(r, language)
                lines.append(f'• {bold(tag)}：{bold(op_text)}' if zh else f'• {bold(tag)}: {bold(op_text)}')

                meta_parts = []
                if zh:
                    meta_parts.append(f'当前持仓：{_holding_label(holding, "zh")}')
                    if r.get('entry_price') is not None:
                        meta_parts.append(f'入场均价：{_format_price(r["entry_price"])}')
                    if r.get('last_price') is not None:
                        meta_parts.append(f'最新价：{_format_price(r["last_price"])}')
                else:
                    meta_parts.append(f'Holding: {_holding_label(holding, "en")}')
                    if r.get('entry_price') is not None:
                        meta_parts.append(f'Entry: {_format_price(r["entry_price"])}')
                    if r.get('last_price') is not None:
                        meta_parts.append(f'Last: {_format_price(r["last_price"])}')
                lines.append(f'  {esc(" ｜ ".join(meta_parts) if zh else " | ".join(meta_parts))}')

                stop_s = _format_level(r.get('stop'), language)
                tp_s = _format_level(r.get('take_profit'), language)
                if zh:
                    lines.append(f'  {esc(f"止损：{stop_s} ｜ 止盈：{tp_s}")}')
                else:
                    lines.append(f'  {esc(f"Stop: {stop_s} | TP: {tp_s}")}')

        if holdings:
            lines.append('')
            sec = f'📦 当前持仓（{len(holdings)}）' if zh else f'📦 Open Holdings ({len(holdings)})'
            lines.append(bold(sec))
            for r in holdings:
                holding = str(r.get('holding') or 'flat')
                op_text = _operation_label(str(r.get('operation') or 'hold'), holding, language)
                tag = _symbol_tag(r, language)
                lines.append(f'• {bold(tag)}：{esc(op_text)}' if zh else f'• {bold(tag)}: {esc(op_text)}')

                meta_parts = []
                if zh:
                    if r.get('entry_price') is not None:
                        meta_parts.append(f'入场均价：{_format_price(r["entry_price"])}')
                    if r.get('last_price') is not None:
                        meta_parts.append(f'最新价：{_format_price(r["last_price"])}')
                else:
                    if r.get('entry_price') is not None:
                        meta_parts.append(f'Entry: {_format_price(r["entry_price"])}')
                    if r.get('last_price') is not None:
                        meta_parts.append(f'Last: {_format_price(r["last_price"])}')
                if meta_parts:
                    lines.append(f'  {esc(" ｜ ".join(meta_parts) if zh else " | ".join(meta_parts))}')

                stop_s = _format_level(r.get('stop'), language)
                tp_s = _format_level(r.get('take_profit'), language)
                if zh:
                    lines.append(f'  {esc(f"止损：{stop_s} ｜ 止盈：{tp_s}")}')
                else:
                    lines.append(f'  {esc(f"Stop: {stop_s} | TP: {tp_s}")}')

        if flats:
            lines.append('')
            sec = f'⚪ 空仓无操作（{len(flats)}）' if zh else f'⚪ Flat / No Action ({len(flats)})'
            lines.append(bold(sec))
            for r in flats:
                tag = _symbol_tag(r, language)
                lp = _format_price(r.get('last_price'))
                if zh:
                    lines.append(f'• {esc(tag)}：空仓（最新 {esc(lp)}）')
                else:
                    lines.append(f'• {esc(tag)}: Flat (last {esc(lp)})')

    return '\n'.join(lines)


def split_message_chunks(text: str, max_len: int = TELEGRAM_MAX_CHARS) -> List[str]:
    """Split a long message cleanly on blank lines / line breaks."""
    if len(text) <= max_len:
        return [text]

    chunks: List[str] = []
    current_lines: List[str] = []
    current_len = 0

    for line in text.split('\n'):
        line_len = len(line)
        added = line_len + (1 if current_lines else 0)
        if current_lines and current_len + added > max_len:
            chunks.append('\n'.join(current_lines))
            current_lines = []
            current_len = 0
        if line_len > max_len:
            # Rare fallback for a single abnormally long line.
            for start in range(0, line_len, max_len):
                piece = line[start:start + max_len]
                if len(piece) == max_len:
                    chunks.append(piece)
                else:
                    current_lines = [piece]
                    current_len = len(piece)
        else:
            current_lines.append(line)
            current_len += line_len + (1 if len(current_lines) > 1 else 0)

    if current_lines:
        chunks.append('\n'.join(current_lines))
    return chunks


# ---------------------------------------------------------------------
# Provider interface and registry
# ---------------------------------------------------------------------

class NotificationProvider(abc.ABC):
    kind: str
    label: str
    label_zh: str

    @abc.abstractmethod
    def validate_config(self, config: dict, existing: Optional[dict] = None) -> dict:
        """Validate and normalize provider-specific config before persistence."""

    @abc.abstractmethod
    def mask_config(self, config: dict) -> dict:
        """Return a safe copy for HTTP responses with secrets stripped/masked."""

    @abc.abstractmethod
    def send(
        self,
        channel_id: str,
        channel_name: str,
        config: dict,
        report: dict,
        *,
        language: str = 'zh',
    ) -> DeliveryResult:
        """Deliver ``report`` to the third-party platform."""

    def send_test(
        self,
        channel_id: str,
        channel_name: str,
        config: dict,
        *,
        language: str = 'zh',
    ) -> DeliveryResult:
        sample = {
            'event': 'futuresview.alert_test',
            'trigger': 'test',
            'generated_at': report_now_iso(),
            'run_date': report_now_iso()[:10],
            'run_time_label': (
                '测试消息' if language == 'zh' else 'Test Message'
            ),
            'data_update': {'updated': [], 'stale': [], 'failed': {}, 'skipped': True},
            'data_warnings': [],
            'monitors': [
                {
                    'id': 'test',
                    'name': '连接测试' if language == 'zh' else 'Connection Test',
                    'strategy': 'double_ma',
                    'params': {'fast': 10, 'slow': 30},
                    'asof': report_now_iso()[:10],
                    'blown_up': False,
                    'error': None,
                    'symbols': [
                        {
                            'symbol': 'SA',
                            'name_zh': '纯碱',
                            'contract': 'SA509',
                            'holding': 'long',
                            'operation': 'hold',
                            'entry_price': 1520.0,
                            'last_price': 1565.0,
                            'stop': {'price': 1490.0, 'distance': None},
                            'take_profit': {'price': 1640.0, 'distance': None},
                        },
                        {
                            'symbol': 'CF',
                            'name_zh': '棉花',
                            'contract': 'CF605',
                            'holding': 'flat',
                            'operation': 'open_long',
                            'entry_price': None,
                            'last_price': 14250.0,
                            'stop': {'price': None, 'distance': 120.0},
                            'take_profit': {'price': None, 'distance': None},
                        },
                    ],
                },
            ],
        }
        return self.send(channel_id, channel_name, config, sample, language=language)


def report_now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds')


# ---------------------------------------------------------------------
# Built-in providers: Telegram & Generic Webhook
# ---------------------------------------------------------------------

class TelegramProvider(NotificationProvider):
    kind = 'telegram'
    label = 'Telegram Bot'
    label_zh = 'Telegram 机器人'

    def validate_config(self, config: dict, existing: Optional[dict] = None) -> dict:
        if not isinstance(config, dict):
            raise ValueError('config must be an object')
        raw_token = config.get('bot_token')
        token = str(raw_token).strip() if raw_token is not None else ''
        if not token and existing:
            token = str(existing.get('bot_token') or '').strip()
        if not token:
            raise ValueError('bot_token is required')
        if any(ch.isspace() for ch in token):
            raise ValueError('bot_token must not contain whitespace')

        chat_id = str(config.get('chat_id') or '').strip()
        if not chat_id:
            raise ValueError('chat_id is required')

        api_base_raw = str(config.get('api_base') or '').strip()
        api_base = (
            _validate_http_url(api_base_raw, field_name='api_base').rstrip('/')
            if api_base_raw else DEFAULT_TELEGRAM_API_BASE
        )
        proxy = _validate_proxy_url(config.get('proxy'))

        thread_raw = config.get('message_thread_id')
        thread_id: Optional[int] = None
        if thread_raw not in (None, ''):
            try:
                thread_id = int(thread_raw)
            except (TypeError, ValueError) as exc:
                raise ValueError('message_thread_id must be an integer') from exc
            if thread_id <= 0:
                raise ValueError('message_thread_id must be positive')

        return {
            'bot_token': token,
            'chat_id': chat_id,
            'api_base': api_base,
            'proxy': proxy,
            'message_thread_id': thread_id,
        }

    def mask_config(self, config: dict) -> dict:
        token = str(config.get('bot_token') or '')
        return {
            'bot_token': '',
            'has_bot_token': bool(token),
            'bot_token_preview': _mask_secret(token),
            'chat_id': str(config.get('chat_id') or ''),
            'api_base': str(config.get('api_base') or DEFAULT_TELEGRAM_API_BASE),
            'proxy': str(config.get('proxy') or ''),
            'message_thread_id': config.get('message_thread_id'),
        }

    def send(
        self,
        channel_id: str,
        channel_name: str,
        config: dict,
        report: dict,
        *,
        language: str = 'zh',
    ) -> DeliveryResult:
        token = str(config.get('bot_token') or '').strip()
        chat_id = str(config.get('chat_id') or '').strip()
        api_base = str(config.get('api_base') or DEFAULT_TELEGRAM_API_BASE).rstrip('/')
        proxy = str(config.get('proxy') or '').strip()
        thread_id = config.get('message_thread_id')

        if not token or not chat_id:
            return DeliveryResult(
                channel_id=channel_id,
                channel_name=channel_name,
                kind=self.kind,
                ok=False,
                detail='Missing bot_token or chat_id',
            )

        html_text = format_report_text(report, language=language, use_html=True)
        chunks = split_message_chunks(html_text, TELEGRAM_MAX_CHARS)
        endpoint = f'{api_base}/bot{token}/sendMessage'

        last_status: Optional[int] = None
        try:
            with _make_client(proxy=proxy) as client:
                for chunk in chunks:
                    payload: Dict[str, Any] = {
                        'chat_id': chat_id,
                        'text': chunk,
                        'parse_mode': 'HTML',
                        'disable_web_page_preview': True,
                    }
                    if thread_id is not None:
                        payload['message_thread_id'] = int(thread_id)
                    resp = client.post(endpoint, json=payload)
                    last_status = resp.status_code
                    if resp.status_code >= 400:
                        desc = _extract_telegram_error(resp)
                        return DeliveryResult(
                            channel_id=channel_id,
                            channel_name=channel_name,
                            kind=self.kind,
                            ok=False,
                            status_code=resp.status_code,
                            detail=f'Telegram HTTP {resp.status_code}: {desc}',
                        )
                    try:
                        body = resp.json()
                    except ValueError:
                        body = {}
                    if isinstance(body, dict) and body.get('ok') is False:
                        return DeliveryResult(
                            channel_id=channel_id,
                            channel_name=channel_name,
                            kind=self.kind,
                            ok=False,
                            status_code=resp.status_code,
                            detail=f"Telegram API error: {body.get('description', 'unknown')}",
                        )
        except Exception as exc:  # noqa: BLE001 -- network/TLS/proxy errors must be caught per channel
            return DeliveryResult(
                channel_id=channel_id,
                channel_name=channel_name,
                kind=self.kind,
                ok=False,
                status_code=last_status,
                detail=f'{type(exc).__name__}: {exc}',
            )

        detail = (
            f'Sent ({len(chunks)} message{"s" if len(chunks) > 1 else ""})'
            if language != 'zh'
            else f'已发送（{len(chunks)} 条消息）'
        )
        return DeliveryResult(
            channel_id=channel_id,
            channel_name=channel_name,
            kind=self.kind,
            ok=True,
            status_code=last_status,
            detail=detail,
        )


def _extract_telegram_error(resp: httpx.Response) -> str:
    try:
        data = resp.json()
        if isinstance(data, dict) and data.get('description'):
            return str(data['description'])
    except ValueError:
        pass
    return (resp.text or '').strip()[:200] or 'request rejected'


def _substitute_json_node(node: Any, context: Dict[str, Any]) -> Any:
    if isinstance(node, dict):
        return {k: _substitute_json_node(v, context) for k, v in node.items()}
    if isinstance(node, list):
        return [_substitute_json_node(item, context) for item in node]
    if isinstance(node, str):
        stripped = node.strip()
        if stripped == '{{report}}':
            return context['report']
        if stripped == '{{monitors}}':
            return context['report'].get('monitors', [])
        out = node
        for token, value in (
            ('{{title}}', context['title']),
            ('{{text}}', context['text']),
            ('{{date}}', context['date']),
            ('{{generated_at}}', context['generated_at']),
            ('{{trigger}}', context['trigger']),
        ):
            if token in out:
                out = out.replace(token, str(value))
        return out
    return node


class WebhookProvider(NotificationProvider):
    kind = 'webhook'
    label = 'Generic Webhook'
    label_zh = '通用 Webhook'

    def validate_config(self, config: dict, existing: Optional[dict] = None) -> dict:
        if not isinstance(config, dict):
            raise ValueError('config must be an object')
        url = _validate_http_url(str(config.get('url') or ''), field_name='url')
        proxy = _validate_proxy_url(config.get('proxy'))

        clear_bearer = bool(config.get('clear_bearer_token'))
        raw_bearer = config.get('bearer_token')
        bearer = str(raw_bearer).strip() if raw_bearer is not None else ''
        if clear_bearer:
            bearer = ''
        elif not bearer and existing:
            bearer = str(existing.get('bearer_token') or '').strip()

        raw_headers = config.get('headers')
        headers: Dict[str, str] = {}
        if raw_headers not in (None, ''):
            if isinstance(raw_headers, str):
                try:
                    raw_headers = json.loads(raw_headers)
                except ValueError as exc:
                    raise ValueError(f'headers must be valid JSON: {exc}') from exc
            if not isinstance(raw_headers, dict):
                raise ValueError('headers must be a JSON object of string key-value pairs')
            for k, v in raw_headers.items():
                key = str(k).strip()
                if not key:
                    continue
                if '\r' in key or '\n' in key or '\r' in str(v) or '\n' in str(v):
                    raise ValueError('headers must not contain CR/LF characters')
                headers[key] = str(v)

        template = str(config.get('payload_template') or '').strip()
        if template:
            try:
                parsed = json.loads(template)
            except ValueError as exc:
                raise ValueError(f'payload_template must be valid JSON: {exc}') from exc
            if not isinstance(parsed, (dict, list)):
                raise ValueError('payload_template must be a JSON object or array')

        return {
            'url': url,
            'bearer_token': bearer,
            'headers': headers,
            'proxy': proxy,
            'payload_template': template,
        }

    def mask_config(self, config: dict) -> dict:
        bearer = str(config.get('bearer_token') or '')
        return {
            'url': str(config.get('url') or ''),
            'bearer_token': '',
            'has_bearer_token': bool(bearer),
            'bearer_token_preview': _mask_secret(bearer),
            'headers': dict(config.get('headers') or {}),
            'proxy': str(config.get('proxy') or ''),
            'payload_template': str(config.get('payload_template') or ''),
        }

    def send(
        self,
        channel_id: str,
        channel_name: str,
        config: dict,
        report: dict,
        *,
        language: str = 'zh',
    ) -> DeliveryResult:
        url = str(config.get('url') or '').strip()
        if not url:
            return DeliveryResult(
                channel_id=channel_id,
                channel_name=channel_name,
                kind=self.kind,
                ok=False,
                detail='Missing webhook url',
            )
        proxy = str(config.get('proxy') or '').strip()
        bearer = str(config.get('bearer_token') or '').strip()
        headers = {'Content-Type': 'application/json'}
        for k, v in (config.get('headers') or {}).items():
            headers[str(k)] = str(v)
        if bearer and not any(k.lower() == 'authorization' for k in headers):
            headers['Authorization'] = f'Bearer {bearer}'

        title = _report_title(report, language)
        text = format_report_text(report, language=language, use_html=False)
        enriched = {
            **report,
            'title': title,
            'text': text,
        }

        template = str(config.get('payload_template') or '').strip()
        if template:
            try:
                body = _substitute_json_node(
                    json.loads(template),
                    {
                        'report': enriched,
                        'title': title,
                        'text': text,
                        'date': str(report.get('run_date') or ''),
                        'generated_at': str(report.get('generated_at') or ''),
                        'trigger': str(report.get('trigger') or ''),
                    },
                )
            except Exception as exc:  # noqa: BLE001
                return DeliveryResult(
                    channel_id=channel_id,
                    channel_name=channel_name,
                    kind=self.kind,
                    ok=False,
                    detail=f'Invalid payload_template: {exc}',
                )
        else:
            body = enriched

        try:
            with _make_client(proxy=proxy) as client:
                resp = client.post(url, json=body, headers=headers)
        except Exception as exc:  # noqa: BLE001
            return DeliveryResult(
                channel_id=channel_id,
                channel_name=channel_name,
                kind=self.kind,
                ok=False,
                detail=f'{type(exc).__name__}: {exc}',
            )

        if resp.status_code >= 400:
            snippet = (resp.text or '').strip()[:200]
            return DeliveryResult(
                channel_id=channel_id,
                channel_name=channel_name,
                kind=self.kind,
                ok=False,
                status_code=resp.status_code,
                detail=f'HTTP {resp.status_code}: {snippet or "request rejected"}',
            )
        return DeliveryResult(
            channel_id=channel_id,
            channel_name=channel_name,
            kind=self.kind,
            ok=True,
            status_code=resp.status_code,
            detail=f'HTTP {resp.status_code}',
        )


# ---------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------

_PROVIDERS: Dict[str, NotificationProvider] = {}


def register_provider(provider: NotificationProvider) -> None:
    _PROVIDERS[provider.kind] = provider


def get_provider(kind: str) -> NotificationProvider:
    provider = _PROVIDERS.get((kind or '').strip().lower())
    if provider is None:
        supported = ', '.join(sorted(_PROVIDERS))
        raise ValueError(f'Unknown notification channel kind {kind!r} (supported: {supported})')
    return provider


def list_providers() -> List[dict]:
    return [
        {
            'kind': p.kind,
            'label': p.label,
            'label_zh': p.label_zh,
        }
        for p in _PROVIDERS.values()
    ]


register_provider(TelegramProvider())
register_provider(WebhookProvider())
