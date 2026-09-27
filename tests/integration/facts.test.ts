import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capture } from '../../src/core/ops/capture';
import { classify, createDomain, listDomains, mergeDomains } from '../../src/core/ops/domains';
import { pending } from '../../src/core/ops/pending';
import { verify } from '../../src/core/ops/verify';
import { createFactType } from '../../src/core/facts/registry';
import { putFacts, queryFacts } from '../../src/core/facts/facts';
import { stack, unwrap, type Stack } from '../helpers/stack';

let s: Stack;
const by = 'test/agent';
const note = async (text: string, actor = s.actor) =>
  unwrap(await capture(s.deps, actor, { source: 'cli', text, maxBytes: 1e6 })).id;

const policy = (n: string, from: string, until: string, ded: string) =>
  `Poliza de Automovil N° ${n}\nVigencia: ${from} al ${until}\nDeducible: UF ${ded} por siniestro`;

beforeAll(async () => {
  s = await stack();
  unwrap(await createFactType(s.deps, s.actor, {
    slug: 'poliza_auto', kind: 'estado', cardinality: 'one', description: 'Póliza de seguro de auto',
    domainSlug: 'seguros', identityField: 'numero',
    fields: [{ name: 'numero', kind: 'text' }, { name: 'deducible', kind: 'number' }],
  }, true));
  unwrap(await createFactType(s.deps, s.actor, {
    slug: 'pasaje', kind: 'periodo', cardinality: 'many', description: 'Pasaje de bus', domainSlug: null,
    identityField: 'pasajero', fields: [{ name: 'pasajero', kind: 'text' }, { name: 'asiento', kind: 'text' }],
  }, true));
});
afterAll(() => s.close());

describe('the registry asks first', () => {
  it('returns requires_confirmation without yes, and creates with it', async () => {
    const r = await createDomain(s.deps, s.actor, { slug: 'seguros', description: 'pólizas y seguros' });
    expect(r.kind).toBe('requires_confirmation');
    expect(await listDomains(s.deps, s.actor)).toHaveLength(0);
    unwrap(await createDomain(s.deps, s.actor, { slug: 'seguros', description: 'pólizas y seguros' }, true));
    expect(await listDomains(s.deps, s.actor)).toHaveLength(1);
  });

  it('rejects an estado type without identity', async () => {
    const r = await createFactType(s.deps, s.actor, { slug: 'x_y', kind: 'estado', cardinality: 'one', description: 'x',
      domainSlug: null, identityField: null, fields: [{ name: 'a', kind: 'text' }] }, true);
    expect(r.kind).toBe('err');
  });
});

describe('classification and the work queue', () => {
  it('moves a memory out of unclassified and unextracted', async () => {
    const id = await note('Receta del doctor: paracetamol 500 mg');
    let q = unwrap(await pending(s.deps, s.actor));
    expect(q.items.find((i) => i.id === id)?.reasons).toEqual(expect.arrayContaining(['unclassified', 'unextracted']));
    unwrap(await classify(s.deps, s.actor, { id, domain: 'seguros', by, needsReview: true }));
    unwrap(await putFacts(s.deps, s.actor, { memoryId: id, instances: [], by }));
    q = unwrap(await pending(s.deps, s.actor));
    expect(q.items.find((i) => i.id === id)?.reasons).toEqual(['review']);
  });
});

describe('facts: evidence, supersession, conflict, expiry', () => {
  it('stores grounded fields and rejects the rest, field by field', async () => {
    const id = await note(policy('BP-9344586', '01/03/2025', '01/03/2026', '3,0'));
    const r = unwrap(await putFacts(s.deps, s.actor, { memoryId: id, type: 'poliza_auto', by, instances: [{
      fields: {
        numero: { value: 'BP-9344586', evidence: 'Poliza de Automovil N° BP-9344586' },
        deducible: { value: 5, evidence: 'Deducible: UF 3,0 por siniestro' },
      },
      valid_from: { value: '2025-03-01', evidence: 'Vigencia: 01/03/2025 al 01/03/2026' },
      valid_until: { value: '2026-03-01', evidence: 'Vigencia: 01/03/2025 al 01/03/2026' },
    }] }));
    expect(r.stored).toEqual([{ identity: 'bp9344586', fields: ['numero'] }]);
    expect(r.rejected).toEqual([{ instance: 0, field: 'deducible', reason: 'number not found in evidence' }]);
  });

  it('the new policy supersedes the old; the old is still there with history', async () => {
    const id = await note(policy('BP 9344586', '01/03/2026', '01/03/2027', '5'));
    unwrap(await putFacts(s.deps, s.actor, { memoryId: id, type: 'poliza_auto', by, instances: [{
      fields: { numero: { value: 'BP 9344586', evidence: 'N° BP 9344586' }, deducible: { value: 5, evidence: 'Deducible: UF 5 por siniestro' } },
      valid_from: { value: '2026-03-01', evidence: 'Vigencia: 01/03/2026 al 01/03/2027' },
      valid_until: { value: '2027-03-01', evidence: 'Vigencia: 01/03/2026 al 01/03/2027' },
    }] }));
    const now = unwrap(await queryFacts(s.deps, s.actor, { type: 'poliza_auto', at: '2026-06-01' }));
    expect(now.facts).toHaveLength(1);
    expect(now.facts[0]).toMatchObject({ status: 'current', memoryId: id, payload: { deducible: 5 } });
    const all = unwrap(await queryFacts(s.deps, s.actor, { type: 'poliza_auto', at: '2026-06-01', history: true }));
    expect(all.facts.map((f) => f.status)).toEqual(['current', 'superseded']);
    const later = unwrap(await queryFacts(s.deps, s.actor, { type: 'poliza_auto', at: '2027-06-01' }));
    expect(later.facts[0]?.status).toBe('expired');
  });

  it('overlapping explicit validity is a conflict, never a silent pick', async () => {
    const id = await note(policy('BP-9344586', '01/06/2026', '01/06/2027', '7'));
    unwrap(await putFacts(s.deps, s.actor, { memoryId: id, type: 'poliza_auto', by, instances: [{
      fields: { numero: { value: 'BP-9344586', evidence: 'N° BP-9344586' } },
      valid_from: { value: '2026-06-01', evidence: 'Vigencia: 01/06/2026 al 01/06/2027' },
      valid_until: { value: '2027-06-01', evidence: 'Vigencia: 01/06/2026 al 01/06/2027' },
    }] }));
    const r = unwrap(await queryFacts(s.deps, s.actor, { type: 'poliza_auto', at: '2026-07-01' }));
    expect(r.facts.map((f) => f.status)).toEqual(['conflict', 'conflict']);
  });

  it('many: two passengers in one document coexist', async () => {
    const id = await note('Pasajero: Alberto Diaz Asiento: 4\nPasajero: Emily Soto Asiento: 5');
    const r = unwrap(await putFacts(s.deps, s.actor, { memoryId: id, type: 'pasaje', by, instances: [
      { fields: { pasajero: { value: 'Alberto Diaz', evidence: 'Pasajero: Alberto Diaz' }, asiento: { value: '4', evidence: 'Alberto Diaz Asiento: 4' } } },
      { fields: { pasajero: { value: 'Emily Soto', evidence: 'Pasajero: Emily Soto' }, asiento: { value: '5', evidence: 'Emily Soto Asiento: 5' } } },
    ] }));
    expect(r.rejected).toEqual([]);
    const q = unwrap(await queryFacts(s.deps, s.actor, { type: 'pasaje' }));
    expect(q.facts.map((f) => f.payload.asiento).sort()).toEqual(['4', '5']);
  });

  it('keeps owners apart', async () => {
    const r = await queryFacts(s.deps, s.other, { type: 'poliza_auto' });
    expect(r).toMatchObject({ kind: 'err', code: 'not_found' });
  });
});

describe('verify', () => {
  it('flags the invented figure and passes the real ones', async () => {
    const id = await note('Deducible: UF 3,0 por siniestro. Total $1.747.885');
    const good = unwrap(await verify(s.deps, s.actor, { text: 'Tu deducible es 3 UF y el total $1.747.885.', memoryIds: [id] }));
    expect(good.ok).toBe(true);
    const bad = unwrap(await verify(s.deps, s.actor, { text: 'Tu deducible es 5 UF.', memoryIds: [id.slice(0, 8)] }));
    expect(bad.missing).toEqual(['5']);
  });
});

describe('merge', () => {
  it('moves memories and archives the source', async () => {
    unwrap(await createDomain(s.deps, s.actor, { slug: 'autos', description: 'x' }, true));
    const id = await note('algo de autos');
    unwrap(await classify(s.deps, s.actor, { id, domain: 'autos', by }));
    expect((await mergeDomains(s.deps, s.actor, 'autos', 'seguros')).kind).toBe('requires_confirmation');
    expect(unwrap(await mergeDomains(s.deps, s.actor, 'autos', 'seguros', true)).moved).toBe(1);
  });
});
