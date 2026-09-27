import type { Actor, Deps } from '../ports';
import { err, ok, type Result } from '../result';
import { containsNumber, numberRuns, readings } from '../text';

export interface VerifyResult {
  ok: boolean;
  figures: Array<{ figure: string; found: boolean }>;
  missing: string[];
}

/**
 * Checks the agent's prose against what it read (hard rule 2): every figure in
 * the text must appear in the cited memories, compared by digits and separator
 * readings. Units are not checked — that would need to know unit names.
 */
export async function verify(deps: Deps, actor: Actor, input: { text: string; memoryIds: string[] }): Promise<Result<VerifyResult>> {
  if (!input.text?.trim()) return err('invalid', 'text is empty');
  if (!input.memoryIds?.length) return err('invalid', 'memory_ids are required: the memories the text relies on');
  const ids = input.memoryIds.map((x) => x.trim().toLowerCase());
  const r = await deps.db.query<{ id: string; body: string }>(
    `select id, concat_ws(E'\\n', note, normalized_text) as body from memories
      where owner_id = $1 and (id::text = any($2::text[]) or left(id::text, 8) = any($2::text[]))`,
    [actor.ownerId, ids]);
  if (r.rows.length === 0) return err('not_found', 'none of those memories exist');
  const corpus = r.rows.map((x) => x.body).join('\n');

  const seen = new Set<string>();
  const figures: VerifyResult['figures'] = [];
  for (const run of numberRuns(input.text)) {
    const fig = run.trim();
    if (seen.has(fig)) continue;
    seen.add(fig);
    // Spaced runs may glue two figures ("5 UF 3"); check each part.
    const parts = fig.split(/[  ]+/).filter(Boolean);
    const found = parts.every((p) => containsNumber(corpus, readings(p)));
    figures.push({ figure: fig, found });
  }
  const missing = figures.filter((f) => !f.found).map((f) => f.figure);
  return ok({ ok: missing.length === 0, figures, missing });
}
