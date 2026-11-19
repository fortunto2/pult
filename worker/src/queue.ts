// The event queue (D1 `events`): enqueue, lease by priority and slot, heartbeat, ack, stop. One runner pulls over HTTPS.
// Priorities: 0 your text, 1 your buttons, 2 scheduled jobs. The interactive slot takes 0 and 1; the background slot takes only 2, and only while no P0 waits.
export interface QEvent {
  id: number; user_id: number; role: 'owner'; item_id: string; action: string; priority: number; session_id: string | null;
  text: string | null; files: { file_id: string; kind: string; size?: number; name?: string; mime?: string }[]; reply_to: number | null; stop_requested: number;
  lease_id?: string | null; status: string; attempts: number; created_at: number;
}
export const LEASE_MS = 90_000, EXPIRE_MS = 24 * 3600e3, MAX_ATTEMPTS = 3;
export type Slot = 'interactive' | 'background' | 'live';

// A live session (Claude Code in a terminal with the Telegram channel, bin/tg-channel) is ATTACHED while its settings row LIVE_SEEN:<session> is younger than LIVE_FRESH_MS.
// Its plain text goes to the 'live' slot; the 'interactive' slot (pult-run) leaves exactly that text alone while attached, and takes it again a minute after the channel dies.
export const LIVE_FRESH_MS = 60e3, LIVE_WRITE_MS = 20e3;
export const LIVE_KEY = 'LIVE_SEEN:';
const PLAIN_OWNER = "priority = 0 AND item_id = '' AND action = 'ask'";   // card buttons and replies to cards carry an item_id: they stay with session-run's restricted draft workflow

/** The live channel's pull is its proof of life: written at most every 20 s (D1 bills rows written). */
export async function recordLiveSeen(db: D1Database, sessionId: string, now: number): Promise<void> {
  await db.prepare("INSERT INTO settings (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at WHERE CAST(settings.value AS INTEGER) < ?").bind(LIVE_KEY + sessionId, String(now), now, now - LIVE_WRITE_MS).run();
}
export const clearLiveSeen = (db: D1Database, sessionId: string) => db.prepare('DELETE FROM settings WHERE key = ?').bind(LIVE_KEY + sessionId).run();

const row = (r: Record<string, unknown>): QEvent => ({ ...(r as unknown as QEvent), role: 'owner', files: r.files ? JSON.parse(String(r.files)) : [] });

export async function enqueue(db: D1Database, e: { user_id: number; session_id: string | null; text: string; files?: QEvent['files']; priority: number; reply_to?: number | null; item_id?: string; action?: string }, now: number): Promise<number> {
  const r = await db.prepare('INSERT INTO events (user_id, item_id, action, created_at, priority, session_id, text, files, reply_to) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(e.user_id, e.item_id ?? '', e.action ?? 'ask', now, e.priority, e.session_id, e.text, e.files?.length ? JSON.stringify(e.files) : null, e.reply_to ?? null).run();
  return Number((r.meta as { last_row_id?: number }).last_row_id);
}

/** Housekeeping on every pull: a dead lease goes back to the queue (3 tries, then failed), a day-old queued event expires. */
export async function recover(db: D1Database, now: number) {
  await db.prepare("UPDATE events SET status = 'failed', acked_at = ? WHERE status = 'running' AND leased_until < ? AND attempts >= ?").bind(now, now, MAX_ATTEMPTS).run();
  await db.prepare("UPDATE events SET status = 'queued', leased_until = NULL, lease_id = NULL WHERE status = 'running' AND leased_until < ?").bind(now).run();
  await db.prepare("UPDATE events SET status = 'expired', acked_at = ? WHERE status = 'queued' AND created_at < ?").bind(now, now - EXPIRE_MS).run();
}

export async function pull(db: D1Database, slot: Slot, now: number, liveSession?: string): Promise<QEvent | null> {
  await recover(db, now);
  if (slot === 'live' && !liveSession) return null;
  const attached = slot === 'interactive' ? ` AND NOT (${PLAIN_OWNER} AND session_id IN (SELECT substr(key, ${LIVE_KEY.length + 1}) FROM settings WHERE key LIKE '${LIVE_KEY}%' AND CAST(value AS INTEGER) >= ${Math.floor(now - LIVE_FRESH_MS)}))` : '';
  const prio = slot === 'live' ? `${PLAIN_OWNER} AND session_id = '${liveSession!.replace(/[^\w-]/g, '')}'` : slot === 'interactive' ? `priority IN (0,1)${attached}`
    : "priority = 2 AND NOT EXISTS (SELECT 1 FROM events p WHERE p.status = 'queued' AND p.priority = 0)";
  for (let i = 0; i < 3; i++) {
    const c = await db.prepare(`SELECT * FROM events e WHERE status = 'queued' AND ${prio}
      AND (session_id IS NULL OR NOT EXISTS (SELECT 1 FROM events r WHERE r.session_id = e.session_id AND r.status = 'running'))
      ORDER BY priority, created_at, id LIMIT 1`).first<Record<string, unknown>>();
    if (!c) return null;
    const lease = crypto.randomUUID();
    const won = await db.prepare("UPDATE events SET status = 'running', leased_until = ?, attempts = attempts + 1, lease_id = ? WHERE id = ? AND status = 'queued'").bind(now + LEASE_MS, lease, c.id).run();
    if (won.meta.changes) return row({ ...c, status: 'running', attempts: Number(c.attempts) + 1, lease_id: lease });
  }
  return null;
}

/** Extends the lease; the answer carries whether /stop was asked. */
export async function beat(db: D1Database, id: number, lease: string | undefined, now: number): Promise<{ ok: boolean; stop: boolean }> {
  if (!lease) return { ok: false, stop: true };   // no token, no lease
  const r = await db.prepare("UPDATE events SET leased_until = ? WHERE id = ? AND status = 'running' AND lease_id = ?").bind(now + LEASE_MS, id, lease).run();
  if (!r.meta.changes) return { ok: false, stop: true };   // not ours any more: the runner should stop
  const e = await db.prepare('SELECT stop_requested FROM events WHERE id = ?').bind(id).first<{ stop_requested: number }>();
  return { ok: true, stop: !!e?.stop_requested };
}
export async function finish(db: D1Database, id: number, lease: string | undefined, status: 'done' | 'failed' | 'stopped' | 'requeue', now: number): Promise<boolean> {
  if (!lease) return false;
  // requeue: the usage limit hit mid-turn; the event goes back to the queue and the try does not count
  if (status === 'requeue') return (await db.prepare("UPDATE events SET status = 'queued', leased_until = NULL, attempts = MAX(attempts - 1, 0), lease_id = NULL WHERE id = ? AND status = 'running' AND lease_id = ?").bind(id, lease).run()).meta.changes > 0;
  return (await db.prepare("UPDATE events SET status = ?, acked_at = ?, leased_until = NULL WHERE id = ? AND status = 'running' AND lease_id = ?").bind(status, now, id, lease).run()).meta.changes > 0;
}
export const getEvent = async (db: D1Database, id: number) => { const r = await db.prepare('SELECT * FROM events WHERE id = ?').bind(id).first<Record<string, unknown>>(); return r ? row(r) : null; };

/** /stop: a running turn of this session gets the flag (the heartbeat carries it); queued ones are dropped. Returns what was hit. */
export async function requestStop(db: D1Database, userId: number, sessionId: string, now: number): Promise<{ running: number; dropped: number }> {
  const running = (await db.prepare("UPDATE events SET stop_requested = 1 WHERE user_id = ? AND session_id = ? AND status = 'running'").bind(userId, sessionId).run()).meta.changes;
  const dropped = (await db.prepare("UPDATE events SET status = 'stopped', acked_at = ? WHERE user_id = ? AND session_id = ? AND status = 'queued'").bind(now, userId, sessionId).run()).meta.changes;
  return { running, dropped };
}
export async function depth(db: D1Database): Promise<{ queued: Record<string, number>; running: number }> {
  const { results } = await db.prepare("SELECT priority, status, COUNT(*) AS n FROM events WHERE status IN ('queued','running') GROUP BY priority, status").all<{ priority: number; status: string; n: number }>();
  const queued: Record<string, number> = {}; let running = 0;
  for (const r of results) { if (r.status === 'queued') queued[`P${r.priority}`] = r.n; else running += r.n; }
  return { queued, running };
}
