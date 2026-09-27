import { resolveId } from '../ops/memories';
import type { Actor, Db, Deps } from '../ports';
import { err, ok, type Result } from '../result';
import { checkField, type Canonical } from './evidence';
import { findFactType, type FactType } from './registry';

export interface FieldInput { value: unknown; evidence: string }

export interface InstanceInput {
  fields: Record<string, FieldInput>;
  /** Validity, each grounded like any field. */
  valid_from?: FieldInput;
  valid_until?: FieldInput;
  confidence?: number;
}

export interface PutInput {
  memoryId: string;
  /** Omit together with instances: [] to say "I checked; no type applies". */
  type?: string | null;
  instances: InstanceInput[];
  by: string;
}

export interface Rejection { instance: number; field: string; reason: string }

export interface PutResult {
  memoryId: string;
  stored: Array<{ identity: string; fields: string[] }>;
  rejected: Rejection[];
}

interface Mem { id: string; text: string }

async function memoryText(db: Db, actor: Actor, id: string): Promise<Mem | null> {
  const r = await db.query<{ id: string; note: string | null; normalized_text: string | null }>(
    'select id, note, normalized_text from memories where owner_id = $1 and id = $2', [actor.ownerId, id]);
  const m = r.rows[0];
  return m ? { id: m.id, text: [m.note, m.normalized_text].filter(Boolean).join('\n\n') } : null;
}

/**
 * Stores the agent's facts for one memory and type, after checking every field
 * against the document (§6). Re-putting a type for a memory replaces that
 * memory's facts of that type: extraction is idempotent. Fields that fail are
 * rejected one by one with a reason; an instance without its identity is dropped.
 */
export async function putFacts(deps: Deps, actor: Actor, input: PutInput): Promise<Result<PutResult>> {
  if (!input.by?.trim()) return err('invalid', 'by is required ("<agent>/<model>")');
  const id = await resolveId(deps, actor, input.memoryId);
  if (id.kind !== 'ok') return id;
  const mem = await memoryText(deps.db, actor, id.value);
  if (!mem) return err('not_found', `no memory ${input.memoryId}`);

  if (!input.type) {
    if (input.instances.length) return err('invalid', 'instances need a type');
    await deps.db.query('update memories set facts_checked_at = now() where id = $1', [mem.id]);
    return ok({ memoryId: mem.id, stored: [], rejected: [] });
  }
  const type = await findFactType(deps.db, actor, input.type);
  if (!type || !type.active) return err('not_found', `no active fact type ${input.type}; see fact_types_list`);
  if (!mem.text) return err('invalid', 'this memory has no text yet: it cannot back any fact');
  if (type.cardinality === 'one' && input.instances.length > 1) {
    return err('invalid', `${type.slug} is cardinality one: send a single instance`);
  }

  const rejected: Rejection[] = [];
  const rows: Array<{ identity: string; payload: Record<string, Canonical>; evidence: Record<string, string>;
    validFrom: string | null; validUntil: string | null; confidence: number | null }> = [];

  input.instances.forEach((inst, i) => {
    const payload: Record<string, Canonical> = {};
    const evidence: Record<string, string> = {};
    for (const [name, f] of Object.entries(inst.fields ?? {})) {
      const def = type.fields.find((x) => x.name === name);
      if (!def) { rejected.push({ instance: i, field: name, reason: `not a field of ${type.slug}` }); continue; }
      const c = checkField(def.kind, f?.value, f?.evidence, mem.text);
      if (!c.ok) { rejected.push({ instance: i, field: name, reason: c.reason! }); continue; }
      payload[name] = c.value!;
      evidence[name] = f.evidence;
    }
    const validity = (key: 'valid_from' | 'valid_until'): string | null => {
      const f = inst[key];
      if (!f) return null;
      const c = checkField('date', f.value, f.evidence, mem.text);
      if (!c.ok) { rejected.push({ instance: i, field: key, reason: c.reason! }); return null; }
      evidence[key] = f.evidence;
      return c.value as string;
    };
    const validFrom = validity('valid_from');
    const validUntil = validity('valid_until');
    if (validFrom && validUntil && validUntil < validFrom) {
      rejected.push({ instance: i, field: 'valid_until', reason: 'valid_until is before valid_from' });
    }
    let identity = '';
    if (type.identityField) {
      const v = payload[type.identityField];
      if (v === undefined) {
        rejected.push({ instance: i, field: type.identityField, reason: 'identity field missing or rejected: instance dropped' });
        return;
      }
      identity = identityKey(v);
    }
    if (!Object.keys(payload).length) return;
    if (rows.some((r) => r.identity === identity)) {
      rejected.push({ instance: i, field: type.identityField ?? '*', reason: 'duplicate identity in this call' });
      return;
    }
    rows.push({ identity, payload, evidence, validFrom, validUntil, confidence: inst.confidence ?? null });
  });

  await deps.db.tx(async (db) => {
    const before = await db.query<{ identity: string }>(
      'select identity from facts where memory_id = $1 and type_id = $2', [mem.id, type.id]);
    await db.query('delete from facts where memory_id = $1 and type_id = $2', [mem.id, type.id]);
    for (const r of rows) {
      await db.query(
        `insert into facts (owner_id, memory_id, type_id, identity, payload, evidence, valid_from, valid_until, confidence, extracted_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [actor.ownerId, mem.id, type.id, r.identity, JSON.stringify(r.payload), JSON.stringify(r.evidence),
         r.validFrom, r.validUntil, r.confidence, input.by.trim()]);
    }
    await db.query('update memories set facts_checked_at = now() where id = $1', [mem.id]);
    const touched = new Set([...before.rows.map((x) => x.identity), ...rows.map((r) => r.identity)]);
    if (type.kind === 'estado') for (const identity of touched) await supersede(db, actor, type, identity);
  });

  return ok({ memoryId: mem.id, stored: rows.map((r) => ({ identity: r.identity, fields: Object.keys(r.payload) })), rejected });
}

/** Identity as a comparable key: "BP-9344586" and "bp 9344586" are the same instance. */
export function identityKey(v: Canonical): string {
  const s = typeof v === 'object' ? `${v.amount}` : String(v);
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Supersession for one (type, identity) of an `estado` type — arithmetic on
 * dates, so it belongs to the memory, not the agent (§4). Ordered by start;
 * each fact is superseded by the next one unless both carry explicit intervals
 * that overlap past a shared boundary day — a conflict, which supersedes nothing.
 * An open-ended validity (no valid_until) is read as succession.
 */
async function supersede(db: Db, actor: Actor, type: FactType, identity: string): Promise<void> {
  const r = await db.query<{ id: string; start: string; valid_until: string | null; explicit: boolean }>(
    `select f.id, coalesce(f.valid_from, m.occurred_at, m.captured_at::date)::text as start, f.valid_until::text as valid_until,
            (f.valid_from is not null and f.valid_until is not null) as explicit
       from facts f join memories m on m.id = f.memory_id
      where f.owner_id = $1 and f.type_id = $2 and f.identity = $3
      order by start, f.created_at`, [actor.ownerId, type.id, identity]);
  const facts = r.rows;
  for (let i = 0; i < facts.length; i++) {
    const cur = facts[i]!;
    const next = facts[i + 1];
    let by: string | null = null;
    if (next) {
      // Touching at the boundary is succession: real policies say "01/03/2025 al
      // 01/03/2026" and the next one starts on 01/03/2026.
      const overlap = cur.explicit && next.explicit && cur.valid_until! > next.start;
      by = overlap ? null : next.id;
    }
    await db.query('update facts set superseded_by = $2 where id = $1', [cur.id, by]);
  }
}

export type FactStatus = 'current' | 'expired' | 'superseded' | 'conflict';

export interface FactHit {
  id: string;
  type: string;
  identity: string;
  status: FactStatus;
  payload: Record<string, Canonical>;
  evidence: Record<string, string>;
  validFrom: string | null;
  validUntil: string | null;
  memoryId: string;
  memoryTitle: string | null;
  occurredAt: string | null;
  extractedBy: string;
}

export interface QueryInput {
  type: string;
  identity?: string | null;
  /** Evaluate validity at this date (default: today). */
  at?: string | null;
  /** Include superseded facts too. */
  history?: boolean;
  memoryId?: string | null;
}

/**
 * The fact mode (§7). Status is computed, and every hit carries the memory that
 * backs it and the evidence it was checked against. Expired facts are returned
 * on purpose: the agent must say "expired" before the value (hard rule 10).
 */
export async function queryFacts(deps: Deps, actor: Actor, input: QueryInput): Promise<Result<{ facts: FactHit[] }>> {
  const type = await findFactType(deps.db, actor, input.type);
  if (!type) return err('not_found', `no fact type ${input.type}; see fact_types_list`);
  const at = input.at ?? deps.clock.now().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(at)) return err('invalid', 'at must be YYYY-MM-DD');
  let memoryId: string | null = null;
  if (input.memoryId) {
    const id = await resolveId(deps, actor, input.memoryId);
    if (id.kind !== 'ok') return id;
    memoryId = id.value;
  }
  const r = await deps.db.query<Record<string, any>>(
    `select f.*, m.title, m.occurred_at, m.hidden
       from facts f join memories m on m.id = f.memory_id
      where f.owner_id = $1 and f.type_id = $2 and not m.hidden
        and ($3::text is null or f.identity = $3)
        and ($4::uuid is null or f.memory_id = $4)
      order by coalesce(f.valid_from, m.occurred_at, m.captured_at::date) desc, f.created_at desc`,
    [actor.ownerId, type.id, input.identity ? identityKey(input.identity) : null, memoryId]);

  const hits: FactHit[] = r.rows.map((f) => ({
    id: f.id, type: type.slug, identity: f.identity, status: 'current',
    payload: f.payload, evidence: f.evidence, validFrom: f.valid_from, validUntil: f.valid_until,
    memoryId: f.memory_id, memoryTitle: f.title, occurredAt: f.occurred_at, extractedBy: f.extracted_by,
    superseded: !!f.superseded_by,
  } as FactHit & { superseded: boolean }));

  for (const h of hits as Array<FactHit & { superseded: boolean }>) {
    if (type.kind === 'estado' && h.superseded) h.status = 'superseded';
    else if (h.validUntil && h.validUntil < at) h.status = 'expired';
  }
  if (type.kind === 'estado') {
    const live = hits.filter((h) => h.status !== 'superseded');
    const byIdentity = new Map<string, FactHit[]>();
    for (const h of live) byIdentity.set(h.identity, [...(byIdentity.get(h.identity) ?? []), h]);
    for (const group of byIdentity.values()) if (group.length > 1) for (const h of group) h.status = 'conflict';
  }
  const out = hits
    .filter((h) => input.history || h.status !== 'superseded')
    .map(({ superseded: _s, ...h }: FactHit & { superseded?: boolean }) => h);
  return ok({ facts: out });
}
