// The taps of the button grammar (grammar.ts). Owner only, idempotent (a state guard on every write), ids not text in callback_data.
// Every tap edits the card to one result line (the next reconcile) and removes the buttons; undo lives for a minute; no new chat message confirms anything.
import type { Item } from './contract.ts';
import { DROP_REASONS, EFFORT, SNOOZE_CODES, costUnknown, snoozeAt } from './grammar.ts';
import { EFFORT_MS, UNDO_MS, settle, undone } from './fsm.ts';
import { firstFreeDay } from './protected.ts';
import { keyboard } from './render.ts';
import { metaOf } from './roll.ts';
import { applySettle, lastLog, setUi } from './store.ts';
import { S, t } from './strings.ts';
import { parts } from './tz.ts';
import { cards } from './cardconfig.ts';
import type { Tg } from './tg.ts';

const CODES = new Set(['dm', 'pk', 'pl', 'un', 'done', ...DROP_REASONS.map(r => r[0]), ...SNOOZE_CODES, ...EFFORT.map(e => e[0]), 'a0', 'a1', 'a2']);
export const isGrammarTap = (a: string) => CODES.has(a);

const dd = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
const fresh = (item: Item) => ['new', 'shown'].includes(item.state) || item.working !== null;

export interface TapEnv { db: D1Database; tg: Tg; chatId: number; now: number; tz: string; by: string }

/** Returns the toast, or null when the action is not a grammar tap. The caller reconciles after a state change (`changed`). */
export async function grammarTap(e: TapEnv, item: Item, action: string): Promise<{ toast: string; changed: boolean } | null> {
  if (!isGrammarTap(action)) return null;
  const { db, tg, now, tz, by } = e, stale = { toast: S.tap_closed, changed: false };
  const menuTo = async (m: boolean | 'pick' | 'drop', toast: string) => {
    if (item.tg_message_id === null || !fresh(item)) return stale;
    await tg.editMarkup(e.chatId, item.tg_message_id, keyboard(item, true, m, 0, 0, false, { now, tz, free: await firstFreeDay(db, now, tz) })).catch(() => undefined);
    return { toast, changed: false };
  };
  if (action === 'dm') return menuTo('drop', S.tap_why);
  if (action === 'pk') return menuTo('pick', S.tap_which_day);
  if (action === 'pl') return menuTo(true, S.tap_how_long);
  if (action === 'un') {
    const u = undone(item, await lastLog(db, item), now);
    if (!u) return { toast: S.tap_too_late, changed: false };
    const payload = { ...((item.payload ?? {}) as Record<string, unknown>) }; delete payload.ui_undo; delete payload.ui_effort; delete payload.drop_reason;
    const res = await db.batch([db.prepare("UPDATE items SET state = ?, snooze_until = NULL, closed_at = NULL, working = NULL, msg_state = CASE WHEN msg_state = 'collapsed' THEN 'live' ELSE msg_state END, payload = ?, rendered_hash = NULL WHERE user_id = ? AND id = ? AND state = ?")
      .bind(u.item.state, JSON.stringify(payload), item.user_id, item.id, item.state),
      db.prepare('INSERT INTO item_log (user_id, item_id, at, from_state, to_state, by, note) SELECT ?,?,?,?,?,?,? WHERE changes() > 0').bind(u.log.user_id, u.log.item_id, u.log.at, u.log.from_state, u.log.to_state, u.log.by, u.log.note)]);
    return res[0].meta.changes ? { toast: S.tap_restored, changed: true } : stale;
  }
  const eff = EFFORT.find(x => x[0] === action);
  if (eff) {   // the effort answer: after the closing tap only, for two minutes, once
    const p = (item.payload ?? {}) as { ui_effort?: number; effort?: number };
    if (!p.ui_effort || p.ui_effort <= now || p.effort) return stale;
    await setUi(db, item, { effort: eff[2], ui_effort: 0 });
    await db.prepare('INSERT INTO item_log (user_id, item_id, at, from_state, to_state, by, note) VALUES (?,?,?,?,?,?,?)').bind(item.user_id, item.id, now, item.state, item.state, by, `effort:${eff[2]}`).run();
    return { toast: S.tap_noted, changed: true };
  }
  if (!fresh(item)) return stale;
  const ui = (extra: Record<string, unknown> = {}) => ({ ui_undo: now + UNDO_MS, ...extra });
  const close = async (to: 'done' | 'dropped', note: string, extra: Record<string, unknown>) => {
    const st = settle(item, to, now, by, note);
    return st && await applySettle(db, item, st, ui(extra)) ? true : false;
  };
  if (action === 'done') {
    const ok = await close('done', 'done', costUnknown(item) ? { ui_effort: now + EFFORT_MS } : {});
    return ok ? { toast: S.tap_done, changed: true } : stale;
  }
  const ans = /^a([0-2])$/.exec(action);
  if (ans) {   // a closed question: the answer is the item's result
    const a = metaOf(item).answers?.[Number(ans[1])];
    if (!a) return stale;
    const ok = await close('done', `answer:${a.value}`, { answer: a.value, answer_label: a.label });
    return ok ? { toast: a.label, changed: true } : stale;
  }
  const why = DROP_REASONS.find(r => r[0] === action);
  if (why) {
    const reason = why[2] === 'mute' && !mutable(item) ? 'plain' : why[2];   // ids the deployment marks unmutable are never muted
    const ok = await close('dropped', `drop:${reason}`, { drop_reason: reason });
    return ok ? { toast: reason === 'mute' ? S.tap_muted : why[2] === 'mute' ? S.tap_removed_unmutable : S.tap_removed, changed: true } : stale;
  }
  if (SNOOZE_CODES.includes(action)) {
    const free = await firstFreeDay(db, now, tz), at = snoozeAt(action, now, tz, free);
    if (at === null) return { toast: S.tap_time_passed, changed: false };
    const hard = metaOf(item).hard_due;   // a snooze must not cross a hard deadline: refused, one line naming it
    if (hard && parts(at, tz).date > hard) return { toast: t('tap_deadline', { date: dd(hard) }), changed: false };
    const st = settle(item, 'snoozed', now, by, `snooze:${action}`, at);
    return st && await applySettle(db, item, st, ui()) ? { toast: S.tap_snoozed, changed: true } : stale;
  }
  return null;
}

export const mutable = (item: Item) => !(cards.unmutable?.test(item.id)) && !['incident', 'meeting'].includes(item.kind) && !(cards.unmutable?.test(String((item.payload as { group?: string } | null)?.group ?? '')));
