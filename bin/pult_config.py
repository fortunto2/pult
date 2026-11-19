"""Where pult finds its roots, its worker and its keys. Everything is an env var with a sane default.

    PULT_HOME     this checkout (derived from this file)
    PULT_WORK     live state of the Mac side: drafts/, deny file, logs. Default $PULT_HOME/_work
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
import urllib.request
from pathlib import Path

PULT_HOME = Path(os.environ.get("PULT_HOME") or Path(__file__).resolve().parent.parent).expanduser().resolve()
BIN = PULT_HOME / "bin"
WORK = Path(os.environ.get("PULT_WORK") or PULT_HOME / "_work").expanduser()
CONFIG_DIR = Path(os.environ.get("PULT_CONFIG_DIR") or Path.home() / ".config/pult").expanduser()
UA = "pult/1"   # Cloudflare refuses the default Python-urllib agent (403)


def url() -> str:
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
    """Write the placeholders out: {PULT} and {WORK} are single absolute paths."""
    return text.replace("{PULT}", str(PULT_HOME)).replace("{WORK}", str(WORK))


def expand_rules(rules: list[str]) -> list[str]:
    """Permission rules as the claude CLI wants them: placeholders filled, `{HOME}` written out twice (`~` and absolute)."""
    out: list[str] = []
    for r in map(fill, rules):
        out += [r.replace("{HOME}", "~"), r.replace("{HOME}", os.path.expanduser("~"))] if "{HOME}" in r else [r]
    return out


class DenyFileMissing(Exception):
    pass


def deny_patterns() -> list[re.Pattern]:
    """Optional wall. Unset: no patterns. Set but unreadable: refuse (fail closed)."""
    f = os.environ.get("PULT_DENY_FILE")
    if not f:
        return []
    p = Path(f).expanduser()
    if not p.exists():
        raise DenyFileMissing(f"PULT_DENY_FILE={f} does not exist; refusing to run without the wall")
    return [re.compile(ln.strip(), re.I) for ln in p.read_text().splitlines() if ln.strip() and not ln.lstrip().startswith("#")]


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
