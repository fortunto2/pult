// The queue hooks an extension uses: its own slot, filters on the core slots, lease length and ceiling, a recovery step, longer expiry, per-call event columns.
// Ported from the behaviour of a private bot's family consumer: one concurrent lease, a failure window, a hold for the interactive slot, a 15-minute ceiling.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { beat, enqueue, finish, getEvent, LEASE_MS, pull, recover, setEventColumns, setQueueHooks, type QueueHooks } from './queue.ts';
import { CORE_MIGRATIONS, migrate } from './migrations.ts';
import { makeDb } from './testkit.ts';

const T = 1_700_000_000_000, MIN = 60e3;
const ev = (db: D1Database, o: Partial<Parameters<typeof enqueue>[1]> = {}, at = T) => enqueue(db, { user_id: 1, session_id: null, text: 'hi', priority: 0, ...o }, at);
afterEach(() => { setQueueHooks([]); setEventColumns({}); });

test('priority 3 (other people\'s events) is taken by the interactive slot after 0 and 1', async () => {
  const db = makeDb();
  const c = await ev(db, { priority: 3 }, T), b = await ev(db, { priority: 1 }, T + 1), a = await ev(db, { priority: 0 }, T + 2);
  const got = []; for (let i = 0; i < 3; i++) got.push((await pull(db, 'interactive', T + 100))!.id);
  assert.deepEqual(got, [a, b, c]);
});

test('an extension slot: its own predicate, a gate that refuses the whole pull, and leased_by names the slot', async () => {
  const db = makeDb();
  let open = true;
  const hook: QueueHooks = { slots: [{ name: 'side', leaseMs: 5 * MIN,
    where: ({ now, args }) => `priority = 3 AND created_at <= ${Math.floor(now - Number(args.minAgeMs ?? 0))}`,
    gate: async (d, { now }) => open && !(await d.prepare("SELECT 1 AS x FROM events WHERE status = 'running' AND leased_by = 'side' AND leased_until >= ?").bind(now).first()) }] };
  setQueueHooks([hook]);
  const id = await ev(db, { priority: 3 }, T), id2 = await ev(db, { priority: 3 }, T + 1);
  assert.equal(await pull(db, 'side', T + 1000, undefined, { minAgeMs: 30e3 }), null, 'too young for this slot');
  const e = (await pull(db, 'side', T + 40e3, undefined, { minAgeMs: 30e3 }))!;
  assert.equal(e.id, id);
  assert.equal((await db.prepare('SELECT leased_by, lease_started, leased_until FROM events WHERE id = ?').bind(id).first<Record<string, number | string>>())!.leased_by, 'side');
  assert.equal((await db.prepare('SELECT leased_until FROM events WHERE id = ?').bind(id).first<{ leased_until: number }>())!.leased_until, T + 40e3 + 5 * MIN, 'the slot\'s own lease length');
  assert.equal(await pull(db, 'side', T + 41e3), null, 'the gate: one concurrent lease');
  await finish(db, id, e.lease_id!, 'done', T + 42e3);
  open = false;
  assert.equal(await pull(db, 'side', T + 43e3), null, 'a closed gate leases nothing, though event %d waits'.replace('%d', String(id2)));
  assert.equal(await pull(db, 'nope', T), null, 'an unknown slot name is nothing, not the interactive slot');
});

test('a filter narrows a core slot: the interactive slot leaves an event the hook holds back, until the hold ends', async () => {
  const db = makeDb();
  setQueueHooks([{ filters: [{ slots: ['interactive'], where: ({ now }) => `priority <> 3 OR created_at <= ${Math.floor(now - 45e3)}` }] }]);
  const id = await ev(db, { priority: 3 }, T);
  assert.equal(await pull(db, 'interactive', T + 10e3), null);
  assert.equal((await pull(db, 'interactive', T + 50e3))!.id, id);
  const other = await ev(db, { priority: 0 }, T);
  setQueueHooks([{ filters: [{ slots: ['background'], where: () => '0' }] }]);
  assert.equal((await pull(db, 'interactive', T + 60e3))!.id, other, 'a filter for another slot does not touch this one');
});

test('lease length per row and a ceiling counted from the lease start: a holder that beats forever loses the event', async () => {
  const db = makeDb();
  setEventColumns({});
  setQueueHooks([{ lease: r => (r.priority === 3 ? { ms: 5 * MIN, maxMs: 15 * MIN } : null) }]);
  const id = await ev(db, { priority: 3 });
  const e = (await pull(db, 'interactive', T))!;
  assert.equal((await db.prepare('SELECT leased_until FROM events WHERE id = ?').bind(id).first<{ leased_until: number }>())!.leased_until, T + 5 * MIN);
  assert.deepEqual(await beat(db, id, e.lease_id!, T + 10 * MIN), { ok: true, stop: false });
  assert.equal((await db.prepare('SELECT leased_until FROM events WHERE id = ?').bind(id).first<{ leased_until: number }>())!.leased_until, T + 15 * MIN);
  assert.deepEqual(await beat(db, id, e.lease_id!, T + 16 * MIN), { ok: false, stop: true }, 'past the ceiling');
  const plain = await ev(db, { priority: 0 }, T + 20 * MIN), p = (await pull(db, 'interactive', T + 20 * MIN))!;
  assert.equal(p.id, plain);
  assert.deepEqual(await beat(db, plain, p.lease_id!, T + 20 * MIN + 60 * MIN), { ok: true, stop: false }, 'no ceiling for rows the hook ignores');
  assert.equal((await db.prepare('SELECT leased_until FROM events WHERE id = ?').bind(plain).first<{ leased_until: number }>())!.leased_until, T + 80 * MIN + LEASE_MS);
});

test('recovery: beforeRecover sees the dead lease before it is requeued; expiry rules keep some events longer', async () => {
  const db = makeDb();
  await db.exec('ALTER TABLE events ADD COLUMN barred INTEGER NOT NULL DEFAULT 0');
  setQueueHooks([{
    beforeRecover: async (d, now) => { await d.prepare("UPDATE events SET barred = 1 WHERE status = 'running' AND leased_until < ? AND leased_by = 'side'").bind(now).run(); },
    expiry: [{ where: "action = 'help'", ms: 48 * 3600e3 }],
    slots: [{ name: 'side', where: () => 'priority = 3' }],
  }]);
  const dead = await ev(db, { priority: 3 }), help = await ev(db, { action: 'help' }), plain = await ev(db, { action: 'ask', session_id: 'x' });
  await db.prepare('UPDATE events SET priority = 9 WHERE id IN (?, ?)').bind(help, plain).run();   // out of every slot: only expiry acts on them
  assert.ok(await pull(db, 'side', T));
  await recover(db, T + LEASE_MS + 5 * MIN);
  const d = (await db.prepare('SELECT barred, status FROM events WHERE id = ?').bind(dead).first<{ barred: number; status: string }>())!;
  assert.deepEqual([d.barred, d.status], [1, 'queued']);
  await recover(db, T + 25 * 3600e3);
  assert.equal((await getEvent(db, plain))!.status, 'expired');
  assert.equal((await getEvent(db, help))!.status, 'queued', 'a help event outlives the day');
  await recover(db, T + 49 * 3600e3);
  assert.equal((await getEvent(db, help))!.status, 'expired');
});

test('enqueue: per-call extra columns override the extensions\' defaults, and the row\'s own role is read back', async () => {
  const db = makeDb();
  await db.exec("ALTER TABLE events ADD COLUMN role TEXT NOT NULL DEFAULT 'owner'");
  setEventColumns({ role: 'owner' });
  const a = await ev(db), b = await ev(db, { priority: 3, extra: { role: 'member' } });
  assert.equal((await getEvent(db, a))!.role, 'owner');
  assert.equal((await getEvent(db, b))!.role, 'member');
});

test('core:0003 is idempotent against a database that already grew these columns (the live one)', async () => {
  const db = makeDb();   // schema.sql plus the columns already present, and no _migrations row for 0003: what a database grown elsewhere looks like
  assert.deepEqual(await migrate(db, CORE_MIGRATIONS), CORE_MIGRATIONS.map(m => m.id));
  assert.deepEqual(await migrate(db, CORE_MIGRATIONS), []);
});
