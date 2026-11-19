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
  db.prepare(`UPDATE items SET kind=?, urgency=?, last_seen=?, source=?, title=?, body=?, actions=?, payload=?, loud=?, custom=?
    ${reopen ? ", state='new', first_seen=?, shown_at=NULL, snooze_until=NULL, closed_at=NULL, working=NULL, expires_at=?, msg_state=CASE WHEN msg_state='gone' THEN 'none' ELSE msg_state END, tg_message_id=CASE WHEN msg_state='gone' THEN NULL ELSE tg_message_id END" : ''}
    WHERE user_id=? AND id=? AND hash=?`)
    .bind(i.kind, i.urgency, i.last_seen, i.source, i.title, i.body, JSON.stringify(i.actions), J(i.payload), i.loud ? 1 : 0, JSON.stringify(i.custom),
      ...(reopen ? [i.first_seen, i.expires_at] : []), i.user_id, i.id, i.hash);

/** Insert / touch / update / reopen. Returns what happened so the caller knows whether to render. */
export async function upsertItem(db: D1Database, userId: number, inc: Incoming, now: number, by = 'job'): Promise<UpsertResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await getItem(db, userId, inc.id);
    const r = upsert(existing, inc, userId, now, by);
    const i = r.item;
    if (r.kind === 'insert') {
      const ins = db.prepare(`INSERT OR IGNORE INTO items (user_id, id, short, kind, urgency, state, first_seen, last_seen, expires_at, source,
        title, body, actions, payload, hash, loud, custom) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(userId, i.id, i.short, i.kind, i.urgency, 'new', now, now, i.expires_at, i.source, i.title, i.body, JSON.stringify(i.actions), J(i.payload), i.hash, i.loud ? 1 : 0, JSON.stringify(i.custom));
      const res = await db.batch([ins, logStmt(db, r.log!)]);
      if (res[0].meta.changes) return r;
      continue;  // lost a race with a concurrent insert of the same id: redo as touch/update
    }
    if (r.kind === 'touch') {
      // the card's contract fields (meta) are not in the hash: a changed `meta` is written here and the message re-rendered, nothing reopens
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
export async function sweep(db: D1Database, now: number): Promise<number[]> {
  const { results } = await db.prepare(
    `SELECT * FROM items WHERE (state IN ('new','shown') AND expires_at IS NOT NULL AND expires_at <= ?1)
        OR (state = 'snoozed' AND snooze_until IS NOT NULL AND snooze_until <= ?1) LIMIT 500`).bind(now).all<Row>();
  const users = new Set<number>();
  for (const row of results) {
    const item = rowToItem(row), s = sweepItem(item, now);
    if (!s) continue;
    const res = await db.batch([
      db.prepare('UPDATE items SET state = ?, snooze_until = ?, closed_at = ?, shown_at = ?, rendered_hash = ?, expires_at = ?, working = NULL WHERE user_id = ? AND id = ? AND state = ?')
        .bind(s.item.state, s.item.snooze_until, s.item.closed_at, s.item.shown_at, s.item.rendered_hash, s.item.expires_at, item.user_id, item.id, item.state),
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
       AND (state IN ('new','shown','snoozed') OR msg_state IN ('live','collapsed','sending')) AND (msg_state != 'gone' OR state IN ('new','shown')) LIMIT 300`).bind(userId).all<Row>();
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
export async function markSent(db: D1Database, i: Item, messageId: number, hash: string, now: number, rang = false): Promise<void> {
  await db.batch([
    db.prepare("UPDATE items SET state = 'shown' WHERE user_id = ? AND id = ? AND state = 'new'").bind(i.user_id, i.id),
    logStmt(db, { user_id: i.user_id, item_id: i.id, at: now, from_state: 'new' as State, to_state: 'shown', by: 'bot', note: `message ${messageId}` }),
    db.prepare(`UPDATE items SET msg_state = 'live', tg_message_id = ?, shown_at = ?, rendered_hash = ?${rang ? ', loud_sent_at = ?' : ''} WHERE user_id = ? AND id = ?`).bind(messageId, now, hash, ...(rang ? [now] : []), i.user_id, i.id),
  ]);
}
/** When an item message last rang: the next loud one within the quiet window is sent silent (one ring per batch). */
export async function lastRang(db: D1Database, userId: number): Promise<number> {
  const r = await db.prepare("SELECT MAX(loud_sent_at) AS t FROM items WHERE user_id = ?").bind(userId).first<{ t: number | null }>();
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

/** A job-owned item that no longer applies (the check is green, the meeting is over): state expired, the renderer removes its message. Null-op when it is not open. */
export async function applyExpire(db: D1Database, item: Item, now: number, by: string, note = 'no longer applies'): Promise<boolean> {
  if (item.state !== 'new' && item.state !== 'shown') return false;
  const res = await db.batch([
    db.prepare("UPDATE items SET state = 'expired', closed_at = ? WHERE user_id = ? AND id = ? AND state IN ('new','shown')").bind(now, item.user_id, item.id),
    logStmt(db, { user_id: item.user_id, item_id: item.id, at: now, from_state: item.state, to_state: 'expired', by, note }),
  ]);
  return res[0].meta.changes > 0;
}
