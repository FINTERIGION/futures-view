"""Parameter ranges (``core.params``) and the CLI param plumbing built on them.

Tests that must hold for *any* strategy are parametrized over
``strategies.discover_strategies()`` rather than naming one strategy, so a
new strategy dropped into strategies/ is covered automatically.
"""

from __future__ import annotations

import argparse

import pytest

from core.params import Int, parse_param_value, resolve_params, resolve_space, validated_overrides
from strategies import discover_strategies
from strategies.base import Strategy

PARAMETERIZED_STRATEGIES = {
    name: cls for name, cls in discover_strategies().items()
    if getattr(cls, 'params', None)
}


@pytest.mark.parametrize('name', sorted(PARAMETERIZED_STRATEGIES))
def test_resolve_space_covers_every_declared_param(name):
    cls = PARAMETERIZED_STRATEGIES[name]
    space = resolve_space(cls)
    assert space  # every bundled strategy with params should yield a non-empty range set
    for key in space:
        assert key in cls.params
        assert key in cls.space


def test_resolve_space_is_only_what_the_class_declared():
    class _S(Strategy):
        params = {'period': 20, 'threshold': 0.5}
        space = {'period': Int(5, 50)}

    assert resolve_space(_S) == {'period': Int(5, 50)}


def test_resolve_space_refuses_a_key_that_is_not_a_param():
    # `perod` pins `period` at its default while the author thinks it is tuned.
    class _Typo(Strategy):
        params = {'period': 20}
        space = {'perod': Int(5, 50)}

    with pytest.raises(ValueError, match="'perod', not in `params`"):
        resolve_space(_Typo)


def test_resolve_space_is_empty_for_a_class_with_nothing_tunable():
    class _Plain(Strategy):
        params = {'lots': 1}

    assert resolve_space(_Plain) == {}


def test_resolve_params_precedence():
    """--param beats --lots beats the class defaults."""
    from strategies.double_ma import DoubleMaStrategy

    args = argparse.Namespace(lots=7, param=['fast_period=3'])
    assert resolve_params(DoubleMaStrategy, args) == {'fast_period': 3, 'lots': 7}

    args = argparse.Namespace(lots=7, param=['lots=2'])
    assert resolve_params(DoubleMaStrategy, args) == {'lots': 2}

    # No flags at all -> no overrides, so the class defaults stand untouched.
    args = argparse.Namespace(lots=None, param=None)
    assert resolve_params(DoubleMaStrategy, args) == {}


def test_parse_param_value_casts_int_float_bool_then_str():
    assert parse_param_value('n=5') == ('n', 5)
    assert parse_param_value('r=0.5') == ('r', 0.5)
    assert parse_param_value('flag=true') == ('flag', True)
    assert parse_param_value('mode=trend') == ('mode', 'trend')
    with pytest.raises(ValueError):
        parse_param_value('nope')


def test_validated_overrides_checks_names_ranges_and_types():
    from strategies.double_ma import DoubleMaStrategy

    assert validated_overrides(DoubleMaStrategy, {}) == {}
    assert validated_overrides(DoubleMaStrategy, {'fast_period': 8, 'slow_period': 40}) == {
        'fast_period': 8, 'slow_period': 40,
    }
    with pytest.raises(ValueError, match='outside its declared range'):
        validated_overrides(DoubleMaStrategy, {'fast_period': 2})
    with pytest.raises(ValueError, match='no param'):
        validated_overrides(DoubleMaStrategy, {'nope': 1})
    with pytest.raises(ValueError, match='integer'):
        validated_overrides(DoubleMaStrategy, {'fast_period': 8.5})
    # Declared, but not in `space`: fixed at its default for any web request.
    with pytest.raises(ValueError, match='not in its `space`'):
        validated_overrides(DoubleMaStrategy, {'lots': 2})


def test_validated_overrides_honours_constraints():
    class _Bounded(Strategy):
        params = {'fast': 5, 'slow': 20}
        space = {'fast': Int(1, 100), 'slow': Int(1, 100)}
        constraints = (lambda p: p['fast'] < p['slow'],)

    assert validated_overrides(_Bounded, {'fast': 10}) == {'fast': 10}
    with pytest.raises(ValueError, match='constraints'):
        validated_overrides(_Bounded, {'fast': 30, 'slow': 10})


def test_packaged_modules_do_not_import_top_level_scripts():
    """``pyproject.toml`` ships ``core``/``datafeed``/``strategies``/... as
    packages and leaves ``main.py`` and ``plotting.py`` at the repo root,
    uninstalled. A packaged module importing one of those used to produce a
    ``pip install .`` tree that raised ``ModuleNotFoundError`` the first time
    it was used.
    """
    import ast
    import pathlib

    root = pathlib.Path(__file__).resolve().parent.parent
    packaged = ('core', 'datafeed', 'strategies', 'indicators', 'web')
    top_level = {p.stem for p in root.glob('*.py')}
    assert {'main', 'plotting'} <= top_level      # guard the premise

    offenders = []
    for package in packaged:
        for path in (root / package).rglob('*.py'):
            tree = ast.parse(path.read_text(encoding='utf-8'))
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom) and node.level == 0:
                    names = [(node.module or '').split('.')[0]]
                elif isinstance(node, ast.Import):
                    names = [a.name.split('.')[0] for a in node.names]
                else:
                    continue
                offenders += [
                    f'{path.relative_to(root)}: {name}'
                    for name in names if name in top_level
                ]
    assert not offenders, f'packaged modules importing unpackaged scripts: {offenders}'
