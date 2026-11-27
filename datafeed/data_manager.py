"""
Data Management Module
Responsible for loading, processing, and updating futures data.

Produces plain pandas DataFrames (no backtrader feed objects). The weighted
series is aligned/ffilled onto the shared calendar for indicator use; each
real contract keeps only the bars where it actually printed -- see
``core.market.build_market_data``, which turns this bundle into a
``MarketData`` instance.
"""

import logging
import os
import re

import pandas as pd

DATAFEED_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(DATAFEED_DIR)

logger = logging.getLogger(__name__)

from .data_update import DataUpdate
from .products import require_products, roll_rule
from .roll_calendar import (
    annotate_expiries,
    build_date_contract_map,
    colliding_codes,
    contract_feed_name,
    mapping_as_dates,
    normalize_contract_code,
    roll_date,
)

_PRICE_COLS = ['open', 'high', 'low', 'close', 'settle']
_ALIGN_COLS = ['open', 'high', 'low', 'close', 'settle', 'oi', 'volume']
_MONTH_SERIES_RE = re.compile(r'^m(0[1-9]|1[0-2])$')


def normalize_series_name(series: str | None) -> str:
    """Validate and canonicalise a chart bar series selector.

    Supported values:
      * ``'weighted'`` -- OI-weighted continuous index (default)
      * ``'main'``     -- calendar-roll main continuous contract
      * ``'m01'``..``'m12'`` -- delivery-month continuous contract
    """
    if series is None:
        return 'weighted'
    text = str(series).strip().lower()
    if not text or text == 'weighted':
        return 'weighted'
    if text == 'main':
        return 'main'
    if _MONTH_SERIES_RE.match(text):
        return text
    raise ValueError(
        f"Unsupported series {series!r}; expected 'weighted', 'main', or 'm01'..'m12'"
    )


class DataManager:
    """
    Data manager.
    Loads, filters, and updates futures weighted data and contract-level bars
    for one or more registered products.
    """

    DATA_DIR = os.path.join(ROOT_DIR, 'data')

    def __init__(self, symbols=None, symbol: str = None, update: bool = False):
        """
        Parameters
        ----------
        symbols : list[str], optional
            Product codes to load, e.g. ``['SA', 'CF', 'RB', 'C']``.
        symbol : str, optional
            Single-product alias used when ``symbols`` is omitted.
        update : bool
            Whether to refresh data from the exchange first. Incremental: CZCE
            re-fetches the current year, SHFE and DCE the last few days.
        """
        if symbols is None:
            symbols = [symbol] if symbol else ['SA']
        self.symbols = require_products(symbols)
        self.symbol = self.symbols[0]

        if update:
            self._update_data()

    def weighted_path(self, symbol: str = None) -> str:
        return os.path.join(self.DATA_DIR, f'{self._sym(symbol)}_weighted.csv')

    def raw_path(self, symbol: str = None) -> str:
        return os.path.join(self.DATA_DIR, f'{self._sym(symbol)}.csv')

    def _sym(self, symbol: str = None) -> str:
        return (symbol or self.symbol).upper()

    # ------------------------------------------------------------------
    # Internal methods
    # ------------------------------------------------------------------

    def _update_data(self):
        """Refresh exchange history incrementally and regenerate weighted data.

        A product the exchange only partly handed over does not abort the run --
        the cached history still backtests -- but it is called out, because the
        alternative is a backtest silently ending a few days short.
        """
        stale = []
        for symbol in self.symbols:
            try:
                path = self.weighted_path(symbol)
                logger.info("Updating %s data ...", symbol)
                job = DataUpdate(symbol)
                job.update()
                if job.stale_keys:
                    stale.append(symbol)
                logger.info("%s data update done. Path: %s", symbol, path)
            except Exception as e:
                logger.error("Data update failed for %s: %s", symbol, e)
                raise
        if stale:
            logger.warning(
                "Incomplete download for %s -- backtesting on cached history "
                "that may be behind the exchange.", ", ".join(stale),
            )

    @staticmethod
    def _align_contract_ohlc(cdf: pd.DataFrame, index: pd.DatetimeIndex) -> pd.DataFrame:
        """Reindex one series onto the shared calendar without looking ahead.

        Real prints keep their OHLC. Days with no print are *not* tradable
        (``session=0``). After the first print, close/settle/oi are ffilled so
        existing positions can mark to the last session; open/high/low are
        flattened to that close so a dark bar cannot print a fake open.
        ``bfill`` is never used.

        Settle is carried, not flattened with the others. It used to be set to
        the carried *close*, which put a ``close - settle`` step into any
        settle-to-settle series on a day nothing traded -- and a second one,
        the other way, on the next day that did.
        """
        frame = cdf.copy()
        for col in _ALIGN_COLS:
            if col not in frame.columns:
                frame[col] = float('nan')
        out = frame[_ALIGN_COLS].reindex(index)
        session = out['close'].notna()
        out[_PRICE_COLS] = out[_PRICE_COLS].ffill()
        out['oi'] = out['oi'].ffill().fillna(0)
        out['volume'] = out['volume'].where(session, 0).fillna(0)
        out['session'] = session.astype(float)
        dark = out['close'].notna() & ~session
        for col in ('open', 'high', 'low'):
            out.loc[dark, col] = out.loc[dark, 'close']
        return out

    def _read_weighted(self, symbol: str) -> pd.DataFrame:
        path = self.weighted_path(symbol)
        if not os.path.exists(path):
            raise FileNotFoundError(
                f"Weighted data file not found: {path}\n"
                "Run python -m datafeed.data_update first, or pass update=True "
                "when constructing DataManager."
            )

        df = pd.read_csv(path, parse_dates=['date'])
        df.set_index('date', inplace=True)
        df.index = pd.to_datetime(df.index).normalize()
        df = df[~df.index.duplicated(keep='last')]
        df.sort_index(inplace=True)
        return df

    # ------------------------------------------------------------------
    # Public methods
    # ------------------------------------------------------------------

    def load_dataframe(
        self,
        start_date: str = None,
        end_date: str = None,
        symbol: str = None,
    ) -> pd.DataFrame:
        """
        Load the weighted CSV data and return a DataFrame filtered by date.

        Parameters
        ----------
        start_date : str, optional
            Start date, formatted as 'YYYY-MM-DD'.
        end_date : str, optional
            End date, formatted as 'YYYY-MM-DD'.
        symbol : str, optional
            Product code. Defaults to the first loaded symbol.

        Returns
        -------
        pd.DataFrame
            Columns: date(index), open, high, low, close, settle, oi, volume.
        """
        symbol = self._sym(symbol)
        df = self._read_weighted(symbol)

        if start_date:
            df = df[df.index >= pd.to_datetime(start_date)]
        if end_date:
            df = df[df.index <= pd.to_datetime(end_date)]

        if df.empty:
            raise ValueError(
                f"Filtered data is empty for {symbol}. Check that the date range "
                f"[{start_date}, {end_date}] falls within the available data."
            )

        return df

    @staticmethod
    def _finalize_contract_series(
        rows: pd.DataFrame,
        symbol: str,
        series: str,
        start_date: str = None,
        end_date: str = None,
    ) -> pd.DataFrame:
        if rows.empty:
            raise ValueError(f"No contract bars available for {symbol} ({series})")
        out = rows.copy()
        out['date'] = pd.to_datetime(out['date']).dt.normalize()
        out = out.sort_values('date').drop_duplicates(subset=['date'], keep='last')
        out.set_index('date', inplace=True)
        for col in _ALIGN_COLS:
            if col not in out.columns:
                out[col] = 0.0 if col in ('oi', 'volume') else float('nan')
            else:
                out[col] = pd.to_numeric(out[col], errors='coerce')
        out['oi'] = out['oi'].fillna(0.0)
        out['volume'] = out['volume'].fillna(0.0)
        if 'settle' in out.columns:
            bad_settle = out['settle'].isna() | (out['settle'] <= 0)
            if bad_settle.any():
                out.loc[bad_settle, 'settle'] = out.loc[bad_settle, 'close']
        out = out[_ALIGN_COLS + ['contract']]

        if start_date:
            out = out[out.index >= pd.to_datetime(start_date)]
        if end_date:
            out = out[out.index <= pd.to_datetime(end_date)]
        if out.empty:
            raise ValueError(
                f"Filtered data is empty for {symbol} ({series}). Check that the date range "
                f"[{start_date}, {end_date}] falls within the available data."
            )
        return out

    def load_series_dataframe(
        self,
        series: str = 'weighted',
        start_date: str = None,
        end_date: str = None,
        symbol: str = None,
    ) -> pd.DataFrame:
        """Load a daily OHLCV frame for ``weighted``, ``main``, or ``m01``..``m12``.

        ``weighted`` delegates directly to :meth:`load_dataframe`.
        ``main`` builds the calendar-roll dominant continuous contract from
        ``data/{symbol}.csv`` using the product's declared ``main_months`` and
        ``roll_lead_months`` (matching the backtest execution roll calendar).
        ``m01``..``m12`` builds a continuous series for a single delivery month,
        rolling smoothly into next year's contract once the expiring contract
        passes its roll date and next year's contract has started printing.
        """
        norm = normalize_series_name(series)
        symbol = self._sym(symbol)
        if norm == 'weighted':
            return self.load_dataframe(start_date=start_date, end_date=end_date, symbol=symbol)

        raw = annotate_expiries(
            self._drop_priceless_rows(self.load_contracts_dataframe(symbol), symbol)
        )
        if raw.empty:
            raise ValueError(f"No usable contract rows in data/{symbol}.csv")

        rule = roll_rule(symbol)
        lead = rule['lead_months']

        if norm == 'main':
            trading_index = pd.DatetimeIndex(sorted(raw['date'].unique()))
            mapping = build_date_contract_map(
                trading_index,
                raw,
                warn=False,
                main_months=rule['main_months'],
                lead_months=lead,
            )
            if not mapping:
                raise ValueError(
                    f"Roll calendar produced no main contracts for {symbol}. "
                    f"Check data/{symbol}.csv coverage."
                )
            colliding = colliding_codes(raw, trading_index.min(), trading_index.max())
            feed_names = [
                contract_feed_name(code, expiry, colliding)
                for code, expiry in zip(raw['contract'], raw['expiry'])
            ]
            keep = [
                mapping.get(dt) == fname
                for dt, fname in zip(raw['date'], feed_names)
            ]
            selected = raw.loc[keep]
            return self._finalize_contract_series(
                selected, symbol, norm, start_date=start_date, end_date=end_date,
            )

        target_month = int(norm[1:])
        subset = raw[raw['expiry'].map(lambda e: e[1] == target_month)].copy()
        if subset.empty:
            raise ValueError(f"No contract data for {symbol} month {target_month:02d}")

        dup_mask = subset.duplicated(subset=['date'], keep=False)
        singles = subset.loc[~dup_mask]
        overlaps = subset.loc[dup_mask]
        if overlaps.empty:
            selected = singles
        else:
            picked_indices = []
            for dt, grp in overlaps.groupby('date', sort=False):
                # Prefer the nearest expiry whose roll date has not yet arrived;
                # if every overlapping contract is already past its roll date,
                # pick the latest expiry (breaking ties by higher OI).
                active_rows = []
                fallback_rows = []
                for idx, row in grp.iterrows():
                    oi_val = pd.to_numeric(row.get('oi', 0), errors='coerce')
                    oi_num = 0.0 if pd.isna(oi_val) else float(oi_val)
                    exp = row['expiry']
                    if roll_date(exp, lead) > dt:
                        active_rows.append((exp, -oi_num, idx))
                    else:
                        fallback_rows.append((exp, oi_num, idx))
                if active_rows:
                    active_rows.sort()
                    picked_indices.append(active_rows[0][2])
                else:
                    fallback_rows.sort(reverse=True)
                    picked_indices.append(fallback_rows[0][2])
            selected = pd.concat([singles, overlaps.loc[picked_indices]], axis=0)

        return self._finalize_contract_series(
            selected, symbol, norm, start_date=start_date, end_date=end_date,
        )

    def load_contracts_dataframe(self, symbol: str = None) -> pd.DataFrame:
        """Load contract-level exchange history from ``data/{symbol}.csv``."""
        symbol = self._sym(symbol)
        path = self.raw_path(symbol)
        if not os.path.exists(path):
            raise FileNotFoundError(
                f"Contract data file not found: {path}\n"
                "Run python -m datafeed.data_update first, or pass update=True "
                "when constructing DataManager."
            )

        df = pd.read_csv(path)
        if 'date' not in df.columns or 'contract' not in df.columns:
            raise ValueError(
                f"{path} must contain 'date' and 'contract' columns"
            )
        df['date'] = pd.to_datetime(df['date'].astype(str), errors='coerce')
        df = df.dropna(subset=['date'])
        df['contract'] = df['contract'].map(normalize_contract_code)
        df = df[df['contract'] != '']
        df.sort_values(['date', 'contract'], inplace=True)
        return df.reset_index(drop=True)

    def _contract_segments(
        self, raw: pd.DataFrame, index: pd.DatetimeIndex
    ) -> list:
        """Split ``raw`` into (feed_name, frame) pairs for one backtest window.

        Same 3-digit code in two decades becomes two segments so 2015 FG501
        prices are not carried into the 2025 FG501 series.
        """
        if raw.empty or index.empty:
            return []
        start, end = index.min(), index.max()
        df = raw if 'expiry' in raw.columns else annotate_expiries(raw)
        window = df[(df['date'] >= start) & (df['date'] <= end)]
        colliding = colliding_codes(df, start, end)
        segments = []
        seen = set()
        for (code, expiry), grp in window.groupby(['contract', 'expiry'], sort=False):
            name = contract_feed_name(code, expiry, colliding)
            if name in seen:
                continue
            seen.add(name)
            segments.append((name, grp))
        return segments

    def _raw_contract_frames(self, segments: list, symbol: str) -> dict:
        """Only-real-prints frames per contract: no calendar reindex, no ffill.

        This is what ``core.market.ContractSeries`` is built from -- a
        63-contract x 1610-bar union calendar would be ~85% padding; keeping
        just the real rows is the whole point.
        """
        frames = {}
        for name, cdf in segments:
            if cdf.empty:
                logger.warning("Skipping %s: no rows in %s.csv", name, symbol)
                continue
            frame = cdf.copy().set_index('date').sort_index()
            frame.index = pd.to_datetime(frame.index).normalize()
            frame = frame[~frame.index.duplicated(keep='last')]
            for col in _ALIGN_COLS:
                if col not in frame.columns:
                    frame[col] = float('nan')
            frame = frame[_ALIGN_COLS].dropna(subset=['close'])
            if frame.empty:
                logger.warning("Skipping %s: no usable OHLC", name)
                continue
            frames[name] = frame
        return frames

    @staticmethod
    def _drop_priceless_rows(raw: pd.DataFrame, symbol: str) -> pd.DataFrame:
        """Drop contract rows missing any of open/high/low/close.

        SHFE lists every contract every day, and on a day one did not trade it
        publishes close and settle with open/high/low left blank. Kept, such a
        row reads as a real print: the engine fills an order or a roll at its
        open, the NaN becomes the position's average entry, and equity is NaN
        from then on -- which is how every risk-sized run on AG or AU died on
        ``int(nan)``. Dropped, the day is dark for that contract, exactly like a
        day with no row at all: nothing fills on it and an open position
        carries its last mark.

        Done before the roll calendar is built, so the calendar never names a
        contract on a day it has no price. CZCE and DCE publish their
        zero-volume days with a full OHLC, so this leaves them untouched: a row
        is dropped for a missing price, never for merely not trading.
        """
        cols = [c for c in ('open', 'high', 'low', 'close') if c in raw.columns]
        numeric = raw[cols].apply(pd.to_numeric, errors='coerce')
        keep = numeric.notna().all(axis=1) & (numeric > 0).all(axis=1)
        dropped = int((~keep).sum())
        if dropped:
            logger.debug('%s: dropped %d contract row(s) with missing or non-positive OHLC', symbol, dropped)
        out = raw[keep].copy()
        if 'settle' in out.columns and 'close' in out.columns:
            settle = pd.to_numeric(out['settle'], errors='coerce')
            bad_settle = settle.isna() | (settle <= 0)
            if bad_settle.any():
                out.loc[bad_settle, 'settle'] = out.loc[bad_settle, 'close']
        return out

    def _bundle_symbol(
        self,
        symbol: str,
        weighted_src: pd.DataFrame,
        calendar: pd.DatetimeIndex,
        first_print,
    ) -> dict:
        """Build the weighted series + real-contract bundle for one product."""
        raw = annotate_expiries(
            self._drop_priceless_rows(self.load_contracts_dataframe(symbol), symbol)
        )
        weighted_df = self._align_contract_ohlc(weighted_src, calendar)

        rule = roll_rule(symbol)
        mapping = build_date_contract_map(
            calendar,
            raw,
            listed_from=first_print,
            main_months=rule['main_months'],
            lead_months=rule['lead_months'],
        )
        calendar_codes = []
        seen_cal = set()
        for code in mapping.values():
            if code not in seen_cal:
                seen_cal.add(code)
                calendar_codes.append(code)

        if not calendar_codes:
            raise ValueError(
                f"Roll calendar produced no contracts for {symbol}. "
                f"Check data/{symbol}.csv coverage."
            )

        segments = self._contract_segments(raw, calendar)
        names = [name for name, _ in segments]
        seen = set(names)
        extra = []
        for code in calendar_codes:
            if code not in seen:
                extra.append(code)
                seen.add(code)
        if extra:
            # Calendar name missing from window segments: include matching rows
            colliding = colliding_codes(raw, calendar.min(), calendar.max())
            by_name = {}
            for (code, expiry), grp in raw.groupby(['contract', 'expiry'], sort=False):
                by_name[contract_feed_name(code, expiry, colliding)] = grp
            for name in extra:
                if name in by_name:
                    segments.append((name, by_name[name]))

        contract_frames = self._raw_contract_frames(segments, symbol)

        missing = [c for c in calendar_codes if c not in contract_frames]
        if missing:
            raise ValueError(
                f"{symbol} calendar contracts have no aligned OHLC: {missing}"
            )

        exec_close = []
        exec_code = []
        for dt in calendar:
            key = pd.Timestamp(dt).normalize()
            code = mapping.get(key)
            frame = contract_frames.get(code) if code else None
            if frame is None or key not in frame.index:
                exec_close.append(float('nan'))
                exec_code.append('')
                continue
            exec_close.append(float(frame.loc[key, 'close']))
            exec_code.append(code)
        exec_price_df = pd.DataFrame(
            {'close': exec_close, 'contract': exec_code},
            index=calendar,
        )

        n_cal = len(calendar_codes)
        n_all = len(contract_frames)
        logger.info(
            "%s feeds: weighted + %d contracts (%d calendar: %s); "
            "main months %s, rolled %d month(s) before delivery",
            symbol, n_all, n_cal, ', '.join(calendar_codes),
            '/'.join(f'{m:02d}' for m in rule['main_months']),
            rule['lead_months'],
        )

        return {
            'weighted_df': weighted_df,
            'contract_frames': contract_frames,
            'contract_by_date': mapping_as_dates(mapping),
            'calendar_codes': calendar_codes,
            'exec_price_df': exec_price_df,
            'first_print': first_print,
        }

    def get_universe_bundle(
        self,
        start_date: str = None,
        end_date: str = None,
    ) -> dict:
        """Build weighted + real-contract bundles for every loaded product.

        All products are aligned onto the union of their weighted calendars
        inside the backtest window so the engine can step them together.
        Missing days are *not* backfilled; ``session=0`` bars are not tradable.

        Returns
        -------
        dict
            symbols, calendar, products[symbol] -> per-product bundle
        """
        frames = {}
        first_prints = {}
        for symbol in self.symbols:
            full = self._read_weighted(symbol)
            if full.empty:
                raise ValueError(f'{symbol} weighted data is empty')
            first_prints[symbol] = pd.Timestamp(full.index.min()).date()
            df = full
            if start_date:
                df = df[df.index >= pd.to_datetime(start_date)]
            if end_date:
                df = df[df.index <= pd.to_datetime(end_date)]
            if df.empty:
                raise ValueError(
                    f"Filtered data is empty for {symbol}. Check that the date range "
                    f"[{start_date}, {end_date}] falls within the available data."
                )
            frames[symbol] = df

        calendar = frames[self.symbols[0]].index
        for symbol in self.symbols[1:]:
            calendar = calendar.union(frames[symbol].index)
        calendar = calendar.sort_values()

        products = {}
        for symbol in self.symbols:
            products[symbol] = self._bundle_symbol(
                symbol, frames[symbol], calendar, first_prints[symbol]
            )

        return {
            'symbols': list(self.symbols),
            'calendar': calendar,
            'products': products,
        }

    def get_contract_bundle(
        self,
        start_date: str = None,
        end_date: str = None,
        symbol: str = None,
    ) -> dict:
        """Build weighted + all real-contract frames for one product.

        Prefer ``get_universe_bundle`` when loading more than one symbol.
        """
        symbol = self._sym(symbol)
        if self.symbols == [symbol]:
            universe = self.get_universe_bundle(start_date, end_date)
            return universe['products'][symbol]
        dm = DataManager(symbols=[symbol], update=False)
        universe = dm.get_universe_bundle(start_date, end_date)
        return universe['products'][symbol]

    def get_raw_dataframe(self, symbol: str = None) -> pd.DataFrame:
        """Return the full unfiltered weighted DataFrame (useful for plotting, etc.)."""
        return self.load_dataframe(symbol=symbol)
