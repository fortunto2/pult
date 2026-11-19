// Digest layout: the job gives STRUCTURE, the renderer lays it out.
//   ## Section title
//   - Lead | text | Source | https://t.me/channel/123      (url and source optional; the last field starting with http is the url)
//   - text with **emphasis**                                (no lead)
//   ## Hanging
//   - 3 | text carried over from 3 days ago                  (days first; 0 prints no prefix)
// Anything else is a plain line. A line holding only `---` starts the expandable sources block.
// Links come from the job only (never invented here); an item without a verified link renders without one.
import { cards } from './cardconfig.ts';
import { S, t } from './strings.ts';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s: string) => esc(s).replace(/"/g, '&quot;');
const SAFE_URL = /^https:\/\/[^\s"<>]+$/i;

export interface DItem { lead?: string; text: string; source?: string; url?: string; days?: number }
export interface DSection { title?: string; items: DItem[]; plain: string[] }
export interface Digest { sections: DSection[]; sources: string }

export function parseDigest(body: string): Digest {
  const [head, ...rest] = body.trim().split(/\n-{3,}\n/);
  const sections: DSection[] = [];
  let cur: DSection | null = null;
  const sec = () => (cur ??= (sections.push({ items: [], plain: [] }), sections[sections.length - 1]));
  for (const raw of head.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const h = /^##\s+(.+)$/.exec(line);
    if (h) { cur = { title: h[1].trim(), items: [], plain: [] }; sections.push(cur); continue; }
    const it = /^[-•*]\s+(.+)$/.exec(line);
    if (!it) { sec().plain.push(line); continue; }
    const f = it[1].split(/\s+\|\s+/).map(x => x.trim());
    let url: string | undefined;
    if (f.length > 1 && /^https?:\/\//i.test(f[f.length - 1])) url = f.pop();
    if (url && !SAFE_URL.test(url)) url = undefined;   // http, quotes, spaces: rendered without a link
    const carried = !!cards.hangingHeading && cards.hangingHeading.test(sec().title ?? '') && /^\d+$/.test(f[0]) && f.length > 1;
    if (carried) { if (Number(f[0]) > 0) sec().items.push({ days: Number(f[0]), text: f.slice(1).join(' | '), url, source: undefined }); }   // the hanging section is for items older than today: age 0 is not hanging 
    else if (f.length >= 3) sec().items.push({ lead: f[0], text: f[1], source: f.slice(2).join(' | '), url });
    else if (f.length === 2) sec().items.push({ lead: f[0], text: f[1], url });
    else sec().items.push({ text: f[0], url });
  }
  return { sections: sections.filter(s => s.items.length || s.plain.length), sources: rest.join('\n').trim() };
}

const hangRe = (n: string) => new RegExp(`^${S.hanging_word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ${n} ${S.days_short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[:·]?\\s*`, 'i');
// **x** -> bold; everything else escaped. A stray "hanging 0 d" prefix never prints.
const inline = (s: string) => esc(s.replace(hangRe('0'), '')).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
const plainInline = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '$1');

function itemHtml(i: DItem): string {
  const prefix = i.days ? `${i.days} ${S.days_short} · ` : '';
  const lead = i.lead ? `<b>${esc(i.lead)}</b> — ` : '';
  const link = i.url ? `<a href="${attr(i.url)}">${esc(i.source ?? S.link_word)}</a>` : i.source ? `<i>${esc(i.source)}</i>` : '';
  return `${prefix}${lead}${inline(i.text)}${link ? ` · ${link}` : ''}`;
}
function itemText(i: DItem): string {
  return `${i.days ? `${i.days} ${S.days_short} · ` : ''}${i.lead ? `${i.lead} — ` : ''}${plainInline(i.text)}${i.source || i.url ? ` · ${i.source ?? S.link_word}${i.url ? ` ${i.url}` : ''}` : ''}`;
}

export const MAX_ITEMS = 20;   // visible items; the rest sit in one expandable "N more" block, links intact

// --- links outlive the model's rewrite: a digest accumulates through the day and the model re-lists items (often in "hanging", where it drops the link) ---
const stripLead = (s: string) => s.replace(hangRe('\\d+'), '');
export const linkKey = (text: string) => stripLead(text).replace(/\*\*/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 60);
const keysOf = (i: DItem) => [linkKey(i.text), ...(i.lead ? [linkKey(`${i.lead} ${i.text}`)] : [])].filter(k => k.length >= 8);

export function harvestLinks(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const sec of parseDigest(body).sections) for (const i of sec.items) if (i.url) for (const k of keysOf(i)) out[k] = i.url;
  return out;
}
/** The links known for this digest: those stored before, those in the previous body, those in the new one (later wins). */
export function digestLinks(stored: unknown, prevBody: string | null, body: string): Record<string, string> {
  const old = stored && typeof stored === 'object' && !Array.isArray(stored) ? Object.fromEntries(Object.entries(stored as Record<string, unknown>).filter(([, v]) => typeof v === 'string' && SAFE_URL.test(v as string))) as Record<string, string> : {};
  return Object.fromEntries(Object.entries({ ...old, ...(prevBody ? harvestLinks(prevBody) : {}), ...harvestLinks(body) }).slice(-300));
}
function withLink(i: DItem, links: Record<string, string>): DItem {
  if (i.url) return i;
  const keys = keysOf(i);
  for (const k of keys) if (links[k]) return { ...i, url: links[k] };
  for (const k of keys) { if (k.length < 24) continue; const hit = Object.keys(links).find(l => l.length >= 24 && (l.startsWith(k) || k.startsWith(l))); if (hit) return { ...i, url: links[hit] }; }
  return i;
}

/** Telegram-HTML for a plain sendMessage (text stays selectable), the rich twin and the plain-text twin. */
export function digestViews(title: string, body: string, links: Record<string, string> = {}): { pm: string; html: string; text: string } {
  const d = parseDigest(body);
  let left = MAX_ITEMS;
  const shown: DSection[] = [], rest: { title?: string; item: DItem }[] = [];
  for (const s of d.sections) {
    const items = s.items.map(i => withLink(i, links));
    const keep = items.slice(0, Math.max(0, left));
    left -= keep.length;
    for (const i of items.slice(keep.length)) rest.push({ title: s.title, item: i });
    if (keep.length || s.plain.length) shown.push({ ...s, items: keep });
  }
  const pmParts: string[] = [], htmlParts: string[] = [], textParts: string[] = [];
  for (const s of shown) {
    const t = s.title;
    pmParts.push([t ? `<b>${esc(t)}</b>` : '', ...s.items.map(i => `• ${itemHtml(i)}`), ...s.plain.map(p => esc(p))].filter(Boolean).join('\n'));
    htmlParts.push(`${t ? `<h4>${esc(t)}</h4>` : ''}${s.items.length ? `<ul>${s.items.map(i => `<li>${itemHtml(i)}</li>`).join('')}</ul>` : ''}${s.plain.map(p => `<p>${esc(p)}</p>`).join('')}`);
    textParts.push([t ?? '', ...s.items.map(i => `• ${itemText(i)}`), ...s.plain].filter(Boolean).join('\n'));
  }
  if (rest.length) {
    const line = (r: { title?: string; item: DItem }) => `${r.title ? `${r.title}: ` : ''}`;
    pmParts.push(`<blockquote expandable>${esc(t('more_n', { n: rest.length }))}\n${rest.map(r => `• ${esc(line(r))}${itemHtml(r.item)}`).join('\n')}</blockquote>`);
    htmlParts.push(`<details><summary>${esc(t('more_n', { n: rest.length }))}</summary><ul>${rest.map(r => `<li>${esc(line(r))}${itemHtml(r.item)}</li>`).join('')}</ul></details>`);
    textParts.push(`${t('more_n', { n: rest.length })}\n${rest.map(r => `• ${line(r)}${itemText(r.item)}`).join('\n')}`);
  }
  const src = d.sources;
  return {
    pm: `<b>${esc(title)}</b>\n\n${pmParts.join('\n\n')}${src ? `\n\n<blockquote expandable>${esc(src)}</blockquote>` : ''}`.trim(),
    html: `<h4>${esc(title)}</h4>${htmlParts.join('')}${src ? `<details><summary>${esc(S.sources)}</summary><p>${esc(src).replace(/\n/g, '<br/>')}</p></details>` : ''}`,
    text: `${title}\n\n${textParts.join('\n\n')}${src ? `\n\n${src}` : ''}`.trim(),
  };
}
