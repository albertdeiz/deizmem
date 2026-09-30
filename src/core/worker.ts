import { chunkText } from './chunk';
import { embedMemory, reembedBatch, syncSpaces } from './ops/embeddings';
import { claim, complete, enqueue, fail, type Job } from './jobs';
import { laneFor } from './media';
import { LaneRefused, type Converter, type Deps } from './ports';

/** Below this a document lane "read" nothing: a scanned PDF with no text layer. */
const POOR_TEXT_CHARS = 100;
const MAX_TEXT = 500_000;

export type Lane = 'inline' | 'document' | 'vision' | 'audio';

interface Mem { id: string; owner_id: string; blob_sha256: string | null; media_type: string | null; filename: string | null; password_protected: boolean }

async function setStatus(deps: Deps, id: string, status: string, detail: string | null) {
  await deps.db.query('update memories set status = $2, status_detail = $3 where id = $1', [id, status, detail]);
}

export type Reading = { text: string; lane: Lane } | { text: null; detail: string };

/**
 * Runs a file through its lanes (§8). Document lane first; a poor PDF falls to
 * the visual lane. A lane that is down throws, so the caller can retry; a lane
 * that refuses gives the next one its turn, and its reason ends up in `detail`.
 */
export async function readFile(
  deps: Deps, input: { bytes: Buffer; filename: string; mediaType: string }, password?: string,
): Promise<Reading> {
  const { bytes, mediaType } = input;
  const first = laneFor(mediaType);
  if (first === 'inline') return { text: bytes.toString('utf8'), lane: 'inline' };
  const plan: Array<[Lane, Converter | null]> = [];
  if (first === 'document') plan.push(['document', deps.lanes.document]);
  if (first === 'vision' || (first === 'document' && mediaType === 'application/pdf')) plan.push(['vision', deps.lanes.vision]);
  if (first === 'audio') plan.push(['audio', deps.lanes.audio]);

  const tried: string[] = [];
  for (const [lane, conv] of plan) {
    if (!conv) { tried.push(`${lane}: off`); continue; }
    let text: string;
    try {
      ({ text } = await conv.extract(password === undefined ? input : { ...input, password }));
    } catch (e) {
      if (!(e instanceof LaneRefused)) throw e;
      tried.push(`${lane}: refused (${e.message.slice(0, 120)})`);
      continue;
    }
    if (text.trim().length >= (lane === 'document' ? POOR_TEXT_CHARS : 1)) return { text, lane };
    tried.push(`${lane}: no text`);
  }
  return { text: null, detail: plan.length ? tried.join('; ') : `no lane reads ${mediaType}` };
}

/**
 * Reads a memory's file into text. If no configured lane can read it, the memory
 * goes to `needs_text` — the agent's queue — instead of failing. A file read with
 * a password is not read again: the password is gone, and its text stays.
 */
export async function normalize(deps: Deps, memoryId: string): Promise<void> {
  const r = await deps.db.query<Mem>(
    'select id, owner_id, blob_sha256, media_type, filename, password_protected from memories where id = $1', [memoryId]);
  const m = r.rows[0];
  if (!m || !m.blob_sha256 || m.password_protected) return;
  const bytes = await deps.blobs.get(m.blob_sha256);
  if (!bytes) { await setStatus(deps, m.id, 'failed', 'blob missing from storage'); return; }
  const read = await readFile(deps, { bytes, filename: m.filename ?? 'file', mediaType: m.media_type ?? 'application/octet-stream' });
  if (read.text !== null) await store(deps, m.id, read.text, read.lane);
  else await setStatus(deps, m.id, 'needs_text', read.detail);
}

/**
 * Stores a lane's text and re-indexes. New text means the facts drawn from the
 * old one are no longer checked against it: back to the agent's queue.
 */
export async function store(deps: Deps, id: string, text: string, lane: Lane, extra: { detail?: string; passwordProtected?: boolean } = {}) {
  const clean = text.slice(0, MAX_TEXT);
  await deps.db.tx(async (db) => {
    await db.query(
      `update memories set normalized_text = $2, lane = $3, status = 'ready', status_detail = $4,
              password_protected = password_protected or $5,
              facts_checked_at = case when normalized_text is distinct from $2 then null else facts_checked_at end
        where id = $1`,
      [id, clean, lane, extra.detail ?? null, extra.passwordProtected ?? false]);
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
  else if (job.kind === 'index') {
    await index(deps, id);
    // Vectors are best effort here: a lane that is down leaves gaps that the
    // periodic sync fills, instead of failing the indexing.
    try { await embedMemory(deps, id); } catch { /* filled by reembed */ }
  } else if (job.kind === 'reembed') {
    const more = await reembedBatch(deps, Number(job.payload.spaceId));
    if (more) await enqueue(deps.db, 'reembed', { spaceId: job.payload.spaceId });
  }
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

/** How often the worker re-checks the embed lane's model (§7). */
const SYNC_EVERY_MS = 60_000;

/** The long-running worker loop. */
export async function work(deps: Deps, log: (s: string) => void, idleMs = 2000, signal?: AbortSignal): Promise<void> {
  let lastSync = 0;
  while (!signal?.aborted) {
    if (Date.now() - lastSync > SYNC_EVERY_MS) {
      lastSync = Date.now();
      try {
        const s = await syncSpaces(deps);
        if (s.action !== 'in sync' && s.action !== 'no embed lane') log(`embeddings: ${s.action}`);
      } catch (e) { log(`embeddings sync failed: ${(e as Error).message}`); }
    }
    const n = await drain(deps, log);
    if (n === 0) await new Promise((res) => setTimeout(res, idleMs));
  }
}
