# ruff: noqa: F811
"""The action registry and the plugin loader: core actions, unknown actions, an extension's action, a failing plugin, the draft guard."""

import json
import sys

import pytest
from test_session_run import FAKE, env, init, result  # noqa: F401  (the fake worker and the `env` fixture)

from pult import actions, plugins
from pult import session_run as sr
from pult.actions import ActionResult, Registry


def test_the_core_registers_ask_reply_and_the_three_custom_buttons():
    reg = sr.build_registry([])
    assert reg.names() == ["ask", "c1", "c2", "c3", "reply"]
    assert reg.get(None).name == "ask" and reg.get("ping") is None   # no action = a plain chat message


def test_a_name_cannot_be_registered_twice_so_a_plugin_never_replaces_a_core_action():
    reg = sr.build_registry([])
    with pytest.raises(ValueError, match="already registered"):
        reg.register("ask", lambda ev, ctx: None)
    with pytest.raises(ValueError):
        ActionResult(status="maybe")
    with pytest.raises(ValueError):
        ActionResult(item_result="closed")


def test_an_unknown_action_is_acked_failed_and_never_reaches_the_model(env):
    w, run, tmp = env
    assert run([init(), result("should not run")], event={"action": "frobnicate"}) == 3
    assert w.acks() == [{"status": "failed"}] and not (tmp / "argv.json").exists()
    assert "Unknown action 'frobnicate'" in w.says()[0]["text"] and w.says()[0]["loud"] is True


def test_a_plugin_action_runs_without_the_model_and_its_result_is_posted_and_acked(env, monkeypatch):
    w, run, tmp = env
    monkeypatch.setenv("PULT_PLUGINS", "toy_ping")
    assert run([init(), result("never")], event={"action": "ping"}) == 0
    assert [s["text"] for s in w.says()] == ["pong"] and w.says()[0]["reply_to"] == 55 and w.acks() == [{"status": "done"}]
    assert not (tmp / "argv.json").exists()   # deterministic code: claude was not started


def test_item_result_travels_to_the_ack_only_for_an_action_registered_with_item_result(env):
    w, run, tmp = env
    for flag in (True, False):
        reg = Registry()
        reg.register("close", lambda ev, ctx: ActionResult(say="closed", item_result="done"), item_result=flag)
        w.calls.clear()
        cfg = sr.Cfg()
        ev = {"id": 7, "user_id": 111, "role": "owner", "session_id": "s1", "action": "close", "item_id": "x:1", "priority": 0, "lease_id": "L7", "reply_to": None}
        assert sr.main_event(cfg, ev, reg) == 0
        assert w.acks() == ([{"status": "done", "item_result": "done"}] if flag else [{"status": "done"}])


def test_a_handler_can_opt_into_one_claude_turn_in_the_event_workflow(env):
    w, run, tmp = env
    reg = Registry()
    reg.register("summarize", lambda ev, ctx: ctx.run_claude("Summarize the notes."), workflow="chat")
    import os

    os.environ["FAKE_CLAUDE_SCRIPT"] = json.dumps([init(), result("Short summary.")])
    ev = {"id": 7, "user_id": 111, "role": "owner", "session_id": "s1", "action": "summarize", "priority": 0, "lease_id": "L7", "reply_to": 55}
    assert sr.main_event(sr.Cfg(), ev, reg) == 0
    argv = json.loads((tmp / "argv.json").read_text())
    assert "--resume" not in argv and argv[1] == "Summarize the notes."   # fresh session, exactly the handler's prompt
    assert w.says()[-1]["text"] == "Short summary." and w.acks() == [{"status": "done"}]


def test_a_handler_that_returns_none_posts_and_acks_nothing(env):
    w, run, _ = env
    reg = Registry()
    reg.register("gone", lambda ev, ctx: None)
    ev = {"id": 7, "user_id": 111, "role": "owner", "session_id": "s1", "action": "gone", "priority": 0, "lease_id": "L7"}
    assert sr.main_event(sr.Cfg(), ev, reg) == 4 and w.acks() == [] and w.says() == []


# --- the loader ---


def test_names_come_from_the_env_comma_list():
    assert plugins.names("a.b, c.d,,") == ["a.b", "c.d"] and plugins.names("") == []


def test_load_into_imports_each_plugin_and_lets_it_register():
    reg = Registry()
    assert plugins.load_into(reg, ["toy_ping"]) == ["toy_ping"] and "ping" in reg


def test_the_env_var_is_what_the_registry_builder_reads(monkeypatch):
    monkeypatch.setenv("PULT_PLUGINS", "toy_ping")
    assert "ping" in sr.build_registry() and plugins.load() == ["toy_ping"]


def test_a_plugin_that_cannot_be_imported_is_an_error_naming_it():
    with pytest.raises(plugins.PluginError, match="no_such_plugin_xyz"):
        plugins.load_into(Registry(), ["no_such_plugin_xyz"])


def test_a_plugin_without_register_or_with_a_raising_register_is_an_error(tmp_path, monkeypatch):
    (tmp_path / "bare_plugin.py").write_text("X = 1\n")
    (tmp_path / "raising_plugin.py").write_text("def register(r):\n    raise RuntimeError('boom')\n")
    monkeypatch.syspath_prepend(str(tmp_path))
    with pytest.raises(plugins.PluginError, match="no register"):
        plugins.load_into(Registry(), ["bare_plugin"])
    with pytest.raises(plugins.PluginError, match="boom"):
        plugins.load_into(Registry(), ["raising_plugin"])


def test_pult_run_stops_at_start_on_a_broken_plugin(monkeypatch, tmp_path, capsys):
    from pult import runner

    monkeypatch.setenv("PULT_PLUGINS", "no_such_plugin_xyz")
    monkeypatch.setenv("PULT_LOG", str(tmp_path / "log"))
    monkeypatch.setattr(sys, "argv", ["pult-run", "--once"])
    assert runner.main() == 78
    assert "no_such_plugin_xyz" in capsys.readouterr().err and "startup error" in (tmp_path / "log").read_text()


def test_workflows_merge_over_the_defaults_and_draft_only_gains_deny_rules(monkeypatch):
    monkeypatch.setenv("PULT_PLUGINS", "toy_ping")
    base = json.loads(sr.cfgmod.data_text("workflows.json"))
    merged = plugins.apply_workflows(base)
    d = merged["workflows"]["draft"]
    assert d["disallowed_tools"][-1] == "Read(**/toy-secret*)" and set(base["workflows"]["draft"]["disallowed_tools"]) <= set(d["disallowed_tools"])
    assert d["allowed_tools"] == base["workflows"]["draft"]["allowed_tools"] and d["permission_mode"] == "dontAsk"


@pytest.mark.parametrize("patch", [{"permission_mode": "bypassPermissions"}, {"allowed_tools": ["Bash"]}, {"resume": True}, {"cwd": "~"}])
def test_an_extension_cannot_weaken_the_draft_workflow(patch, tmp_path, monkeypatch):
    (tmp_path / "evil_plugin.py").write_text(f"def register(r):\n    pass\n\ndef workflows():\n    return {{'draft': {patch!r}}}\n")
    monkeypatch.syspath_prepend(str(tmp_path))
    base = json.loads(sr.cfgmod.data_text("workflows.json"))
    with pytest.raises(plugins.PluginError, match="refused to change the draft workflow"):
        plugins.apply_workflows(base, ["evil_plugin"])


def test_a_new_workflow_is_added_and_an_existing_non_draft_one_is_replaced(tmp_path, monkeypatch):
    (tmp_path / "wf_plugin.py").write_text("def register(r):\n    pass\n\ndef workflows():\n    return {'workflows': {'review': {'cwd': '~', 'permission_mode': 'plan'}, 'chat': {'cwd': '/', 'permission_mode': 'plan'}}}\n")
    monkeypatch.syspath_prepend(str(tmp_path))
    merged = plugins.apply_workflows(json.loads(sr.cfgmod.data_text("workflows.json")), ["wf_plugin"])
    assert merged["workflows"]["review"]["permission_mode"] == "plan" and merged["workflows"]["chat"]["cwd"] == "/"


def test_the_registry_module_exports_the_pieces_extensions_import():
    assert {"Action", "ActionResult", "Ctx", "Registry"} <= set(dir(actions)) and FAKE
