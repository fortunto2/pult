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
