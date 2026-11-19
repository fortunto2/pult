// A button press. Identity first (the owner only), then the item by short id.
// callback_data is never trusted: the action must be in the item's stored list; a custom button's instruction is looked up here, never read from callback_data.
import { ACTIONS } from './contract.ts';
import { keyboard, SNOOZE_BACK, SNOOZE_MENU } from './render.ts';
import { reconcile } from './reconcile.ts';
import { buttonEvent, type ItemEvent } from './replies.ts';
import { applyAction, getByShort } from './store.ts';
import type { Tg } from './tg.ts';

const DATA = /^v1:([0-9a-f]{10}):([a-z0-9_]{1,32})$/;
const TOAST: Record<string, string> = { ack: 'acknowledged', done: 'done', drop: 'dropped', snooze_1h: 'back in 1 hour', snooze_tomorrow: 'back tomorrow', snooze_3d: 'back in 3 days' };

export async function handleCallback(db: D1Database, tg: Tg, owner: number, q: { fromId: number; data: string; queryId: string; name?: string }, now: number, tz: string,
                                     sleep?: (ms: number) => Promise<void>, enqueue?: (e: ItemEvent) => Promise<void>): Promise<string | null> {
  if (q.fromId !== owner) return null;  // anyone else: dropped, not even a toast
  const answer = async (text: string) => { await tg.answerCallback(q.queryId, text).catch(() => undefined); return text; };
  const m = DATA.exec(q.data);
  if (!m) return answer('unknown button');
  const [, short, action] = m;
  const item = await getByShort(db, owner, short);
  if (!item) return answer('already handled');
  if (/^c[1-3]$/.test(action)) {  // a per-item custom button: its instruction becomes a queued read-and-draft job
    const c = item.custom.find(x => x.id === action);
    if (!c || !enqueue) return answer('not allowed');
    const ev = await buttonEvent(db, tg, item, c, { userId: owner, name: q.name ?? 'owner' }, now, tz);
    if (!ev) return answer('already running');
    await enqueue(ev);
    return answer('started');
  }
  if (action === SNOOZE_MENU || action === SNOOZE_BACK) {   // keyboard only, no state change
    if (item.tg_message_id === null || !['new', 'shown'].includes(item.state)) return answer('already handled');
    await tg.editMarkup(item.user_id, item.tg_message_id, keyboard(item, true, action === SNOOZE_MENU)).catch(() => undefined);
    return answer(action === SNOOZE_MENU ? 'for how long?' : 'ok');
  }
  if (!ACTIONS[action] || !item.actions.includes(action)) return answer('not allowed');
  const next = await applyAction(db, item, action, now, `user:${owner}`, tz);
  if (!next) return answer('already handled');
  const text = await answer(TOAST[action] ?? 'done');
  await reconcile(db, tg, owner, now, tz, sleep);
  return text;
}
