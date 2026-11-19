import assert from 'node:assert/strict';
import { test } from 'node:test';
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
  assert.deepEqual(await migrate(db, [...CORE_MIGRATIONS, ...ext]), ['core:0001_init', 'x1:0001', 'x1:0002']);
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
