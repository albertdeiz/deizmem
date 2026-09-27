import { enqueue } from '../jobs';
import type { Actor, Deps } from '../ports';
import { err, ok, type Result } from '../result';

export interface MemorySummary {
  id: string;
  title: string | null;
  occurredAt: string | null;
  capturedAt: string;
  status: string;
  lane: string | null;
  domain: string | null;
  tags: string[];
  mediaType: string | null;
  filename: string | null;
  needsReview: boolean;
  hidden: boolean;
}

export interface MemoryDetail extends MemorySummary {
  note: string | null;
  text: string | null;
  statusDetail: string | null;
  domainConfidence: number | null;
  classifiedBy: string | null;
  factsCheckedAt: string | null;
  sha256: string | null;
}

const SUMMARY_COLS = `m.id, m.title, m.occurred_at, m.captured_at, m.status, m.lane, d.slug as domain,
  m.tags, m.media_type, m.filename, m.needs_review, m.hidden`;

type Row = Record<string, any>;

const summary = (r: Row): MemorySummary => ({
  id: r.id, title: r.title, occurredAt: r.occurred_at, capturedAt: (r.captured_at as Date).toISOString(),
  status: r.status, lane: r.lane, domain: r.domain, tags: r.tags, mediaType: r.media_type,
  filename: r.filename, needsReview: r.needs_review, hidden: r.hidden,
});

/**
 * Accepts a full uuid or a unique prefix of at least 6 hex characters: a person
 * copies the first eight, never thirty-six.
 */
export async function resolveId(deps: Deps, actor: Actor, ref: string): Promise<Result<string>> {
  const clean = ref.trim().toLowerCase();
  if (/^[0-9a-f-]{36}$/.test(clean)) return ok(clean);
  if (!/^[0-9a-f]{6,}$/.test(clean)) return err('invalid', `"${ref}" is not a memory id`);
  const r = await deps.db.query<{ id: string }>(
    `select id from memories where owner_id = $1 and id::text like $2 limit 2`, [actor.ownerId, `${clean}%`]);
  if (r.rows.length === 0) return err('not_found', `no memory ${ref}`);
  if (r.rows.length > 1) return err('ambiguous', `prefix ${ref} matches more than one memory`);
  return ok(r.rows[0]!.id);
}

export interface ListInput {
  domain?: string | null;
  from?: string | null;
  to?: string | null;
  status?: string | null;
  includeHidden?: boolean;
  query?: string | null;
  limit?: number;
  cursor?: number;
}

/**
 * Lists memories, newest event first. With `query`, filters to memories whose
 * chunks, title or tags match it — any token, the same OR as retrieval (§7).
 */
export async function list(deps: Deps, actor: Actor, input: ListInput = {}): Promise<Result<{ items: MemorySummary[]; next: number | null }>> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const offset = Math.max(input.cursor ?? 0, 0);
  const tsq = input.query ? orQuery(input.query) : null;
  if (input.query && !tsq) return ok({ items: [], next: null });
  const r = await deps.db.query<Row>(
    `select ${SUMMARY_COLS} from memories m left join domains d on d.id = m.domain_id
      where m.owner_id = $1
        and ($2::text is null or d.slug = $2)
        and ($3::date is null or coalesce(m.occurred_at, m.captured_at::date) >= $3)
        and ($4::date is null or coalesce(m.occurred_at, m.captured_at::date) <= $4)
        and ($5::text is null or m.status = $5)
        and ($6 or not m.hidden)
        and ($7::text is null
             or exists (select 1 from chunks c where c.memory_id = m.id
                        and c.tsv @@ to_tsquery('dm_simple', $7))
             or to_tsvector('dm_simple', coalesce(m.title, '') || ' ' || array_to_string(m.tags, ' '))
                @@ to_tsquery('dm_simple', $7))
      order by coalesce(m.occurred_at, m.captured_at::date) desc, m.captured_at desc
      limit $8 offset $9`,
    [actor.ownerId, input.domain ?? null, input.from ?? null, input.to ?? null, input.status ?? null,
     input.includeHidden ?? false, tsq, limit + 1, offset]);
  const items = r.rows.slice(0, limit).map(summary);
  return ok({ items, next: r.rows.length > limit ? offset + limit : null });
}

/** "a b c" → "a:* | b | c:*": OR of tokens, prefix for 4+ characters (§7). */
export function orQuery(q: string, extra: string[] = []): string | null {
  const terms = [...new Set([q, ...extra].join(' ').normalize('NFKC').toLowerCase()
    .split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3 || /\p{N}/u.test(t)))];
  return terms.length ? terms.map(term).join(' | ') : null;
}

export const term = (t: string) => (t.length >= 4 ? `${t}:*` : t);

export async function show(deps: Deps, actor: Actor, ref: string): Promise<Result<MemoryDetail>> {
  const id = await resolveId(deps, actor, ref);
  if (id.kind !== 'ok') return id;
  const r = await deps.db.query<Row>(
    `select ${SUMMARY_COLS}, m.note, m.normalized_text, m.status_detail, m.domain_confidence,
            m.classified_by, m.facts_checked_at, m.blob_sha256
       from memories m left join domains d on d.id = m.domain_id
      where m.owner_id = $1 and m.id = $2`, [actor.ownerId, id.value]);
  const x = r.rows[0];
  if (!x) return err('not_found', `no memory ${ref}`);
  return ok({
    ...summary(x), note: x.note, text: x.normalized_text, statusDetail: x.status_detail,
    domainConfidence: x.domain_confidence, classifiedBy: x.classified_by,
    factsCheckedAt: x.facts_checked_at ? (x.facts_checked_at as Date).toISOString() : null, sha256: x.blob_sha256,
  });
}

export interface Original { bytes: Buffer; mediaType: string; filename: string }

export async function original(deps: Deps, actor: Actor, ref: string): Promise<Result<Original>> {
  const m = await show(deps, actor, ref);
  if (m.kind !== 'ok') return m;
  if (!m.value.sha256) return err('not_found', 'this memory has no file, only text');
  const bytes = await deps.blobs.get(m.value.sha256);
  if (!bytes) return err('unavailable', 'the blob is missing from storage');
  return ok({ bytes, mediaType: m.value.mediaType ?? 'application/octet-stream',
              filename: m.value.filename ?? `${m.value.id.slice(0, 8)}` });
}

export async function setHidden(deps: Deps, actor: Actor, ref: string, hidden: boolean): Promise<Result<{ id: string; hidden: boolean }>> {
  const id = await resolveId(deps, actor, ref);
  if (id.kind !== 'ok') return id;
  const r = await deps.db.query('update memories set hidden = $3 where owner_id = $1 and id = $2', [actor.ownerId, id.value, hidden]);
  return r.rowCount ? ok({ id: id.value, hidden }) : err('not_found', `no memory ${ref}`);
}

/**
 * The agent's text for a memory no lane could read (a handwritten note, a voice
 * note with Whisper off). Replaces normalized_text only — never the note.
 */
export async function setText(deps: Deps, actor: Actor, ref: string, text: string, by?: string): Promise<Result<{ id: string; status: string }>> {
  const clean = text.trim();
  if (!clean) return err('invalid', 'text is empty');
  const id = await resolveId(deps, actor, ref);
  if (id.kind !== 'ok') return id;
  const done = await deps.db.tx(async (db) => {
    const r = await db.query(
      `update memories set normalized_text = $3, lane = 'agent', status = 'ready',
              status_detail = $4, facts_checked_at = null
        where owner_id = $1 and id = $2`,
      [actor.ownerId, id.value, clean, by ? `text by ${by}` : null]);
    if (r.rowCount) await enqueue(db, 'index', { memoryId: id.value });
    return !!r.rowCount;
  });
  return done ? ok({ id: id.value, status: 'ready' }) : err('not_found', `no memory ${ref}`);
}
