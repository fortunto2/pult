// The hourly tick: expire undecided cards, wake snoozed ones, re-render what changed (also retries a render that failed earlier).
import type { Env } from './env.ts';
import { reconcile } from './reconcile.ts';
import { sweep } from './store.ts';
import type { Tg } from './tg.ts';

export async function hourly(env: Env, tg: Tg, tz: string, now = Date.now()): Promise<void> {
  await sweep(env.DB, now);
  await reconcile(env.DB, tg, Number(env.CHAT_ID), now, tz);
}
