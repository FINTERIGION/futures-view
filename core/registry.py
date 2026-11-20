"""Folder-scan discovery shared by ``strategies/`` and ``indicators/``.

Both packages offer the same deal to a user: write a class, drop the file in
the folder, it shows up. That deal has four details in it that are easy to
get subtly wrong on a second implementation, which is why they live here once
rather than twice:

* a class is registered only where it is *defined*, so an ``import`` at the
  top of a module does not register that module's dependency a second time;
* the base class itself is never registered;
* the short name drops a redundant class-name suffix, but not when doing so
  would leave a single, uninformative word (``MyStrategy`` -> ``my_strategy``,
  not ``my``);
* two classes that reduce to the same short name are refused, never resolved
  by scan order.

Nothing here knows what a strategy or an indicator *is* -- it takes a package
name and a base class and returns what it found.

:func:`reload_package` is the hot-reload half of the same deal, and lives here
for the same reason: ``importlib.reload`` is the obvious way to write it, and
it is subtly wrong for a folder people edit (see there).
"""

from __future__ import annotations

import importlib
import inspect
import pkgutil
import re
import sys
from typing import Callable, Optional

__all__ = ['discover_subclasses', 'reload_package', 'snake_name']

_CAMEL_RE = re.compile(r'(?<!^)(?=[A-Z])')


def snake_name(cls: type, suffix: str) -> str:
    """``DoubleMaStrategy`` + ``'strategy'`` -> ``'double_ma'``.

    Snake-cases the class name, then drops a trailing ``_{suffix}`` -- unless
    doing so would leave a single, uninformative word, so ``MyStrategy`` stays
    ``'my_strategy'`` rather than collapsing to ``'my'``. Matches the CLI names
    already documented in README.md.
    """
    snake = _CAMEL_RE.sub('_', cls.__name__).lower()
    tail = f'_{suffix}'
    if snake.endswith(tail):
        stem = snake[: -len(tail)]
        if '_' in stem:
            return stem
    return snake


def discover_subclasses(
    package_name: str,
    base: type,
    suffix: str,
    on_error: Optional[Callable[[str, Exception], None]] = None,
) -> dict:
    """Scan every module in ``package_name`` and return ``{short_name: cls}``
    for every concrete ``base`` subclass found (``base`` itself excluded).

    A class is included regardless of which module defines it, so long as it
    lives somewhere under the package -- private, gitignored modules are
    discovered the same as the bundled examples.

    Two classes whose short names coincide are both left out, and reported as
    a ``ValueError`` against each module involved. Picking one would make the
    winner depend on file order and leave the other silently unreachable: a
    user who copied a template file and forgot to rename the class would find
    one of the two quietly running the other's code.

    ``on_error``, when given, is called with ``(module_name, exception)`` for a
    module that fails to import or holds one side of a name clash, and the
    scan continues. Left at ``None`` the error propagates, which is the right
    default for a package whose modules are imported by a CLI run that is
    about to use one of them: a silent skip there would look like "strategy
    not found" for what is actually a syntax error. Callers that serve a
    *catalog* -- where one broken module should cost one entry rather than the
    whole list -- pass a handler.
    """
    found: dict = {}
    clashes: dict = {}  # short name -> every distinct class claiming it
    package = importlib.import_module(package_name)
    for _finder, mod_name, _is_pkg in pkgutil.iter_modules(package.__path__, prefix=f'{package_name}.'):
        try:
            module = importlib.import_module(mod_name)
        except Exception as e:  # noqa: BLE001 -- user code; the handler decides what it means
            if on_error is None:
                raise
            on_error(mod_name, e)
            continue
        for _attr_name, obj in inspect.getmembers(module, inspect.isclass):
            if obj is base:
                continue
            if not issubclass(obj, base):
                continue
            if obj.__module__ != module.__name__:
                continue  # re-exported import, not defined here
            name = snake_name(obj, suffix)
            if name not in found:
                found[name] = obj
            elif found[name] is not obj:  # an alias (`Foo2 = Foo`) is one class, not a clash
                bucket = clashes.setdefault(name, [found[name]])
                if obj not in bucket:
                    bucket.append(obj)

    for name, classes in clashes.items():
        del found[name]
        where = ', '.join(f'{c.__module__}.{c.__qualname__}' for c in classes)
        err = ValueError(
            f'{len(classes)} classes share the short name {name!r} ({where}), so none '
            f'of them is registered; rename all but one.'
        )
        if on_error is None:
            raise err
        for mod_name in dict.fromkeys(c.__module__ for c in classes):
            on_error(mod_name, err)
    return found


def reload_package(
    package_name: str,
    base: type,
    on_error: Optional[Callable[[str, Exception], None]] = None,
) -> None:
    """Re-import every module under ``package_name`` from source, except the
    one that defines ``base``.

    Modules are dropped from ``sys.modules`` and imported fresh rather than
    passed to ``importlib.reload``, which re-executes a module into its
    *existing* namespace: a class the user renamed or deleted survives there
    under its old name, and :func:`discover_subclasses` -- which reads that
    namespace -- would go on listing it, running pre-edit code. Everything is
    dropped before anything is re-imported, so a module that imports a sibling
    (``from .ma import Ma``) binds the fresh sibling rather than the stale one.

    ``base``'s own module is kept because discovery checks
    ``issubclass(obj, base)`` against the class object the caller already
    holds. Re-importing it would mint a new ``base`` that no freshly imported
    subclass descends from, silently emptying the registry.

    ``on_error`` behaves as in :func:`discover_subclasses`. A module that fails
    to import is left out of ``sys.modules`` by the import system itself, so
    the next discovery retries it and reports the same failure, rather than
    finding the pre-edit version still registered.
    """
    keep = base.__module__
    prefix = f'{package_name}.'
    for name in list(sys.modules):
        if name.startswith(prefix) and name != keep:
            sys.modules.pop(name, None)
    # A file created since the last scan may not be in the path finder's
    # cached directory listing yet.
    importlib.invalidate_caches()

    package = importlib.import_module(package_name)
    for _finder, mod_name, _is_pkg in pkgutil.iter_modules(package.__path__, prefix=prefix):
        if mod_name == keep:
            continue
        try:
            importlib.import_module(mod_name)
        except Exception as e:  # noqa: BLE001 -- user code; the handler decides what it means
            if on_error is None:
                raise
            on_error(mod_name, e)
