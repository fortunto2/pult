import { LIVE_FRESH_MS, LIVE_KEY } from './queue.ts';
// Sessions: a conversation is a row pointing at a Claude session id. Addressing without topics: reply > the target you chose today > the day's main.
export interface Session {
  id: string; user_id: number; title: string; claude_session_id: string | null; cwd: string | null; workflow: string;
  status: 'idle' | 'running' | 'archived'; created_at: number; last_active: number; day_key: string | null;
}
export interface Resolved { session: Session; how: 'reply' | 'target' | 'main'; created: boolean }

export const dayKey = (tz: string, now: number) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(now));
const newId = () => [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');

export const getSession = (db: D1Database, id: string) => db.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first<Session>();
const forUser = async (db: D1Database, userId: number, id: string | null | undefined) => {
  if (!id) return null;
  const s = await db.prepare("SELECT * FROM sessions WHERE id = ? AND user_id = ? AND status != 'archived'").bind(id, userId).first<Session>();
  return s ?? null;   // another user's session never resolves
};

/** Which session an incoming message belongs to: reply > the target chosen today > the day's main (created on first use). */
export async function resolveSession(db: D1Database, userId: number, q: { replyTo?: number }, now: number, tz: string): Promise<Resolved> {
  if (q.replyTo) {
    const r = await db.prepare('SELECT session_id FROM session_msgs WHERE user_id = ? AND tg_message_id = ?').bind(userId, q.replyTo).first<{ session_id: string }>();
    const s = await forUser(db, userId, r?.session_id);
    if (s) return { session: s, how: 'reply', created: false };
  }
  const day = dayKey(tz, now);
  const target = await currentTarget(db, userId, now, tz);
  if (target) return { session: target, how: 'target', created: false };
  const had = await db.prepare('SELECT id FROM sessions WHERE user_id = ? AND day_key = ?').bind(userId, day).first();
  await db.prepare("INSERT OR IGNORE INTO sessions (id, user_id, title, created_at, last_active, day_key) VALUES (?,?,?,?,?,?)")
    .bind(newId(), userId, `main ${day}`, now, now, day).run();
  const main = (await db.prepare('SELECT * FROM sessions WHERE user_id = ? AND day_key = ?').bind(userId, day).first<Session>())!;
  return { session: main, how: 'main', created: !had };
}

/** /new [title]: a fresh session that takes plain messages until midnight. */
export async function newSession(db: D1Database, userId: number, title: string, now: number, tz: string): Promise<Session> {
  const id = newId();
  await db.prepare('INSERT INTO sessions (id, user_id, title, created_at, last_active) VALUES (?,?,?,?,?)').bind(id, userId, (title.trim() || `session ${dayKey(tz, now)}`).slice(0, 80), now, now).run();
  await setTarget(db, userId, id, now, tz);
  return (await getSession(db, id))!;
}
/** The live terminal session: reuse the newest non-archived 'live' session of this title (a reattach keeps its history), else create one; either way it becomes today's target. */
export async function liveSession(db: D1Database, userId: number, title: string, now: number, tz: string): Promise<Session> {
  const t = (title.trim() || 'live').slice(0, 80);
  let s = await db.prepare("SELECT * FROM sessions WHERE user_id = ? AND workflow = 'live' AND title = ? AND status != 'archived' ORDER BY last_active DESC LIMIT 1").bind(userId, t).first<Session>();
  if (!s) {
    const id = newId();
    await db.prepare("INSERT INTO sessions (id, user_id, title, workflow, created_at, last_active) VALUES (?,?,?,'live',?,?)").bind(id, userId, t, now, now).run();
    s = (await getSession(db, id))!;
  }
  await setTarget(db, userId, s.id, now, tz);
  return s;
}
/** Detach: today's target stops pointing at this session (plain messages fall back to the day's main). */
export const clearTarget = (db: D1Database, userId: number, id: string) => db.prepare('DELETE FROM session_target WHERE user_id = ? AND session_id = ?').bind(userId, id).run();
export async function setTarget(db: D1Database, userId: number, id: string, now: number, tz: string): Promise<boolean> {
  if (!(await forUser(db, userId, id))) return false;
  await db.prepare('INSERT INTO session_target (user_id, session_id, day_key) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET session_id = excluded.session_id, day_key = excluded.day_key').bind(userId, id, dayKey(tz, now)).run();
  return true;
}
export const targetOf = currentTarget;
/** Today's target. A target chosen on an earlier day still holds while it is an ATTACHED live terminal session (its LIVE_SEEN row is fresh): the day changing under a running terminal must not move its messages to a new day's main. */
async function currentTarget(db: D1Database, userId: number, now: number, tz: string): Promise<Session | null> {
  const t = await db.prepare('SELECT session_id, day_key FROM session_target WHERE user_id = ?').bind(userId).first<{ session_id: string; day_key: string }>();
  if (!t) return null;
  const s = await forUser(db, userId, t.session_id);
  if (!s) return null;
  if (t.day_key === dayKey(tz, now)) return s;
  if (s.workflow !== 'live') return null;
  const seen = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(LIVE_KEY + s.id).first<{ value: string }>();
  return seen && Number(seen.value) >= now - LIVE_FRESH_MS ? s : null;
}
export async function listSessions(db: D1Database, userId: number, limit = 8): Promise<Session[]> {
  return (await db.prepare("SELECT * FROM sessions WHERE user_id = ? AND status != 'archived' ORDER BY last_active DESC LIMIT ?").bind(userId, limit).all<Session>()).results;
}
export const recordMsg = (db: D1Database, userId: number, messageId: number, sessionId: string) =>
  db.prepare('INSERT OR REPLACE INTO session_msgs (user_id, tg_message_id, session_id) VALUES (?,?,?)').bind(userId, messageId, sessionId).run();
export const touch = (db: D1Database, id: string, now: number) => db.prepare('UPDATE sessions SET last_active = ? WHERE id = ?').bind(now, id).run();
export const setClaudeId = (db: D1Database, id: string, claudeId: string, cwd?: string | null) =>
  db.prepare('UPDATE sessions SET claude_session_id = ?, cwd = COALESCE(?, cwd) WHERE id = ?').bind(claudeId, cwd ?? null, id).run();
