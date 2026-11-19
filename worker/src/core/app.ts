// createApp({ extensions }): the whole worker as a library. The core's own src/index.ts is createApp({ extensions: [] }); a private layer calls it with its extensions
// and gets the same worker plus whatever they add (see extension.ts and docs/extending.md).
import { type Api, Bot, type Context, webhookCallback } from 'grammy';
import { itemsRoute } from './api.ts';
import { handleCallback } from './callbacks.ts';
import { cmdNew, cmdSessions, cmdStop, filesOf, inbound, queueItemEvent, statusLine, stopDraft, switchTo } from './chat.ts';
import type { Env } from './env.ts';
import { type AppCtx, type Extension, type Route, validate } from './extension.ts';
import { hourly } from './hourly.ts';
import { CORE_MIGRATIONS, migrate } from './migrations.ts';
import { appRoute, authenticate, WRITE_KEY, writeEnabled } from './miniapp/api.ts';
import { appAsset } from './miniapp/assets.ts';
import { replyEvent } from './replies.ts';
import { callbackData, setButtonOptions } from './render.ts';
import { getSetting, putSetting } from './settings.ts';
import { isQueuePath, sessionsRoute } from './sessions-api.ts';
import { listItems } from './store.ts';
import { grammyTg } from './tg.ts';
import { ownerTz } from './tz.ts';
import { S, setStrings } from './strings.ts';
import { setEventColumns, setQueueHooks, type QEvent } from './queue.ts';

const COMMANDS = [
  { command: 'new', description: 'new Claude session (until midnight)' },
  { command: 'sessions', description: 'my sessions, switch' },
  { command: 'stop', description: 'stop the current turn' },
  { command: 'open', description: 'open cards' },
  { command: 'later', description: 'snoozed cards' },
  { command: 'status', description: 'queue and usage limit' },
  { command: 'app', description: 'open the Mini App' },
  { command: 'help', description: 'what this bot does' },
];
const HELP = `Pult: Claude Code from your phone, on your own subscription.

Any message goes to Claude in the day's session. A reply to any bot message continues the session that message came from.
/new [title]: a fresh session until midnight. /sessions: list and switch. /stop: interrupt the current turn (as a reply: that session).
/open: open cards with buttons. /later: snoozed cards. /status: queue and usage-limit pause. /app: the Mini App. /appwrite on|off: let the app press card buttons.
Voice notes, photos and files go to the session as files (up to 20 MB).`;

/** Compares SHA-256 digests of both sides with no early exit, so neither the length nor a matching prefix shows in the timing. */
export async function sameKey(given: string, want: string): Promise<boolean> {
  const h = async (x: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(x)));
  const [a, b] = await Promise.all([h(given), h(want)]);
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export interface AppOptions<X> { extensions?: Extension<X>[]; /** user-facing sentences in your language; keys you leave out stay English (core/strings.ts) */ strings?: Record<string, string> }
export interface App<X> {
  fetch(req: Request, env: Env & X): Promise<Response>;
  scheduled(e: ScheduledController, env: Env & X, ctx: ExecutionContext): Promise<void>;
}

export function createApp<X extends object = object>(opts: AppOptions<X> = {}): App<X> {
  const exts = opts.extensions ?? [];
  validate(exts as Extension<never>[]);
  setStrings(opts.strings ?? {});
  setEventColumns(Object.assign({}, ...exts.map(e => e.eventColumns ?? {})));
  setQueueHooks(exts.flatMap(e => (e.queue ? [e.queue] : [])));
  const migrations = [...CORE_MIGRATIONS, ...exts.flatMap(e => e.migrations ?? [])];
  const ready = new WeakMap<D1Database, Promise<string[]>>();   // once per isolate and database; a failed run is retried by the next request
  const ensure = (env: Env) => {
    let p = ready.get(env.DB);
    if (!p) { p = migrate(env.DB, migrations); ready.set(env.DB, p); p.catch(() => ready.delete(env.DB)); }
    return p;
  };
  const botOf = (env: Env) => new Bot(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_API_ROOT ? { client: { apiRoot: env.TELEGRAM_API_ROOT } } : {});
  const ctxOf = (env: Env & X, api: Api, now = Date.now()): AppCtx<X> => ({ env, db: env.DB, tg: grammyTg(api), api, owner: Number(env.CHAT_ID), tz: ownerTz(env), now });
  const commands = exts.flatMap(e => e.commands ?? []);
  const callbacks = exts.flatMap(e => e.callbacks ?? []);
  const actions = Object.assign({}, ...exts.map(e => e.queueActions ?? {})) as Record<string, NonNullable<Extension<X>['queueActions']>[string]>;
  const help = [HELP, ...exts.map(e => e.help).filter(Boolean), ...commands.map(c => `/${c.name}: ${c.description}`)].join('\n');

  function handlers(b: Bot, env: Env & X) {
    const owner = Number(env.CHAT_ID), tz = ownerTz(env), tgOf = (api: Api) => grammyTg(api);
    // The stop button on a streamed draft. Its update has no `from`; the chat is the owner's private chat or nothing happens.
    b.use(async (ctx, next) => {
      const g = (ctx.update as { stopped_message_generation?: { chat?: { id?: number }; draft_id?: number } }).stopped_message_generation;
      if (!g) return next();
      if (g.chat?.id === owner) await stopDraft(env, owner, g.draft_id, Date.now(), tz);
    });
    // Only the owner reaches anything below: CHAT_ID is his private chat with the bot, and a private chat's id is its user's id.
    // Everyone else, groups, channels and other bots get no answer at all.
    b.use(async (ctx, next) => {
      if (!ctx.from || ctx.from.is_bot || ctx.from.id !== owner || ctx.chat?.id !== owner) {
        for (const e of exts) if (e.outsiders && await e.outsiders(ctxOf(env, ctx.api), ctx.update).catch(err => { console.error(`extension ${e.name}: outsiders failed`, err); return false; })) return;
        return;
      }
      await next();
    });
    b.command('start', ctx => ctx.reply(S.start));
    b.command(['help', 'commands'], ctx => ctx.reply(help));
    b.command('status', async ctx => { await ctx.reply(await statusLine(env, Date.now(), tz)); });
    b.command('new', async ctx => { await ctx.reply((await cmdNew(env, owner, String(ctx.match ?? ''), Date.now(), tz)).text); });
    b.command('sessions', async ctx => {
      const r = await cmdSessions(env, owner, Date.now(), tz);
      await ctx.reply(r.text, { reply_markup: { inline_keyboard: r.buttons.length ? [r.buttons] : [] } });
    });
    b.command('stop', async ctx => { await ctx.reply(await cmdStop(env, owner, ctx.message?.reply_to_message?.message_id, Date.now(), tz)); });
    b.command('app', async ctx => {
      const url = await getSetting(env.DB, 'app:url');
      if (!url) { await ctx.reply(S.appUnknown); return; }
      await ctx.reply(S.appBlurb, { reply_markup: { inline_keyboard: [[{ text: S.appOpen, web_app: { url: `${url}/app/` } }]] } });
    });
    b.command('appwrite', async ctx => {
      const arg = String(ctx.match ?? '').trim().toLowerCase();
      if (arg === 'on' || arg === 'off') await putSetting(env.DB, WRITE_KEY, arg === 'on' ? '1' : '0');
      await ctx.reply(`Mini App write-back is ${(await writeEnabled(env.DB)) ? 'on' : 'off'}. /appwrite on|off`);
    });
    // Open and snoozed decisions straight from the store; the buttons act on the same items as their own messages.
    const list = (state: 'open' | 'snoozed') => async (ctx: Context) => {
      const now = Date.now();
      const items = (await listItems(env.DB, owner, { state, kind: 'decision' })).filter(i => state === 'open' ? i.state !== 'snoozed' : true).slice(0, 8);
      if (!items.length) { await ctx.reply(state === 'open' ? S.noOpen : S.nothingSnoozed); return; }
      const line = (i: (typeof items)[number], n: number) => `${n + 1}. ${i.title}` + (state === 'snoozed' ? ` · until ${new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(i.snooze_until ?? 0)}`
        : Math.floor((now - i.first_seen) / 86400e3) >= 1 ? ` · waiting ${Math.floor((now - i.first_seen) / 86400e3)} d` : '');
      const rows = items.filter(i => i.actions.includes('done')).map((i, n) => state === 'open'
        ? [{ text: `✓ ${n + 1}`, callback_data: callbackData(i.short, 'done') }, ...(i.actions.includes('snooze_tomorrow') ? [{ text: `💤 ${n + 1}`, callback_data: callbackData(i.short, 'snooze_tomorrow') }] : [])]
        : [{ text: `Done ${n + 1}`, callback_data: callbackData(i.short, 'done') }]);
      await ctx.reply(items.map(line).join('\n'), { reply_markup: { inline_keyboard: rows } });
    };
    b.command('open', list('open'));
    b.command('later', list('snoozed'));
    for (const c of commands) {   // extension commands: same owner gate, run with the core's context
      b.command(c.name, async ctx => {
        const base = ctxOf(env, ctx.api);
        await c.run({ ...base, args: String(ctx.match ?? ''), replyToMessageId: ctx.message?.reply_to_message?.message_id,
          reply: async (text, markup) => { await ctx.reply(text, markup ? { reply_markup: markup as never } : undefined); } });
      });
    }
    b.on('callback_query:data', async ctx => {
      const now = Date.now(), data = ctx.callbackQuery.data;
      if (data.startsWith('sw:')) { await ctx.answerCallbackQuery({ text: await switchTo(env, owner, data.slice(3), now, tz) }); return; }
      const ext = callbacks.find(c => data.startsWith(c.prefix));
      if (ext) {
        const answer = async (text: string) => { await ctx.answerCallbackQuery({ text }).catch(() => undefined); };
        try { await ext.run({ ...ctxOf(env, ctx.api, now), data: data.slice(ext.prefix.length), queryId: ctx.callbackQuery.id, fromId: ctx.from.id, messageId: ctx.callbackQuery.message?.message_id, answer }); }
        catch (e) { console.error(`callback ${ext.prefix} failed`, e); await answer(S.callbackFailed); }
        return;
      }
      await handleCallback(env.DB, tgOf(ctx.api), owner, { fromId: ctx.from.id, data, queryId: ctx.callbackQuery.id, name: ctx.from.first_name },
        now, tz, undefined, async e => { await queueItemEvent(env.DB, owner, e, 1, tz, now); });
    });
    // His message is a turn in a session (reply > the target he chose today > the day's main), queued for the runner.
    b.on('message', async ctx => {
      const m = ctx.message, now = Date.now();
      if (ctx.chat.type !== 'private') return;
      const { files, unsupported } = filesOf(m as never);
      const text = (m.forward_origin ? '[forwarded] ' : '') + (m.text ?? m.caption ?? '');
      if (!text && !files.length && !unsupported.length) return;
      const r = m.reply_to_message;
      // a reply to a card keeps its own flow (card context from the store, "working"), and the turn runs in the day's session
      const viaItem = r ? await replyEvent(env.DB, tgOf(ctx.api), { userId: owner, name: m.from.first_name, messageId: r.message_id, text, eventId: m.message_id }, now, tz).catch(() => null) : null;
      if (viaItem) await queueItemEvent(env.DB, owner, viaItem, 0, tz, now);
      const o = viaItem ? null : await inbound(env, { userId: owner, messageId: m.message_id, text, replyTo: r?.message_id, files, unsupported }, now, tz);
      await ctx.react('👀').catch(() => undefined);
      const lines = [...(o?.refusals ?? []), ...(o?.pauseLine ? [o.pauseLine] : [])];
      if (lines.length) await ctx.reply(lines.join('\n'), { reply_parameters: { message_id: m.message_id } }).catch(() => undefined);
    });
  }

  /** POST /say: one plain message to the owner (bot-say). `silent` sends without a notification; `reply_to` quotes a message. */
  async function say(req: Request, env: Env, api: Api): Promise<Response> {
    const b = (await req.json().catch(() => null)) as { text?: string; reply_to?: number; silent?: boolean } | null;
    if (typeof b?.text !== 'string' || !b.text.trim()) return Response.json({ error: 'text' }, { status: 400 });
    const m = await api.sendMessage(env.CHAT_ID, b.text.slice(0, 4000), {
      link_preview_options: { is_disabled: true }, ...(b.silent ? { disable_notification: true } : {}),
      ...(b.reply_to ? { reply_parameters: { message_id: b.reply_to, allow_sending_without_reply: true } } : {}),
    });
    return Response.json({ message_id: m.message_id });
  }

  const onAckOf = (ctx: AppCtx<X>) => async (ev: QEvent, ack: Parameters<NonNullable<NonNullable<Extension<X>['queueActions']>[string]['onAck']>>[2]) => {
    await actions[ev.action]?.onAck?.(ctx, ev, ack);
  };

  async function extRoute(req: Request, u: URL, env: Env & X, ctx: AppCtx<X>): Promise<Response | null> {
    const m = /^\/x\/([a-z][a-z0-9_]{1,15})(\/.*)?$/.exec(u.pathname);
    if (!m) return null;
    const ext = exts.find(e => e.name === m[1]), sub = m[2] ?? '/';
    let hit: { r: Route<X>; params: string[] } | undefined;
    for (const r of ext?.routes ?? []) {
      if (r.method !== req.method) continue;
      if (typeof r.path === 'string') { if (r.path === sub) { hit = { r, params: [] }; break; } }
      else { const x = r.path.exec(sub); if (x) { hit = { r, params: x.slice(1) }; break; } }
    }
    if (!hit) return new Response('not found', { status: 404 });
    const auth = hit.r.auth ?? 'key';
    if (auth === 'key') {
      const key = /^Bearer (.+)$/.exec(req.headers.get('Authorization') ?? '')?.[1] ?? '';
      if (!(env.RUN_KEY && await sameKey(key, env.RUN_KEY))) return new Response('no', { status: 403 });
    } else if (auth === 'tma') {
      const who = await authenticate(req, ctx);
      if (who instanceof Response) return who;
    }
    return hit.r.handler(req, { ...ctx, url: u, params: hit.params });
  }

  return {
    async scheduled(ev, env, execCtx) {
      execCtx.waitUntil((async () => {
        await ensure(env);
        const api = botOf(env).api, ctx = ctxOf(env, api);
        await hourly(env, ctx.tg, ctx.tz).catch(err => console.error('hourly sweep failed', err));
        for (const e of exts) if (e.scheduled) await e.scheduled(ctx, ev).catch(err => console.error(`extension ${e.name}: scheduled failed`, err));
      })().catch(err => console.error('scheduled failed', err)));
    },
    async fetch(req, env) {
      const u = new URL(req.url);
      setButtonOptions(env);
      const asset = req.method === 'GET' ? appAsset(u.pathname) : null;
      if (asset) return asset;
      await ensure(env);
      if (u.pathname === '/tg' && req.method === 'POST') {
        if (!env.TG_SECRET) return new Response('webhook secret not configured', { status: 503 });   // fail closed: an empty secret would mean no verification
        const b = botOf(env);
        handlers(b, env);
        return webhookCallback(b, 'cloudflare-mod', { secretToken: env.TG_SECRET })(req);
      }
      const api = botOf(env).api, ctx = ctxOf(env, api);
      const app = await appRoute(req, u, ctx, exts);   // the Mini App API: its own auth (initData), not the key
      if (app) return app;
      const ex = await extRoute(req, u, env, ctx);
      if (ex) return ex;
      // everything else wants the key, in the header only: a key in a URL lands in logs and history
      const key = /^Bearer (.+)$/.exec(req.headers.get('Authorization') ?? '')?.[1] ?? '';
      const isRunner = !!env.RUNNER_KEY && isQueuePath(u.pathname) && await sameKey(key, env.RUNNER_KEY);   // RUNNER_KEY opens the queue routes and nothing else
      if (!isRunner && !(env.RUN_KEY && await sameKey(key, env.RUN_KEY))) return new Response('no', { status: 403 });
      const root = env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org';
      if (isQueuePath(u.pathname)) {
        const r = await sessionsRoute(req, u, env, { tg: ctx.tg, tz: ctx.tz, onAck: onAckOf(ctx), files: { getFile: id => api.getFile(id), download: path => fetch(`${root}/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`) } });
        if (r) return r;
      }
      if (req.method === 'POST' && u.pathname === '/say') return say(req, env, api);
      if (u.pathname.startsWith('/items')) {
        const r = await itemsRoute(req, u, env, ctx.tg, ctx.tz);
        if (r) return r;
      }
      if (u.pathname === '/setup') {   // once after deploy: the command menu, the webhook (same secret the worker checks), the Mini App menu button
        await api.setMyCommands([...COMMANDS, ...commands.map(c => ({ command: c.name, description: c.description.slice(0, 256) }))]);
        await api.setWebhook(`${u.origin}/tg`, { secret_token: env.TG_SECRET, allowed_updates: ['message', 'callback_query', 'stopped_message_generation'] });
        await putSetting(env.DB, 'app:url', u.origin);
        await api.setChatMenuButton({ chat_id: Number(env.CHAT_ID), menu_button: { type: 'web_app', text: S.menuTitle, web_app: { url: `${u.origin}/app/` } } }).catch(() => undefined);
        return Response.json({ ok: true, migrations: migrations.map(m => m.id) });
      }
      return new Response('not found', { status: 404 });
    },
  };
}
