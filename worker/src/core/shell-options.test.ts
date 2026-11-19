// createApp's shell options a private layer needs: ownerTz, withEnv, botInfo, cards, and commands that override a core command.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createApp } from './app.ts';
import { resetCards } from './cardconfig.ts';
import type { Env } from './env.ts';
import type { Extension } from './extension.ts';
import { validate } from './extension.ts';
import { makeDb } from './testkit.ts';
import { telegramStub } from './tgstub.ts';

const OWNER = 42, stub = await telegramStub();
after(() => { stub.close(); resetCards(); });
const seen: string[] = [];
const ext: Extension<{ MODE?: string }> = {
  name: 'shell',
  commands: [
    { name: 'status', description: 'my status', override: true, run: async c => { seen.push(`tz=${c.tz} mode=${c.env.MODE}`); await c.reply('mine'); } },
    { name: 'extra', description: 'plain', run: async c => c.reply('extra') },
  ],
};
const app = createApp<{ MODE?: string }>({
  extensions: [ext],
  ownerTz: async () => 'Asia/Tokyo',
  withEnv: async e => ({ ...e, MODE: 'overlaid' }),
  botInfo: { id: 1, is_bot: true, first_name: 'b', username: 'b_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never,
  cards: { glyphs: { mail: '✉' }, groups: { gmail: 'mail' } },
});
const env = (): Env & { MODE?: string } => ({ CHAT_ID: String(OWNER), TELEGRAM_BOT_TOKEN: '1:t', TG_SECRET: 's', RUN_KEY: 'k', DB: makeDb(), TELEGRAM_API_ROOT: stub.root });
const say = (e: Env, text: string) => app.fetch(new Request('https://w.test/tg', { method: 'POST', body: JSON.stringify({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, is_bot: false, first_name: 'o' }, text, entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] : [] } }), headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 's' } }), e);

test('an override command answers instead of the core one, with the resolved zone and the overlaid env; a plain command still works', async () => {
  const e = env(), before = stub.calls.length; seen.length = 0;
  await say(e, '/status');
  assert.deepEqual(seen, ['tz=Asia/Tokyo mode=overlaid']);
  const sent = stub.calls.slice(before).filter(c => c.method === 'sendMessage');
  assert.deepEqual(sent.map(c => c.body.text), ['mine']);
  await say(e, '/extra');
  assert.equal(stub.calls.at(-1)?.body.text, 'extra');
});

test('botInfo spares the getMe call', async () => {
  const before = stub.calls.length;
  await say(env(), '/extra');
  assert.equal(stub.calls.slice(before).some(c => c.method === 'getMe'), false);
});

test('cards option configures groups and glyphs', async () => {
  const { marker } = await import('./render.ts');
  const item = { kind: 'decision', id: 'gmail-abc-def', urgency: 'week', payload: null } as never;
  assert.equal(marker(item), '✉🟡');
});

test('override must name a core command and only once', () => {
  assert.throws(() => validate([{ name: 'aa', commands: [{ name: 'nope', description: 'x', override: true, run: async () => undefined }] }] as never), /not a core command/);
  assert.throws(() => validate([{ name: 'aa', commands: [{ name: 'status', description: 'x', override: true, run: async () => undefined }] }, { name: 'bb', commands: [{ name: 'status', description: 'x', override: true, run: async () => undefined }] }] as never), /already taken/);
});

test('/setup lists the override once and not the core entry it replaces', async () => {
  const before = stub.calls.length;
  await app.fetch(new Request('https://w.test/setup', { headers: { Authorization: 'Bearer k' } }), env());
  const menu = stub.calls.slice(before).find(c => c.method === 'setMyCommands')?.body.commands as { command: string; description: string }[];
  assert.deepEqual(menu.filter(c => c.command === 'status').map(c => c.description), ['my status']);
});
