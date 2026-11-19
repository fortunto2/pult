import { type Api, Bot, type Context, webhookCallback } from 'grammy';
import { itemsRoute } from './src/api.ts';
import { handleCallback } from './src/callbacks.ts';
import { cmdNew, cmdSessions, cmdStop, filesOf, inbound, queueItemEvent, statusLine, switchTo } from './src/chat.ts';
import type { Env } from './src/env.ts';
import { hourly } from './src/hourly.ts';
import { replyEvent } from './src/replies.ts';
import { callbackData } from './src/render.ts';
import { isQueuePath, sessionsRoute } from './src/sessions-api.ts';
import { listItems } from './src/store.ts';
import { grammyTg } from './src/tg.ts';
import { ownerTz } from './src/tz.ts';

const COMMANDS = [
  { command: 'new', description: 'new Claude session (until midnight)' },
  { command: 'sessions', description: 'my sessions, switch' },
  { command: 'stop', description: 'stop the current turn' },
  { command: 'open', description: 'open cards' },
  { command: 'later', description: 'snoozed cards' },
  { command: 'status', description: 'queue and usage limit' },
  { command: 'help', description: 'what this bot does' },
];
const HELP = `Pult: Claude Code from your phone, on your own subscription.

Any message goes to Claude in the day's session. A reply to any bot message continues the session that message came from.
/new [title]: a fresh session until midnight. /sessions: list and switch. /stop: interrupt the current turn (as a reply: that session).
/open: open cards with buttons. /later: snoozed cards. /status: queue and usage-limit pause.
Voice notes, photos and files go to the session as files (up to 20 MB).`;

const bot = (env: Env) => new Bot(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_API_ROOT ? { client: { apiRoot: env.TELEGRAM_API_ROOT } } : {});
const tgOf = (api: Api) => grammyTg(api);

function handlers(b: Bot, env: Env) {
  const owner = Number(env.CHAT_ID), tz = ownerTz(env);
  // Only the owner reaches anything below: CHAT_ID is his private chat with the bot, and a private chat's id is its user's id.
  // Everyone else, groups, channels and other bots get no answer at all.
  b.use(async (ctx, next) => {
    if (!ctx.from || ctx.from.is_bot || ctx.from.id !== owner || ctx.chat?.id !== owner) return;
    await next();
  });
  b.command('start', ctx => ctx.reply('Write a message and Claude answers. /help lists the commands.'));
  b.command(['help', 'commands'], ctx => ctx.reply(HELP));
  b.command('status', async ctx => { await ctx.reply(await statusLine(env, Date.now(), tz)); });
  b.command('new', async ctx => { await ctx.reply((await cmdNew(env, owner, String(ctx.match ?? ''), Date.now(), tz)).text); });
  b.command('sessions', async ctx => {
    const r = await cmdSessions(env, owner, Date.now(), tz);
    await ctx.reply(r.text, { reply_markup: { inline_keyboard: r.buttons.length ? [r.buttons] : [] } });
  });
  b.command('stop', async ctx => { await ctx.reply(await cmdStop(env, owner, ctx.message?.reply_to_message?.message_id, Date.now(), tz)); });
  // Open and snoozed decisions straight from the store; the buttons act on the same items as their own messages.
  const list = (state: 'open' | 'snoozed') => async (ctx: Context) => {
    const now = Date.now();
    const items = (await listItems(env.DB, owner, { state, kind: 'decision' })).filter(i => state === 'open' ? i.state !== 'snoozed' : true).slice(0, 8);
    if (!items.length) { await ctx.reply(state === 'open' ? 'No open cards.' : 'Nothing snoozed.'); return; }
    const line = (i: (typeof items)[number], n: number) => `${n + 1}. ${i.title}` + (state === 'snoozed' ? ` · until ${new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(i.snooze_until ?? 0)}`
      : Math.floor((now - i.first_seen) / 86400e3) >= 1 ? ` · waiting ${Math.floor((now - i.first_seen) / 86400e3)} d` : '');
    const rows = items.filter(i => i.actions.includes('done')).map((i, n) => state === 'open'
      ? [{ text: `✓ ${n + 1}`, callback_data: callbackData(i.short, 'done') }, ...(i.actions.includes('snooze_tomorrow') ? [{ text: `💤 ${n + 1}`, callback_data: callbackData(i.short, 'snooze_tomorrow') }] : [])]
      : [{ text: `Done ${n + 1}`, callback_data: callbackData(i.short, 'done') }]);
    await ctx.reply(items.map(line).join('\n'), { reply_markup: { inline_keyboard: rows } });
  };
  b.command('open', list('open'));
  b.command('later', list('snoozed'));
  b.on('callback_query:data', async ctx => {
    const now = Date.now();
    if (ctx.callbackQuery.data.startsWith('sw:')) { await ctx.answerCallbackQuery({ text: await switchTo(env, owner, ctx.callbackQuery.data.slice(3), now, tz) }); return; }
    await handleCallback(env.DB, tgOf(ctx.api), owner, { fromId: ctx.from.id, data: ctx.callbackQuery.data, queryId: ctx.callbackQuery.id, name: ctx.from.first_name },
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

/** Compares SHA-256 digests of both sides with no early exit, so neither the length nor a matching prefix shows in the timing. */
export async function sameKey(given: string, want: string): Promise<boolean> {
  const h = async (x: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(x)));
  const [a, b] = await Promise.all([h(given), h(want)]);
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** POST /say: one plain message to the owner (bot-say). `silent` sends without a notification; `reply_to` quotes a message. */
async function say(req: Request, env: Env): Promise<Response> {
  const b = (await req.json().catch(() => null)) as { text?: string; reply_to?: number; silent?: boolean } | null;
  if (typeof b?.text !== 'string' || !b.text.trim()) return Response.json({ error: 'text' }, { status: 400 });
  const api = bot(env).api;
  const m = await api.sendMessage(env.CHAT_ID, b.text.slice(0, 4000), {
    link_preview_options: { is_disabled: true }, ...(b.silent ? { disable_notification: true } : {}),
    ...(b.reply_to ? { reply_parameters: { message_id: b.reply_to, allow_sending_without_reply: true } } : {}),
  });
  return Response.json({ message_id: m.message_id });
}

export default {
  async scheduled(_e: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(hourly(env, tgOf(bot(env).api), ownerTz(env)).catch(err => console.error('hourly sweep failed', err)));
  },
  async fetch(req: Request, env: Env) {
    const u = new URL(req.url);
    if (u.pathname === '/tg' && req.method === 'POST') {
      if (!env.TG_SECRET) return new Response('webhook secret not configured', { status: 503 });   // fail closed: an empty secret would mean no verification
      const b = bot(env);
      handlers(b, env);
      return webhookCallback(b, 'cloudflare-mod', { secretToken: env.TG_SECRET })(req);
    }
    // everything else wants the key, in the header only: a key in a URL lands in logs and history
    const key = /^Bearer (.+)$/.exec(req.headers.get('Authorization') ?? '')?.[1] ?? '';
    const isRunner = !!env.RUNNER_KEY && isQueuePath(u.pathname) && await sameKey(key, env.RUNNER_KEY);   // RUNNER_KEY opens the queue routes and nothing else
    if (!isRunner && !(env.RUN_KEY && await sameKey(key, env.RUN_KEY))) return new Response('no', { status: 403 });
    const api = bot(env).api, tz = ownerTz(env);
    const root = env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org';
    if (isQueuePath(u.pathname)) {
      const r = await sessionsRoute(req, u, env, { tg: tgOf(api), tz, files: { getFile: id => api.getFile(id), download: path => fetch(`${root}/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`) } });
      if (r) return r;
    }
    if (req.method === 'POST' && u.pathname === '/say') return say(req, env);
    if (u.pathname.startsWith('/items')) {
      const r = await itemsRoute(req, u, env, tgOf(api), tz);
      if (r) return r;
    }
    if (u.pathname === '/setup') {   // once after deploy: the command menu and the webhook, with the same secret the worker checks
      await api.setMyCommands(COMMANDS);
      await api.setWebhook(`${u.origin}/tg`, { secret_token: env.TG_SECRET, allowed_updates: ['message', 'callback_query'] });
      return Response.json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  },
};

