// Hand-written from contracts/*.json. A change to an action or a field needs a test update (contract.test.ts).
import actionsJson from '../../contracts/actions.json' with { type: 'json' };

export type Kind = 'decision' | 'inbox' | 'digest' | 'incident' | 'meeting';
export type Urgency = 'now' | 'today' | 'week';
export type State = 'new' | 'shown' | 'snoozed' | 'done' | 'dropped' | 'expired';
export type MsgState = 'none' | 'sending' | 'live' | 'collapsed' | 'gone';
export type Role = 'owner' | 'member';

export const KINDS: Kind[] = ['decision', 'inbox', 'digest', 'incident', 'meeting'];
export const URGENCIES: Urgency[] = ['now', 'today', 'week'];
export const OPEN_STATES: State[] = ['new', 'shown', 'snoozed'];
export const CLOSED_STATES: State[] = ['done', 'dropped', 'expired'];

export interface CustomAction { id: string; label: string; instruction: string }
export const WORK_HOURS = 6;  // a run that never reports back returns the item to the list after this long

/** tier `state` moves the card; `draft` hands the card to a read-and-draft job; `task` is handled by an extension. */
export interface ActionDef { tier: 'state' | 'draft' | 'task'; label: string; roles?: Role[]; snooze?: '1h' | 'tomorrow' | '3d' }
export const ACTIONS = { ...(actionsJson as Record<string, ActionDef>) };
/** An extension (or createApp's `actions` option) adds actions the contract accepts: a name that is already taken is refused. */
export function addActions(defs: Record<string, ActionDef>): void {
  for (const [name, d] of Object.entries(defs)) {
    if (!/^[a-z0-9_]{1,32}$/.test(name)) throw new Error(`action "${name}": [a-z0-9_]{1,32}`);
    if (ACTIONS[name] && JSON.stringify(ACTIONS[name]) !== JSON.stringify(d)) throw new Error(`action "${name}" is already defined`);
    ACTIONS[name] = d;
  }
}

export interface Item {
  user_id: number; id: string; short: string; origin_user: number | null;
  kind: Kind; urgency: Urgency; state: State;
  first_seen: number; last_seen: number; shown_at: number | null; snooze_until: number | null; expires_at: number | null;
  closed_at: number | null; source: string | null; title: string; body: string;
  actions: string[]; payload: unknown; hash: string;
  tg_message_id: number | null; msg_state: MsgState; rendered_hash: string | null;
  loud: boolean; loud_sent_at: number | null; bumped_at: number | null;
  working: string | null; custom: CustomAction[]; held?: number; folded_at?: number | null;
}

// What a job sends: user_id comes from the key, never from the body.
export interface Incoming {
  id: string; kind: Kind; urgency: Urgency; title: string; body: string; actions: string[];
  payload: unknown; source: string | null; expires_at: number | null; origin_user: number | null; hash: string; short: string; loud: boolean; custom: CustomAction[]; held?: boolean;
}

export interface LogRow { user_id: number; item_id: string; at: number; from_state: State | null; to_state: State; by: string; note: string }

export interface EventRow { user_id: number; role: Role; item_id: string; action: string }
