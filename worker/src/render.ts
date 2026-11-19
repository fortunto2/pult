// Pure: items + time -> Telegram ops. The worker applies them; tests compare the result.
// Rule learned the hard way: an edit without reply_markup REMOVES the keyboard, so every edit of a live message passes it again.
import { ACTIONS, type Item } from './contract.ts';

type Style = { style?: 'danger' | 'success' | 'primary' }   // Bot API: coloured inline button
export type Button = ({ text: string; callback_data: string } | { text: string; copy_text: { text: string } } | { text: string; url: string }) & Style
export interface Markup { inline_keyboard: Button[][] }
export interface Op {
  kind: 'send' | 'edit' | 'delete';
  effect: 'show' | 'update' | 'collapse' | 'purge';
  item: Item;
  message_id?: number;
  replaces?: number;          // send: the old message to delete once the new one is out (best effort)
  pm?: string;                // Telegram HTML
  text?: string;              // plain twin
  markup?: Markup;
  silent?: boolean;           // send: no notification
  key?: string;               // rendered_hash to store once the op succeeded
}
export interface RenderOpts { tz?: string; quietUntil?: number }

const DAY = 86400e3;
export const BATCH_QUIET_MS = 10 * 60e3;   // a loud item within 10 min of the last ring is sent silent
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s: string) => esc(s).replace(/"/g, '&quot;');
export const callbackData = (short: string, action: string) => `v1:${short}:${action}`;
type Meta = { do?: string; why?: string; cost?: string; verb?: string };
const payloadOf = (item: Item) => (item.payload ?? {}) as { fix?: string; start?: number; link?: string; source_label?: string; detail?: string; copy?: string; meta?: Meta };

export const SNOOZE_MENU = 'snooze_menu', SNOOZE_BACK = 'snooze_back';
export const DETAILS = 'More';   // the label of the automatic details button (bin/bot-item card); the job's answer lands in payload.detail
const LINK_OK = /^https:\/\//i;
const urgencyDot = (u: string) => (u === 'now' || u === 'today' ? '🔴' : u === 'week' ? '🟡' : '');
const hanging = (item: Item, now: number) => Math.floor((now - item.first_seen) / DAY);
const hm = (ms: number, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
function when(ms: number, tz: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
}

/** Bare https URLs become named links (the domain); everything else is escaped. */
export function linkify(raw: string): string {
  return raw.split(/(https?:\/\/[^\s<>()"']+[^\s<>().,;:!?"'])/g).map((part, i) => {
    if (i % 2 === 0) return esc(part);
    let host = part;
    try { host = new URL(part).hostname.replace(/^www\./, ''); } catch { /* keep the raw text as the name */ }
    return /^https:/.test(part) ? `<a href="${attr(part)}">${esc(host)}</a>` : esc(host);
  }).join('');
}

/** The card's own fields: what to do, why, what it costs. Sanitised on the way in (api.ts), shown here. */
export function metaLine(m: Meta): string | null {
  const parts = [m.why && `why: ${m.why}`, m.cost && `cost: ${m.cost}`].filter(Boolean);
  return parts.length ? parts.join('  ·  ') : null;
}

/** Layout: row 1 = Done · Later · Not needed · More; row 2 = Open (+ Copy); other custom buttons after, two to a row.
 *  `menu`: the opened "Later" keyboard (the options and Back). Closed, several snoozes collapse into one button. */
export function keyboard(item: Item, withCustom = true, menu = false): Markup {
  const state = item.actions.filter(a => ACTIONS[a]);
  const p = payloadOf(item);
  const verb = p.meta?.verb;
  const label = (a: string) => (a === 'done' ? `✅ ${verb ?? ACTIONS.done.label}` : a === 'drop' ? `✖️ ${ACTIONS.drop.label}` : ACTIONS[a].label);
  const hot = item.urgency === 'now' ? 'danger' : item.urgency === 'today' ? 'primary' : 'success';
  const btn = (a: string): Button => ({ text: label(a), callback_data: callbackData(item.short, a), ...(a === 'done' ? { style: hot } : {}) } as Button);
  const customs = withCustom ? item.custom : [];
  const details = customs.find(c => c.label === DETAILS);
  const cb = (c: { id: string; label: string }): Button => ({ text: c.label, callback_data: callbackData(item.short, c.id) });   // the instruction stays in the store
  const others = customs.filter(c => c !== details).map(cb);
  const snoozes = state.filter(a => ACTIONS[a].snooze);
  const snoozeRow: Button[] = menu ? [...snoozes.map(btn), { text: '← Back', callback_data: callbackData(item.short, SNOOZE_BACK) }]
    : snoozes.length > 1 ? [{ text: '⏰ Later', callback_data: callbackData(item.short, SNOOZE_MENU) }] : snoozes.map(btn);
  const url: Button[] = p.link && LINK_OK.test(p.link) ? [{ text: '↗ Open', url: p.link }] : [];
  const copyBtn: Button[] = [];
  if (p.copy) copyBtn.push({ text: 'Copy', copy_text: { text: p.copy.slice(0, 256) } });
  if (item.kind === 'incident' && p.fix) copyBtn.unshift({ text: 'Copy command', copy_text: { text: p.fix.slice(0, 256) } });
  const rows: Button[][] = [];
  if (menu) rows.push(snoozeRow);
  else {
    const plain = state.filter(a => !ACTIONS[a].snooze);
    rows.push([...plain.filter(a => a !== 'drop').map(btn), ...snoozeRow, ...plain.filter(a => a === 'drop').map(btn), ...(details ? [cb(details)] : [])]);
    rows.push([...url, ...copyBtn]);
  }
  if (!menu) for (let i = 0; i < others.length; i += 2) rows.push(others.slice(i, i + 2));
  else rows.push(...others.map(b => [b]));
  return { inline_keyboard: rows.filter(r => r.length) };
}

const renderKey = (item: Item, now: number) => `${item.hash}:${item.kind === 'decision' ? hanging(item, now) : 0}${item.working ? ':w' + item.working : ''}${payloadOf(item).detail ? ':d' + payloadOf(item).detail!.length : ''}`;

interface View { pm: string; text: string }
function liveView(item: Item, now: number, tz: string): View {
  const days = hanging(item, now);
  const p = payloadOf(item);
  const body = item.body.trim();
  if (item.kind === 'meeting') {
    return { pm: `⏰ <b>${esc(item.title)}</b>${p.start ? `\nstarts ${hm(p.start * 1000, tz)}` : ''}${body ? `\n\n${linkify(body)}` : ''}`,
      text: `⏰ ${item.title}\n${p.start ? `starts ${hm(p.start * 1000, tz)}\n` : ''}${body ? '\n' + body : ''}`.trimEnd() };
  }
  if (item.kind === 'incident') {
    return { pm: `⚠️ <b>${esc(item.title)}</b>${body ? `\n\n${linkify(body)}` : ''}${p.fix ? `\n\n<code>${esc(p.fix)}</code>` : ''}`,
      text: `⚠️ ${item.title}${body ? '\n\n' + body : ''}${p.fix ? `\n\n${p.fix}` : ''}` };
  }
  if (item.kind === 'digest' || item.kind === 'inbox') {   // a living note: the title, then the text as written, links named by their domain
    return { pm: `<b>${esc(item.title)}</b>${body ? `\n\n${linkify(body)}` : ''}`, text: `${item.title}${body ? '\n\n' + body : ''}` };
  }
  const tail = days >= 1 ? `waiting ${days} d` : '';
  const meta = [p.source_label, tail].filter(Boolean).join(' · ');
  const dot = urgencyDot(item.urgency), lead = dot ? dot + ' ' : '';
  const link = p.link && LINK_OK.test(p.link) ? p.link : null;
  const m = p.meta ?? {};
  if (m.do) {   // the fixed shape: the action, why and cost, one fact line, details collapsed
    const ml = metaLine(m), fact = item.title.trim().replace(/\s+/g, ' ').slice(0, 140);
    const more = [body, p.detail].filter(Boolean).join('\n\n');
    const head = link ? `<a href="${attr(link)}">${esc(m.do)}</a>` : esc(m.do);
    return { pm: `<b>${lead}${head}</b>${ml ? `\n<i>${esc(ml)}</i>` : ''}\nAbout: ${esc(fact)}${more ? `\n<blockquote expandable>${linkify(more)}</blockquote>` : ''}${meta ? `\n<i>${esc(meta)}</i>` : ''}`,
      text: `${lead}${m.do}${ml ? `\n${ml}` : ''}\nAbout: ${fact}${more ? `\n\n${more}` : ''}${meta ? `\n\n${meta}` : ''}` };
  }
  const titleHtml = link ? `<a href="${attr(link)}">${esc(item.title)}</a>` : esc(item.title);
  return { pm: `<b>${lead}${titleHtml}</b>${body ? `\n\n${linkify(body)}` : ''}${p.detail ? `\n\n<blockquote expandable>${linkify(p.detail)}</blockquote>` : ''}${meta ? `\n\n<i>${esc(meta)}</i>` : ''}`,
    text: `${lead}${item.title}${body ? '\n\n' + body : ''}${p.detail ? `\n\n${p.detail}` : ''}${meta ? `\n\n${meta}` : ''}` };
}

export function collapsedView(item: Item, tz: string): View {
  const t = item.title;
  const line = item.state === 'done' ? `✓ done: ${t}` : item.state === 'dropped' ? `✕ not needed: ${t}`
    : item.state === 'expired' ? `⌛ no answer: ${t}` : `💤 later, until ${when(item.snooze_until ?? 0, tz)}: ${t}`;
  return { pm: esc(line), text: line };
}

export function render(items: Item[], now: number, opts: RenderOpts = {}): Op[] {
  const tz = opts.tz ?? 'UTC';
  let quiet = (opts.quietUntil ?? 0) > now;          // something rang recently: this batch is silent
  const ring = (want: boolean) => { if (!want || quiet) return false; quiet = true; return true; };
  const ops: Op[] = [];
  const open = (i: Item) => i.state === 'new' || i.state === 'shown';
  const sendOp = (item: Item, silent: boolean, replaces?: number): Op =>
    ({ kind: 'send', effect: 'show', item, replaces, ...liveView(item, now, tz), markup: keyboard(item), silent, key: renderKey(item, now) });
  const editOp = (item: Item): Op => ({ kind: 'edit', effect: 'update', item, message_id: item.tg_message_id ?? undefined, ...liveView(item, now, tz), markup: keyboard(item), key: renderKey(item, now) });
  const purge = (item: Item): Op => ({ kind: 'delete', effect: 'purge', item, message_id: item.tg_message_id ?? undefined });

  for (const item of items.filter(i => i.kind === 'decision')) {
    const mid = item.tg_message_id ?? undefined;
    if (item.msg_state === 'sending' || item.msg_state === 'gone') continue;
    if (item.state === 'snoozed' && item.working !== null && item.msg_state === 'live') {
      // working: one line, the done and later buttons stay (the custom ones are spent)
      const line = `⏳ working: ${item.working.slice(0, 60)}`;
      if (item.rendered_hash !== renderKey(item, now)) ops.push({ kind: 'edit', effect: 'update', item, message_id: mid, pm: esc(line), text: line, markup: keyboard(item, false), key: renderKey(item, now) });
    } else if (open(item)) {
      if (item.msg_state === 'live') { if (item.rendered_hash !== renderKey(item, now)) ops.push(editOp(item)); }
      else ops.push(sendOp(item, !ring(item.loud), item.msg_state === 'collapsed' ? mid : undefined));
    } else if (item.msg_state === 'live') {
      const c = collapsedView(item, tz);
      ops.push({ kind: 'edit', effect: 'collapse', item, message_id: mid, pm: c.pm, text: c.text, markup: { inline_keyboard: [] } });
    } else if (item.msg_state === 'collapsed' && item.state !== 'snoozed' && item.closed_at !== null && now - item.closed_at >= DAY) {
      ops.push(purge(item));  // past Telegram's 48 h window the API refuses; applyOps then just forgets it
    }
  }

  for (const item of items.filter(i => i.kind !== 'decision')) {
    if (item.msg_state === 'sending' || item.msg_state === 'gone') continue;
    if (open(item)) {
      if (item.msg_state === 'none') ops.push(sendOp(item, !ring(item.loud || item.kind === 'incident')));   // an incident always rings; notes stay silent unless the job says loud
      else if (item.msg_state === 'live' && item.rendered_hash !== renderKey(item, now)) ops.push(editOp(item));
    } else if (item.msg_state === 'live' || item.msg_state === 'collapsed') ops.push(purge(item));  // acknowledged, expired or superseded: out of the chat
  }
  return ops;
}
