// Schema migrations. Core ones live here; an extension brings its own (ids prefixed `<extension>:`), applied after the core ones.
// A migration is a list of statements run in ONE D1 batch together with the bookkeeping row, so it lands whole or not at all,
// and two isolates racing on a cold start cannot both apply it (the loser's batch fails on the primary key and is read as "already applied").
import { SCHEMA_0001 } from './schema.gen.ts';

/** `addColumns` is the idempotent ALTER: each column is added only when the table lacks it (a database that already has it, say the live one of a private bot, is left alone). Runs before `sql`. */
export interface AddColumn { table: string; column: string; ddl: string }
export interface Migration { id: string; sql?: string | string[]; addColumns?: AddColumn[] }

export const CORE_MIGRATIONS: Migration[] = [
  { id: 'core:0001_init', sql: SCHEMA_0001 },
  // Who holds a lease and since when: the slots of an extension and the heartbeat ceiling need them. Both exist already on a database that grew them elsewhere.
  { id: 'core:0003_lease_columns', addColumns: [{ table: 'events', column: 'lease_started', ddl: 'INTEGER' }, { table: 'events', column: 'leased_by', ddl: 'TEXT' }] },
  // Later core changes are appended here as `core:NNNN_name`, additive only, and never edit an entry that has shipped.
];

/** Splits a plain SQL string on statement boundaries. No triggers or semicolons inside string literals: give those as an array. */
export const statements = (m: Migration): string[] =>
  !m.sql ? [] : Array.isArray(m.sql) ? m.sql : m.sql.split('\n').filter(l => !/^\s*--/.test(l)).join('\n').split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean);

export async function migrate(db: D1Database, list: Migration[]): Promise<string[]> {
  await db.prepare('CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)').run();
  const done = new Set(((await db.prepare('SELECT id FROM _migrations').all<{ id: string }>()).results).map(r => r.id));
  const applied: string[] = [];
  for (const m of list) {
    if (done.has(m.id)) continue;
    try {
      const alters: string[] = [];
      for (const a of m.addColumns ?? []) {
        if (!/^[a-z_]+$/.test(a.table) || !/^[a-z_]+$/.test(a.column)) throw new Error(`migration ${m.id}: bad table or column name`);
        const have = (await db.prepare(`SELECT 1 AS x FROM pragma_table_info('${a.table}') WHERE name = ?`).bind(a.column).first());
        if (!have) alters.push(`ALTER TABLE ${a.table} ADD COLUMN ${a.column} ${a.ddl}`);
      }
      await db.batch([...alters.map(s => db.prepare(s)), ...statements(m).map(s => db.prepare(s)), db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)').bind(m.id, Date.now())]);
      applied.push(m.id);
    } catch (e) {
      if (await db.prepare('SELECT 1 AS x FROM _migrations WHERE id = ?').bind(m.id).first()) continue;   // another isolate got there first
      throw new Error(`migration ${m.id} failed: ${String((e as Error).message ?? e)}`);
    }
  }
  return applied;
}
