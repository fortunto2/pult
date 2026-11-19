// Behaviour ported from the private bot's queue tests: a long turn that heartbeats runs exactly once, a dead holder loses the event, the live terminal session's door.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beat, clearLiveSeen, enqueue, finish, getEvent, pull, recordLiveSeen } from './queue.ts';
import { makeDb } from './testkit.ts';

const U = 111, T0 = Date.UTC(2026, 10, 12, 9, 0);
const ev = (db: D1Database, o: Partial<Parameters<typeof enqueue>[1]> = {}, at = T0) => enqueue(db, { user_id: U, session_id: 's', text: 'x', priority: 0, ...o }, at);

test('a turn three leases long runs exactly once while it heartbeats; a finished event is never pulled again; without beats it is re-leased', async () => {
  const db = makeDb();
  const id = await ev(db);
  const first = (await pull(db, 'interactive', T0))!;
  for (let t = 3e3; t <= 270e3; t += 3e3) {   // a 270 s turn (3 x the 90 s lease), beating every 20 s, both slots polling every 3 s
    if (t % 20e3 < 3e3) assert.equal((await beat(db, id, first.lease_id!, T0 + t)).ok, true);
    assert.equal(await pull(db, 'interactive', T0 + t), null);
    assert.equal(await pull(db, 'background', T0 + t), null);
  }
  assert.equal(await finish(db, id, first.lease_id!, 'done', T0 + 271e3), true);
  for (const t of [272e3, 400e3, 3600e3]) { assert.equal(await pull(db, 'interactive', T0 + t), null); assert.equal(await pull(db, 'background', T0 + t), null); }
  const e = (await getEvent(db, id))!;
  assert.deepEqual([e.status, e.attempts], ['done', 1]);
  const id2 = await ev(db, { session_id: 's2' });   // no beat for longer than the lease: another pull re-leases it, and the first runner's beat tells it to stop
  const a = (await pull(db, 'interactive', T0))!, b = (await pull(db, 'interactive', T0 + 100e3))!;
  assert.equal(b.id, id2);
  const late = await beat(db, id2, a.lease_id!, T0 + 101e3);
  assert.deepEqual([late.ok, late.stop], [false, true]);
});

test('live: a card button or a reply to a card (item_id) is never the live slot\'s: it stays with interactive (draft workflow)', async () => {
  const db = makeDb();
  await recordLiveSeen(db, 'L1', T0);
  await ev(db, { session_id: 'L1', text: 'More', priority: 1, item_id: 'card1' });
  await ev(db, { session_id: 'L1', text: 'a reply to the card', priority: 0, item_id: 'card1' });
  assert.equal(await pull(db, 'live', T0 + 1000, 'L1'), null);
  assert.equal((await pull(db, 'interactive', T0 + 1000))!.item_id, 'card1');
});

test('live: after 60 s without a pull the session is detached by itself and interactive takes the message; detach does it at once; another session is never held', async () => {
  const db = makeDb();
  await recordLiveSeen(db, 'L1', T0);
  const e1 = await ev(db, { session_id: 'L1', text: 'one' });
  assert.equal(await pull(db, 'interactive', T0 + 59_000), null, 'seen at T0, fresh');
  const got = (await pull(db, 'interactive', T0 + 61_000))!;
  assert.equal(got.id, e1, 'the channel died: nothing is lost');
  await finish(db, e1, got.lease_id ?? undefined, 'done', T0 + 62_000);
  await recordLiveSeen(db, 'L1', T0 + 70_000);   // alive again
  const mine = await ev(db, { session_id: 'L1', text: 'two' }, T0 + 70_000), other = await ev(db, { session_id: 'zzz', text: 'main' }, T0 + 70_000);
  assert.equal((await pull(db, 'interactive', T0 + 71_000))!.id, other, 'a different session is not held back');
  const lv = (await pull(db, 'live', T0 + 71_000, 'L1'))!;
  assert.equal(lv.id, mine);
  await finish(db, mine, lv.lease_id ?? undefined, 'done', T0 + 71_500);
  const e3 = await ev(db, { session_id: 'L1', text: 'three' }, T0 + 72_000);
  await clearLiveSeen(db, 'L1');
  assert.equal((await pull(db, 'interactive', T0 + 73_000))!.id, e3, 'detach hands the chat back at once');
});

test('live: seen is written at most every 20 s; the live slot needs a session', async () => {
  const db = makeDb();
  const at = async () => (await db.prepare("SELECT value FROM settings WHERE key = 'LIVE_SEEN:L1'").first<{ value: string }>())!.value;
  await recordLiveSeen(db, 'L1', T0); await recordLiveSeen(db, 'L1', T0 + 5_000);
  assert.equal(await at(), String(T0), '5 s later: no write');
  await recordLiveSeen(db, 'L1', T0 + 25_000);
  assert.equal(await at(), String(T0 + 25_000));
  assert.equal(await pull(db, 'live', T0), null);
});
