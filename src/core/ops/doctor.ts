import type { Deps, LaneHealth } from '../ports';

export interface DoctorReport {
  db: LaneHealth;
  lanes: Record<'document' | 'vision' | 'audio' | 'embed', LaneHealth | 'off'>;
  queue: { pending: number; failed: number };
  memories: { total: number; needsText: number; failed: number };
}

const safe = async (f: () => Promise<LaneHealth>): Promise<LaneHealth> => {
  try { return await f(); } catch (e) { return { ok: false, detail: (e as Error).message }; }
};

/** Health as data. An unconfigured lane is `off`, not an error (§8). */
export async function doctor(deps: Deps): Promise<DoctorReport> {
  const db = await safe(async () => {
    const r = await deps.db.query<{ v: string }>('select version() as v');
    return { ok: true, detail: r.rows[0]!.v.split(' ').slice(0, 2).join(' ') };
  });
  const lane = async (l: { health(): Promise<LaneHealth> } | null) => (l ? safe(() => l.health()) : 'off' as const);
  const [document, vision, audio, embed] = await Promise.all([
    lane(deps.lanes.document), lane(deps.lanes.vision), lane(deps.lanes.audio), lane(deps.lanes.embed),
  ]);
  let queue = { pending: 0, failed: 0 };
  let memories = { total: 0, needsText: 0, failed: 0 };
  if (db.ok) {
    const q = await deps.db.query<{ pending: string; failed: string }>(
      `select count(*) filter (where done_at is null and error is null) as pending,
              count(*) filter (where done_at is null and error is not null) as failed from jobs`);
    queue = { pending: Number(q.rows[0]!.pending), failed: Number(q.rows[0]!.failed) };
    const m = await deps.db.query<{ total: string; needs_text: string; failed: string }>(
      `select count(*) as total,
              count(*) filter (where status = 'needs_text') as needs_text,
              count(*) filter (where status = 'failed') as failed from memories`);
    memories = { total: Number(m.rows[0]!.total), needsText: Number(m.rows[0]!.needs_text), failed: Number(m.rows[0]!.failed) };
  }
  return { db, lanes: { document, vision, audio, embed }, queue, memories };
}
