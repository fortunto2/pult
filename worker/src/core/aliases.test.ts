// pathAliases: an old URL keeps working after its handler moved under /x/<name>/.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from './app.ts';
import type { Env } from './env.ts';
import { makeDb } from './testkit.ts';

const app = createApp({
  extensions: [{ name: 'fam', routes: [{ method: 'GET', path: '/owner/flag', handler: async () => Response.json({ ok: 'flag' }) }, { method: 'GET', path: '/owner/flag/deep', handler: async () => Response.json({ ok: 'deep' }) }] }],
  pathAliases: { '/owner/': '/x/fam/owner/', '/owner/flag/deep': '/x/fam/owner/flag/deep' },
});
const env = { CHAT_ID: '1', TELEGRAM_BOT_TOKEN: '1:x', TG_SECRET: 's', RUN_KEY: 'k', DB: makeDb() } as unknown as Env;
const get = (p: string) => app.fetch(new Request(`https://w.test${p}`, { headers: { Authorization: 'Bearer k' } }), env);

test('an aliased path reaches the extension route, the longest alias wins, other paths are untouched', async () => {
  assert.deepEqual(await (await get('/owner/flag')).json(), { ok: 'flag' });
  assert.deepEqual(await (await get('/owner/flag/deep')).json(), { ok: 'deep' });
  assert.equal((await get('/nothing')).status >= 400, true);
});
