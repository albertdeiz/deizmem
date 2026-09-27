import { resolveId } from './memories';
import type { Actor, Db, Deps } from '../ports';
import { confirm, err, ok, type Result } from '../result';

export interface Domain { id: string; slug: string; label: string; description: string; active: boolean; memories: number }

const row = (r: Record<string, any>): Domain => ({
  id: r.id, slug: r.slug, label: r.label, description: r.description, active: r.active, memories: Number(r.n ?? 0),
});

const SLUG = /^[a-z0-9][a-z0-9_-]{0,40}$/;

export async function listDomains(deps: Deps, actor: Actor, includeArchived = false): Promise<Domain[]> {
  const r = await deps.db.query(
    `select d.*, (select count(*) from memories m where m.domain_id = d.id and not m.hidden) as n
       from domains d where d.owner_id = $1 and ($2 or d.active) order by d.slug`, [actor.ownerId, includeArchived]);
  return r.rows.map(row);
}

export async function findDomain(db: Db, actor: Actor, slug: string): Promise<Domain | null> {
  const r = await db.query('select * from domains where owner_id = $1 and slug = $2', [actor.ownerId, slug]);
  return r.rows[0] ? row(r.rows[0]) : null;
}

/** Every change to the registry asks first (hard rule 7). */
export async function createDomain(deps: Deps, actor: Actor, input: { slug: string; label?: string; description: string }, yes = false): Promise<Result<Domain>> {
  const slug = input.slug.trim().toLowerCase();
  if (!SLUG.test(slug)) return err('invalid', 'slug: lowercase letters, digits, - and _');
  if (!input.description?.trim()) return err('invalid', 'description is required: it is the prompt the agent classifies with');
  if (await findDomain(deps.db, actor, slug)) return err('conflict', `domain ${slug} already exists`);
  const label = input.label?.trim() || slug;
  if (!yes) return confirm(`create domain ${slug}`, { slug, label, description: input.description.trim() });
  const r = await deps.db.query(
    `insert into domains (owner_id, slug, label, description) values ($1, $2, $3, $4) returning *`,
    [actor.ownerId, slug, label, input.description.trim()]);
  return ok(row(r.rows[0]!));
}

export async function editDomain(deps: Deps, actor: Actor, slug: string, patch: { label?: string; description?: string }, yes = false): Promise<Result<Domain>> {
  const d = await findDomain(deps.db, actor, slug);
  if (!d) return err('not_found', `no domain ${slug}`);
  const next = { label: patch.label?.trim() || d.label, description: patch.description?.trim() || d.description };
  if (!yes) return confirm(`edit domain ${slug} (memories are not touched)`, { before: { label: d.label, description: d.description }, after: next });
  const r = await deps.db.query('update domains set label = $2, description = $3 where id = $1 returning *', [d.id, next.label, next.description]);
  return ok(row(r.rows[0]!));
}

export async function archiveDomain(deps: Deps, actor: Actor, slug: string, yes = false): Promise<Result<Domain>> {
  const d = await findDomain(deps.db, actor, slug);
  if (!d) return err('not_found', `no domain ${slug}`);
  const n = await deps.db.query<{ n: string }>('select count(*) as n from memories where domain_id = $1', [d.id]);
  if (!yes) return confirm(`archive domain ${slug}: no longer offered; its memories stay searchable`, { slug, memories: Number(n.rows[0]!.n) });
  const r = await deps.db.query('update domains set active = false where id = $1 returning *', [d.id]);
  return ok(row(r.rows[0]!));
}

export async function mergeDomains(deps: Deps, actor: Actor, from: string, into: string, yes = false): Promise<Result<{ moved: number; into: string }>> {
  if (from === into) return err('invalid', 'cannot merge a domain into itself');
  const a = await findDomain(deps.db, actor, from);
  const b = await findDomain(deps.db, actor, into);
  if (!a || !b) return err('not_found', `no domain ${!a ? from : into}`);
  const n = await deps.db.query<{ n: string }>('select count(*) as n from memories where domain_id = $1', [a.id]);
  if (!yes) return confirm(`merge ${from} into ${into}: moves its memories and archives ${from}`, { from, into, memories: Number(n.rows[0]!.n) });
  const moved = await deps.db.tx(async (db) => {
    const r = await db.query('update memories set domain_id = $2 where domain_id = $1 and owner_id = $3', [a.id, b.id, actor.ownerId]);
    await db.query('update domains set active = false where id = $1', [a.id]);
    return r.rowCount ?? 0;
  });
  return ok({ moved, into });
}

export interface ClassifyInput {
  id: string;
  /** Domain slug, or null to leave it unclassified. */
  domain?: string | null;
  title?: string | null;
  occurredAt?: string | null;
  tags?: string[];
  confidence?: number | null;
  needsReview?: boolean;
  by: string;
}

/** The agent's classification, stored with its provenance (`by`). */
export async function classify(deps: Deps, actor: Actor, input: ClassifyInput): Promise<Result<{ id: string; domain: string | null; needsReview: boolean }>> {
  const id = await resolveId(deps, actor, input.id);
  if (id.kind !== 'ok') return id;
  if (!input.by?.trim()) return err('invalid', 'by is required ("<agent>/<model>")');
  if (input.occurredAt && !/^\d{4}-\d{2}-\d{2}$/.test(input.occurredAt)) return err('invalid', 'occurred_at must be YYYY-MM-DD');
  let domainId: string | null = null;
  if (input.domain) {
    const d = await findDomain(deps.db, actor, input.domain);
    if (!d || !d.active) return err('not_found', `no active domain ${input.domain}; see domains_list`);
    domainId = d.id;
  }
  const r = await deps.db.query(
    `update memories set domain_id = $3, domain_confidence = $4, classified_by = $5,
            needs_review = $6, title = coalesce($7, title), occurred_at = coalesce($8, occurred_at),
            tags = coalesce($9, tags)
      where owner_id = $1 and id = $2`,
    [actor.ownerId, id.value, domainId, input.confidence ?? null, input.by.trim(), input.needsReview ?? false,
     input.title?.trim() || null, input.occurredAt ?? null, input.tags ?? null]);
  if (!r.rowCount) return err('not_found', `no memory ${input.id}`);
  return ok({ id: id.value, domain: input.domain ?? null, needsReview: input.needsReview ?? false });
}
