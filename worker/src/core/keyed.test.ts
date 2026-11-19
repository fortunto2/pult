// Extension.keyed (a second credential for part of the API) and QueueHooks.seen / PullArgs.db.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from './app.ts';
import type { Env } from './env.ts';
import { enqueue } from './queue.ts';
import { makeDb } from './testkit.ts';

const seen: string[] = [];
const app = createApp({
  extensions: [{
    name: 'dev',
    keyed: async req => (req.headers.get('Authorization') === 'Bearer dev-key' && new URL(req.url).pathname === '/events/ping' ? Response.json({ ok: 'dev' }) : null),
    queue: { seen: async (_db, slot) => { seen.push(slot); }, filters: [{ slots: ['interactive'], where: async a => { const n = (await a.db.prepare('SELECT COUNT(*) n FROM events').first<{ n: number }>())!.n; return n > 1 ? "text <> 'hidden'" : ''; } }] },
  }],
});
const env = () => ({ CHAT_ID: '1', TELEGRAM_BOT_TOKEN: '1:x', TG_SECRET: 's', RUN_KEY: 'k', DB: makeDb() }) as unknown as Env;
const call = (e: Env, path: string, key: string, body: unknown = {}) => app.fetch(new Request(`https://w.test${path}`, { method: 'POST', body: JSON.stringify(body), headers: { Authorization: `Bearer ${key}` } }), e);

test('keyed answers its own credential; any other key still goes through the core check', async () => {
  const e = env();
  assert.deepEqual(await (await call(e, '/events/ping', 'dev-key')).json(), { ok: 'dev' });
  assert.equal((await call(e, '/events/pull', 'dev-key')).status, 403);
  assert.equal((await call(e, '/events/pull', 'k')).status, 200);
});

test('seen runs on every interactive pull before the pause, and a filter can query the db', async () => {
  const e = env(); seen.length = 0;
  await enqueue(e.DB, { user_id: 1, session_id: 's1', text: 'hidden', priority: 0 }, 1);
  await enqueue(e.DB, { user_id: 1, session_id: 's2', text: 'shown', priority: 0 }, 2);
  const r = await (await call(e, '/events/pull', 'k', { slot: 'interactive' })).json() as { event: { text: string } };
  assert.deepEqual(seen, ['interactive']);
  assert.equal(r.event.text, 'shown');
});
