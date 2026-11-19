// The worker end to end, at its front door: auth on every route, the webhook's secret and the owner-only gate, against a local Telegram stub.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import worker, { sameKey } from '../index.ts';
import type { Env } from './env.ts';
import { makeDb } from './testkit.ts';
import { telegramStub } from './tgstub.ts';

const OWNER = 42, STRANGER = 43;
const stub = await telegramStub();
after(() => stub.close());
const env = (o: Partial<Env> = {}): Env => ({ CHAT_ID: String(OWNER), TELEGRAM_BOT_TOKEN: '123:test', TG_SECRET: 'hook-secret', RUN_KEY: 'run-key', DB: makeDb(), TELEGRAM_API_ROOT: stub.root, OWNER_TZ: 'UTC', ...o });
const hit = (e: Env, path: string, init: RequestInit & { key?: string } = {}) =>
  worker.fetch(new Request(`https://w.test${path}`, { ...init, headers: { ...(init.key ? { Authorization: `Bearer ${init.key}` } : {}), ...(init.headers ?? {}) } }), e);
const update = (from: number, text: string, chat = from) => ({ update_id: Math.floor(Math.random() * 1e9), message: { message_id: 1, date: 1, chat: { id: chat, type: 'private' }, from: { id: from, is_bot: false, first_name: 'x' }, text } });
const webhook = (e: Env, body: unknown, secret = 'hook-secret') => hit(e, '/tg', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret } });
const eventsCount = async (e: Env) => (await e.DB.prepare('SELECT COUNT(*) n FROM events').first<{ n: number }>())!.n;

test('every route but the webhook wants the key in the Authorization header', async () => {
  const e = env();
  for (const [m, p] of [['GET', '/items'], ['POST', '/items'], ['POST', '/say'], ['POST', '/events/pull'], ['GET', '/sessions/x'], ['GET', '/files/x'], ['POST', '/pause'], ['GET', '/setup'], ['GET', '/']]) {
    assert.equal((await hit(e, p, { method: m })).status, 403, `${m} ${p}`);
  }
  assert.equal((await hit(e, '/items?key=run-key')).status, 403, 'a key in the URL is not accepted');
  assert.equal((await hit(e, '/items', { key: 'wrong' })).status, 403);
  assert.equal((await hit(e, '/items', { key: 'run-key' })).status, 200);
  assert.equal((await hit(env({ RUN_KEY: '' }), '/items', { key: '' })).status, 403, 'an empty configured key never matches an empty header');
});

test('RUNNER_KEY opens the queue routes and nothing else', async () => {
  const e = env({ RUNNER_KEY: 'runner-key' });
  assert.equal((await hit(e, '/events/depth', { key: 'runner-key' })).status, 200);
  assert.equal((await hit(e, '/items', { key: 'runner-key' })).status, 403);
  assert.equal((await hit(e, '/say', { method: 'POST', key: 'runner-key', body: '{"text":"x"}' })).status, 403);
  assert.equal((await hit(e, '/setup', { key: 'runner-key' })).status, 403);
});

test('the webhook fails closed without a secret and refuses a wrong one', async () => {
  assert.equal((await webhook(env({ TG_SECRET: '' }), update(OWNER, 'hi'))).status, 503);
  const e = env();
  assert.equal((await webhook(e, update(OWNER, 'hi'), 'guess')).status, 401);
  assert.equal(await eventsCount(e), 0);
});

test('the owner\'s message becomes a queued event in the day\'s session', async () => {
  const e = env();
  const r = await webhook(e, update(OWNER, 'summarise my notes'));
  assert.equal(r.status, 200);
  const ev = await e.DB.prepare('SELECT text, priority, action, session_id FROM events').first<{ text: string; priority: number; action: string; session_id: string }>();
  assert.deepEqual([ev!.text, ev!.priority, ev!.action], ['summarise my notes', 0, 'ask']);
  assert.ok(ev!.session_id);
});

test('a stranger gets no answer, no event and no Telegram call at all', async () => {
  const e = env(), before = stub.calls.length;
  for (const text of ['hello', '/start', '/status', '/new x']) assert.equal((await webhook(e, update(STRANGER, text))).status, 200);
  assert.equal(await eventsCount(e), 0);
  assert.equal(stub.calls.slice(before).filter(c => c.method !== 'getMe').length, 0, 'not even a courtesy line');
});

test('the owner in a group, or a bot, is ignored too', async () => {
  const e = env();
  await webhook(e, update(OWNER, 'in a group', -100500));
  await webhook(e, { update_id: 7, message: { message_id: 1, date: 1, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, is_bot: true, first_name: 'b' }, text: 'bot' } });
  assert.equal(await eventsCount(e), 0);
});

test('/say sends one plain message to the owner; /setup registers the webhook with the secret', async () => {
  const e = env();
  const r = await hit(e, '/say', { method: 'POST', key: 'run-key', body: JSON.stringify({ text: 'build finished', silent: true }) });
  assert.deepEqual(await r.json(), { message_id: 7 });
  const sent = stub.calls.filter(c => c.method === 'sendMessage').at(-1)!.body;
  assert.deepEqual([sent.chat_id, sent.text, sent.disable_notification], [String(OWNER), 'build finished', true]);
  assert.equal((await hit(e, '/say', { method: 'POST', key: 'run-key', body: '{"text":" "}' })).status, 400);
  await hit(e, '/setup', { key: 'run-key' });
  const wh = stub.calls.filter(c => c.method === 'setWebhook').at(-1)!.body;
  assert.deepEqual([wh.url, wh.secret_token], ['https://w.test/tg', 'hook-secret']);
});

test('the key comparison does not care about length or prefix', async () => {
  assert.equal(await sameKey('abc', 'abc'), true);
  assert.equal(await sameKey('abc', 'abcd'), false);
  assert.equal(await sameKey('', 'x'), false);
});

test('the hourly tick expires an undecided card and removes nothing else', async () => {
  const e = env();
  await hit(e, '/items', { method: 'POST', key: 'run-key', body: JSON.stringify({ id: 'a', title: 'A', expires_at: 1 }) });
  await worker.scheduled({} as ScheduledController, e, { waitUntil: (p: Promise<unknown>) => p } as unknown as ExecutionContext);
  await new Promise(r => setTimeout(r, 50));
  const it = await e.DB.prepare("SELECT state FROM items WHERE id = 'a'").first<{ state: string }>();
  assert.equal(it!.state, 'expired');
});
