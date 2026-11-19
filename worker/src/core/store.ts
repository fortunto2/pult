// D1 around fsm.ts. Every transition is one conditional UPDATE (compare-and-set on the old state) plus its log row in one batch:
// zero rows matched means somebody else got there first, and nothing is logged.
import type { Incoming, Item, LogRow, State } from './contract.ts';
import { sweepItem, transition, unwork, upsert, work, type UpsertResult } from './fsm.ts';

type Row = Record<string, unknown>;
const J = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

export function rowToItem(r: Row): Item {
  return { ...(r as unknown as Item), actions: JSON.parse(String(r.actions ?? '[]')), payload: r.payload ? JSON.parse(String(r.payload)) : null, loud: !!r.loud,
    working: (r.working as string | null) ?? null, custom: r.custom ? JSON.parse(String(r.custom)) : [] };
}

const logStmt = (db: D1Database, l: LogRow) =>
  db.prepare('INSERT INTO item_log (user_id, item_id, at, from_state, to_state, by, note) SELECT ?,?,?,?,?,?,? WHERE changes() > 0')
    .bind(l.user_id, l.item_id, l.at, l.from_state, l.to_state, l.by, l.note);

export async function getItem(db: D1Database, userId: number, id: string): Promise<Item | null> {
  const r = await db.prepare('SELECT * FROM items WHERE user_id = ? AND id = ?').bind(userId, id).first<Row>();
  return r ? rowToItem(r) : null;
}
export async function getByShort(db: D1Database, userId: number, short: string): Promise<Item | null> {
  const r = await db.prepare('SELECT * FROM items WHERE user_id = ? AND short = ?').bind(userId, short).first<Row>();
  return r ? rowToItem(r) : null;
}
export async function listItems(db: D1Database, userId: number, f: { state?: string; kind?: string }): Promise<Item[]> {
  const where = ['user_id = ?'], args: unknown[] = [userId];
  if (f.state === 'open') where.push("state IN ('new','shown','snoozed')");
  else if (f.state) { where.push('state = ?'); args.push(f.state); }
  if (f.kind) { where.push('kind = ?'); args.push(f.kind); }
  const { results } = await db.prepare(`SELECT * FROM items WHERE ${where.join(' AND ')} ORDER BY first_seen DESC LIMIT 200`).bind(...args).all<Row>();
  return results.map(rowToItem);
}

// Content only for an in-place update; a reopen also restarts the life of the item. Never the message fields: the renderer owns those.
const writeAll = (db: D1Database, i: Item, reopen: boolean) =>
  db.prepare(`UPDATE items SET kind=?, urgency=?, last_seen=?, source=?, title=?, body=?, actions=?, payload=?, origin_user=?, loud=?, custom=?
    ${reopen ? ", state='new', first_seen=?, shown_at=NULL, snooze_until=NULL, closed_at=NULL, working=NULL, expires_at=?, loud_sent_at=NULL, folded_at=NULL, msg_state=CASE WHEN msg_state='gone' THEN 'none' ELSE msg_state END, tg_message_id=CASE WHEN msg_state='gone' THEN NULL ELSE tg_message_id END" : ''}
    WHERE user_id=? AND id=? AND hash=?`)
    .bind(i.kind, i.urgency, i.last_seen, i.source, i.title, i.body, JSON.stringify(i.actions), J(i.payload), i.origin_user, i.loud ? 1 : 0, JSON.stringify(i.custom),
      ...(reopen ? [i.first_seen, i.expires_at] : []), i.user_id, i.id, i.hash);

/** Insert / touch / update / reopen. Returns what happened so the caller knows whether to render. */
export async function upsertItem(db: D1Database, userId: number, inc: Incoming, now: number, by = 'job'): Promise<UpsertResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await getItem(db, userId, inc.id);
    const r = upsert(existing, inc, userId, now, by);
    const i = r.item;
    if (r.kind === 'insert') {
      const ins = db.prepare(`INSERT OR IGNORE INTO items (user_id, id, short, origin_user, kind, urgency, state, first_seen, last_seen, expires_at, source,
        title, body, actions, payload, hash, loud, custom, held) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(userId, i.id, i.short, i.origin_user, i.kind, i.urgency, 'new', now, now, i.expires_at, i.source, i.title, i.body, JSON.stringify(i.actions), J(i.payload), i.hash, i.loud ? 1 : 0, JSON.stringify(i.custom), inc.held ? 1 : 0);
      const res = await db.batch([ins, logStmt(db, r.log!)]);
      if (res[0].meta.changes) return r;
      continue;  // lost a race with a concurrent insert of the same id: redo as touch/update
    }
    if (r.kind === 'touch') {
      // the card's contract fields are not in the hash: a changed `meta` is written here and the message re-rendered (edit), nothing reopens
      const metaNow = JSON.stringify(((existing?.payload ?? {}) as { meta?: unknown }).meta ?? null), metaNew = JSON.stringify(((inc.payload ?? {}) as { meta?: unknown }).meta ?? null);
      if (existing && (existing.state === 'new' || existing.state === 'shown') && metaNew !== 'null' && metaNow !== metaNew) {
        const merged = { ...((existing.payload ?? {}) as object), meta: (inc.payload as { meta: unknown }).meta };
        await db.prepare('UPDATE items SET last_seen = ?, payload = ?, rendered_hash = NULL WHERE user_id = ? AND id = ?').bind(now, JSON.stringify(merged), userId, i.id).run();
        return { ...r, kind: 'update' };
      }
      await db.prepare('UPDATE items SET last_seen = ? WHERE user_id = ? AND id = ?').bind(now, userId, i.id).run(); return r;
    }
    // update / reopen: CAS on the old hash, so two writers do not both log
    const cas = db.prepare('UPDATE items SET hash = ? WHERE user_id = ? AND id = ? AND hash = ?').bind(i.hash, userId, i.id, existing!.hash);
    const res = await db.batch([cas, logStmt(db, r.log!), writeAll(db, i, r.kind === 'reopen')]);
    if (res[0].meta.changes) return r;
  }
  return upsert(await getItem(db, userId, inc.id), inc, userId, now, by);  // second racer: same content already written
}

/** A state action from a button or a job. Null when nothing changed (double press, closed, not allowed). */
export async function applyAction(db: D1Database, item: Item, action: string, now: number, by: string, tz?: string): Promise<Item | null> {
  const t = transition(item, action, now, by, tz);
  if (!t) return null;
  const res = await db.batch([
    db.prepare('UPDATE items SET state = ?, snooze_until = ?, closed_at = ?, working = NULL WHERE user_id = ? AND id = ? AND state = ?')
      .bind(t.item.state, t.item.snooze_until, t.item.closed_at, item.user_id, item.id, item.state),
    logStmt(db, t.log),
  ]);
  return res[0].meta.changes ? t.item : null;
}

/** Hourly: expire undecided, wake snoozed. Returns the users whose messages now need a render. */
export async function sweep(db: D1Database, now: number, todayCap = 5): Promise<number[]> {
  const { results } = await db.prepare(
    `SELECT * FROM items WHERE (state IN ('new','shown') AND expires_at IS NOT NULL AND expires_at <= ?1)
        OR (state = 'snoozed' AND snooze_until IS NOT NULL AND snooze_until <= ?1) LIMIT 500`).bind(now).all<Row>();
  const users = new Set<number>();
  const onToday = new Map<number, number>();   // visible decision cards on today/now per user: a card that wakes into a full day goes to `week`, so the cap holds between the runner's reaps too
  const todayCount = async (uid: number) => onToday.get(uid) ?? (await db.prepare("SELECT count(*) n FROM items WHERE user_id = ? AND kind = 'decision' AND state IN ('new','shown') AND urgency IN ('today','now')").bind(uid).first<{ n: number }>())?.n ?? 0;
  for (const row of results) {
    const item = rowToItem(row), s = sweepItem(item, now);
    if (!s) continue;
    if (item.state === 'snoozed' && s.item.state === 'new' && item.kind === 'decision' && item.urgency === 'today') {
      const n = await todayCount(item.user_id);
      if (n >= todayCap) s.item = { ...s.item, urgency: 'week' }; else onToday.set(item.user_id, n + 1);
    }
    const res = await db.batch([
      db.prepare('UPDATE items SET state = ?, snooze_until = ?, closed_at = ?, shown_at = ?, rendered_hash = ?, expires_at = ?, urgency = ?, working = NULL WHERE user_id = ? AND id = ? AND state = ?')
        .bind(s.item.state, s.item.snooze_until, s.item.closed_at, s.item.shown_at, s.item.rendered_hash, s.item.expires_at, s.item.urgency, item.user_id, item.id, item.state),
      logStmt(db, s.log),
    ]);
    if (res[0].meta.changes) users.add(item.user_id);
  }
  return [...users];
}

/** Items the renderer may need to touch: open ones, and closed ones whose message still exists. */
export async function renderable(db: D1Database, userId: number): Promise<Item[]> {
  const { results } = await db.prepare(
    `SELECT * FROM items WHERE user_id = ?
       AND (state IN ('new','shown','snoozed') OR msg_state IN ('live','collapsed','sending')) AND (msg_state != 'gone' OR state IN ('new','shown')) AND held = 0 LIMIT 300`).bind(userId).all<Row>();
  return results.map(rowToItem);
}

// --- message bookkeeping, driven by the result of each Telegram op ---
export async function claimSend(db: D1Database, i: Item): Promise<boolean> {
  const r = await db.prepare("UPDATE items SET msg_state = 'sending' WHERE user_id = ? AND id = ? AND msg_state = ? AND state IN ('new','shown')")
    .bind(i.user_id, i.id, i.msg_state).run();
  return r.meta.changes > 0;
}
export async function releaseClaim(db: D1Database, i: Item): Promise<void> {
  await db.prepare("UPDATE items SET msg_state = ? WHERE user_id = ? AND id = ? AND msg_state = 'sending'")
    .bind(i.msg_state === 'live' ? 'live' : i.tg_message_id ? 'collapsed' : 'none', i.user_id, i.id).run();
}
export async function markSent(db: D1Database, i: Item, messageId: number, hash: string, now: number, rang: boolean, bumped = false): Promise<void> {
  await db.batch([
    db.prepare("UPDATE items SET state = 'shown' WHERE user_id = ? AND id = ? AND state = 'new'").bind(i.user_id, i.id),
    logStmt(db, { user_id: i.user_id, item_id: i.id, at: now, from_state: 'new' as State, to_state: 'shown', by: 'bot', note: `message ${messageId}` }),
    db.prepare(`UPDATE items SET msg_state = 'live', tg_message_id = ?, shown_at = ?, rendered_hash = ?${rang ? ', loud_sent_at = ?' : ''}${bumped ? ', bumped_at = ?' : ''}
      WHERE user_id = ? AND id = ?`).bind(messageId, now, hash, ...(rang ? [now] : []), ...(bumped ? [now] : []), i.user_id, i.id),
  ]);
}

/** When a decision or inbox message last rang: the next loud one within the quiet window is sent silent (one ring per batch). */
export async function lastRang(db: D1Database, userId: number): Promise<number> {
  const r = await db.prepare("SELECT MAX(loud_sent_at) AS t FROM items WHERE user_id = ? AND kind IN ('decision','inbox')").bind(userId).first<{ t: number | null }>();
  return r?.t ?? 0;
}
export async function markEdited(db: D1Database, i: Item, hash: string): Promise<void> {
  await db.prepare('UPDATE items SET rendered_hash = ? WHERE user_id = ? AND id = ?').bind(hash, i.user_id, i.id).run();
}
export async function markCollapsed(db: D1Database, i: Item): Promise<void> {
  await db.prepare("UPDATE items SET msg_state = 'collapsed' WHERE user_id = ? AND id = ?").bind(i.user_id, i.id).run();
}
export async function markGone(db: D1Database, i: Item): Promise<void> {
  await db.prepare("UPDATE items SET msg_state = 'gone' WHERE user_id = ? AND id = ?").bind(i.user_id, i.id).run();
}

export async function getByMessage(db: D1Database, userId: number, messageId: number): Promise<Item | null> {
  const r = await db.prepare("SELECT * FROM items WHERE user_id = ? AND tg_message_id = ? AND msg_state IN ('live','collapsed')").bind(userId, messageId).first<Row>();
  return r ? rowToItem(r) : null;
}

/** A reply or custom button on an item: log it; a decision (open or snoozed) moves to "working". Returns true when the state moved. */
export async function applyWork(db: D1Database, item: Item, text: string, now: number, by: string, note: string, dedupe = false): Promise<boolean> {
  const w = item.kind === 'decision' ? work(item, text, now, by, note, dedupe) : null;
  if (!w) {
    // other kinds, closed items and repeated presses: a reply is still history, a repeated press is not
    if (!dedupe) await db.prepare('INSERT INTO item_log (user_id, item_id, at, from_state, to_state, by, note) VALUES (?,?,?,?,?,?,?)')
      .bind(item.user_id, item.id, now, item.state, item.state, by, `${note}: ${text.slice(0, 80)}`).run();
    return false;
  }
  const res = await db.batch([
    db.prepare("UPDATE items SET state = 'snoozed', snooze_until = ?, working = ?, closed_at = NULL WHERE user_id = ? AND id = ? AND state = ? AND IFNULL(working, '') != ?")
      .bind(w.item.snooze_until, text, item.user_id, item.id, item.state, dedupe ? text : '\u0000'),
    logStmt(db, w.log),
  ]);
  return res[0].meta.changes > 0;
}

export async function applyUnwork(db: D1Database, item: Item, now: number, by: string): Promise<boolean> {
  const u = unwork(item, now, by);
  if (!u) return false;
  const res = await db.batch([
    db.prepare("UPDATE items SET state = 'new', snooze_until = NULL, working = NULL, shown_at = NULL, rendered_hash = NULL WHERE user_id = ? AND id = ? AND state = 'snoozed' AND working IS NOT NULL").bind(item.user_id, item.id),
    logStmt(db, u.log),
  ]);
  return res[0].meta.changes > 0;
}

/** The expanded section of a card (the "More" button): kept in the payload, outside the content hash, so it never reopens or re-sends the card. */
export async function setDetail(db: D1Database, item: Item, text: string, now: number, by: string): Promise<boolean> {
  const payload = { ...((item.payload ?? {}) as Record<string, unknown>), detail: text.slice(0, 1500) };
  const res = await db.batch([
    db.prepare('UPDATE items SET payload = ? WHERE user_id = ? AND id = ?').bind(JSON.stringify(payload), item.user_id, item.id),
    logStmt(db, { user_id: item.user_id, item_id: item.id, at: now, from_state: item.state, to_state: item.state, by, note: `detail: ${text.slice(0, 80)}` }),
  ]);
  return res[0].meta.changes > 0;
}
export async function itemLog(db: D1Database, userId: number, id: string): Promise<Record<string, unknown>[]> {
  return (await db.prepare('SELECT at, from_state, to_state, by, note FROM item_log WHERE user_id = ? AND item_id = ? ORDER BY n').bind(userId, id).all<Record<string, unknown>>()).results;
}

/** Cards waiting behind the "More (K)" button. */
export async function heldCount(db: D1Database, userId: number): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM items WHERE user_id = ? AND held = 1 AND state IN ('new','shown')").bind(userId).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Show up to `n` held cards, most urgent first. Returns how many were released. */
export async function revealHeld(db: D1Database, userId: number, n: number): Promise<number> {
  const r = await db.prepare(`UPDATE items SET held = 0 WHERE user_id = ? AND id IN (SELECT id FROM items WHERE user_id = ? AND held = 1 AND state IN ('new','shown')
    ORDER BY CASE urgency WHEN 'now' THEN 0 WHEN 'today' THEN 1 ELSE 2 END, first_seen LIMIT ?)`).bind(userId, userId, n).run();
  return r.meta.changes;
}

// --- card hygiene: fold what nobody touched, bring it back on request ---
export const FOLD_AFTER_MS = 3 * 86400e3;

/** Open decision cards older than 3 days with no press, comment or reveal by a person in those 3 days leave the chat (the renderer deletes the message). Returns how many. */
export async function foldStale(db: D1Database, userId: number, now: number): Promise<number> {
  const cut = now - FOLD_AFTER_MS;
  const r = await db.prepare(`UPDATE items SET folded_at = ?1 WHERE user_id = ?2 AND kind = 'decision' AND state IN ('new','shown') AND held = 0 AND folded_at IS NULL AND working IS NULL
      AND first_seen <= ?3 AND NOT EXISTS (SELECT 1 FROM item_log l WHERE l.user_id = items.user_id AND l.item_id = items.id AND l.by LIKE 'user:%' AND l.at > ?3)`).bind(now, userId, cut).run();
  return r.meta.changes;
}

/** The standup's button: the oldest `n` folded cards come back as fresh, silent messages. The reveal is logged as the person's touch, so they are not folded again for 3 days. */
export async function unfoldStale(db: D1Database, userId: number, n: number, now: number): Promise<number> {
  const { results } = await db.prepare("SELECT id, state FROM items WHERE user_id = ? AND folded_at IS NOT NULL AND state IN ('new','shown') ORDER BY first_seen LIMIT ?").bind(userId, n).all<{ id: string; state: string }>();
  for (const r of results) {
    await db.batch([
      db.prepare("UPDATE items SET folded_at = NULL, loud = 0, msg_state = 'none', tg_message_id = NULL, rendered_hash = NULL WHERE user_id = ? AND id = ? AND folded_at IS NOT NULL").bind(userId, r.id),
      logStmt(db, { user_id: userId, item_id: r.id, at: now, from_state: r.state as never, to_state: r.state as never, by: `user:${userId}`, note: 'unfold from the standup' }),
    ]);
  }
  return results.length;
}

/** A job-owned item that no longer applies (the check is green, the meeting is over): state expired, the renderer removes its message. Null-op when it is not open. */
export async function applyExpire(db: D1Database, item: Item, now: number, by: string, note = 'no longer applies'): Promise<boolean> {
  if (item.state !== 'new' && item.state !== 'shown') return false;
  const res = await db.batch([
    db.prepare("UPDATE items SET state = 'expired', closed_at = ? WHERE user_id = ? AND id = ? AND state IN ('new','shown')").bind(now, item.user_id, item.id),
    logStmt(db, { user_id: item.user_id, item_id: item.id, at: now, from_state: item.state, to_state: 'expired', by, note }),
  ]);
  return res[0].meta.changes > 0;
}

/** The today-cap's demotion: an open decision moves to another urgency (the dot in its title follows, because its message is edited on the next render). Null-op when it is not an open decision or already there. */
export async function setUrgency(db: D1Database, item: Item, urgency: string, now: number, by: string): Promise<boolean> {
  if (item.kind !== 'decision' || (item.state !== 'new' && item.state !== 'shown') || item.urgency === urgency) return false;
  const res = await db.batch([
    db.prepare('UPDATE items SET urgency = ?, rendered_hash = NULL WHERE user_id = ? AND id = ? AND state IN (\'new\',\'shown\') AND urgency != ?').bind(urgency, item.user_id, item.id, urgency),
    logStmt(db, { user_id: item.user_id, item_id: item.id, at: now, from_state: item.state, to_state: item.state, by, note: `urgency ${item.urgency} -> ${urgency} (today cap)` }),
  ]);
  return res[0].meta.changes > 0;
}


// --- the button grammar: direct transitions, payload flags for the collapsed line ---
export async function applySettle(db: D1Database, item: Item, t: { item: Item; log: LogRow }, ui: Record<string, unknown> = {}): Promise<Item | null> {
  const payload = { ...((item.payload ?? {}) as Record<string, unknown>), ...ui };
  const res = await db.batch([
    db.prepare('UPDATE items SET state = ?, snooze_until = ?, closed_at = ?, working = NULL, payload = ?, rendered_hash = NULL WHERE user_id = ? AND id = ? AND state = ?')
      .bind(t.item.state, t.item.snooze_until, t.item.closed_at, JSON.stringify(payload), item.user_id, item.id, item.state),
    logStmt(db, t.log),
  ]);
  return res[0].meta.changes ? { ...t.item, payload } : null;
}
export async function lastLog(db: D1Database, item: Item): Promise<LogRow | null> {
  return db.prepare('SELECT user_id, item_id, at, from_state, to_state, by, note FROM item_log WHERE user_id = ? AND item_id = ? ORDER BY rowid DESC LIMIT 1').bind(item.user_id, item.id).first<LogRow>();
}
/** Flags the collapsed line reads (undo until, effort window, the effort answer); the message is edited on the next reconcile. */
export async function setUi(db: D1Database, item: Item, ui: Record<string, unknown>): Promise<void> {
  const payload = { ...((item.payload ?? {}) as Record<string, unknown>), ...ui };
  await db.prepare('UPDATE items SET payload = ?, rendered_hash = NULL WHERE user_id = ? AND id = ?').bind(JSON.stringify(payload), item.user_id, item.id).run();
}
/** Recent drops, answers and effort answers of this user: a job turns them into check-ins and a mute list. */
export async function recentTaps(db: D1Database, userId: number, since: number): Promise<{ id: string; kind: string; at: number; note: string; title: string; source: string | null; urgency: string; payload: string | null }[]> {
  return (await db.prepare(`SELECT l.item_id AS id, i.kind AS kind, l.at AS at, l.note AS note, i.title AS title, i.source AS source, i.urgency AS urgency, i.payload AS payload FROM item_log l JOIN items i ON i.user_id = l.user_id AND i.id = l.item_id
    WHERE l.user_id = ? AND l.at >= ? AND (l.note LIKE 'drop:%' OR l.note LIKE 'answer:%' OR l.note LIKE 'effort:%' OR l.note LIKE 'snooze:%') ORDER BY l.at LIMIT 500`).bind(userId, since).all()).results as never;
}
