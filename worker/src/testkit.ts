// Test helpers: a D1-shaped wrapper over node:sqlite (the same schema.sql as production) and a recording Telegram fake.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Tg } from './tg.ts';

export function makeDb(): D1Database {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (sql: string, args: unknown[] = []) => {
    const s: any = {
      bind: (...a: unknown[]) => stmt(sql, a),
      run: async () => { const r = db.prepare(sql).run(...(args as never[])); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) }, results: [] }; },
      first: async () => { const r = db.prepare(sql).get(...(args as never[])); return r ? { ...r } : null; },
      all: async () => ({ results: db.prepare(sql).all(...(args as never[])).map(r => ({ ...r })), meta: { changes: 0 } }),
    };
    return s;
  };
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: any[]) => {
      db.exec('BEGIN');
      try { const out = []; for (const s of list) out.push(await s.run()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    exec: async (sql: string) => { db.exec(sql); },
  } as unknown as D1Database;
}

export interface Call { op: string; chat?: number; id?: number; pm?: string; markup?: unknown; text?: string; silent?: boolean; plain?: string; replyTo?: number }
export function fakeTg(): Tg & { calls: Call[]; failNext: (re: string) => void } {
  const calls: Call[] = [];
  let next = 100, fail: string | null = null;
  const maybeFail = () => { if (fail) { const m = fail; fail = null; throw new Error(m); } };
  return {
    calls,
    failNext: (m: string) => { fail = m; },
    send: async (chat, c, markup, silent, replyTo) => { maybeFail(); calls.push({ op: 'send', chat, pm: c.pm, plain: c.text, markup, silent, replyTo }); return ++next; },
    edit: async (chat, id, c, markup) => { maybeFail(); calls.push({ op: 'edit', chat, id, pm: c.pm, plain: c.text, markup }); },
    editMarkup: async (chat, id, markup) => { maybeFail(); calls.push({ op: 'markup', chat, id, markup }); },
    delete: async (chat, id) => { maybeFail(); calls.push({ op: 'delete', chat, id }); },
    answerCallback: async (_id, text) => { calls.push({ op: 'answer', text }); },
  };
}
export const noSleep = async () => undefined;
