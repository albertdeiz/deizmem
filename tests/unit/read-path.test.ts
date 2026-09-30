import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAllowedPath } from '../../src/adapters/mcp/read-path';

let root: string;
let inbox: string;
let outside: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dm-path-'));
  inbox = join(root, 'inbox');
  outside = join(root, 'outside');
  await mkdir(join(inbox, 'sub'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(inbox, 'sub', 'poliza.txt'), 'póliza BP-9344586');
  await writeFile(join(inbox, 'empty.txt'), '');
  await writeFile(join(inbox, 'big.bin'), Buffer.alloc(100));
  await writeFile(join(outside, 'secret.txt'), 'no');
  await symlink(join(outside, 'secret.txt'), join(inbox, 'link.txt'));
  await mkdir(`${inbox}-evil`);
  await writeFile(join(`${inbox}-evil`, 'x.txt'), 'no');
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

const read = (p: string, dirs = [inbox], max = 50) => readAllowedPath(p, dirs, max);
const code = (r: Awaited<ReturnType<typeof read>>) => (r.kind === 'err' ? r.code : r.kind);

describe('readAllowedPath', () => {
  it('reads a file inside an allowed directory, named by its basename', async () => {
    const r = await read(join(inbox, 'sub', 'poliza.txt'));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.value.bytes.toString()).toBe('póliza BP-9344586');
      expect(r.value.filename).toBe('poliza.txt');
    }
  });

  it('is off when no directory is configured', async () => {
    expect(code(await read(join(inbox, 'sub', 'poliza.txt'), []))).toBe('forbidden');
  });

  it('refuses a relative path', async () => {
    expect(code(await read('inbox/sub/poliza.txt'))).toBe('invalid');
  });

  it('refuses what resolves outside: .., a symlink, a sibling with the same prefix', async () => {
    expect(code(await read(join(inbox, '..', 'outside', 'secret.txt')))).toBe('forbidden');
    expect(code(await read(join(inbox, 'link.txt')))).toBe('forbidden');
    expect(code(await read(join(`${inbox}-evil`, 'x.txt')))).toBe('forbidden');
  });

  it('says clearly what is wrong with the file', async () => {
    expect(code(await read(join(inbox, 'nope.txt')))).toBe('not_found');
    expect(code(await read(join(inbox, 'sub')))).toBe('invalid');
    expect(code(await read(join(inbox, 'empty.txt')))).toBe('invalid');
    expect(code(await read(join(inbox, 'big.bin')))).toBe('too_large');
  });
});
