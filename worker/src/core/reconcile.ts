// Bring Telegram in line with the item store for one user: read, render, apply.
import { cards } from './cardconfig.ts';
import { firstFreeDay, protectedToday } from './protected.ts';
import { BATCH_QUIET_MS, render } from './render.ts';
import { heldCount, lastRang, renderable } from './store.ts';
import { applyOps, type ApplyResult, type Tg } from './tg.ts';

export async function reconcile(db: D1Database, tg: Tg, userId: number, now: number, tz: string, sleep?: (ms: number) => Promise<void>, gapMs?: number): Promise<ApplyResult> {
  let ops = render(await renderable(db, userId), now, { tz, quietUntil: (await lastRang(db, userId)) + BATCH_QUIET_MS, held: await heldCount(db, userId), calm: !!(await protectedToday(db, now, tz)), free: await firstFreeDay(db, now, tz) });
  if (cards.filterOps) ops = await cards.filterOps(db, userId, ops, now, tz);
  return applyOps(tg, db, ops, now, sleep, gapMs);
}
