"""The usage-limit sentence of the Claude CLI and when it resets."""

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from pult import usage_limit as U

IST = ZoneInfo("Europe/Berlin")
NOW = datetime(2026, 11, 15, 1, 0, tzinfo=IST).timestamp()


@pytest.mark.parametrize("text,when", [
    ("You've hit your Fable limit · resets Nov 18 at 7pm (Europe/Berlin)", datetime(2026, 11, 18, 19, 1, tzinfo=IST)),
    ("You've hit your usage limit · resets 7pm (Europe/Berlin)", datetime(2026, 11, 15, 19, 1, tzinfo=IST)),
    ("hit your limit · resets 12:30pm (Europe/Berlin)", datetime(2026, 11, 15, 12, 31, tzinfo=IST)),
    ("hit your limit. resets Dec 2, 9am (Europe/Berlin)", datetime(2026, 12, 2, 9, 1, tzinfo=IST)),
])
def test_the_reset_time_is_read_in_both_cli_forms(text, when):
    assert U.reset_epoch(text, NOW, cap=False) == int(when.timestamp())


def test_the_wait_is_capped_unreadable_times_fall_back_and_other_text_is_not_a_limit():
    assert U.reset_epoch("hit your Fable limit · resets Nov 18 at 7pm (Europe/Berlin)", NOW) == int(NOW) + U.MAX_WAIT_S
    assert U.reset_epoch("You've hit your limit, try later", NOW) == int(NOW) + U.FALLBACK_S
    assert U.reset_epoch("hit your limit · resets 7pm (Mars/Olympus)", NOW) == int(NOW) + U.FALLBACK_S
    assert U.reset_epoch("Something went wrong, exit 3", NOW) is None and U.reset_epoch("", NOW) is None
