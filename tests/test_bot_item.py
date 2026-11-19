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
    assert b["custom_actions"][0]["label"] == bi.DETAILS_LABEL and len(b["custom_actions"][0]["instruction"]) <= 300


def test_details_instruction_starts_with_the_phrase_session_run_routes_on():
    from pult import session_run as sr

    assert bi.DETAILS_INSTRUCTION.startswith(sr.DETAILS_HEAD)


def test_a_denied_item_writes_nothing(tmp_path, monkeypatch, capsys):
    (tmp_path / "deny.txt").write_text("secretco\n")
    monkeypatch.setenv("PULT_DENY_FILE", str(tmp_path / "deny.txt"))
    monkeypatch.setattr(bi, "request", lambda *a, **k: pytest.fail("nothing may be written"))
    assert bi.main(["decision", "--id", "a", "--title", "Reply to SecretCo"]) == 0
    assert "filtered" in capsys.readouterr().out
