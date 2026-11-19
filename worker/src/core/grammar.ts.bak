// The button grammar of a decision card. Pure: keyboards, labels and snooze targets.
// Layout: at most 2 rows, at most 3 buttons per row, the same places on every card.
//   row 1  [primary] [Later] [Not needed]    primary = the card's own verb (meta.verb, "Paid", "Done"); a closed question puts its answers (<=3) in row 1 instead
//   row 2  contextual: [More] [custom button] [one more] (open link, copy)
// "Later" swaps row 1 in place for [This evening] [Tomorrow] [Mon] / [Pick a day] [← back]; "Not needed" asks why with one more tap, skippable.
// The day picker (seven days) is the one transient exception to the two-row rule.
import type { Item } from './contract.ts';
import { cards } from './cardconfig.ts';
import { metaOf } from './roll.ts';
import { S } from './strings.ts';
import { localToInstant, parts } from './tz.ts';

export type Btn = { text: string; callback_data: string } | { text: string; url: string } | { text: string; copy_text: { text: string } };
type Style = { style?: 'danger' | 'success' | 'primary' };
export type GButton = Btn & Style;
export type Menu = boolean | 'pick' | 'drop';   // `true` = the "Later" row
export interface GrammarCtx { now?: number; tz?: string; free?: string | null; reply?: boolean }   // reply: the reply button is offered (an open Gmail/Telegram/LinkedIn card with no draft yet; render.ts canReply)   // free: the first non-protected date (YYYY-MM-DD) while today is protected

/** The card's own verb for its primary button: meta.verb, else a configured stem of meta.do, else the generic one. */
export const verbOf = (item: Item): string => { const m = metaOf(item); return m.verb ?? cards.verbByStem.find(([re]) => re.test(m.do ?? ''))?.[1] ?? S.verb_done; };

/** [callback code, label key, reason]. The label comes from `S`, so a deployment translates it. */
export const DROP_REASONS: [string, string, string][] = [['dd', 'drop_done', 'done'], ['ds', 'drop_stale', 'stale'], ['dn', 'drop_notmine', 'notmine'], ['dx', 'drop_mute', 'mute'], ['dc', 'drop_plain', 'plain']];
export const SNOOZE_CODES = ['sv', 'st', 'sm', 'sf', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
export const EFFORT: [string, string, number][] = [['e5', 'effort_5', 5], ['e30', 'effort_30', 30], ['e60', 'effort_60', 60]];

export function dayLabel(ms: number, tz: string): string {
  const p = parts(ms, tz), d = new Date(`${p.date}T12:00:00Z`);
  return `${S.weekdays.split(',')[d.getUTCDay()]} ${p.date.slice(8, 10)}.${p.date.slice(5, 7)}`;
}
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);

/** When each snooze code wakes the card (instants in the owner's zone), or null when the code does not apply now ("this evening" after 18:30). */
export function snoozeAt(code: string, now: number, tz: string, free?: string | null): number | null {
  const today = parts(now, tz);
  if (code === 'sv') return today.min < 18 * 60 + 30 ? localToInstant(today.date, '19:00', tz) : null;
  if (code === 'st') return localToInstant(addDays(today.date, 1), '08:00', tz);
  if (code === 'sf') return free ? localToInstant(free, '08:00', tz) : null;
  if (code === 'sm') { const wd = new Date(`${today.date}T12:00:00Z`).getUTCDay(); return localToInstant(addDays(today.date, ((8 - wd) % 7) || 7), '09:00', tz); }
  const n = /^d([1-7])$/.exec(code);
  return n ? localToInstant(addDays(today.date, Number(n[1])), '09:00', tz) : null;
}

const cb = (short: string, a: string) => `v1:${short}:${a}`;

/** The decision card's keyboard rows for one menu state. `extras` = the details button, other custom buttons, link, copy: the first three are shown. */
export function decisionRows(item: Item, menu: Menu, extras: GButton[], ctx: GrammarCtx = {}): GButton[][] {
  const t = (text: string, a: string, style?: Style['style']): GButton => ({ text, callback_data: cb(item.short, a), ...(style ? { style } : {}) });
  const now = ctx.now ?? Date.now(), tz = ctx.tz ?? 'UTC';
  if (menu === 'drop') return [DROP_REASONS.slice(0, 3).map(([c, l]) => t(S[l], c)), [...DROP_REASONS.slice(3).map(([c, l]) => t(S[l], c)), t(S.back, 'snooze_back')].slice(0, 3)];
  if (menu === 'pick') {
    const days = [1, 2, 3, 4, 5, 6, 7].map(n => t(dayLabel(snoozeAt(`d${n}`, now, tz)!, tz), `d${n}`));
    return [days.slice(0, 3), days.slice(3, 6), [days[6], t(S.back, 'pl')]];
  }
  if (menu === true) {   // "Later" opened
    const eve = snoozeAt('sv', now, tz) !== null ? [t(S.snooze_evening, 'sv')] : [];
    const second = ctx.free ? t(dayLabel(snoozeAt('sf', now, tz, ctx.free)!, tz), 'sf') : t(S.snooze_tomorrow, 'st');   // a protected day offers the first free day first
    return [[...eve, second, t(S.snooze_monday, 'sm')].slice(0, 3), [t(S.snooze_pick, 'pk'), t(S.back, 'snooze_back')]];
  }
  const answers = metaOf(item).answers;
  const hot = item.urgency === 'now' ? 'danger' : item.urgency === 'today' ? 'primary' : 'success';
  const later = t(S.later_btn, 'snooze_menu'), drop = t(S.not_needed, 'dm');
  if (answers?.length) return [answers.map((a, i) => t(a.label, `a${i}`, i === 0 ? hot : undefined)), [later, drop, ...extras.slice(0, 1)]];
  if (ctx.reply) {   // the answer button. Primary when the card's action is an answer (the done verb moves to row 2), otherwise first in row 2.
    const rp = t(S.reply_btn, 'rp', hot);
    if (cards.answerDo?.test(metaOf(item).do ?? '')) return [[rp, later, drop], [t(verbOf(item), 'done'), ...extras.slice(0, 2)]];
    return [[t(verbOf(item), 'done', hot), later, drop], [rp, ...extras.slice(0, 2)]];
  }
  return [[t(verbOf(item), 'done', hot), later, drop], extras.slice(0, 3)].filter(r => r.length);
}

/** The collapsed line's buttons: undo for a minute, and for a card whose cost was unknown the effort question for two (stored for the mirror). */
export function afterRows(item: Item, now: number): GButton[][] {
  const p = (item.payload ?? {}) as { ui_undo?: number; ui_effort?: number; effort?: number };
  const rows: GButton[][] = [];
  if (p.ui_undo && p.ui_undo > now) rows.push([{ text: S.undo_btn, callback_data: cb(item.short, 'un') }]);
  if (p.ui_effort && p.ui_effort > now && !p.effort) rows.push(EFFORT.map(([c, l]) => ({ text: S[l], callback_data: cb(item.short, c) })));
  return rows;
}
export const afterKey = (item: Item, now: number) => { const p = (item.payload ?? {}) as { ui_undo?: number; ui_effort?: number; effort?: number }; return `c${p.ui_undo && p.ui_undo > now ? 'u' : ''}${p.ui_effort && p.ui_effort > now && !p.effort ? 'e' : ''}${p.effort ?? ''}`; };
export const costUnknown = (item: Item) => !!cards.costUnknown?.test(metaOf(item).cost ?? '');
