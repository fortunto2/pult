"""Write to the owner through the bot. The token stays in Cloudflare; this talks to your worker.

    echo "text" | bot-say                       a new message (POST /say)
    echo "text" | bot-say --key standup-DATE    one living message: with --key the text becomes an ITEM (id = key,
                                                first line = title, kind digest by default) that the worker renders
                                                silently and edits in place on the next call
    echo "text" | bot-say --kind inbox --key sweep-DATE   a living note of kind inbox
    echo "text" | bot-say --issue 12 --reply-to 345       an agent answer; the owner's reply to it continues issue 12
    echo "caption" | bot-say --photo chart.png            a picture (chart, screenshot)
    echo "caption" | bot-say --doc report.pdf             a file (PDF and the like), up to ~10 MB
    echo "text" | bot-say --silent               no notification sound
    echo "text" | bot-say --key K --replace      delete the keyed message and send a new one (notifies), instead of editing
    echo "text" | bot-say --keyboard             also (re)attach the persistent keyboard
    echo '{"title": ..., "sections": [...]}' | bot-say --roll --key K    a roll-up laid out by the worker from fields

Prints the Telegram message_id (0 when the worker has not shown the item yet). A text over the worker's limit is split into
parts that lose nothing. Lines matching the wall (PULT_DENY_FILE and any plugin `wall()`) are dropped before anything is sent, and a wall
that cannot be loaded refuses everything. --topic and --thread are accepted and ignored (one chat). --issue, --reply-to, --photo, --doc and
--keyboard use the plain /say path. BOT_SAY_LEGACY=1 forces that path for everything; if the item path fails the text goes out that way: never lost.
"""
import argparse
import base64
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

from pult import paths as cfg  # noqa: E402
from pult.i18n import t

UA = cfg.UA
CTX = cfg.ssl_context()
LIMIT_TEXT, LIMIT_CAPTION = 4000, 1000   # the worker slices JS strings, so its limits are UTF-16 units, not characters
ITEM_BODY_LIMIT = int(os.environ.get("PULT_ITEM_BODY_LIMIT") or 30000)   # the worker keeps a note up to this many characters; a rich message holds 32768


def worker() -> str:
    return cfg.url()


def key_text() -> str:
    return cfg.owner_key_file().read_text().strip()


def post(path: str, body: dict) -> dict:
    req = urllib.request.Request(f"{worker()}{path}", data=json.dumps(body).encode(), method="POST", headers={
        "Authorization": f"Bearer {key_text()}", "Content-Type": "application/json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30, context=CTX) as r:
        return json.load(r)


def say(text: str, key: str | None = None, issue: int | None = None, reply_to: int | None = None,
        thread: int | None = None, topic: str | None = None, photo: str | None = None,
        keyboard: bool = False, doc: str | None = None, silent: bool = False, replace: bool = False) -> dict:
    b64 = base64.b64encode(Path(photo).read_bytes()).decode() if photo else None
    d64 = base64.b64encode(Path(doc).read_bytes()).decode() if doc else None
    body = {k: v for k, v in {"text": text, "key": key, "issue": issue, "reply_to": reply_to, "thread": thread,
                              "topic": topic, "photo_b64": b64, "doc_b64": d64,
                              "doc_name": Path(doc).name if doc else None, "keyboard": keyboard,
                              "silent": silent, "replace": replace}.items() if v}
    return post("/say", body)


def u16(s: str) -> int:
    return len(s.encode("utf-16-le")) // 2


def _fit(text: str, limit: int) -> int:
    """The longest prefix of text, in characters, that fits limit UTF-16 units."""
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if u16(text[:mid]) <= limit:
            lo = mid
        else:
            hi = mid - 1
    return lo


def split(text: str, first: int = LIMIT_TEXT, rest: int = LIMIT_TEXT) -> list[str]:
    """Parts that each fit the worker, cut at a paragraph, else a line, else a space. Nothing is lost."""
    parts, limit = [], first
    while u16(text) > limit:
        end = _fit(text, limit)
        cut = end
        for sep in ("\n\n", "\n", " "):
            i = text.rfind(sep, 0, end)
            if i > end // 2:
                cut = i
                break
        parts.append(text[:cut].rstrip())
        text = text[cut:].lstrip()
        limit = rest
    parts.append(text)
    return parts


def say_long(text: str, key: str | None = None, issue: int | None = None, reply_to: int | None = None,
             thread: int | None = None, topic: str | None = None, photo: str | None = None,
             keyboard: bool = False, doc: str | None = None, silent: bool = False, replace: bool = False) -> list[dict]:
    """say(), split into parts that fit. Part n of a living message gets key `<key>.n`, so every
    later edit lands on the same messages; the first part carries the photo and the reply."""
    parts = split(text, LIMIT_CAPTION if photo or doc else LIMIT_TEXT)
    out: list[dict] = []
    for n, part in enumerate(parts, 1):
        first = n == 1
        r = say(part, key if first or not key else f"{key}.{n}", issue, reply_to if first else None,
                thread, topic, photo if first else None, keyboard and n == len(parts), doc if first else None, silent, replace)
        if first and r.get("thread"):
            thread, topic = r["thread"], None  # the rest go into the topic the first one opened
        out.append(r)
    return out


def _pieces(paras: list[str]) -> list[str]:
    """Paragraphs no longer than the limit: an oversize one is cut at its last line break or space before the limit, so no text is dropped."""
    out = []
    for para in paras:
        while len(para) > ITEM_BODY_LIMIT:
            cut = max(para.rfind("\n", 0, ITEM_BODY_LIMIT), para.rfind(" ", 0, ITEM_BODY_LIMIT))
            cut = cut if cut > ITEM_BODY_LIMIT // 2 else ITEM_BODY_LIMIT
            out.append(para[:cut])
            para = para[cut:].lstrip()
        out.append(para)
    return out


def item_parts(text: str, key: str, kind: str) -> list[dict]:
    """The item bodies for a text: first line is the title; a text over the limit becomes `key`, `key.2`, ... with a continued title."""
    first, _, rest = text.strip().partition("\n")
    title, rest = first.strip()[:300] or t("say.no_title"), rest.strip()
    if len(rest) <= ITEM_BODY_LIMIT:
        return [{"id": key, "kind": kind, "title": title, "body": rest}]
    chunks, cur = [], ""
    for para in _pieces(rest.split("\n\n")):
        if cur and len(cur) + len(para) + 2 > ITEM_BODY_LIMIT:
            chunks.append(cur)
            cur = ""
        cur = f"{cur}\n\n{para}" if cur else para
    chunks.append(cur)
    return [{"id": key if n == 1 else f"{key}.{n}", "kind": kind, "title": title if n == 1 else f"{title[:270]} {t('say.part', n=n)}",
             "body": c[:ITEM_BODY_LIMIT]} for n, c in enumerate(chunks, 1)]


def roll_item(key: str, kind: str, data: dict, patterns: list | None = None) -> list[dict]:
    """A roll-up from FIELDS: {title, sections: [{h, items: [{b?, t, url?, label?}], fold?}], quote?}. The worker builds the message from payload.roll;
    body is a plain-text twin for the log and the Mini App. Items the wall matches are dropped here, empty sections vanish."""
    bad = lambda *tx: bool(patterns) and any(p.search(x) for x in tx if x for p in patterns)  # noqa: E731
    secs = []
    for sec in data.get("sections", []):
        items = [i for i in sec.get("items", []) if i.get("t") and not bad(i.get("t"), i.get("b"), i.get("url"), i.get("label"))]
        if items:
            secs.append({"h": sec["h"], "items": items, **({"fold": True} if sec.get("fold") else {})})
    quote = "\n".join(ln for ln in (data.get("quote") or "").splitlines() if not bad(ln)) or None
    title = str(data.get("title") or "").strip()[:300] or t("say.no_title")
    lines = [f"{sec['h']}: " + "; ".join(f"{i.get('b') + ': ' if i.get('b') else ''}{i['t']}" for i in sec["items"]) for sec in secs]
    body = "\n".join([*lines, *([quote] if quote else [])])
    if not re.search(r"\S", str(data.get("title") or "")):
        sys.exit(t("say.roll_title"))
    return [{"id": key, "kind": kind, "title": title, "body": body[:ITEM_BODY_LIMIT], "payload": {"roll": {"sections": secs, **({"quote": quote} if quote else {})}}}]


def put_items(parts: list[dict]) -> int:
    mid = 0
    for body in parts:
        mid = mid or (post("/items", body).get("message_id") or 0)
    return mid


def strip_denied_lines(text: str, patterns: list) -> str:
    return "\n".join(ln for ln in text.splitlines() if not any(p.search(ln) for p in patterns)) if patterns else text


def use_item_path(a: argparse.Namespace) -> bool:
    legacy = os.environ.get("BOT_SAY_LEGACY") or os.environ.get("PULT_SAY_LEGACY")
    return bool(a.key) and not (legacy or a.issue or a.reply_to or a.photo or a.doc or a.keyboard)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--key")
    ap.add_argument("--issue", type=int)
    ap.add_argument("--reply-to", type=int)
    ap.add_argument("--topic")
    ap.add_argument("--photo")
    ap.add_argument("--doc")
    ap.add_argument("--keyboard", action="store_true")
    ap.add_argument("--silent", action="store_true")
    ap.add_argument("--replace", action="store_true")
    ap.add_argument("--kind", choices=["inbox", "digest"], default="digest")
    ap.add_argument("--thread", type=int)
    ap.add_argument("--roll", action="store_true", help="stdin is JSON {title, sections:[{h, items:[{b,t,url,label}], fold}], quote}: the worker lays the roll-up out from fields")
    a = ap.parse_args(argv)
    text = sys.stdin.read().strip()
    try:
        patterns = cfg.deny_patterns()   # fail closed: a configured but unloadable wall means nothing is sent
    except cfg.DenyFileMissing as e:
        sys.exit(f"bot-say: {e}")
    if a.roll:
        if not a.key:
            sys.exit("bot-say --roll needs --key")
        try:
            data = json.loads(text)
        except ValueError as e:
            sys.exit(f"bot-say --roll: stdin is not JSON ({e})")
        print(put_items(roll_item(a.key, a.kind, data, patterns)))
        return 0
    text = strip_denied_lines(text, patterns).strip()
    if not text:
        print(0)
        return 0
    if (a.topic or a.thread) and not (os.environ.get("BOT_SAY_LEGACY") or os.environ.get("PULT_SAY_LEGACY")):
        print(f"bot-say: --topic/--thread ignored, single chat (topic {a.topic!r})", file=sys.stderr)
        a.topic = a.thread = None
    if use_item_path(a):
        if a.replace:
            print("bot-say: --replace ignored, the worker decides what to re-send", file=sys.stderr)
        try:
            print(put_items(item_parts(text, a.key, a.kind)))
            return 0
        except Exception as e:  # noqa: BLE001 - never lose the text: fall through to the plain path
            print(f"bot-say: item path failed ({str(e)[:120]}), sending the old way", file=sys.stderr)
    out = say_long(text, a.key, a.issue, a.reply_to, topic=a.topic, thread=a.thread, photo=a.photo,
                   keyboard=a.keyboard, doc=a.doc, silent=a.silent, replace=a.replace)
    print(out[0].get("message_id", 0))
    return 0


def cli() -> None:
    sys.exit(main())


if __name__ == "__main__":
    cli()
