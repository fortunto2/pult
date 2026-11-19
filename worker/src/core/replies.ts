// A reply to an item message, or a custom button: an inbound event that carries the item from the STORE (so the model sees the card it is about),
// the item moves to "working", the line collapses. Owner only: the gate in index.ts drops everyone else before this runs.
import type { Item } from './contract.ts';
import { reconcile } from './reconcile.ts';
import { applyWork, getByMessage } from './store.ts';
import type { Tg } from './tg.ts';

const KIND_LABEL: Record<Item['kind'], string> = { decision: 'Decision', inbox: 'Inbox', digest: 'Note', incident: 'Incident', meeting: 'Meeting' };
// The instruction of a custom button runs with these limits written into the request itself, on top of the tool rules the runner enforces.
export const DRAFT_ONLY = '[button job: read and draft only; send nothing, pay nothing, cancel nothing, delete nothing]';

export interface ItemEvent {
  id: number; at: number; text: string; quoted: string;
  from: { id: number; name: string }; item: { id: string; kind: Item['kind']; title: string }; action?: string;
}

export function context(item: Item): string {
  return `${KIND_LABEL[item.kind]} "${item.title}" (id ${item.id})${item.body ? `\n${item.body}` : ''}`.slice(0, 1500);
}

/** A reply to message `messageId`. Null when the message is not an item. */
export async function replyEvent(db: D1Database, tg: Tg, q: { userId: number; name: string; messageId: number; text: string; eventId: number }, now: number, tz: string): Promise<ItemEvent | null> {
  const item = await getByMessage(db, q.userId, q.messageId);
  if (!item) return null;
  if (await applyWork(db, item, q.text, now, `user:${q.userId}`, 'reply')) await reconcile(db, tg, q.userId, now, tz);
  return { id: q.eventId, at: now, text: q.text, quoted: context(item), from: { id: q.userId, name: q.name }, item: { id: item.id, kind: item.kind, title: item.title }, action: 'reply' };
}

/** A custom button pressed: null on a repeat press (already working on that instruction). */
export async function buttonEvent(db: D1Database, tg: Tg, item: Item, c: { id: string; label: string; instruction: string }, who: { userId: number; name: string }, now: number, tz: string): Promise<ItemEvent | null> {
  if (!(await applyWork(db, item, c.instruction, now, `user:${who.userId}`, `button ${c.id}`, true))) return null;
  await reconcile(db, tg, who.userId, now, tz);
  return { id: now, at: now, text: `${c.instruction}\n\n${DRAFT_ONLY}`, quoted: context(item), from: { id: who.userId, name: who.name }, action: c.id,
    item: { id: item.id, kind: item.kind, title: item.title } };
}
