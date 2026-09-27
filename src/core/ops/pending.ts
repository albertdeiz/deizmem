import type { Actor, Deps } from '../ports';
import { ok, type Result } from '../result';
import type { MemorySummary } from './memories';

export type PendingKind = 'needs_text' | 'unclassified' | 'unextracted' | 'review' | 'failed';

export const PENDING_KINDS: PendingKind[] = ['needs_text', 'unclassified', 'unextracted', 'review', 'failed'];

/**
 * The agent's work queue (§5): what a memory still lacks to be useful. Nothing
 * here is an error; it is work waiting for whoever can do it.
 */
const WHERE: Record<PendingKind, string> = {
  needs_text: `m.status = 'needs_text'`,
  unclassified: `m.status = 'ready' and m.domain_id is null`,
  unextracted: `m.status = 'ready' and m.facts_checked_at is null`,
  review: `m.needs_review`,
  failed: `m.status = 'failed'`,
};

export interface PendingResult {
  counts: Record<PendingKind, number>;
  items: Array<MemorySummary & { reasons: PendingKind[]; statusDetail: string | null }>;
}

export async function pending(deps: Deps, actor: Actor, kind?: PendingKind | null, limit = 20): Promise<Result<PendingResult>> {
  const counts = await deps.db.query<Record<PendingKind, string>>(
    `select ${PENDING_KINDS.map((k) => `count(*) filter (where ${WHERE[k]}) as ${k}`).join(', ')}
       from memories m where m.owner_id = $1 and not m.hidden`, [actor.ownerId]);
  const c = counts.rows[0]!;
  const kinds = kind ? [kind] : PENDING_KINDS;
  const r = await deps.db.query<Record<string, any>>(
    `select m.id, m.title, m.occurred_at, m.captured_at, m.status, m.lane, d.slug as domain, m.tags,
            m.media_type, m.filename, m.needs_review, m.hidden, m.status_detail,
            array_remove(array[${PENDING_KINDS.map((k) => `case when ${WHERE[k]} then '${k}' end`).join(', ')}], null) as reasons
       from memories m left join domains d on d.id = m.domain_id
      where m.owner_id = $1 and not m.hidden and (${kinds.map((k) => `(${WHERE[k]})`).join(' or ')})
      order by m.captured_at limit $2`, [actor.ownerId, Math.min(Math.max(limit, 1), 100)]);
  return ok({
    counts: Object.fromEntries(PENDING_KINDS.map((k) => [k, Number(c[k])])) as Record<PendingKind, number>,
    items: r.rows.map((x) => ({
      id: x.id, title: x.title, occurredAt: x.occurred_at, capturedAt: (x.captured_at as Date).toISOString(),
      status: x.status, lane: x.lane, domain: x.domain, tags: x.tags, mediaType: x.media_type,
      filename: x.filename, needsReview: x.needs_review, hidden: x.hidden,
      reasons: x.reasons, statusDetail: x.status_detail,
    })),
  });
}
