"""LRU cache over ``load_market``.

``load_market`` re-reads every symbol's CSV from disk on every call, which is
fine for a CLI run (one call, then the process exits) but not for a panel
where a user tries several strategies against the same universe/date range
back to back. Nothing downstream writes to a ``MarketData`` -- the engine,
strategies and indicators only read it -- so one cached object can be shared
across requests.
"""

from __future__ import annotations

import logging
import threading
from collections import OrderedDict
from typing import Optional, Tuple

from core.market import MarketData, build_market_data
from datafeed.data_manager import DataManager
from datafeed.products import require_products

from web.config import MARKET_CACHE_SIZE

logger = logging.getLogger('futuresview.web')

_Key = Tuple[Tuple[str, ...], Optional[str], Optional[str]]


def load_market(symbols, start: str, end: str, update: bool = False) -> MarketData:
    """Build the ``MarketData`` for ``symbols`` over ``[start, end]`` from disk."""
    resolved = require_products(symbols)
    dm = DataManager(symbols=resolved, update=update)
    universe = dm.get_universe_bundle(start_date=start, end_date=end)
    return build_market_data(universe)


class MarketCache:
    def __init__(self, maxsize: int = MARKET_CACHE_SIZE):
        self._maxsize = maxsize
        self._store: "OrderedDict[_Key, MarketData]" = OrderedDict()
        self._lock = threading.Lock()
        self._generation = 0

    @staticmethod
    def _key(symbols, start: Optional[str], end: Optional[str]) -> _Key:
        """Symbols in the order given -- deliberately not sorted."""
        return (tuple(symbols), start, end)

    def get(self, symbols, start: str, end: str, update: bool = False) -> MarketData:
        key = self._key(symbols, start, end)
        with self._lock:
            if not update:
                hit = self._store.get(key)
                if hit is not None:
                    self._store.move_to_end(key)
                    return hit
            gen = self._generation

        market = load_market(symbols, start, end, update=update)
        with self._lock:
            if self._generation == gen:
                self._store[key] = market
                self._store.move_to_end(key)
                while len(self._store) > self._maxsize:
                    evicted_key, _ = self._store.popitem(last=False)
                    logger.debug('MarketCache: evicted %s', evicted_key)
        return market

    def invalidate(self) -> None:
        """Drop everything -- called after a registry write or a data update,
        either of which can change what a cached ``MarketData`` reflects."""
        with self._lock:
            self._generation += 1
            self._store.clear()


cache = MarketCache()
