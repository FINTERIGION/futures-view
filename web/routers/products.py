"""Product registry CRUD, price data for the chart, and roll-calendar
lookup. See ``datafeed/products.py`` for the underlying registry and
``web/data_status.py`` for the on-disk coverage helper.
"""

from __future__ import annotations

import os

from fastapi import APIRouter, HTTPException, Query

from datafeed.data_manager import DataManager, normalize_series_name
from datafeed.products import (
    DEFAULT_MAIN_MONTHS,
    DEFAULT_ROLL_LEAD_MONTHS,
    SUPPORTED_EXCHANGES,
    get_product,
    list_products,
    normalize_symbol,
    product_costs,
    roll_rule,
    save_registry,
)

from web.barscache import cache as bars_cache
from web.data_status import coverage_for, data_file_paths
from web.jobs import manager as job_manager
from web.marketcache import cache as market_cache
from web.schemas import ProductIn
from web.serialize import jsonable

router = APIRouter(prefix='/api', tags=['products'])


def _mutate_registry(mutator) -> None:
    """Run ``mutator(registry_copy)`` and persist atomically while no job runs.

    Reading ``PRODUCTS``, mutating, writing ``products.json``, and invalidating
    both caches all execute inside ``hold_starts`` so concurrent edits cannot
    clobber each other and no newly started job can read stale cached frames.
    """
    with job_manager.hold_starts():
        if job_manager.any_active():
            raise HTTPException(
                status_code=409,
                detail='A job is running. Product edits are held while a backtest or '
                       'data update is in progress, because the engine reads costs and '
                       'roll rules live, per fill.',
            )
        registry = {code: get_product(code) for code in list_products()}
        mutator(registry)
        try:
            save_registry(registry)
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
        market_cache.invalidate()
        bars_cache.invalidate()


def _product_view(code: str) -> dict:
    meta = get_product(code)
    return {
        'code': code,
        **meta,
        'costs': product_costs(code),
        'roll': roll_rule(code),
        'coverage': coverage_for(code),
    }


@router.get('/products')
def list_all_products():
    return [_product_view(code) for code in list_products()]


@router.get('/products/{code}')
def get_one_product(code: str):
    code = normalize_symbol(code)
    try:
        return _product_view(code)
    except KeyError:
        raise HTTPException(status_code=404, detail=f'Unknown product {code!r}') from None


@router.post('/products/{code}', status_code=201)
def create_product(code: str, body: ProductIn):
    """``code`` in the path, matching PUT and DELETE."""
    code = normalize_symbol(code)

    def _add(registry: dict) -> None:
        if code in registry:
            raise HTTPException(status_code=409, detail=f'{code} already exists; use PUT to edit it')
        registry[code] = body.to_registry_entry()

    _mutate_registry(_add)
    return _product_view(code)


@router.put('/products/{code}')
def update_product(code: str, body: ProductIn):
    code = normalize_symbol(code)

    def _edit(registry: dict) -> None:
        if code not in registry:
            raise HTTPException(status_code=404, detail=f'Unknown product {code!r}')
        registry[code] = body.to_registry_entry()

    _mutate_registry(_edit)
    return _product_view(code)


@router.delete('/products/{code}')
def delete_product(code: str, purge_data: bool = Query(False)):
    code = normalize_symbol(code)

    def _remove(registry: dict) -> None:
        if code not in registry:
            raise HTTPException(status_code=404, detail=f'Unknown product {code!r}')
        del registry[code]

    _mutate_registry(_remove)

    removed = []
    if purge_data:
        for path in data_file_paths(code):
            try:
                os.remove(path)
                removed.append(path)
            except FileNotFoundError:
                pass

    return {'deleted': code, 'purged_files': removed}


@router.get('/products/{code}/bars')
def product_bars(
    code: str,
    start: str = None,
    end: str = None,
    series: str = Query('weighted'),
):
    code = normalize_symbol(code)
    try:
        get_product(code)
    except KeyError:
        raise HTTPException(status_code=404, detail=f'Unknown product {code!r}') from None
    try:
        norm_series = normalize_series_name(series)
        df = bars_cache.get(code, start, end, series=norm_series)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    rows = [
        {'date': str(idx.date()), **{c: row[c] for c in df.columns}}
        for idx, row in df.iterrows()
    ]
    return jsonable({'symbol': code, 'series': norm_series, 'bars': rows})


@router.get('/products/{code}/roll')
def product_roll(code: str, start: str = None, end: str = None):
    code = normalize_symbol(code)
    try:
        get_product(code)
    except KeyError:
        raise HTTPException(status_code=404, detail=f'Unknown product {code!r}') from None
    try:
        dm = DataManager(symbols=[code])
        bundle = dm.get_universe_bundle(start_date=start, end_date=end)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    exec_df = bundle['products'][code]['exec_price_df']
    rows = [
        {'date': str(idx.date()), 'contract': row['contract'], 'close': row['close']}
        for idx, row in exec_df.iterrows()
        if row['contract']
    ]
    return jsonable({'symbol': code, 'roll': rows})


@router.get('/meta/exchanges')
def meta_exchanges():
    return {
        'exchanges': list(SUPPORTED_EXCHANGES),
        'default_main_months': list(DEFAULT_MAIN_MONTHS),
        'default_roll_lead_months': DEFAULT_ROLL_LEAD_MONTHS,
    }
