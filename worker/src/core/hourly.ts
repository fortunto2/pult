// The hourly tick: expire undecided cards, wake snoozed ones, close superseded notes, fold what nobody touched, re-render what changed
// (also retries a render that failed earlier, and deletes collapsed lines after 24 h).
import { cards } from './cardconfig.ts';
import { expireStaleSends } from './drafts.ts';
import type { Env } from './env.ts';
import { protectedToday } from './protected.ts';
import { reconcile } from './reconcile.ts';
import { applyExpire, foldStale, getItem, sweep } from './store.ts';
import { sweepStreams } from './streams.ts';
import type { Tg } from './tg.ts';

/** An `incident:ack:<event id>` card (the runner's ack was rejected) is about one event: once that event is done the card has no cause left and expires itself. */
export async function settleAckIncidents(db: D1Database, owner: number, now: number): Promise<number> {
  const { results } = await db.prepare("SELECT id FROM items WHERE user_id = ? AND id LIKE 'incident:ack:%' AND state IN ('new','shown')").bind(owner).all<{ id: string }>();
  let n = 0;
  for (const { id } of results) {
    const ev = Number(id.slice('incident:ack:'.length));
    if (!Number.isInteger(ev) || !(await db.prepare("SELECT 1 AS ok FROM events WHERE id = ? AND status = 'done'").bind(ev).first())) continue;
    const item = await getItem(db, owner, id);
    if (item && await applyExpire(db, item, now, 'job', `event ${ev} finished`)) n++;
  }
  return n;
}

export async function hourly(env: Env, tg: Tg, tz: string, now = Date.now()): Promise<{ swept: number[]; errors: string[] }> {
  const cap = cards.todayCap ? await cards.todayCap(env.DB, now, tz) : (await protectedToday(env.DB, now, tz)) ? 2 : 5;   // a protected day is short by itself
  const swept = await sweep(env.DB, now, cap);
  await expireStaleSends(env.DB, now, tz).catch(() => 0);
  const owner = Number(env.CHAT_ID), users = new Set([owner, ...swept]);
  const errors: string[] = [];
  await settleAckIncidents(env.DB, owner, now).catch(() => 0);
  await sweepStreams(env.DB, owner, now);   // one note per stream even when a job skipped the insert path
  for (const u of users) await foldStale(env.DB, u, now);   // before the render: the folded card's message goes in the same pass
  for (const u of users) errors.push(...(await reconcile(env.DB, tg, u, now, tz)).errors);
  return { swept, errors };
}
