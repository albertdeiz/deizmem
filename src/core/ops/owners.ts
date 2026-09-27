import { err, ok, type Result } from '../result';
import type { Actor, Db } from '../ports';

export interface Owner { id: string; name: string; createdAt: string }

const row = (r: { id: string; name: string; created_at: Date }): Owner =>
  ({ id: r.id, name: r.name, createdAt: r.created_at.toISOString() });

export async function listOwners(db: Db): Promise<Owner[]> {
  const r = await db.query<{ id: string; name: string; created_at: Date }>(
    'select id, name, created_at from owners order by created_at');
  return r.rows.map(row);
}

export async function createOwner(db: Db, name: string): Promise<Result<Owner>> {
  const clean = name.trim();
  if (!clean) return err('invalid', 'owner name is empty');
  const r = await db.query<{ id: string; name: string; created_at: Date }>(
    `insert into owners (name) values ($1) on conflict (name) do nothing
     returning id, name, created_at`, [clean]);
  if (!r.rows[0]) return err('conflict', `owner "${clean}" already exists`);
  return ok(row(r.rows[0]));
}

/**
 * The operator's actor. By id or name; with nothing given, the only owner if
 * there is exactly one. Never used by MCP, whose actor comes from a token.
 */
export async function resolveOperatorActor(db: Db, ref?: string): Promise<Result<Actor>> {
  const owners = await listOwners(db);
  if (ref) {
    const o = owners.find((x) => x.id === ref || x.name === ref);
    return o ? ok({ ownerId: o.id }) : err('not_found', `no owner "${ref}"`);
  }
  if (owners.length === 1) return ok({ ownerId: owners[0]!.id });
  if (owners.length === 0) return err('not_found', 'no owners yet: run `dm init`');
  return err('ambiguous', 'more than one owner: pass --actor');
}
