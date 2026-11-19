"""bot-say splits long text into parts the worker keeps whole (it slices at 4,000 UTF-16 units)."""

import importlib.machinery
import importlib.util
import sys
from pathlib import Path

BIN = Path(__file__).resolve().parent.parent / "bin"
sys.path.insert(0, str(BIN))
_loader = importlib.machinery.SourceFileLoader("bot_say", str(BIN / "bot-say"))
_spec = importlib.util.spec_from_loader("bot_say", _loader)
assert _spec
bs = importlib.util.module_from_spec(_spec)
_loader.exec_module(bs)


def test_short_text_is_one_part():
    assert bs.split("hello") == ["hello"]


def test_long_text_cuts_at_paragraphs_and_loses_nothing():
    paras = [f"paragraph {i} " + "x" * 900 for i in range(10)]
    text = "\n\n".join(paras)
    parts = bs.split(text)
    assert len(parts) > 1
    assert all(bs.u16(p) <= bs.LIMIT_TEXT for p in parts)
    assert all(p.startswith("paragraph") for p in parts)  # cut between paragraphs, not inside
    assert "\n\n".join(parts) == text


def test_emoji_count_as_two_units():
    text = "🤖" * 2500  # 2,500 characters, 5,000 UTF-16 units
    parts = bs.split(text)
    assert len(parts) == 2
    assert all(bs.u16(p) <= bs.LIMIT_TEXT for p in parts)
    assert "".join(parts) == text


def test_a_smaller_first_limit_applies_to_the_first_part_only():
    text = "word " * 600  # 3,000 units
    parts = bs.split(text, first=1000)
    assert bs.u16(parts[0]) <= 1000
    assert len(parts) == 2


def test_say_long_sends_every_part_and_only_the_first_carries_the_reply(monkeypatch):
    calls = []

    def fake_say(text, reply_to=None, silent=False):
        calls.append({"reply_to": reply_to, "silent": silent, "n": len(text)})
        return {"message_id": len(calls)}

    monkeypatch.setattr(bs, "say", fake_say)
    out = bs.say_long("a" * 9000, reply_to=5, silent=True)
    assert len(calls) == 3 and calls[0]["reply_to"] == 5 and calls[1]["reply_to"] is None and all(c["silent"] for c in calls)
    assert sum(c["n"] for c in calls) == 9000 and out[0]["message_id"] == 1


def test_item_parts_title_is_the_first_line_and_a_short_text_is_one_item():
    (p,) = bs.item_parts("Inbox, 14:00, 2 new\n\nfirst\nsecond", "sweep-1", "inbox")
    assert p == {"id": "sweep-1", "kind": "inbox", "title": "Inbox, 14:00, 2 new", "body": "first\nsecond"}


def test_a_long_text_becomes_continued_parts_and_loses_nothing():
    paras = [f"paragraph {i} " + "x" * 5000 for i in range(14)]  # ~70k chars
    parts = bs.item_parts("Title\n" + "\n\n".join(paras), "d", "digest")
    assert [p["id"] for p in parts][:3] == ["d", "d.2", "d.3"] and len(parts) > 3
    assert parts[1]["title"] == "Title (part 2)"
    assert all(len(p["body"]) <= bs.ITEM_BODY_LIMIT for p in parts)
    assert "".join(p["body"] for p in parts).count("paragraph") == 14


def test_empty_first_line_still_gets_a_title():
    assert bs.item_parts("\n\nbody", "k", "digest")[0]["title"]


def test_deny_file_drops_matching_lines_and_a_missing_file_refuses(tmp_path, monkeypatch):
    f = tmp_path / "deny.txt"
    f.write_text("# comment\nacme\n")
    monkeypatch.setenv("PULT_DENY_FILE", str(f))
    pats = bs.cfg.deny_patterns()
    assert bs.strip_denied_lines("keep\nAcme invoice\nkeep too", pats) == "keep\nkeep too"
    monkeypatch.setenv("PULT_DENY_FILE", str(tmp_path / "missing.txt"))
    import pytest

    with pytest.raises(bs.cfg.DenyFileMissing):
        bs.cfg.deny_patterns()
