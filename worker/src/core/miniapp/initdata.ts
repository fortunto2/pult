// Telegram Mini App initData validation, both documented ways (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
//   1. HMAC with the bot token (`hash`): for the bot's own deployment.
//   2. Ed25519 `signature` with Telegram's public key and the bot id, no token needed (third-party validation, Bot API 8.0): for a shared public app.
// Pure: no I/O. The caller decides what a valid user may do (pult: only the owner).
export interface InitUser { id: number; first_name?: string; username?: string }
export type InitResult = { ok: true; user: InitUser; authDate: number; startParam: string | null; via: 'hmac' | 'ed25519' } | { ok: false; reason: 'malformed' | 'bad_hash' | 'bad_signature' | 'expired' | 'no_user' };

export const MAX_AGE_S = 3600;
/** Telegram's production Ed25519 public key for initData signatures (the value published on the webapps page). */
export const TELEGRAM_PROD_PUBLIC_KEY = 'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d';

const enc = new TextEncoder();
const hmac = async (key: ArrayBuffer | Uint8Array, msg: string) => {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
};
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const fromHex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], h => parseInt(h, 16));
const fromB64Url = (s: string) => { const t = s.replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(t + '='.repeat((4 - t.length % 4) % 4)), c => c.charCodeAt(0)); };
function sameHex(a: string, b: string): boolean {   // constant time over equal-length strings
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const checkString = (p: URLSearchParams, drop: string[]) => [...p.entries()].filter(([k]) => !drop.includes(k)).map(([k, v]) => `${k}=${v}`).sort().join('\n');

function finish(p: URLSearchParams, nowMs: number, maxAgeS: number, via: 'hmac' | 'ed25519'): InitResult {
  const authDate = Number(p.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate <= 0 || nowMs / 1000 - authDate > maxAgeS || authDate - nowMs / 1000 > 300) return { ok: false, reason: 'expired' };
  try {
    const user = JSON.parse(p.get('user') ?? '') as InitUser;
    if (typeof user.id !== 'number') return { ok: false, reason: 'no_user' };
    return { ok: true, user, authDate, startParam: p.get('start_param'), via };
  } catch { return { ok: false, reason: 'no_user' }; }
}

export async function validateHmac(raw: string, botToken: string, nowMs: number, maxAgeS = MAX_AGE_S): Promise<InitResult> {
  if (!raw || !botToken) return { ok: false, reason: 'malformed' };
  const p = new URLSearchParams(raw), hash = p.get('hash');
  if (!hash) return { ok: false, reason: 'malformed' };
  const secret = await hmac(enc.encode('WebAppData'), botToken);
  if (!sameHex(hex(await hmac(secret, checkString(p, ['hash']))), hash.toLowerCase())) return { ok: false, reason: 'bad_hash' };
  return finish(p, nowMs, maxAgeS, 'hmac');
}

/** Third-party validation: data-check string is `<bot_id>:WebAppData\n` + the sorted pairs without `hash` and `signature`. */
export async function validateSignature(raw: string, botId: string, nowMs: number, publicKeyHex = TELEGRAM_PROD_PUBLIC_KEY, maxAgeS = MAX_AGE_S): Promise<InitResult> {
  if (!raw || !/^\d+$/.test(botId)) return { ok: false, reason: 'malformed' };
  const p = new URLSearchParams(raw), sig = p.get('signature');
  if (!sig) return { ok: false, reason: 'malformed' };
  try {
    const key = await crypto.subtle.importKey('raw', fromHex(publicKeyHex) as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, fromB64Url(sig) as BufferSource, enc.encode(`${botId}:WebAppData\n${checkString(p, ['hash', 'signature'])}`));
    if (!ok) return { ok: false, reason: 'bad_signature' };
  } catch { return { ok: false, reason: 'bad_signature' }; }
  return finish(p, nowMs, maxAgeS, 'ed25519');
}

/** Either way: the Ed25519 signature when the data carries one and a bot id is known, else the HMAC. A bad signature is not retried as HMAC. */
export async function validateInitData(raw: string, o: { botToken?: string; botId?: string; publicKeyHex?: string; mode?: 'hmac' | 'ed25519' | 'both' }, nowMs: number): Promise<InitResult> {
  const mode = o.mode ?? 'both', botId = o.botId || (o.botToken ?? '').split(':')[0];
  const hasSig = new URLSearchParams(raw).has('signature');
  if ((mode === 'ed25519' || (mode === 'both' && hasSig && botId)) && hasSig) return validateSignature(raw, botId, nowMs, o.publicKeyHex);
  if (mode === 'ed25519') return { ok: false, reason: 'malformed' };
  return validateHmac(raw, o.botToken ?? '', nowMs);
}

/** Test helpers and the signer for a local smoke test: build valid initData with a token (HMAC) or with an Ed25519 private key. */
export async function signHmac(fields: Record<string, string>, botToken: string): Promise<string> {
  const secret = await hmac(enc.encode('WebAppData'), botToken);
  return new URLSearchParams({ ...fields, hash: hex(await hmac(secret, checkString(new URLSearchParams(fields), []))) }).toString();
}
export async function signEd25519(fields: Record<string, string>, botId: string, privateKey: CryptoKey): Promise<string> {
  const data = enc.encode(`${botId}:WebAppData\n${checkString(new URLSearchParams(fields), [])}`);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, data));
  const b64 = btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return new URLSearchParams({ ...fields, signature: b64 }).toString();
}
