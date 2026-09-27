import type { Actor, Deps } from '../ports';

/** Whether retrieval used vectors, and if not, why (§7). */
export type VectorState = 'active' | 'rebuilding' | 'off';

/** Vector half of retrieval. Filled in S4; until then retrieval is lexical. */
export async function vectorSearch(
  _deps: Deps, _actor: Actor, _query: string, _scope: string, _base: unknown[], _limit: number,
): Promise<{ state: VectorState; rows: unknown[] }> {
  return { state: 'off', rows: [] };
}
