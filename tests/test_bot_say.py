"""bot-say splits long text into parts the worker keeps whole (it slices at 4,000 UTF-16 units)."""

from pult import say as bs


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


def test_say_long_keys_parts_and_moves_them_into_the_opened_topic(monkeypatch):
    calls = []

    def fake_say(text, key=None, issue=None, reply_to=None, thread=None, topic=None, photo=None, keyboard=False, doc=None, silent=False, replace=False):
        calls.append({"key": key, "reply_to": reply_to, "thread": thread, "topic": topic, "photo": photo, "silent": silent})
        return {"message_id": len(calls), "thread": 77 if len(calls) == 1 else thread}

    monkeypatch.setattr(bs, "say", fake_say)
    out = bs.say_long("a" * 9000, key="sweep-2026-10-27", reply_to=5, topic="Inbox", silent=True)
    assert [c["key"] for c in calls] == ["sweep-2026-10-27", "sweep-2026-10-27.2", "sweep-2026-10-27.3"]
    assert calls[0]["reply_to"] == 5 and calls[1]["reply_to"] is None and all(c["silent"] for c in calls)
    assert calls[1]["thread"] == 77 and calls[1]["topic"] is None
    assert out[0]["message_id"] == 1


def test_photo_caption_limit_applies_to_the_first_part_only():
    text = "word " * 600  # 3,000 units
    parts = bs.split(text, first=bs.LIMIT_CAPTION)
    assert bs.u16(parts[0]) <= bs.LIMIT_CAPTION


def ns(**kw):
    import argparse

    base = dict(key=None, issue=None, reply_to=None, photo=None, doc=None, keyboard=False)
    return argparse.Namespace(**{**base, **kw})


def test_key_without_extras_goes_to_the_item_path(monkeypatch):
    monkeypatch.delenv("BOT_SAY_LEGACY", raising=False)
    assert bs.use_item_path(ns(key="standup-1"))
    assert not bs.use_item_path(ns())                              # no key: /say as before
    for extra in ({"issue": 3}, {"reply_to": 4}, {"photo": "a.png"}, {"doc": "a.pdf"}, {"keyboard": True}):
        assert not bs.use_item_path(ns(key="k", **extra))          # agent answers and files keep /say


def test_legacy_flag_forces_the_old_path(monkeypatch):
    monkeypatch.setenv("BOT_SAY_LEGACY", "1")
    assert not bs.use_item_path(ns(key="k"))


def test_item_parts_title_is_the_first_line_and_a_short_text_is_one_item():
    (p,) = bs.item_parts("Inbox, 14:00, 2 new\n\nfirst\nsecond", "sweep-1", "inbox")
    assert p == {"id": "sweep-1", "kind": "inbox", "title": "Inbox, 14:00, 2 new", "body": "first\nsecond"}


def test_a_long_text_becomes_continued_parts_and_loses_nothing():
    paras = [f"paragraph {i} " + "x" * 5000 for i in range(14)]  # ~70k chars
    parts = bs.item_parts("Title\n" + "\n\n".join(paras), "d", "digest")
    assert [p["id"] for p in parts][:3] == ["d", "d.2", "d.3"] and len(parts) == 3
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


def test_one_oversize_paragraph_is_cut_at_a_space_or_line_break_and_no_text_is_lost():
    words = [f"word{i}" for i in range(10000)]
    para = " ".join(words)
    assert "\n\n" not in para and len(para) > 50000
    parts = bs.item_parts("Title\n" + para, "big", "note")
    assert len(parts) >= 2 and all(len(p["body"]) <= bs.ITEM_BODY_LIMIT for p in parts)
    assert " ".join(p["body"] for p in parts).split() == words   # every word survives, none is split in half
    assert [p["id"] for p in parts][:2] == ["big", "big.2"]
    nl = "line\n" * 12000
    assert "".join(p["body"] + "\n" for p in bs.item_parts("T\n" + nl, "k", "note")).split() == nl.split()
    blob = "x" * 70000   # no break at all: a hard cut, still lossless
    assert "".join(p["body"] for p in bs.item_parts("T\n" + blob, "k", "note")) == blob


def test_roll_item_carries_fields_drops_denied_items_and_empty_sections():
    import re

    data = {"title": "Inbox 10:14", "sections": [
        {"h": "Needs you", "items": [{"b": "PR #290", "t": "recount the row"}, {"b": "Acme", "t": "company page"}]},
        {"h": "FYI", "items": [{"t": "Acme: price"}]},   # every item denied: the section vanishes
        {"h": "Channels", "fold": True, "items": [{"t": "post"}]}],
        "quote": "Read: Gmail\nAcme page note\nTelegram"}
    (item,) = bs.roll_item("sweep-2026-11-14", "inbox", data, [re.compile("acme", re.I)])
    roll = item["payload"]["roll"]
    assert [s["h"] for s in roll["sections"]] == ["Needs you", "Channels"] and roll["sections"][1]["fold"] is True
    assert roll["sections"][0]["items"] == [{"b": "PR #290", "t": "recount the row"}]
    assert roll["quote"] == "Read: Gmail\nTelegram"
    assert item["kind"] == "inbox" and item["id"] == "sweep-2026-11-14" and item["body"].startswith("Needs you: PR #290: recount the row")


def test_a_plugin_wall_and_strings_apply(monkeypatch, tmp_path):
    """A plugin's wall() drops matching lines; its strings() renames the fallback title and the continuation."""
    import sys

    (tmp_path / "wallplug.py").write_text(
        "import re\ndef wall():\n    return [re.compile('secret', re.I)]\ndef strings():\n    return {'say.no_title': '(bez zagolovka)', 'say.part': '(chast {n})'}\n")
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.setenv("PULT_PLUGINS", "wallplug")
    sys.modules.pop("wallplug", None)
    from pult import paths

    pats = paths.deny_patterns()
    assert bs.strip_denied_lines("keep\nthe SECRET line\nkeep too", pats) == "keep\nkeep too"
    assert bs.item_parts("", "k", "digest")[0]["title"] == "(bez zagolovka)"
    big = "x" * (bs.ITEM_BODY_LIMIT + 10)
    assert bs.item_parts("T\n" + big, "k", "digest")[1]["title"] == "T (chast 2)"


def test_an_unloadable_wall_refuses_to_send(monkeypatch, capsys):
    monkeypatch.setenv("PULT_DENY_FILE", "/nonexistent/deny.txt")
    monkeypatch.setattr("sys.stdin", __import__("io").StringIO("hello"))
    try:
        bs.main(["--silent"])
        raise AssertionError("must exit")
    except SystemExit as e:
        assert "refusing" in str(e)
