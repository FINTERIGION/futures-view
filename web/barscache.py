"""LRU cache over ``DataManager.load_dataframe``.

``load_dataframe`` re-reads the product's CSV on every call. That was fine
when the chart made one request per product (``/products/{code}/bars``), but
selecting several indicators fans out into one request per indicator, each of
which needs the same frame -- four indicators meant reading the same file four
times to compute a few microseconds of TA-Lib.

The cached frames are handed out by reference and must be treated as
read-only, the same contract ``web/marketcache.py`` documents for
``MarketData``. Every consumer here reads columns out to numpy
(``IndicatorContext._column``) or iterates rows (``product_bars``), so nothing
mutates one today; a future caller that wants to must ``.copy()`` first.

Invalidated alongside ``marketcache``: a registry write can change what a
symbol means, and a data update rewrites the CSV underneath it.
"""

from __future__ import annotations

import logging
import threading
from collections import OrderedDict
from typing import Optional, Tuple

from datafeed.data_manager import DataManager, normalize_series_name

from web.config import MARKET_CACHE_SIZE

logger = logging.getLogger('futuresview.web')

_Key = Tuple[str, str, Optional[str], Optional[str]]

#: Frames are far smaller than a ``MarketData`` panel and the fan-out is per
#: *indicator*, not per run, so this holds more entries than the market cache.
BARS_CACHE_SIZE = MARKET_CACHE_SIZE * 4


class BarsCache:
    def __init__(self, maxsize: int = BARS_CACHE_SIZE):
        self._maxsize = maxsize
        self._store: "OrderedDict[_Key, object]" = OrderedDict()
        self._lock = threading.Lock()
        self._generation = 0

    @staticmethod
    def _key(symbol: str, series: str, start: Optional[str], end: Optional[str]) -> _Key:
        return (symbol, series, start, end)

    def get(
        self,
        symbol: str,
        start: Optional[str] = None,
        end: Optional[str] = None,
        series: str = 'weighted',
    ):
        """Return a product's daily frame for ``series`` (``weighted``, ``main``,
        or ``m01``..``m12``). Raises whatever ``load_series_dataframe`` raises
        (``FileNotFoundError`` / ``ValueError``), so callers keep the route
        error mapping unchanged."""
        norm_series = normalize_series_name(series)
        key = self._key(symbol, norm_series, start, end)
        with self._lock:
            hit = self._store.get(key)
            if hit is not None:
                self._store.move_to_end(key)
                return hit
            gen = self._generation

        # Outside the lock: a slow read must not block every other symbol.
        df = DataManager(symbols=[symbol]).load_series_dataframe(
            series=norm_series, start_date=start, end_date=end, symbol=symbol,
        )
        with self._lock:
            if self._generation == gen:
                self._store[key] = df
                self._store.move_to_end(key)
                while len(self._store) > self._maxsize:
                    evicted_key, _ = self._store.popitem(last=False)
                    logger.debug('BarsCache: evicted %s', evicted_key)
        return df

    def invalidate(self) -> None:
        """Drop everything -- called after a registry write or a data update,
        either of which can change what a cached frame reflects."""
        with self._lock:
            self._generation += 1
            self._store.clear()


cache = BarsCache()
