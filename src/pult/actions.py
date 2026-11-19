"""The action registry: what session-run does with an event, by the event's `action`.

The core registers `ask`, `reply` and `c1`..`c3` (they run Claude). An extension registers more from its `register(registry)` hook
(see pult.plugins):

    from pult.actions import ActionResult

    def ping(ev, ctx):
        return ActionResult(say="pong")

    def register(registry):
        registry.register("ping", ping, workflow="draft")

A handler is deterministic code: `handler(ev: dict, ctx: Ctx) -> ActionResult | None`. It reaches the model only by calling
`ctx.run_claude(prompt)` itself. Returning None means "nothing to post and nothing to ack" (the lease is gone); the core does that
only when the worker gave the event to someone else.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

STATUSES = ("done", "failed", "stopped", "requeue")
ITEM_RESULTS = ("done", "reopen")


@dataclass
class ActionResult:
    """What the core does after a handler: post `say` as a reply (split to Telegram's size, `loud` rings on the last part), then ack `status`.

    status       done | failed | stopped | requeue (requeue: run the event again later; the core's own usage-limit path)
    say          the answer text, or None to post nothing
    item_result  done | reopen | None: what happens to the card the event came from. Honoured only when the action was registered with item_result=True
    loud         the last part of `say` rings the phone instead of arriving silently
    """

    status: str = "done"
    say: str | None = None
    item_result: str | None = None
    loud: bool = False

    def __post_init__(self) -> None:
        if self.status not in STATUSES:
            raise ValueError(f"ActionResult.status must be one of {STATUSES}, not {self.status!r}")
        if self.item_result not in (None, *ITEM_RESULTS):
            raise ValueError(f"ActionResult.item_result must be one of {ITEM_RESULTS} or None, not {self.item_result!r}")


@dataclass
class Ctx:
    """What a handler may use. Built by session-run for one event.

    cfg          the runner's Cfg (worker URL, state dir, sessions dir, intervals)
    ev, sess     the event and its session, as the worker returned them (the session already belongs to the event's owner)
    session_id   sess["id"]
    workflow     the name of the workflow this event runs in: `draft` whenever the event carries an item_id, else the registered one
    wf           that workflow's settings (cwd, permission_mode, tool rules, ...)
    cwd          the working directory a Claude turn of this event would use
    call         call(method, path, body=None, raw=False): one authenticated JSON call to the worker (runner key)
    say          say(text, **kw): post a message in the session now (extra keys go to POST /sessions/<id>/say)
    run_claude   run_claude(prompt) -> ActionResult: one turn in this event's workflow, a fresh Claude session. Opt in; a handler that never calls it never reaches the model
    fetch_files  fetch_files() -> (saved, refused): the event's files downloaded into the session inbox; saved items carry kind, path, name
    transcribe   transcribe(path) -> str | None: a voice file as text with the workflow's transcriber (None: it failed or passed the cap)
    card         card() -> dict: the item the event came from, read through the owner's own key (`bot-item get`), {} when there is none
    """

    cfg: Any
    ev: dict
    sess: dict
    session_id: str
    workflow: str
    wf: dict
    cwd: str
    call: Callable[..., Any]
    say: Callable[..., Any]
    run_claude: Callable[[str], ActionResult]
    fetch_files: Callable[[], Any] | None = None
    transcribe: Callable[[str], str | None] | None = None
    card: Callable[[], dict] | None = None
    extra: dict = field(default_factory=dict)


Handler = Callable[[dict, Ctx], "ActionResult | None"]


@dataclass(frozen=True)
class Action:
    """One registered action. `workflow`: `chat` runs in the session's workflow (default chat), any other name runs in that workflow; an event with an item_id always runs in `draft`."""

    name: str
    handler: Handler
    workflow: str = "draft"
    item_result: bool = False


class Registry:
    def __init__(self) -> None:
        self._actions: dict[str, Action] = {}

    def register(self, name: str, handler: Handler, *, workflow: str = "draft", item_result: bool = False) -> Action:
        """Add an action. A name that is already registered is an error: an extension never silently replaces a core action or another extension's."""
        if not name or not isinstance(name, str):
            raise ValueError("an action needs a name")
        if not callable(handler):
            raise TypeError(f"action {name!r}: handler must be callable")
        if name in self._actions:
            raise ValueError(f"action {name!r} is already registered")
        a = Action(name, handler, workflow, item_result)
        self._actions[name] = a
        return a

    def get(self, name: str | None) -> Action | None:
        return self._actions.get(name or "ask")

    def names(self) -> list[str]:
        return sorted(self._actions)

    def __contains__(self, name: str) -> bool:
        return name in self._actions
