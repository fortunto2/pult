"""Where pult finds its roots, its worker and its keys. Everything is an env var with a sane default.

    PULT_HOME     this checkout (derived from this file); {PULT} in workflows and rules, and bin/ with the script shims, live here
    PULT_WORK     live state of the Mac side: drafts/, deny file, logs. Default $PULT_HOME/_work
    PULT_WORKFLOWS  full override of the workflows file. Default: the packaged pult/data/workflows.json
    PULT_PLUGINS  comma list of importable modules, each with register(registry) (see pult.plugins)
    PULT_PROGRESS draft (default) | edit: how the "working..." line of a turn is shown (see pult.session_run)
    PULT_URL      the worker's base URL (no trailing slash). Else the first line of ~/.config/pult/url
    PULT_STATE    runner state (flock, limit-until, completed events). Default ~/.config/pult
    keys          a key is a file with one line. Owner scripts (bot-item, bot-say, tg-channel) read PULT_KEY_FILE,
                  else ~/.config/pult/run_key. The runner (pult-run, session-run) reads PULT_RUNNER_KEY_FILE,
                  else ~/.config/pult/runner_key, else run_key.
    PULT_DENY_FILE  optional: regex lines (one per line). A line of output or an item that matches is dropped.
                  When the variable is set the file must exist: a missing file is a refusal, not an empty wall.
"""

from __future__ import annotations

import json
import os
import re
import ssl
import sys
import urllib.parse
import urllib.request
from importlib import resources
from pathlib import Path

PULT_HOME = Path(os.environ.get("PULT_HOME") or Path(__file__).resolve().parents[2]).expanduser().resolve()
BIN = PULT_HOME / "bin"
WORK = Path(os.environ.get("PULT_WORK") or PULT_HOME / "_work").expanduser()
CONFIG_DIR = Path(os.environ.get("PULT_CONFIG_DIR") or Path.home() / ".config/pult").expanduser()
UA = "pult/1"   # Cloudflare refuses the default Python-urllib agent (403)


def agent_rules_text() -> str:
    """The rules a chat turn starts with: PULT_AGENT_RULES (a file that replaces the packaged text) or the packaged agent-rules.txt."""
    f = os.environ.get("PULT_AGENT_RULES")
    return Path(f).expanduser().read_text() if f else data_text("agent-rules.txt")


def data_text(name: str) -> str:
    """A file shipped inside the package (pult/data/<name>)."""
    return resources.files("pult").joinpath("data", name).read_text(encoding="utf-8")


def workflows_file() -> Path | None:
    """PULT_WORKFLOWS when set (a full override), else None: the packaged default is used."""
    e = os.environ.get("PULT_WORKFLOWS")
    return Path(e).expanduser() if e else None


def workflows_text() -> str:
    f = workflows_file()
    return f.read_text() if f else data_text("workflows.json")


def script_argv(name: str, module: str) -> list[str]:
    """argv that runs one of pult's own tools: the bin/ shim of this checkout when it exists, else `python -m <module>`."""
    shim = BIN / name
    return [sys.executable, str(shim)] if shim.exists() else [sys.executable, "-m", module]


def _loopback(u: str) -> bool:
    host = (urllib.parse.urlsplit(u).hostname or "").lower()
    return host in {"localhost", "127.0.0.1", "::1"} or host.startswith("127.")


def url() -> str:
    """The worker URL. Under pytest (PYTEST_CURRENT_TEST is set) anything but a loopback address is refused, so a test that forgot to point at its own worker can
    never post into a live chat; a test that really means to talk to a live worker sets PULT_ALLOW_LIVE_IN_TESTS=1."""
    u = _url()
    if os.environ.get("PYTEST_CURRENT_TEST") and not os.environ.get("PULT_ALLOW_LIVE_IN_TESTS") and not _loopback(u):
        raise SystemExit(f"pult: refusing {u} under pytest: not a loopback worker (set PULT_ALLOW_LIVE_IN_TESTS=1 to opt in)")
    return u


def _url() -> str:
    u = os.environ.get("PULT_URL")
    if not u:
        f = CONFIG_DIR / "url"
        u = f.read_text().strip() if f.exists() else ""
    if not u:
        raise SystemExit("pult: set PULT_URL (or write the worker URL into ~/.config/pult/url)")
    return u.rstrip("/")


def owner_key_file() -> Path:
    return Path(os.environ.get("PULT_KEY_FILE") or CONFIG_DIR / "run_key").expanduser()


def runner_key_file() -> Path:
    e = os.environ.get("PULT_RUNNER_KEY_FILE")
    if e:
        return Path(e).expanduser()
    return CONFIG_DIR / ("runner_key" if (CONFIG_DIR / "runner_key").exists() else "run_key")


def state_dir() -> Path:
    return Path(os.environ.get("PULT_STATE") or CONFIG_DIR).expanduser()


def sessions_dir() -> Path:
    return Path(os.environ.get("PULT_SESSIONS_DIR") or Path.home() / "pult-sessions").expanduser()


def fill(text: str) -> str:
    """Write the placeholders out: {PULT} and {WORK} are single absolute paths, plus whatever plugins' `placeholders()` name."""
    from pult import hooks  # noqa: PLC0415  (hooks imports plugins imports paths)

    for extra in hooks.collect("placeholders"):   # a plugin's own names, e.g. {BOT} or {CRM}; they win over the built-in two
        for k, v in extra.items():
            text = text.replace("{" + k + "}", str(v))
    return text.replace("{PULT}", str(PULT_HOME)).replace("{WORK}", str(WORK))


def expand_rules(rules: list[str]) -> list[str]:
    """Permission rules as the claude CLI wants them: placeholders filled, `{HOME}` written out twice (`~` and absolute)."""
    out: list[str] = []
    for r in map(fill, rules):
        out += [r.replace("{HOME}", "~"), r.replace("{HOME}", os.path.expanduser("~"))] if "{HOME}" in r else [r]
    return out


class DenyFileMissing(Exception):
    pass


_DENY_CACHE: dict[tuple[str, int, int], list[re.Pattern]] = {}


def _file_patterns() -> list[re.Pattern]:
    f = os.environ.get("PULT_DENY_FILE")
    if not f:
        return []
    p = Path(f).expanduser()
    if not p.exists():
        raise DenyFileMissing(f"PULT_DENY_FILE={f} does not exist; refusing to run without the wall")
    st = p.stat()   # `bot-item seen` asks once per line: cached per (path, mtime, size), so an edit of the file is seen at once
    key = (str(p), st.st_mtime_ns, st.st_size)
    if key not in _DENY_CACHE:
        _DENY_CACHE.clear()
        _DENY_CACHE[key] = [re.compile(ln.strip(), re.I) for ln in p.read_text().splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
    return _DENY_CACHE[key]


def deny_patterns() -> list[re.Pattern]:
    """The wall: PULT_DENY_FILE (optional) plus every plugin's `wall()` (see pult.hooks). Unset: no patterns. Set but unreadable, or a plugin wall that
    raises DenyFileMissing: refuse (fail closed)."""
    from pult import hooks  # noqa: PLC0415  (hooks imports plugins imports paths)

    return [*_file_patterns(), *(p for walls in hooks.collect("wall") for p in walls)]


def denied(*texts: str | None, patterns: list[re.Pattern] | None = None) -> bool:
    pats = deny_patterns() if patterns is None else patterns
    return any(p.search(t) for t in texts if t for p in pats)


def ssl_context() -> ssl.SSLContext:
    """python.org Framework builds ship no CA bundle; fall back to the macOS system one (verification stays on)."""
    cafile = "/etc/ssl/cert.pem"
    return ssl.create_default_context(cafile=cafile if Path(cafile).exists() else None)


def owner_request(method: str, path: str, body: dict | None = None):
    """One JSON call to the worker with the owner's key. HTTPError propagates."""
    req = urllib.request.Request(
        f"{url()}{path}", method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {owner_key_file().read_text().strip()}", "Content-Type": "application/json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30, context=ssl_context()) as r:
        return json.load(r)
