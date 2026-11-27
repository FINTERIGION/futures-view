"""DataManager's contract-level loading, on a throwaway data directory."""

from __future__ import annotations

import numpy as np
import pandas as pd

from datafeed.data_manager import DataManager
from datafeed.products import roll_rule
from datafeed.roll_calendar import target_expiry

_NO_PRICE = {'open': np.nan, 'high': np.nan, 'low': np.nan}


def test_a_contract_row_with_a_blank_open_is_not_a_print(tmp_path, monkeypatch):
    """SHFE lists every contract every day and, on a day one did not trade,
    publishes close and settle with open/high/low left blank. Loaded as a
    print, that row put a NaN open under any fill or roll landing on it, and
    the NaN equity that followed killed every risk-sized AG or AU run.
    """
    monkeypatch.setattr(DataManager, 'DATA_DIR', str(tmp_path))
    dates = pd.bdate_range('2025-03-03', periods=5)
    rule = roll_rule('AG')
    expiries = {target_expiry(d, rule['main_months'], rule['lead_months']) for d in dates}
    assert len(expiries) == 1, 'the window must not straddle a roll'
    year, month = expiries.pop()
    assert month <= 10
    live = f'AG{year % 100:02d}{month:02d}'
    idle = f'AG{year % 100:02d}{month + 2:02d}'   # listed, never traded in the window

    rows = []
    for i, day in enumerate(dates):
        px = 8000.0 + i
        prices = _NO_PRICE if i == 2 else {'open': px, 'high': px + 5, 'low': px - 5}
        rows.append({'date': day, 'contract': live, **prices, 'close': px,
                     'oi': 300, 'volume': 0.0 if i == 2 else 100.0, 'settle': px})
        rows.append({'date': day, 'contract': idle, **_NO_PRICE, 'close': px + 20,
                     'oi': 10, 'volume': 0.0, 'settle': px + 20})
    contracts = pd.DataFrame(rows)
    contracts['date'] = contracts['date'].dt.strftime('%Y-%m-%d')
    contracts.to_csv(tmp_path / 'AG.csv', index=False)
    pd.DataFrame({
        'date': dates.strftime('%Y-%m-%d'), 'open': 8000.0, 'high': 8005.0, 'low': 7995.0,
        'close': 8000.0, 'settle': 8000.0, 'oi': 300, 'volume': 100.0,
    }).to_csv(tmp_path / 'AG_weighted.csv', index=False)

    bundle = DataManager(symbols=['AG']).get_universe_bundle()['products']['AG']

    frames = bundle['contract_frames']
    assert idle not in frames
    assert list(frames[live].index) == [dates[0], dates[1], dates[3], dates[4]]
    assert not frames[live][['open', 'high', 'low', 'close']].isna().any().any()
    # The untraded day is dark for the product rather than a day to fill on.
    assert bundle['exec_price_df'].loc[dates[2], 'contract'] == ''
    assert bundle['exec_price_df'].loc[dates[1], 'contract'] == live


def test_a_dark_bar_carries_the_last_settle_and_flattens_to_the_last_close():
    """Nothing traded, so nothing moved: open/high/low collapse onto the
    carried close, and settle carries its own last value rather than taking
    the close's -- which used to put a spurious ``close - settle`` step into a
    settle-to-settle return on the dark day."""
    days = pd.to_datetime(['2025-03-03', '2025-03-04', '2025-03-05'])
    frame = pd.DataFrame(
        {'open': [100.0, 104.0], 'high': [106.0, 108.0], 'low': [99.0, 103.0],
         'close': [105.0, 107.0], 'settle': [102.0, 106.0], 'oi': [50.0, 60.0],
         'volume': [10.0, 12.0]},
        index=days[[0, 2]],
    )
    out = DataManager._align_contract_ohlc(frame, days)

    dark = out.loc[days[1]]
    assert dark['session'] == 0.0
    assert (dark['open'], dark['high'], dark['low'], dark['close']) == (105.0, 105.0, 105.0, 105.0)
    assert dark['settle'] == 102.0
    assert dark['volume'] == 0.0 and dark['oi'] == 50.0


def test_load_series_dataframe_supports_main_and_month_continuous(tmp_path, monkeypatch):
    """Main continuous follows the product's roll calendar; month continuous
    (e.g. m01/m06) stitches contracts of one delivery month and smoothly rolls
    into next year's contract when overlap dates pass the roll date."""
    import pytest

    monkeypatch.setattr(DataManager, 'DATA_DIR', str(tmp_path))
    rows = [
        # SA main_months=(1, 5, 9), lead=1: March -> 05, April -> 09
        {'date': '2025-03-31', 'contract': 'SA505', 'open': 1500, 'high': 1510, 'low': 1495, 'close': 1505, 'oi': 1000, 'volume': 500, 'settle': 1504},
        {'date': '2025-03-31', 'contract': 'SA509', 'open': 1520, 'high': 1530, 'low': 1515, 'close': 1525, 'oi': 400, 'volume': 200, 'settle': 1524},
        {'date': '2025-03-31', 'contract': 'SA601', 'open': 1560, 'high': 1570, 'low': 1555, 'close': 1565, 'oi': 120, 'volume': 60, 'settle': 1564},
        {'date': '2025-04-01', 'contract': 'SA505', 'open': 1506, 'high': 1512, 'low': 1500, 'close': 1508, 'oi': 900, 'volume': 450, 'settle': 1507},
        {'date': '2025-04-01', 'contract': 'SA509', 'open': 1526, 'high': 1536, 'low': 1520, 'close': 1532, 'oi': 550, 'volume': 300, 'settle': 1531},
        {'date': '2025-04-01', 'contract': 'SA601', 'open': 1566, 'high': 1575, 'low': 1560, 'close': 1570, 'oi': 130, 'volume': 70, 'settle': 1569},
        # Overlap for 05 month after roll date (2025-04-01 >= roll_date(2025-05, 1))
        {'date': '2025-04-01', 'contract': 'SA605', 'open': 1600, 'high': 1610, 'low': 1595, 'close': 1605, 'oi': 50, 'volume': 20, 'settle': 1604},
    ]
    pd.DataFrame(rows).to_csv(tmp_path / 'SA.csv', index=False)

    dm = DataManager(symbols=['SA'])
    main_df = dm.load_series_dataframe(series='main', symbol='SA')
    assert list(main_df['contract']) == ['SA505', 'SA509']
    assert list(main_df['close']) == [1505.0, 1532.0]

    m01_df = dm.load_series_dataframe(series='m01', symbol='SA')
    assert list(m01_df['contract']) == ['SA601', 'SA601']
    assert list(m01_df['close']) == [1565.0, 1570.0]

    # On 2025-04-01 both SA505 (past roll date) and SA605 (pre roll date) print:
    # m05 rolls cleanly into SA605.
    m05_df = dm.load_series_dataframe(series='m05', symbol='SA')
    assert list(m05_df['contract']) == ['SA505', 'SA605']

    with pytest.raises(ValueError, match='Unsupported series'):
        dm.load_series_dataframe(series='weekly', symbol='SA')
