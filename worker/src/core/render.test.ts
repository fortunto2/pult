import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Item } from './contract.ts';
import { collapsedView, keyboard, linkify, render } from './render.ts';

const base: Item = { user_id: 7, id: 'card:1', short: 'abcdef0123', kind: 'decision', urgency: 'today', state: 'new', first_seen: 0, last_seen: 0, shown_at: null, snooze_until: null, expires_at: null, closed_at: null, source: null,
  title: 'Reply to the vendor', body: 'They asked for a date.', actions: ['done', 'snooze_1h', 'snooze_tomorrow', 'drop'], payload: null, hash: 'h', tg_message_id: null, msg_state: 'none', rendered_hash: null, loud: false, loud_sent_at: null, bumped_at: null, origin_user: null, working: null, custom: [] };
const item = (o: Partial<Item> = {}): Item => ({ ...base, ...o });
const NOW = 5 * 3600e3;

test('a new decision is sent once, silent unless the job asked for a ring', () => {
  const [op] = render([item()], NOW);
  assert.equal(op.kind, 'send');
  assert.equal(op.silent, true);
  const [loud] = render([item({ loud: true })], NOW);
  assert.equal(loud.silent, false);
});

test('one ring per batch: the second loud card within the quiet window is silent', () => {
  const ops = render([item({ id: 'a', short: 'aaaaaaaaaa', loud: true }), item({ id: 'b', short: 'bbbbbbbbbb', loud: true })], NOW);
  assert.deepEqual(ops.map(o => o.silent), [false, true]);
  assert.deepEqual(render([item({ loud: true })], NOW, { quietUntil: NOW + 1 }).map(o => o.silent), [true]);
});

test('rule: every edit of a live message carries reply_markup again', () => {
  const live = item({ msg_state: 'live', tg_message_id: 11, rendered_hash: 'stale' });
  const edit = render([live], NOW)[0];
  assert.equal(edit.kind, 'edit');
  assert.ok(edit.markup && edit.markup.inline_keyboard.length > 0);
  const collapse = render([item({ ...live, state: 'done', closed_at: NOW })], NOW)[0];
  assert.equal(collapse.effect, 'collapse');
  assert.ok(collapse.markup, 'the collapsed line passes an (empty) keyboard explicitly');
  assert.match(collapse.text!, /^✓ done: Reply to the vendor$/);
});

test('an up-to-date live card produces no op', () => {
  const [op] = render([item()], NOW);
  assert.deepEqual(render([item({ msg_state: 'live', tg_message_id: 11, rendered_hash: op.key })], NOW), []);
});

test('keyboard: Done, Later, Not needed on row 1; several snoozes collapse into one Later button that opens a menu', () => {
  const kb = keyboard(item());
  const labels = kb.inline_keyboard[0].map(b => b.text);
  assert.deepEqual(labels, ['Done', '⏰ Later', 'Not needed']);
  const menu = keyboard(item(), true, true).inline_keyboard.flat().map(b => b.text);
  assert.ok(menu.includes('Tomorrow') && menu.includes('← Back'));
});

test('the card\'s own verb replaces "Done", and the More button sits on row 1 with its instruction kept out of callback_data', () => {
  const kb = keyboard(item({ payload: { meta: { verb: 'Paid' } }, custom: [{ id: 'c1', label: 'More', instruction: 'Look up the thread and summarise it.' }] }));
  assert.equal(kb.inline_keyboard[0][0].text, 'Paid');
  const more = kb.inline_keyboard.flat().find(b => b.text === 'More')!;
  assert.ok('callback_data' in more && more.callback_data.endsWith(':c1'));
  assert.ok(!JSON.stringify(kb).includes('summarise'));
});

test('only https links become an Open button; Copy carries at most 256 characters', () => {
  assert.equal(JSON.stringify(keyboard(item({ payload: { link: 'http://example.com' } }))).includes('Open'), false);
  assert.equal(JSON.stringify(keyboard(item({ payload: { link: 'javascript:alert(1)' } }))).includes('Open'), false);
  const kb = keyboard(item({ payload: { link: 'https://example.com/x', copy: 'c'.repeat(400) } }));
  const row = kb.inline_keyboard[1];
  assert.equal(row[0].text, '↗ Open');
  assert.equal((row[1] as { copy_text: { text: string } }).copy_text.text.length, 256);
});

test('model text is escaped: no markup from a title, a body or a meta field reaches the HTML', () => {
  const [op] = render([item({ title: '<b>x</b>', body: '<script>1</script>', payload: { meta: { do: '<i>do</i>', why: '<u>w</u>' } } })], NOW);
  assert.ok(!/<script|<u>|<i>do/.test(op.pm!));
  assert.match(op.pm!, /&lt;i&gt;do/);
});

test('the fixed card shape: action, why and cost, the fact, details collapsed', () => {
  const [op] = render([item({ payload: { meta: { do: 'Pay the invoice', why: 'late fee on Friday', cost: '5 min' }, detail: 'Thread: three messages.' } })], NOW);
  assert.match(op.pm!, /^<b>🔴 Pay the invoice<\/b>\n<i>why: late fee on Friday {2}·  cost: 5 min<\/i>\nWho\/what: Reply to the vendor/);
  assert.match(op.pm!, /<blockquote expandable>.*Thread: three messages\./s);
});

test('a decision that was snoozed collapses to one line with the time; waking it sends a fresh card and replaces the old line', () => {
  const sn = item({ state: 'snoozed', snooze_until: NOW + 3600e3, msg_state: 'live', tg_message_id: 4 });
  assert.match(collapsedView(sn, 'UTC').text, /^💤 snoozed until \d\d\.\d\d \d\d:\d\d: /);
  const woke = item({ state: 'new', msg_state: 'collapsed', tg_message_id: 4 });
  const [op] = render([woke], NOW);
  assert.equal(op.kind, 'send');
  assert.equal(op.replaces, 4);
});

test('a card being worked on shows one line and keeps Done and Later but drops the spent custom buttons', () => {
  const w = item({ state: 'snoozed', working: 'draft the reply', msg_state: 'live', tg_message_id: 4, custom: [{ id: 'c1', label: 'More', instruction: 'x' }] });
  const [op] = render([w], NOW);
  assert.match(op.text!, /^⏳ working: draft the reply/);
  assert.ok(!JSON.stringify(op.markup).includes(':c1'));
});

test('incidents ring and offer Copy command; a finished one is deleted; notes are silent', () => {
  const inc = item({ kind: 'incident', id: 'incident:disk', short: 'iiiiiiiiii', actions: ['ack'], payload: { fix: 'df -h' } });
  const [op] = render([inc], NOW);
  assert.equal(op.silent, false);
  assert.ok(JSON.stringify(op.markup).includes('Copy command'));
  assert.equal(render([{ ...inc, state: 'done', msg_state: 'live', tg_message_id: 3 }], NOW)[0].kind, 'delete');
  assert.equal(render([item({ kind: 'inbox', actions: [] })], NOW)[0].silent, true);
});

test('linkify names a link by its host and escapes the rest', () => {
  assert.equal(linkify('see https://www.example.com/a?b=1 now <3'), 'see <a href="https://www.example.com/a?b=1">example.com</a> now &lt;3');
});
