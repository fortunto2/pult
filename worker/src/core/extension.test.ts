import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createApp } from './app.ts';
import { CORE_MIGRATIONS, migrate } from './migrations.ts';
import { makeDb } from './testkit.ts';
import type { Extension } from './extension.ts';

const bad = (e: Extension<object>[], re: RegExp) => assert.throws(() => createApp({ extensions: e }), re);
const noop = async () => undefined;

test('createApp refuses anything that would collide or escape its namespace, before serving a request', () => {
  bad([{ name: 'Bad' }], /extension name/);
  bad([{ name: 'a_b' }, { name: 'a_b' }], /already taken/);
  bad([{ name: 'x1', migrations: [{ id: 'other:0001', sql: 'SELECT 1' }] }], /must start with "x1:"/);
  bad([{ name: 'x1', commands: [{ name: 'status', description: 'd', run: noop }] }], /command "status" is already taken/);
  bad([{ name: 'x1', commands: [{ name: 'Up', description: 'd', run: noop }] }], /is not/);
  bad([{ name: 'x1', callbacks: [{ prefix: 'v1:', run: noop }] }], /overlaps|must look/);
  bad([{ name: 'x1', callbacks: [{ prefix: 'sw:', run: noop }] }], /overlaps/);
  bad([{ name: 'x1', callbacks: [{ prefix: 'ab:', run: noop }] }, { name: 'x2', callbacks: [{ prefix: 'ab:', run: noop }] }], /overlaps/);
  bad([{ name: 'x1', queueActions: { ask: {} } }], /queue action "ask" is already taken/);
  bad([{ name: 'x1', queueActions: { 'Bad-Name': {} } }], /queue action/);
  bad([{ name: 'x1', routes: [{ method: 'GET', path: 'no-slash', handler: async () => new Response() }] }], /must start with \//);
  assert.doesNotThrow(() => createApp({ extensions: [{ name: 'ok1', commands: [{ name: 'hello', description: 'd', run: noop }], callbacks: [{ prefix: 'ok1:', run: noop }] }] }));
});

test('migrations: applied once, in order, core first; a failing one throws and is not recorded; a second run changes nothing', async () => {
  const db = makeDb();
  const ext = [{ id: 'x1:0001', sql: 'CREATE TABLE x1_a (n INTEGER)' }, { id: 'x1:0002', sql: ['ALTER TABLE x1_a ADD COLUMN m TEXT', 'INSERT INTO x1_a (n, m) VALUES (1, \'a\')'] }];
  assert.deepEqual(await migrate(db, [...CORE_MIGRATIONS, ...ext]), [...CORE_MIGRATIONS.map(m => m.id), 'x1:0001', 'x1:0002']);
  assert.deepEqual(await migrate(db, [...CORE_MIGRATIONS, ...ext]), []);
  await assert.rejects(migrate(db, [{ id: 'x1:0003', sql: ['CREATE TABLE x1_b (n INTEGER)', 'THIS IS NOT SQL'] }]), /migration x1:0003 failed/);
  assert.equal(await db.prepare("SELECT name FROM sqlite_master WHERE name = 'x1_b'").first(), null, 'the batch rolled back whole');
  assert.equal(await db.prepare("SELECT id FROM _migrations WHERE id = 'x1:0003'").first(), null);
});

test('schema.gen.ts is the generated twin of schema.sql', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [new URL('../../scripts/gen-schema.mjs', import.meta.url).pathname, '--check']);
  assert.equal(r.status, 0, String(r.stderr));
});

test('eventColumns: an extension whose table has a NOT NULL column without a default can still receive core inserts (the live-database case)', async () => {
  const { enqueue, setEventColumns } = await import('./queue.ts');
  const db = makeDb();
  await db.exec('DROP TABLE events; CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, item_id TEXT NOT NULL, action TEXT NOT NULL, created_at INTEGER NOT NULL, priority INTEGER NOT NULL DEFAULT 0, session_id TEXT, text TEXT, files TEXT, reply_to INTEGER, status TEXT NOT NULL DEFAULT \'queued\', attempts INTEGER NOT NULL DEFAULT 0, stop_requested INTEGER NOT NULL DEFAULT 0, leased_until INTEGER, lease_id TEXT, acked_at INTEGER, role TEXT NOT NULL)');
  const ev = { user_id: 1, session_id: null, text: 'x', priority: 0 };
  setEventColumns({});
  await assert.rejects(enqueue(db, ev, 1), /NOT NULL/);
  assert.throws(() => createApp({ extensions: [{ name: 'x1', eventColumns: { status: 'x' } }] }), /plain extra column/);
  createApp({ extensions: [{ name: 'x1', eventColumns: { role: 'owner' } }] });
  await enqueue(db, ev, 1);
  assert.equal((await db.prepare('SELECT role FROM events').first<{ role: string }>())?.role, 'owner');
  setEventColumns({});
});

const stub = await (await import('./tgstub.ts')).telegramStub();
after(() => stub.close());
test('outsiders: an extension may claim a non-owner update; unclaimed ones are still dropped without a word', async () => {
  const seen: number[] = [];
  const app = createApp({ extensions: [{ name: 'fam', outsiders: async (_c, u) => { seen.push(u.message?.from?.id ?? 0); return u.message?.text === 'mine'; } }] });
  const db = makeDb();
  const env = { CHAT_ID: '42', TELEGRAM_BOT_TOKEN: '1:t', TG_SECRET: 's', RUN_KEY: 'k', DB: db, TELEGRAM_API_ROOT: stub.root };
  const send = (from: number, text: string) => app.fetch(new Request('https://w.test/tg', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 's' },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: from, type: 'private' }, from: { id: from, is_bot: false, first_name: 'x' }, text } }) }), env);
  assert.equal((await send(43, 'hello')).status, 200);
  assert.equal((await send(43, 'mine')).status, 200);
  assert.equal((await send(42, 'owner text')).status, 200);
  assert.deepEqual(seen, [43, 43], 'only non-owners are offered, the owner never is');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM events').first<{ n: number }>())?.n, 1, 'only the owner\'s message became an event');
});
