// A reply to an item message, or a custom button: an inbound event that carries the item from the STORE (a rich message has no
// `text` field to quote), the item moves to "working", the line collapses. Owner only: the gate in app.ts drops everyone else before this runs.
import type { Item } from './contract.ts';
import { draftOf, replyOf } from './drafts.ts';
import { reconcile } from './reconcile.ts';
import { S, t } from './strings.ts';
import { applyWork, getByMessage } from './store.ts';
import type { Tg } from './tg.ts';

const KIND_KEY: Record<Item['kind'], string> = { decision: 'kind_decision', inbox: 'kind_inbox', digest: 'kind_digest', incident: 'kind_incident', meeting: 'kind_meeting' };
// The instruction of a custom button runs with these limits written into the request itself (a deployment may translate the line).
export const draftOnly = () => S.draft_only;

export interface ItemEvent {
  id: number; at: number; text: string; quoted: string;
  from: { id: number; name: string }; item: { id: string; kind: Item['kind']; title: string }; action?: string; files?: { file_id: string; kind: string; size?: number; name?: string; mime?: string }[];
}

export function context(item: Item): string {
  return `${S[KIND_KEY[item.kind]]} "${item.title}" (id ${item.id})${item.body ? `\n${item.body}` : ''}`.slice(0, 1500);
}

/** A reply to message `messageId` of this user. Null when the message is not an item of theirs. */
export async function replyEvent(db: D1Database, tg: Tg, q: { userId: number; name: string; messageId: number; text: string; eventId: number; voice?: boolean }, now: number, tz: string): Promise<ItemEvent | null> {
  const item = await getByMessage(db, q.userId, q.messageId);
  if (!item) return null;
  // A reply to a card that carries a drafted answer is an instruction to REWRITE it: its own action, the text (or the voice note) is the instruction.
  const fix = item.kind === 'decision' && ['new', 'shown'].includes(item.state) && (!!draftOf(item) || !!replyOf(item));
  const said = q.text.trim() || (q.voice ? S.voice_note : '');
  if (await applyWork(db, item, fix ? t('fixing', { said }).slice(0, 80) : q.text, now, `user:${q.userId}`, 'reply')) await reconcile(db, tg, q.userId, now, tz);
  return { id: q.eventId, at: now, text: fix ? `${FIX_HEAD}\n${q.text}` : q.text, quoted: context(item), from: { id: q.userId, name: q.name }, item: { id: item.id, kind: item.kind, title: item.title }, ...(fix ? { action: 'reply_fix' } : {}) };
}

export const REPLY_HEAD = 'reply_draft', FIX_HEAD = 'reply_fix';   // first line of the event text: the runner reads the verb from it, never from the model

/** The reply button: the card goes "working" and a P1 job writes the reply text. Null on a repeat press. The job reads and writes a file; a plain script makes the mail draft. */
export async function replyDraftEvent(db: D1Database, tg: Tg, item: Item, who: { userId: number; name: string }, now: number, tz: string): Promise<ItemEvent | null> {
  if (!(await applyWork(db, item, S.writing_reply, now, `user:${who.userId}`, 'button rp', true))) return null;
  await reconcile(db, tg, who.userId, now, tz);
  return { id: now, at: now, text: REPLY_HEAD, quoted: context(item), from: { id: who.userId, name: who.name }, action: 'reply_draft', item: { id: item.id, kind: item.kind, title: item.title } };
}

/** A custom button pressed: null on a repeat press (already working on that instruction). */
export async function buttonEvent(db: D1Database, tg: Tg, item: Item, c: { id: string; label: string; instruction: string }, who: { userId: number; name: string }, now: number, tz: string): Promise<ItemEvent | null> {
  if (!(await applyWork(db, item, c.instruction, now, `user:${who.userId}`, `button ${c.id}`, true))) return null;
  await reconcile(db, tg, who.userId, now, tz);
  return { id: now, at: now, text: `${c.instruction}\n\n${draftOnly()}`, quoted: context(item), from: { id: who.userId, name: who.name }, action: c.id,
    item: { id: item.id, kind: item.kind, title: item.title } };
}
