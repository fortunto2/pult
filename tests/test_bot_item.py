"""bot-item: argument handling and the body shape the worker's /items expects (no network)."""

import pytest

from pult import items as bi


def test_snooze_alias_expands_in_order_without_duplicates():
    assert bi.expand_actions("done,snooze,drop") == ["done", "snooze_1h", "snooze_tomorrow", "snooze_3d", "drop"]
    assert bi.expand_actions("done, done ,snooze_1h") == ["done", "snooze_1h"]


def test_decision_body_shape():
    b = bi.decision_body("gmail:x", "Title", "body", "done,drop", "now", "sweep")
    assert b == {"id": "gmail:x", "kind": "decision", "title": "Title", "body": "body", "actions": ["done", "drop"],
                 "urgency": "now", "source": "sweep"}


def test_decision_body_omits_missing_source_and_never_carries_a_user():
    b = bi.decision_body("a", "t")
    assert "source" not in b and "user_id" not in b and "user" not in b
    assert b["urgency"] == "today" and b["actions"][0] == "done"


def test_cli_posts_to_items_and_prints_one_line(monkeypatch, capsys):
    seen = {}

    def fake(method, path, body=None):
        seen.update(method=method, path=path, body=body)
        return {"id": "a", "result": "insert", "state": "shown", "message_id": 5, "render_errors": []}

    monkeypatch.setattr(bi, "request", fake)
    assert bi.main(["decision", "--id", "a", "--title", "T", "--actions", "done", "--urgency", "week"]) == 0   # week: no today-cap lookup after the write
    assert seen["method"] == "POST" and seen["path"] == "/items" and seen["body"]["actions"] == ["done"]
    assert capsys.readouterr().out.strip() == "a: insert, state shown, message 5"


def test_close_encodes_the_id_for_the_path(monkeypatch, capsys):
    seen = {}
    monkeypatch.setattr(bi, "request", lambda m, p, b=None: seen.update(path=p, body=b) or {"id": "gmail:x", "changed": True, "state": "dropped"})
    bi.main(["close", "gmail:x", "--drop"])
    assert seen["path"] == "/items/gmail%3Ax/state" and seen["body"] == {"state": "dropped"}


def test_close_expire_sends_state_expired(monkeypatch):
    seen = {}
    monkeypatch.setattr(bi, "request", lambda m, p, b=None: seen.update(path=p, body=b) or {"id": "incident:x", "changed": True, "state": "expired"})
    bi.main(["close", "incident:x", "--expire"])
    assert seen["body"] == {"state": "expired"}


def test_resolve_expires_only_open_incidents_with_the_prefix(monkeypatch, capsys):
    calls = []
    rows = [{"id": "incident:sweep:2026-11-12", "state": "shown"}, {"id": "incident:sweep:2026-11-11", "state": "done"},
            {"id": "incident:checks:2026-11-12", "state": "new"}]
    def fake(m, p, b=None):
        calls.append((m, p, b))
        return rows if m == "GET" else {"changed": True}
    monkeypatch.setattr(bi, "request", fake)
    assert bi.main(["resolve", "incident:sweep:"]) == 0
    assert capsys.readouterr().out.strip() == "1"
    assert calls[1:] == [("POST", "/items/incident%3Asweep%3A2026-11-12/state", {"state": "expired"})]
    with pytest.raises(SystemExit):
        bi.main(["resolve", "gmail:"])   # a card of his can never be expired by a script


def test_resolve_meeting_only_after_its_end(monkeypatch, capsys):
    now = 1_800_000_000_000
    monkeypatch.setattr(bi.time, "time", lambda: now / 1000)
    rows = [{"id": "meeting:a|1", "state": "shown", "expires_at": now - 1}, {"id": "meeting:b|1", "state": "shown", "expires_at": now + 600_000}]
    posted = []
    monkeypatch.setattr(bi, "request", lambda m, p, b=None: rows if m == "GET" else posted.append(p) or {"changed": True})
    assert bi.main(["resolve", "meeting:"]) == 0
    assert capsys.readouterr().out.strip() == "1" and posted == ["/items/meeting%3Aa%7C1/state"]


def test_decision_is_silent_unless_loud():
    assert "loud" not in bi.decision_body("a", "t")
    assert bi.decision_body("a", "t", loud=True)["loud"] is True


def test_put_body_per_kind():
    inc = bi.put_body("incident", "incident:sweep:2026-11-12", "sweep failed", "rc=1", fix="tail -50 log")
    assert inc == {"id": "incident:sweep:2026-11-12", "kind": "incident", "title": "sweep failed", "body": "rc=1", "payload": {"fix": "tail -50 log"}}
    m = bi.put_body("meeting", "meeting:e1", "Call", start=1794470000, expires_in_min=90, loud=True, now_ms=1_000_000)
    assert m["payload"] == {"start": 1794470000} and m["expires_at"] == 1_000_000 + 90 * 60_000 and m["loud"] is True
    assert "payload" not in bi.put_body("digest", "d", "t") and "expires_at" not in bi.put_body("digest", "d", "t")


def test_custom_actions_become_label_instruction_pairs():
    b = bi.decision_body("a", "t", custom=["Size=Show what takes the space", "Plans = Compare the plans"])
    assert b["custom_actions"] == [{"label": "Size", "instruction": "Show what takes the space"},
                                   {"label": "Plans", "instruction": "Compare the plans"}]
    assert "custom_actions" not in bi.decision_body("a", "t")


@pytest.mark.parametrize("spec", ["no equals sign", "=only instruction", "label=", "x" * 25 + "=i", "l=" + "i" * 301])
def test_bad_custom_action_fails_before_the_network(spec):
    with pytest.raises(SystemExit):
        bi.parse_custom([spec])


def test_four_custom_actions_are_refused():
    with pytest.raises(SystemExit):
        bi.parse_custom([f"l{i}=do" for i in range(4)])


def test_card_refuses_a_non_https_link():
    with pytest.raises(SystemExit):
        bi.decision_body("x", "t", link="http://insecure", details=True)



def test_card_is_a_decision_with_link_source_and_an_automatic_details_button():
    b = bi.decision_body("mail:t1", "Sam: invoice", "Pay by Friday", bi.DEFAULT_ACTIONS, "today", "card", False, None,
                         "https://mail.example.test/t1", "Mail", None, details=True)
    assert b["kind"] == "decision" and b["payload"] == {"link": "https://mail.example.test/t1", "source_label": "Mail", "card": True}
    from pult.i18n import t

    assert b["custom_actions"][0]["label"] == t("item.details_label") and len(b["custom_actions"][0]["instruction"]) <= 300


def test_details_instruction_starts_with_the_phrase_session_run_routes_on():
    from pult import session_run as sr
    from pult.i18n import t

    assert t("item.details_instruction").startswith(sr.DETAILS_HEAD)


def test_a_denied_item_writes_nothing(tmp_path, monkeypatch, capsys):
    (tmp_path / "deny.txt").write_text("secretco\n")
    monkeypatch.setenv("PULT_DENY_FILE", str(tmp_path / "deny.txt"))
    monkeypatch.setattr(bi, "request", lambda *a, **k: pytest.fail("nothing may be written"))
    assert bi.main(["decision", "--id", "a", "--title", "Reply to SecretCo"]) == 0
    assert "filtered" in capsys.readouterr().out


def test_card_direct_hold_and_contract_fields_go_into_the_payload_only_when_set():
    assert "direct" not in (bi.decision_body("tg:-1", "t", details=True).get("payload") or {})
    assert bi.decision_body("tg:-1", "t", details=True, direct=True)["payload"]["direct"] is True
    assert "hold" not in bi.decision_body("a", "t") and bi.decision_body("a", "t", hold=True)["hold"] is True
    b = bi.decision_body("a", "t", hard_due="2026-11-30", meta={"money": True})
    assert b["payload"]["meta"] == {"money": True, "hard_due": "2026-11-30"}
    with pytest.raises(SystemExit):
        bi.decision_body("a", "t", hard_due="30.11")


def test_a_telegram_user_link_is_a_valid_card_link():
    assert bi.decision_body("a", "t", link="tg://user?id=42")["payload"]["link"] == "tg://user?id=42"
    with pytest.raises(SystemExit):
        bi.decision_body("a", "t", link="tg://user?id=x")


def test_answers_become_buttons_at_most_three():
    assert bi.parse_answers("Yes=yes, No=no") == [{"label": "Yes", "value": "yes"}, {"label": "No", "value": "no"}]
    for bad in ("Yes", "a=1,b=2,c=3,d=4", "=x"):
        with pytest.raises(SystemExit):
            bi.parse_answers(bad)


def test_seen_lines_round_trip_the_item_seen_format():
    assert bi.parse_seen_lines("gmail:x\tNotion closes\nnot a line\n tg:y \t facts ") == [
        {"id": "gmail:x", "text": "Notion closes"}, {"id": "tg:y", "text": "facts"}]
    out = bi.format_seen([{"status": "NEW", "id": "a", "text": "t1"}, {"status": "OLD", "id": "b", "days": 3, "text": "t2"},
                          {"status": "CHANGED", "id": "c", "text": "t3"}])
    assert out == ["NEW\ta\tt1", "OLD\tb\t3\tt2", "CHANGED\tc\tt3", "# new=1 changed=1 old=1"]


def test_tz_label_reads_like_a_zone_not_an_offset():
    assert bi.tz_label("America/New_York") == "New York" and bi.tz_label("UTC") == "UTC"


def test_now_falls_back_to_the_local_clock_when_the_worker_is_down(monkeypatch, capsys):
    monkeypatch.setattr(bi, "request", lambda *a, **k: (_ for _ in ()).throw(SystemExit("down")))
    assert bi.main(["now"]) == 0
    assert capsys.readouterr().out.strip().count(":") == 1


def test_seen_command_prints_lines_and_the_wall_drops_denied_ones(monkeypatch, capsys, tmp_path):
    import io

    (tmp_path / "deny.txt").write_text("secretco\n")
    monkeypatch.setenv("PULT_DENY_FILE", str(tmp_path / "deny.txt"))
    monkeypatch.setattr("sys.stdin", io.StringIO("a\tx\nb\tabout SecretCo\n"))
    sent = []
    monkeypatch.setattr(bi, "request", lambda m, p, b=None: sent.append(b) or {"results": [{"status": "NEW", "id": "a", "text": "x"}]})
    bi.main(["seen", "sweep"])
    assert sent[0]["items"] == [{"id": "a", "text": "x"}]
    assert capsys.readouterr().out.splitlines() == ["NEW\ta\tx", "# new=1 changed=0 old=0"]


def test_reply_draft_posts_text_with_its_hash(monkeypatch, capsys):
    import hashlib

    seen = []
    monkeypatch.setattr(bi, "request", lambda m, p, b=None: seen.append((m, p, b)) or {"changed": True})
    monkeypatch.setattr("sys.stdin", __import__("io").StringIO("Hi! See you at 7.\n"))
    assert bi.main(["reply-draft", "tg:55", "--ring", "--missing", " the time "]) == 0
    m, path, body = seen[0]
    assert (m, path) == ("POST", "/items/tg%3A55/reply-draft") and body["text"] == "Hi! See you at 7." and body["ring"] is True and body["missing"] == "the time"
    assert body["hash"] == hashlib.sha256(b"Hi! See you at 7.").hexdigest()
    assert "attached" in capsys.readouterr().out


def test_flag_progress_draft_sets_and_shows_the_d1_row(monkeypatch, capsys):
    calls = []

    def fake(method, path, body=None):
        calls.append((method, path, body))
        return {"value": "0"} if method == "GET" else {"ok": True}

    monkeypatch.setattr(bi, "request", fake)
    assert bi.main(["flag", "progress-draft", "off"]) == 0
    assert calls[0] == ("POST", "/owner/flag", {"key": "PROGRESS_DRAFT", "value": "0"}) and "off" in capsys.readouterr().out
    calls.clear()
    bi.main(["flag", "progress-draft", "show"])
    assert [c[0] for c in calls] == ["GET"]


PLUGIN = """
def item_args(cmd, parser):
    if cmd == "card":
        parser.add_argument("--tg-urgent")

def item_gate(cmd, args, body):
    if cmd == "card" and args.id.startswith("tg:") and not args.tg_urgent:
        return ("skip", args.id + ": skipped, a chat item needs --tg-urgent")
    if cmd == "decision" and not args.why:
        return ("refuse", "a decision says why it exists: --why")

def item_payload(cmd, args, payload):
    return {**payload, "source": "plugin"}

def item_after(cmd, args, result):
    return ["after " + result["id"]]

def item_commands():
    def configure(p):
        p.add_argument("word")
    def run(args, request):
        print("ran " + args.word + " " + str(request("GET", "/ping")))
        return 0
    return {"shout": (configure, run)}
"""


def test_plugin_hooks_gate_extend_and_add_subcommands(monkeypatch, tmp_path, capsys):
    import sys

    (tmp_path / "itemplug.py").write_text(PLUGIN)
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.setenv("PULT_PLUGINS", "itemplug")
    sys.modules.pop("itemplug", None)
    sent = []
    monkeypatch.setattr(bi, "request", lambda m, p, b=None: sent.append((m, p, b)) or {"id": "x", "result": "created", "state": "new", "message_id": 5})
    assert bi.main(["card", "--id", "tg:1", "--title", "t"]) == 0
    assert "needs --tg-urgent" in capsys.readouterr().out and not sent
    with pytest.raises(SystemExit) as e:
        bi.main(["decision", "--id", "d", "--title", "t"])
    assert "--why" in str(e.value) and not sent
    assert bi.main(["card", "--id", "tg:1", "--title", "t", "--tg-urgent", "now"]) == 0
    assert sent[0][2]["source"] == "plugin" and "after x" in capsys.readouterr().out
    assert bi.main(["shout", "hey"]) == 0
    assert "ran hey" in capsys.readouterr().out
