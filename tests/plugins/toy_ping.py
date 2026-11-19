"""The smallest extension of the Mac side: one deterministic action and one extra deny rule. docs/extending.md walks through it.

Enable with PULT_PLUGINS=toy_ping. An event whose action is `ping` is then answered with "pong", and no model is involved.
"""

from pult.actions import ActionResult


def ping(ev, ctx):
    return ActionResult(say="pong")


def register(registry):
    registry.register("ping", ping, workflow="draft")


def workflows():
    """Optional hook. The built-in draft workflow accepts only more entries in disallowed_tools, never fewer rules."""
    return {"draft": {"disallowed_tools": ["Read(**/toy-secret*)"]}}
