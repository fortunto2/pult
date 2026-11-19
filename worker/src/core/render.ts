// Pure: items + time -> Telegram ops. The worker applies them; tests compare golden JSON.
// Rule learned from the 12.11 probe: an edit without reply_markup REMOVES the keyboard, so every edit of a live message passes it again.
// Every op carries Telegram-HTML (`pm`), a plain-text twin and, for long notes, rich `html`: the worker's RICH var picks one.
import { ACTIONS, type Item } from './contract.ts';
import { digestViews } from './digest.ts';
import { foldedProse, linkify, metaLine, metaOf, parseRoll, rollView } from './roll.ts';
import { cards } from './cardconfig.ts';
import { accountLabel, COPY_MAX, draftOf, phaseOf, replyOf } from './drafts.ts';
import { S, t } from './strings.ts';
import { afterKey, afterRows, decisionRows, type GrammarCtx, type Menu } from './grammar.ts';

type Style = { style?: 'danger' | 'success' | 'primary' }   // Bot API: coloured inline button
export type Button = ({ text: string; callback_data: string } | { text: string; copy_text: { text: string } } | { text: string; url: string } | { text: string; disabled: Record<string, never> }) & Style

/** Button decoration, switched per deployment (BUTTON_STYLES=0, BUTTON_DISABLED=0): coloured styles (Bot API 9.4) and a disabled button while a card's job runs. Can be turned off for older clients. */
export const buttonOptions = { styles: true, disabled: true };
export const setButtonOptions = (env: { BUTTON_STYLES?: string; BUTTON_DISABLED?: string }) => { buttonOptions.styles = env.BUTTON_STYLES !== '0'; buttonOptions.disabled = env.BUTTON_DISABLED !== '0'; };
export interface Markup { inline_keyboard: Button[][] }
export interface Op {
  kind: 'send' | 'edit' | 'delete';
  effect: 'show' | 'update' | 'collapse' | 'purge' | 'bump';
  item: Item;
  message_id?: number;
  replaces?: number;          // send: the old message to delete once the new one is out (best effort)
  html?: string;
  pm?: string;                // Telegram-HTML for a plain sendMessage/editMessageText: the text stays selectable 
  text?: string;
  markup?: Markup;
  silent?: boolean;           // send: no notification
  key?: string;               // rendered_hash to store once the op succeeded
}
export interface RenderOpts { tz?: string; quietUntil?: number; held?: number; calm?: boolean; free?: string | null }   // held: cards created but not yet shown (the "More K" button on the newest inbox note)

const DAY = 86400e3;
export const BATCH_QUIET_MS = 10 * 60e3;   // a loud decision within 10 min of the last ring is sent silent
const BUMP_DEBOUNCE_MS = 2 * 60e3;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const callbackData = (short: string, action: string) => `v1:${short}:${action}`;
const payloadOf = (item: Item) => (item.payload ?? {}) as { fix?: string; start?: number; link?: string; source_label?: string; detail?: string; copy?: string; links?: Record<string, string> };
const PM_MAX = 4000;

export { linkify };
export const SNOOZE_MENU = 'snooze_menu', SNOOZE_BACK = 'snooze_back', REVEAL = 'reveal', STALE = 'stale';
/** Group of a card (the glyph in its title, the colour in the Mini App): payload.group, else the id's prefix. */
export function groupOf(item: Item): string {
  const g = (item.payload as { group?: string } | null)?.group;
  if (g) return g;
  if (item.kind === 'incident') return 'incident';
  if (item.kind === 'meeting') return 'meeting';
  const m = /^([a-z0-9_-]+)[:\-]/i.exec(item.id);
  return (m && cards.groups[m[1].toLowerCase()]) || 'other';
}
const urgencyDot = (u: string) => (u === 'now' || u === 'today' ? '🔴' : u === 'week' ? '🟡' : '');
/** The leading marker of a card title: group glyph, then a dot for urgent ones. Digests and notes carry none. */
export const marker = (item: Item) => (item.kind === 'decision' ? `${cards.glyphs[groupOf(item)] ?? ''}${urgencyDot(item.urgency)}` : '');

/** The reply button is offered on an open card of a configured group that has no draft yet. */
export const canReply = (item: Item) => item.kind === 'decision' && ['new', 'shown'].includes(item.state) && cards.replyGroups.includes(groupOf(item)) && !draftOf(item) && !replyOf(item);
const LINK_OK = /^(?:https:\/\/|tg:\/\/user\?id=\d+$)/i;   // a card's "Open" button: https, or a person without a username
export const detailsLabel = () => S.details;
const GRAMMAR = true;
/** `menu`: the opened "Later" keyboard (the options and "Back"). Closed, several snoozes collapse into one button.
 *  Layout on a phone: row 1 = Done · Later · ✖️ · More (the details custom button); row 2 = Open (+ copy); other custom buttons after, two to a row. */
export function keyboard(item: Item, withCustom = true, menu: Menu = false, held = 0, stale = 0, calm = false, x: GrammarCtx = {}): Markup {
  const k = buildKeyboard(item, withCustom, menu, held, stale, calm, x);
  return buttonOptions.styles ? k : { inline_keyboard: k.inline_keyboard.map(r => r.map(b => { const { style: _s, ...rest } = b as Button & Style; return rest as Button; })) };
}

/** The keyboard of a card whose custom job is running: the done/later buttons stay, the running one is shown greyed out. */
export function workingKeyboard(item: Item, x: GrammarCtx = {}): Markup {
  const m = keyboard(item, false, false, 0, 0, false, x);
  const running = buttonOptions.disabled ? item.custom.find(c => c.instruction === item.working) : undefined;
  return running ? { inline_keyboard: [...m.inline_keyboard, [{ text: `⏳ ${running.label}`, disabled: {} }]] } : m;
}

function buildKeyboard(item: Item, withCustom: boolean, menu: Menu, held: number, stale: number, calm: boolean, x: GrammarCtx): Markup {
  const state = item.actions.filter(a => ACTIONS[a]?.tier === 'state');  // draft-tier buttons are the grammar's and the custom ones
  const label = (a: string) => (a === 'done' ? S.done_btn : a === 'drop' ? '✖️' : ACTIONS[a].label);
  const hot: 'danger' | 'primary' | 'success' = item.urgency === 'now' ? 'danger' : item.urgency === 'today' ? 'primary' : 'success';
  const btn = (a: string): Button => ({ text: label(a), callback_data: callbackData(item.short, a), ...(a === 'done' ? { style: hot } : {}) } as Button);
  const customs = (withCustom ? item.custom : []);
  const details = customs.find(c => c.label === S.details);
  const cb = (c: { id: string; label: string }, text = c.label): Button => ({ text, callback_data: callbackData(item.short, c.id) });  // the instruction stays in the store
  const others = customs.filter(c => c !== details).map(c => cb(c));
  const snoozes = state.filter(a => ACTIONS[a].snooze);
  const snoozeRow: Button[] = menu ? [...snoozes.map(btn), { text: S.back, callback_data: callbackData(item.short, SNOOZE_BACK) }]
    : snoozes.length > 1 ? [{ text: S.later_btn, callback_data: callbackData(item.short, SNOOZE_MENU) }] : snoozes.map(btn);
  const { link, copy } = payloadOf(item);
  const checkId = (item.payload as { check_id?: string } | null)?.check_id;
  const recheck: Button[] = checkId && item.actions.includes('run_check') && ACTIONS.run_check ? [{ text: ACTIONS.run_check.label, callback_data: callbackData(item.short, 'run_check') }] : [];
  const url: Button[] = link && LINK_OK.test(link) ? [{ text: S.open_btn, url: link }] : [];
  const fix = payloadOf(item).fix;
  const plain = state.filter(a => !ACTIONS[a].snooze);
  const done = plain.filter(a => a !== 'drop').map(btn), drop = draftOf(item) ? [] : plain.filter(a => a === 'drop').map(btn);   // a draft card has its own "Not needed" in the draft row
  const copyBtn: Button[] = [];
  if (copy) copyBtn.push({ text: S.copy_btn, copy_text: { text: copy.slice(0, 256) } });
  if (item.kind === 'incident' && fix) copyBtn.unshift({ text: S.copy_cmd_btn, copy_text: { text: fix.slice(0, 256) } });
  const rows: Button[][] = [];
  const draft = draftOf(item), ph = phaseOf(item).s;
  if (GRAMMAR && item.kind === 'decision') {   // one grammar for every decision card (grammar.ts)
    const open = ['new', 'shown'].includes(item.state);
    if (draft && open && !menu && ph === 'confirm') return { inline_keyboard: [[{ text: t('send_yes_btn', { to: draft.to }).slice(0, 60), callback_data: callbackData(item.short, `sy_${draft.hash.slice(0, 12)}`), style: 'danger' }, { text: S.cancel_btn, callback_data: callbackData(item.short, 'sn') }]] };
    if (draft && open && !menu && ph === 'sending') return { inline_keyboard: [] };
    const extras: Button[] = [...(details ? [cb(details, S.details)] : []), ...others, ...url, ...recheck, ...copyBtn];
    const g = decisionRows(item, menu, extras as never, { ...x, reply: canReply(item) }) as Button[][];
    const rep = replyOf(item);
    if (rep && open && !menu) {   // a drafted chat reply: copy it, fix it, or say it is sent. No send button exists for these.
      const later = g[0].find(b => 'callback_data' in b && b.callback_data.endsWith(':snooze_menu'));
      return { inline_keyboard: [
        [...(rep.text.length <= COPY_MAX ? [{ text: S.copy_reply_btn, copy_text: { text: rep.text } } as Button] : []), { text: S.fix_btn, callback_data: callbackData(item.short, 'fix_draft') }, { text: S.not_needed, callback_data: callbackData(item.short, 'dm') }],
        [{ text: S.i_sent_btn, callback_data: callbackData(item.short, 'done'), style: hot }, ...(later ? [later] : []), ...url],
      ].filter(r => r.length) };
    }
    if (draft && open && !menu) {   // the draft is in the card: row 1 = send-on-confirm, row 2 = later and the rest
      const sendRow: Button[] = [{ text: S.send_btn, callback_data: callbackData(item.short, 'send_draft'), style: 'success' }, { text: S.fix_btn, callback_data: callbackData(item.short, 'fix_draft') }, { text: S.not_needed, callback_data: callbackData(item.short, 'dm') }];
      const later = g[0].find(b => 'callback_data' in b && b.callback_data.endsWith(':snooze_menu'));
      return { inline_keyboard: [sendRow, [...(later ? [later] : []), ...extras.slice(0, 2)]].filter(r => r.length) };
    }
    return { inline_keyboard: g.filter(r => r.length) };
  }
  if (draft && !menu && ['new', 'shown'].includes(item.state)) {   // send on confirm: the draft is IN the card; two taps, the second names the recipient
    if (ph === 'confirm') return { inline_keyboard: [[{ text: t('send_yes_btn', { to: draft.to }).slice(0, 60), callback_data: callbackData(item.short, `sy_${draft.hash.slice(0, 12)}`), style: 'danger' }, { text: S.cancel_btn, callback_data: callbackData(item.short, 'sn') }]] };
    if (ph === 'sending') return { inline_keyboard: [] };
    rows.push([{ text: S.send_btn, callback_data: callbackData(item.short, 'send_draft'), style: 'success' }, { text: S.fix_btn, callback_data: callbackData(item.short, 'fix_draft') }, { text: S.not_needed, callback_data: callbackData(item.short, 'drop') }]);
  }
  if (menu) rows.push(snoozeRow);
  else {
    const fixBtn = item.kind === 'incident' ? copyBtn.splice(0, 1) : [];   // an incident keeps its acknowledge button and the command in one row
    rows.push([...done, ...fixBtn, ...snoozeRow, ...drop, ...(details ? [cb(details, S.more_btn)] : [])]);
    rows.push([...url, ...recheck, ...copyBtn]);
  }
  if (!menu) for (let i = 0; i < others.length; i += 2) rows.push(others.slice(i, i + 2));
  else rows.push(...others.map(b => [b]));
  if (held > 0 && item.kind === 'inbox') rows.push([{ text: t('more_held_btn', { n: held }), callback_data: callbackData(item.short, REVEAL) }]);
  if (stale > 0 && item.kind === 'digest') rows.push([{ text: t('show_stale_btn', { n: Math.min(stale, 8), total: stale }), callback_data: callbackData(item.short, STALE) }]);
  if (['new', 'shown'].includes(item.state) && !menu) rows.push(...(cards.extraRows?.(item, { menu, calm }) ?? []));   // a deployment's own rows (a standup's one-tap questions), skipped on a calm day by the hook
  return { inline_keyboard: rows.filter(r => r.length) };
}

const hanging = (item: Item, now: number) => Math.floor((now - item.first_seen) / DAY);
const renderKey = (item: Item, now: number, held = 0) => `${item.hash}${replyOf(item) ? ':r' + replyOf(item)!.hash.slice(0, 8) + (replyOf(item)!.missing ?? '').length : ''}${draftOf(item)?.missing ? ':m' + draftOf(item)!.missing!.length : ''}${held ? ':h' + held : ''}:${item.kind === 'decision' ? hanging(item, now) : 0}${item.working ? ':w' + item.working : ''}${payloadOf(item).detail ? ':d' + payloadOf(item).detail!.length : ''}${draftOf(item) ? ':g' + draftOf(item)!.hash.slice(0, 8) + phaseOf(item).s + phaseOf(item).at : ''}`;

function when(ms: number, tz: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
}
const hm = (ms: number, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));

// A body is paragraphs; everything after a line holding only `---` goes into an expandable block (sources, details).
function bodyHtml(body: string, long = 700): string {
  const [head, ...rest] = body.trim().split(/\n-{3,}\n/);
  const paras = (t: string) => t.trim() ? t.trim().split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, '<br/>')}</p>`).join('') : '';
  const more = rest.join('\n').trim();
  let out = head.length > long && !more ? `<details><summary>${esc(S.details)}</summary>${paras(head)}</details>` : paras(head);
  if (more) out += `<details><summary>${esc(S.sources)}</summary>${paras(more)}</details>`;
  return out;
}
const bodyText = (body: string) => body.trim().replace(/\n-{3,}\n/g, '\n\n');

interface View { html: string; text: string; pm?: string }
const pmOk = (v: View): View => (v.pm && v.pm.length > PM_MAX ? { ...v, pm: undefined } : v);
const pmBody = (b: string) => linkify(b.trim().replace(/\n-{3,}\n/g, '\n\n'));

function liveView(item: Item, now: number, tz: string): View {
  const days = hanging(item, now);
  const p = payloadOf(item);
  if (item.kind === 'meeting') {
    const t = p.start ? `<p>${esc(S.starts)} <tg-time unix="${p.start}" format="t">${hm(p.start * 1000, tz)}</tg-time> · <tg-time unix="${p.start}" format="r">${hm(p.start * 1000, tz)}</tg-time></p>` : '';
    return { pm: `⏰ <b>${esc(item.title)}</b>${p.start ? `\n${S.starts} ${hm(p.start * 1000, tz)}` : ''}${item.body ? `\n\n${pmBody(item.body)}` : ''}`, html: `<h4>⏰ ${esc(item.title)}</h4>${t}${bodyHtml(item.body)}`,
      text: `⏰ ${item.title}\n${p.start ? `${S.starts} ${hm(p.start * 1000, tz)}\n` : ''}${item.body ? '\n' + bodyText(item.body) : ''}`.trimEnd() };
  }
  if (item.kind === 'incident') {
    return { pm: `⚠️ <b>${esc(item.title)}</b>${item.body ? `\n\n${pmBody(item.body)}` : ''}${p.fix ? `\n\n<code>${esc(p.fix)}</code>` : ''}`, html: `<h4>⚠️ ${esc(item.title)}</h4>${bodyHtml(item.body)}${p.fix ? `<pre>${esc(p.fix)}</pre>` : ''}`,
      text: `⚠️ ${item.title}${item.body ? '\n\n' + bodyText(item.body) : ''}${p.fix ? `\n\n${p.fix}` : ''}` };
  }
  const tail = item.kind === 'decision' && days >= 1 ? t('hanging_tail', { n: days }) : '';
  if (item.kind === 'digest' || item.kind === 'inbox') {
    const roll = parseRoll((item.payload as { roll?: unknown } | null)?.roll);
    if (roll) return pmOk(rollView(item.title, roll));   // structured: the layout is ours, not the model's
    const sectioned = /^\s*(\*\*|#{1,4} |[-*•] |\d+[.)] )/m.test(item.body) || /\n-{3,}\n/.test(item.body);
    if (!sectioned && item.body.trim().length > 300) return pmOk(foldedProse(item.title, item.body));   // a paragraph: 300 characters, the rest collapsed
    const d = digestViews(item.title, item.body, p.links);
    return pmOk(d);
  }
  const meta = [p.source_label, tail].filter(Boolean).join(' · ');
  const dv = draftView(item, tz) ?? replyView(item);
  const mk = marker(item), lead = mk ? mk + ' ' : '';
  const mf = item.kind === 'decision' ? metaOf(item) : {};
  if (item.kind === 'decision' && mf.do) {   // the fixed shape: action, why·cost·due, one fact line, details collapsed (built from fields)
    const ml = metaLine(mf), fact = item.title.trim().replace(/\s+/g, ' ').slice(0, 140);
    const paras = item.body.trim().split(/\n{2,}/).filter(Boolean), more = [...paras, ...(p.detail ? [p.detail] : [])].join('\n\n');
    const link = p.link && LINK_OK.test(p.link) ? p.link : null;
    const head = link ? `<a href="${esc(link).replace(/"/g, '&quot;')}">${esc(mf.do)}</a>` : esc(mf.do);
    const pm = `<b>${lead}${head}</b>${ml ? `\n<i>${esc(ml)}</i>` : ''}\n${esc(S.who_what)}: ${esc(fact)}${more ? `\n<blockquote expandable>${linkify(more)}</blockquote>` : ''}${dv ? `\n\n${dv.pm}` : ''}${meta ? `\n<i>${esc(meta)}</i>` : ''}`;
    return pmOk({ pm, html: `<h4>${lead}${esc(mf.do)}</h4>${ml ? `<p><i>${esc(ml)}</i></p>` : ''}<p>${esc(S.who_what)}: ${esc(fact)}</p>${more ? `<details><summary>${esc(S.details)}</summary><p>${esc(more).replace(/\n/g, '<br/>')}</p></details>` : ''}${dv ? dv.html : ''}${tail ? `<p><i>${tail}</i></p>` : ''}`,
      text: `${lead}${mf.do}${ml ? `\n${ml}` : ''}\n${S.who_what}: ${fact}${more ? `\n\n${more}` : ''}${dv ? '\n\n' + dv.text : ''}${meta ? `\n\n${meta}` : ''}` });
  }
  const titleHtml = p.link && LINK_OK.test(p.link) ? `<a href="${esc(p.link).replace(/"/g, '&quot;')}">${esc(item.title)}</a>` : esc(item.title);
  const pm = `<b>${lead}${titleHtml}</b>${item.body ? `\n\n${pmBody(item.body)}` : ''}${dv ? `\n\n${dv.pm}` : ''}${p.detail ? `\n\n<blockquote expandable>${esc(p.detail)}</blockquote>` : ''}${meta ? `\n\n<i>${esc(meta)}</i>` : ''}`;
  return pmOk({ pm, html: `<h4>${lead}${esc(item.title)}</h4>${bodyHtml(item.body)}${dv ? dv.html : ''}${tail ? `<p><i>${tail}</i></p>` : ''}`,
    text: `${lead}${item.title}${item.body ? '\n\n' + bodyText(item.body) : ''}${dv ? '\n\n' + dv.text : ''}${p.detail ? `\n\n${p.detail}` : ''}${meta ? `\n\n${meta}` : ''}` });
}

/** The draft inside the card: account, To, Cc, Subject, the whole body (a long one continues in the messages the runner sends right after: `more`), attachment names, and where the confirm stands. */
function draftView(item: Item, tz: string): View | null {
  const d = draftOf(item);
  if (!d) return null;
  const st = phaseOf(item);
  const lines = [[S.d_account, accountLabel(d.account)], [S.d_to, d.to], ...(d.cc ? [[S.d_cc, d.cc]] : []), [S.d_subject, d.subject]];
  const head = (f: (k: string, v: string) => string) => lines.map(([k, v]) => f(k, v)).join('\n');
  const att = d.attachments.length ? `📎 ${d.attachments.join(', ')}` : '';
  const need = [d.missing ? t('need_from_you', { what: d.missing }) : '', !d.missing && /\[[^\]\n]{1,120}\]/.test(d.body) ? S.brackets_mail : ''].filter(Boolean).join('\n');
  const more = d.more > 0 ? (d.more === 1 ? S.continues_one : t('continues_many', { n: d.more })) : '';
  const status = st.s === 'confirm' ? `❓ ${t('send_confirm_q', { to: d.to })}` : st.s === 'sending' ? `⏳ ${S.sending_status}` : st.s === 'failed' ? `⚠️ ${S.send_failed}: ${st.note ?? ''}`.trim() : st.s === 'refused' ? `⚠️ ${S.send_refused}: ${st.note ?? ''}`.trim() : st.note ? `⚠️ ${st.note}` : '';
  void tz;
  return {
    pm: `✉️ <b>${esc(S.mail_draft)}</b>\n${head((k, v) => `<b>${k}:</b> ${esc(v)}`)}\n<blockquote>${esc(d.body)}</blockquote>${more ? `\n<i>${esc(more)}</i>` : ''}${att ? `\n${esc(att)}` : ''}${need ? `\n⚠️ ${esc(need)}` : ''}${status ? `\n\n<b>${esc(status)}</b>` : ''}`,
    html: `<p>✉️ <b>${esc(S.mail_draft)}</b></p><p>${head((k, v) => `<b>${k}:</b> ${esc(v)}`).replace(/\n/g, '<br/>')}</p><blockquote>${esc(d.body).replace(/\n/g, '<br/>')}</blockquote>${more ? `<p><i>${esc(more)}</i></p>` : ''}${att ? `<p>${esc(att)}</p>` : ''}${need ? `<p>⚠️ ${esc(need)}</p>` : ''}${status ? `<p><b>${esc(status)}</b></p>` : ''}`,
    text: `✉️ ${S.mail_draft}\n${head((k, v) => `${k}: ${v}`)}\n\n${d.body}${more ? `\n${more}` : ''}${att ? `\n${att}` : ''}${need ? `\n⚠️ ${need}` : ''}${status ? `\n\n${status}` : ''}`,
  };
}

/** The reply drafted for a Telegram or LinkedIn card: the text (a code block when it is too long for the copy button), what is missing. Nothing here can be sent. */
function replyView(item: Item): View | null {
  const r = replyOf(item);
  if (!r) return null;
  const need = [r.missing ? t('need_from_you', { what: r.missing }) : '', !r.missing && /\[[^\]\n]{1,120}\]/.test(r.text) ? S.brackets_reply : ''].filter(Boolean).join('\n');
  const long = r.text.length > COPY_MAX;
  const block = long ? `<pre>${esc(r.text)}</pre>` : `<blockquote>${esc(r.text)}</blockquote>`;
  return {
    pm: `✍️ <b>${esc(S.reply_draft)}</b> <i>(${esc(S.you_send)})</i>\n${block}${need ? `\n⚠️ ${esc(need)}` : ''}`,
    html: `<p>✍️ <b>${esc(S.reply_draft)}</b> <i>(${esc(S.you_send)})</i></p><blockquote>${esc(r.text).replace(/\n/g, '<br/>')}</blockquote>${need ? `<p>⚠️ ${esc(need)}</p>` : ''}`,
    text: `✍️ ${S.reply_draft} (${S.you_send})\n\n${r.text}${need ? `\n⚠️ ${need}` : ''}`,
  };
}

export const liveHtml = (item: Item, now: number, tz = 'UTC') => liveView(item, now, tz).html;

export function collapsedView(item: Item, tz: string): View {
  const sent = item.state === 'done' && draftOf(item) && phaseOf(item).s === 'sent' ? phaseOf(item) : null;
  const line = sent ? t('line_sent', { time: hm(sent.at, tz), to: sent.to ?? draftOf(item)!.to, title: item.title }) : item.state === 'done' ? t('line_done', { title: item.title }) : item.state === 'dropped' ? t('line_dropped', { title: item.title })
    : item.state === 'expired' ? t('line_expired', { title: item.title }) : t('line_snoozed', { until: when(item.snooze_until ?? 0, tz), title: item.title });
  return { html: `<p>${esc(line)}</p>`, pm: esc(line), text: line };
}
export const collapsedHtml = (item: Item, tz: string) => collapsedView(item, tz).html;

export function render(items: Item[], now: number, opts: RenderOpts = {}): Op[] {
  const tz = opts.tz ?? 'UTC';
  let quiet = (opts.quietUntil ?? 0) > now;          // a decision rang recently: this batch is silent
  const ring = (want: boolean) => { if (!want || quiet) return false; quiet = true; return true; };
  const ops: Op[] = [];
  const open = (i: Item) => i.state === 'new' || i.state === 'shown';
  // hygiene: open cards folded out of the chat are counted in one line of the newest standup, with a button that brings them back
  const folded = items.filter(i => i.kind === 'decision' && i.folded_at && open(i));
  const standupId = folded.length ? items.filter(i => i.kind === 'digest' && open(i) && i.id.startsWith('standup-')).sort((a, b) => b.first_seen - a.first_seen)[0]?.id : undefined;
  const staleN = (i: Item) => (i.id === standupId ? folded.length : 0);
  const staleLine = t('stale_line', { n: folded.length, days: Math.floor((now - Math.min(...folded.map(f => f.first_seen))) / DAY) });
  const view = (i: Item): View => {
    const v = liveView(i, now, tz);
    return staleN(i) ? { ...v, pm: v.pm === undefined ? undefined : `${v.pm}\n\n${esc(staleLine)}`, html: `${v.html}<p>${esc(staleLine)}</p>`, text: `${v.text}\n\n${staleLine}` } : v;
  };
  const rk = (i: Item, h = 0) => renderKey(i, now, h) + (staleN(i) ? `:s${folded.length}:${Math.floor((now - Math.min(...folded.map(f => f.first_seen))) / DAY)}` : '');
  const noteWithMore = (opts.held ?? 0) > 0 ? items.filter(i => i.kind === 'inbox' && (i.state === 'new' || i.state === 'shown')).sort((a, b) => b.first_seen - a.first_seen)[0]?.id : undefined;
  const heldFor = (i: Item) => (i.id === noteWithMore ? opts.held! : 0);
  const sendOp = (item: Item, silent: boolean, effect: Op['effect'] = 'show', replaces?: number): Op =>
    ({ kind: 'send', effect, item, replaces, ...view(item), markup: keyboard(item, true, false, heldFor(item), staleN(item), opts.calm, { now, tz, free: opts.free }), silent, key: rk(item, heldFor(item)) });
  const editOp = (item: Item): Op => ({ kind: 'edit', effect: 'update', item, message_id: item.tg_message_id ?? undefined, ...view(item), markup: keyboard(item, true, false, heldFor(item), staleN(item), opts.calm, { now, tz, free: opts.free }), key: rk(item, heldFor(item)) });
  const purge = (item: Item): Op => ({ kind: 'delete', effect: 'purge', item, message_id: item.tg_message_id ?? undefined });

  const decisions = items.filter(i => i.kind === 'decision');
  for (const item of decisions) {
    const mid = item.tg_message_id ?? undefined;
    if (item.msg_state === 'sending' || item.msg_state === 'gone') continue;
    if (item.folded_at && open(item)) { if (item.msg_state === 'live' || item.msg_state === 'collapsed') ops.push(purge(item)); continue; }   // folded: out of the chat, still open in the store
    if (item.state === 'snoozed' && item.working !== null && item.msg_state === 'live') {
      // working: one line, the done/snooze buttons stay (the custom ones are spent)
      const line = t('working_line', { what: item.working.slice(0, 60) });
      if (item.rendered_hash !== renderKey(item, now)) ops.push({ kind: 'edit', effect: 'update', item, message_id: mid, html: `<p>${esc(line)}</p>`, pm: esc(line), text: line, markup: workingKeyboard(item, { now, tz, free: opts.free }), key: renderKey(item, now) });
    } else if (open(item)) {
      const ringAt = (item.payload as { ring_at?: number } | null)?.ring_at ?? 0;
      if (item.msg_state === 'live') {
        if (ringAt > (item.bumped_at ?? 0)) ops.push(sendOp(item, false, 'bump', mid));   // a draft is ready: the card is sent again WITH a sound and the old one goes: one message per card, and the owner notices
        else if (item.rendered_hash !== renderKey(item, now)) ops.push(editOp(item));
      }
      else ops.push(sendOp(item, !ring(item.loud), 'show', item.msg_state === 'collapsed' ? mid : undefined));
    } else if (item.msg_state === 'live') {
      const c = collapsedView(item, tz);
      ops.push({ kind: 'edit', effect: 'collapse', item, message_id: mid, html: c.html, pm: c.pm, text: c.text, markup: { inline_keyboard: afterRows(item, now) as Button[][] }, key: afterKey(item, now) });
    } else if (item.msg_state === 'collapsed' && ((item.payload ?? {}) as { ui_undo?: number }).ui_undo !== undefined && item.rendered_hash !== afterKey(item, now) && !(item.state !== 'snoozed' && item.closed_at !== null && now - item.closed_at >= DAY)) {
      const c = collapsedView(item, tz);   // the undo and effort buttons expire: the same line, the keyboard they leave behind taken away
      ops.push({ kind: 'edit', effect: 'collapse', item, message_id: mid, html: c.html, pm: c.pm, text: c.text, markup: { inline_keyboard: afterRows(item, now) as Button[][] }, key: afterKey(item, now) });
    } else if (item.msg_state === 'collapsed' && item.state !== 'snoozed' && item.closed_at !== null && now - item.closed_at >= DAY) {
      ops.push(purge(item));  // past Telegram's 48 h window the API refuses; applyOps then just forgets it
    }
  }

  for (const item of items.filter(i => i.kind === 'incident' || i.kind === 'meeting')) {
    if (item.msg_state === 'sending' || item.msg_state === 'gone') continue;
    const always = item.kind === 'incident';  // an incident always rings; a meeting only when the job says loud
    if (open(item)) {
      if (item.msg_state === 'none') ops.push(sendOp(item, !(always || item.loud)));
      else if (item.msg_state === 'live') {
        if (item.kind === 'meeting' && item.loud && item.loud_sent_at === null) ops.push(sendOp(item, false, 'bump', item.tg_message_id ?? undefined));  // T-60 was silent, T-15 rings
        else if (item.rendered_hash !== renderKey(item, now)) ops.push(editOp(item));
      }
    } else if (item.msg_state === 'live' || item.msg_state === 'collapsed') ops.push(purge(item));  // acknowledged, expired or past its end: gone
  }

  for (const item of items.filter(i => i.kind === 'inbox' || i.kind === 'digest')) {
    if (item.msg_state === 'sending' || item.msg_state === 'gone') continue;
    if (!open(item)) { if (item.state === 'expired' && (item.msg_state === 'live' || item.msg_state === 'collapsed')) ops.push(purge(item)); continue; }   // superseded by the next note of its stream out of the chat
    if (item.msg_state === 'none') { ops.push(sendOp(item, true)); continue; }
    if (item.msg_state !== 'live') continue;
    // A decision that appeared after this message went out: re-send the inbox below it, silently (the decision is what rings).
    // Debounced on the last bump only, so a batch of decisions moves the inbox once and the rest wait two minutes.
    const since = Math.max(item.bumped_at ?? 0, item.shown_at ?? 0);
    const fresh = item.kind === 'inbox' && now - (item.bumped_at ?? 0) >= BUMP_DEBOUNCE_MS && decisions.some(d => open(d) && d.first_seen > since);
    if (fresh) ops.push(sendOp(item, true, 'bump', item.tg_message_id ?? undefined));
    else if (item.rendered_hash !== rk(item, heldFor(item))) ops.push(editOp(item));
  }
  return ops;
}
