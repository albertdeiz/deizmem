import { enqueue } from '../jobs';
import type { Actor, Deps } from '../ports';
import { ok, type Result } from '../result';

export interface ReprocessInput {
  /** Which memories: by status (default needs_text + failed), or every file. */
  status?: string[];
  all?: boolean;
  /** Re-queue what a given agent decided: clears its classification and facts check. */
  by?: string | null;
}

/**
 * What a lane produced is recomputed from the blob; what an agent decided is
 * re-queued for the agent, never recomputed — the memory has no model to do it (§3.6).
 * A file read with a password is skipped: without it, re-reading can only lose its text.
 */
export async function reprocess(deps: Deps, actor: Actor, input: ReprocessInput): Promise<Result<{ normalize: number; requeued: number }>> {
  let requeued = 0;
  if (input.by) {
    const r = await deps.db.query(
      `update memories set domain_id = null, domain_confidence = null, classified_by = null, facts_checked_at = null
        where owner_id = $1 and classified_by = $2`, [actor.ownerId, input.by]);
    const f = await deps.db.query(
      `update memories m set facts_checked_at = null where owner_id = $1
         and exists (select 1 from facts x where x.memory_id = m.id and x.extracted_by = $2)`, [actor.ownerId, input.by]);
    requeued = (r.rowCount ?? 0) + (f.rowCount ?? 0);
    if (!input.status && !input.all) return ok({ normalize: 0, requeued });
  }
  const statuses = input.status ?? ['needs_text', 'failed'];
  const ids = await deps.db.query<{ id: string }>(
    `select id from memories where owner_id = $1 and blob_sha256 is not null
        and ($2 or status = any($3::text[])) and lane is distinct from 'agent' and not password_protected`,
    [actor.ownerId, input.all ?? false, statuses]);
  await deps.db.tx(async (db) => {
    for (const { id } of ids.rows) {
      await db.query(`update memories set status = 'pending', status_detail = null where id = $1`, [id]);
      await enqueue(db, 'normalize', { memoryId: id });
    }
  });
  return ok({ normalize: ids.rows.length, requeued });
}
