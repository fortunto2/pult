"""The real worker (`wrangler dev --local`, an empty local D1 the worker migrates itself) against a Telegram stub.

Run with INTEGRATION=1 (`make integration`). One wrangler process at a time: this fixture starts exactly one for the whole session.
"""

import json
import os
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
WORKER = ROOT / "worker"
OWNER = 4242
RUN_KEY, TG_SECRET, TOKEN = "integration-run-key", "integration-hook-secret", "123:integration"


def pytest_collection_modifyitems(config, items):
    if os.environ.get("INTEGRATION") != "1":
        skip = pytest.mark.skip(reason="set INTEGRATION=1 (make integration): starts a local worker")
        for it in items:
            if "integration" in str(it.fspath):
                it.add_marker(skip)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class TelegramStub:
    """Records every Bot API call, answers ok with a counting message id; serves one file for getFile."""

    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self.next_id = 500
        me = self

        class H(BaseHTTPRequestHandler):
            def do_any(self):
                n = int(self.headers.get("content-length", 0))
                raw = self.rfile.read(n) if n else b""
                if "/file/bot" in self.path:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"file-bytes")
                    return
                try:
                    body = json.loads(raw or b"{}")
                except ValueError:
                    body = {}
                method = self.path.rsplit("/", 1)[-1]
                me.calls.append((method, body))
                me.next_id += 1
                result: object = {"message_id": me.next_id}
                if method == "getMe":
                    result = {"id": 99, "is_bot": True, "first_name": "pult", "username": "pult_test_bot", "can_join_groups": True, "can_read_all_group_messages": False, "supports_inline_queries": False}
                elif method == "getFile":
                    result = {"file_id": body.get("file_id"), "file_path": f"docs/{body.get('file_id')}", "file_size": 10}
                elif method in ("answerCallbackQuery", "setMessageReaction", "setMyCommands", "setWebhook", "deleteMessage", "editMessageReplyMarkup"):
                    result = True
                out = json.dumps({"ok": True, "result": result}).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(out)

            do_GET = do_POST = do_any

            def log_message(self, *a):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), H)
        self.root = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def of(self, method: str) -> list[dict]:
        return [b for m, b in self.calls if m == method]


class Worker:
    def __init__(self, url: str, tg: TelegramStub):
        self.url, self.tg = url, tg

    def call(self, method: str, path: str, body: dict | None = None, key: str | None = RUN_KEY):
        req = urllib.request.Request(self.url + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                     headers={"content-type": "application/json", "User-Agent": "pult-tests/1", **({"Authorization": f"Bearer {key}"} if key else {})})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    def _webhook(self, update: dict):
        req = urllib.request.Request(self.url + "/tg", method="POST", data=json.dumps(update).encode(),
                                     headers={"content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": TG_SECRET})
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status

    def message(self, text: str, who: int = OWNER, reply_to: int | None = None, mid: int = 1):
        m = {"message_id": mid, "date": 1, "chat": {"id": who, "type": "private"}, "from": {"id": who, "is_bot": False, "first_name": "Owner"}, "text": text}
        if reply_to:
            m["reply_to_message"] = {"message_id": reply_to, "date": 1, "chat": {"id": who, "type": "private"}, "from": {"id": 99, "is_bot": True, "first_name": "pult"}, "text": "x"}
        return self._webhook({"update_id": mid * 1000 + len(self.tg.calls), "message": m})

    def press(self, short: str, action: str, who: int = OWNER):
        return self._webhook({"update_id": int(time.time() * 1000) % 10**9, "callback_query": {
            "id": "cb1", "chat_instance": "ci", "from": {"id": who, "is_bot": False, "first_name": "Owner"}, "data": f"v1:{short}:{action}",
            "message": {"message_id": 1, "date": 1, "chat": {"id": who, "type": "private"}}}})


@pytest.fixture(scope="session")
def stack(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("pult-int")
    tg = TelegramStub()
    port = free_port()
    toml = tmp / "wrangler.toml"
    toml.write_text(f'name = "pult-integration"\nmain = "{WORKER / "src" / "index.ts"}"\ncompatibility_date = "2026-08-01"\n'
                    f'[[d1_databases]]\nbinding = "DB"\ndatabase_name = "pult"\ndatabase_id = "00000000-0000-0000-0000-000000000000"\n'
                    f'[vars]\nCHAT_ID = "{OWNER}"\nOWNER_TZ = "UTC"\nTELEGRAM_API_ROOT = "{tg.root}"\nTELEGRAM_BOT_TOKEN = "{TOKEN}"\nTG_SECRET = "{TG_SECRET}"\nRUN_KEY = "{RUN_KEY}"\n')
    state = tmp / "state"
    base = ["npx", "--yes", "wrangler@4"]
    # no schema step: the worker migrates its own empty D1 on the first request
    proc = subprocess.Popen([*base, "dev", "--local", "--config", str(toml), "--persist-to", str(state), "--port", str(port), "--ip", "127.0.0.1"],
                            cwd=WORKER, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    url = f"http://127.0.0.1:{port}"
    deadline = time.time() + 120
    while time.time() < deadline:
        try:
            urllib.request.urlopen(urllib.request.Request(url + "/items", headers={"Authorization": f"Bearer {RUN_KEY}"}), timeout=2)
            break
        except Exception:
            if proc.poll() is not None:
                raise RuntimeError("wrangler dev exited:\n" + (proc.stdout.read() if proc.stdout else "")) from None
            time.sleep(0.5)
    else:
        proc.kill()
        raise RuntimeError("wrangler dev did not come up in 120 s")
    yield Worker(url, tg), tmp
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest.fixture
def worker(stack):
    w, _ = stack
    w.tg.calls.clear()
    return w


@pytest.fixture
def mac_env(stack, monkeypatch):
    """What a Mac-side script sees: the worker's URL and key files, state under tmp."""
    w, tmp = stack
    (tmp / "run_key").write_text(RUN_KEY)
    cfg = tmp / "cfg"
    cfg.mkdir(exist_ok=True)
    for k, v in {"PULT_URL": w.url, "PULT_KEY_FILE": str(tmp / "run_key"), "PULT_RUNNER_KEY_FILE": str(tmp / "run_key"), "PULT_CONFIG_DIR": str(cfg),
                 "PULT_STATE": str(tmp / "mac-state"), "PULT_WORK": str(tmp / "work"), "PULT_SESSIONS_DIR": str(tmp / "sessions")}.items():
        monkeypatch.setenv(k, v)
    return tmp
