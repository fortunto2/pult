import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signEd25519, signHmac, validateHmac, validateInitData, validateSignature } from './initdata.ts';

const NOW = 1_800_000_000_000, auth = (s: number) => String(Math.floor(NOW / 1000) - s), user = JSON.stringify({ id: 42, first_name: 'x' });
const TOKEN = '123456:token';
const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
const pubHex = [...new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey) as ArrayBuffer)].map(b => b.toString(16).padStart(2, '0')).join('');

test('HMAC: a signed initData passes, a tampered or foreign one does not', async () => {
  const good = await signHmac({ auth_date: auth(10), user, start_param: 'card_abc' }, TOKEN);
  const r = await validateHmac(good, TOKEN, NOW);
  assert.ok(r.ok && r.user.id === 42 && r.startParam === 'card_abc' && r.via === 'hmac');
  assert.deepEqual(await validateHmac(good, '999:other', NOW), { ok: false, reason: 'bad_hash' });
  assert.deepEqual(await validateHmac(good.replace('42', '43'), TOKEN, NOW), { ok: false, reason: 'bad_hash' });
  assert.deepEqual(await validateHmac('auth_date=1', TOKEN, NOW), { ok: false, reason: 'malformed' });
  assert.deepEqual(await validateHmac(good, '', NOW), { ok: false, reason: 'malformed' });
});

test('the one-hour window: 59 minutes pass, 61 do not, and a date from the future is refused', async () => {
  assert.ok((await validateHmac(await signHmac({ auth_date: auth(59 * 60), user }, TOKEN), TOKEN, NOW)).ok);
  assert.deepEqual(await validateHmac(await signHmac({ auth_date: auth(61 * 60), user }, TOKEN), TOKEN, NOW), { ok: false, reason: 'expired' });
  assert.deepEqual(await validateHmac(await signHmac({ auth_date: auth(-3600), user }, TOKEN), TOKEN, NOW), { ok: false, reason: 'expired' });
});

test('Ed25519: validates with only the bot id and the public key, never the token', async () => {
  const good = await signEd25519({ auth_date: auth(5), user, query_id: 'q' }, '123456', keys.privateKey);
  const r = await validateSignature(good, '123456', NOW, pubHex);
  assert.ok(r.ok && r.user.id === 42 && r.via === 'ed25519');
  assert.deepEqual(await validateSignature(good, '777', NOW, pubHex), { ok: false, reason: 'bad_signature' }, 'another bot id');
  assert.deepEqual(await validateSignature(good.replace('query_id=q', 'query_id=z'), '123456', NOW, pubHex), { ok: false, reason: 'bad_signature' }, 'tampered');
  const stranger = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  assert.deepEqual(await validateSignature(await signEd25519({ auth_date: auth(5), user }, '123456', stranger.privateKey), '123456', NOW, pubHex), { ok: false, reason: 'bad_signature' }, 'signed by another key');
  assert.deepEqual(await validateSignature(await signEd25519({ auth_date: auth(7200), user }, '123456', keys.privateKey), '123456', NOW, pubHex), { ok: false, reason: 'expired' });
});

test('validateInitData picks the check from the data and the mode; a bad signature is not retried as HMAC', async () => {
  const sig = await signEd25519({ auth_date: auth(5), user }, '123456', keys.privateKey);
  assert.ok((await validateInitData(sig, { botToken: TOKEN, publicKeyHex: pubHex }, NOW)).ok, 'bot id taken from the token');
  assert.ok((await validateInitData(sig, { botId: '123456', publicKeyHex: pubHex }, NOW)).ok, 'no token at all');
  const hmacOnly = await signHmac({ auth_date: auth(5), user }, TOKEN);
  assert.ok((await validateInitData(hmacOnly, { botToken: TOKEN }, NOW)).ok);
  assert.equal((await validateInitData(hmacOnly, { botToken: TOKEN, mode: 'ed25519' }, NOW)).ok, false, 'ed25519-only refuses HMAC-only data');
  assert.equal((await validateInitData(sig, { botToken: TOKEN, mode: 'hmac', publicKeyHex: pubHex }, NOW)).ok, false, 'hmac-only refuses signature-only data');
  assert.equal((await validateInitData(sig, { botToken: TOKEN }, NOW)).ok, false, 'default key is Telegram\'s, not ours');
});
