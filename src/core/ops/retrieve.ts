import type { Actor, Deps } from '../ports';
import { err, ok, type Result } from '../result';
import { term } from './memories';
import { vectorSearch, type VectorState } from './embeddings';

export interface RetrieveInput {
  query: string;
  /** Extra variants from the agent: synonyms, translations, spellings. Optional. */
  terms?: string[];
  domain?: string | null;
  from?: string | null;
  to?: string | null;
  limit?: number;
}

export interface Passage {
  memoryId: string;
  seq: number;
  content: string;
  title: string | null;
  occurredAt: string | null;
  capturedAt: string;
  domain: string | null;
  mediaType: string | null;
  via: 'lexical' | 'vector' | 'both';
  score: number;
}

export interface RetrieveResult { passages: Passage[]; vector: VectorState }

/** A term far more frequent than the rarest one is topic, not datum (§7). */
const COMMON_FACTOR = 3;
const W_LEX = 1.0;
const W_VEC = 0.85;

/**
 * Search tokens: 3+ characters, or anything with a digit ("8", "UF3"). A length
 * rule, not a stopword list — stopwords are a language, and a length is not.
 */
export const termsOf = (q: string, extra: string[] = []) =>
  [...new Set([q, ...extra].join(' ').normalize('NFKC').toLowerCase()
    .split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3 || /\p{N}/u.test(t)))];

/** With enough chunks to judge, a term in more than this share of them is noise (IDF). */
const NOISE_SHARE = 0.6;
const NOISE_MIN_CHUNKS = 20;

type Row = {
  memory_id: string; seq: number; content: string; title: string | null; occurred_at: string | null;
  captured_at: Date; domain: string | null; media_type: string | null; score: number;
};

/**
 * Hybrid retrieval over chunks. Matches with OR (a question is not an AND), but
 * ranks only with the rare terms, the threshold relative to the rarest term of
 * the question itself — measured in deiz-memory, where ranking with every term
 * pushed the only chunk carrying the figure to seventh place.
 */
export async function retrieve(deps: Deps, actor: Actor, input: RetrieveInput): Promise<Result<RetrieveResult>> {
  const terms = termsOf(input.query ?? '', input.terms ?? []);
  if (!terms.length) return err('invalid', 'query has no searchable terms');
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 30);

  const scope = `m.owner_id = $1 and not m.hidden
    and ($2::text is null or d.slug = $2)
    and ($3::date is null or coalesce(m.occurred_at, m.captured_at::date) >= $3)
    and ($4::date is null or coalesce(m.occurred_at, m.captured_at::date) <= $4)`;
  const base = [actor.ownerId, input.domain ?? null, input.from ?? null, input.to ?? null];

  const df = await deps.db.query<{ t: string; n: string }>(
    `select t, (select count(*) from chunks c where c.owner_id = $1
                  and c.tsv @@ to_tsquery('dm_simple', q)) as n
       from unnest($2::text[], $3::text[]) as x(t, q)`,
    [actor.ownerId, terms, terms.map(term)]);
  const freq = new Map(df.rows.map((r) => [r.t, Number(r.n)]));
  const total = Number((await deps.db.query<{ n: string }>(
    'select count(*) as n from chunks where owner_id = $1', [actor.ownerId])).rows[0]!.n);
  const noise = (t: string) => total >= NOISE_MIN_CHUNKS && freq.get(t)! > total * NOISE_SHARE;
  const present = terms.filter((t) => (freq.get(t) ?? 0) > 0 && !noise(t));
  if (!present.length) {
    const vec = await vectorSearch(deps, actor, [input.query, ...(input.terms ?? [])].join(' '), scope, base, limit * 2);
    return ok({ passages: fuse([], vec.rows as Row[], limit), vector: vec.state });
  }
  const rarest = present.length ? Math.min(...present.map((t) => freq.get(t)!)) : 0;
  const rare = present.filter((t) => freq.get(t)! <= rarest * COMMON_FACTOR);
  const match = present.map(term).join(' | ');
  const rank = rare.map(term).join(' | ');

  const lex = await deps.db.query<Row>(
    `select c.memory_id, c.seq, c.content, m.title, m.occurred_at, m.captured_at, d.slug as domain,
            m.media_type, ts_rank(c.tsv, to_tsquery('dm_simple', $6)) as score
       from chunks c join memories m on m.id = c.memory_id left join domains d on d.id = m.domain_id
      where ${scope} and c.tsv @@ to_tsquery('dm_simple', $5)
      order by score desc limit $7`,
    [...base, match, rank, limit * 2]);

  const vec = await vectorSearch(deps, actor, [input.query, ...(input.terms ?? [])].join(' '), scope, base, limit * 2);
  return ok({ passages: fuse(lex.rows, vec.rows as Row[], limit), vector: vec.state });
}

/** Each list normalized against its own max, then summed: the scales differ. */
function fuse(lex: Row[], vec: Row[], limit: number): Passage[] {
  const norm = (rows: Row[]) => {
    const max = Math.max(0, ...rows.map((r) => Number(r.score)));
    return max > 0 ? rows.map((r) => ({ r, s: Number(r.score) / max })) : [];
  };
  const acc = new Map<string, { r: Row; lex: number; vec: number }>();
  for (const { r, s } of norm(lex)) acc.set(`${r.memory_id}:${r.seq}`, { r, lex: s, vec: 0 });
  for (const { r, s } of norm(vec)) {
    const k = `${r.memory_id}:${r.seq}`;
    const prev = acc.get(k);
    if (prev) prev.vec = s; else acc.set(k, { r, lex: 0, vec: s });
  }
  return [...acc.values()]
    .map(({ r, lex: l, vec: v }) => ({
      memoryId: r.memory_id, seq: r.seq, content: r.content, title: r.title, occurredAt: r.occurred_at,
      capturedAt: r.captured_at.toISOString(), domain: r.domain, mediaType: r.media_type,
      via: (l && v ? 'both' : l ? 'lexical' : 'vector') as Passage['via'],
      score: Math.round((W_LEX * l + W_VEC * v) * 1000) / 1000,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
