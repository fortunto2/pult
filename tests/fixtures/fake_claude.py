#!/usr/bin/env python3
"""A stand-in for `claude -p ... --output-format stream-json --verbose`: prints a scripted session and exits.

FAKE_CLAUDE_SCRIPT is a JSON list: {"line": {...}} prints a stream-json line, {"sleep": s} waits, {"exit": n} exits.
It records its argv to FAKE_CLAUDE_ARGV (JSON) so tests can check --resume, --permission-mode and the prompt.
"""
import json
import os
import sys
import time

if p := os.environ.get("FAKE_CLAUDE_ARGV"):
    with open(p, "w") as f:
        json.dump(sys.argv[1:], f)
for step in json.loads(os.environ.get("FAKE_CLAUDE_SCRIPT", "[]")):
    if "sleep" in step:
        time.sleep(step["sleep"])
    elif "line" in step:
        print(json.dumps(step["line"]), flush=True)
    elif "exit" in step:
        sys.exit(step["exit"])
