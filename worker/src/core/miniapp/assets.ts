// The Mini App page, served by the worker itself at /app/ (no build step, no asset hosting, nothing to configure for a private fork).
// Text only goes through textContent. The one external script is Telegram's own SDK. Because the Mini App is served from the worker's origin,
// the 10.2 same-origin rule for Mini App methods holds as long as nothing in here links out or frames another origin.
const HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Pult</title><link rel="stylesheet" href="/app/app.css"><script src="https://telegram.org/js/telegram-web-app.js"></script></head>
<body><header><nav id="tabs"></nav></header><div id="banner" hidden></div><main id="view"></main>
<footer id="foot"></footer><div id="sheet" hidden><div class="card"><button id="close" aria-label="Close">x</button><div id="sheetbody"></div></div></div>
<script src="/app/app.js"></script></body></html>`;

const CSS = String.raw`:root{--bg:var(--tg-theme-bg-color,#fff);--fg:var(--tg-theme-text-color,#111);--hint:var(--tg-theme-hint-color,#777);--btn:var(--tg-theme-button-color,#2481cc);--btnfg:var(--tg-theme-button-text-color,#fff);--sec:var(--tg-theme-secondary-bg-color,#f1f1f4);--bad:#d64545;--ok:#3fa55b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.35 -apple-system,system-ui,sans-serif;padding-bottom:env(safe-area-inset-bottom)}
header{position:sticky;top:0;background:var(--bg);padding:8px 12px;z-index:2}nav{display:flex;gap:4px;overflow-x:auto}
nav button,.chip{border:0;background:var(--sec);color:var(--fg);padding:6px 12px;border-radius:14px;font:inherit;white-space:nowrap}nav button.on{background:var(--btn);color:var(--btnfg)}
#banner{background:#ffe9b3;color:#5a4300;padding:6px 12px;font-size:13px}h3{margin:14px 12px 4px;font-size:12px;text-transform:uppercase;color:var(--hint);letter-spacing:.04em}
.row{padding:8px 12px;border-bottom:1px solid var(--sec);cursor:pointer}.row.focus{background:color-mix(in srgb,var(--btn) 14%,transparent)}.row .t{font-weight:500}.row .m{color:var(--hint);font-size:13px}
.badge{float:right;font-size:11px;padding:1px 7px;border-radius:9px;background:var(--sec);color:var(--hint)}.badge.hot{background:#fde7e7;color:#b42318}
.tiles{display:flex;gap:8px;padding:8px 12px;flex-wrap:wrap}.tile{background:var(--sec);border-radius:10px;padding:6px 10px;font-size:13px}
#sheet{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:flex-end;z-index:5}#sheet[hidden]{display:none}
.card{background:var(--bg);width:100%;max-height:80vh;overflow:auto;border-radius:16px 16px 0 0;padding:16px 16px calc(16px + env(safe-area-inset-bottom));position:relative}
#close{position:absolute;right:8px;top:4px;border:0;background:none;font-size:22px;color:var(--hint)}.card h2{margin:0 24px 8px 0;font-size:17px}
.acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.acts button,#foot button{border:0;background:var(--btn);color:var(--btnfg);padding:8px 14px;border-radius:10px;font:inherit}
.note{color:var(--hint);font-size:13px;padding:0 12px}pre{white-space:pre-wrap;word-break:break-word;font-size:12px;background:var(--sec);padding:8px;border-radius:8px}#foot{display:flex;gap:8px;padding:12px;flex-wrap:wrap}`;

const JS = String.raw`// Pult Mini App. initData goes in the Authorization header; start_param deep links: card_<short>, session_<id>, panel_<id>[_<focus>].
const tg = window.Telegram && window.Telegram.WebApp;
if (tg) { tg.ready(); tg.expand(); }
const initData = (tg && tg.initData) || new URLSearchParams(location.hash.slice(1)).get('tma') || '';
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const S = { tab: 'overview', me: null, ov: null, focus: null };
const ago = ms => { const m = Math.max(0, Math.round((S.ov.now - ms) / 60000)); return m < 90 ? m + ' min ago' : m < 2880 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
const hm = s => new Date(s * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

async function api(path, opts) {
  const r = await fetch('/app/api/' + path, Object.assign({ headers: { Authorization: 'tma ' + initData, 'Content-Type': 'application/json' } }, opts || {}));
  if (!r.ok) throw new Error(r.status === 401 ? 'Open this from Telegram' : r.status === 403 ? (await r.json().catch(() => ({}))).error === 'write disabled' ? 'Write-back is off (/appwrite on)' : 'No access' : 'Error ' + r.status);
  return r.json();
}
function row(title, sub, badge, hot, onclick, focus) {
  const r = el('div', 'row' + (focus ? ' focus' : '')); if (badge) r.append(el('span', 'badge' + (hot ? ' hot' : ''), badge));
  r.append(el('div', 't', title)); if (sub) r.append(el('div', 'm', sub)); if (onclick) r.onclick = onclick; return r;
}
function sheet(title, build) { const b = $('sheetbody'); b.replaceChildren(el('h2', '', title)); build(b); $('sheet').hidden = false; }
function cardSheet(c) {
  sheet(c.title, b => {
    b.append(el('div', 'note', [c.kind, c.urgency, c.state, 'since ' + ago(c.since), c.source].filter(Boolean).join(' · ')));
    if (c.body) b.append(el('pre', '', c.body));
    if (c.link) { const a = el('a', '', 'Open source'); a.href = c.link; a.target = '_blank'; a.rel = 'noopener'; b.append(a); }
    const acts = el('div', 'acts');
    if (S.me.write) for (const a of c.actions) { const btn = el('button', '', a.label); btn.onclick = async () => { btn.disabled = true; try { await api('action', { method: 'POST', body: JSON.stringify({ short: c.short, action: a.id }) }); $('sheet').hidden = true; load(); } catch (e) { btn.textContent = e.message; } }; acts.append(btn); }
    else b.append(el('p', 'note', 'Read-only. Buttons live on the card in the chat.'));
    b.append(acts);
  });
}
function overview() {
  const v = $('view'), o = S.ov; v.replaceChildren();
  const q = o.queue, tiles = el('div', 'tiles');
  tiles.append(el('div', 'tile', 'running ' + q.running), el('div', 'tile', 'queued ' + (Object.entries(q.queued).map(e => e[0] + ':' + e[1]).join(' ') || 'none')));
  if (q.paused_until) tiles.append(el('div', 'tile', 'usage limit until ' + hm(q.paused_until)));
  v.append(tiles, el('h3', '', 'Cards · ' + o.cards.length));
  for (const c of o.cards) v.append(row(c.title, [c.kind, c.state === 'snoozed' ? 'later' : '', c.working ? 'working' : '', ago(c.since)].filter(Boolean).join(' · '), c.urgency === 'week' ? '' : c.urgency, c.urgency === 'now', () => cardSheet(c), S.focus === 'card_' + c.short));
  if (!o.cards.length) v.append(el('p', 'note', 'No open cards.'));
  v.append(el('h3', '', 'Sessions · ' + o.sessions.length));
  for (const s of o.sessions) v.append(row(s.title, ago(s.last_active) + (s.workflow === 'live' ? ' · live' : ''), s.status === 'running' ? 'running' : '', s.status === 'running', null, S.focus === 'session_' + s.id));
  v.append(el('h3', '', 'Recent runs'));
  for (const r of o.runs) v.append(row('#' + r.id + ' ' + r.action, 'P' + r.priority + ' · ' + ago(r.created_at), r.status, r.status === 'failed'));
  if (S.focus) { const f = v.querySelector('.focus'); if (f) f.scrollIntoView({ block: 'center' }); }
}
function panel(p) {
  const v = $('view'); v.replaceChildren(el('h3', '', p.title)); const d = p.data;
  if (d.rows) for (const r of d.rows) v.append(row(r.title, r.sub, r.badge, false, null, S.focus === 'panel_' + p.id + '_' + r.focus));
  else if (d.kv) for (const kv of d.kv) v.append(row(kv[0], kv[1]));
  else if (d.text != null) v.append(el('pre', '', d.text));
  if (S.focus) { const f = v.querySelector('.focus'); if (f) f.scrollIntoView({ block: 'center' }); }
}
function tabs() {
  const t = $('tabs'); t.replaceChildren();
  for (const [id, label] of [['overview', 'Overview']].concat(S.me.panels.map(p => [p.id, p.title]))) { const b = el('button', S.tab === id ? 'on' : '', label); b.onclick = () => { S.tab = id; S.focus = null; load(); }; t.append(b); }
}
function footer() {
  const f = $('foot'); f.replaceChildren();
  if (!tg) return;
  if (tg.isVersionAtLeast && tg.isVersionAtLeast('8.0')) {
    if (tg.requestFullscreen && !tg.isFullscreen) { const b = el('button', '', 'Fullscreen'); b.onclick = () => tg.requestFullscreen(); f.append(b); }
    if (tg.addToHomeScreen) { const b = el('button', '', 'Add to home screen'); b.onclick = () => tg.addToHomeScreen(); f.append(b); }
  }
}
async function load() {
  try {
    if (!S.me) { S.me = await api('me'); const sp = S.me.start_param || (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param); if (sp) { S.focus = sp; const m = /^panel_([a-z0-9-]+?)(?:_|$)/.exec(sp); if (m && S.me.panels.some(p => p.id === m[1])) S.tab = m[1]; } }
    tabs(); footer(); $('banner').hidden = true;
    if (S.tab === 'overview') { S.ov = await api('overview'); overview(); const m = /^card_([0-9a-f]{10})$/.exec(S.focus || ''); const c = m && S.ov.cards.find(x => x.short === m[1]); if (c) { S.focus = null; cardSheet(c); } }
    else panel(await api('panel/' + S.tab));
  } catch (e) { $('view').replaceChildren(el('p', 'note', e.message)); }
}
$('close').onclick = () => { $('sheet').hidden = true; };
load();`;

export const ASSETS: Record<string, { type: string; body: string }> = {
  '/app/': { type: 'text/html; charset=utf-8', body: HTML },
  '/app/app.css': { type: 'text/css; charset=utf-8', body: CSS },
  '/app/app.js': { type: 'text/javascript; charset=utf-8', body: JS },
};

export function appAsset(pathname: string): Response | null {
  const a = ASSETS[pathname === '/app' ? '/app/' : pathname];
  return a ? new Response(a.body, { headers: { 'content-type': a.type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } }) : null;
}
