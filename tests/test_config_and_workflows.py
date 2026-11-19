"""Config resolution, and the read-and-draft security point in workflows.json."""

import json
from pathlib import Path

import pult_config as cfg
import pytest

ROOT = Path(__file__).resolve().parent.parent
WF = json.loads((ROOT / "workflows.json").read_text())["workflows"]


def test_url_comes_from_env_then_file_and_a_missing_one_is_an_error(tmp_path, monkeypatch):
    with pytest.raises(SystemExit):
        cfg.url()
    (tmp_path / "cfg").mkdir()
    (tmp_path / "cfg/url").write_text("https://pult.example.test/\n")
    monkeypatch.setattr(cfg, "CONFIG_DIR", tmp_path / "cfg")
    assert cfg.url() == "https://pult.example.test"
    monkeypatch.setenv("PULT_URL", "http://127.0.0.1:9/")
    assert cfg.url() == "http://127.0.0.1:9"


def test_runner_key_prefers_its_own_file_then_the_owner_key(tmp_path, monkeypatch):
    monkeypatch.setattr(cfg, "CONFIG_DIR", tmp_path)
    assert cfg.runner_key_file() == tmp_path / "run_key"
    (tmp_path / "runner_key").write_text("k")
    assert cfg.runner_key_file() == tmp_path / "runner_key"
    monkeypatch.setenv("PULT_RUNNER_KEY_FILE", str(tmp_path / "other"))
    assert cfg.runner_key_file() == tmp_path / "other"


def test_placeholders_and_home_are_written_out():
    assert cfg.fill("{PULT}/bin") == f"{cfg.PULT_HOME}/bin" and cfg.fill("Edit(/{WORK}/x)") == f"Edit(/{cfg.WORK}/x)"
    out = cfg.expand_rules(["Read({HOME}/x)"])
    assert out[0] == "Read(~/x)" and len(out) == 2 and out[1].startswith("Read(/")


def test_deny_file_is_optional_but_fail_closed_when_configured(tmp_path, monkeypatch):
    assert cfg.deny_patterns() == [] and not cfg.denied("anything")
    monkeypatch.setenv("PULT_DENY_FILE", str(tmp_path / "nope"))
    with pytest.raises(cfg.DenyFileMissing):
        cfg.denied("x")


def test_the_draft_workflow_is_read_and_draft_only():
    d = WF["draft"]
    assert d["permission_mode"] == "dontAsk" and d["resume"] is False
    for rule in d["allowed_tools"]:
        assert not rule.startswith(("Write", "WebFetch", "WebSearch"))
        if rule.startswith("Bash("):
            assert "bot-item get" in rule or "bot-item log" in rule or "bot-item list" in rule, f"a draft job may only read items: {rule}"
        if rule.startswith("Edit("):
            assert rule == "Edit(/{WORK}/drafts/**)"
    assert {"WebFetch", "WebSearch", "Task"} <= set(d["disallowed_tools"])
    assert "bypassPermissions" not in json.dumps(d)


def test_the_chat_workflow_is_not_bypass_by_default():
    assert WF["chat"]["permission_mode"] != "bypassPermissions"
