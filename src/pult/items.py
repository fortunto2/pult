"""Put an item into the bot's store (D1 behind your worker). Jobs write items, never chat text.

    bot-item decision --id gmail:x --title "Reply to the invoice" [--body TEXT|-] [--actions done,snooze,drop]
                      [--urgency now|today|week] [--source sweep] [--action "label=instruction"]...
                      a decision card; up to 3 custom buttons (label <=24, instruction <=300): a press hands
                      the instruction to the agent as a read-and-draft job (it can read and write drafts, never send)
    bot-item card --id ID --title T [--body TEXT|-] [--link https://..] [--source-label S] [--copy TEXT]
                      a decision card with a link button, a source line and an automatic «More» button
    bot-item put --kind inbox|digest|incident|meeting --id ID --title T [--body TEXT|-] [--fix CMD] [--start EPOCH_S]
                 [--expires-in-min N] [--loud]       a living note, an incident with a fix command, a meeting
    bot-item list [--state open|new|shown|snoozed|done|dropped|expired] [--kind decision] [--json]
    bot-item get ID                     one item as JSON
    bot-item log ID                     every press, comment and detail of an item
    bot-item detail ID                  stdin -> the expanded section of a card (what a «More» job writes)
    bot-item reopen ID                  put an item back on the list
    bot-item close ID [--drop|--expire] mark an item done (or dropped; --expire: no trace left in the chat)
    bot-item resolve PREFIX             expire every OPEN incident (or finished meeting) whose id starts with PREFIX; prints how many
    bot-item reply-draft CARD [--missing T] [--ring] < text   a reply text shown in a card with a copy button; nothing is sent
    bot-item flag NAME on|off|show      a live switch (a settings row in D1): progress-draft
    bot-item seen SCOPE                 stdin `id<TAB>facts` lines -> NEW / CHANGED / OLD (days), state kept in the store
    bot-item now                        the owner's clock «HH:MM zone» for note headers

A card may carry --do, --why, --cost (what to do, why, what it costs) and --verb (the primary button's word); the worker shows them.
--answers 'Yes=yes,No=no' makes a closed question whose answers are the buttons; --money and --hard-due YYYY-MM-DD rank the card for `today`;
--hold creates it hidden behind the «more» button; --direct reopens a chat the owner dismissed. Plugins add flags and subcommands (pult.hooks).
Items are SILENT unless --loud. The same id with the same content creates nothing new; a closed item stays closed;
changed content reopens it. `snooze` in --actions means the three snooze buttons (1 h, tomorrow, 3 days).
Optional PULT_DENY_FILE: an item that matches one of its regexes is not written.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse

from pult import hooks
from pult import paths as cfg  # noqa: E402
from pult.i18n import t

ALIASES = {"snooze": ["snooze_1h", "snooze_tomorrow", "snooze_3d"]}
DEFAULT_ACTIONS = "done,snooze,drop"


def expand_actions(spec: str) -> list[str]:
    out: list[str] = []
    for name in (s.strip() for s in spec.split(",") if s.strip()):
        for a in ALIASES.get(name, [name]):
            if a not in out:
                out.append(a)
    return out


def parse_custom(specs: list[str] | None) -> list[dict]:
    """`label=instruction` -> {label, instruction}; the worker enforces 3 / 24 / 300, this fails early with the same words."""
    out = []
    for spec in specs or []:
        label, sep, instruction = spec.partition("=")
        label, instruction = label.strip(), instruction.strip()
        if not sep or not label or not instruction:
            sys.exit(f"bot-item: --action wants 'label=instruction', got {spec!r}")
        if len(label) > 24 or len(instruction) > 300:
            sys.exit(f"bot-item: --action label <=24 and instruction <=300 chars ({label!r})")
        out.append({"label": label, "instruction": instruction})
    if len(out) > 3:
        sys.exit("bot-item: at most 3 --action buttons")
    return out


def parse_answers(spec: str) -> list[dict]:
    """'Yes=yes,No=no' -> [{label, value}], at most 3 (the button row holds three)."""
    out = []
    for part in spec.split(","):
        label, sep, value = part.partition("=")
        if not sep or not label.strip() or not value.strip() or len(label.strip()) > 20 or len(value.strip()) > 40:
            sys.exit(f"bot-item: --answers wants 'label=value,label=value' (label <=20, value <=40), got {part!r}")
        out.append({"label": label.strip(), "value": value.strip()})
    if not 1 <= len(out) <= 3:
        sys.exit("bot-item: --answers takes 1 to 3 answers")
    return out


def decision_body(item_id: str, title: str, body: str = "", actions: str = DEFAULT_ACTIONS, urgency: str = "today",
                  source: str | None = None, loud: bool = False, custom: list[str] | None = None, link: str | None = None,
                  source_label: str | None = None, copy: str | None = None, details: bool = False, hold: bool = False, direct: bool = False,
                  hard_due: str | None = None, meta: dict | None = None) -> dict:
    """card = a decision with a link button, a source line and an automatic details button."""
    if link and not (link.startswith("https://") or re.fullmatch(r"tg://user\?id=\d+", link)):
        sys.exit(f"bot-item: --link must be https:// or tg://user?id=N, got {link!r}")
    specs = list(custom or [])
    if details and len(specs) < 3:
        specs.insert(0, f"{t('item.details_label')}={t('item.details_instruction')}")
    if hard_due and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", hard_due):
        sys.exit(f"bot-item: --hard-due wants YYYY-MM-DD, got {hard_due!r}")
    meta = {k: v for k, v in {**(meta or {}), "hard_due": hard_due}.items() if v}   # the card's contract fields: shown by the renderer, not part of the content hash
    payload = {k: v for k, v in {"link": link, "source_label": source_label, "copy": copy, "card": True if details else None,
                                 "direct": True if direct else None, "meta": meta or None}.items() if v}
    d = {"id": item_id, "kind": "decision", "title": title, "body": body, "actions": expand_actions(actions),
         "urgency": urgency, "source": source, "loud": True if loud else None,
         "custom_actions": parse_custom(specs) or None, "payload": payload or None, "hold": True if hold else None}
    return {k: v for k, v in d.items() if v is not None}


def put_body(kind: str, item_id: str, title: str, body: str = "", fix: str | None = None, start: int | None = None,
             expires_in_min: int | None = None, loud: bool = False, now_ms: int | None = None) -> dict:
    """A stream item. Actions are left to the worker's per-kind default (incident: ack)."""
    payload = {k: v for k, v in {"fix": fix, "start": start}.items() if v is not None}
    expires = (now_ms if now_ms is not None else int(time.time() * 1000)) + expires_in_min * 60_000 if expires_in_min else None
    d = {"id": item_id, "kind": kind, "title": title, "body": body, "payload": payload or None, "expires_at": expires,
         "loud": True if loud else None}
    return {k: v for k, v in d.items() if v is not None}


def request(method: str, path: str, body: dict | None = None) -> dict | list:
    try:
        return cfg.owner_request(method, path, body)
    except urllib.error.HTTPError as e:
        sys.exit(f"bot-item: {e.code} {e.read().decode()[:300]}")


def attach_reply(card_id: str, text: str, missing: str | None = None, ring: bool = False) -> str:
    """A reply text for a chat card: shown with a copy button. There is no send path for it and none is added."""
    body = {"text": text.strip(), "hash": hashlib.sha256(text.strip().encode()).hexdigest(), "missing": (missing or "").strip()[:300], "ring": ring}
    r = request("POST", f"/items/{urllib.parse.quote(card_id, safe='')}/reply-draft", body)
    return f"{card_id}: reply {body['hash'][:8]} {'attached' if r['changed'] else 'unchanged'}"  # type: ignore[call-overload,index]


FLAGS = {"progress-draft": "PROGRESS_DRAFT"}   # name -> settings key; a live switch is a D1 row, never a deploy-time variable


def parse_seen_lines(text: str) -> list[dict]:
    out = []
    for ln in text.splitlines():
        if "\t" in ln:
            iid, rest = ln.split("\t", 1)
            out.append({"id": iid.strip(), "text": rest.strip()})
    return out


def format_seen(results: list[dict]) -> list[str]:
    """One line per fact: NEW/CHANGED id text, OLD id days text, then a count line."""
    lines = [("\t".join([r["status"], r["id"], str(r["days"]), r["text"]]) if r["status"] == "OLD"
              else "\t".join([r["status"], r["id"], r["text"]])) for r in results]
    n = lambda k: sum(1 for r in results if r["status"] == k)  # noqa: E731
    return [*lines, f"# new={n('NEW')} changed={n('CHANGED')} old={n('OLD')}"]


def tz_label(tz: str) -> str:
    return hooks.first("tz_label", tz) or tz.split("/")[-1].replace("_", " ")


def local_now_label() -> str:
    """Fallback when the worker is unreachable: this machine's own clock and zone."""
    try:
        tz = os.path.realpath("/etc/localtime").split("zoneinfo/")[-1]
    except OSError:
        tz = "UTC"
    return f"{time.strftime('%H:%M')} {tz_label(tz)}"


def hooks_args(cmd: str, parser) -> None:
    for _ in hooks.collect("item_args", cmd, parser):
        pass


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("decision")
    d.add_argument("--id", required=True)
    d.add_argument("--title", required=True)
    d.add_argument("--body", default="", help="text, or - to read stdin")
    d.add_argument("--actions", default=DEFAULT_ACTIONS)
    d.add_argument("--urgency", choices=["now", "today", "week"], default="today")
    d.add_argument("--source")
    d.add_argument("--loud", action="store_true", help="may ring; default silent")
    d.add_argument("--action", action="append", metavar="LABEL=INSTRUCTION", help="custom button, up to 3")
    cd = sub.add_parser("card", help="an inbox item as its own card: More, Done/Drop, snoozes, Open")
    cd.add_argument("--id", required=True)
    cd.add_argument("--title", required=True)
    cd.add_argument("--body", default="", help="1-3 lines, or - for stdin")
    cd.add_argument("--link", help="https URL for the «Open» button (a verified one only)")
    cd.add_argument("--source-label", help="shown in italics under the card")
    cd.add_argument("--copy", help="text for a «Copy» button (a draft, a command, an address), up to 256 chars")
    cd.add_argument("--urgency", choices=["now", "today", "week"], default="today")
    cd.add_argument("--loud", action="store_true")
    cd.add_argument("--direct", action="store_true", help="a mention of the owner or a reply to them: reopens a chat they dismissed (otherwise it stays dismissed for 7 days)")
    cd.add_argument("--hold", action="store_true", help="create the card hidden (beyond the first batch of a sweep); the «more» button on the note reveals it")
    cd.add_argument("--action", action="append", metavar="LABEL=INSTRUCTION")
    for sp in (d, cd):
        sp.add_argument("--do", help="the action to take, one line")
        sp.add_argument("--why", help="why it exists: what is lost if it is not done")
        sp.add_argument("--cost", help="what it costs, e.g. '5 min'")
        sp.add_argument("--verb", help="the primary button's own word; default «Done»")
        sp.add_argument("--answers", help="a closed question: up to 3 answers as buttons, 'Yes=yes,No=no'; the tap is recorded as the item's result")
        sp.add_argument("--money", action="store_true", help="the card is about paying or being paid: ranks right after a hard deadline for `today`")
        sp.add_argument("--hard-due", help="YYYY-MM-DD of a hard deadline or a payment: ranks first for `today`")
        hooks_args(sp.prog.split()[-1], sp)
    pu = sub.add_parser("put")
    pu.add_argument("--kind", required=True, choices=["inbox", "digest", "incident", "meeting"])
    pu.add_argument("--id", required=True)
    pu.add_argument("--title", required=True)
    pu.add_argument("--body", default="", help="text, or - to read stdin")
    pu.add_argument("--fix", help="incident: the command to copy")
    pu.add_argument("--start", type=int, help="meeting: start, epoch seconds")
    pu.add_argument("--expires-in-min", type=int, help="meeting: deleted this many minutes from now")
    pu.add_argument("--loud", action="store_true")
    hooks_args("put", pu)
    rd = sub.add_parser("reply-draft", help="show a reply text in a chat card with a copy button (nothing is sent, the owner sends it themself)")
    rd.add_argument("id")
    rd.add_argument("--missing")
    rd.add_argument("--ring", action="store_true")
    fl = sub.add_parser("flag", help="a live switch (D1 settings row): progress-draft on|off|show")
    fl.add_argument("name", choices=sorted(FLAGS))
    fl.add_argument("value", choices=["on", "off", "show"])
    sn = sub.add_parser("seen", help="stdin `id<TAB>facts` lines -> NEW / CHANGED / OLD, state kept in the store")
    sn.add_argument("scope")
    sn.add_argument("--import-file", help="load an old seen file into the store")
    sub.add_parser("now", help="the owner's clock, HH:MM zone")
    extra = hooks.commands()
    for name, (configure, _run) in extra.items():
        configure(sub.add_parser(name))
    dt = sub.add_parser("detail", help="fill the expanded section of a card from stdin (a «More» job)")
    dt.add_argument("id")
    lg = sub.add_parser("log", help="every press, comment and detail of an item")
    lg.add_argument("id")
    gt = sub.add_parser("get", help="one item as JSON")
    gt.add_argument("id")
    ls = sub.add_parser("list")
    ls.add_argument("--state")
    ls.add_argument("--kind")
    ls.add_argument("--json", action="store_true")
    c = sub.add_parser("close")
    c.add_argument("id")
    c.add_argument("--drop", action="store_true")
    c.add_argument("--expire", action="store_true", help="state expired, message removed")
    rs = sub.add_parser("resolve", help="expire open incidents by id prefix: the check or job they reported is green again")
    rs.add_argument("prefix")
    ro = sub.add_parser("reopen")
    ro.add_argument("id")
    a = ap.parse_args(argv)
    q = urllib.parse.quote

    if a.cmd in extra:
        return int(extra[a.cmd][1](a, request) or 0)
    if a.cmd == "now":
        try:
            r = request("GET", "/me")
            print(f"{r['hm']} {r['label']}")  # type: ignore[call-overload]
        except SystemExit:
            print(local_now_label())
        return 0
    if a.cmd == "seen":
        if a.scope.startswith("-"):
            sys.exit(f"bot-item seen: scope must not start with '-': {a.scope!r}")
        if a.import_file:
            print(request("POST", "/seen/import", json.loads(open(a.import_file).read())))
            return 0
        try:
            wall = cfg.deny_patterns()
        except cfg.DenyFileMissing as e:
            sys.exit(f"bot-item: {e}")
        r = request("POST", "/seen", {"scope": a.scope, "items": [i for i in parse_seen_lines(sys.stdin.read()) if not cfg.denied(i["id"], i["text"], patterns=wall)]})
        print("\n".join(format_seen(r["results"])))  # type: ignore[call-overload]
        return 0
    if a.cmd == "reply-draft":
        print(attach_reply(a.id, sys.stdin.read(), a.missing, a.ring))
        return 0
    if a.cmd == "flag":   # live switches are D1 rows: a deploy from any checkout cannot flip one
        key = FLAGS[a.name]
        if a.value != "show":
            request("POST", "/owner/flag", {"key": key, "value": "1" if a.value == "on" else "0"})
        r = request("GET", f"/owner/flag?key={key}")
        print(f"{a.name}: {'on' if r.get('value') == '1' else 'off' if r.get('value') == '0' else 'default'}")  # type: ignore[union-attr]
        return 0

    if a.cmd == "resolve":
        if not a.prefix.startswith(("incident:", "meeting:")):
            sys.exit("bot-item resolve: the prefix must start with 'incident:' or 'meeting:' (job-owned streams only, never a card of the owner)")
        kind, n = a.prefix.split(":", 1)[0], 0
        for i in request("GET", f"/items?kind={kind}"):  # type: ignore[union-attr]
            over = kind == "incident" or (i.get("expires_at") or 0) <= time.time() * 1000   # a meeting only once its end has passed
            if i["id"].startswith(a.prefix) and i["state"] in ("new", "shown") and over:
                n += bool(request("POST", f"/items/{q(i['id'], safe='')}/state", {"state": "expired"})["changed"])  # type: ignore[call-overload,index]
        print(n)
        return 0
    if a.cmd == "detail":
        r = request("POST", f"/items/{q(a.id, safe='')}/detail", {"text": sys.stdin.read().strip()})
        print(f"{r['id']}: detail {'set' if r['changed'] else 'unchanged'}")  # type: ignore[call-overload]
        return 0
    if a.cmd == "log":
        r = request("GET", f"/items/{q(a.id, safe='')}/log")
        for row in r["log"]:  # type: ignore[call-overload]
            print(f"{row['at']} {row['by']:12} {row['from_state']}->{row['to_state']}  {row['note']}")
        return 0
    if a.cmd == "get":
        print(json.dumps(request("GET", f"/items/{q(a.id, safe='')}"), ensure_ascii=False, indent=2))
        return 0
    if a.cmd in ("decision", "card", "put"):
        body = sys.stdin.read().strip() if a.body == "-" else a.body
        try:
            if cfg.denied(a.title, body, getattr(a, "source_label", None), getattr(a, "link", None)):
                print(f"{a.id}: filtered (deny file), nothing written")
                return 0
        except cfg.DenyFileMissing as e:   # fail closed
            sys.exit(f"bot-item: {e}")
        for gate in hooks.collect("item_gate", a.cmd, a, body):   # a plugin may skip the write (print its line) or refuse it (exit with its text)
            how, line = gate
            if how == "skip":
                print(line)
                return 0
            sys.exit(f"bot-item {a.cmd}: {line}")
        meta = {k: v for k, v in {"do": getattr(a, "do", None), "why": getattr(a, "why", None), "cost": getattr(a, "cost", None), "verb": getattr(a, "verb", None)}.items() if v and v.strip()}
        if getattr(a, "money", False):
            meta["money"] = True
        if getattr(a, "answers", None):
            meta["answers"] = parse_answers(a.answers)
        hard_due = getattr(a, "hard_due", None)
        payload = (decision_body(a.id, a.title, body, a.actions, a.urgency, a.source, a.loud, a.action, hard_due=hard_due, meta=meta) if a.cmd == "decision"
                   else decision_body(a.id, a.title, body, DEFAULT_ACTIONS, a.urgency, "card", a.loud, a.action, a.link, a.source_label, a.copy, details=True, hold=a.hold, direct=a.direct, hard_due=hard_due, meta=meta) if a.cmd == "card"
                   else put_body(a.kind, a.id, a.title, body, a.fix, a.start, a.expires_in_min, a.loud))
        for patched in hooks.collect("item_payload", a.cmd, a, payload):
            payload = patched
        r = request("POST", "/items", payload)
        print(f"{r['id']}: {r['result']}, state {r['state']}, message {r['message_id']}")  # type: ignore[call-overload]
        for line in (x for lines in hooks.collect("item_after", a.cmd, a, r) for x in lines):
            print(line)
        for e in r.get("render_errors", []):  # type: ignore[union-attr]
            print(f"render error: {e}", file=sys.stderr)
    elif a.cmd == "list":
        qs = urllib.parse.urlencode({k: v for k, v in {"state": a.state, "kind": a.kind}.items() if v})
        items = request("GET", f"/items?{qs}")
        if a.json:
            print(json.dumps(items, ensure_ascii=False))
            return 0
        for i in items:  # type: ignore[union-attr]
            print(f"{i['state']:8} {i['urgency']:5} {i['id']}  {i['title']}")
    else:
        state = "new" if a.cmd == "reopen" else "expired" if a.cmd == "close" and a.expire else "dropped" if a.drop else "done"
        r = request("POST", f"/items/{q(a.id, safe='')}/state", {"state": state})
        print(f"{r['id']}: {r['state']}{'' if r['changed'] else ' (no change)'}")  # type: ignore[call-overload]
    return 0


def cli() -> None:
    sys.exit(main())


if __name__ == "__main__":
    cli()
