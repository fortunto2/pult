// Telegram side of the renderer: a small interface (so tests run the same code against a fake) and applyOps.
import type { Api } from 'grammy';
import { markCollapsed, markEdited, markGone, markSent, releaseClaim, claimSend } from './store.ts';
import type { Markup, Op } from './render.ts';

// pm: Telegram-HTML (parse_mode HTML). text: the plain twin, sent when Telegram refuses the markup.
export interface Content { text: string; pm?: string }
export interface Tg {
  send(chat: number, c: Content, markup: Markup | undefined, silent: boolean, replyTo?: number): Promise<number>;
  edit(chat: number, messageId: number, c: Content, markup: Markup | undefined): Promise<void>;
  editMarkup(chat: number, messageId: number, markup: Markup): Promise<void>;   // keyboard only: the "Later" menu opens and closes without touching the text
  delete(chat: number, messageId: number): Promise<void>;
  answerCallback(id: string, text: string): Promise<void>;
  /** Bot API 9.3+: a streamed draft (30 s ephemeral preview; the final answer is a normal send). Empty text shows "Thinking...". True when Telegram took it. */
  draft(chat: number, draftId: number, text: string, canStop: boolean): Promise<boolean>;
}

const NO_PREVIEW = { is_disabled: true };
const badMarkup = (e: unknown) => /can't parse entities|can't find end|unsupported start tag/i.test(String((e as Error)?.message ?? e));

/** rich=false (env RICH=0) sends the plain-text twin of every message: one switch for a bad render on a client. */
export const grammyTg = (api: Api, rich = true): Tg => ({
  send: async (chat, c, markup, silent, replyTo) => {
    const other = { ...(markup ? { reply_markup: markup } : {}), ...(silent ? { disable_notification: true } : {}), ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}), link_preview_options: NO_PREVIEW };
    if (c.pm && rich) {
      try { return (await api.sendMessage(chat, c.pm.slice(0, 4096), { ...other, parse_mode: 'HTML' })).message_id; }
      catch (e) { if (!badMarkup(e)) throw e; }   // Telegram refused the entities: the plain twin goes out instead of losing the message
    }
    return (await api.sendMessage(chat, c.text.slice(0, 4000), other)).message_id;
  },
  edit: async (chat, id, c, markup) => {
    const other = { ...(markup ? { reply_markup: markup } : {}), link_preview_options: NO_PREVIEW };   // an edit without reply_markup REMOVES the keyboard: callers pass it every time
    if (c.pm && rich) {
      try { await api.editMessageText(chat, id, c.pm.slice(0, 4096), { ...other, parse_mode: 'HTML' }); return; }
      catch (e) { if (!badMarkup(e)) throw e; }
    }
    await api.editMessageText(chat, id, c.text.slice(0, 4000), other);
  },
  editMarkup: async (chat, id, markup) => { await api.editMessageReplyMarkup(chat, id, { reply_markup: markup }); },
  delete: async (chat, id) => { await api.deleteMessage(chat, id); },
  answerCallback: async (id, text) => { await api.answerCallbackQuery(id, { text }); },
  draft: async (chat, draftId, text, canStop) => { await api.sendMessageDraft(chat, draftId, text.slice(0, 4000), canStop ? { can_stop: true } : {}); return true; },
});

const has = (e: unknown, re: RegExp) => re.test(String((e as Error)?.message ?? e));
const NOT_MODIFIED = /not modified/i, MISSING = /message to edit not found|message can't be edited|message to delete not found|can't be deleted|MESSAGE_ID_INVALID/i;

export interface ApplyResult { applied: number; errors: string[] }

/** Runs ops one by one with a gap (Telegram: about one message per second in a chat). Each op's failure is isolated. */
export async function applyOps(tg: Tg, db: D1Database, ops: Op[], now: number, sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms)), gapMs = 1100): Promise<ApplyResult> {
  const res: ApplyResult = { applied: 0, errors: [] };
  let first = true;
  for (const op of ops) {
    if (!first) await sleep(gapMs);
    first = false;
    const chat = op.item.user_id;
    try {
      if (op.kind === 'send') {
        if (!(await claimSend(db, op.item))) continue;  // someone else is sending it
        try {
          const id = await tg.send(chat, { text: op.text!, pm: op.pm }, op.markup, !!op.silent);
          if (op.replaces) await tg.delete(chat, op.replaces).catch(() => undefined);  // the old message goes only after the new one is out; past 48 h it stays
          await markSent(db, op.item, id, op.key!, now, !op.silent);
        } catch (e) { await releaseClaim(db, op.item); throw e; }
      } else if (op.kind === 'edit') {
        try { await tg.edit(chat, op.message_id!, { text: op.text!, pm: op.pm }, op.markup); }
        catch (e) {
          if (has(e, NOT_MODIFIED)) { /* already shows this */ }
          else if (has(e, MISSING)) {   // the message is gone: a collapsed line is forgotten, a live card is sent anew
            await (op.effect === 'collapse' ? markGone(db, op.item) : db.prepare("UPDATE items SET msg_state = 'none', tg_message_id = NULL WHERE user_id = ? AND id = ?").bind(chat, op.item.id).run()); continue;
          }
          else throw e;
        }
        if (op.effect === 'collapse') await markCollapsed(db, op.item); else await markEdited(db, op.item, op.key!);
      } else {
        await tg.delete(chat, op.message_id!).catch(e => { if (!has(e, MISSING)) throw e; });
        await markGone(db, op.item);
      }
      res.applied++;
    } catch (e) { res.errors.push(`${op.kind} ${op.item.id}: ${String((e as Error).message ?? e).slice(0, 200)}`); }
  }
  return res;
}
