// A button press. Identity first (the owner only), then the item by short id.
// callback_data is never trusted: the action must be in the item's stored list; a custom button's instruction is looked up here, never read from callback_data.
import { ACTIONS } from './contract.ts';
import { cards } from './cardconfig.ts';
import { DEFAULT_SENDS_PER_DAY, finishSend, tapCancel, tapConfirm, tapSend } from './drafts.ts';
import { canReply, keyboard, REVEAL, STALE, SNOOZE_BACK, SNOOZE_MENU } from './render.ts';
import { reconcile } from './reconcile.ts';
import { firstFreeDay } from './protected.ts';
import { grammarTap, isGrammarTap } from './taps.ts';
import { buttonEvent, replyDraftEvent, type ItemEvent } from './replies.ts';
import { applyAction, applyUnwork, getByShort, revealHeld, unfoldStale } from './store.ts';
import { S, t } from './strings.ts';
import type { Tg } from './tg.ts';

const DATA = /^v1:([0-9a-f]{10}):([a-z0-9_]{1,32})$/;
const TOAST: Record<string, string> = { ack: 'toast_ack', done: 'toast_done', drop: 'toast_drop', snooze_1h: 'toast_snooze_1h', snooze_tomorrow: 'toast_snooze_tomorrow', snooze_3d: 'toast_snooze_3d' };

export interface CallbackOpts {
  /** false when the queue is off: buttons that need the runner say so instead of failing. Default true. */
  sessions?: boolean;
  /** confirmed sends per local day (send-on-confirm). */
  sendCap?: number;
}

export async function handleCallback(db: D1Database, tg: Tg, owner: number, q: { fromId: number; data: string; queryId: string; name?: string }, now: number, tz: string,
                                     sleep?: (ms: number) => Promise<void>, enqueue?: (e: ItemEvent) => Promise<void>, opts: CallbackOpts = {}): Promise<string | null> {
  if (q.fromId !== owner) return null;  // anyone else: dropped, not even a toast
  const sessions = opts.sessions !== false;
  const answer = async (text: string) => { await tg.answerCallback(q.queryId, text).catch(() => undefined); return text; };
  const m = DATA.exec(q.data);
  if (!m) return answer(S.unknown_button);
  const [, short, action] = m;
  const item = await getByShort(db, owner, short);
  if (!item) return answer(S.already_handled);
  const who = { userId: owner, name: q.name ?? 'owner' };
  const sy = /^sy_([0-9a-f]{12})$/.exec(action);
  if (action === 'send_draft' || action === 'sn' || action === 'fix_draft' || sy) {   // send on confirm: only on a card that carries a draft; not in the item's action list on purpose
    if (action === 'fix_draft') return answer(S.fix_prompt);
    if (action !== 'sn' && (!sessions || !enqueue)) return answer(S.queue_off_send);
    const tap = action === 'send_draft' ? await tapSend(db, item, now) : action === 'sn' ? await tapCancel(db, item, now) : await tapConfirm(db, item, sy![1], now, tz, opts.sendCap ?? DEFAULT_SENDS_PER_DAY);
    if (tap.event && enqueue) {
      try { await enqueue({ id: now, at: now, text: `send_draft ${tap.event.row}`, quoted: '', from: { id: owner, name: who.name }, action: 'send_draft', item: { id: item.id, kind: item.kind, title: item.title } }); }
      catch { await finishSend(db, tap.event.row, { state: 'failed', reason: S.queue_failed }, now, tz); tap.toast = S.queue_failed; }
    }
    const text = await answer(tap.toast);
    if (tap.render) await reconcile(db, tg, owner, now, tz, sleep);
    return text;
  }
  if (action === 'rp') {   // the reply button: an open card of a configured group with no draft; the job only reads and writes text, a script makes the mail draft
    if (!canReply(item)) return answer(S.not_allowed);
    if (!sessions || !enqueue) return answer(S.queue_off_reply);
    const ev = await replyDraftEvent(db, tg, item, who, now, tz);
    if (!ev) return answer(S.already_running);
    try { await enqueue(ev); } catch { await applyUnwork(db, item, now, 'button rp'); await reconcile(db, tg, owner, now, tz, sleep); return answer(S.queue_failed); }
    return answer(S.writing_toast);
  }
  if (/^c[1-3]$/.test(action)) {  // a per-item custom button: its instruction becomes a queued read-and-draft job
    const c = item.custom.find(x => x.id === action);
    if (!c || !enqueue) return answer(S.not_allowed);
    const ev = await buttonEvent(db, tg, item, c, who, now, tz);
    if (!ev) return answer(S.already_running);
    await enqueue(ev);
    return answer(S.started_draft);
  }
  if (action === REVEAL) {   // the next 8 held cards appear; the note's button count follows on the reconcile
    const n = await revealHeld(db, owner, 8);
    if (!n) return answer(S.no_more);
    const text = await answer(t('shown_n', { n }));
    await reconcile(db, tg, owner, now, tz, sleep);
    return text;
  }
  if (action === STALE) {   // the standup's "hanging" line: the oldest folded cards come back (silent), the line's count follows on the reconcile
    const n = await unfoldStale(db, owner, 8, now);
    if (!n) return answer(S.no_more);
    const text = await answer(t('shown_n', { n }));
    await reconcile(db, tg, owner, now, tz, sleep);
    return text;
  }
  if (isGrammarTap(action)) {   // the button grammar
    const r = await grammarTap({ db, tg, chatId: owner, now, tz, by: `user:${owner}` }, item, action);
    const text = await answer(r!.toast);
    if (r!.changed) await reconcile(db, tg, owner, now, tz, sleep);
    return text;
  }
  if (action === SNOOZE_MENU || action === SNOOZE_BACK) {   // keyboard only, no state change
    if (item.tg_message_id === null || !['new', 'shown'].includes(item.state)) return answer(S.already_handled);
    await tg.editMarkup(owner, item.tg_message_id, keyboard(item, true, action === SNOOZE_MENU, 0, 0, false, { now, tz, free: await firstFreeDay(db, now, tz) })).catch(() => undefined);
    return answer(action === SNOOZE_MENU ? S.tap_how_long : S.ok);
  }
  const def = ACTIONS[action];
  if (!def || !item.actions.includes(action)) return answer(S.not_allowed);
  if (def.tier !== 'state') {   // draft and task tiers: a deployment's own handler (a deterministic script action queued like a button)
    const toast = await cards.onAction?.({ db, tg, item, action, now, tz, owner, name: who.name, enqueue });
    return answer(toast ?? S.not_allowed);
  }
  const next = await applyAction(db, item, action, now, `user:${owner}`, tz);
  if (!next) return answer(S.already_handled);
  const text = await answer(S[TOAST[action]] ?? S.toast_done);
  await reconcile(db, tg, owner, now, tz, sleep);
  return text;
}
