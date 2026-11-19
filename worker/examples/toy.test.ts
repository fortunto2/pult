// The worked example of docs/extending.md, end to end through the worker's front door: command, button, queue action, migration, route, Mini App panel.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createApp } from '../src/lib.ts';
import type { Env } from '../src/core/env.ts';
import { signHmac } from '../src/core/miniapp/initdata.ts';
import { makeDb } from '../src/core/testkit.ts';
import { telegramStub } from '../src/core/tgstub.ts';
import { toy, type ToyEnv } from './toy.ts';

const OWNER = 42, TOKEN = '123:test';
const stub = await telegramStub();
after(() => stub.close());
const app = createApp<ToyEnv>({ extensions: [toy] });
const env = (): Env & ToyEnv => ({ CHAT_ID: String(OWNER), TELEGRAM_BOT_TOKEN: TOKEN, TG_SECRET: 's', RUN_KEY: 'k', DB: makeDb(), TELEGRAM_API_ROOT: stub.root, TOY_GREETING: 'pong!' });
const hit = (e: Env & ToyEnv, path: string, init: RequestInit & { key?: string } = {}) =>
  app.fetch(new Request(`https://w.test${path}`, { ...init, headers: { ...(init.key ? { Authorization: `Bearer ${init.key}` } : {}), ...(init.headers ?? {}) } }), e);
const hook = (e: Env & ToyEnv, body: unknown) => hit(e, '/tg', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 's' } });
const msg = (text: string) => ({ update_id: Math.floor(Math.random() * 1e9), message: { message_id: 1, date: 1, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, is_bot: false, first_name: 'x' }, text, ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : {}) } });
const press = (data: string) => ({ update_id: Math.floor(Math.random() * 1e9), callback_query: { id: 'q1', from: { id: OWNER, is_bot: false, first_name: 'x' }, chat_instance: 'c', data, message: { message_id: 5, date: 1, chat: { id: OWNER, type: 'private' } } } });
const json = async (r: Response) => (await r.json()) as any;

test('the whole round trip: /ping answers with a button, the button queues an action, the ack reaches onAck', async () => {
  const e = env(), before = stub.calls.length;
  assert.equal((await hook(e, msg('/ping'))).status, 200);
  const sent = stub.calls.slice(before).find(c => c.method === 'sendMessage');
  assert.equal(sent?.body.text, 'pong!');
  assert.equal(sent?.body.reply_markup.inline_keyboard[0][0].callback_data, 'toy:mac');

  assert.equal((await hook(e, press('toy:mac'))).status, 200);
  const ev = await e.DB.prepare("SELECT id, action, priority FROM events WHERE action = 'ping'").first<{ id: number; action: string; priority: number }>();
  assert.deepEqual([ev?.action, ev?.priority], ['ping', 1]);

  const pulled = await json(await hit(e, '/events/pull', { method: 'POST', key: 'k', body: '{}' }));
  assert.equal(pulled.event.action, 'ping');
  await hit(e, `/events/${ev!.id}/ack`, { method: 'POST', key: 'k', body: JSON.stringify({ status: 'done', lease_id: pulled.event.lease_id }) });
  assert.equal((await e.DB.prepare('SELECT note FROM toy_pings').first<{ note: string }>())?.note, 'done', 'onAck ran with the ack status');
});

test('the extension route wants the key, the panel wants the owner\'s initData', async () => {
  const e = env();
  await hook(e, msg('/ping'));
  assert.equal((await hit(e, '/x/toy/count')).status, 403);
  assert.deepEqual(await json(await hit(e, '/x/toy/count', { key: 'k' })), { count: 1 });
  assert.equal((await hit(e, '/x/toy/nothing', { key: 'k' })).status, 404);

  const now = Math.floor(Date.now() / 1000);
  const mine = await signHmac({ auth_date: String(now), user: JSON.stringify({ id: OWNER }) }, TOKEN);
  const other = await signHmac({ auth_date: String(now), user: JSON.stringify({ id: 99 }) }, TOKEN);
  assert.equal((await hit(e, '/app/api/panel/pings')).status, 401);
  assert.equal((await hit(e, '/app/api/panel/pings', { headers: { Authorization: `tma ${other}` } })).status, 403);
  const me = await json(await hit(e, '/app/api/me', { headers: { Authorization: `tma ${mine}` } }));
  assert.deepEqual(me.panels, [{ id: 'pings', title: 'Pings' }]);
  const panel = await json(await hit(e, '/app/api/panel/pings', { headers: { Authorization: `tma ${mine}` } }));
  assert.equal(panel.data.rows[0].title, 'ping #1');
});

test('the migration ran after the core ones, once', async () => {
  const e = env();
  await hit(e, '/x/toy/count', { key: 'k' });
  const ids = (await e.DB.prepare('SELECT id FROM _migrations ORDER BY applied_at, rowid').all<{ id: string }>()).results.map(r => r.id);
  assert.deepEqual(ids, ['core:0001_init', 'toy:0001_pings']);
});
