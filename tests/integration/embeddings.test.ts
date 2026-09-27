import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capture } from '../../src/core/ops/capture';
import { resetLaneInfo, spaceStatus, syncSpaces } from '../../src/core/ops/embeddings';
import { retrieve } from '../../src/core/ops/retrieve';
import type { Embedder } from '../../src/core/ports';
import { drain } from '../../src/core/worker';
import { stack, unwrap, type Stack } from '../helpers/stack';

/**
 * A fake embedder with a synonym table, so "auto" and "vehículo" land close —
 * the thing a lexical index cannot do. Dimension and model are switchable.
 */
function fakeEmbedder(model: string, dims: number): Embedder & { model: string; dims: number } {
  const groups = [['auto', 'vehiculo', 'car', 'coche'], ['doctor', 'medico', 'receta'], ['wifi', 'router', 'clave']];
  const e = {
    model, dims,
    async info() { return { model: e.model, dimensions: e.dims }; },
    async embed(texts: string[]) {
      return texts.map((t) => {
        const v = new Array(e.dims).fill(0.001);
        const words = t.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').split(/\W+/);
        groups.forEach((g, i) => { if (words.some((w) => g.includes(w))) v[i % e.dims] += 1; });
        return v;
      });
    },
    async health() { return { ok: true, detail: 'fake' }; },
  };
  return e;
}

let s: Stack;
const emb = fakeEmbedder('fake-a', 8);
beforeAll(async () => { resetLaneInfo(); s = await stack({ embed: emb }); });
afterAll(() => s.close());

describe('embedding spaces', () => {
  it('builds the first space and activates it when complete', async () => {
    unwrap(await capture(s.deps, s.actor, { source: 'cli', text: 'Mi coche tiene la patente KXTR-45', maxBytes: 1e6 }));
    unwrap(await capture(s.deps, s.actor, { source: 'cli', text: 'La clave está pegada en el router', maxBytes: 1e6 }));
    const sync = await syncSpaces(s.deps);
    expect(sync.state).toBe('rebuilding');
    await drain(s.deps);
    const st = await spaceStatus(s.deps);
    expect(st.find((x) => x.status === 'active')).toMatchObject({ model: 'fake-a', embedded: st[0]!.chunks });
  });

  it('finds by meaning what the words do not share', async () => {
    const r = unwrap(await retrieve(s.deps, s.actor, { query: 'vehículo' }));
    expect(r.vector).toBe('active');
    expect(r.passages[0]?.content).toContain('coche');
    expect(r.passages[0]?.via).toBe('vector');
  });

  it('a model change rebuilds in the background, lexical meanwhile, atomic switch', async () => {
    emb.model = 'fake-b'; emb.dims = 16; resetLaneInfo();
    const sync = await syncSpaces(s.deps);
    expect(sync.action).toContain('replace fake-a');
    const during = unwrap(await retrieve(s.deps, s.actor, { query: 'patente' }));
    expect(during.vector).toBe('rebuilding');
    expect(during.passages[0]?.content).toContain('KXTR');
    await drain(s.deps);
    const st = await spaceStatus(s.deps);
    expect(st.filter((x) => x.status === 'active').map((x) => x.model)).toEqual(['fake-b']);
    expect(st.find((x) => x.model === 'fake-a')).toMatchObject({ status: 'retired', embedded: 0 });
    const after = unwrap(await retrieve(s.deps, s.actor, { query: 'vehículo' }));
    expect(after.vector).toBe('active');
    expect(after.passages[0]?.content).toContain('coche');
  });

  it('a memory captured after the switch is embedded in the active space', async () => {
    unwrap(await capture(s.deps, s.actor, { source: 'cli', text: 'Receta del médico: ibuprofeno', maxBytes: 1e6 }));
    await drain(s.deps);
    const r = unwrap(await retrieve(s.deps, s.actor, { query: 'doctor' }));
    expect(r.passages[0]?.content).toContain('ibuprofeno');
  });

  it('keeps owners apart in vector search too', async () => {
    const r = unwrap(await retrieve(s.deps, s.other, { query: 'vehículo' }));
    expect(r.passages).toEqual([]);
  });
});
