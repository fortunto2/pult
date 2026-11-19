"""Start (or reattach) a Claude Code session that your Telegram bot chat is wired into.

    live-session                     a fresh session in $LIVE_SESSION_CWD (default: your home directory)
    live-session --resume <id>       reattach a session by its Claude session id
    live-session -c                  continue the last session of this directory

Everything after the command name goes to claude. The channel is `tg-channel` (an MCP server over stdio); claude shows a
confirmation screen for --dangerously-load-development-channels on every start (custom channels are not on the research-preview
allowlist). Plain messages in the bot chat go to this session while it runs; when it exits they go back to the normal queue.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from pult import paths


def mcp_config(path: Path) -> Path:
    """Write the MCP config that starts this package's channel server; returns the file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    argv = paths.script_argv("tg-channel", "pult.channel")
    path.write_text(json.dumps({"mcpServers": {"telegram": {"command": argv[0], "args": argv[1:]}}}, indent=2))
    return path


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    cfg = mcp_config(paths.WORK / "live-session-mcp.json")
    os.chdir(os.path.expanduser(os.environ.get("LIVE_SESSION_CWD") or "~"))
    os.execvp("claude", ["claude", "--mcp-config", str(cfg), "--dangerously-load-development-channels", "server:telegram", *args])


def cli() -> None:
    sys.exit(main())


if __name__ == "__main__":
    cli()
