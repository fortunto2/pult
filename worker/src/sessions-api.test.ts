import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIncoming } from './api.ts';
import type { Env } from './env.ts';
import { enqueue, getEvent } from './queue.ts';
import { reconcile } from './reconcile.ts';
import { resolveSession } from './sessions.ts';
import { sessionsRoute } from './sessions-api.ts';
import { getItem, upsertItem } from './store.ts';
import { fakeTg, makeDb, noSleep } from './testkit.ts';

const OWNER = 42, T = Date.UTC(2026, 0, 5, 12, 0);
function rig() {
  const db = makeDb(), tg = fakeTg(), env = { DB: db, CHAT_ID: String(OWNER) } as unknown as Env;
  const downloads: string[] = [];
  const files = { getFile: async (id: string) => ({ file_path: `docs/${id}`, file_size: id === 'huge' ? 30_000_000 : 5 }), download: async (p: string) => { downloads.push(p); return new Response('bytes'); } };
  const call = async (method: string, path: string, body?: unknown, now = T) => {
    const r = await sessionsRoute(new Request(`https://w.test${path}`, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) }), new URL(`https://w.test${path}`), env, { tg, files, tz: 'UTC' }, now);
    const text = await r!.text();
    return { status: r!.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
  };
  return { db, tg, call, downloads };
}

test('pull -> beat -> ack over HTTP; the lease id is the proof', async () => {
  const { db, call } = rig();
  const { session } = await resolveSession(db, OWNER, {}, T, 'UTC');
  await enqueue(db, { user_id: OWNER, session_id: session.id, text: 'hello', priority: 0 }, T);
  const pulled = (await call('POST', '/events/pull', { slot: 'interactive' })).json.event;
  assert.equal(pulled.text, 'hello');
  assert.equal((await call('POST', `/events/${pulled.id}/beat`, { lease_id: 'forged' })).json.ok, false);
  assert.deepEqual((await call('POST', `/events/${pulled.id}/beat`, { lease_id: pulled.lease_id })).json, { ok: true, stop: false });
  assert.equal((await call('POST', `/events/${pulled.id}/ack`, { status: 'done' })).json.ok, false, 'no token, no ack');
  assert.equal((await call('POST', `/events/${pulled.id}/ack`, { status: 'done', lease_id: pulled.lease_id })).json.ok, true);
  assert.equal((await call('GET', '/events/depth')).json.running, 0);
});

test('the usage-limit pause: nothing is leased until it passes, and the pull says until when', async () => {
  const { db, call } = rig();
  await enqueue(db, { user_id: OWNER, session_id: 's', text: 'x', priority: 0 }, T);
  assert.equal((await call('POST', '/pause', { until: 'soon' })).status, 400);
  await call('POST', '/pause', { until: Math.floor(T / 1000) + 600 });
  const r = (await call('POST', '/events/pull', { slot: 'interactive' })).json;
  assert.equal(r.event, null);
  assert.equal(r.paused_until, Math.floor(T / 1000) + 600);
  assert.ok((await call('POST', '/events/pull', { slot: 'interactive' }, T + 601_000)).json.event);
});

test('say: Markdown becomes Telegram HTML, a key edits the same message in place, delete removes it', async () => {
  const { db, tg, call } = rig();
  const { session } = await resolveSession(db, OWNER, {}, T, 'UTC');
  const a = (await call('POST', `/sessions/${session.id}/say`, { text: '## Plan\n**bold** and `code`', key: 'prog:1', reply_to: 9 })).json;
  assert.equal(a.edited, false);
  const sent = tg.calls.find(c => c.op === 'send')!;
  assert.equal(sent.pm, '<b>Plan</b>\n<b>bold</b> and <code>code</code>');
  assert.equal(sent.silent, true);
  assert.equal(sent.replyTo, 9);
  const b = (await call('POST', `/sessions/${session.id}/say`, { text: 'second', key: 'prog:1' })).json;
  assert.deepEqual([b.message_id, b.edited], [a.message_id, true]);
  assert.equal(tg.calls.at(-1)!.op, 'edit');
  await call('POST', `/sessions/${session.id}/say`, { delete: true, key: 'prog:1' });
  assert.deepEqual(tg.calls.at(-1), { op: 'delete', chat: OWNER, id: a.message_id });
  const c = (await call('POST', `/sessions/${session.id}/say`, { text: 'third', key: 'prog:1' })).json;
  assert.notEqual(c.message_id, a.message_id, 'after delete the key starts a new message');
  assert.equal((await call('POST', `/sessions/${session.id}/say`, { text: '' })).status, 400);
  assert.equal((await call('POST', '/sessions/nope/say', { text: 'x' })).status, 404);
});

test('say with fmt plain leaves progress lines literal; loud rings', async () => {
  const { db, tg, call } = rig();
  const { session } = await resolveSession(db, OWNER, {}, T, 'UTC');
  await call('POST', `/sessions/${session.id}/say`, { text: 'reading **file**', fmt: 'plain', loud: true });
  const sent = tg.calls.find(c => c.op === 'send')!;
  assert.equal(sent.pm, undefined);
  assert.equal(sent.plain, 'reading **file**');
  assert.equal(sent.silent, false);
});

test('a reply target Telegram no longer knows must not lose the answer', async () => {
  const { db, tg, call } = rig();
  const { session } = await resolveSession(db, OWNER, {}, T, 'UTC');
  tg.failNext('Bad Request: message to reply not found');
  const r = (await call('POST', `/sessions/${session.id}/say`, { text: 'still here', reply_to: 5 })).json;
  assert.ok(r.message_id);
  assert.equal(tg.calls.find(c => c.op === 'send')!.replyTo, undefined);
});

test('files are proxied only for a file of an event that is leased right now; over 20 MB is a 413', async () => {
  const { db, call, downloads } = rig();
  await enqueue(db, { user_id: OWNER, session_id: 's', text: '', files: [{ file_id: 'abc', kind: 'document' }, { file_id: 'huge', kind: 'document' }], priority: 0 }, T);
  assert.equal((await call('GET', '/files/abc?event=1')).status, 403, 'queued is not leased');
  const ev = (await call('POST', '/events/pull', { slot: 'interactive' })).json.event;
  assert.equal((await call('GET', '/files/other?event=1')).status, 403, 'a file that is not in the event');
  assert.equal((await call('GET', '/files/abc')).status, 403, 'no event');
  const ok = await call('GET', `/files/abc?event=${ev.id}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.text, 'bytes');
  assert.deepEqual(downloads, ['docs/abc']);
  assert.equal((await call('GET', `/files/huge?event=${ev.id}`)).status, 413);
});

test('live channel: attach makes today\'s target, the live pull delivers plain text, detach hands the chat back', async () => {
  const { db, call } = rig();
  const live = (await call('POST', '/sessions/live', { title: 'terminal' })).json;
  assert.equal((await resolveSession(db, OWNER, {}, T, 'UTC')).session.id, live.id);
  await enqueue(db, { user_id: OWNER, session_id: live.id, text: 'from the phone', priority: 0 }, T + 1);
  assert.equal((await call('POST', '/events/pull', { slot: 'interactive' }, T + 2)).json.event, null, 'the runner leaves it alone while attached');
  const e = (await call('POST', '/events/pull', { slot: 'live', session: live.id }, T + 3)).json.event;
  assert.equal(e.text, 'from the phone');
  assert.equal((await call('POST', '/events/pull', { slot: 'live', session: 'nope' })).status, 404);
  await call('POST', `/events/${e.id}/ack`, { status: 'done', lease_id: e.lease_id });
  await call('POST', `/sessions/${live.id}/detach`, {});
  assert.notEqual((await resolveSession(db, OWNER, {}, T + 4, 'UTC')).session.id, live.id);
  await enqueue(db, { user_id: OWNER, session_id: live.id, text: 'after detach', priority: 0 }, T + 5);
  assert.equal((await call('POST', '/events/pull', { slot: 'interactive' }, T + 6)).json.event.text, 'after detach', 'plain text is the runner\'s again at once');
  assert.equal((await call('POST', '/sessions/other/detach', {})).status, 404);
});

test('claude session id is stored once the runner knows it', async () => {
  const { db, call } = rig();
  const { session } = await resolveSession(db, OWNER, {}, T, 'UTC');
  assert.equal((await call('POST', `/sessions/${session.id}/claude`, {})).status, 400);
  await call('POST', `/sessions/${session.id}/claude`, { claude_session_id: 'abc-123', cwd: '/work' });
  const s = (await call('GET', `/sessions/${session.id}`)).json;
  assert.deepEqual([s.claude_session_id, s.cwd], ['abc-123', '/work']);
});

test('ack with item_result: done closes the card, reopen puts a working card back on the list', async () => {
  const { db, tg, call } = rig();
  for (const id of ['c:1', 'c:2']) await upsertItem(db, OWNER, await parseIncoming({ id, title: id }, OWNER) as never, T);
  await reconcile(db, tg, OWNER, T, 'UTC', noSleep);
  const { session } = await resolveSession(db, OWNER, {}, T, 'UTC');
  await db.prepare("UPDATE items SET state = 'snoozed', working = 'x', snooze_until = ? WHERE id = 'c:2'").bind(T + 1e9).run();
  for (const [id, result] of [['c:1', 'done'], ['c:2', 'reopen']]) {
    await enqueue(db, { user_id: OWNER, session_id: session.id, text: 'job', priority: 1, item_id: id, action: 'c1' }, T);
    const ev = (await call('POST', '/events/pull', { slot: 'interactive' })).json.event;
    assert.equal(ev.item_id, id);
    await call('POST', `/events/${ev.id}/ack`, { status: 'done', lease_id: ev.lease_id, item_result: result });
    assert.equal((await getEvent(db, ev.id))!.status, 'done');
  }
  assert.equal((await getItem(db, OWNER, 'c:1'))!.state, 'done');
  assert.equal((await getItem(db, OWNER, 'c:2'))!.state, 'new');
});
