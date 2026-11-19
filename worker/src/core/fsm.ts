// Pure state machine for items. No I/O: store.ts applies what these return.
import { ACTIONS, OPEN_STATES, WORK_HOURS, type Incoming, type Item, type LogRow, type State, type Urgency } from './contract.ts';

const H = 3600e3;
export const DEFAULT_TTL: Record<Urgency, number> = { now: 24 * H, today: 36 * H, week: 7 * 24 * H };
export const isWorking = (i: Item) => i.state === 'snoozed' && i.working !== null;
const isOpen = (s: State) => OPEN_STATES.includes(s);

export type UpsertKind = 'insert' | 'touch' | 'update' | 'reopen';
export interface UpsertResult { item: Item; log: LogRow | null; kind: UpsertKind }

function log(item: Pick<Item, 'user_id' | 'id'>, at: number, from: State | null, to: State, by: string, note = ''): LogRow {
  return { user_id: item.user_id, item_id: item.id, at, from_state: from, to_state: to, by, note };
}

/** Insert / touch / update in place / reopen. The same id with the same content creates nothing; a closed item stays closed until its content changes. */
export function upsert(existing: Item | null, inc: Incoming, userId: number, now: number, by = 'job'): UpsertResult {
  // Decisions and meetings run out; a live note and an incident stay until replaced or acknowledged.
  const expires = inc.expires_at ?? (inc.kind === 'decision' || inc.kind === 'meeting' ? now + DEFAULT_TTL[inc.urgency] : null);
  const fresh = (): Item => ({
    user_id: userId, id: inc.id, short: inc.short, kind: inc.kind, urgency: inc.urgency, state: 'new',
    first_seen: now, last_seen: now, shown_at: null, snooze_until: null, expires_at: expires, closed_at: null, source: inc.source,
    title: inc.title, body: inc.body, actions: inc.actions, payload: inc.payload, hash: inc.hash,
    tg_message_id: null, msg_state: 'none', rendered_hash: null, loud: inc.loud, working: null, custom: inc.custom,
  });
  if (!existing) { const item = fresh(); return { item, log: log(item, now, null, 'new', by, 'insert'), kind: 'insert' }; }
  if (existing.hash === inc.hash) return { item: { ...existing, last_seen: now }, log: null, kind: 'touch' };  // closed stays closed
  if (isOpen(existing.state)) {
    const item = { ...existing, last_seen: now, title: inc.title, body: inc.body, actions: inc.actions, payload: inc.payload,
      hash: inc.hash, kind: inc.kind, urgency: inc.urgency, source: inc.source, loud: inc.loud, custom: inc.custom };
    return { item, log: log(item, now, existing.state, existing.state, by, 'content changed'), kind: 'update' };
  }
  // Closed and the fact changed: a new life. The old message (collapsed) stays in tg_message_id for the renderer to replace.
  const item: Item = { ...fresh(), short: existing.short, tg_message_id: existing.tg_message_id,
    msg_state: existing.msg_state === 'live' ? 'live' : existing.msg_state === 'collapsed' ? 'collapsed' : 'none' };
  return { item, log: log(item, now, existing.state, 'new', by, `reopened: content changed after ${existing.state}`), kind: 'reopen' };
}

/** Next 08:00 local after now + 8 h (so "tomorrow" never means "in twenty minutes"). */
export function tomorrowMorning(now: number, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  for (let t = now + 8 * H; t < now + 40 * H; t += 15 * 60e3) {
    if (fmt.format(new Date(t)) === '08:00') return t;
  }
  return now + 24 * H;
}

/** One state action. Returns null when it changes nothing (double press, wrong state, action not in the item's list). */
export function transition(item: Item, action: string, now: number, by: string, tz = 'UTC'): { item: Item; log: LogRow } | null {
  const def = ACTIONS[action];
  if (!def || !item.actions.includes(action)) return null;
  if (item.state !== 'new' && item.state !== 'shown' && !isWorking(item)) return null;
  let to: State = 'done', snooze: number | null = null;
  if (action === 'drop') to = 'dropped';
  else if (def.snooze) {
    to = 'snoozed';
    snooze = def.snooze === '1h' ? now + H : def.snooze === '3d' ? now + 72 * H : tomorrowMorning(now, tz);
  }
  const next: Item = { ...item, state: to, snooze_until: snooze, closed_at: to === 'snoozed' ? null : now, working: null };
  return { item: next, log: log(item, now, item.state, to, by, action) };
}

/** Hourly sweep for one item: expiry of undecided, wake of snoozed. */
export function sweepItem(item: Item, now: number): { item: Item; log: LogRow } | null {
  if (item.state === 'snoozed' && item.snooze_until !== null && item.snooze_until <= now) {
    // The collapsed message is replaced by a fresh one from the renderer.
    return { item: { ...item, state: 'new', snooze_until: null, working: null, shown_at: null, rendered_hash: null, expires_at: Math.max(item.expires_at ?? 0, now + DEFAULT_TTL[item.urgency]) },
      log: log(item, now, 'snoozed', 'new', 'sweep', 'snooze over') };
  }
  if ((item.state === 'new' || item.state === 'shown') && item.expires_at !== null && item.expires_at <= now)
    return { item: { ...item, state: 'expired', closed_at: now }, log: log(item, now, item.state, 'expired', 'sweep', 'expires_at passed') };
  return null;
}

/**
 * Your reply or a custom button: the item is being handled. Open and snoozed items move to "working" (state snoozed + working text,
 * back to new after WORK_HOURS if nothing closes it). `dedupe` makes a repeated press of the same button a no-op. Null = nothing to change.
 */
export function work(item: Item, text: string, now: number, by: string, note: string, dedupe = false): { item: Item; log: LogRow } | null {
  if (item.state === 'done' || item.state === 'dropped' || item.state === 'expired') return null;
  if (dedupe && item.state === 'snoozed' && item.working === text) return null;
  const next: Item = { ...item, state: 'snoozed', snooze_until: now + WORK_HOURS * 3600e3, working: text, closed_at: null };
  return { item: next, log: log(item, now, item.state, 'snoozed', by, `${note}: ${text.slice(0, 80)}`) };
}

/** The run failed or was abandoned: back on the list. */
export function unwork(item: Item, now: number, by: string): { item: Item; log: LogRow } | null {
  if (!isWorking(item)) return null;
  return { item: { ...item, state: 'new', snooze_until: null, working: null, shown_at: null, rendered_hash: null }, log: log(item, now, 'snoozed', 'new', by, 'run failed, back on the list') };
}
