import type { Db } from './ports';

export type JobKind = 'normalize' | 'index' | 'reembed';

export interface Job { id: number; kind: JobKind; payload: Record<string, unknown>; attempts: number }

export async function enqueue(db: Db, kind: JobKind, payload: Record<string, unknown>): Promise<void> {
  await db.query('insert into jobs (kind, payload) values ($1, $2)', [kind, JSON.stringify(payload)]);
}

/**
 * Claims one ready job. `skip locked` lets several workers share the table; a
 * lock older than the lease is treated as a crashed worker and taken over.
 */
export async function claim(db: Db, leaseSeconds = 900): Promise<Job | null> {
  const r = await db.query<{ id: string; kind: JobKind; payload: Record<string, unknown>; attempts: number }>(
    `update jobs set locked_at = now(), attempts = attempts + 1
      where id = (
        select id from jobs
         where done_at is null and error is null and run_after <= now()
           and (locked_at is null or locked_at < now() - make_interval(secs => $1))
         order by id for update skip locked limit 1)
      returning id, kind, payload, attempts`, [leaseSeconds]);
  const j = r.rows[0];
  return j ? { id: Number(j.id), kind: j.kind, payload: j.payload, attempts: j.attempts } : null;
}

export async function complete(db: Db, id: number): Promise<void> {
  await db.query('update jobs set done_at = now(), locked_at = null where id = $1', [id]);
}

/** Retries with backoff; after `max` attempts the job stays failed with its error. */
export async function fail(db: Db, job: Job, error: string, max = 4): Promise<boolean> {
  if (job.attempts >= max) {
    await db.query('update jobs set error = $2, locked_at = null where id = $1', [job.id, error.slice(0, 2000)]);
    return true;
  } else {
    await db.query(
      `update jobs set locked_at = null, run_after = now() + make_interval(secs => $2) where id = $1`,
      [job.id, 30 * 2 ** job.attempts]);
    return false;
  }
}
