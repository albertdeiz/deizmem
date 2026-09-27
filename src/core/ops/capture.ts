import { createHash } from 'node:crypto';
import { enqueue } from '../jobs';
import { detectMediaType } from '../media';
import type { Actor, Deps } from '../ports';
import { err, ok, type Result } from '../result';

export interface CaptureInput {
  source: 'mcp' | 'cli';
  bytes?: Buffer | null;
  filename?: string | null;
  mediaType?: string | null;
  /** Text the agent already extracted (a transcript, a handwriting read). Skips the lanes. */
  text?: string | null;
  /** The person's own words. Never overwritten. */
  note?: string | null;
  title?: string | null;
  occurredAt?: string | null;
  tags?: string[];
  maxBytes: number;
}

export interface CaptureResult {
  id: string;
  status: string;
  deduped: boolean;
  sha256: string | null;
  mediaType: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 500_000;

/**
 * Stores first, reads later. The ack never waits for a lane: reading is a job.
 * The blob is written before the row, because a blob without a row is harmless
 * and a row pointing at a missing blob is worse than no row.
 */
export async function capture(deps: Deps, actor: Actor, input: CaptureInput): Promise<Result<CaptureResult>> {
  const bytes = input.bytes && input.bytes.length ? input.bytes : null;
  const text = input.text?.trim() || null;
  const note = input.note?.trim() || null;
  if (!bytes && !text && !note) return err('invalid', 'nothing to capture: send a file, text or a note');
  if (bytes && bytes.length > input.maxBytes) {
    return err('too_large', `file is ${bytes.length} bytes; the limit is ${input.maxBytes}`);
  }
  if (input.occurredAt && !ISO_DATE.test(input.occurredAt)) return err('invalid', 'occurred_at must be YYYY-MM-DD');
  if (text && text.length > MAX_TEXT) return err('too_large', `text is longer than ${MAX_TEXT} characters`);

  let sha: string | null = null;
  let mediaType: string | null = null;
  if (bytes) {
    sha = createHash('sha256').update(bytes).digest('hex');
    mediaType = detectMediaType(bytes, input.filename, input.mediaType);
    const dup = await deps.db.query<{ id: string; status: string }>(
      'select id, status from memories where owner_id = $1 and blob_sha256 = $2 order by captured_at limit 1',
      [actor.ownerId, sha]);
    if (dup.rows[0]) {
      // Same bytes again: keep the memory, but fill a name or a type it was missing.
      // Fills gaps only; nothing already known is overwritten.
      await deps.db.query(
        `update memories set filename = coalesce(filename, $2),
                media_type = case when media_type = 'application/octet-stream' then $3 else media_type end
          where id = $1`, [dup.rows[0].id, input.filename ?? null, mediaType]);
      return ok({ id: dup.rows[0].id, status: dup.rows[0].status, deduped: true, sha256: sha, mediaType });
    }
    await deps.blobs.put(sha, bytes);
  }

  const ready = !bytes || !!text;
  const id = await deps.db.tx(async (db) => {
    if (sha) {
      await db.query(
        'insert into blobs (sha256, size, media_type) values ($1, $2, $3) on conflict do nothing',
        [sha, bytes!.length, mediaType]);
    }
    const r = await db.query<{ id: string }>(
      `insert into memories (owner_id, source, occurred_at, blob_sha256, filename, media_type, note,
                             normalized_text, lane, status, title, tags)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
      [actor.ownerId, input.source, input.occurredAt ?? null, sha, input.filename ?? null, mediaType, note,
       text, text ? 'agent' : null, ready ? 'ready' : 'pending', input.title?.trim() || null, input.tags ?? []]);
    const memoryId = r.rows[0]!.id;
    await enqueue(db, ready ? 'index' : 'normalize', { memoryId });
    return memoryId;
  });

  return ok({ id, status: ready ? 'ready' : 'pending', deduped: false, sha256: sha, mediaType });
}
