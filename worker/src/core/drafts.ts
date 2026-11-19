// Send-on-confirm for drafts of outgoing mail. The one card button that sends something: a draft, after two taps by the owner, from the runner, as stored.
// The worker never holds mail credentials. It shows the draft (payload.draft, pushed by the runner), runs the two-step confirm, records the send (draft_sends = audit +
// idempotency key) and queues an owner event that the runner hands to a plain send script: no model sees the mail between the tap and the send.
import type { Item } from './contract.ts';
import { cards } from './cardconfig.ts';
import { getItem, applyAction } from './store.ts';
import { S, t } from './strings.ts';

/** The label of a draft account on the card: the configured one, else the key itself. */
export const accountLabel = (key: string) => cards.accountLabels[key] ?? key;
export const DEFAULT_SENDS_PER_DAY = 10;
export const CONFIRM_TTL_MS = 10 * 60e3;   // an open confirm question goes back to the plain card after this long

export interface DraftInfo { account: string; id: string; to: string; cc: string; subject: string; body: string; more: number; attachments: string[]; hash: string; task?: { ref: string; ball: string }; missing?: string }
export type DraftPhase = 'ready' | 'confirm' | 'sending' | 'sent' | 'failed' | 'refused';
export interface DraftState { s: DraftPhase; at: number; note?: string; to?: string }
export const draftOf = (item: Item): DraftInfo | null => ((item.payload as { draft?: DraftInfo } | null)?.draft ?? null);
export const phaseOf = (item: Item): DraftState => ((item.payload as { draft_state?: DraftState } | null)?.draft_state ?? { s: 'ready', at: 0 });

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);
/** What the runner pushes: validated again here, the account and ids are closed sets and shapes. The hash is the runner's (sha256 over to, cc, subject, body and attachment names). */
export function parseDraft(raw: unknown): DraftInfo | string {
  const b = (raw ?? {}) as Record<string, unknown>;
  const account = String(b.account ?? '');
  const known = Object.keys(cards.accountLabels);
  if (known.length ? !known.includes(account) : !/^[a-z0-9_-]{1,16}$/.test(account)) return `account: ${known.length ? known.join('|') : '[a-z0-9_-]{1,16}'}`;
  const id = String(b.id ?? '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return 'id: the mail provider\'s draft id';
  const hash = String(b.hash ?? '');
  if (!/^[0-9a-f]{64}$/.test(hash)) return 'hash: sha256 hex';
  const to = str(b.to, 500), cc = str(b.cc ?? '', 500), subject = str(b.subject ?? '', 300), body = str(b.body ?? '', 3600);
  if (!to || !to.trim()) return 'to: required, up to 500 chars';
  if (cc === null || subject === null || body === null) return 'cc/subject/body too long';
  const more = Math.floor(Number(b.more ?? 0));
  if (!(more >= 0 && more <= 20)) return 'more: 0..20';
  const att = Array.isArray(b.attachments) ? b.attachments : [];
  if (att.length > 20 || att.some(a => typeof a !== 'string' || a.length > 120)) return 'attachments: up to 20 names';
  let task: DraftInfo['task'];
  if (b.task !== undefined && b.task !== null) {
    const t = b.task as Record<string, unknown>;
    if (typeof t.ref !== 'string' || !/^[a-z0-9][a-z0-9-]{0,60}(#\d{1,3})?$/.test(t.ref) || typeof t.ball !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(t.ball)) return 'task: {ref: topic[#n], ball: who}';
    task = { ref: t.ref, ball: t.ball };
  }
  const missing = str(b.missing ?? '', 300);
  if (missing === null) return 'missing: up to 300 chars';
  return { account, id, to: to.trim(), cc: cc.trim(), subject: subject.trim(), body, more, attachments: att as string[], hash, ...(task ? { task } : {}), ...(missing.trim() ? { missing: missing.trim() } : {}) };
}

// A reply drafted for a chat or social card. No send path exists and none is added: the text is shown with a copy button, the owner sends it himself.
export interface ReplyDraft { text: string; hash: string; missing?: string; at: number }
export const replyOf = (item: Item): ReplyDraft | null => ((item.payload as { reply?: ReplyDraft } | null)?.reply ?? null);
export const COPY_MAX = 256;   // Bot API: a copy_text button holds 1-256 characters
export function parseReply(raw: unknown, now: number): ReplyDraft | string {
  const b = (raw ?? {}) as Record<string, unknown>;
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text || text.length > 3500) return 'text: 1..3500 chars';
  const hash = String(b.hash ?? '');
  if (!/^[0-9a-f]{64}$/.test(hash)) return 'hash: sha256 hex';
  const missing = typeof b.missing === 'string' ? b.missing.trim() : '';
  if (missing.length > 300) return 'missing: up to 300 chars';
  return { text, hash, at: now, ...(missing ? { missing } : {}) };
}

async function patch(db: D1Database, item: Item, draft: DraftInfo | undefined, state: DraftState, now: number, note: string, extra: Record<string, unknown> = {}): Promise<boolean> {
  const payload = { ...((item.payload ?? {}) as Record<string, unknown>), ...(draft ? { draft } : {}), ...extra, draft_state: state };
  const res = await db.batch([
    db.prepare('UPDATE items SET payload = ? WHERE user_id = ? AND id = ?').bind(JSON.stringify(payload), item.user_id, item.id),
    db.prepare('INSERT INTO item_log (user_id, item_id, at, from_state, to_state, by, note) SELECT ?,?,?,?,?,?,? WHERE changes() > 0').bind(item.user_id, item.id, now, item.state, item.state, 'draft', note),
  ]);
  return res[0].meta.changes > 0;
}

/** The runner attaches (or refreshes) the draft shown in a card. `changed` is false when the same content is already there (the caller then sends no continuation again). */
export async function attachDraft(db: D1Database, item: Item, draft: DraftInfo, now: number, ring = false): Promise<{ ok: boolean; changed: boolean }> {
  const had = draftOf(item);
  const same = !!had && had.hash === draft.hash && JSON.stringify(had) === JSON.stringify(draft);
  if (same && phaseOf(item).s !== 'refused') return { ok: true, changed: false };
  const ok = await patch(db, item, draft, { s: 'ready', at: now }, now, `draft attached ${draft.account}:${draft.id} ${draft.hash.slice(0, 8)}`, ring ? { ring_at: now } : {});
  return { ok, changed: true };
}

/** The reply text of a chat card (the runner pushes it). `ring`: the card is sent again with a notification (render.ts), once. */
export async function attachReply(db: D1Database, item: Item, reply: ReplyDraft, now: number, ring = false): Promise<{ ok: boolean; changed: boolean }> {
  const had = replyOf(item);
  if (had && had.hash === reply.hash && (had.missing ?? '') === (reply.missing ?? '')) return { ok: true, changed: false };
  const payload = { ...((item.payload ?? {}) as Record<string, unknown>), reply, ...(ring ? { ring_at: now } : {}) };
  const res = await db.batch([
    db.prepare('UPDATE items SET payload = ? WHERE user_id = ? AND id = ?').bind(JSON.stringify(payload), item.user_id, item.id),
    db.prepare('INSERT INTO item_log (user_id, item_id, at, from_state, to_state, by, note) SELECT ?,?,?,?,?,?,? WHERE changes() > 0').bind(item.user_id, item.id, now, item.state, item.state, 'draft', `reply drafted ${reply.hash.slice(0, 8)}`),
  ]);
  return { ok: res[0].meta.changes > 0, changed: true };
}

export async function sendsToday(db: D1Database, now: number, tz: string): Promise<number> {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date(now)).map(x => [x.type, x.value]));
  const sinceMidnight = (Number(p.hour) % 24) * 3600e3 + Number(p.minute) * 60e3 + Number(p.second) * 1000;
  return (await db.prepare("SELECT COUNT(*) AS n FROM draft_sends WHERE created_at >= ? AND state IN ('queued','sending','sent')").bind(now - sinceMidnight).first<{ n: number }>())?.n ?? 0;
}

export type Tap = { toast: string; render: boolean; event?: { row: number } };
const NOT_NOW = () => S.not_allowed;

/** Step 1 "Send": the card turns into the question "Really send to <To>?". Nothing is queued yet. */
export async function tapSend(db: D1Database, item: Item, now: number): Promise<Tap> {
  const d = draftOf(item);
  if (!d || !['new', 'shown'].includes(item.state)) return { toast: NOT_NOW(), render: false };
  const ph = phaseOf(item).s;
  if (ph === 'sending') return { toast: S.send_already_sending, render: false };
  if (ph === 'sent') return { toast: S.send_already_sent, render: false };
  if (!(await patch(db, item, undefined, { s: 'confirm', at: now }, now, 'confirm asked'))) return { toast: NOT_NOW(), render: false };
  return { toast: t('send_confirm_q', { to: d.to }).slice(0, 190), render: true };
}

export async function tapCancel(db: D1Database, item: Item, now: number): Promise<Tap> {
  if (!draftOf(item) || phaseOf(item).s !== 'confirm') return { toast: S.already_handled, render: false };
  await patch(db, item, undefined, { s: 'ready', at: now }, now, 'confirm cancelled');
  return { toast: S.cancelled, render: true };
}

/** Step 2 "Yes, send": the callback carries the first 12 hex of the hash shown on the card; the stored draft must still be that one. The row (UNIQUE draft_id+hash) is the idempotency key. */
export async function tapConfirm(db: D1Database, item: Item, hash12: string, now: number, tz: string, cap: number): Promise<Tap> {
  const d = draftOf(item), ph = phaseOf(item);
  if (!d || !['new', 'shown'].includes(item.state)) return { toast: NOT_NOW(), render: false };
  if (ph.s === 'sending') return { toast: S.send_already_sending, render: false };
  if (ph.s === 'sent') return { toast: S.send_already_sent, render: false };
  if (ph.s !== 'confirm' || now - ph.at > CONFIRM_TTL_MS) {
    if (ph.s === 'confirm') await patch(db, item, undefined, { s: 'ready', at: now }, now, 'confirm expired');
    return { toast: S.send_confirm_expired, render: ph.s === 'confirm' };
  }
  if (d.hash.slice(0, 12) !== hash12) return { toast: S.send_card_changed, render: false };
  const prev = await db.prepare('SELECT id, state, reason FROM draft_sends WHERE draft_id = ? AND hash = ?').bind(d.id, d.hash).first<{ id: number; state: string; reason: string | null }>();
  if (prev && (prev.state === 'sent')) { await patch(db, item, undefined, { s: 'sent', at: now, to: d.to }, now, 'tap on a sent draft'); return { toast: S.send_already_sent, render: true }; }
  if (prev && (prev.state === 'queued' || prev.state === 'sending')) return { toast: S.send_already_sending, render: false };
  if ((await sendsToday(db, now, tz)) >= cap) {
    await patch(db, item, undefined, { s: 'ready', at: now, note: t('send_cap_note', { cap }) }, now, 'daily cap');
    return { toast: t('send_cap_toast', { cap }), render: true };
  }
  let row: number;
  if (prev) {   // a failed or refused earlier try for the same draft and content (a Bcc removed since, a network error): the same row again, and the runner re-checks everything
    const r = await db.prepare("UPDATE draft_sends SET state = 'queued', reason = NULL, updated_at = ? WHERE id = ? AND state IN ('failed','refused')").bind(now, prev.id).run();
    if (!r.meta.changes) return { toast: S.already_running, render: false };
    row = prev.id;
  } else {
    const r = await db.prepare("INSERT OR IGNORE INTO draft_sends (user_id, item_id, account, draft_id, hash, to_addr, cc, subject, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,'queued',?,?)")
      .bind(item.user_id, item.id, d.account, d.id, d.hash, d.to, d.cc, d.subject, now, now).run();
    if (!r.meta.changes) return { toast: S.already_running, render: false };   // a second tap raced this one
    row = Number(r.meta.last_row_id);
  }
  await patch(db, item, undefined, { s: 'sending', at: now }, now, `send queued #${row}`);
  return { toast: S.sending_toast, render: true, event: { row } };
}

export interface SendRow { id: number; user_id: number; item_id: string; account: string; draft_id: string; hash: string; to_addr: string; cc: string | null; subject: string | null; state: string; reason: string | null; gmail_id: string | null; event_id: number | null; created_at: number; updated_at: number; sent_at: number | null }
export const getSend = (db: D1Database, id: number) => db.prepare('SELECT * FROM draft_sends WHERE id = ?').bind(id).first<SendRow>();

/** The runner asks to start: queued -> sending (the state is on record BEFORE the Gmail call). `recover` when it was already sending (a crash between the call and the record). */
export async function claimSend(db: D1Database, id: number, eventId: number | null, now: number): Promise<{ ok: boolean; state: string; recover?: boolean }> {
  const r = await db.prepare("UPDATE draft_sends SET state = 'sending', event_id = ?, updated_at = ? WHERE id = ? AND state = 'queued'").bind(eventId, now, id).run();
  if (r.meta.changes) return { ok: true, state: 'sending' };
  const row = await getSend(db, id);
  if (row?.state === 'sending') return { ok: true, state: 'sending', recover: true };
  return { ok: false, state: row?.state ?? 'missing' };
}

/** The runner's verdict. sent: the card collapses to "Sent HH:MM → To" and the item is settled; refused/failed: the card returns with the reason (a changed draft arrives through attachDraft first). */
export async function finishSend(db: D1Database, id: number, b: { state?: string; reason?: string; gmail_id?: string }, now: number, tz: string): Promise<{ ok: boolean; item?: Item }> {
  const row = await getSend(db, id);
  if (!row || !['sent', 'refused', 'failed'].includes(String(b.state))) return { ok: false };
  if (row.state === 'sent') return { ok: true };   // never downgrade a send that happened
  const state = String(b.state), reason = String(b.reason ?? '').slice(0, 300) || null;
  await db.prepare('UPDATE draft_sends SET state = ?, reason = ?, gmail_id = COALESCE(?, gmail_id), updated_at = ?, sent_at = CASE WHEN ? = ? THEN ? ELSE sent_at END WHERE id = ?')
    .bind(state, reason, b.gmail_id ?? null, now, state, 'sent', now, id).run();
  const item = await getItem(db, row.user_id, row.item_id);
  if (!item) return { ok: true };
  if (state === 'sent') {
    await patch(db, item, undefined, { s: 'sent', at: now, to: row.to_addr }, now, `sent ${row.account}:${row.draft_id} -> ${row.to_addr}`);
    const fresh = await getItem(db, row.user_id, row.item_id);
    if (fresh && ['new', 'shown', 'snoozed'].includes(fresh.state)) await applyAction(db, { ...fresh, actions: [...fresh.actions, 'done'] }, 'done', now, 'draft', tz);
    return { ok: true, item: (await getItem(db, row.user_id, row.item_id)) ?? undefined };
  }
  await patch(db, item, undefined, { s: state === 'refused' ? 'refused' : 'failed', at: now, note: reason ?? '' }, now, `${state}: ${reason ?? ''}`);
  return { ok: true, item: (await getItem(db, row.user_id, row.item_id)) ?? undefined };
}

export async function listSends(db: D1Database, limit = 30): Promise<SendRow[]> {
  return (await db.prepare('SELECT * FROM draft_sends ORDER BY id DESC LIMIT ?').bind(Math.min(Math.max(limit, 1), 200)).all<SendRow>()).results;
}

export const STALE_SEND_MS = 30 * 60e3;
/** Hourly: a send that never reached the runner, or one it started and never recorded, goes back to the card as "failed" (never silently resent: the runner checks the draft and the sent folder first). */
export async function expireStaleSends(db: D1Database, now: number, tz: string): Promise<number> {
  const { results } = await db.prepare("SELECT id, state FROM draft_sends WHERE state IN ('queued','sending') AND updated_at < ?").bind(now - STALE_SEND_MS).all<{ id: number; state: string }>();
  let n = 0;
  for (const r of results) {
    const reason = r.state === 'queued' ? S.send_stale_queued : S.send_stale_sending;
    if ((await finishSend(db, r.id, { state: 'failed', reason }, now, tz)).ok) n++;
  }
  return n;
}
