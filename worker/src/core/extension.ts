// The extension contract. pult is a core; a private layer adds to it through these hooks and nothing else (no patching, no forks).
// Everything an extension registers is namespaced by its name, so two extensions and the core cannot collide: routes live under /x/<name>/,
// commands and callback prefixes are validated at createApp() time, and a clash throws before the worker serves a single request.
import type { Api } from 'grammy';
import type { Message, Update } from 'grammy/types';
import type { Env } from './env.ts';
import type { Markup, Button } from './render.ts';
import type { QEvent, QueueHooks } from './queue.ts';
import type { Migration } from './migrations.ts';
import type { Tg } from './tg.ts';

export type { Migration, QEvent, Markup, Button, QueueHooks };

/** What every hook receives. `env` is the core Env plus the extension's own bindings (the generic X). */
export interface AppCtx<X = object> {
  env: Env & X; db: D1Database; tg: Tg; api: Api;
  owner: number;          // the owner's Telegram id: the only user the bot serves
  tz: string; now: number;
}

export interface RouteCtx<X = object> extends AppCtx<X> { url: URL; params: string[] /* regexp groups of the sub-path, if the route path is a RegExp */; /** set for `tma` and `tma_user` routes: the Telegram user whose initData was verified */ user?: { id: number } }
/** `key`: Authorization: Bearer RUN_KEY (default). `tma`: a valid Mini App initData of the owner. `tma_user`: a valid Mini App initData of ANY Telegram user (a family member's app), the handler decides what that user may see via `ctx.user`. `public`: no check, the handler's own business (a second webhook, a health ping). */
export interface Route<X = object> { method: string; path: string | RegExp; auth?: 'key' | 'tma' | 'tma_user' | 'public'; handler(req: Request, ctx: RouteCtx<X>): Promise<Response> }

export interface CommandCtx<X = object> extends AppCtx<X> { args: string; replyToMessageId?: number; reply(text: string, markup?: Markup): Promise<void> }
export interface Command<X = object> { name: string; description: string; run(c: CommandCtx<X>): Promise<void> }

/** A button whose callback_data starts with `prefix` (e.g. `crm:`). `data` is what follows the prefix. callback_data is never trusted: validate it. */
export interface CallbackCtx<X = object> extends AppCtx<X> { data: string; queryId: string; fromId: number; messageId?: number; answer(text: string): Promise<void> }
export interface Callback<X = object> { prefix: string; run(c: CallbackCtx<X>): Promise<void> }

/** A queue action: `enqueue(db, { action: '<name>', ... })` makes the Mac runner look the name up in its registry (PULT_PLUGINS). `onAck` runs here when the runner acks such an event. */
export interface QueueAction<X = object> { onAck?(ctx: AppCtx<X>, ev: QEvent, ack: { status: 'done' | 'failed' | 'stopped' | 'requeue'; body: Record<string, unknown> }): Promise<void> }

/** A Mini App section. The data is declarative (rows, key-values, text): the page renders it with textContent, so an extension ships no script into the app. */
export type PanelRow = { title: string; sub?: string; badge?: string; focus?: string /* start_param that opens it: `panel:<id>:<focus>` */ };
export type PanelData = { rows: PanelRow[] } | { kv: [string, string][] } | { text: string };
export interface Panel<X = object> { id: string; title: string; data(ctx: AppCtx<X>): Promise<PanelData> }

/** An owner's private-chat message that no slash command took. `reply` quotes the message by default. */
export interface MessageCtx<X = object> extends AppCtx<X> {
  message: Message; text: string /* text or caption */; forwarded: boolean; replyToMessageId?: number;
  reply(text: string, o?: { markup?: Markup; replyTo?: number | null; silent?: boolean }): Promise<number | undefined>;
  react(emoji: string): Promise<void>;
}

export interface Extension<X = object> {
  name: string;                                   // [a-z][a-z0-9_]{1,15}
  migrations?: Migration[];                       // ids `<name>:...`; applied after the core ones, once each, in order
  routes?: Route<X>[];                            // served under /x/<name>/<path>
  commands?: Command<X>[];                        // slash commands (also registered in the menu by /setup)
  callbacks?: Callback<X>[];
  queueActions?: Record<string, QueueAction<X>>;
  scheduled?(ctx: AppCtx<X>, ev: ScheduledController): Promise<void>;   // after the core's hourly sweep, on every cron trigger; check ev.cron if you have several
  panels?: Panel<X>[];                            // Mini App sections; data comes from your own tables, never from the core's
  /** Updates from anyone but the owner (a family member, a group, a stranger) reach the core's gate first and are dropped. An extension that serves other people claims them here: return true when handled; false leaves them to be dropped. The core never answers non-owners itself. */
  outsiders?(ctx: AppCtx<X>, update: Update): Promise<boolean>;
  queue?: QueueHooks;                              // slots of its own, filters on the core slots, lease length and ceiling, a recovery step, longer expiry for some events
  /** Runs first for every update (after the stop-button handler). Return true to drop it silently: business-connection updates, bot senders, an experiment fence. */
  fence?(ctx: AppCtx<X>, update: Update): boolean | Promise<boolean>;
  /** The owner's plain private message, before it becomes a session turn: claim intake, a rest/hold mode, a relayed answer, a keyboard-button text. Return true when handled (nothing is queued); false leaves it to the next extension and then the core. */
  ownerMessage?(c: MessageCtx<X>): Promise<boolean>;
  eventColumns?: Record<string, string | number | null>;   // values for extra columns your migrations added to `events` that have no default (written on every core insert)
  help?: string;                                  // a line appended to /help
}

export const CORE_COMMANDS = ['start', 'help', 'commands', 'status', 'new', 'sessions', 'stop', 'open', 'later', 'app', 'appwrite'];
export const CORE_ACTIONS = ['ask', 'reply', 'c1', 'c2', 'c3'];
export const CORE_EVENT_COLUMNS = ['id', 'user_id', 'item_id', 'action', 'created_at', 'priority', 'session_id', 'text', 'files', 'reply_to', 'status', 'attempts', 'stop_requested', 'leased_until', 'lease_id', 'acked_at'];
export const CORE_CALLBACKS = ['v1:', 'sw:'];

const NAME = /^[a-z][a-z0-9_]{1,15}$/, CMD = /^[a-z][a-z0-9_]{0,31}$/, PREFIX = /^[a-z][a-z0-9_]{1,12}:$/, ACTION = /^[a-z][a-z0-9_]{1,31}$/, PANEL = /^[a-z0-9_-]{1,32}$/;

/** Throws on anything that would collide or escape its namespace. Called once by createApp. */
export function validate(exts: Extension<never>[]): void {
  const seen = { name: new Set<string>(), cmd: new Set<string>(CORE_COMMANDS), act: new Set<string>(CORE_ACTIONS), pre: new Set<string>(CORE_CALLBACKS), panel: new Set<string>(), col: new Set<string>() };
  const once = (set: Set<string>, v: string, what: string, by: string) => { if (set.has(v)) throw new Error(`extension ${by}: ${what} "${v}" is already taken`); set.add(v); };
  for (const e of exts) {
    if (!NAME.test(e.name)) throw new Error(`extension name "${e.name}": [a-z][a-z0-9_]{1,15}`);
    once(seen.name, e.name, 'name', e.name);
    for (const m of e.migrations ?? []) if (!m.id.startsWith(`${e.name}:`)) throw new Error(`extension ${e.name}: migration id "${m.id}" must start with "${e.name}:"`);
    for (const c of e.commands ?? []) { if (!CMD.test(c.name)) throw new Error(`extension ${e.name}: command "${c.name}" is not [a-z][a-z0-9_]*`); once(seen.cmd, c.name, 'command', e.name); }
    for (const c of e.callbacks ?? []) {
      if (!PREFIX.test(c.prefix)) throw new Error(`extension ${e.name}: callback prefix "${c.prefix}" must look like "abc:"`);
      for (const p of seen.pre) if (p.startsWith(c.prefix) || c.prefix.startsWith(p)) throw new Error(`extension ${e.name}: callback prefix "${c.prefix}" overlaps "${p}"`);
      seen.pre.add(c.prefix);
    }
    for (const a of Object.keys(e.queueActions ?? {})) { if (!ACTION.test(a)) throw new Error(`extension ${e.name}: queue action "${a}" is not [a-z][a-z0-9_]*`); once(seen.act, a, 'queue action', e.name); }
    for (const p of e.panels ?? []) { if (!PANEL.test(p.id)) throw new Error(`extension ${e.name}: panel id "${p.id}"`); once(seen.panel, p.id, 'panel', e.name); }
    for (const k of Object.keys(e.eventColumns ?? {})) { if (!/^[a-z][a-z0-9_]*$/.test(k) || CORE_EVENT_COLUMNS.includes(k)) throw new Error(`extension ${e.name}: eventColumns key "${k}" is not a plain extra column`); once(seen.col, k, 'event column', e.name); }
    for (const r of e.routes ?? []) if (typeof r.path === 'string' && !r.path.startsWith('/')) throw new Error(`extension ${e.name}: route path "${r.path}" must start with /`);
  }
}
