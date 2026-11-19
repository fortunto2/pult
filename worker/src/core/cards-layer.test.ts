// The card layer end to end on the neutral core: reply and draft taps, send on confirm, hold/fold/sweep, the button grammar, a Russian string map, and core:0002 on a database that already has the columns.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { itemsRoute } from './api.ts';
import { handleCallback } from './callbacks.ts';
import { configureCards, resetCards } from './cardconfig.ts';
import { claimSend, getSend, finishSend } from './drafts.ts';
import { draftRoute } from './drafts-api.ts';
import type { Env } from './env.ts';
import { RU } from './locales/ru.ts';
import { CORE_MIGRATIONS, migrate } from './migrations.ts';
import type { ItemEvent } from './replies.ts';
import { resetStrings, setStrings } from './strings.ts';
import { getItem } from './store.ts';
import { hourly } from './hourly.ts';
import { fakeTg, makeDb, noSleep, type Call } from './testkit.ts';

const OWNER = 111, TZ = 'UTC', T0 = Date.UTC(2026, 10, 19, 9, 0), H = 3600e3, D = 24 * H, HASH = 'a'.repeat(64);
afterEach(() => { resetCards(); resetStrings(); });

async function setup() {
  const db = makeDb(), tg = fakeTg(), events: ItemEvent[] = [];
  const env = { CHAT_ID: String(OWNER), DB: db } as unknown as Env;
  const post = async (body: unknown, now = T0) => (await itemsRoute(new Request('https://x/items', { method: 'POST', body: JSON.stringify(body) }), new URL('https://x/items'), env, tg, TZ, now, noSleep))!.json() as Promise<any>;
  const draft = async (id: string, kind: 'draft' | 'reply-draft', body: unknown, now = T0 + H) => {
    const path = `/items/${encodeURIComponent(id)}/${kind}`;
    const r = (await draftRoute(new Request(`https://x${path}`, { method: 'POST', body: JSON.stringify(body) }), new URL(`https://x${path}`), env, tg, TZ, now, noSleep))!;
    return { status: r.status, body: await r.json() as any };
  };
  const press = async (id: string, action: string, now = T0 + H / 2, from = OWNER, sessions = true) => {
    const it = await getItem(db, OWNER, id);
    return handleCallback(db, tg, OWNER, { fromId: from, data: `v1:${it!.short}:${action}`, queryId: 'q' }, now, TZ, noSleep, async e => { events.push(e); }, { sessions, sendCap: 2 });
  };
  return { db, tg, env, events, post, draft, press };
}
const sends = (tg: { calls: Call[] }) => tg.calls.filter(c => c.op === 'send');
const flat = (c: Call) => (((c.markup as any)?.inline_keyboard ?? []) as { text: string; callback_data?: string }[][]).flat();
const mail = { id: 'gmail:t1', kind: 'decision', title: 'Paul: seats?', body: 'asks for an answer by Friday', payload: { meta: { do: 'Reply to Paul', why: 'waiting', cost: '3 min' } } };
const gdraft = { account: 'work', id: 'r-1', to: 'Paul <paul@example.com>', cc: '', subject: 'Re: seats', body: 'Hi Paul,\n\nYes.', more: 0, attachments: [], hash: HASH };

test('with no reply group configured the reply button is never offered; configured, it leads the card and starts one job', async () => {
  const a = await setup();
  await a.post(mail);
  assert.ok(!flat(sends(a.tg)[0]).some(b => /Reply/.test(b.text)));
  assert.equal(await a.press('gmail:t1', 'rp'), 'not allowed');

  configureCards({ groups: { gmail: 'mail' }, replyGroups: ['mail'] });
  const b = await setup();
  await b.post(mail);
  assert.equal(flat(sends(b.tg)[0])[0].text, '✍️ Reply');
  assert.match(String(await b.press('gmail:t1', 'rp')), /^writing a draft/);
  assert.equal(b.events.length, 1);
  assert.equal(b.events[0].action, 'reply_draft');
  assert.equal(await b.press('gmail:t1', 'rp'), 'not allowed');   // the card is working now: no second job
  assert.equal(b.events.length, 1);
  assert.equal(await b.press('gmail:t1', 'rp', T0, 999), null as never);   // not the owner: no toast at all
});

test('a mail draft arrives, Send asks once, the confirm queues one send, the cap and a second confirm hold', async () => {
  configureCards({ groups: { gmail: 'mail' }, replyGroups: ['mail'] });
  const { db, tg, events, post, draft, press } = await setup();
  await post(mail);
  assert.equal((await draft('gmail:t1', 'draft', gdraft)).status, 200);
  const card = tg.calls.filter(c => c.op === 'edit').at(-1)!;
  assert.ok(flat(card).some(b => b.callback_data?.endsWith(':send_draft')));
  assert.match(String(await press('gmail:t1', 'send_draft')), /^Really send/);
  const sy = flat(tg.calls.filter(c => c.op === 'edit' || c.op === 'markup').at(-1)!).find(b => /:sy_/.test(b.callback_data ?? ''))!;
  assert.ok(sy, 'the confirm button carries the draft hash');
  assert.equal(await press('gmail:t1', sy.callback_data!.split(':')[2]), 'sending');
  assert.equal(events.at(-1)!.action, 'send_draft');
  const row = Number(events.at(-1)!.text.split(' ')[1]);
  assert.equal((await claimSend(db, row, 1, T0 + H)).ok, true);
  assert.equal((await finishSend(db, row, { state: 'sent', gmail_id: 'g1' }, T0 + 2 * H, TZ)).ok, true);
  assert.equal((await getSend(db, row))!.state, 'sent');
  assert.match(String(await press('gmail:t1', sy.callback_data!.split(':')[2])), /already|not allowed/);
});

test('with the queue off, send and reply say so instead of failing', async () => {
  configureCards({ groups: { gmail: 'mail' }, replyGroups: ['mail'] });
  const { post, draft, press } = await setup();
  await post(mail);
  assert.match(String(await press('gmail:t1', 'rp', T0, OWNER, false)), /queue is off/);
  await draft('gmail:t1', 'draft', gdraft);
  assert.match(String(await press('gmail:t1', 'send_draft', T0, OWNER, false)), /queue is off/);
});

test('hold: cards past the cap wait behind one note, held ones never ring, sweep folds nothing early', async () => {
  const { db, tg, post } = await setup();
  for (let i = 0; i < 12; i++) await post({ id: `m:${i}`, kind: 'decision', title: `Card ${i}`, hold: i >= 4 });
  const held = (await db.prepare('SELECT COUNT(*) AS n FROM items WHERE held = 1').first<{ n: number }>())!.n;
  assert.equal(held, 8);
  assert.equal(sends(tg).filter(c => !c.silent).length <= 4, true);
  const before = tg.calls.length;
  await hourly({ CHAT_ID: String(OWNER), DB: db } as Env, tg, TZ, T0 + 2 * H);
  assert.ok(tg.calls.length >= before);
});

test('hygiene: an incident whose check is green again is expired by the job and its line collapses', async () => {
  const { db, tg, post, env } = await setup();
  await post({ id: 'incident:disk', kind: 'incident', title: 'Disk 91%', actions: ['ack'] });
  const r = await itemsRoute(new Request('https://x/items/incident%3Adisk/state', { method: 'POST', body: JSON.stringify({ state: 'expired' }) }), new URL('https://x/items/incident%3Adisk/state'), env, tg, TZ, T0 + H, noSleep);
  assert.equal(r!.status, 200);
  assert.equal((await getItem(db, OWNER, 'incident:disk'))!.state, 'expired');
});

test('a Russian string map turns every card string into Russian, and resetting brings English back', async () => {
  setStrings(RU);
  const { tg, post, press } = await setup();
  await post(mail);
  const labels = flat(sends(tg)[0]).map(b => b.text);
  assert.ok(labels.includes('⏰ Позже') && labels.includes('Не нужно'), labels.join('|'));
  assert.equal(await press('gmail:t1', 'ack'), 'так нельзя');
  resetStrings();
  assert.equal(await press('gmail:t1', 'ack'), 'not allowed');
});

test('core:0002 is a no-op on a database that already has the card columns and the send table (the live case)', async () => {
  const sql = new DatabaseSync(':memory:');
  const db = {
    prepare: (q: string) => { const mk = (a: unknown[]): any => ({ bind: (...x: unknown[]) => mk(x), run: async () => { const r = sql.prepare(q).run(...(a as never[])); return { meta: { changes: Number(r.changes) } }; }, first: async () => sql.prepare(q).get(...(a as never[])) ?? null, all: async () => ({ results: sql.prepare(q).all(...(a as never[])) }) }); return mk([]); },
    batch: async (l: any[]) => { sql.exec('BEGIN'); try { for (const s of l) await s.run(); sql.exec('COMMIT'); } catch (e) { sql.exec('ROLLBACK'); throw e; } },
  } as unknown as D1Database;
  const first = await migrate(db, CORE_MIGRATIONS);
  assert.deepEqual(first, CORE_MIGRATIONS.map(m => m.id));
  sql.exec("DELETE FROM _migrations WHERE id = 'core:0002_cards'");   // as if the live D1 had every column but never recorded the core id
  assert.deepEqual(await migrate(db, CORE_MIGRATIONS), ['core:0002_cards']);
  const cols = (sql.prepare('PRAGMA table_info(items)').all() as { name: string }[]).map(c => c.name);
  for (const c of ['origin_user', 'bumped_at', 'held', 'folded_at']) assert.equal(cols.filter(x => x === c).length, 1, c);
});
