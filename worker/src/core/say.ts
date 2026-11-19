// POST /say: one message from a job to the owner. The route behind `bot-say`.
//   text            the message (4000 characters; a caption is cut at 1000)
//   key             a living message: the first call sends, later calls edit it in place; with `replace` the old one is deleted and a new one sent, so it notifies
//   silent          no notification sound         reply_to  quote a message         keyboard  attach the persistent reply keyboard (createApp's replyKeyboard)
//   photo_b64       a picture (text becomes the caption)           doc_b64 + doc_name   a file (the same)
//   issue, thread, topic, origin, urgent   accepted from older callers and ignored here; an extension's `say.before` hook may read them (a content wall, a rest period)
import { InputFile, type Api } from 'grammy';
import type { AppCtx, Extension } from './extension.ts';
import { clearKeyedMessage, keyedMessage, setKeyedMessage } from './settings.ts';

export type SayBody = { text?: string; key?: string; reply_to?: number; silent?: boolean; replace?: boolean; keyboard?: boolean; photo_b64?: string; doc_b64?: string; doc_name?: string; [k: string]: unknown };
const bytes = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

export async function say<X>(b: SayBody | null, ctx: AppCtx<X>, hooks: NonNullable<Extension<X>['say']>[], keyboard?: object): Promise<Response> {
  if (typeof b?.text !== 'string' || (!b.text.trim() && !b.photo_b64 && !b.doc_b64)) return Response.json({ error: 'text' }, { status: 400 });
  for (const h of hooks) { const stop = await h.before?.(ctx, b); if (stop) return stop; }
  const { api, db } = ctx, chat = ctx.env.CHAT_ID;
  const opts = {
    ...(b.silent ? { disable_notification: true } : {}),
    ...(b.keyboard && keyboard ? { reply_markup: keyboard as never } : {}),
    ...(b.reply_to ? { reply_parameters: { message_id: b.reply_to, allow_sending_without_reply: true } } : {}),
  };
  let id = 0;
  if (b.doc_b64) id = (await (api as Api).sendDocument(chat, new InputFile(bytes(b.doc_b64), b.doc_name || 'file'), { caption: b.text.slice(0, 1000), ...opts })).message_id;
  else if (b.photo_b64) id = (await api.sendPhoto(chat, new InputFile(bytes(b.photo_b64), 'image.png'), { caption: b.text.slice(0, 1000), ...opts })).message_id;
  else {
    const key = typeof b.key === 'string' && b.key ? b.key : '', prev = key ? await keyedMessage(db, key, ctx.now) : 0;
    if (prev && b.replace) { await api.deleteMessage(chat, prev).catch(() => undefined); await clearKeyedMessage(db, key); }
    else if (prev) {
      try { await api.editMessageText(chat, prev, b.text.slice(0, 4000), { link_preview_options: { is_disabled: true } }); id = prev; }
      catch (e) { if (String(e).includes('not modified')) id = prev; }   // deleted or too old: a new message below
    }
    if (!id) id = (await api.sendMessage(chat, b.text.slice(0, 4000), { link_preview_options: { is_disabled: true }, ...opts })).message_id;
    if (key) await setKeyedMessage(db, key, id);
  }
  return Response.json({ message_id: id });
}
