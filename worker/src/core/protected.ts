// Protected days: a day the owner's calendars mark as family or rest time is short by itself, with no tap:
// a job reads the all-day events and pushes {date: title}; the card cap, a calm render and the "Later" menu's first free day follow.
import { localDate } from './tz.ts';

const KEY = 'PROTECTED';
export type Days = Record<string, string>;

export async function setProtected(db: D1Database, days: unknown, now: number): Promise<Days> {
  const clean: Days = {};
  if (days && typeof days === 'object') for (const [d, t] of Object.entries(days as Record<string, unknown>).slice(0, 30)) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && typeof t === 'string') clean[d] = t.slice(0, 80);
  await db.prepare('INSERT INTO settings (key, value, at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at').bind(KEY, JSON.stringify(clean), now).run();
  return clean;
}

export async function getProtected(db: D1Database): Promise<Days> {
  try {
    const r = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(KEY).first<{ value: string }>();
    return r ? JSON.parse(r.value) as Days : {};
  } catch { return {}; }
}

/** Today's protected title in the owner's zone, or null. */
export async function protectedToday(db: D1Database, now: number, tz: string): Promise<string | null> {
  return (await getProtected(db))[localDate(tz, now)] ?? null;
}

/** The first date from tomorrow on that is not protected (the day "Later" offers first while today is protected), or null when today is not protected. */
export async function firstFreeDay(db: D1Database, now: number, tz: string): Promise<string | null> {
  const days = await getProtected(db), today = localDate(tz, now);
  if (!days[today]) return null;
  for (let n = 1; n <= 30; n++) { const d = new Date(Date.parse(`${today}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10); if (!days[d]) return d; }
  return null;
}
