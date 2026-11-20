import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cmdNew, cmdSessions, cmdStop, filesOf, inbound, MAX_FILE, statusLine, switchTo } from './chat.ts';
import { pull, recordLiveSeen } from './queue.ts';
import { getSession, liveSession, recordMsg, resolveSession, setTarget } from './sessions.ts';
import { setPause } from './settings.ts';
import { makeDb } from './testkit.ts';

const U = 1, T = Date.UTC(2026, 0, 5, 12, 0), TZ = 'UTC';

test('a plain message opens the day\'s main session once and queues a P0 event in it', async () => {
  const db = makeDb(), env = { DB: db };
  const a = await inbound(env, { userId: U, messageId: 10, text: 'hello', files: [] }, T, TZ);
  assert.equal(a.created, true);
  const b = await inbound(env, { userId: U, messageId: 11, text: 'again', files: [] }, T + 1000, TZ);
  assert.equal(b.session.id, a.session.id);
  assert.equal(b.created, false);
  const e = (await pull(db, 'interactive', T + 2000))!;
  assert.equal(e.priority, 0);
  assert.equal(e.session_id, a.session.id);
  assert.equal(e.role, 'owner');
});

test('addressing: a reply goes to the session that message belongs to, then the chosen target, then the day\'s main', async () => {
  const db = makeDb(), env = { DB: db };
  const main = (await resolveSession(db, U, {}, T, TZ)).session;
  const other = (await cmdNew(env, U, 'research', T, TZ)).session;
  assert.equal((await resolveSession(db, U, {}, T, TZ)).session.id, other.id, '/new becomes today\'s target');
  await recordMsg(db, U, 500, main.id);
  const r = await resolveSession(db, U, { replyTo: 500 }, T, TZ);
  assert.deepEqual([r.session.id, r.how], [main.id, 'reply']);
  assert.equal((await resolveSession(db, U, {}, T + 86400e3, TZ)).session.id === other.id, false, 'the target lapses at midnight');
});

test('another user\'s session never resolves, and an unknown session cannot become the target', async () => {
  const db = makeDb();
  const mine = (await resolveSession(db, U, {}, T, TZ)).session;
  await recordMsg(db, 2, 77, mine.id);
  assert.notEqual((await resolveSession(db, 2, { replyTo: 77 }, T, TZ)).session.id, mine.id);
  assert.equal(await setTarget(db, 2, mine.id, T, TZ), false);
  assert.equal(await switchTo({ DB: db }, U, 'nope', T, TZ), 'No such session.');
});

test('/sessions lists newest first with the current one marked', async () => {
  const db = makeDb(), env = { DB: db };
  await resolveSession(db, U, {}, T, TZ);
  await cmdNew(env, U, 'second', T + 60_000, TZ);
  const r = await cmdSessions(env, U, T + 120_000, TZ);
  assert.match(r.text.split('\n')[0], /^1\. ▶ second · 1 min ago/);
  assert.equal(r.buttons.length, 2);
});

test('/stop hits the replied-to session, else the current one', async () => {
  const db = makeDb(), env = { DB: db };
  const a = await inbound(env, { userId: U, messageId: 1, text: 'work', files: [] }, T, TZ);
  await pull(db, 'interactive', T + 1);
  assert.match(await cmdStop(env, U, undefined, T + 2, TZ), /^Stopping "main 2026-01-05" \(up to 20 s\)/);
  assert.match(await cmdStop(env, U, 1, T + 3, TZ), /Stopping/);
  assert.equal(a.session.id.length, 12);
});

test('files: photos, documents and voice become references, video is declined, a file over 20 MB is refused with a line', async () => {
  const f = filesOf({ photo: [{ file_id: 'small' }, { file_id: 'big', file_size: 10 }], voice: { file_id: 'v', file_size: 5 }, video: {} });
  assert.deepEqual(f.files.map(x => x.kind), ['photo', 'voice']);
  assert.equal(f.files[0].file_id, 'big', 'the largest photo size');
  assert.deepEqual(f.unsupported, ['video']);
  const db = makeDb();
  const o = await inbound({ DB: db }, { userId: U, messageId: 3, text: '', files: [{ file_id: 'x', kind: 'document', size: MAX_FILE + 1, name: 'huge.bin' }] }, T, TZ);
  assert.equal(o.eventId, null);
  assert.match(o.refusals[0], /huge\.bin: larger than 20 MB/);
});

test('during the usage-limit pause the message is queued and the owner hears it once per pause', async () => {
  const db = makeDb(), env = { DB: db };
  await setPause(db, Math.floor((T + 3600e3) / 1000));
  const a = await inbound(env, { userId: U, messageId: 1, text: 'one', files: [] }, T, TZ);
  assert.match(a.pauseLine!, /^Claude usage limit until 13:00, your message is queued/);
  assert.equal((await inbound(env, { userId: U, messageId: 2, text: 'two', files: [] }, T + 1, TZ)).pauseLine, null);
  assert.match(await statusLine(env, T, TZ), /Queue: P0: 2; running: 0\.\nClaude usage limit until 13:00/);
});

test('the live session is reused by title and becomes the target', async () => {
  const db = makeDb();
  const a = await liveSession(db, U, 'terminal', T, TZ), b = await liveSession(db, U, 'terminal', T + 1, TZ);
  assert.equal(a.id, b.id);
  assert.equal((await getSession(db, a.id))!.workflow, 'live');
  assert.equal((await resolveSession(db, U, {}, T, TZ)).session.id, a.id);
});

test('an attached live session stays the target across the day boundary; a dead or non-live target does not', async () => {
  const db = makeDb();
  const live = await liveSession(db, U, 'terminal', T, TZ);
  const next = T + 24 * 3600e3;
  await recordLiveSeen(db, live.id, next - 5000);   // the channel is polling
  assert.equal((await resolveSession(db, U, {}, next, TZ)).session.id, live.id, 'still the live terminal after midnight');
  const later = next + 3600e3;   // no pull for an hour: detached by itself
  const m = await resolveSession(db, U, {}, later, TZ);
  assert.equal(m.how, 'main');
  assert.notEqual(m.session.id, live.id);
  const plain = (await cmdNew({ DB: db }, U, 'r', T, TZ)).session;   // a /new target is a today-only choice
  assert.notEqual((await resolveSession(db, U, {}, next, TZ)).session.id, plain.id);
});
