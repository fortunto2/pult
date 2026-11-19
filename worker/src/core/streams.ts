// One living message per stream: a job-owned note's id carries its date (`sweep-2026-01-05`, `incident:disk:2026-01-05`),
// and a new note of the same stream closes every earlier open one. A decision card is never touched here.
import { applyExpire, getItem } from './store.ts';

const DATED = /^(.+?)[-:]\d{4}-\d{2}-\d{2}(?:-\d+)?$/;

/** The stream an id belongs to, or null for ids that are not date-keyed notes (a card, a one-off note). */
export function streamOf(id: string): string | null {
  return DATED.exec(id)?.[1] ?? null;
}

/** Expire every OLDER open note or incident of `id`'s stream. Returns the ids closed (the caller reconciles: an expired item's message is removed). */
export async function supersede(db: D1Database, userId: number, id: string, now: number): Promise<string[]> {
  const stream = streamOf(id);
  if (!stream) return [];
  const { results } = await db.prepare("SELECT id FROM items WHERE user_id = ? AND id != ? AND state IN ('new','shown') AND kind IN ('inbox','digest','incident') AND id LIKE ? ESCAPE '\\'")
    .bind(userId, id, `${stream.replace(/[%_\\]/g, '\\$&')}%`).all<{ id: string }>();
  const closed: string[] = [];
  for (const r of results) {
    if (streamOf(r.id) !== stream || r.id >= id) continue;   // only older ones: a late re-run of an old day must not close today's
    const item = await getItem(db, userId, r.id);
    if (item && await applyExpire(db, item, now, `stream:${id}`)) closed.push(r.id);
  }
  return closed;
}
