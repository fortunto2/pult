// Bring Telegram in line with the item store for one user: read, render, apply.
import { BATCH_QUIET_MS, render } from './render.ts';
import { lastRang, renderable } from './store.ts';
import { applyOps, type ApplyResult, type Tg } from './tg.ts';

export async function reconcile(db: D1Database, tg: Tg, userId: number, now: number, tz: string, sleep?: (ms: number) => Promise<void>, gapMs?: number): Promise<ApplyResult> {
  const ops = render(await renderable(db, userId), now, { tz, quietUntil: (await lastRang(db, userId)) + BATCH_QUIET_MS });
  return applyOps(tg, db, ops, now, sleep, gapMs);
}
