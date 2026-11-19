// A rejected-ack incident clears itself when its event is done, and only then.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settleAckIncidents } from './hourly.ts';
import { CORE_MIGRATIONS, migrate } from './migrations.ts';
import { upsertItem } from './store.ts';
import { makeDb } from './testkit.ts';
import type { Incoming } from './contract.ts';

const OWNER = 7, NOW = Date.UTC(2026, 10, 19, 12);
const card = (id: string): Incoming => ({ id, kind: 'incident', urgency: 'today', title: 't', body: 'b', actions: ['ack'], payload: null, source: 'runner', expires_at: null, origin_user: null, loud: false, custom: [], hash: 'h'.repeat(64), short: [...id].map(c => c.charCodeAt(0).toString(16)).join('').slice(-10).padStart(10, '0') } as unknown as Incoming);

const stateOf = async (db: D1Database, id: string) => (await db.prepare('SELECT state FROM items WHERE id = ?').bind(id).first<{ state: string }>())!.state;

test('the ack incident expires once its event is done, not while it is still running', async () => {
  const db = makeDb(); await migrate(db, CORE_MIGRATIONS);
  for (const [id, status] of [[93, 'done'], [94, 'running']] as const) {
    await db.prepare('INSERT INTO events (id, user_id, created_at, status) VALUES (?,?,?,?)').bind(id, OWNER, NOW, status).run();
    await upsertItem(db, OWNER, card(`incident:ack:${id}`), NOW, 'job');
  }
  await upsertItem(db, OWNER, card('incident:other'), NOW, 'job');
  assert.equal(await settleAckIncidents(db, OWNER, NOW + 1), 1);
  assert.equal(await stateOf(db, 'incident:ack:93'), 'expired');
  assert.notEqual(await stateOf(db, 'incident:ack:94'), 'expired');
  assert.notEqual(await stateOf(db, 'incident:other'), 'expired');
});
