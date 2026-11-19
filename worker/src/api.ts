// /items for the Mac's scripts (RUN_KEY = owner). Jobs write items, never chat text.
import { ACTIONS, KINDS, URGENCIES, type CustomAction, type Incoming, type Kind, type Urgency } from './contract.ts';
import type { Env } from './env.ts';
import { reconcile } from './reconcile.ts';
import { supersede } from './streams.ts';
import { applyAction, applyExpire, applyUnwork, getItem, itemLog, listItems, setDetail, upsertItem } from './store.ts';
import type { Tg } from './tg.ts';

const hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
const DEFAULT_ACTIONS: Record<Kind, string[]> = { decision: ['done', 'snooze_1h', 'snooze_tomorrow', 'snooze_3d', 'drop'], incident: ['ack'], inbox: [], digest: [], meeting: [] };

/** Up to 3 extra buttons per item: label 1-24 chars, instruction 1-300; ids c1..c3 are what callback_data carries. */
function parseCustom(raw: unknown): CustomAction[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 3) return 'custom_actions: up to 3 of {label, instruction}';
  const out: CustomAction[] = [];
  for (const [n, a] of raw.entries()) {
    const { label, instruction } = (a ?? {}) as Record<string, unknown>;
    if (typeof label !== 'string' || !label.trim() || label.length > 24) return 'custom_actions: label 1-24 chars';
    if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 300) return 'custom_actions: instruction 1-300 chars';
    out.push({ id: `c${n + 1}`, label: label.trim(), instruction: instruction.trim() });
  }
  return out;
}

const cut = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, n) : undefined);
/** The card's contract fields (do, why, cost, verb), cut to length. Nothing a model writes here reaches the HTML as markup: render escapes it. */
export function parseMeta(x: unknown): Record<string, string> | null {
  if (!x || typeof x !== 'object') return null;
  const m = x as Record<string, unknown>, out: Record<string, string> = {};
  for (const [k, n] of [['do', 90], ['why', 160], ['cost', 160], ['verb', 16]] as const) { const v = cut(m[k], n); if (v) out[k] = v; }
  return Object.keys(out).length ? out : null;
}

/** Validate a job's body into an Incoming, or return the reason for a 400. */
export async function parseIncoming(raw: unknown, userId: number): Promise<Incoming | string> {
  const b = (raw ?? {}) as Record<string, unknown>;
  const id = b.id, title = b.title;
  if (typeof id !== 'string' || !id || id.length > 200) return 'id: 1-200 chars';
  if (typeof title !== 'string' || !title.trim() || title.length > 300) return 'title: 1-300 chars';
  const kind = (b.kind ?? 'decision') as Kind, urgency = (b.urgency ?? 'today') as Urgency;
  if (!KINDS.includes(kind)) return 'kind: unknown';
  const body = b.body === undefined ? '' : b.body;
  const maxBody = kind === 'inbox' || kind === 'digest' ? 3500 : 3000;   // one Telegram message holds 4096
  if (typeof body !== 'string' || body.length > maxBody) return `body: string up to ${maxBody} chars`;
  if (!URGENCIES.includes(urgency)) return 'urgency: unknown';
  const actions = b.actions === undefined ? DEFAULT_ACTIONS[kind] : b.actions;
  if (!Array.isArray(actions) || actions.some(a => typeof a !== 'string' || !(a in ACTIONS))) return `actions: names from actions.json only (${Object.keys(ACTIONS).join(', ')})`;
  const expires = b.expires_at ?? null;
  if (expires !== null && !Number.isFinite(expires)) return 'expires_at: epoch ms';
  let payload = b.payload ?? null;
  if (payload !== null && typeof payload !== 'object') return 'payload: object';
  // `meta` stays OUT of the hash, so adding it to a card the owner already handled does not reopen it (the store refreshes it on a touch instead)
  if (payload) {
    const p = { ...(payload as Record<string, unknown>) };
    if ('meta' in p) { const m = parseMeta(p.meta); if (m) p.meta = m; else delete p.meta; }
    payload = Object.keys(p).length ? p : null;
  }
  const hashPayload = payload ? (({ meta: _m, ...rest }) => (Object.keys(rest).length ? rest : null))(payload as Record<string, unknown>) : null;
  const acts = [...new Set(actions as string[])];
  const loud = b.loud === true;
  const custom = parseCustom(b.custom_actions);
  if (typeof custom === 'string') return custom;
  return { id, kind, urgency, title: title.trim(), body, actions: acts, payload, source: typeof b.source === 'string' ? b.source.slice(0, 60) : null,
    expires_at: expires as number | null, loud, custom, hash: await hex(JSON.stringify([title.trim(), body, hashPayload, acts, kind, loud, custom])), short: (await hex(`${userId}:${id}`)).slice(0, 10) };
}

const json = (o: unknown, status = 200) => Response.json(o, { status });
const publicItem = ({ short: _s, rendered_hash: _r, ...i }: Awaited<ReturnType<typeof getItem>> & object) => i;

export async function itemsRoute(req: Request, u: URL, env: Env, tg: Tg, tz: string, now = Date.now(), sleep?: (ms: number) => Promise<void>): Promise<Response | null> {
  if (u.pathname !== '/items' && !u.pathname.startsWith('/items/')) return null;
  const owner = Number(env.CHAT_ID);
  if (req.method === 'GET' && u.pathname === '/items') {
    const items = await listItems(env.DB, owner, { state: u.searchParams.get('state') ?? undefined, kind: u.searchParams.get('kind') ?? undefined });
    return json(items.map(publicItem));
  }
  if (req.method === 'POST' && u.pathname === '/items') {
    const inc = await parseIncoming(await req.json().catch(() => null), owner);
    if (typeof inc === 'string') return json({ error: inc }, 400);
    const r = await upsertItem(env.DB, owner, inc, now, 'job');
    let errors: string[] = [];
    if (r.kind === 'insert') await supersede(env.DB, owner, inc.id, now);   // a new note of a stream closes the earlier ones before the render
    if (r.kind !== 'touch') errors = (await reconcile(env.DB, tg, owner, now, tz, sleep)).errors;
    const item = await getItem(env.DB, owner, inc.id);
    return json({ id: inc.id, result: r.kind, state: item?.state, message_id: item?.tg_message_id ?? null, render_errors: errors });
  }
  const mg = /^\/items\/([^/]+)\/(log|detail)$/.exec(u.pathname);
  if (mg) {
    const id = decodeURIComponent(mg[1]), item = await getItem(env.DB, owner, id);
    if (!item) return json({ error: 'no such item' }, 404);
    if (req.method === 'GET' && mg[2] === 'log') return json({ id, state: item.state, log: await itemLog(env.DB, owner, id) });
    if (req.method === 'POST' && mg[2] === 'detail') {
      const text = ((await req.json().catch(() => ({}))) as { text?: string }).text;
      if (typeof text !== 'string' || !text.trim()) return json({ error: 'text' }, 400);
      const ok = await setDetail(env.DB, item, text.trim(), now, 'job');
      if (ok) await reconcile(env.DB, tg, owner, now, tz, sleep);
      return json({ id, changed: ok });
    }
  }
  if (req.method === 'GET' && /^\/items\/[^/]+$/.test(u.pathname)) {
    const item = await getItem(env.DB, owner, decodeURIComponent(u.pathname.split('/')[2]));
    return item ? json(publicItem(item)) : json({ error: 'no such item' }, 404);
  }
  const m = /^\/items\/([^/]+)\/state$/.exec(u.pathname);
  if (req.method === 'POST' && m) {
    const id = decodeURIComponent(m[1]);
    const sb = (await req.json().catch(() => ({}))) as { state?: string; reason?: string };
    const state = sb.state, reason = typeof sb.reason === 'string' ? sb.reason.trim().slice(0, 200) : '';
    const action = state === 'done' ? 'done' : state === 'dropped' ? 'drop' : null;
    if (!action && state !== 'new' && state !== 'expired') return json({ error: "state: 'done', 'dropped', 'expired' (an incident whose check is green again, a meeting that is over) or 'new' (the run failed: back on the list)" }, 400);
    const item = await getItem(env.DB, owner, id);
    if (!item) return json({ error: 'no such item' }, 404);
    if (state === 'expired') {   // job-owned streams only: a decision card is never expired by a script without a reason
      if (item.kind !== 'incident' && item.kind !== 'meeting' && !(item.kind === 'decision' && reason)) return json({ error: 'expired: incident and meeting items; a decision only with a reason' }, 400);
      const gone = await applyExpire(env.DB, item, now, 'job', reason || undefined);
      if (gone) await reconcile(env.DB, tg, owner, now, tz, sleep);
      return json({ id, changed: gone, state: gone ? 'expired' : item.state });
    }
    if (!action) {
      const back = await applyUnwork(env.DB, item, now, 'job');
      if (back) await reconcile(env.DB, tg, owner, now, tz, sleep);
      return json({ id, changed: back, state: back ? 'new' : item.state });
    }
    const next = await applyAction(env.DB, { ...item, actions: [...item.actions, action] }, action, now, 'job', tz);
    if (next) await reconcile(env.DB, tg, owner, now, tz, sleep);
    return json({ id, changed: !!next, state: next?.state ?? item.state });
  }
  return json({ error: 'not found' }, 404);
}
