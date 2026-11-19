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

// --- live switches: the deploy-time default is a variable, the live value is a D1 row of the same name, so a deploy from any checkout cannot flip one ---

/** The env with the stored values of `keys` laid over the deploy-time defaults. A missing table or row leaves the default. */
export async function withSettings<E extends { DB: D1Database }>(env: E, keys: readonly string[]): Promise<E> {
  if (!keys.length) return env;
  try {
    const { results } = await env.DB.prepare(`SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`).bind(...keys).all<{ key: string; value: string }>();
    return results.length ? { ...env, ...Object.fromEntries(results.map(r => [r.key, r.value])) } : env;
  } catch { return env; }
}
/** Sets a '0'/'1' switch; false when the key is not one of `allowed` or the value is not 0 or 1. */
export async function setFlag(db: D1Database, key: string, value: string, now: number, allowed: readonly string[]): Promise<boolean> {
  if (!allowed.includes(key) || !['0', '1'].includes(value)) return false;
  await putSetting(db, key, value, now);
  return true;
}
/** On while the row says 1 and, when `ttlMs` is given, it was set less than that long ago: a switch that lapses by itself so a forgotten test cannot stay on. */
export async function flagOn(db: D1Database, key: string, now: number, ttlMs = 0): Promise<boolean> {
  try {
    const r = await db.prepare('SELECT value, at FROM settings WHERE key = ?').bind(key).first<{ value: string; at: number }>();
    return !!r && r.value === '1' && (!ttlMs || now - r.at < ttlMs);
  } catch { return false; }
}
