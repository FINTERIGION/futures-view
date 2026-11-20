"""CLI argument bounds shared with the web panel.

``--cash`` and ``--slippage`` used to accept any float. Zero cash ran and
came back blown up on bar 0; a negative slippage filled every trade better
than the market. The web request model already refuses both.
"""

from __future__ import annotations

import pytest

import main


def test_backtest_defaults_cash_to_100000():
    args = main._parse_args(['backtest'])
    assert args.cash == 100_000
    assert args.slippage == 0


@pytest.mark.parametrize('argv', [
    ['backtest', '--cash', '0'],
    ['backtest', '--cash', '-1'],
    ['backtest', '--cash', 'inf'],
    ['backtest', '--cash', 'nan'],
])
def test_backtest_rejects_cash_that_is_not_a_positive_finite_number(argv):
    with pytest.raises(SystemExit):
        main._parse_args(argv)


@pytest.mark.parametrize('argv', [
    ['backtest', '--slippage', '-1'],
    ['backtest', '--slippage', '-0.5'],
    ['backtest', '--slippage', 'inf'],
    ['backtest', '--slippage', 'nan'],
])
def test_backtest_rejects_slippage_that_is_negative_or_non_finite(argv):
    with pytest.raises(SystemExit):
        main._parse_args(argv)


def test_backtest_accepts_a_zero_slippage_and_a_positive_cash():
    args = main._parse_args(['backtest', '--cash', '100000', '--slippage', '0'])
    assert args.cash == 100_000
    assert args.slippage == 0.0


def test_broken_strategy_does_not_crash_cli_arg_parsing(tmp_path, monkeypatch):
    import strategies as strat_pkg

    broken = tmp_path / 'ftk_cli_broken.py'
    broken.write_text('def broken(:\n', encoding='utf-8')
    monkeypatch.setattr(strat_pkg, '__path__', list(strat_pkg.__path__) + [str(tmp_path)])
    args = main._parse_args(['backtest'])
    assert args.command == 'backtest'


def test_plotter_handles_empty_equity_records_without_crashing(tmp_path):
    from plotting import BacktestPlotter

    plotter = BacktestPlotter(
        equity_records=[],
        trade_logs=[],
        price_dfs={},
        signal_log=[],
        metrics={},
        config={'results_dir': str(tmp_path), 'strategy_name': 'Test', 'timestamp': '20260101_000000'},
    )
    saved = plotter.plot_all()
    assert isinstance(saved, dict)

