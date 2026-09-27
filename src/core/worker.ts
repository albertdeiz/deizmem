import { chunkText } from './chunk';
import { claim, complete, enqueue, fail, type Job } from './jobs';
import { laneFor } from './media';
import { LaneRefused, type Converter, type Deps } from './ports';

/** Below this a document lane "read" nothing: a scanned PDF with no text layer. */
const POOR_TEXT_CHARS = 100;
const MAX_TEXT = 500_000;

type Lane = 'inline' | 'document' | 'vision' | 'audio';

interface Mem { id: string; owner_id: string; blob_sha256: string | null; media_type: string | null; filename: string | null }

async function setStatus(deps: Deps, id: string, status: string, detail: string | null) {
  await deps.db.query('update memories set status = $2, status_detail = $3 where id = $1', [id, status, detail]);
}

/**
 * Reads a memory's file into text (§8). Document lane first; a poor PDF falls
 * to the visual lane. If no configured lane can read it, the memory goes to
 * `needs_text` — the agent's queue — instead of failing.
 */
export async function normalize(deps: Deps, memoryId: string): Promise<void> {
  const r = await deps.db.query<Mem>(
    'select id, owner_id, blob_sha256, media_type, filename from memories where id = $1', [memoryId]);
  const m = r.rows[0];
  if (!m || !m.blob_sha256) return;
  const bytes = await deps.blobs.get(m.blob_sha256);
  if (!bytes) { await setStatus(deps, m.id, 'failed', 'blob missing from storage'); return; }
  const mediaType = m.media_type ?? 'application/octet-stream';
  const input = { bytes, filename: m.filename ?? 'file', mediaType };

  const plan: Array<[Lane, Converter | null]> = [];
  const first = laneFor(mediaType);
  if (first === 'inline') {
    await store(deps, m.id, bytes.toString('utf8'), 'inline');
    return;
  }
  if (first === 'document') plan.push(['document', deps.lanes.document]);
  if (first === 'vision' || (first === 'document' && mediaType === 'application/pdf')) plan.push(['vision', deps.lanes.vision]);
  if (first === 'audio') plan.push(['audio', deps.lanes.audio]);

  const tried: string[] = [];
  for (const [lane, conv] of plan) {
    if (!conv) { tried.push(`${lane}: off`); continue; }
    let text: string;
    try {
      ({ text } = await conv.extract(input)); // a lane that is down throws: the job retries
    } catch (e) {
      if (!(e instanceof LaneRefused)) throw e;
      tried.push(`${lane}: refused (${e.message.slice(0, 120)})`);
      continue;
    }
    if (text.trim().length >= (lane === 'document' ? POOR_TEXT_CHARS : 1)) {
      await store(deps, m.id, text, lane);
      return;
    }
    tried.push(`${lane}: no text`);
  }
  await setStatus(deps, m.id, 'needs_text',
    plan.length ? tried.join('; ') : `no lane reads ${mediaType}`);
}

async function store(deps: Deps, id: string, text: string, lane: Lane) {
  await deps.db.tx(async (db) => {
    await db.query(
      `update memories set normalized_text = $2, lane = $3, status = 'ready', status_detail = null where id = $1`,
      [id, text.slice(0, MAX_TEXT), lane]);
    await enqueue(db, 'index', { memoryId: id });
  });
}

/** Rebuilds a memory's chunks from its note and text. */
export async function index(deps: Deps, memoryId: string): Promise<void> {
  const r = await deps.db.query<{ owner_id: string; note: string | null; normalized_text: string | null }>(
    'select owner_id, note, normalized_text from memories where id = $1', [memoryId]);
  const m = r.rows[0];
  if (!m) return;
  const chunks = chunkText([m.note, m.normalized_text].filter(Boolean).join('\n\n'));
  await deps.db.tx(async (db) => {
    await db.query('delete from chunks where memory_id = $1', [memoryId]);
    for (const [seq, content] of chunks.entries()) {
      await db.query('insert into chunks (owner_id, memory_id, seq, content) values ($1, $2, $3, $4)',
        [m.owner_id, memoryId, seq, content]);
    }
  });
}

export async function runJob(deps: Deps, job: Job): Promise<void> {
  const id = String(job.payload.memoryId ?? '');
  if (job.kind === 'normalize') await normalize(deps, id);
  else if (job.kind === 'index') await index(deps, id);
}

/** Processes jobs until the queue is empty. Returns how many ran. */
export async function drain(deps: Deps, log: (s: string) => void = () => {}): Promise<number> {
  let n = 0;
  for (;;) {
    const job = await claim(deps.db);
    if (!job) return n;
    const t0 = Date.now();
    try {
      await runJob(deps, job);
      await complete(deps.db, job.id);
      log(`job ${job.id} ${job.kind} ok ${Date.now() - t0}ms`);
    } catch (e) {
      const msg = (e as Error).message;
      const final = await fail(deps.db, job, msg);
      if (final && job.kind === 'normalize') {
        await setStatus(deps, String(job.payload.memoryId), 'failed', msg.slice(0, 500));
      }
      log(`job ${job.id} ${job.kind} failed (attempt ${job.attempts}): ${msg}`);
    }
    n++;
  }
}

/** The long-running worker loop. */
export async function work(deps: Deps, log: (s: string) => void, idleMs = 2000, signal?: AbortSignal): Promise<void> {
  while (!signal?.aborted) {
    const n = await drain(deps, log);
    if (n === 0) await new Promise((res) => setTimeout(res, idleMs));
  }
}
