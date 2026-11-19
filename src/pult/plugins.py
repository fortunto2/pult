"""Extensions of the Mac side: PULT_PLUGINS=pkg.mod,other.mod

Each name is imported with importlib and may define:

    def register(registry: pult.actions.Registry) -> None     # required: add actions with registry.register(...)
    def workflows() -> dict                                    # optional: workflows to merge over the default ones

`workflows()` returns {name: workflow} (a {"workflows": {...}} wrapper is accepted too). A new name is added, an existing one is
replaced as a whole, with one exception: the built-in `draft` workflow is the read-and-draft security point, so an extension may only
ADD entries to its `disallowed_tools` (any other difference is refused with a PluginError).

A module that cannot be imported, has no register(), or raises in it, is a PluginError. pult-run stops at start on it.
"""

from __future__ import annotations

import copy
import importlib
import json
import os
from types import ModuleType

from pult import paths
from pult.actions import Registry


class PluginError(Exception):
    pass


def names(env: str | None = None) -> list[str]:
    raw = os.environ.get("PULT_PLUGINS", "") if env is None else env
    return [n.strip() for n in raw.split(",") if n.strip()]


def _import(name: str) -> ModuleType:
    try:
        return importlib.import_module(name)
    except Exception as e:  # noqa: BLE001  any failure in a plugin is a startup error with its name on it
        raise PluginError(f"plugin {name!r} failed to import: {type(e).__name__}: {e}") from e


def modules(plugin_names: list[str] | None = None) -> list[ModuleType]:
    return [_import(n) for n in (names() if plugin_names is None else plugin_names)]


def load_into(registry: Registry, plugin_names: list[str] | None = None) -> list[str]:
    """Import every plugin and let it register its actions. Returns the loaded names."""
    loaded = []
    for mod in modules(plugin_names):
        reg = getattr(mod, "register", None)
        if not callable(reg):
            raise PluginError(f"plugin {mod.__name__!r} has no register(registry) function")
        try:
            reg(registry)
        except Exception as e:  # noqa: BLE001
            raise PluginError(f"plugin {mod.__name__!r}: register() raised {type(e).__name__}: {e}") from e
        loaded.append(mod.__name__)
    return loaded


def load(plugin_names: list[str] | None = None) -> list[str]:
    """Import and validate (register into a scratch registry, merge workflows) without keeping anything. For startup checks."""
    scratch = Registry()
    loaded = load_into(scratch, plugin_names)
    apply_workflows(json.loads(paths.workflows_text()), plugin_names)
    return loaded


def merge_draft(base: dict, patch: dict, who: str = "a plugin") -> dict:
    """The only change an extension may make to `draft`: more entries in disallowed_tools."""
    out = copy.deepcopy(base)
    for k, v in patch.items():
        if k == "_doc":
            continue
        if k == "disallowed_tools":
            if not isinstance(v, list):
                raise PluginError(f"{who}: draft disallowed_tools must be a list")
            out["disallowed_tools"] = [*base.get("disallowed_tools", []), *[x for x in v if x not in base.get("disallowed_tools", [])]]
        elif base.get(k) != v:
            raise PluginError(f"{who}: refused to change the draft workflow ({k!r}); an extension may only add to its disallowed_tools")
    return out


def apply_workflows(base: dict, plugin_names: list[str] | None = None) -> dict:
    """`base` is a parsed workflows file; returns a copy with every plugin's workflows() merged in."""
    out = copy.deepcopy(base)
    wfs = out.setdefault("workflows", {})
    for mod in modules(plugin_names):
        fn = getattr(mod, "workflows", None)
        if not callable(fn):
            continue
        extra = fn() or {}
        extra = extra.get("workflows", extra) if isinstance(extra, dict) else {}
        for name, wf in extra.items():
            if name == "draft":
                if "draft" not in wfs:
                    raise PluginError(f"plugin {mod.__name__!r}: there is no draft workflow to add to")
                wfs["draft"] = merge_draft(wfs["draft"], wf, f"plugin {mod.__name__!r}")
            else:
                wfs[name] = wf
    return out
