import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capture } from '../../src/core/ops/capture';
import { list, setText, show } from '../../src/core/ops/memories';
import { pending } from '../../src/core/ops/pending';
import { retrieve } from '../../src/core/ops/retrieve';
import { drain } from '../../src/core/worker';
import { fakeLane, stack, unwrap, type Stack } from '../helpers/stack';

let s: Stack;
beforeAll(async () => {
  s = await stack({ document: fakeLane('Póliza de seguro de vehículo BP9344586.\n\nDeducible UF 3,0 por evento para daños propios.\n\nVigencia hasta el 2026-12-31, renovable.') });
});
afterAll(() => s.close());

const cap = (input: Partial<Parameters<typeof capture>[2]>, actor = s.actor) =>
  capture(s.deps, actor, { source: 'cli', maxBytes: 1_000_000, ...input });

describe('capture → read → index → retrieve', () => {
  it('stores a note as ready and finds it', async () => {
    const r = unwrap(await cap({ note: 'La clave del wifi de la casa está pegada en el router' }));
    expect(r.status).toBe('ready');
    await drain(s.deps);
    const found = unwrap(await retrieve(s.deps, s.actor, { query: '¿dónde está la clave del wifi?' }));
    expect(found.passages[0]?.memoryId).toBe(r.id);
    expect(found.vector).toBe('off');
  });

  it('reads a document through the lane and ranks by the rare term', async () => {
    const r = unwrap(await cap({ bytes: Buffer.from('%PDF-1.4 fake'), filename: 'poliza.pdf' }));
    expect(r.status).toBe('pending');
    await drain(s.deps);
    const m = unwrap(await show(s.deps, s.actor, r.id));
    expect(m.status).toBe('ready');
    expect(m.lane).toBe('document');
    const found = unwrap(await retrieve(s.deps, s.actor, { query: 'cuánto es el deducible' }));
    expect(found.passages[0]?.memoryId).toBe(r.id);
  });

  it('matches by prefix without stemming', async () => {
    const found = unwrap(await retrieve(s.deps, s.actor, { query: 'vigente' }));
    expect(found.passages.length).toBe(0);
    const pre = unwrap(await retrieve(s.deps, s.actor, { query: 'vigen' }));
    expect(pre.passages.length).toBeGreaterThan(0);
  });

  it('dedupes the same file for the same owner', async () => {
    const r = unwrap(await cap({ bytes: Buffer.from('%PDF-1.4 fake'), filename: 'otra.pdf' }));
    expect(r.deduped).toBe(true);
  });

  it('sends an unreadable file to needs_text, and the agent text brings it back', async () => {
    const r = unwrap(await cap({ bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00, 1, 2]), filename: 'receta.jpg' }));
    await drain(s.deps);
    const m = unwrap(await show(s.deps, s.actor, r.id));
    expect(m.status).toBe('needs_text');
    expect(m.statusDetail).toContain('vision: off');
    const q = unwrap(await pending(s.deps, s.actor, 'needs_text'));
    expect(q.items.map((i) => i.id)).toContain(r.id);

    unwrap(await setText(s.deps, s.actor, r.id.slice(0, 8), 'Amoxicilina 500 mg cada 8 horas', 'test-agent'));
    await drain(s.deps);
    const found = unwrap(await retrieve(s.deps, s.actor, { query: 'amoxicilina' }));
    expect(found.passages[0]?.memoryId).toBe(r.id);
  });

  it('agent text at capture skips the lanes', async () => {
    const r = unwrap(await cap({ bytes: Buffer.from('OggS voice'), filename: 'nota.ogg', text: 'Llamar al dentista el martes' }));
    expect(r.status).toBe('ready');
    const m = unwrap(await show(s.deps, s.actor, r.id));
    expect(m.lane).toBe('agent');
  });

  it('never shows one owner what belongs to another', async () => {
    unwrap(await cap({ note: 'secreto de bob: patente ZZ-9999' }, s.other));
    await drain(s.deps);
    const mine = unwrap(await retrieve(s.deps, s.actor, { query: 'patente' }));
    expect(mine.passages.length).toBe(0);
    const theirs = unwrap(await list(s.deps, s.other, { query: 'patente' }));
    expect(theirs.items.length).toBe(1);
  });

  it('rejects an empty capture and an oversized file', async () => {
    expect((await cap({})).kind).toBe('err');
    expect((await cap({ bytes: Buffer.alloc(10), maxBytes: 5 })).kind).toBe('err');
  });
});
