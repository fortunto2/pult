// The front-end hooks a private layer relies on: fence, ownerMessage, outsiders for callbacks and groups, tma_user routes, replyKeyboard, menu, RICH, hourlyCron, appAssets.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createApp } from './app.ts';
import type { Env } from './env.ts';
import type { Extension } from './extension.ts';
import { signHmac } from './miniapp/initdata.ts';
import { makeDb } from './testkit.ts';
import { telegramStub } from './tgstub.ts';

const OWNER = 42, OTHER = 77, TOKEN = '123:test';
const stub = await telegramStub();
after(() => stub.close());
interface KvEnv { BEATS: { get(k: string): Promise<string | null> } }   // an extension's own binding, typed through X
const log: string[] = [];
const ext: Extension<KvEnv> = {
  name: 'front',
  fence: (_c, u) => !!(u as { business_message?: unknown }).business_message,
  ownerMessage: async c => { log.push(`om:${c.text}`); if (c.text === '📊 Status') { await c.reply('kb tap', { replyTo: null }); return true; } if (c.text.startsWith('claim ')) { await c.react('👀'); return true; } return false; },
  outsiders: async (_c, u) => { log.push(`out:${u.callback_query ? 'cb' : u.message?.chat.type}:${u.callback_query?.data ?? u.message?.text}`); return true; },
  routes: [{ method: 'POST', path: '/who', auth: 'tma_user', handler: async (_r, c) => Response.json({ user: c.user?.id }) }, { method: 'POST', path: '/own', auth: 'tma', handler: async (_r, c) => Response.json({ user: c.user?.id }) }],
  scheduled: async (_c, ev) => { log.push(`sched:${ev.cron}`); },
};
const app = createApp<KvEnv>({
  extensions: [ext], replyKeyboard: [['📊 Status', '/open']], hourlyCron: '0 * * * *',
  menu: (core, e) => [...core.filter(c => c.command === 'status'), ...e, { command: 'menuonly', description: 'only in the menu' }],
  appAssets: p => (p === '/app/private.js' ? new Response('own page') : null),
});
const env = (o: Partial<Env> = {}): Env & KvEnv => ({ CHAT_ID: String(OWNER), TELEGRAM_BOT_TOKEN: TOKEN, TG_SECRET: 's', RUN_KEY: 'k', DB: makeDb(), TELEGRAM_API_ROOT: stub.root, BEATS: { get: async () => null }, ...o });
const hit = (e: Env & KvEnv, path: string, init: RequestInit & { key?: string } = {}) => app.fetch(new Request(`https://w.test${path}`, { ...init, headers: { ...(init.key ? { Authorization: `Bearer ${init.key}` } : {}), ...(init.headers ?? {}) } }), e);
const hook = (e: Env & KvEnv, body: unknown) => hit(e, '/tg', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 's' } });
const msg = (text: string, from = OWNER, type = 'private', chat = from) => ({ update_id: Math.floor(Math.random() * 1e9), message: { message_id: 1, date: 1, chat: { id: chat, type }, from: { id: from, is_bot: false, first_name: 'x' }, text, ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : {}) } });
const events = async (e: Env) => (await e.DB.prepare('SELECT COUNT(*) n FROM events').first<{ n: number }>())!.n;

test('ownerMessage: true stops the message before it becomes a turn, false lets the core queue it', async () => {
  const e = env(); log.length = 0;
  await hook(e, msg('claim https://example.com/x'));
  assert.equal(await events(e), 0);
  await hook(e, msg('plain question'));
  assert.equal(await events(e), 1);
  assert.deepEqual(log.filter(x => x.startsWith('om:')), ['om:claim https://example.com/x', 'om:plain question']);
});

test('fence drops an update before the gate, outsiders and ownerMessage never see it', async () => {
  const e = env(); log.length = 0;
  await hook(e, { update_id: 5, business_message: { message_id: 1, date: 1, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, is_bot: false, first_name: 'x' }, text: 'hi' } });
  await hook(e, { update_id: 6, message: { message_id: 1, date: 1, chat: { id: OTHER, type: 'private' }, from: { id: OTHER, is_bot: false, first_name: 'x' }, text: 'hi' } });
  assert.deepEqual(log.filter(x => !x.startsWith('sched')), ['out:private:hi']);
  assert.equal(await events(e), 0);
});

test('outsiders sees a stranger\'s callback press and a message in a group', async () => {
  const e = env(); log.length = 0;
  await hook(e, { update_id: 7, callback_query: { id: 'q', from: { id: OTHER, is_bot: false, first_name: 'x' }, chat_instance: 'c', data: 'kd:3', message: { message_id: 5, date: 1, chat: { id: OTHER, type: 'private' } } } });
  await hook(e, msg('hello group', OTHER, 'group', -100));
  await hook(e, msg('owner in a group', OWNER, 'group', -100));
  assert.deepEqual(log, ['out:cb:kd:3', 'out:group:hello group', 'out:group:owner in a group']);
});

test('replyKeyboard rides on /start, and its button text reaches ownerMessage', async () => {
  const e = env(), before = stub.calls.length; log.length = 0;
  await hook(e, msg('/start'));
  const sent = stub.calls.slice(before).find(c => c.method === 'sendMessage');
  assert.deepEqual(sent?.body.reply_markup, { keyboard: [[{ text: '📊 Status' }, { text: '/open' }]], resize_keyboard: true, is_persistent: true });
  await hook(e, msg('📊 Status'));
  assert.equal(stub.calls.at(-1)?.body.text, 'kb tap');
});

test('/setup registers the menu the layer chose', async () => {
  const e = env(), before = stub.calls.length;
  await hit(e, '/setup', { key: 'k' });
  const set = stub.calls.slice(before).find(c => c.method === 'setMyCommands');
  assert.deepEqual(set?.body.commands.map((c: { command: string }) => c.command), ['status', 'menuonly']);
});

test('RICH=0 sends the plain twin of a rich message', async () => {
  for (const [rich, want] of [['0', 'plain twin'], [undefined, 'rich']] as const) {
    const e = env({ RICH: rich }), before = stub.calls.length;
    const { grammyTg } = await import('./tg.ts');
    const { Api } = await import('grammy');
    await grammyTg(new Api(TOKEN, { apiRoot: stub.root }), e.RICH !== '0').send(OWNER, { text: 'plain twin', pm: '<b>rich</b>' }, undefined, false);
    const c = stub.calls.slice(before).find(x => x.method === 'sendMessage')!;
    assert.equal(c.body.parse_mode ? 'rich' : 'plain twin', want);
  }
});

test('hourlyCron: the sweep runs only on its own trigger, the extension on every one', async () => {
  const e = env(); log.length = 0;
  await e.DB.prepare("INSERT INTO items (user_id, id, short, kind, urgency, state, first_seen, last_seen, snooze_until, title, body, actions, hash) VALUES (?, 'a', 'abcdef0123', 'decision', 'today', 'snoozed', 1, 1, 2, 't', '', '[\"done\"]', 'h')").bind(OWNER).run().catch(() => undefined);
  const state = async () => (await e.DB.prepare("SELECT state FROM items WHERE id = 'a'").first<{ state: string }>())?.state;
  const run = async (cron: string) => { const waits: Promise<unknown>[] = []; await app.scheduled({ cron } as ScheduledController, e, { waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as ExecutionContext); await Promise.all(waits); };
  await run('*/5 * * * *');
  assert.equal(await state(), 'snoozed', 'the five-minute trigger does not sweep');
  await run('0 * * * *');
  assert.notEqual(await state(), 'snoozed', 'the hourly trigger wakes it');
  assert.deepEqual(log, ['sched:*/5 * * * *', 'sched:0 * * * *']);
});

test('tma_user routes take any Telegram user\'s initData, tma stays owner-only', async () => {
  const e = env();
  const initFor = (id: number) => signHmac({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: 'x' }) }, TOKEN);
  const call = async (path: string, id: number) => hit(e, `/x/front${path}`, { method: 'POST', headers: { Authorization: `tma ${await initFor(id)}` } });
  assert.deepEqual(await (await call('/who', OTHER)).json(), { user: OTHER });
  assert.equal((await call('/own', OTHER)).status, 403);
  assert.deepEqual(await (await call('/own', OWNER)).json(), { user: OWNER });
  assert.equal((await hit(e, '/x/front/who', { method: 'POST' })).status, 401);
});

test('appAssets serves a private Mini App page and falls through otherwise', async () => {
  const e = env();
  assert.equal(await (await hit(e, '/app/private.js')).text(), 'own page');
  assert.equal((await hit(e, '/app/')).status, 200);
});
