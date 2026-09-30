import { enqueue } from '../jobs';
import type { Actor, Deps } from '../ports';
import { err, ok, type Result } from '../result';
import { readFile, store } from '../worker';
import { resolveId } from './memories';

/**
 * A password opens an encrypted PDF for one read, in the caller's process, and is
 * gone when the call returns (CLAUDE.md §5). It never reaches the job queue — the
 * worker would have to find it in Postgres — nor a row, a log or an error.
 */

export const MAX_PASSWORD = 1024;

/** Takes the password out of any message that could leave the call. */
export const redact = (s: string, secret: string) => (secret ? s.split(secret).join('[redacted]') : s);

const READ_DETAIL = 'read with a password';

/** What the sidecars answer for a PDF they cannot open (services/ocr, services/documents). */
const WRONG = /wrong_password/;

export function checkPassword(password: string | null | undefined): Result<string | null> {
  if (password === undefined || password === null || password === '') return ok(null);
  if (password.length > MAX_PASSWORD) return err('invalid', `password is longer than ${MAX_PASSWORD} characters`);
  return ok(password);
}

export interface UnlockResult { id: string; status: 'ready'; lane: string }

/**
 * Reads a memory's file now, with a password, and stores the text. The memory
 * must already be claimed (status pending) by the caller. Whatever happens, it
 * leaves that status: ready with its text, or needs_text with a redacted reason.
 */
export async function readWithPassword(deps: Deps, memoryId: string, password: string): Promise<Result<UnlockResult>> {
  const r = await deps.db.query<{ blob_sha256: string; media_type: string | null; filename: string | null }>(
    'select blob_sha256, media_type, filename from memories where id = $1', [memoryId]);
  const m = r.rows[0]!;
  const back = async (code: 'wrong_password' | 'unavailable' | 'invalid', message: string) => {
    const clean = redact(message, password).slice(0, 500);
    // A file read with its password before keeps that reading: a failed retry takes nothing away.
    await deps.db.query(
      `update memories set status = case when password_protected then 'ready' else 'needs_text' end,
              status_detail = case when password_protected then $3 else $2 end
        where id = $1`, [memoryId, clean, READ_DETAIL]);
    return err<UnlockResult>(code, clean);
  };
  const bytes = await deps.blobs.get(m.blob_sha256);
  if (!bytes) return back('unavailable', 'the blob is missing from storage');
  let read;
  try {
    read = await readFile(deps, { bytes, filename: m.filename ?? 'file', mediaType: m.media_type ?? 'application/octet-stream' }, password);
  } catch (e) {
    // A lane that is down: the worker would retry, but a retry would need the
    // password again. Send it again when the lane is back.
    return back('unavailable', `a lane is down, send the password again later: ${(e as Error).message}`);
  }
  if (read.text === null) {
    const off = read.detail.split('; ').every((d) => d.endsWith(': off'));
    return back(WRONG.test(read.detail) ? 'wrong_password' : off ? 'unavailable' : 'invalid', read.detail);
  }
  await store(deps, memoryId, read.text, read.lane, { detail: READ_DETAIL, passwordProtected: true });
  return ok({ id: memoryId, status: 'ready', lane: read.lane });
}

/**
 * Claims a memory for a read: only one that is not being read already, so two
 * reads never race. Returns false when another read holds it.
 */
async function claim(deps: Deps, id: string, from: string): Promise<boolean> {
  const r = await deps.db.query(
    `update memories set status = 'pending', status_detail = null where id = $1 and ${from}`, [id]);
  return !!r.rowCount;
}

interface Target { id: string; status: string; blob_sha256: string | null; lane: string | null; password_protected: boolean }

async function target(deps: Deps, actor: Actor, ref: string): Promise<Result<Target>> {
  const id = await resolveId(deps, actor, ref);
  if (id.kind !== 'ok') return id;
  const r = await deps.db.query<Target>(
    'select id, status, blob_sha256, lane, password_protected from memories where owner_id = $1 and id = $2',
    [actor.ownerId, id.value]);
  const m = r.rows[0];
  if (!m) return err('not_found', `no memory ${ref}`);
  if (!m.blob_sha256) return err('invalid', 'this memory has no file, only text');
  return ok(m);
}

/** Which memories a password may open: an unread file, or one read with a password before. */
const UNLOCKABLE = `(status in ('needs_text', 'failed') or (status = 'ready' and password_protected))`;

/** Opens an encrypted file that no lane could read (or reads it again, with its password). */
export async function unlock(deps: Deps, actor: Actor, ref: string, password: string): Promise<Result<UnlockResult>> {
  const pw = checkPassword(password);
  if (pw.kind !== 'ok') return pw;
  if (!pw.value) return err('invalid', 'password is empty');
  const m = await target(deps, actor, ref);
  if (m.kind !== 'ok') return m;
  if (!(await claim(deps, m.value.id, UNLOCKABLE))) {
    return err('conflict', m.value.status === 'pending'
      ? 'this memory is being read right now; try again when it settles'
      : `this memory already has its text (${m.value.status}, lane ${m.value.lane ?? 'none'}); nothing to unlock`);
  }
  return readWithPassword(deps, m.value.id, pw.value);
}

/**
 * Reads a file again through the lanes, in the background: after a lane came
 * back up, or a better one arrived. What an agent or the person wrote is not
 * replaced (§3.6), and a file read with a password needs `unlock` instead.
 */
export async function reread(deps: Deps, actor: Actor, ref: string): Promise<Result<{ id: string; status: 'pending' }>> {
  const m = await target(deps, actor, ref);
  if (m.kind !== 'ok') return m;
  if (m.value.password_protected) return err('conflict', 'this file was read with a password: unlock it again instead');
  if (m.value.lane === 'agent') {
    return err('conflict', 'its text was written by an agent or by the person; re-reading would replace it. Correct the text instead');
  }
  const done = await deps.db.tx(async (db) => {
    const r = await db.query(
      `update memories set status = 'pending', status_detail = null
        where id = $1 and status <> 'pending' and not password_protected and lane is distinct from 'agent'`, [m.value.id]);
    if (r.rowCount) await enqueue(db, 'normalize', { memoryId: m.value.id });
    return !!r.rowCount;
  });
  return done ? ok({ id: m.value.id, status: 'pending' }) : err('conflict', 'this memory is being read right now');
}
