// Owner-key (RUN_KEY) routes of send-on-confirm; the runner's send script and item CLI are the only callers.
import { attachDraft, attachReply, claimSend, DEFAULT_SENDS_PER_DAY, draftOf, finishSend, getSend, listSends, parseDraft, parseReply, sendsToday } from './drafts.ts';
import type { Env } from './env.ts';
import { reconcile } from './reconcile.ts';
import { applyUnwork, getItem } from './store.ts';
import type { Tg } from './tg.ts';

export const sendCap = (env: Env) => { const n = Math.floor(Number(env.DRAFT_SENDS_PER_DAY)); return n >= 1 && n <= 100 ? n : DEFAULT_SENDS_PER_DAY; };
const json = (o: unknown, status = 200) => Response.json(o, { status });
const ID = /^\/owner\/draft-send\/(\d+)(?:\/(claim|done))?$/;

export async function draftRoute(req: Request, u: URL, env: Env, tg: Tg, tz: string, now = Date.now(), sleep?: (ms: number) => Promise<void>): Promise<Response | null> {
  const owner = Number(env.CHAT_ID);
  if (u.pathname === '/owner/draft-sends' && req.method === 'GET') return json({ cap: sendCap(env), used_today: await sendsToday(env.DB, now, tz), sends: await listSends(env.DB, Number(u.searchParams.get('limit')) || 30) });
  const a = /^\/items\/([^/]+)\/(draft|reply-draft)$/.exec(u.pathname);
  if (a && req.method === 'POST') {   // the runner shows a mail draft (`draft`) or a chat reply text (`reply-draft`) in a card
    let item = await getItem(env.DB, owner, decodeURIComponent(a[1]));
    if (!item) return json({ error: 'no such item' }, 404);
    if (item.kind !== 'decision') return json({ error: 'an open decision card only' }, 409);
    let unworked = false;
    if (item.state === 'snoozed' && item.working !== null) {   // the reply and fix buttons put the card "working": the finished draft is what brings it back
      unworked = await applyUnwork(env.DB, item, now, 'draft');
      item = (await getItem(env.DB, owner, item.id)) ?? item;
    }
    if (!['new', 'shown'].includes(item.state)) return json({ error: 'an open decision card only' }, 409);
    const raw = await req.json().catch(() => null), ring = (raw as { ring?: unknown } | null)?.ring === true;
    let r: { ok: boolean; changed: boolean };
    if (a[2] === 'draft') {
      const d = parseDraft(raw);
      if (typeof d === 'string') return json({ error: d }, 400);
      r = await attachDraft(env.DB, item, d, now, ring);
    } else {
      const d = parseReply(raw, now);
      if (typeof d === 'string') return json({ error: d }, 400);
      r = await attachReply(env.DB, item, d, now, ring);
    }
    if (r.changed || unworked) await reconcile(env.DB, tg, owner, now, tz, sleep);
    return json({ id: item.id, changed: r.changed, ok: r.ok });
  }
  const m = ID.exec(u.pathname);
  if (!m) return null;
  const id = Number(m[1]), row = await getSend(env.DB, id);
  if (!row) return json({ error: 'no such send' }, 404);
  if (!m[2] && req.method === 'GET') {
    const item = await getItem(env.DB, row.user_id, row.item_id);
    return json({ ...row, cap: sendCap(env), used_today: await sendsToday(env.DB, now, tz), task: item ? draftOf(item)?.task ?? null : null });
  }
  if (m[2] === 'claim' && req.method === 'POST') return json(await claimSend(env.DB, id, Number(((await req.json().catch(() => ({}))) as { event_id?: number }).event_id) || null, now));
  if (m[2] === 'done' && req.method === 'POST') {
    const r = await finishSend(env.DB, id, (await req.json().catch(() => ({}))) as { state?: string; reason?: string; gmail_id?: string }, now, tz);
    if (r.ok && r.item) await reconcile(env.DB, tg, owner, now, tz, sleep);
    return json({ ok: r.ok }, r.ok ? 200 : 400);
  }
  return json({ error: 'not found' }, 404);
}
