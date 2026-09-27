import type { Actor, Db, Deps } from '../ports';
import { confirm, err, ok, type Result } from '../result';
import { FIELD_KINDS, type FieldKind } from './evidence';

export interface FactField { name: string; kind: FieldKind; label?: string; description?: string }

export interface FactType {
  id: string;
  slug: string;
  kind: 'estado' | 'periodo';
  cardinality: 'one' | 'many';
  description: string;
  domainSlug: string | null;
  fields: FactField[];
  identityField: string | null;
  active: boolean;
}

export type FactTypeInput = Omit<FactType, 'id' | 'active'>;

const row = (r: Record<string, any>): FactType => ({
  id: r.id, slug: r.slug, kind: r.kind, cardinality: r.cardinality, description: r.description,
  domainSlug: r.domain_slug, fields: r.fields, identityField: r.identity_field, active: r.active,
});

const SLUG = /^[a-z][a-z0-9_]{1,40}$/;

/**
 * Shape rules only — never language. A `many` type without identity would
 * collapse two rows of one document; an `estado` type without identity could
 * never supersede, which is the whole point of `estado` (§4).
 */
export function validateType(t: FactTypeInput): string | null {
  if (!SLUG.test(t.slug)) return 'slug: lowercase letters, digits and _ (2-41 chars)';
  if (t.kind !== 'estado' && t.kind !== 'periodo') return 'kind must be estado or periodo';
  if (t.cardinality !== 'one' && t.cardinality !== 'many') return 'cardinality must be one or many';
  if (!t.description?.trim()) return 'description is required: it is what the agent reads';
  if (!Array.isArray(t.fields) || t.fields.length === 0 || t.fields.length > 30) return 'fields: 1 to 30';
  const names = new Set<string>();
  for (const f of t.fields) {
    if (!SLUG.test(f.name)) return `field name "${f.name}": lowercase letters, digits and _`;
    if (!FIELD_KINDS.includes(f.kind)) return `field ${f.name}: kind must be one of ${FIELD_KINDS.join(', ')}`;
    if (names.has(f.name)) return `field ${f.name} is repeated`;
    names.add(f.name);
  }
  if (t.identityField && !names.has(t.identityField)) return `identity_field ${t.identityField} is not a field`;
  if (t.cardinality === 'many' && !t.identityField) return 'a many type needs identity_field, or two rows of one document collapse';
  if (t.kind === 'estado' && !t.identityField) return 'an estado type needs identity_field, or it can never supersede';
  return null;
}

export async function listFactTypes(deps: Deps, actor: Actor, includeArchived = false): Promise<FactType[]> {
  const r = await deps.db.query(
    `select * from fact_types where owner_id = $1 and ($2 or active) order by slug`, [actor.ownerId, includeArchived]);
  return r.rows.map(row);
}

export async function findFactType(db: Db, actor: Actor, slug: string): Promise<FactType | null> {
  const r = await db.query('select * from fact_types where owner_id = $1 and slug = $2', [actor.ownerId, slug]);
  return r.rows[0] ? row(r.rows[0]) : null;
}

export async function createFactType(deps: Deps, actor: Actor, input: FactTypeInput, yes = false): Promise<Result<FactType>> {
  const t = { ...input, cardinality: input.cardinality ?? 'one', domainSlug: input.domainSlug ?? null, identityField: input.identityField ?? null };
  const bad = validateType(t);
  if (bad) return err('invalid', bad);
  if (await findFactType(deps.db, actor, t.slug)) return err('conflict', `fact type ${t.slug} already exists`);
  if (!yes) return confirm(`create fact type ${t.slug}: it decides how every future document of this kind is read`, t);
  const r = await deps.db.query(
    `insert into fact_types (owner_id, slug, kind, cardinality, description, domain_slug, fields, identity_field)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
    [actor.ownerId, t.slug, t.kind, t.cardinality, t.description.trim(), t.domainSlug, JSON.stringify(t.fields), t.identityField]);
  return ok(row(r.rows[0]!));
}

export type FactTypePatch = Partial<Pick<FactType, 'kind' | 'cardinality' | 'description' | 'domainSlug' | 'fields' | 'identityField'>>;

export async function editFactType(deps: Deps, actor: Actor, slug: string, patch: FactTypePatch, yes = false): Promise<Result<FactType>> {
  const cur = await findFactType(deps.db, actor, slug);
  if (!cur) return err('not_found', `no fact type ${slug}`);
  const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as FactType;
  const bad = validateType(next);
  if (bad) return err('invalid', bad);
  const facts = await deps.db.query<{ n: string }>('select count(*) as n from facts where type_id = $1', [cur.id]);
  if (!yes) return confirm(`edit fact type ${slug}`, { before: cur, after: next, factsOfThisType: Number(facts.rows[0]!.n) });
  const r = await deps.db.query(
    `update fact_types set kind = $2, cardinality = $3, description = $4, domain_slug = $5, fields = $6, identity_field = $7
      where id = $1 returning *`,
    [cur.id, next.kind, next.cardinality, next.description, next.domainSlug, JSON.stringify(next.fields), next.identityField]);
  return ok(row(r.rows[0]!));
}

/** Archiving never deletes: facts already stored came from documents that still say what they say. */
export async function archiveFactType(deps: Deps, actor: Actor, slug: string, yes = false): Promise<Result<FactType>> {
  const cur = await findFactType(deps.db, actor, slug);
  if (!cur) return err('not_found', `no fact type ${slug}`);
  if (!yes) return confirm(`archive fact type ${slug}: it stops being offered; its facts stay`, { slug });
  const r = await deps.db.query('update fact_types set active = false where id = $1 returning *', [cur.id]);
  return ok(row(r.rows[0]!));
}
