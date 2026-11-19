// Streamed progress (sendMessageDraft), its stop button (stopped_message_generation) and the button styling.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createApp } from './app.ts';
import { stopDraft } from './chat.ts';
import type { Env } from './env.ts';
import { enqueue } from './queue.ts';
import { keyboard, workingKeyboard } from './render.ts';
import { makeDb } from './testkit.ts';
import { telegramStub } from './tgstub.ts';
import type { Item } from './contract.ts';

const OWNER = 42;
const stub = await telegramStub();
after(() => stub.close());
const app = createApp();
const env = (o: Partial<Env> = {}): Env => ({ CHAT_ID: String(OWNER), TELEGRAM_BOT_TOKEN: '123:test', TG_SECRET: 's', RUN_KEY: 'k', DB: makeDb(), TELEGRAM_API_ROOT: stub.root, ...o });
const hit = (e: Env, path: string, body?: unknown) => app.fetch(new Request(`https://w.test${path}`, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, headers: { Authorization: 'Bearer k', 'content-type': 'application/json' } }), e);
const session = (e: Env) => e.DB.prepare("INSERT INTO sessions (id, user_id, title, created_at, last_active) VALUES ('s1', ?, 't', 1, 1)").bind(OWNER).run();

test('/sessions/:id/draft calls sendMessageDraft with the event id as draft_id and the stop button on', async () => {
  const e = env(); await session(e);
  const before = stub.calls.length;
  const r = await hit(e, '/sessions/s1/draft', { draft_id: 17, text: 'reading files' });
  assert.deepEqual(await r.json(), { ok: true });
  const c = stub.calls.slice(before).find(x => x.method === 'sendMessageDraft');
  assert.deepEqual([c?.body.chat_id, c?.body.draft_id, c?.body.text, c?.body.can_stop], [OWNER, 17, 'reading files', true]);
  await hit(e, '/sessions/s1/draft', { draft_id: 17, text: '' });
  assert.equal(stub.calls.at(-1)?.body.text, '', 'empty text is the "Thinking..." placeholder');
});

test('the draft route falls back instead of failing: flag off, Telegram refusing, a bad id', async () => {
  const e = env({ PROGRESS_DRAFTS: '0' }); await session(e);
  assert.deepEqual(await (await hit(e, '/sessions/s1/draft', { draft_id: 1, text: 'x' })).json(), { ok: false, fallback: true });
  const down = env({ TELEGRAM_API_ROOT: 'http://127.0.0.1:1' }); await session(down);
  assert.deepEqual(await (await hit(down, '/sessions/s1/draft', { draft_id: 1, text: 'x' })).json(), { ok: false, fallback: true });
  assert.equal((await hit(e, '/sessions/s1/draft', { draft_id: 0, text: 'x' })).status, 400);
  assert.equal((await hit(e, '/sessions/nope/draft', { draft_id: 1 })).status, 404);
});

test('stopped_message_generation stops exactly the turn whose event id was the draft id, from the owner\'s chat only', async () => {
  const e = env(); await session(e);
  const id = await enqueue(e.DB, { user_id: OWNER, session_id: 's1', text: 'long job', priority: 0 }, 1);
  await e.DB.prepare("UPDATE events SET status = 'running', lease_id = 'L' WHERE id = ?").bind(id).run();
  const upd = (chat: number) => app.fetch(new Request('https://w.test/tg', { method: 'POST', body: JSON.stringify({ update_id: 9, stopped_message_generation: { chat: { id: chat, type: 'private' }, draft_id: id } }), headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 's' } }), e);
  assert.equal((await upd(99)).status, 200);
  assert.equal((await e.DB.prepare('SELECT stop_requested s FROM events WHERE id = ?').bind(id).first<{ s: number }>())?.s, 0, 'a stranger\'s chat is ignored');
  assert.equal((await upd(OWNER)).status, 200);
  assert.equal((await e.DB.prepare('SELECT stop_requested s FROM events WHERE id = ?').bind(id).first<{ s: number }>())?.s, 1);
  const beat = await (await hit(e, `/events/${id}/beat`, { lease_id: 'L' })).json() as any;
  assert.equal(beat.stop, true, 'the runner sees it on the next heartbeat, as with /stop');
});

test('an unknown draft id falls back to /stop semantics', async () => {
  const e = env(); await session(e);
  assert.match(await stopDraft(e, OWNER, 999, Date.now(), 'UTC'), /Nothing is running|Stopping/);
});

const item = (o: Partial<Item> = {}): Item => ({ user_id: 1, id: 'c', short: 'abcdef0123', kind: 'decision', urgency: 'today', state: 'new', first_seen: 0, last_seen: 0, shown_at: null, snooze_until: null, expires_at: null, closed_at: null, source: null,
  title: 't', body: '', actions: ['done', 'snooze_1h', 'drop'], payload: null, hash: 'h', tg_message_id: null, msg_state: 'none', rendered_hash: null, loud: false, working: null, custom: [], ...o });

test('button styles: done green, not needed red, later default; copy_text for a command', () => {
  const rows = keyboard(item({ kind: 'decision', payload: { copy: 'make deploy' } })).inline_keyboard.flat() as any[];
  assert.equal(rows.find(b => /Done/.test(b.text)).style, 'success');
  assert.equal(rows.find(b => /Not needed/.test(b.text)).style, 'danger');
  assert.equal(rows.find(b => /Later|hour/i.test(b.text)).style, undefined);
  assert.deepEqual(rows.find(b => b.copy_text).copy_text, { text: 'make deploy' });
});

test('while a custom action runs its button is shown greyed out, and Done and Later stay', () => {
  const custom = [{ id: 'c1', label: 'Draft reply', instruction: 'draft a reply' }];
  const k = workingKeyboard(item({ custom, working: 'draft a reply', state: 'snoozed' })).inline_keyboard;
  assert.deepEqual(k.at(-1), [{ text: '⏳ Draft reply', disabled: {} }]);
  assert.ok(k.flat().some((b: any) => b.callback_data?.endsWith(':done')));
});
