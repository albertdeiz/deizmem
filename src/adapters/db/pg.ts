import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import type { Db } from '../../core/ports';

// pgvector and date columns come back as strings; dates stay ISO (YYYY-MM-DD).
pg.types.setTypeParser(1082, (v) => v);

type Queryable = pg.Pool | pg.PoolClient;

const wrap = (q: Queryable, pool: pg.Pool): Db => ({
  async query(sql, params) {
    const r = await q.query(sql, params as unknown[]);
    return { rows: r.rows, rowCount: r.rowCount };
  },
  async tx(fn) {
    if (q !== pool) return fn(wrap(q, pool)); // already inside one
    const client = await pool.connect();
    try {
      await client.query('begin');
      const out = await fn(wrap(client, pool));
      await client.query('commit');
      return out;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  },
});

export function openDb(url: string): { db: Db; close: () => Promise<void> } {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  return { db: wrap(pool, pool), close: () => pool.end() };
}

/** Applies every migrations/*.sql not yet recorded, in name order. */
export async function migrate(db: Db, dir: string): Promise<string[]> {
  await db.query(`create table if not exists schema_migrations (
    name text primary key, applied_at timestamptz not null default now())`);
  const done = new Set(
    (await db.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(join(dir, f), 'utf8');
    await db.tx(async (t) => {
      await t.query(sql);
      await t.query('insert into schema_migrations (name) values ($1)', [f]);
    });
    applied.push(f);
  }
  return applied;
}
