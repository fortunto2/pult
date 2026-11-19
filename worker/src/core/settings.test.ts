import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flagOn, setFlag, withSettings } from './settings.ts';
import { makeDb } from './testkit.ts';

test('live switches: the D1 row wins over the deploy default, only named keys can be set, only 0 or 1', async () => {
  const DB = makeDb(), env = { DB, FAMILY: '0', OTHER: 'x' };
  assert.equal((await withSettings(env, ['FAMILY'])).FAMILY, '0');
  assert.equal(await setFlag(DB, 'FAMILY', '1', 5, ['FAMILY']), true);
  assert.equal(await setFlag(DB, 'NOPE', '1', 5, ['FAMILY']), false);
  assert.equal(await setFlag(DB, 'FAMILY', '2', 5, ['FAMILY']), false);
  const w = await withSettings(env, ['FAMILY']);
  assert.equal(w.FAMILY, '1');
  assert.equal(w.OTHER, 'x');
  assert.equal((await withSettings(env, [])).FAMILY, '0');
});

test('a timed switch lapses by itself', async () => {
  const DB = makeDb();
  await setFlag(DB, 'TEST', '1', 1000, ['TEST']);
  assert.equal(await flagOn(DB, 'TEST', 1000 + 3600e3, 2 * 3600e3), true);
  assert.equal(await flagOn(DB, 'TEST', 1000 + 3 * 3600e3, 2 * 3600e3), false);
  assert.equal(await flagOn(DB, 'TEST', 1000 + 3 * 3600e3), true, 'no ttl, no lapse');
  assert.equal(await flagOn(makeDb(), 'TEST', 1), false);
});
