"""A Claude usage limit hit in a run's output, and when it resets (15.11.2026).

The CLI says e.g. «You've hit your Fable limit · resets Nov 18 at 7pm (Europe/Berlin)» (the older form has no date: «resets 7pm (Europe/Berlin)»).
`reset_epoch` returns the reset moment (+1 min), or None when the text is not a usage limit; an unreadable time is 30 minutes from now. The wait is capped (MAX_WAIT_S) so a misread date can never park the bot for days.
"""

from __future__ import annotations

import re
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

LIMIT = re.compile(r"hit your .{0,40}limit|usage limit reached|limit reached", re.I)
RESET = re.compile(r"resets\s+(?:(?P<mon>[A-Z][a-z]{2,8})\.?\s+(?P<day>\d{1,2})(?:,|\s+at)?\s+)?(?P<h>\d{1,2})(?::(?P<m>\d{2}))?\s?(?P<ap>[ap])m\s*\((?P<tz>[^)]+)\)", re.I)
MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
MAX_WAIT_S = 6 * 3600
FALLBACK_S = 1800


def is_limit(text: str) -> bool:
    return bool(text and LIMIT.search(text))


def reset_epoch(text: str, now: float | None = None, cap: bool = True) -> int | None:
    """None when the text is not a usage limit."""
    return parse_reset(text, now, cap) if is_limit(text) else None


def parse_reset(text: str, now: float | None = None, cap: bool = True) -> int:
    """The reset moment in `text` (+1 min), whether or not the sentence names a limit; unreadable = now + 30 min."""
    t_now = now if now is not None else time.time()
    m = RESET.search(text)
    until = None
    if m:
        try:
            tz = ZoneInfo(m["tz"].strip())
            n = datetime.fromtimestamp(t_now, tz)
            hour = int(m["h"]) % 12 + (12 if m["ap"].lower() == "p" else 0)
            if m["mon"]:
                mon = MONTHS[m["mon"][:3].lower()]
                t = n.replace(month=mon, day=int(m["day"]), hour=hour, minute=int(m["m"] or 0), second=0, microsecond=0)
                if t < n - timedelta(days=1):
                    t = t.replace(year=n.year + 1)
            else:
                t = n.replace(hour=hour, minute=int(m["m"] or 0), second=0, microsecond=0)
                if t <= n:
                    t += timedelta(days=1)
            until = int(t.timestamp()) + 60
        except (KeyError, ValueError, OSError):
            until = None
    if until is None or until <= t_now:
        until = int(t_now) + FALLBACK_S
    return int(min(until, t_now + MAX_WAIT_S)) if cap else int(until)   # cap=False: the real reset, for the line the person reads
