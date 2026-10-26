"""Replay a strategy to the latest bar and return the pending action.

Not a backtest: nothing is written to run history, metrics are not scored,
and lots never leave the engine. The job exists only because a multi-year
replay is too slow for one HTTP request, the same reason ``/api/backtest``
is a job.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from core.alert import run_alert_snapshot
from core.params import validated_overrides
from datafeed.products import require_products
from strategies import load_registered_strategy

from web.jobs import manager as job_manager
from web.marketcache import cache as market_cache
from web.schemas import AlertPreviewRequest
from web.serialize import jsonable

router = APIRouter(prefix='/api', tags=['alerts'])


@router.post('/alerts/preview')
def start_alert_preview(body: AlertPreviewRequest):
    try:
        symbols = require_products(body.symbols)
        strategy_cls = load_registered_strategy(body.strategy)
        params = validated_overrides(strategy_cls, body.params)
    except (KeyError, ValueError) as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    def run(job):
        job.message = 'Loading market data'
        # Both ends are filled by ``AlertPreviewRequest``'s validator.
        market = market_cache.get(symbols, body.start or '', body.end or '')
        job.progress = 0.3
        job.message = f'Previewing {strategy_cls.__name__}'
        snapshot = run_alert_snapshot(market, strategy_cls, params)
        job.progress = 1.0
        return jsonable(snapshot)

    job = job_manager.submit('alert', run)
    return {'job_id': job.id}
