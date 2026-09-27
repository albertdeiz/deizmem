import { migrate, openDb } from '../../src/adapters/db/pg';
import { memoryBlobStore } from '../../src/adapters/blobs/fs';
import { createOwner } from '../../src/core/ops/owners';
import { noLanes, systemClock, type Actor, type Converter, type Deps, type Lanes } from '../../src/core/ports';

export const TEST_DB = process.env.DM_TEST_DATABASE_URL ?? 'postgres://deizmem:deizmem@127.0.0.1:55432/deizmem';

export interface Stack { deps: Deps; actor: Actor; other: Actor; close: () => Promise<void> }

/** A fresh schema, two owners, in-memory blobs and whatever lanes the test brings. */
export async function stack(lanes: Partial<Lanes> = {}): Promise<Stack> {
  const { db, close } = openDb(TEST_DB);
  await db.query('drop schema if exists public cascade; create schema public;');
  await migrate(db, new URL('../../migrations', import.meta.url).pathname);
  const a = await createOwner(db, 'alice');
  const b = await createOwner(db, 'bob');
  if (a.kind !== 'ok' || b.kind !== 'ok') throw new Error('owners');
  return {
    deps: { db, blobs: memoryBlobStore(), lanes: { ...noLanes, ...lanes }, clock: systemClock },
    actor: { ownerId: a.value.id }, other: { ownerId: b.value.id }, close,
  };
}

/** A lane that returns fixed text, or throws. */
export function fakeLane(text: string | Error): Converter {
  return {
    async extract() { if (text instanceof Error) throw text; return { text }; },
    async health() { return { ok: true, detail: 'fake' }; },
  };
}

export function unwrap<T>(r: { kind: string; value?: T; message?: string }): T {
  if (r.kind !== 'ok') throw new Error(`expected ok, got ${r.kind}: ${r.message}`);
  return r.value as T;
}
