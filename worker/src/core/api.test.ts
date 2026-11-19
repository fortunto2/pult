import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemsRoute, parseIncoming, parseMeta } from './api.ts';
import type { Env } from './env.ts';
import { streamOf } from './streams.ts';
import { getItem } from './store.ts';
import { fakeTg, makeDb, noSleep } from './testkit.ts';

const OWNER = 42, T = Date.UTC(2026, 0, 5, 12, 0);
function rig() {
  const db = makeDb(), tg = fakeTg(), env = { DB: db, CHAT_ID: String(OWNER) } as unknown as Env;
  const call = async (method: string, path: string, body?: unknown, now = T) => {
    const r = await itemsRoute(new Request(`https://w.test${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), new URL(`https://w.test${path}`), env, tg, 'UTC', now, noSleep);
    return { status: r!.status, json: (await r!.json()) as any };
  };
  return { db, tg, call };
}

test('parseIncoming: the bounds are the contract', async () => {
  const bad = async (o: object) => String(await parseIncoming({ id: 'a', title: 't', ...o }, 1));
  assert.match(await bad({ id: '' }), /id/);
  assert.match(await bad({ title: ' ' }), /title/);
  assert.match(await bad({ kind: 'chat' }), /kind/);
  assert.match(await bad({ urgency: 'asap' }), /urgency/);
  assert.match(await bad({ body: 'x'.repeat(3001) }), /body/);
  assert.match(await bad({ expires_at: 'tomorrow' }), /expires_at/);
  assert.match(await bad({ custom_actions: [{ label: 'a', instruction: 'b' }, { label: 'a', instruction: 'b' }, { label: 'a', instruction: 'b' }, { label: 'a', instruction: 'b' }] }), /up to 3/);
  assert.match(await bad({ custom_actions: [{ label: 'x'.repeat(25), instruction: 'b' }] }), /label/);
  assert.match(await bad({ custom_actions: [{ label: 'ok', instruction: 'x'.repeat(301) }] }), /instruction/);
  const ok = await parseIncoming({ id: 'a', title: 't', custom_actions: [{ label: 'One', instruction: 'do it' }] }, 1) as { custom: { id: string }[]; short: string };
  assert.equal(ok.custom[0].id, 'c1');
  assert.match(ok.short, /^[0-9a-f]{10}$/);
});

test('the meta fields are cut to length and stay out of the content hash', async () => {
  assert.deepEqual(parseMeta({ do: 'd'.repeat(200), why: ' w ', cost: '', verb: 'v'.repeat(40), junk: 1 }), { do: 'd'.repeat(90), why: 'w', verb: 'v'.repeat(16) });
  const a = await parseIncoming({ id: 'a', title: 't', payload: { link: 'https://x.test' } }, 1) as { hash: string };
  const b = await parseIncoming({ id: 'a', title: 't', payload: { link: 'https://x.test', meta: { do: 'pay' } } }, 1) as { hash: string };
  assert.equal(a.hash, b.hash);
});

test('POST /items shows the card once; the same content again changes nothing; changed content edits it in place', async () => {
  const { tg, call } = rig();
  const first = (await call('POST', '/items', { id: 'mail:1', title: 'Reply', body: 'v1' })).json;
  assert.deepEqual([first.result, first.state], ['insert', 'shown']);
  assert.ok(first.message_id);
  assert.equal(tg.calls.filter(c => c.op === 'send').length, 1);
  assert.equal((await call('POST', '/items', { id: 'mail:1', title: 'Reply', body: 'v1' }, T + 1000)).json.result, 'touch');
  assert.equal(tg.calls.length, 1);
  assert.equal((await call('POST', '/items', { id: 'mail:1', title: 'Reply', body: 'v2' }, T + 2000)).json.result, 'update');
  assert.equal(tg.calls.at(-1)!.op, 'edit');
  assert.ok(tg.calls.at(-1)!.markup, 'the edit carries the keyboard');
  assert.equal(tg.calls.filter(c => c.op === 'send').length, 1, 'no second message');
});

test('a bad body is a 400 with the reason, not a 500', async () => {
  const { call } = rig();
  const r = await call('POST', '/items', { id: 'x', title: 't', actions: ['rm_rf'] });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /actions/);
});

test('state: close from a script, reopen after a failed run, expire only job-owned streams', async () => {
  const { db, call } = rig();
  await call('POST', '/items', { id: 'mail:1', title: 'Reply' });
  await call('POST', '/items', { id: 'incident:disk-2026-01-05', kind: 'incident', title: 'Disk full' });
  assert.equal((await call('POST', '/items/mail%3A1/state', { state: 'expired' })).status, 400, 'a decision needs a reason');
  assert.equal((await call('POST', '/items/mail%3A1/state', { state: 'expired', reason: 'answered in the thread' })).json.state, 'expired');
  assert.equal((await call('POST', '/items/incident%3Adisk-2026-01-05/state', { state: 'expired' })).json.state, 'expired');
  assert.equal((await call('POST', '/items/nope/state', { state: 'done' })).status, 404);
  assert.equal((await call('POST', '/items/mail%3A1/state', { state: 'maybe' })).status, 400);
  await call('POST', '/items', { id: 'mail:2', title: 'Other' });
  assert.deepEqual((await call('POST', '/items/mail%3A2/state', { state: 'done' })).json, { id: 'mail:2', changed: true, state: 'done' });
  assert.equal((await getItem(db, OWNER, 'mail:2'))!.closed_at, T);
});

test('detail: the answer of a More job lands inside the card and edits the message', async () => {
  const { tg, call } = rig();
  await call('POST', '/items', { id: 'mail:1', title: 'Reply', custom_actions: [{ label: 'More', instruction: 'look it up' }] });
  assert.equal((await call('POST', '/items/mail%3A1/detail', { text: '  ' })).status, 400);
  assert.equal((await call('POST', '/items/mail%3A1/detail', { text: 'Thread: three messages.' })).json.changed, true);
  assert.match(tg.calls.at(-1)!.pm!, /<blockquote expandable>Thread: three messages\./);
  assert.match(JSON.stringify((await call('GET', '/items/mail%3A1/log')).json.log), /detail: Thread/);
});

test('streams: a new dated note closes the older ones of its stream and deletes their messages, a card is never touched', async () => {
  assert.equal(streamOf('sweep-2026-01-05'), 'sweep');
  assert.equal(streamOf('incident:disk:2026-01-05'), 'incident:disk');
  assert.equal(streamOf('mail:1'), null);
  const { tg, call } = rig();
  await call('POST', '/items', { id: 'sweep-2026-01-04', kind: 'inbox', title: 'Sweep yesterday' });
  await call('POST', '/items', { id: 'mail:1', title: 'Card' });
  await call('POST', '/items', { id: 'sweep-2026-01-05', kind: 'inbox', title: 'Sweep today' }, T + 1000);
  const open = (await call('GET', '/items?state=open')).json.map((i: { id: string }) => i.id).sort();
  assert.deepEqual(open, ['mail:1', 'sweep-2026-01-05']);
  assert.ok(tg.calls.some(c => c.op === 'delete'));
});

test('GET /items filters by state and kind and never leaks the short id or render hash', async () => {
  const { call } = rig();
  await call('POST', '/items', { id: 'a', title: 'A' });
  await call('POST', '/items', { id: 'b', kind: 'inbox', title: 'B' });
  const list = (await call('GET', '/items?kind=inbox')).json;
  assert.deepEqual(list.map((i: { id: string }) => i.id), ['b']);
  assert.equal('short' in list[0] || 'rendered_hash' in list[0], false);
  assert.equal((await call('GET', '/items/nope')).status, 404);
});
