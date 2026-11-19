import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from './app.ts';
import { resetStrings, S } from './strings.ts';

test('createApp({ strings }) overrides the front sentences and leaves the rest English', () => {
  createApp({ strings: { start: 'Привет' } });
  assert.equal(S.start, 'Привет');
  assert.equal(S.noOpen, 'No open cards.');
  resetStrings();
});
