"""The Mac-side scripts against the real worker: a card, its buttons, a message through the queue to a (fake) Claude and back."""

import json
import os
import subprocess
import sys
from pathlib import Path

from .conftest import OWNER

ROOT = Path(__file__).resolve().parents[2]
FAKE = str(ROOT / "tests/fixtures/fake_claude.py")


def run(script: str, *args: str, stdin: str | None = None, **env) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(ROOT / "bin" / script), *args], input=stdin, capture_output=True, text=True, timeout=120, env={**os.environ, **env})


def test_a_card_is_shown_pressed_and_collapsed(worker, mac_env):
    r = run("bot-item", "card", "--id", "mail:int-1", "--title", "Reply to the vendor", "--body", "They asked for a date.", "--link", "https://example.com/t/1", "--do", "Reply to the vendor", "--why", "they wait on us")
    assert r.returncode == 0, r.stderr
    assert "mail:int-1: insert, state shown" in r.stdout
    sent = worker.tg.of("sendMessage")[-1]
    assert "Reply to the vendor" in sent["text"] and sent["parse_mode"] == "HTML"
    labels = [b["text"] for row in sent["reply_markup"]["inline_keyboard"] for b in row]
    assert {"✅ Done", "⏰ Later", "✖️ Not needed", "More", "↗ Open"} <= set(labels)

    again = run("bot-item", "card", "--id", "mail:int-1", "--title", "Reply to the vendor", "--body", "They asked for a date.", "--link", "https://example.com/t/1", "--do", "Reply to the vendor", "--why", "they wait on us")
    assert "touch" in again.stdout, "the same content creates nothing new"

    short = json.loads(run("bot-item", "get", "mail:int-1").stdout)  # public view hides `short`: read it from the keyboard
    assert short["state"] == "shown"
    data = next(b["callback_data"] for row in sent["reply_markup"]["inline_keyboard"] for b in row if b["text"] == "✅ Done")
    _, short_id, action = data.split(":")
    assert worker.press(short_id, action) == 200
    assert json.loads(run("bot-item", "get", "mail:int-1").stdout)["state"] == "done"
    collapsed = worker.tg.of("editMessageText")[-1]
    assert collapsed["text"].startswith("✓ done: Reply to the vendor")
    assert collapsed["reply_markup"] == {"inline_keyboard": []}


def test_a_stranger_pressing_the_owner_s_button_changes_nothing(worker, mac_env):
    run("bot-item", "card", "--id", "mail:int-2", "--title", "Private card")
    data = next(b["callback_data"] for row in worker.tg.of("sendMessage")[-1]["reply_markup"]["inline_keyboard"] for b in row if b["text"] == "✅ Done")
    _, short_id, action = data.split(":")
    def calls():
        return [m for m, _ in worker.tg.calls if m != "getMe"]   # grammY asks getMe on a cold start; that is not an answer

    before = len(calls())
    assert worker.press(short_id, action, who=OWNER + 1) == 200
    assert json.loads(run("bot-item", "get", "mail:int-2").stdout)["state"] == "shown"
    assert len(calls()) == before, "not even an answerCallbackQuery"


def test_a_message_goes_through_the_queue_to_claude_and_back(worker, mac_env, tmp_path):
    assert worker.message("what is on my plate?", mid=11) == 200
    script = [{"line": {"type": "system", "subtype": "init", "session_id": "cl-int-1"}},
              {"line": {"type": "result", "subtype": "success", "is_error": False, "result": "Two things: **write the report**, then review.", "session_id": "cl-int-1"}}]
    wf = tmp_path / "wf.json"
    wf.write_text(json.dumps({"workflows": {"chat": {"cwd": str(tmp_path), "permission_mode": "acceptEdits", "allowed_tools": None, "timeout_s": 60}}}))
    worker.tg.calls.clear()
    r = run("pult-run", "--once", "--slot", "interactive", PULT_CLAUDE=json.dumps([sys.executable, FAKE]), FAKE_CLAUDE_SCRIPT=json.dumps(script), PULT_WORKFLOWS=str(wf),
            HEARTBEAT_S="0.5", PROGRESS_S="30")
    assert r.returncode == 0, r.stderr + r.stdout
    answers = [c for c in worker.tg.of("sendMessage") if "write the report" in c.get("text", "")]
    assert answers, worker.tg.calls
    assert answers[-1]["text"] == "Two things: <b>write the report</b>, then review."
    assert answers[-1]["reply_parameters"]["message_id"] == 11
    status, depth = worker.call("GET", "/events/depth")
    assert depth["running"] == 0 and depth["queued"] == {}


def test_bot_say_and_the_worker_refuse_a_missing_key(worker, mac_env):
    assert run("bot-say", stdin="build finished").returncode == 0
    assert worker.tg.of("sendMessage")[-1]["text"] == "build finished"
    assert worker.call("POST", "/say", {"text": "x"}, key=None)[0] == 403
    assert worker.call("POST", "/say", {"text": "x"}, key="not-the-key")[0] == 403
