// The Mini App's API, /app/api/*. Every call carries `Authorization: tma <initData>`. 401: missing, malformed, bad signature, expired. 403: a valid Telegram user who is not the owner.
// The core view is generic and read-only: open cards, sessions, queue depth and the usage-limit pause, recent runs. Extensions add panels (their own data, declarative).
// Write-back (card buttons from the app) is behind a D1 switch, `app:write` = '1', off by default; /appwrite on|off flips it.
import { ACTIONS } from '../contract.ts';
import type { AppCtx, Extension, PanelData } from '../extension.ts';
import { depth } from '../queue.ts';
import { reconcile } from '../reconcile.ts';
import { listSessions } from '../sessions.ts';
import { getSetting, pausedUntil } from '../settings.ts';
import { applyAction, getByShort, listItems } from '../store.ts';
import { validateInitData, type InitResult } from './initdata.ts';

const json = (b: unknown, status = 200) => Response.json(b, { status, headers: { 'cache-control': 'no-store' } });
export const WRITE_KEY = 'app:write';
export const writeEnabled = async (db: D1Database) => (await getSetting(db, WRITE_KEY)) === '1';

/** initData from the header, checked; the owner only. A Response is the refusal. */
export async function authenticate<X>(req: Request, ctx: AppCtx<X>): Promise<InitResult & { ok: true } | Response> {
  const h = req.headers.get('Authorization') ?? '';
  if (!h.startsWith('tma ')) return json({ error: 'unauthorized' }, 401);
  const e = ctx.env;
  const r = await validateInitData(h.slice(4), { botToken: e.TELEGRAM_BOT_TOKEN, botId: e.BOT_ID, publicKeyHex: e.TG_PUBLIC_KEY, mode: e.MINIAPP_AUTH }, ctx.now);
  if (!r.ok) return json({ error: 'unauthorized', reason: r.reason }, 401);
  if (r.user.id !== ctx.owner) return json({ error: 'forbidden' }, 403);
  return r;
}

export async function overview<X>(ctx: AppCtx<X>) {
  const { db, owner, now } = ctx;
  const cards = (await listItems(db, owner, { state: 'open' })).slice(0, 200).map(i => ({
    short: i.short, title: i.title, body: i.body.slice(0, 1500), kind: i.kind, urgency: i.urgency, state: i.state, since: i.first_seen, snooze_until: i.snooze_until,
    source: i.source, working: i.working, actions: i.actions.filter(a => ACTIONS[a]).map(a => ({ id: a, label: ACTIONS[a].label })),
    link: typeof (i.payload as { link?: unknown } | null)?.link === 'string' && /^https:\/\//.test((i.payload as { link: string }).link) ? (i.payload as { link: string }).link : null,
  }));
  const sessions = (await listSessions(db, owner, 30)).map(s => ({ id: s.id, title: s.title, status: s.status, workflow: s.workflow, last_active: s.last_active }));
  const q = await depth(db);
  const { results: runs } = await db.prepare("SELECT id, action, priority, status, session_id, created_at, acked_at, attempts FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 25").bind(owner).all();
  return { now, cards, sessions, queue: { ...q, paused_until: (await pausedUntil(db, now)) || null }, runs };
}

export async function appRoute<X>(req: Request, u: URL, ctx: AppCtx<X>, exts: Extension<X>[]): Promise<Response | null> {
  if (!u.pathname.startsWith('/app/api/')) return null;
  const who = await authenticate(req, ctx);
  if (who instanceof Response) return who;
  const route = u.pathname.slice('/app/api/'.length), db = ctx.db;
  const panels = exts.flatMap(e => e.panels ?? []);

  if (route === 'me' && req.method === 'GET') return json({ user_id: who.user.id, via: who.via, write: await writeEnabled(db), start_param: who.startParam, panels: panels.map(p => ({ id: p.id, title: p.title })) });
  if (route === 'overview' && req.method === 'GET') return json(await overview(ctx));
  const pm = /^panel\/([a-z0-9_-]{1,32})$/.exec(route);
  if (pm && req.method === 'GET') {
    const p = panels.find(x => x.id === pm[1]);
    if (!p) return json({ error: 'no such panel' }, 404);
    try { return json({ id: p.id, title: p.title, data: await p.data(ctx) satisfies PanelData }); }
    catch (e) { console.error(`panel ${p.id} failed`, e); return json({ error: 'panel failed' }, 502); }
  }
  if (route === 'action' && req.method === 'POST') {
    if (!(await writeEnabled(db))) return json({ error: 'write disabled' }, 403);
    const b = await req.json<{ short?: string; action?: string }>().catch(() => ({} as { short?: string; action?: string }));
    if (typeof b.short !== 'string' || typeof b.action !== 'string') return json({ error: 'short, action' }, 400);
    const item = await getByShort(db, ctx.owner, b.short);
    if (!item) return json({ error: 'gone' }, 404);
    if (!ACTIONS[b.action] || !item.actions.includes(b.action)) return json({ error: 'not allowed' }, 400);
    const next = await applyAction(db, item, b.action, ctx.now, `app:${ctx.owner}`, ctx.tz);
    if (!next) return json({ error: 'already handled' }, 409);
    await reconcile(db, ctx.tg, ctx.owner, ctx.now, ctx.tz).catch(() => undefined);   // the chat message collapses like after a button press
    return json({ ok: true, state: next.state });
  }
  return json({ error: 'not found' }, 404);
}
