import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BlobStore } from '../../core/ports';

/**
 * Blobs on disk, content-addressed: blobs/<aa>/<bb>/<sha256>. Written to a temp
 * name and renamed, so a crash never leaves a half file under the real name.
 */
export function fsBlobStore(root: string): BlobStore {
  const path = (sha: string) => join(root, sha.slice(0, 2), sha.slice(2, 4), sha);
  return {
    async put(sha, bytes) {
      const p = path(sha);
      await mkdir(dirname(p), { recursive: true });
      const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, bytes);
      await rename(tmp, p);
    },
    async get(sha) {
      try {
        return await readFile(path(sha));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },
    async delete(sha) {
      await rm(path(sha), { force: true });
    },
  };
}

export function memoryBlobStore(): BlobStore {
  const m = new Map<string, Buffer>();
  return {
    async put(sha, bytes) { m.set(sha, bytes); },
    async get(sha) { return m.get(sha) ?? null; },
    async delete(sha) { m.delete(sha); },
  };
}
