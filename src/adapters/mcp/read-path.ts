import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, sep } from 'node:path';
import { err, ok, type Result } from '../../core/result';

/**
 * Reads a file the agent names by path, for an agent that cannot send the bytes.
 * Only inside the directories the operator listed (DM_CAPTURE_DIRS): a path is
 * resolved with realpath first, so a symlink or a `..` cannot step outside them.
 * Only a regular file, and never more than the upload limit.
 */
export async function readAllowedPath(
  path: string, dirs: string[], maxBytes: number,
): Promise<Result<{ bytes: Buffer; filename: string }>> {
  if (!dirs.length) return err('forbidden', 'capture by path is off: the server has no DM_CAPTURE_DIRS');
  if (!isAbsolute(path) || path.includes('\0')) return err('invalid', 'path must be absolute');

  let real: string;
  try {
    real = await realpath(path);
  } catch (e) {
    return fsError(e, path);
  }
  const roots = await Promise.all(dirs.map((d) => realpath(d).catch(() => null)));
  if (!roots.some((r) => r && (real === r || real.startsWith(r.endsWith(sep) ? r : r + sep)))) {
    return err('forbidden', `path is outside the directories the server may read: ${dirs.join(', ')}`);
  }

  let fh;
  try {
    fh = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    return fsError(e, path);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return err('invalid', `not a regular file: ${path}`);
    if (st.size > maxBytes) return err('too_large', `file is ${st.size} bytes; the limit is ${maxBytes}`);
    if (st.size === 0) return err('invalid', `file is empty: ${path}`);
    return ok({ bytes: await fh.readFile(), filename: basename(real) });
  } catch (e) {
    return fsError(e, path);
  } finally {
    await fh.close();
  }
}

function fsError(e: unknown, path: string): Result<never> {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return err('not_found', `no such file on the server: ${path}`);
  if (code === 'EACCES' || code === 'EPERM') return err('forbidden', `the server cannot read: ${path}`);
  if (code === 'ELOOP') return err('forbidden', `path changed while reading: ${path}`);
  if (code === 'EISDIR') return err('invalid', `not a regular file: ${path}`);
  return err('unavailable', `could not read ${path}: ${code ?? (e as Error).message}`);
}
