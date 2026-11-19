import assert from 'node:assert/strict';
import { test } from 'node:test';
import { say } from './say.ts';
import { makeDb } from './testkit.ts';

function fixture() {
  const calls: { m: string; a: unknown[] }[] = [];
  let next = 500, failEdit: string | null = null;
  const rec = (m: string, f?: () => unknown) => async (...a: unknown[]) => { calls.push({ m, a }); return f ? f() : { message_id: ++next }; };
  const api = {
    sendMessage: rec('sendMessage'), sendPhoto: rec('sendPhoto'), sendDocument: rec('sendDocument'), deleteMessage: rec('deleteMessage', () => true),
    editMessageText: rec('editMessageText', () => { if (failEdit) throw new Error(failEdit); return true; }),
  };
  const ctx = { env: { CHAT_ID: '42' }, db: makeDb(), api, now: 1_700_000_000_000 } as never;
  return { calls, ctx, failEdit: (m: string | null) => { failEdit = m; } };
}
const idOf = async (r: Response) => ((await r.json()) as { message_id: number }).message_id;

test('a plain message, silent and as a reply', async () => {
  const f = fixture();
  assert.equal(await idOf(await say({ text: 'hi', silent: true, reply_to: 7 }, f.ctx, [])), 501);
  const o = f.calls[0].a[2] as Record<string, unknown>;
  assert.equal(o.disable_notification, true);
  assert.deepEqual(o.reply_parameters, { message_id: 7, allow_sending_without_reply: true });
  assert.equal((await say({ text: '  ' }, f.ctx, [])).status, 400);
});

test('a keyed message is edited in place; replace deletes the old one and sends a new one; a vanished one is sent anew', async () => {
  const f = fixture();
  const a = await idOf(await say({ text: 'v1', key: 'k' }, f.ctx, []));
  assert.equal(await idOf(await say({ text: 'v2', key: 'k' }, f.ctx, [])), a);
  assert.equal(f.calls.at(-1)!.m, 'editMessageText');
  const b = await idOf(await say({ text: 'v3', key: 'k', replace: true }, f.ctx, []));
  assert.notEqual(b, a);
  assert.deepEqual(f.calls.slice(-2).map(c => c.m), ['deleteMessage', 'sendMessage']);
  f.failEdit('Bad Request: message to edit not found');
  const c = await idOf(await say({ text: 'v4', key: 'k' }, f.ctx, []));
  assert.notEqual(c, b, 'the edit failed: sent anew');
  f.failEdit('Bad Request: message is not modified');
  assert.equal(await idOf(await say({ text: 'v4', key: 'k' }, f.ctx, [])), c, 'not modified is success');
});

test('photo and document carry the text as a caption cut at 1000', async () => {
  const f = fixture();
  const b64 = btoa('PNG');
  await say({ text: 'x'.repeat(1500), photo_b64: b64 }, f.ctx, []);
  assert.equal(f.calls[0].m, 'sendPhoto');
  assert.equal(((f.calls[0].a[2] as { caption: string }).caption).length, 1000);
  await say({ text: 'report', doc_b64: b64, doc_name: 'r.pdf' }, f.ctx, []);
  assert.equal(f.calls[1].m, 'sendDocument');
});

test('old callers\' fields (issue, topic, thread) are ignored; the keyboard comes from the app option and only on request', async () => {
  const f = fixture();
  const kb = { keyboard: [[{ text: 'Status' }]], resize_keyboard: true };
  await say({ text: 'a', issue: 12, topic: 'T', thread: 3 }, f.ctx, [], kb);
  assert.equal((f.calls[0].a[2] as Record<string, unknown>).reply_markup, undefined);
  await say({ text: 'b', keyboard: true }, f.ctx, [], kb);
  assert.deepEqual((f.calls[1].a[2] as Record<string, unknown>).reply_markup, kb);
});

test('a before hook can refuse or swallow a message; nothing is sent', async () => {
  const f = fixture();
  const wall = { before: async (_c: unknown, b: Record<string, unknown>) => (String(b.text).includes('secret') ? Response.json({ error: 'refused' }, { status: 403 }) : null) };
  assert.equal((await say({ text: 'a secret' }, f.ctx, [wall])).status, 403);
  assert.equal(f.calls.length, 0);
  assert.equal((await say({ text: 'fine' }, f.ctx, [wall])).status, 200);
});
