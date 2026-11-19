"""bin/tg-channel against a fake worker: the MCP wire (initialize, tools, channel and permission notifications) and the worker calls."""

import json
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

BOT = Path(__file__).resolve().parent.parent
SCRIPT = BOT / "bin/tg-channel"


class Fake:
    def __init__(self):
        self.calls, self.events = [], []
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _do(self):
                n = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                fake.calls.append((self.command, self.path, body, self.headers.get("authorization")))
                out, code = {}, 200
                if self.path == "/sessions/live":
                    out = {"id": "live1", "title": "t", "claude_session_id": None}
                elif self.path == "/events/pull":
                    out = {"event": fake.events.pop(0) if fake.events else None}
                elif self.path.startswith("/files/"):
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"PDFBYTES")
                    return
                elif self.path.endswith("/say"):
                    out = {"message_id": 7}
                elif self.path.endswith(("/ack", "/detach")):
                    out = {"ok": True}
                self.send_response(code)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(out).encode())

            do_GET = do_POST = _do

        self.srv = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_port}"

    def paths(self):
        return [c[1] for c in self.calls]


class Client:
    def __init__(self, tmp_path, url):
        key = tmp_path / "key"
        key.write_text("SECRET\n")
        env = {"PATH": "/usr/bin:/bin", "PULT_URL": url, "PULT_KEY_FILE": str(key), "PULT_CHANNEL_POLL_S": "0.05",
               "PULT_SESSIONS_DIR": str(tmp_path / "sessions"), "HOME": str(tmp_path)}
        self.p = subprocess.Popen([sys.executable, str(SCRIPT)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        self.out, self.lock = [], threading.Lock()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.p.stdout:
            with self.lock:
                self.out.append(json.loads(line))

    def send(self, obj):
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", **obj}) + "\n")
        self.p.stdin.flush()

    def wait(self, pred, secs=5):
        end = time.time() + secs
        while time.time() < end:
            with self.lock:
                for m in self.out:
                    if pred(m):
                        return m
            time.sleep(0.02)
        raise AssertionError(f"no matching message in {secs}s: {self.out}")

    def handshake(self):
        self.send({"id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}})
        r = self.wait(lambda m: m.get("id") == 1)["result"]
        self.send({"method": "notifications/initialized"})
        return r


def wait_for(cond, secs=5):
    end = time.time() + secs
    while time.time() < end:
        if cond():
            return
        time.sleep(0.02)
    raise AssertionError("condition not met")


@pytest.fixture
def rig(tmp_path):
    fake = Fake()
    c = Client(tmp_path, fake.url)
    yield fake, c
    c.p.kill()


def test_initialize_declares_channel_permission_tools_and_instructions(rig):
    _, c = rig
    r = c.handshake()
    assert r["capabilities"]["experimental"] == {"claude/channel": {}, "claude/channel/permission": {}}
    assert r["capabilities"]["tools"] == {} and "reply" in r["instructions"]
    c.send({"id": 2, "method": "tools/list"})
    assert [t["name"] for t in c.wait(lambda m: m.get("id") == 2)["result"]["tools"]] == ["reply"]


def test_attach_hello_then_event_becomes_channel_notification_and_is_acked(rig, tmp_path):
    fake, c = rig
    fake.events.append({"id": 5, "text": "hello", "reply_to": 42, "lease_id": "L", "files": [{"file_id": "F1", "kind": "document", "name": "a.pdf"}]})
    c.handshake()
    n = c.wait(lambda m: m.get("method") == "notifications/claude/channel")
    assert n["params"]["meta"] == {"message_id": "42", "event": "5"}   # strings: Claude Code drops the connection on a number
    assert n["params"]["content"].startswith("hello") and "a.pdf" in n["params"]["content"]
    assert (tmp_path / "sessions/live1/inbox/5-a.pdf").read_bytes() == b"PDFBYTES"
    wait_for(lambda: "/events/5/ack" in fake.paths())
    assert ("POST", "/sessions/live", {"title": "orchestrator"}, "Bearer SECRET") in fake.calls
    assert any(p == "/events/pull" and b == {"slot": "live", "session": "live1"} for _, p, b, _ in fake.calls)
    assert any(p == "/sessions/live1/say" and "Live session" in b["text"] for _, p, b, _ in fake.calls)   # the one hello
    ack = next(b for _, p, b, _ in fake.calls if p == "/events/5/ack")
    assert ack == {"status": "done", "lease_id": "L"}


def test_reply_goes_to_say_as_a_reply_to_his_last_message_progress_is_replaced(rig):
    fake, c = rig
    fake.events.append({"id": 1, "text": "do it", "reply_to": 99, "lease_id": "L", "files": []})
    c.handshake()
    c.wait(lambda m: m.get("method") == "notifications/claude/channel")
    c.send({"id": 3, "method": "tools/call", "params": {"name": "reply", "arguments": {"text": "looking", "progress": True}}})
    assert c.wait(lambda m: m.get("id") == 3)["result"]["isError"] is False
    c.send({"id": 4, "method": "tools/call", "params": {"name": "reply", "arguments": {"text": "finished", "loud": True}}})
    c.wait(lambda m: m.get("id") == 4)
    says = [b for _, p, b, _ in fake.calls if p == "/sessions/live1/say"]
    assert {"text": "looking", "key": "prog:live", "fmt": "plain", "reply_to": 99} in says
    assert {"text": "finished", "reply_to": 99, "loud": True} in says
    assert {"delete": True, "key": "prog:live"} in says
    c.send({"id": 5, "method": "tools/call", "params": {"name": "reply", "arguments": {"text": ""}}})
    assert c.wait(lambda m: m.get("id") == 5)["result"]["isError"] is True


def test_permission_prompt_goes_to_chat_and_yes_id_becomes_a_verdict_not_chat(rig):
    fake, c = rig
    c.handshake()
    wait_for(lambda: "/sessions/live" in fake.paths())
    c.send({"method": "notifications/claude/channel/permission_request", "params": {"request_id": "abcde", "tool_name": "Bash", "description": "ls", "input_preview": "{\"command\":\"ls\"}"}})
    wait_for(lambda: any(p.endswith("/say") and "abcde" in b.get("text", "") and b.get("loud") for _, p, b, _ in fake.calls))
    fake.events.append({"id": 8, "text": "Yes ABCDE", "reply_to": 5, "lease_id": "L", "files": []})
    v = c.wait(lambda m: m.get("method") == "notifications/claude/channel/permission")
    assert v["params"] == {"request_id": "abcde", "behavior": "allow"}
    wait_for(lambda: "/events/8/ack" in fake.paths())
    assert not [m for m in c.out if m.get("method") == "notifications/claude/channel"]   # never forwarded as chat


def test_a_redelivered_event_is_acked_but_not_delivered_twice(rig):
    fake, c = rig
    ev = {"id": 3, "text": "once", "reply_to": 1, "lease_id": "L", "files": []}
    fake.events += [ev, dict(ev, lease_id="L2")]
    c.handshake()
    wait_for(lambda: fake.paths().count("/events/3/ack") == 2)
    assert len([m for m in c.out if m.get("method") == "notifications/claude/channel"]) == 1


def test_stdin_eof_detaches_and_exits(rig):
    fake, c = rig
    c.handshake()
    wait_for(lambda: "/sessions/live" in fake.paths())
    c.p.stdin.close()
    assert c.p.wait(timeout=5) == 0
    assert "/sessions/live1/detach" in fake.paths()
