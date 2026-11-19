// Small keyed state in D1 `settings`: live switches, the usage-limit pause, living-message ids. One table, no KV namespace to create.
const DAY = 86400e3;

export async function getSetting(db: D1Database, key: string, maxAgeMs = 0, now = Date.now()): Promise<string | null> {
  const r = await db.prepare('SELECT value, at FROM settings WHERE key = ?').bind(key).first<{ value: string; at: number }>();
  if (!r || (maxAgeMs && now - r.at > maxAgeMs)) return null;
  return r.value;
}
export const putSetting = (db: D1Database, key: string, value: string, now = Date.now()) =>
  db.prepare('INSERT INTO settings (key, value, at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at').bind(key, value, now).run();
export const delSetting = (db: D1Database, key: string) => db.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();

/** The usage-limit pause: epoch seconds, written by the runner when claude says its limit is hit. 0 when not paused. */
export async function pausedUntil(db: D1Database, now: number): Promise<number> {
  const v = Number(await getSetting(db, 'pause:until')) || 0;
  return v * 1000 > now ? v : 0;
}
export const setPause = (db: D1Database, until: number) => putSetting(db, 'pause:until', String(until));

/** A living message: the id a key points at (edited in place by the next say with the same key). Forgotten after three days. */
export const keyedMessage = async (db: D1Database, key: string, now = Date.now()) => Number(await getSetting(db, `key:${key}`, 3 * DAY, now)) || 0;
export const setKeyedMessage = (db: D1Database, key: string, id: number) => putSetting(db, `key:${key}`, String(id));
export const clearKeyedMessage = (db: D1Database, key: string) => delSetting(db, `key:${key}`);
