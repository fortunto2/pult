import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createApp } from '../app.ts';
import type { Env } from '../env.ts';
import { makeDb } from '../testkit.ts';
import { telegramStub } from '../tgstub.ts';
import { signHmac } from './initdata.ts';
import { appAsset } from './assets.ts';

const OWNER = 42, TOKEN = '123:test';
const stub = await telegramStub();
after(() => stub.close());
const app = createApp();
const env = (): Env => ({ CHAT_ID: String(OWNER), TELEGRAM_BOT_TOKEN: TOKEN, TG_SECRET: 's', RUN_KEY: 'k', DB: makeDb(), TELEGRAM_API_ROOT: stub.root, OWNER_TZ: 'UTC' });
const init = (id = OWNER, age = 5) => signHmac({ auth_date: String(Math.floor(Date.now() / 1000) - age), user: JSON.stringify({ id }) }, TOKEN);
const call = async (e: Env, path: string, o: { who?: number; age?: number; method?: string; body?: unknown } = {}) =>
  app.fetch(new Request(`https://w.test/app/api/${path}`, { method: o.method ?? 'GET', body: o.body ? JSON.stringify(o.body) : undefined, headers: { Authorization: `tma ${await init(o.who, o.age)}` } }), e);
const item = (e: Env) => app.fetch(new Request('https://w.test/items', { method: 'POST', headers: { Authorization: 'Bearer k' }, body: JSON.stringify({ id: 'c1', title: 'Pay the invoice', kind: 'decision', urgency: 'today', body: 'details' }) }), e);

test('auth: no header 401, expired 401, a stranger 403, the owner 200', async () => {
  const e = env();
  assert.equal((await app.fetch(new Request('https://w.test/app/api/me'), e)).status, 401);
  assert.equal((await call(e, 'me', { age: 3700 })).status, 401);
  assert.equal((await call(e, 'me', { who: 99 })).status, 403);
  const r = await call(e, 'me');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { user_id: OWNER, via: 'hmac', write: false, start_param: null, panels: [] });
});

test('overview: open cards with their actions, sessions, queue depth, the pause and recent runs', async () => {
  const e = env();
  await item(e);
  await e.DB.prepare("INSERT INTO sessions (id, user_id, title, created_at, last_active) VALUES ('s1', ?, 'main', 1, 5)").bind(OWNER).run();
  await e.DB.prepare("INSERT INTO events (user_id, action, created_at, priority, session_id, text) VALUES (?, 'ask', 1, 0, 's1', 'hi')").bind(OWNER).run();
  await e.DB.prepare("INSERT INTO settings (key, value, at) VALUES ('pause:until', ?, 1)").bind(String(Math.floor(Date.now() / 1000) + 600)).run();
  const o = await (await call(e, 'overview')).json() as any;
  assert.equal(o.cards[0].title, 'Pay the invoice');
  assert.ok(o.cards[0].actions.some((a: any) => a.id === 'done'));
  assert.equal(o.sessions[0].id, 's1');
  assert.deepEqual([o.queue.queued.P0, o.queue.running], [1, 0]);
  assert.ok(o.queue.paused_until > 0);
  assert.equal(o.runs[0].action, 'ask');
});

test('write-back is off by default; /appwrite style switch in D1 turns it on; unknown actions stay refused', async () => {
  const e = env();
  await item(e);
  const short = ((await (await call(e, 'overview')).json()) as any).cards[0].short;
  const press = (action: string) => call(e, 'action', { method: 'POST', body: { short, action } });
  assert.equal((await press('done')).status, 403);
  await e.DB.prepare("INSERT INTO settings (key, value, at) VALUES ('app:write', '1', 1)").run();
  assert.equal((await press('rm_rf')).status, 400);
  assert.equal((await press('done')).status, 200);
  assert.equal((await press('done')).status, 409, 'a second press finds the card already handled');
  assert.equal(((await (await call(e, 'overview')).json()) as any).cards.length, 0);
});

test('the page is served without a key and carries no inline script', async () => {
  const html = await appAsset('/app/')!.text();
  assert.match(html, /telegram-web-app\.js/);
  assert.doesNotMatch(html.replace(/<script src="[^"]+"><\/script>/g, ''), /<script/, 'only src scripts, nothing inline');
  assert.equal(appAsset('/app/nothing'), null);
  assert.equal((await app.fetch(new Request('https://w.test/app/'), env())).status, 200);
});
