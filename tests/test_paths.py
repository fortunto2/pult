"""pult.paths: every root, key and file comes from an env var with a default; the packaged data loads."""

import json
import sys

from pult import paths


def test_state_work_and_sessions_follow_their_env_vars(tmp_path, monkeypatch):
    monkeypatch.setenv("PULT_STATE", str(tmp_path / "st"))
    monkeypatch.setenv("PULT_SESSIONS_DIR", str(tmp_path / "ss"))
    monkeypatch.setenv("PULT_KEY_FILE", str(tmp_path / "k"))
    assert paths.state_dir() == tmp_path / "st" and paths.sessions_dir() == tmp_path / "ss" and paths.owner_key_file() == tmp_path / "k"
    monkeypatch.delenv("PULT_STATE")
    assert paths.state_dir() == paths.CONFIG_DIR


def test_the_packaged_defaults_are_inside_the_package():
    assert json.loads(paths.data_text("workflows.json"))["workflows"]["draft"]["permission_mode"] == "dontAsk"
    assert "{PULT}" in paths.data_text("agent-rules.txt") and paths.workflows_file() is None
    assert json.loads(paths.workflows_text()) == json.loads(paths.data_text("workflows.json"))


def test_pult_workflows_is_a_full_override_not_a_merge(tmp_path, monkeypatch):
    f = tmp_path / "mine.json"
    f.write_text('{"workflows": {"chat": {"cwd": "~", "permission_mode": "plan"}}}')
    monkeypatch.setenv("PULT_WORKFLOWS", str(f))
    assert paths.workflows_file() == f and list(json.loads(paths.workflows_text())["workflows"]) == ["chat"]


def test_script_argv_prefers_the_checkout_shim_else_python_dash_m(tmp_path, monkeypatch):
    assert paths.script_argv("bot-item", "pult.items") == [sys.executable, str(paths.BIN / "bot-item")]
    monkeypatch.setattr(paths, "BIN", tmp_path)
    assert paths.script_argv("bot-item", "pult.items") == [sys.executable, "-m", "pult.items"]


def test_the_runner_key_and_url_resolution_are_unchanged_for_extensions(tmp_path, monkeypatch):
    monkeypatch.setenv("PULT_URL", "http://127.0.0.1:8787/")
    assert paths.url() == "http://127.0.0.1:8787"
    monkeypatch.setattr(paths, "CONFIG_DIR", tmp_path)
    (tmp_path / "run_key").write_text("k")
    assert paths.runner_key_file() == tmp_path / "run_key"


def test_a_live_looking_worker_url_is_refused_under_pytest(monkeypatch):
    import pytest

    from pult import paths

    monkeypatch.delenv("PULT_ALLOW_LIVE_IN_TESTS", raising=False)
    for live in ("https://bot.example.test", "http://10.0.0.5:8787", "https://example.com"):
        monkeypatch.setenv("PULT_URL", live)
        with pytest.raises(SystemExit, match="refusing"):
            paths.url()
    for ok in ("http://127.0.0.1:8787", "http://localhost:9"):
        monkeypatch.setenv("PULT_URL", ok)
        assert paths.url() == ok
    monkeypatch.setenv("PULT_URL", "https://bot.example.test")
    monkeypatch.setenv("PULT_ALLOW_LIVE_IN_TESTS", "1")
    assert paths.url() == "https://bot.example.test"
