// A complete toy extension, the worked example of docs/extending.md: one slash command, one button, one migration, one queue action, one route, one Mini App panel.
// It lives in the core repo only as documentation that the tests keep honest (examples/toy.test.ts); a real extension lives in your private repo and imports from 'pult-worker'.
import { enqueue, resolveSession, type Extension } from '../src/lib.ts';

export interface ToyEnv { TOY_GREETING?: string }   // an extension's own bindings: the Env of the whole worker is the core Env & ToyEnv

export const toy: Extension<ToyEnv> = {
  name: 'toy',

  // 1. A migration: ids start with the extension's name; applied after the core's, once, in one D1 batch with its bookkeeping row.
  migrations: [{ id: 'toy:0001_pings', sql: "CREATE TABLE IF NOT EXISTS toy_pings (n INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '')" }],

  // 2. A slash command (registered in the menu by /setup). It answers with one button whose callback_data starts with the extension's prefix.
  commands: [{
    name: 'ping', description: 'pong, with a button that asks the Mac',
    async run(c) {
      await c.db.prepare('INSERT INTO toy_pings (at) VALUES (?)').bind(c.now).run();
      await c.reply(c.env.TOY_GREETING ?? 'pong', { inline_keyboard: [[{ text: 'Ask the Mac', callback_data: 'toy:mac' }]] });
    },
  }],

  // 3. A button action: everything after the prefix is `data`. It queues an event whose action the Mac side registered (tests/plugins/toy_ping.py).
  callbacks: [{
    prefix: 'toy:',
    async run(c) {
      if (c.data !== 'mac') { await c.answer('unknown button'); return; }   // callback_data is never trusted
      const { session } = await resolveSession(c.db, c.owner, {}, c.now, c.tz);
      await enqueue(c.db, { user_id: c.owner, session_id: session.id, text: 'ping', priority: 1, action: 'ping' }, c.now);
      await c.answer('asked');
    },
  }],

  // 4. A queue action: runs here when the Mac acks an event with that action.
  queueActions: {
    ping: { async onAck(c, _ev, ack) { await c.db.prepare('UPDATE toy_pings SET note = ? WHERE n = (SELECT MAX(n) FROM toy_pings)').bind(ack.status).run(); } },
  },

  // 5. A route, served at /x/toy/count with the same bearer key as the core's.
  routes: [{
    method: 'GET', path: '/count',
    async handler(_req, c) { return Response.json({ count: (await c.db.prepare('SELECT COUNT(*) AS n FROM toy_pings').first<{ n: number }>())!.n }); },
  }],

  // 6. A Mini App panel: declarative data, rendered by the core's page as another tab. No script of its own.
  panels: [{
    id: 'pings', title: 'Pings',
    async data(c) {
      const { results } = await c.db.prepare('SELECT n, at, note FROM toy_pings ORDER BY n DESC LIMIT 20').all<{ n: number; at: number; note: string }>();
      return { rows: results.map(r => ({ title: `ping #${r.n}`, sub: new Date(r.at).toISOString(), badge: r.note || undefined, focus: String(r.n) })) };
    },
  }],

  help: 'toy extension: /ping',
};
