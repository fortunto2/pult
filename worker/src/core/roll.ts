// Structure instead of a paragraph: a roll-up (inbox, channels, standup, promo) arrives as
// FIELDS (payload.roll), and this file builds the message from them, so the layout does not depend on the model remembering it. Free prose is never the body of a roll-up.
import type { Item } from './contract.ts';
import { S, t } from './strings.ts';

export interface RollItem { b?: string; t: string; url?: string; label?: string }
export interface RollSection { h: string; items: RollItem[]; fold?: boolean }
export interface Roll { sections: RollSection[]; quote?: string }
export interface MetaFields { do?: string; why?: string; cost?: string; due?: string; hard_due?: string; verb?: string; answers?: { label: string; value: string }[] }

export const MAX_ITEM = 140, MAX_BOLD = 40, MAX_SECTION_ITEMS = 8, VISIBLE_BUDGET = 900;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s: string) => esc(s).replace(/"/g, '&quot;');
const cut = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
const str = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? cut(v, n) : undefined);
const https = (v: unknown) => (typeof v === 'string' && /^https:\/\/\S+$/.test(v) && v.length <= 500 ? v : undefined);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The sanitised roll from a job's payload, or null (not a roll). Every field is cut and every url must be https: nothing the model writes reaches the HTML as markup. */
export function parseRoll(x: unknown): Roll | null {
  if (!x || typeof x !== 'object' || !Array.isArray((x as Roll).sections)) return null;
  const sections: RollSection[] = [];
  for (const s of (x as Roll).sections.slice(0, 12)) {
    const h = str(s?.h, 60);
    if (!h || !Array.isArray(s.items)) continue;
    const items: RollItem[] = [];
    for (const i of s.items.slice(0, 60)) {
      const t = str(i?.t, MAX_ITEM * 2);
      if (t) items.push({ t, b: str(i.b, MAX_BOLD), url: https(i.url), label: str(i.label, 60) });
    }
    sections.push({ h, items, fold: s.fold === true });
  }
  return { sections, quote: str((x as Roll).quote, 1500) };
}

export function parseMeta(x: unknown): MetaFields | null {
  if (!x || typeof x !== 'object') return null;
  const m = x as Record<string, unknown>, out: MetaFields = {};
  for (const k of ['do', 'why', 'cost'] as const) { const v = str(m[k], k === 'do' ? 90 : 160); if (v) out[k] = v; }
  for (const k of ['due', 'hard_due'] as const) if (typeof m[k] === 'string' && DATE.test(m[k] as string)) out[k] = m[k] as string;
  const verb = str(m.verb, 16); if (verb) out.verb = verb;   // the card's own primary verb ("Paid"), never a generic one when a better exists
  if (Array.isArray(m.answers)) {   // a closed question: the answers themselves are the buttons (at most 3), the reply is recorded as the item's result
    const a = m.answers.slice(0, 3).map(x => ({ label: str((x as Record<string, unknown>)?.label, 20), value: str((x as Record<string, unknown>)?.value, 40) })).filter((x): x is { label: string; value: string } => !!x.label && !!x.value);
    if (a.length) out.answers = a;
  }
  return Object.keys(out).length ? out : null;
}

export const metaOf = (item: Item): MetaFields => ((item.payload ?? {}) as { meta?: MetaFields }).meta ?? {};

/** Bare URLs become named links (the domain when no name is given); everything else is escaped. For prose inside cards. */
export function linkify(raw: string): string {
  return raw.split(/(https?:\/\/[^\s<>()"']+[^\s<>().,;:!?"'])/g).map((part, i) => {
    if (i % 2 === 0) return esc(part);
    let host = part;
    try { host = new URL(part).hostname.replace(/^www\./, ''); } catch { /* keep the raw text as the name */ }
    return /^https:/.test(part) ? `<a href="${attr(part)}">${esc(host)}</a>` : esc(host);
  }).join('');
}

const shortDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat(S.locale, { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d))).replace(',', '');
};

/** "why: … · cost: 5 min · due: Sun 15/11", built from fields. Null when there is nothing to say. */
export function metaLine(m: MetaFields): string | null {
  const costWord = S.meta_cost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = [m.why && `${S.meta_why}: ${m.why}`, m.cost && `${S.meta_cost}: ${m.cost.replace(new RegExp(`^${costWord}\\s+`, 'i'), '')}`, (m.hard_due ?? m.due) && `${S.meta_due}: ${shortDate((m.hard_due ?? m.due)!)}`].filter(Boolean);
  return parts.length ? parts.join('  ·  ') : null;
}

interface View { html: string; text: string; pm: string }
const itemPm = (i: RollItem) => `• ${i.b ? `<b>${esc(i.b)}</b>: ` : ''}${i.url ? `<a href="${attr(i.url)}">${esc(i.label ?? cut(i.t, MAX_ITEM))}</a>${i.label ? ` ${esc(cut(i.t, MAX_ITEM))}` : ''}` : esc(cut(i.t, MAX_ITEM))}`;
const itemText = (i: RollItem) => `• ${i.b ? `${i.b}: ` : ''}${cut(i.t, MAX_ITEM)}${i.url ? ` ${i.url}` : ''}`;
const itemHtml = (i: RollItem) => `<li>${itemPm(i).slice(2)}</li>`;
const visible = (i: RollItem) => (i.b?.length ?? 0) + Math.min(i.t.length, MAX_ITEM);

/** Title line, then the sections in the order given; an empty section is omitted; a folded section, items past 8, and anything past the 900-character budget go into collapsed quotes. */
export function rollView(title: string, roll: Roll): View {
  const pm: string[] = [`<b>${esc(title)}</b>`], html: string[] = [`<h4>${esc(title)}</h4>`], text: string[] = [title];
  let budget = VISIBLE_BUDGET;
  const spill: { h: string; items: RollItem[] }[] = [];
  for (const s of roll.sections) {
    if (!s.items.length) continue;
    const head = `${s.h} · ${s.items.length}`;
    const open = s.fold ? [] : s.items.slice(0, MAX_SECTION_ITEMS).filter(i => (budget -= visible(i)) >= 0);
    const rest = s.items.slice(open.length);
    if (open.length) {
      pm.push(`<b>${esc(head)}</b>\n${open.map(itemPm).join('\n')}`);
      html.push(`<h4>${esc(head)}</h4><ul>${open.map(itemHtml).join('')}</ul>`);
      text.push(`${head}\n${open.map(itemText).join('\n')}`);
    }
    if (rest.length) spill.push({ h: open.length || s.fold ? (s.fold ? head : t('roll_rest', { h: s.h, n: rest.length })) : head, items: rest });
  }
  for (const s of spill) {
    pm.push(`<blockquote expandable><b>${esc(s.h)}</b>\n${s.items.map(itemPm).join('\n')}</blockquote>`);
    html.push(`<details><summary>${esc(s.h)}</summary><ul>${s.items.map(itemHtml).join('')}</ul></details>`);
    text.push(`${s.h}\n${s.items.map(itemText).join('\n')}`);
  }
  if (roll.quote) {
    pm.push(`<blockquote expandable>${linkify(roll.quote).replace(/\n/g, '\n')}</blockquote>`);
    html.push(`<details><summary>${esc(S.sources)}</summary><p>${esc(roll.quote).replace(/\n/g, '<br/>')}</p></details>`);
    text.push(roll.quote);
  }
  return { pm: pm.join('\n\n'), html: html.join(''), text: text.join('\n\n') };
}

/** A body without sections (the model wrote a paragraph): the first 300 characters, the rest collapsed. */
export function foldedProse(title: string, body: string): View {
  const t = body.trim(), sp = t.lastIndexOf(' ', 300), head = t.length > 300 ? t.slice(0, sp > 150 ? sp : 300) : t, rest = t.slice(head.length).trim();
  return {
    pm: `<b>${esc(title)}</b>\n\n${linkify(head)}${rest ? `\n\n<blockquote expandable>${linkify(rest)}</blockquote>` : ''}`,
    html: `<h4>${esc(title)}</h4><p>${esc(head)}</p>${rest ? `<details><summary>${esc(S.details)}</summary><p>${esc(rest).replace(/\n/g, '<br/>')}</p></details>` : ''}`,
    text: `${title}\n\n${head}${rest ? `\n\n${rest}` : ''}`,
  };
}
