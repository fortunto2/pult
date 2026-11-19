// Routes for the runner (RUN_KEY, or RUNNER_KEY when set): lease the queue, heartbeat, ack, read a session, say into a session, proxy a Telegram file.
import { mdToTg } from './mdtg.ts';
import { MAX_FILE } from './chat.ts';
import type { Env } from './env.ts';
import { beat, clearLiveSeen, depth, finish, getEvent, pull, recordLiveSeen, type QEvent } from './queue.ts';
import { reconcile } from './reconcile.ts';
import { applyAction, applyUnwork, getItem } from './store.ts';
import { clearKeyedMessage, keyedMessage, pausedUntil, setKeyedMessage, setPause } from './settings.ts';
import { clearTarget, getSession, liveSession, recordMsg, setClaudeId } from './sessions.ts';
import type { Tg } from './tg.ts';

const json = (o: unknown, status = 200) => Response.json(o, { status });
type Body = Record<string, unknown>;

export interface FileProxy { getFile(fileId: string): Promise<{ file_path?: string; file_size?: number }>; download(path: string): Promise<Response> }

const lease = (b: Record<string, unknown>) => (typeof b.lease_id === 'string' && b.lease_id ? b.lease_id : undefined);
export const isQueuePath = (p: string) => /^\/(events|sessions|files|pause)(\/|$)/.test(p);

export async function sessionsRoute(req: Request, u: URL, env: Env, deps: { tg: Tg; files: FileProxy; tz?: string; onAck?: (ev: QEvent, ack: { status: 'done' | 'failed' | 'stopped' | 'requeue'; body: Body }) => Promise<void> }, now = Date.now()): Promise<Response | null> {
  const p = u.pathname;
  if (!isQueuePath(p)) return null;
  const owner = Number(env.CHAT_ID), tz = deps.tz ?? 'UTC';
  const body = async (): Promise<Body> => (await req.json().catch(() => ({}))) as Body;

  if (req.method === 'POST' && p === '/events/pull') {
    const pb = await body();
    if (pb.slot === 'live') {   // the live terminal session's own door: its plain text only; the pull is its proof of life
      const sid = typeof pb.session === 'string' ? pb.session : '';
      const s = sid ? await getSession(env.DB, sid) : null;
      if (!s || s.user_id !== owner || s.workflow !== 'live') return json({ error: 'no such live session' }, 404);
      await recordLiveSeen(env.DB, s.id, now);
      return json({ event: await pull(env.DB, 'live', now, s.id), paused_until: null });   // delivery costs no model run, so the usage-limit pause does not hold it
    }
    const slot = pb.slot === 'background' ? 'background' : 'interactive';
    const paused = await pausedUntil(env.DB, now);
    // under the usage limit nothing is leased: messages wait in the queue and run after the reset
    return json({ event: paused ? null : await pull(env.DB, slot, now), paused_until: paused });
  }
  if (req.method === 'GET' && p === '/events/depth') return json({ ...(await depth(env.DB)), paused_until: await pausedUntil(env.DB, now) });
  let m = /^\/events\/(\d+)\/(beat|ack)$/.exec(p);
  if (req.method === 'POST' && m) {
    const id = Number(m[1]);
    if (m[2] === 'beat') return json(await beat(env.DB, id, lease(await body()), now));
    const b = await body();
    const status = b.status === 'failed' ? 'failed' : b.status === 'stopped' ? 'stopped' : b.status === 'requeue' ? 'requeue' : 'done';
    const ev = await getEvent(env.DB, id);
    const ok = await finish(env.DB, id, lease(b), status, now);
    // a card's job is over: ITEM-DONE closes the card, anything else puts it back on the owner's list
    if (ok && ev?.item_id && (b.item_result === 'done' || b.item_result === 'reopen')) {
      const item = await getItem(env.DB, ev.user_id, ev.item_id);
      if (item) {
        const changed = b.item_result === 'done' ? !!(await applyAction(env.DB, { ...item, actions: [...item.actions, 'done'] }, 'done', now, 'job', tz)) : await applyUnwork(env.DB, item, now, 'job');
        if (changed) await reconcile(env.DB, deps.tg, ev.user_id, now, tz);
      }
    }
    if (ok && ev && deps.onAck) await deps.onAck(ev, { status, body: b }).catch(e => console.error('onAck failed', e));   // an extension's follow-up never fails the ack
    return json({ ok });
  }
  m = /^\/sessions\/([^/]+)\/draft$/.exec(p);
  if (req.method === 'POST' && m) {   // streamed progress: sendMessageDraft. {ok:false, fallback:true} tells the runner to edit a message instead
    const s = await getSession(env.DB, m[1]);
    if (!s || s.user_id !== owner) return json({ error: 'no such session' }, 404);
    const b = await body();
    const draftId = Number(b.draft_id);
    if (!Number.isInteger(draftId) || draftId === 0) return json({ error: 'draft_id: non-zero integer' }, 400);
    if (env.PROGRESS_DRAFTS === '0' || !deps.tg.draft) return json({ ok: false, fallback: true });
    try { await deps.tg.draft(s.user_id, draftId, String(b.text ?? ''), b.can_stop !== false); return json({ ok: true }); }
    catch (e) { console.error('draft refused', String((e as Error).message ?? e).slice(0, 200)); return json({ ok: false, fallback: true }); }   // client or API without drafts, a rate limit, a group chat: the edit path carries on
  }
  if (req.method === 'POST' && p === '/pause') {
    const until = Number((await body()).until);
    if (!Number.isFinite(until) || until <= 0) return json({ error: 'until: epoch seconds' }, 400);
    await setPause(env.DB, until);
    return json({ ok: true });
  }
  if (req.method === 'POST' && p === '/sessions/live') {   // attach: create or reuse the live session, make it today's target, count as seen
    const s = await liveSession(env.DB, owner, String((await body()).title ?? ''), now, tz);
    await recordLiveSeen(env.DB, s.id, now);
    return json({ id: s.id, title: s.title, claude_session_id: s.claude_session_id });
  }
  m = /^\/sessions\/([^/]+)\/detach$/.exec(p);
  if (req.method === 'POST' && m) {   // the channel closes: pult-run takes plain messages again at once
    const s = await getSession(env.DB, m[1]);
    if (!s || s.user_id !== owner || s.workflow !== 'live') return json({ error: 'no such live session' }, 404);
    await clearLiveSeen(env.DB, s.id); await clearTarget(env.DB, owner, s.id);
    return json({ ok: true });
  }
  m = /^\/sessions\/([^/]+)$/.exec(p);
  if (req.method === 'GET' && m) { const s = await getSession(env.DB, m[1]); return s ? json(s) : json({ error: 'no such session' }, 404); }
  m = /^\/sessions\/([^/]+)\/claude$/.exec(p);
  if (req.method === 'POST' && m) {
    const b = await body();
    if (typeof b.claude_session_id !== 'string' || !b.claude_session_id) return json({ error: 'claude_session_id' }, 400);
    if (!(await getSession(env.DB, m[1]))) return json({ error: 'no such session' }, 404);
    await setClaudeId(env.DB, m[1], b.claude_session_id, typeof b.cwd === 'string' ? b.cwd : null);
    return json({ ok: true });
  }
  m = /^\/sessions\/([^/]+)\/say$/.exec(p);
  if (req.method === 'POST' && m) {
    const s = await getSession(env.DB, m[1]);
    if (!s) return json({ error: 'no such session' }, 404);
    const b = await body();
    const chat = s.user_id;   // a private chat's id is its user's id
    const text = String(b.text ?? '').slice(0, 4000);
    const key = typeof b.key === 'string' ? b.key : '';
    if (b.delete === true) {   // the progress message goes when the answer arrives
      const prev = key ? await keyedMessage(env.DB, key, now) : 0;
      if (prev) await deps.tg.delete(chat, prev).catch(() => undefined);
      if (key) await clearKeyedMessage(env.DB, key);
      return json({ ok: true });
    }
    if (!text) return json({ error: 'text' }, 400);
    const prev = key ? await keyedMessage(env.DB, key, now) : 0;
    // answers are Claude's Markdown -> Telegram HTML (bold, code, tables as bullets); progress lines (fmt:'plain') stay literal
    const md = b.fmt === 'plain' ? null : mdToTg(text);
    const rich = md && md.pm.length <= 4000 ? { text: md.text, pm: md.pm } : { text: md?.text ?? text };
    if (prev) {
      try { await deps.tg.edit(chat, prev, rich, undefined); return json({ message_id: prev, edited: true }); }
      catch (e) { if (/not modified/i.test(String(e))) return json({ message_id: prev, edited: false }); /* gone: send anew */ }
    }
    const replyTo = typeof b.reply_to === 'number' && b.reply_to < 2_000_000_000 ? b.reply_to : undefined;
    const silent = b.loud !== true;
    // a reply target Telegram no longer knows must not lose the answer: send it without the reply
    const id = await deps.tg.send(chat, rich, undefined, silent, replyTo).catch(e => { if (replyTo) return deps.tg.send(chat, rich, undefined, silent, undefined); throw e; });
    if (key) await setKeyedMessage(env.DB, key, id);
    await recordMsg(env.DB, s.user_id, id, s.id);
    return json({ message_id: id, edited: false });
  }
  m = /^\/files\/(.+)$/.exec(p);
  if (req.method === 'GET' && m) {
    const fileId = decodeURIComponent(m[1]), evId = Number(u.searchParams.get('event'));
    const ev = evId ? await getEvent(env.DB, evId) : null;
    // only a file of an event that is leased right now: the key alone does not open arbitrary Telegram files
    if (!ev || ev.status !== 'running' || !ev.files.some(f => f.file_id === fileId)) return json({ error: 'file is not in a running event' }, 403);
    const info = await deps.files.getFile(fileId);
    if (!info.file_path) return json({ error: 'telegram has no path for it' }, 404);
    if ((info.file_size ?? 0) > MAX_FILE) return json({ error: 'larger than 20 MB' }, 413);
    const r = await deps.files.download(info.file_path);
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/octet-stream', 'x-file-path': info.file_path } });
  }
  return json({ error: 'not found' }, 404);
}
