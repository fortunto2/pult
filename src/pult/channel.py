"""Telegram live channel for an interactive Claude Code session (an MCP server on stdio, Claude Code "channels" contract).

    live-session [claude options]      the usual way: writes the MCP config and starts claude with this channel

What it does: on start it attaches (POST /sessions/live: a session with workflow 'live' becomes today's target), then polls
POST /events/pull {slot:'live', session} every POLL_S. Each plain text message of the owner arrives in the session as
<channel source="telegram" message_id=... event=...>text</channel>; files are downloaded into ~/pult-sessions/<session>/inbox/
and listed. The session answers with the `reply` tool (POST /sessions/<id>/say, Markdown is converted by the worker).
Permission relay: a tool-approval prompt is sent to the chat, `yes abcde` / `no abcde` from the owner answers it (only the
owner's own messages ever reach this channel: the worker leases the owner's plain text of this one session and nothing else).
While attached, pult-run (session-run) leaves this session's plain text alone; a minute after this process dies it takes
the messages again, and on a clean exit the detach is immediate.

stdout is the MCP wire: duplicated at start, everything else that prints goes to stderr.
Env: PULT_URL, PULT_KEY_FILE, PULT_CHANNEL_TITLE, PULT_CHANNEL_POLL_S, PULT_SESSIONS_DIR, PULT_CHANNEL_HELLO=0.
"""

import json
import os
import re
import signal
import sys
import threading
import time
import urllib.error
import urllib.request

WIRE = sys.__stdout__   # replaced by claim_wire() when run as a server


def claim_wire() -> None:
    """stdout is the MCP wire: keep a private copy of fd 1 for it and point everything else's stdout at stderr."""
    global WIRE
    WIRE = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
    os.dup2(2, 1)  # a library's print() lands on stderr, never on the wire
    sys.stdout = sys.stderr

VERSION = "0.1.0"
from pult import paths as cfgmod  # noqa: E402

UA = cfgmod.UA
PERMISSION_REPLY = re.compile(r"^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$", re.I)
INSTRUCTIONS = """\
These are the owner's own messages from their phone, sent through their Telegram bot to THIS session. Each arrives as
<channel source="telegram" message_id="..." event="...">text</channel>; files they sent are listed under the text with their local paths
(read them; a voice note is an audio file: transcribe it before you answer).
The owner cannot see this terminal. Answer every message with the `reply` tool: short, the answer or the decision first, no preamble,
no recap. Long output, code and diffs stay on the screen; say in one line that the details are on the screen. For work that takes more than
a few seconds call `reply` with progress=true first ("looking at X"); the next normal reply replaces that line. Use loud=true only when you cannot
continue without their answer. Tool-approval prompts reach their phone too: they answer `yes <id>` or `no <id>`. Nothing leaves the Mac in the
owner's name because of a message here unless they asked for exactly that."""
TOOLS = [{
    "name": "reply",
    "description": "Send a message to the owner in the Telegram bot chat, as a reply to the owner's last message. Markdown is converted. Silent unless loud.",
    "inputSchema": {"type": "object", "properties": {
        "text": {"type": "string", "description": "the message, short"},
        "loud": {"type": "boolean", "description": "ring the phone: only when you need an answer"},
        "progress": {"type": "boolean", "description": "a plain live line that the next normal reply replaces"},
    }, "required": ["text"]},
}]

_wire_lock, _wire_open = threading.Lock(), threading.Event()


def send(obj: dict) -> None:
    with _wire_lock:
        WIRE.write(json.dumps(obj, ensure_ascii=False) + "\n")
        WIRE.flush()


def notify(method: str, params: dict) -> None:
    _wire_open.wait()   # a notification before notifications/initialized would be dropped
    send({"jsonrpc": "2.0", "method": method, "params": params})


class Cfg:
    def __init__(self) -> None:
        e = os.environ.get
        self.worker = cfgmod.url()
        self.key = cfgmod.owner_key_file().read_text().strip()   # the owner's own key
        self.title = e("PULT_CHANNEL_TITLE", "orchestrator")
        self.poll_s = float(e("PULT_CHANNEL_POLL_S", "2"))
        self.sessions_dir = cfgmod.sessions_dir()
        self.hello = e("PULT_CHANNEL_HELLO", "1") != "0"


def call(cfg: Cfg, method: str, path: str, body: dict | None = None, raw: bool = False):
    req = urllib.request.Request(f"{cfg.worker}{path}", method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {cfg.key}", "Content-Type": "application/json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()
        return data if raw else json.loads(data or b"null")


def log(msg: str) -> None:
    print(f"tg-channel: {msg}", file=sys.stderr, flush=True)


def safe_name(f: dict) -> str:
    return re.sub(r"[^\w.\-]", "_", f.get("name") or f["file_id"][:12])


def fetch_files(cfg: Cfg, sid: str, ev: dict) -> list[str]:
    """Download the event's files while its lease is held; one line per file for the session (path, or why not)."""
    lines = []
    inbox = cfg.sessions_dir / sid / "inbox"
    for f in ev.get("files") or []:
        name = safe_name(f)
        try:
            inbox.mkdir(parents=True, exist_ok=True)
            path = inbox / f"{ev['id']}-{name}"
            path.write_bytes(call(cfg, "GET", f"/files/{f['file_id']}?event={ev['id']}", raw=True))
            lines.append(f"[file {f.get('kind', 'file')}: {path}]")
        except urllib.error.HTTPError as e:
            lines.append(f"[file {name}: {'larger than 20 MB, not downloaded' if e.code == 413 else 'download failed'}]")
        except OSError:
            lines.append(f"[file {name}: download failed, network]")
    return lines


class Channel:
    def __init__(self, cfg: Cfg) -> None:
        self.cfg = cfg
        self.sid: str | None = None
        self.last_msg: int | None = None
        self.progress_on = False
        self.delivered: set[int] = set()
        self.halt = threading.Event()

    def attach(self) -> None:
        r = call(self.cfg, "POST", "/sessions/live", {"title": self.cfg.title})
        first = self.sid is None
        self.sid = r["id"]
        log(f"attached to session {self.sid}")
        if first and self.cfg.hello:
            self.say("Live session attached. Write here, the answer comes from the terminal.")

    def detach(self) -> None:
        if not self.sid:
            return
        try:
            call(self.cfg, "POST", f"/sessions/{self.sid}/detach", {})
            log("detached")
        except (OSError, ValueError):
            log("detach failed; the worker releases the session itself after 60 s")

    def say(self, text: str, **kw) -> dict:
        return call(self.cfg, "POST", f"/sessions/{self.sid}/say", {"text": text, **kw})

    # --- the session calls this ---
    def tool_reply(self, a: dict) -> str:
        text = str(a.get("text") or "").strip()
        if not text:
            raise ValueError("text is empty")
        if a.get("progress"):
            self.say(text, key="prog:live", fmt="plain", reply_to=self.last_msg)
            self.progress_on = True
            return "progress line shown"
        self.say(text, reply_to=self.last_msg, loud=bool(a.get("loud")))
        if self.progress_on:   # the answer landed: the live line goes
            try:
                call(self.cfg, "POST", f"/sessions/{self.sid}/say", {"delete": True, "key": "prog:live"})
            except (OSError, ValueError):
                pass
            self.progress_on = False
        return "sent"

    # --- Claude Code calls this when a tool-approval dialog opens ---
    def permission_request(self, p: dict) -> None:
        text = (f"Claude wants to run {p.get('tool_name')}: {p.get('description')}\n{p.get('input_preview', '')}"[:3000]
                + f"\n\nAnswer \"yes {p.get('request_id')}\" or \"no {p.get('request_id')}\"")
        try:
            self.say(text, fmt="plain", loud=True)
        except (OSError, ValueError) as e:
            log(f"permission prompt not sent: {e}")

    # --- inbound ---
    def deliver(self, ev: dict) -> None:
        text = (ev.get("text") or "").strip()
        m = PERMISSION_REPLY.match(text)
        if m:   # a verdict, never chat text
            notify("notifications/claude/channel/permission", {"request_id": m.group(2).lower(), "behavior": "allow" if m.group(1).lower().startswith("y") else "deny"})
        else:
            files = fetch_files(self.cfg, self.sid or "", ev)
            body = "\n".join(p for p in [text, *files] if p) or "(empty message)"
            notify("notifications/claude/channel", {"content": body, "meta": {"message_id": str(ev.get("reply_to") or 0), "event": str(ev["id"])}})   # Claude Code rejects non-string meta and drops the connection
            self.last_msg = ev.get("reply_to") or self.last_msg

    def poll_once(self) -> bool:
        r = call(self.cfg, "POST", "/events/pull", {"slot": "live", "session": self.sid})
        ev = r.get("event") if isinstance(r, dict) else None
        if not ev:
            return False
        if ev["id"] not in self.delivered:
            self.deliver(ev)
            self.delivered.add(ev["id"])
        # delivery is the job: ack now (a redelivery after a lost ack is skipped above)
        call(self.cfg, "POST", f"/events/{ev['id']}/ack", {"status": "done", "lease_id": ev.get("lease_id")})
        return True

    def poll_loop(self) -> None:
        while not self.halt.is_set():
            try:
                busy = self.poll_once()
            except urllib.error.HTTPError as e:
                busy = False
                if e.code == 404:   # the worker lost the session: attach again
                    try:
                        self.attach()
                    except (OSError, ValueError):
                        pass
                else:
                    log(f"pull: HTTP {e.code}")
            except (OSError, ValueError) as e:
                busy = False
                log(f"pull: {e}")
            if not busy:
                self.halt.wait(self.cfg.poll_s)


def reply(mid, result=None, error=None) -> None:
    send({"jsonrpc": "2.0", "id": mid, **({"error": error} if error else {"result": result})})


def serve(cfg: Cfg) -> None:
    ch = Channel(cfg)

    def bye(*_a) -> None:
        ch.halt.set()
        ch.detach()
        os._exit(0)

    signal.signal(signal.SIGTERM, bye)
    signal.signal(signal.SIGHUP, bye)
    started = threading.Event()

    def start() -> None:
        for _ in range(60):   # the worker may be unreachable for a moment at launch
            try:
                ch.attach()
                break
            except (OSError, ValueError) as e:
                log(f"attach: {e}")
                time.sleep(2)
        else:
            return
        threading.Thread(target=ch.poll_loop, daemon=True).start()

    for raw in sys.stdin.buffer:
        try:
            msg = json.loads(raw)
        except ValueError:
            continue
        mid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
        if method == "initialize":
            reply(mid, {"protocolVersion": params.get("protocolVersion", "2025-06-18"),
                        "capabilities": {"experimental": {"claude/channel": {}, "claude/channel/permission": {}}, "tools": {}},
                        "serverInfo": {"name": "telegram", "version": VERSION}, "instructions": INSTRUCTIONS})
        elif method == "notifications/initialized":
            _wire_open.set()
            if not started.is_set():
                started.set()
                threading.Thread(target=start, daemon=True).start()
        elif method == "tools/list":
            reply(mid, {"tools": TOOLS})
        elif method == "tools/call":
            try:
                if params.get("name") != "reply":
                    raise ValueError(f"unknown tool {params.get('name')}")
                out, err = ch.tool_reply(params.get("arguments") or {}), False
            except Exception as e:  # noqa: BLE001  the session must see why, not a silent failure
                out, err = f"{type(e).__name__}: {e}", True
            reply(mid, {"content": [{"type": "text", "text": out}], "isError": err})
        elif method == "notifications/claude/channel/permission_request":
            ch.permission_request(params)
        elif method == "ping":
            reply(mid, {})
        elif mid is not None:
            reply(mid, error={"code": -32601, "message": f"unknown method {method}"})
    ch.halt.set()   # Claude Code closed the pipe
    ch.detach()
    os._exit(0)


def cli() -> None:
    claim_wire()
    serve(Cfg())


if __name__ == "__main__":
    cli()
