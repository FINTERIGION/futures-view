"""The ``indicators/`` package: discovery, the drawing declaration, and the
context accessors.

The web surface over these is covered in ``tests/test_web_api.py``.
"""

from __future__ import annotations

import sys

import numpy as np
import pandas as pd
import pytest

from core.registry import snake_name
from indicators import (
    discover_indicators,
    load_indicator,
    load_registered_indicator,
    name_for,
)
from indicators.base import (
    Indicator,
    IndicatorContext,
    Output,
    declared_outputs,
    describe_errors,
    output_json,
    value_range_json,
)

BUNDLED = (
    'ma', 'ema', 'macd', 'rsi', 'bollinger', 'atr',
    'kdj', 'cci', 'dmi', 'donchian', 'keltner', 'obv', 'oi',
)


def build_frame(n_bars: int = 300, seed: int = 0) -> pd.DataFrame:
    """A frame shaped like ``DataManager.load_dataframe``'s output.

    Same columns, same ``DatetimeIndex`` named ``date`` -- the indicator
    context reads columns by name, so anything else would pass while the real
    thing failed.
    """
    rng = np.random.default_rng(seed)
    index = pd.date_range('2020-01-01', periods=n_bars, freq='D', name='date')
    close = 1500 + np.cumsum(rng.normal(0, 8, n_bars))
    return pd.DataFrame(
        {
            'open': close, 'high': close * 1.01, 'low': close * 0.99,
            'close': close, 'settle': close,
            'oi': np.full(n_bars, 10_000.0), 'volume': np.full(n_bars, 5_000.0),
        },
        index=index,
    )


# ---------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------

def test_every_bundled_indicator_is_discovered():
    found = discover_indicators()
    assert set(BUNDLED) <= set(found)


def test_name_for_keeps_a_one_word_stem_intact():
    """``Rsi`` -> ``rsi``, but ``MyIndicator`` keeps its suffix rather than
    collapsing to the uninformative ``my`` -- the rule strategies already use,
    which is why single-word indicators should not be named ``RsiIndicator``.
    """
    class Rsi2(Indicator):
        pass

    class MyIndicator2(Indicator):
        pass

    class DonchianChannelIndicator(Indicator):
        pass

    assert name_for(Rsi2) == 'rsi2'
    assert name_for(MyIndicator2) == 'my_indicator2'
    assert name_for(DonchianChannelIndicator) == 'donchian_channel'
    assert snake_name(DonchianChannelIndicator, 'indicator') == 'donchian_channel'


def test_a_broken_module_costs_one_entry_not_the_catalog(tmp_path, monkeypatch):
    """The deliberate divergence from ``discover_strategies``.

    An indicator catalog is rebuilt every time the user hits reload while
    editing, so one unimportable module has to degrade to one reported error
    and leave every other indicator on the chart.
    """
    import indicators

    broken = tmp_path / 'ftk_broken_indicator.py'
    broken.write_text('raise RuntimeError("deliberately broken")\n', encoding='utf-8')
    monkeypatch.setattr(indicators, '__path__', [*indicators.__path__, str(tmp_path)])

    errors: dict = {}
    found = discover_indicators(errors=errors)

    assert set(BUNDLED) <= set(found), 'a broken module took healthy ones down with it'
    assert any('ftk_broken_indicator' in key for key in errors)
    assert 'RuntimeError' in next(iter(errors.values()))


def _add_modules(tmp_path, monkeypatch, package, modules: dict):
    """Write ``{module_name: source}`` into a throwaway directory appended to
    ``package``'s path, dropping any same-named module already imported."""
    for name, source in modules.items():
        sys.modules.pop(f'{package.__name__}.{name}', None)
        (tmp_path / f'{name}.py').write_text(source, encoding='utf-8')
    monkeypatch.setattr(package, '__path__', [*package.__path__, str(tmp_path)])


_CLASH = 'from indicators.base import Indicator, Output\nclass FtkClash(Indicator):\n    outputs = (Output("x"),)\n'


def test_a_short_name_clash_registers_neither_and_reports_both_modules(tmp_path, monkeypatch):
    """A copied template whose class was never renamed. Last-scanned-wins
    would leave one of the two silently running the other's code, and which
    one would depend on file order."""
    import indicators

    _add_modules(tmp_path, monkeypatch, indicators, {'ftk_clash_a': _CLASH, 'ftk_clash_b': _CLASH})

    errors: dict = {}
    found = discover_indicators(errors=errors)

    assert 'ftk_clash' not in found
    assert set(BUNDLED) <= set(found), 'a clash took healthy indicators down with it'
    for module in ('indicators.ftk_clash_a', 'indicators.ftk_clash_b'):
        assert "share the short name 'ftk_clash'" in errors[module]
        # Both sides are named, so the user can find the other file.
        assert 'ftk_clash_a.FtkClash' in errors[module] and 'ftk_clash_b.FtkClash' in errors[module]


def test_an_alias_is_one_class_not_a_clash(tmp_path, monkeypatch):
    """``inspect.getmembers`` lists a class once per name bound to it."""
    import indicators

    _add_modules(tmp_path, monkeypatch, indicators, {'ftk_aliased': (
        'from indicators.base import Indicator, Output\n'
        'class FtkAliased(Indicator):\n'
        '    outputs = (Output("x"),)\n'
        'FtkAliasedToo = FtkAliased\n'
    )})

    errors: dict = {}
    found = discover_indicators(errors=errors)
    assert 'ftk_aliased' in found
    assert errors == {}


def test_a_strategy_name_clash_raises(tmp_path, monkeypatch):
    """The strategy side raises, as it does for an import error: a CLI run
    about to use one of these must not quietly get the other."""
    import strategies

    source = 'from strategies.base import Strategy\nclass FtkClashStrategy(Strategy):\n    pass\n'
    _add_modules(tmp_path, monkeypatch, strategies, {'ftk_sclash_a': source, 'ftk_sclash_b': source})

    with pytest.raises(ValueError, match="share the short name 'ftk_clash'"):
        strategies.discover_strategies()


def test_registry_only_loader_rejects_what_the_cli_loader_accepts():
    """Same split as ``strategies``: the HTTP-reachable loader never imports."""
    assert load_indicator('indicators.macd:Macd') is load_indicator('macd')
    assert load_registered_indicator('macd') is load_indicator('macd')
    with pytest.raises(KeyError):
        load_registered_indicator('indicators.macd:Macd')


def test_load_indicator_rejects_a_non_indicator():
    with pytest.raises(TypeError):
        load_indicator('indicators.base:Output')


# ---------------------------------------------------------------------
# Compute
# ---------------------------------------------------------------------

@pytest.mark.parametrize('key', BUNDLED)
def test_bundled_indicator_returns_one_full_length_array_per_output(key):
    df = build_frame()
    cls = load_registered_indicator(key)
    result = cls().compute(IndicatorContext(df, 'SA'), 'SA')

    declared = {o.key for o in cls.outputs}
    assert declared <= set(result), f'{key} declares outputs it does not return'
    for out_key in declared:
        arr = np.asarray(result[out_key], dtype='float64')
        assert arr.shape == (len(df),)
        assert np.isfinite(arr).any(), f'{key}.{out_key} is entirely NaN'


@pytest.mark.parametrize('key', BUNDLED)
def test_bundled_indicator_declares_a_valid_drawing_contract(key):
    assert describe_errors(load_registered_indicator(key)) == []


def test_nan_is_a_leading_run_only():
    """Warmup shows up as leading NaN, which the chart draws as "no line yet".
    A hole *after* the first valid bar would be legitimate for some
    indicators, but none of the bundled ones should have one.
    """
    df = build_frame()
    for key in BUNDLED:
        cls = load_registered_indicator(key)
        for out_key, values in cls().compute(IndicatorContext(df, 'SA'), 'SA').items():
            arr = np.asarray(values, dtype='float64')
            isnan = np.isnan(arr)
            first_valid = int(np.argmax(~isnan))
            assert not isnan[first_valid:].any(), f'{key}.{out_key} has an embedded NaN'


def _compute(key: str, df: pd.DataFrame, **params) -> dict:
    cls = load_registered_indicator(key)
    return cls(**params).compute(IndicatorContext(df, 'SA'), 'SA')


def test_kdj_matches_a_hand_computed_first_bar():
    """RSV 75 on the first full window, K and D seeded at 50 and smoothed
    with ``SMA(X, 3, 1)``, J = 3K - 2D."""
    from indicators.kdj import kdj

    high = np.array([10.0, 11.0, 12.0, 11.0])
    low = np.array([8.0, 9.0, 10.0, 9.0])
    close = np.array([9.0, 10.0, 11.0, 10.0])
    k, d, j = kdj(high, low, close, n=3, m1=3, m2=3)

    assert np.isnan(k[:2]).all() and np.isnan(d[:2]).all()
    assert k[2] == pytest.approx((75 + 2 * 50) / 3)
    assert d[2] == pytest.approx((k[2] + 2 * 50) / 3)
    # Bar 3: window 11/12/11 high, 9/10/9 low, close 10 -> RSV 100/3.
    assert k[3] == pytest.approx((100 / 3 + 2 * k[2]) / 3)
    np.testing.assert_allclose(j, 3 * k - 2 * d)


def test_kdj_holds_through_a_flat_window():
    """A window whose high equals its low has no RSV; K and D carry over
    rather than jumping to an invented value or going NaN mid-series."""
    from indicators.kdj import kdj

    high = np.array([10.0, 11.0, 12.0, 12.0, 12.0, 12.0])
    low = np.array([8.0, 9.0, 10.0, 12.0, 12.0, 12.0])
    close = np.array([9.0, 10.0, 11.0, 12.0, 12.0, 12.0])
    k, d, _ = kdj(high, low, close, n=3, m1=3, m2=3)

    assert k[5] == k[4] and d[5] == d[4]


@pytest.mark.parametrize('key', ['bollinger', 'donchian', 'keltner'])
def test_channel_bands_bracket_the_middle(key):
    out = _compute(key, build_frame())
    valid = ~np.isnan(out['upper'])
    assert (out['lower'][valid] <= out['mid'][valid]).all()
    assert (out['mid'][valid] <= out['upper'][valid]).all()


def test_oi_is_the_loaded_open_interest_and_its_average():
    """The series is the bar's own open interest, not a transform of price,
    and the average is an SMA of that series."""
    import talib

    df = build_frame()
    df['oi'] = np.arange(len(df), dtype='float64') * 10 + 1000
    out = _compute('oi', df, period=5)
    np.testing.assert_array_equal(out['oi'], df['oi'].to_numpy())
    np.testing.assert_allclose(out['ma'], talib.SMA(df['oi'].to_numpy(dtype='float64'), 5))


def test_donchian_bands_are_the_window_extremes():
    df = build_frame()
    out = _compute('donchian', df, period=20)
    assert out['upper'][-1] == df['high'].iloc[-20:].max()
    assert out['lower'][-1] == df['low'].iloc[-20:].min()


def test_context_accessor_symbol_argument_is_optional():
    """``ctx.close()`` and ``ctx.close(sym)`` are the same series, so a
    strategy's ``setup()`` body pastes into ``compute()`` unmodified."""
    df = build_frame()
    ctx = IndicatorContext(df, 'SA')
    assert np.array_equal(ctx.close(), ctx.close('SA'))
    assert len(ctx) == len(df)
    assert ctx.dates.shape == (len(df),)


def test_context_rejects_a_symbol_it_did_not_load():
    ctx = IndicatorContext(build_frame(), 'SA')
    with pytest.raises(ValueError, match='only product loaded'):
        ctx.close('CF')


def test_context_guards_embedded_nan_in_the_input():
    """``core.indicators.guard`` on the way *in*, because the user is about to
    hand the array to TA-Lib, which silently returns all-NaN for that input."""
    df = build_frame()
    df.iloc[50, df.columns.get_loc('close')] = np.nan
    with pytest.raises(ValueError, match='NaN after its first valid value'):
        IndicatorContext(df, 'SA').close()


# ---------------------------------------------------------------------
# The drawing declaration
# ---------------------------------------------------------------------

def test_describe_errors_flags_a_malformed_declaration():
    class Bad(Indicator):
        pane = 'sidebar'
        outputs = (
            Output('a', kind='pie'),
            Output('a', style='wavy'),
        )

    errors = ' | '.join(describe_errors(Bad))
    assert 'pane' in errors
    assert 'kind' in errors
    assert 'style' in errors
    assert 'two outputs' in errors


def test_describe_errors_flags_an_indicator_that_draws_nothing():
    class Empty(Indicator):
        pass

    assert any('no outputs' in e for e in describe_errors(Empty))


def test_value_range_on_the_price_pane_is_reported_and_dropped():
    """Those bounds would rescale the axis the candles own, so they are
    ignored -- but silently ignoring them is how a user loses an afternoon."""
    class MainBounded(Indicator):
        pane = 'main'
        value_range = (0, 100)
        outputs = (Output('x'),)

    assert any('ignored' in e for e in describe_errors(MainBounded))
    assert value_range_json(MainBounded) is None


def test_value_range_serializes_as_an_object():
    """``{'min': 0, 'max': None}`` rather than ``[0, null]``, so "bounded
    below, autoscaled above" is unambiguous on the wire."""
    class HalfBounded(Indicator):
        pane = 'sub'
        value_range = (0, None)
        outputs = (Output('x'),)

    assert value_range_json(HalfBounded) == {'min': 0, 'max': None}
    assert value_range_json(load_registered_indicator('rsi')) == {'min': 0, 'max': 100}


def test_sign_coloured_pair_is_only_meaningful_on_a_bar():
    class Wrong(Indicator):
        outputs = (Output('x', kind='line', color=('up', 'down')),)

    assert any("kind='bar'" in e for e in describe_errors(Wrong))


def test_candle_colour_is_only_meaningful_on_a_bar():
    class Wrong(Indicator):
        outputs = (Output('x', kind='line', color='candle'),)

    assert any("color 'candle'" in e for e in describe_errors(Wrong))


def test_oi_bars_follow_the_day_direction():
    """Height is the open interest; colour is the day's price, the same rule
    as the volume pane. A single palette colour would paint every bar one
    hue, because the level is always positive."""
    oi = next(o for o in declared_outputs(load_registered_indicator('oi')) if o.key == 'oi')
    assert oi.kind == 'bar'
    assert oi.color == 'candle'


def test_output_json_passes_colour_through_verbatim():
    """The frontend resolves colour against the live theme, so the wire format
    carries the declaration, not a hex."""
    assert output_json(Output('a', color=3))['color'] == 3
    assert output_json(Output('a', color='muted'))['color'] == 'muted'
    assert output_json(Output('h', kind='bar', color=('up', 'down')))['color'] == ['up', 'down']
    assert output_json(Output('a'))['label'] == 'a'
    assert output_json(Output('a', label='Alpha'))['label'] == 'Alpha'


def test_a_missing_trailing_comma_on_outputs_is_reported_not_raised():
    """`outputs = Output('x')` is the likeliest typo in this declaration, and
    a bare dataclass is not iterable -- it must read as one reported error,
    not a TypeError escaping into the catalog."""
    class NoComma(Indicator):
        outputs = Output('x')  # type: ignore[assignment]

    errors = describe_errors(NoComma)
    assert any('trailing comma' in e for e in errors)


def test_describe_errors_survives_a_wrong_type_on_every_field():
    class Nonsense(Indicator):
        pane = 3  # type: ignore[assignment]
        precision = 'two'  # type: ignore[assignment]
        value_range = 100  # type: ignore[assignment]
        guides = 30  # type: ignore[assignment]
        outputs = 'not outputs'  # type: ignore[assignment]

    errors = describe_errors(Nonsense)  # must not raise
    assert len(errors) >= 4
    assert value_range_json(Nonsense) is None


def test_declared_outputs_drops_anything_that_is_not_an_output():
    class Mixed(Indicator):
        outputs = (Output('good'), 'bad', 42)  # type: ignore[assignment]

    assert [o.key for o in declared_outputs(Mixed)] == ['good']
    assert declared_outputs(type('Bare', (Indicator,), {'outputs': Output('x')})) [0].key == 'x'
