// What a deployment decides about its cards. The core ships neutral defaults (no groups, no reply button, no accounts); a private layer calls
// `configureCards({...})` once at startup (createApp's `cards` option does it). Everything here is data or a small pure function.
import type { Item } from './contract.ts';
import type { Op, Button } from './render.ts';
import type { ItemEvent } from './replies.ts';
import type { Tg } from './tg.ts';

export interface CardConfig {
  /** id prefix -> group, for ids like `gmail:...`; a card can also name its group in payload.group. */
  groups: Record<string, string>;
  /** group -> glyph in front of a decision title. */
  glyphs: Record<string, string>;
  /** groups whose open cards get the reply-draft button. Empty = the button is never offered. */
  replyGroups: string[];
  /** the card's own verb for the primary button when meta.verb is absent: [what meta.do starts with, the verb]. */
  verbByStem: [RegExp, string][];
  /** a card whose own action matches this is an answer: the reply button becomes the primary one. */
  answerDo: RegExp | null;
  /** card ids never muted by "not that kind" (payments, deadlines...). */
  unmutable: RegExp | null;
  /** draft account key -> label shown on the card. Empty = any account name of [a-z0-9_-]{1,16} is accepted. */
  accountLabels: Record<string, string>;
  /** the heading of the digest section that lists carried-over items. */
  hangingHeading: RegExp;
  /** a cost the card does not know: the effort question follows the closing tap. */
  costUnknown: RegExp | null;
  /** extra button rows under a card (a standup's energy row, for example). */
  extraRows?(item: Item, o: { menu: boolean | 'pick' | 'drop'; calm: boolean }): Button[][];
  /** a button whose action is not a plain state change (tier draft or task): return the toast, or null when this deployment does not handle it. */
  onAction?(c: { db: D1Database; tg: Tg; item: Item; action: string; now: number; tz: string; owner: number; name: string; enqueue?: (e: ItemEvent) => Promise<void> }): Promise<string | null>;
  /** last word on the ops of one render (a rest period holds sends back). */
  filterOps?(db: D1Database, userId: number, ops: Op[], now: number, tz: string): Promise<Op[]>;
  /** daily cap of cards on today/now that a waking card may join (default 5); a protected day may lower it. */
  todayCap?(db: D1Database, now: number, tz: string): Promise<number>;
}

const DEFAULT: CardConfig = {
  groups: {}, glyphs: {}, replyGroups: [], verbByStem: [], answerDo: /^(reply|answer|respond|write back)/i, unmutable: null, accountLabels: {},
  hangingHeading: /^hanging/i, costUnknown: /unknown/i,
};
export const cards: CardConfig = { ...DEFAULT };
export function configureCards(over: Partial<CardConfig>): void { Object.assign(cards, over); }
export function resetCards(): void { for (const k of Object.keys(cards)) delete (cards as unknown as Record<string, unknown>)[k]; Object.assign(cards, DEFAULT); }
