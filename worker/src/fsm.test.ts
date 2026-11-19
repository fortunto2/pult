import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Incoming, Item } from './contract.ts';
import { sweepItem, tomorrowMorning, transition, unwork, upsert, work } from './fsm.ts';

const H = 3600e3;
const inc = (o: Partial<Incoming> = {}): Incoming => ({ id: 'a', kind: 'decision', urgency: 'today', title: 'T', body: '', actions: ['done', 'drop', 'snooze_1h', 'snooze_tomorrow'], payload: null, source: null, expires_at: null, hash: 'h1', short: 's', loud: false, custom: [], ...o });
const live = (o: Partial<Item> = {}): Item => upsert(null, inc(), 1, 1000).item && { ...upsert(null, inc(), 1, 1000).item, ...o };

test('insert, then the same content is a touch, changed content updates in place', () => {
  const first = upsert(null, inc(), 1, 1000);
  assert.equal(first.kind, 'insert');
  assert.equal(first.item.expires_at, 1000 + 36 * H, 'a decision runs out');
  assert.equal(upsert(first.item, inc(), 1, 2000).kind, 'touch');
  const upd = upsert(first.item, inc({ hash: 'h2', title: 'T2' }), 1, 2000);
  assert.equal(upd.kind, 'update');
  assert.equal(upd.item.title, 'T2');
});

test('a closed item stays closed on the same content and reopens when the content changes', () => {
  const done = { ...live(), state: 'done' as const, closed_at: 5 };
  assert.equal(upsert(done, inc(), 1, 9).kind, 'touch');
  const re = upsert(done, inc({ hash: 'h9' }), 1, 9);
  assert.equal(re.kind, 'reopen');
  assert.equal(re.item.state, 'new');
});

test('notes and incidents do not run out on their own', () => {
  assert.equal(upsert(null, inc({ kind: 'inbox' }), 1, 1).item.expires_at, null);
  assert.equal(upsert(null, inc({ kind: 'incident' }), 1, 1).item.expires_at, null);
});

test('done, drop and snooze move the state; an action outside the item\'s list does nothing; a closed item does not move', () => {
  const it = live();
  assert.equal(transition(it, 'done', 5, 'u')?.item.state, 'done');
  assert.equal(transition(it, 'drop', 5, 'u')?.item.state, 'dropped');
  const s = transition(it, 'snooze_1h', 1000, 'u')!;
  assert.equal(s.item.state, 'snoozed');
  assert.equal(s.item.snooze_until, 1000 + H);
  assert.equal(transition(it, 'snooze_3d', 5, 'u'), null);
  assert.equal(transition({ ...it, state: 'done' }, 'done', 5, 'u'), null);
});

test('"tomorrow" is the next 08:00 in the owner\'s zone, never sooner than 8 hours', () => {
  const now = Date.UTC(2026, 0, 5, 23, 0);   // 23:00 UTC
  const t = tomorrowMorning(now, 'UTC');
  assert.equal(new Date(t).toISOString(), '2026-01-06T08:00:00.000Z');
  const late = tomorrowMorning(Date.UTC(2026, 0, 5, 7, 59), 'UTC');
  assert.ok(late - Date.UTC(2026, 0, 5, 7, 59) >= 8 * H);
});

test('sweep: a snooze that is over wakes the card, an undecided card past its expiry expires', () => {
  const sn = { ...live(), state: 'snoozed' as const, snooze_until: 100 };
  assert.equal(sweepItem(sn, 200)?.item.state, 'new');
  assert.equal(sweepItem({ ...live(), expires_at: 100 }, 200)?.item.state, 'expired');
  assert.equal(sweepItem(live(), 200), null);
});

test('work parks the card as "working" and unwork brings it back; repeating the same button is a no-op', () => {
  const w = work(live(), 'draft a reply', 10, 'user:1', 'button c1', true)!;
  assert.equal(w.item.state, 'snoozed');
  assert.equal(w.item.working, 'draft a reply');
  assert.equal(work(w.item, 'draft a reply', 11, 'user:1', 'button c1', true), null);
  assert.equal(unwork(w.item, 12, 'job')?.item.state, 'new');
  assert.equal(work({ ...live(), state: 'done' }, 'x', 1, 'u', 'reply'), null);
});
