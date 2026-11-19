import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beat, depth, enqueue, finish, getEvent, LEASE_MS, pull, recordLiveSeen, requestStop } from './queue.ts';
import { makeDb } from './testkit.ts';

const U = 1, T = 1_700_000_000_000;
const ev = (db: D1Database, o: Partial<Parameters<typeof enqueue>[1]> = {}, at = T) => enqueue(db, { user_id: U, session_id: 's1', text: 'hi', priority: 0, ...o }, at);

test('the interactive slot takes the lowest priority number first, oldest first within it', async () => {
  const db = makeDb();
  const b = await ev(db, { session_id: 's2', priority: 1 }, T), a = await ev(db, { session_id: 's3', priority: 0 }, T + 5), c = await ev(db, { session_id: 's4', priority: 0 }, T + 1);
  const order = [];
  for (let i = 0; i < 3; i++) order.push((await pull(db, 'interactive', T + 100))!.id);
  assert.deepEqual(order, [c, a, b]);
  assert.equal(await pull(db, 'interactive', T + 100), null);
});

test('the background slot takes only P2, and none while a P0 waits', async () => {
  const db = makeDb();
  await ev(db, { session_id: 'j', priority: 2 });
  assert.equal(await pull(db, 'interactive', T), null, 'P2 is not the interactive slot\'s');
  await ev(db, { session_id: 'p0', priority: 0 });
  assert.equal(await pull(db, 'background', T), null, 'a waiting P0 holds the background');
  assert.ok(await pull(db, 'interactive', T));
  assert.equal((await pull(db, 'background', T))!.priority, 2);
});

test('one running turn per session: the next message of that session waits for the ack', async () => {
  const db = makeDb();
  await ev(db, { text: 'one' }); await ev(db, { text: 'two' }, T + 1);
  const first = (await pull(db, 'interactive', T + 2))!;
  assert.equal(first.text, 'one');
  assert.equal(await pull(db, 'interactive', T + 3), null);
  assert.ok(await finish(db, first.id, first.lease_id!, 'done', T + 4));
  assert.equal((await pull(db, 'interactive', T + 5))!.text, 'two');
});

test('lease: beat needs the token, extends the lease and carries /stop; a stale holder cannot ack', async () => {
  const db = makeDb();
  await ev(db);
  const e = (await pull(db, 'interactive', T))!;
  assert.equal((await beat(db, e.id, undefined, T)).ok, false);
  assert.equal((await beat(db, e.id, 'wrong', T)).ok, false);
  assert.deepEqual(await beat(db, e.id, e.lease_id!, T + 60_000), { ok: true, stop: false });
  assert.equal((await getEvent(db, e.id))!.status, 'running');
  await requestStop(db, U, 's1', T + 61_000);
  assert.deepEqual(await beat(db, e.id, e.lease_id!, T + 62_000), { ok: true, stop: true });
  assert.equal(await finish(db, e.id, 'wrong', 'done', T), false);
  assert.equal(await finish(db, e.id, e.lease_id!, 'stopped', T), true);
});

test('a dead lease goes back to the queue, three tries then failed; a day-old queued event expires', async () => {
  const db = makeDb();
  await ev(db);
  let t = T;
  for (let n = 1; n <= 3; n++) { const e = (await pull(db, 'interactive', t))!; assert.equal(e.attempts, n); t += LEASE_MS + 1; }
  assert.equal(await pull(db, 'interactive', t), null);
  assert.equal((await getEvent(db, 1))!.status, 'failed');
  const old = await ev(db, { session_id: 'old' }, T);
  assert.equal(await pull(db, 'interactive', T + 25 * 3600e3), null);
  assert.equal((await getEvent(db, old))!.status, 'expired');
});

test('requeue (usage limit hit mid-turn) returns the event and does not count the try', async () => {
  const db = makeDb();
  await ev(db);
  const e = (await pull(db, 'interactive', T))!;
  assert.ok(await finish(db, e.id, e.lease_id!, 'requeue', T));
  const again = (await pull(db, 'interactive', T + 1))!;
  assert.equal(again.attempts, 1);
});

test('/stop flags the running turn and drops the queued ones of that session only', async () => {
  const db = makeDb();
  await ev(db, { session_id: 'a' }); await ev(db, { session_id: 'a' }, T + 1); await ev(db, { session_id: 'b' }, T + 2);
  await pull(db, 'interactive', T + 3);
  assert.deepEqual(await requestStop(db, U, 'a', T + 4), { running: 1, dropped: 1 });
  assert.deepEqual(await depth(db), { queued: { P0: 1 }, running: 1 });
});

test('the live slot: an attached terminal session gets its plain text, the interactive runner leaves it alone, then takes it back a minute after the channel dies', async () => {
  const db = makeDb();
  await recordLiveSeen(db, 'live1', T);
  const plain = await ev(db, { session_id: 'live1', text: 'from the phone' }, T + 1);
  const card = await ev(db, { session_id: 'live1', item_id: 'mail:1', action: 'reply', text: 'card reply' }, T + 2);
  const job = (await pull(db, 'interactive', T + 3))!;
  assert.equal(job.id, card, 'card jobs stay with the restricted runner');
  await finish(db, job.id, job.lease_id!, 'done', T + 3);
  assert.equal(await pull(db, 'interactive', T + 4), null, 'the attached plain text is not the runner\'s');
  assert.equal(await pull(db, 'live', T + 5, 'other'), null, 'another session\'s door is shut');
  assert.equal((await pull(db, 'live', T + 5, 'live1'))!.id, plain);
  await ev(db, { session_id: 'live1', text: 'later' }, T + 6);
  assert.equal(await pull(db, 'interactive', T + 7), null, 'while the channel keeps pulling, its text stays its own');
});

test('without a live heartbeat the plain text is the interactive runner\'s again', async () => {
  const db = makeDb();
  await recordLiveSeen(db, 'live1', T);
  const id = await ev(db, { session_id: 'live1' }, T + 1);
  assert.equal(await pull(db, 'interactive', T + 30_000), null);
  assert.equal((await pull(db, 'interactive', T + 61_000))!.id, id);
});
