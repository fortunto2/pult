"""Plugin hooks of the Mac side beyond actions and workflows (see pult.plugins). A plugin is a module listed in PULT_PLUGINS; each hook is optional.

    def strings() -> dict[str, str]            user-facing text overrides (see pult.i18n): a translation, or your own wording
    def wall() -> list[re.Pattern]             patterns an outgoing line or item must not match; raise pult.paths.DenyFileMissing when the wall
                                               cannot be loaded (every script then refuses to send: fail closed)
    def tz_label(tz: str) -> str | None        a short name for a zone in note headers ("CET" for Europe/Berlin); None keeps the city
    def placeholders() -> dict[str, str]      extra {NAME} placeholders for workflows and rules ({BOT}, {CRM}); {PULT} and {WORK} are built in
    def agent_rules() -> str                   appended to the packaged agent rules a chat turn starts with
    def draft_rules() -> str                   appended to the rules of a restricted read-and-draft job
    def item_args(cmd: str, parser) -> None    add flags to one `bot-item` subcommand (decision, card, put)
    def item_gate(cmd: str, args, body: str) -> tuple[str, str] | None
                                               before an item is written: ("skip", line) prints the line and writes nothing, ("refuse", text) exits with it
    def item_payload(cmd: str, args, payload: dict) -> dict      last look at the item body before it is posted (urgency by date, extra fields)
    def item_after(cmd: str, args, result: dict) -> list[str]    lines to print after an item was written (a draft attached, a cap applied)
    def item_commands() -> dict[str, tuple[configure, run]]
                                               extra `bot-item` subcommands: configure(subparser) adds the flags, run(args, request) -> int

Hooks never see a secret: `request(method, path, body)` is the owner-key call `bot-item` itself uses.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from pult import plugins


def _each(name: str):
    for mod in plugins.modules():
        fn = getattr(mod, name, None)
        if callable(fn):
            yield mod, fn


def collect(name: str, *args: Any) -> list[Any]:
    """The results of every plugin's hook `name` that returned something, in PULT_PLUGINS order."""
    return [r for _, fn in _each(name) if (r := fn(*args)) is not None]


def first(name: str, *args: Any) -> Any | None:
    for _, fn in _each(name):
        r = fn(*args)
        if r is not None:
            return r
    return None


def commands() -> dict[str, tuple[Callable, Callable]]:
    out: dict[str, tuple[Callable, Callable]] = {}
    for mod, fn in _each("item_commands"):
        for name, pair in (fn() or {}).items():
            if name in out:
                raise plugins.PluginError(f"plugin {mod.__name__!r}: bot-item command {name!r} is already registered")
            out[name] = pair
    return out
