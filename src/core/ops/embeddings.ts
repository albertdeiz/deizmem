import type { Actor, Db, Deps, Embedder } from '../ports';

/** Whether retrieval used vectors, and if not, why (§7). */
export type VectorState = 'active' | 'rebuilding' | 'off';

export interface Space { id: number; model: string; dimensions: number; status: 'building' | 'active' | 'retired' }

const BATCH = 32;
/** A vector hit below this share of the best one is noise. */
const VECTOR_RELATIVE_CUTOFF = 0.5;
const INFO_TTL_MS = 60_000;

let infoCache: { at: number; lane: Embedder; info: { model: string; dimensions: number } } | null = null;

/** What the lane declares, cached briefly: every query would otherwise ask. */
export async function laneInfo(lane: Embedder): Promise<{ model: string; dimensions: number } | null> {
  if (infoCache && infoCache.lane === lane && Date.now() - infoCache.at < INFO_TTL_MS) return infoCache.info;
  try {
    const info = await lane.info();
    infoCache = { at: Date.now(), lane, info };
    return info;
  } catch {
    return null;
  }
}

export function resetLaneInfo(): void { infoCache = null; }

async function spaces(db: Db): Promise<Space[]> {
  return (await db.query<Space>(`select id, model, dimensions, status from embedding_spaces where status <> 'retired'`)).rows;
}

const same = (s: Space, i: { model: string; dimensions: number }) => s.model === i.model && s.dimensions === i.dimensions;

/** The space new vectors go to: the building one if a rebuild is on, else the active one. */
async function targetSpace(db: Db, info: { model: string; dimensions: number }): Promise<Space | null> {
  return (await spaces(db)).find((s) => same(s, info)) ?? null;
}

/**
 * Compares what the lane declares with the active space and starts a rebuild
 * when they differ (§7). Nobody has to remember a command after changing the
 * model: the worker calls this on start and periodically.
 */
export async function syncSpaces(deps: Deps): Promise<{ state: VectorState; space: Space | null; action: string }> {
  const lane = deps.lanes.embed;
  if (!lane) return { state: 'off', space: null, action: 'no embed lane' };
  const info = await laneInfo(lane);
  if (!info) return { state: 'off', space: null, action: 'embed lane unreachable' };

  return deps.db.tx(async (db) => {
    await db.query('lock table embedding_spaces in exclusive mode');
    const all = await spaces(db);
    const active = all.find((s) => s.status === 'active');
    const building = all.find((s) => s.status === 'building');
    if (active && same(active, info)) {
      if (building) await db.query(`update embedding_spaces set status = 'retired' where id = $1`, [building.id]);
      await enqueueFill(db, active.id);
      return { state: 'active' as VectorState, space: active, action: building ? 'dropped a stale rebuild' : 'in sync' };
    }
    if (building && same(building, info)) {
      await enqueueFill(db, building.id);
      return { state: 'rebuilding' as VectorState, space: building, action: 'rebuild in progress' };
    }
    if (building) await db.query(`update embedding_spaces set status = 'retired' where id = $1`, [building.id]);
    const r = await db.query<Space>(
      `insert into embedding_spaces (model, dimensions, status) values ($1, $2, 'building')
       on conflict (model, dimensions) do update set status = 'building', activated_at = null
       returning id, model, dimensions, status`, [info.model, info.dimensions]);
    const space = r.rows[0]!;
    await db.query(
      `create index if not exists chunk_embeddings_s${space.id}_idx on chunk_embeddings
         using hnsw ((embedding::vector(${space.dimensions})) vector_cosine_ops) where space_id = ${space.id}`);
    await enqueueFill(db, space.id);
    return { state: 'rebuilding' as VectorState, space, action: `building ${info.model}${active ? ` to replace ${active.model}` : ''}` };
  });
}

async function enqueueFill(db: Db, spaceId: number): Promise<void> {
  const pending = await db.query(
    `select 1 from jobs where kind = 'reembed' and done_at is null and error is null and (payload->>'spaceId')::int = $1 limit 1`, [spaceId]);
  if (!pending.rows.length) {
    await db.query(`insert into jobs (kind, payload) values ('reembed', $1)`, [JSON.stringify({ spaceId })]);
  }
}

const vec = (v: number[]) => `[${v.join(',')}]`;

async function embedChunks(deps: Deps, lane: Embedder, space: Space, rows: Array<{ id: string; content: string }>): Promise<void> {
  if (!rows.length) return;
  const vectors = await lane.embed(rows.map((r) => r.content), 'passage');
  if (vectors.length !== rows.length || vectors.some((v) => v.length !== space.dimensions)) {
    throw new Error(`embed lane returned ${vectors.length} vectors of ${vectors[0]?.length} dims; expected ${rows.length} of ${space.dimensions}`);
  }
  for (const [i, r] of rows.entries()) {
    await deps.db.query(
      `insert into chunk_embeddings (chunk_id, space_id, embedding) values ($1, $2, $3::vector)
       on conflict (space_id, chunk_id) do update set embedding = excluded.embedding`,
      [r.id, space.id, vec(vectors[i]!)]);
  }
}

/**
 * One batch of a fill/rebuild job. Embeds chunks missing from the space; when
 * none are left, a building space becomes active atomically and the old one
 * is retired and its vectors dropped. Returns whether more work remains.
 */
export async function reembedBatch(deps: Deps, spaceId: number): Promise<boolean> {
  const lane = deps.lanes.embed;
  if (!lane) return false;
  const s = (await deps.db.query<Space>('select id, model, dimensions, status from embedding_spaces where id = $1', [spaceId])).rows[0];
  if (!s || s.status === 'retired') return false;
  const info = await laneInfo(lane);
  if (!info || !same(s, info)) return false; // the lane changed again: syncSpaces will start over
  const todo = await deps.db.query<{ id: string; content: string }>(
    `select c.id::text as id, c.content from chunks c
      where not exists (select 1 from chunk_embeddings e where e.chunk_id = c.id and e.space_id = $1)
      order by c.id limit $2`, [s.id, BATCH]);
  await embedChunks(deps, lane, s, todo.rows);
  if (todo.rows.length === BATCH) return true;
  if (s.status === 'building') {
    await deps.db.tx(async (db) => {
      await db.query(`update embedding_spaces set status = 'retired' where status = 'active'`);
      await db.query(`update embedding_spaces set status = 'active', activated_at = now() where id = $1`, [s.id]);
    });
    await deps.db.query(`delete from chunk_embeddings where space_id in (select id from embedding_spaces where status = 'retired')`);
  }
  return false;
}

/** Called after a memory's chunks are rebuilt. A lane that is down never fails indexing. */
export async function embedMemory(deps: Deps, memoryId: string): Promise<void> {
  const lane = deps.lanes.embed;
  if (!lane) return;
  const info = await laneInfo(lane);
  if (!info) return;
  const space = await targetSpace(deps.db, info);
  if (!space) return;
  const rows = await deps.db.query<{ id: string; content: string }>(
    'select id::text as id, content from chunks where memory_id = $1 order by seq', [memoryId]);
  for (let i = 0; i < rows.rows.length; i += BATCH) {
    await embedChunks(deps, lane, space, rows.rows.slice(i, i + BATCH));
  }
}

/**
 * The vector half of retrieval. Uses only the active space, and only if the
 * lane still speaks it; during a rebuild the query cannot be embedded in the
 * old space, so retrieval is lexical and says so.
 */
export async function vectorSearch(
  deps: Deps, _actor: Actor, query: string, scope: string, base: unknown[], limit: number,
): Promise<{ state: VectorState; rows: unknown[] }> {
  const lane = deps.lanes.embed;
  if (!lane) return { state: 'off', rows: [] };
  const info = await laneInfo(lane);
  if (!info) return { state: 'off', rows: [] };
  const active = (await spaces(deps.db)).find((s) => s.status === 'active');
  if (!active) return { state: (await targetSpace(deps.db, info)) ? 'rebuilding' : 'off', rows: [] };
  if (!same(active, info)) return { state: 'rebuilding', rows: [] };
  let q: number[] | undefined;
  try { [q] = await lane.embed([query], 'query'); } catch { return { state: 'off', rows: [] }; }
  if (!q) return { state: 'off', rows: [] };
  const d = active.dimensions;
  const r = await deps.db.query(
    `select c.memory_id, c.seq, c.content, m.title, m.occurred_at, m.captured_at, d.slug as domain, m.media_type,
            1 - (e.embedding::vector(${d}) <=> $5::vector(${d})) as score
       from chunk_embeddings e
       join chunks c on c.id = e.chunk_id
       join memories m on m.id = c.memory_id left join domains d on d.id = m.domain_id
      where e.space_id = $6 and ${scope}
      order by e.embedding::vector(${d}) <=> $5::vector(${d}) limit $7`,
    [...base, vec(q), active.id, limit]);
  // Nearest neighbours always fill the limit, relevant or not. Keep only hits
  // within half the best similarity — relative, so it holds for any model.
  const top = Math.max(0, ...r.rows.map((x) => Number((x as { score: number }).score)));
  return { state: 'active', rows: r.rows.filter((x) => Number((x as { score: number }).score) >= top * VECTOR_RELATIVE_CUTOFF && top > 0) };
}

export interface SpaceStatus extends Space { embedded: number; chunks: number }

export async function spaceStatus(deps: Deps): Promise<SpaceStatus[]> {
  const total = Number((await deps.db.query<{ n: string }>('select count(*) as n from chunks')).rows[0]!.n);
  const r = await deps.db.query<Space & { embedded: string }>(
    `select s.id, s.model, s.dimensions, s.status,
            (select count(*) from chunk_embeddings e where e.space_id = s.id) as embedded
       from embedding_spaces s order by s.id`);
  return r.rows.map((x) => ({ ...x, embedded: Number(x.embedded), chunks: total }));
}
