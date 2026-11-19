import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACTIONS, KINDS } from './contract.ts';
import { parseIncoming } from './api.ts';
import { callbackData } from './render.ts';

test('every action is a state action with a label, and snoozes name their length', () => {
  for (const [name, def] of Object.entries(ACTIONS)) {
    assert.match(name, /^[a-z0-9_]{1,32}$/, 'callback_data allows [a-z0-9_]{1,32}');
    assert.ok(['state', 'draft', 'task'].includes(def.tier));
    assert.ok(def.label.length > 0 && def.label.length <= 24, name);
    if (def.snooze) assert.ok(['1h', 'tomorrow', '3d'].includes(def.snooze), name);
  }
  assert.deepEqual(Object.keys(ACTIONS).sort(), ['ack', 'done', 'draft', 'drop', 'snooze_1h', 'snooze_3d', 'snooze_tomorrow']);
});

test('callback_data stays far below Telegram\'s 64 bytes for every action', () => {
  for (const a of Object.keys(ACTIONS)) assert.ok(callbackData('0123456789', a).length <= 64);
});

test('every kind gets a default action list the contract accepts', async () => {
  for (const kind of KINDS) {
    const r = await parseIncoming({ id: `t:${kind}`, kind, title: 'x' }, 1);
    assert.equal(typeof r, 'object', `${kind}: ${r}`);
    for (const a of (r as { actions: string[] }).actions) assert.ok(a in ACTIONS);
  }
});

test('an action outside the contract is refused at the door', async () => {
  assert.match(String(await parseIncoming({ id: 'a', title: 'x', actions: ['done', 'send_mail'] }, 1)), /actions/);
});
