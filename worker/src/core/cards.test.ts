import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIncoming } from './api.ts';
import { handleCallback } from './callbacks.ts';
import { replyEvent, type ItemEvent } from './replies.ts';
import { callbackData } from './render.ts';
import { reconcile } from './reconcile.ts';
import { getByShort, getItem, itemLog, upsertItem } from './store.ts';
import { fakeTg, makeDb, noSleep } from './testkit.ts';

const OWNER = 42, NOW = 1_700_000_000_000;
async function card(db: D1Database, over: Record<string, unknown> = {}) {
  const inc = await parseIncoming({ id: 'mail:1', title: 'Reply to the vendor', body: 'They asked for a date.', ...over }, OWNER) as never;
  await upsertItem(db, OWNER, inc, NOW);
  return inc as { short: string; id: string };
}
const press = (db: D1Database, tg: ReturnType<typeof fakeTg>, short: string, action: string, who = OWNER, enqueue?: (e: ItemEvent) => Promise<void>) =>
  handleCallback(db, tg, OWNER, { fromId: who, data: callbackData(short, action), queryId: 'q' }, NOW + 1000, 'UTC', noSleep, enqueue);

test('Done closes the card and collapses its message; a second press says it is already handled', async () => {
  const db = makeDb(), tg = fakeTg(), { short } = await card(db);
  await reconcile(db, tg, OWNER, NOW, 'UTC', noSleep);
  assert.equal(tg.calls.filter(c => c.op === 'send').length, 1);
  assert.equal(await press(db, tg, short, 'done'), 'done');
  assert.equal((await getItem(db, OWNER, 'mail:1'))!.state, 'done');
  const edit = tg.calls.filter(c => c.op === 'edit').at(-1)!;
  assert.match(edit.plain!, /^✓ done:/);
  assert.deepEqual(edit.markup, { inline_keyboard: [[{ text: '↩︎ Undo', callback_data: callbackData(short, 'un') }]] });   // the grammar leaves one minute of undo
  assert.equal(await press(db, tg, short, 'done'), 'already closed');
});

test('Not needed and Later move the state and log who pressed', async () => {
  const db = makeDb(), tg = fakeTg(), { short } = await card(db);
  await reconcile(db, tg, OWNER, NOW, 'UTC', noSleep);
  await press(db, tg, short, 'snooze_tomorrow');
  const it = (await getItem(db, OWNER, 'mail:1'))!;
  assert.equal(it.state, 'snoozed');
  assert.ok(it.snooze_until! > NOW);
  assert.ok((await itemLog(db, OWNER, 'mail:1')).some(l => l.by === `user:${OWNER}` && l.note === 'snooze_tomorrow'));
});

test('anyone but the owner gets nothing, not even a toast; garbage and unknown cards are refused', async () => {
  const db = makeDb(), tg = fakeTg(), { short } = await card(db);
  assert.equal(await press(db, tg, short, 'done', 999), null);
  assert.equal(tg.calls.filter(c => c.op === 'answer').length, 0);
  assert.equal((await getItem(db, OWNER, 'mail:1'))!.state, 'new');
  assert.equal(await handleCallback(db, tg, OWNER, { fromId: OWNER, data: 'nonsense', queryId: 'q' }, NOW, 'UTC', noSleep), 'unknown button');
  assert.equal(await press(db, tg, '0000000000', 'done'), 'already handled');
});

test('an action that is not in the card\'s stored list is refused even when callback_data names a real action', async () => {
  const db = makeDb(), tg = fakeTg(), { short } = await card(db, { actions: ['done'] });
  assert.equal(await press(db, tg, short, 'drop'), 'not allowed');
  assert.equal((await getItem(db, OWNER, 'mail:1'))!.state, 'new');
});

test('the Later button opens a menu and Back closes it, without any state change', async () => {
  const db = makeDb(), tg = fakeTg(), { short } = await card(db);
  await reconcile(db, tg, OWNER, NOW, 'UTC', noSleep);
  await press(db, tg, short, 'snooze_menu');
  const m = tg.calls.find(c => c.op === 'markup')!;
  assert.deepEqual((m.markup as { inline_keyboard: { text: string }[][] }).inline_keyboard[0].map(b => b.text), ['Tomorrow', 'Mon']);
  assert.equal((await getItem(db, OWNER, 'mail:1'))!.state, 'shown');
});

test('a custom button queues its stored instruction as a read-and-draft job and parks the card as working; a repeat press does nothing', async () => {
  const db = makeDb(), tg = fakeTg();
  const { short } = await card(db, { custom_actions: [{ label: 'Draft', instruction: 'Draft a polite reply into the drafts folder.' }] });
  await reconcile(db, tg, OWNER, NOW, 'UTC', noSleep);
  const queued: ItemEvent[] = [];
  assert.equal(await press(db, tg, short, 'c1', OWNER, async e => { queued.push(e); }), 'started');
  assert.equal(queued.length, 1);
  assert.match(queued[0].text, /^Draft a polite reply/);
  assert.match(queued[0].text, /read and draft only; send nothing/);
  assert.equal(queued[0].item.id, 'mail:1');
  assert.equal((await getItem(db, OWNER, 'mail:1'))!.working, 'Draft a polite reply into the drafts folder.');
  assert.equal(await press(db, tg, short, 'c1', OWNER, async e => { queued.push(e); }), 'already running');
  assert.equal(queued.length, 1);
  assert.equal(await press(db, tg, short, 'c2', OWNER, async () => undefined), 'not allowed', 'a button the card does not have');
});

test('a reply to a card message becomes an event that quotes the card from the store', async () => {
  const db = makeDb(), tg = fakeTg();
  await card(db);
  await reconcile(db, tg, OWNER, NOW, 'UTC', noSleep);
  const mid = (await getItem(db, OWNER, 'mail:1'))!.tg_message_id!;
  const ev = await replyEvent(db, tg, { userId: OWNER, name: 'o', messageId: mid, text: 'say no, politely', eventId: 5 }, NOW + 5, 'UTC');
  assert.ok(ev);
  assert.match(ev.quoted, /Decision "Reply to the vendor"/);
  assert.equal((await getItem(db, OWNER, 'mail:1'))!.working, 'say no, politely');
  assert.equal(await replyEvent(db, tg, { userId: OWNER, name: 'o', messageId: 99999, text: 'x', eventId: 6 }, NOW, 'UTC'), null);
});

test('short ids are stable per owner and id', async () => {
  const db = makeDb(), { short, id } = await card(db);
  assert.equal((await getByShort(db, OWNER, short))!.id, id);
});
