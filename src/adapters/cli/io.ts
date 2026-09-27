import type { loadConfig } from '../../config';
import type { Actor, Deps } from '../../core/ports';
import type { Result } from '../../core/result';

export interface Ctx {
  deps: Deps;
  args: string[];
  flags: Record<string, string | boolean | undefined>;
  json: boolean;
  actor: () => Promise<Actor>;
  cfg: ReturnType<typeof loadConfig>;
}

export type Command = (ctx: Ctx) => Promise<number>;

/** Exit codes: 0 ok · 1 error · 2 needs confirmation · 3 not found · 4 forbidden · 5 ambiguous. */
export const EXIT: Record<string, number> = { not_found: 3, forbidden: 4, ambiguous: 5 };

export class CliExit extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

/** Prints a Result and returns the exit code. Human output is plain JSON-ish text. */
export function emit<T>(ctx: Pick<Ctx, 'json'>, r: Result<T>, human?: (v: T) => string): number {
  if (r.kind === 'ok') {
    if (ctx.json || !human) console.log(JSON.stringify(r.value, null, 2));
    else console.log(human(r.value));
    return 0;
  }
  if (r.kind === 'requires_confirmation') {
    console.error(ctx.json ? JSON.stringify(r, null, 2) : `${r.message}\n${JSON.stringify(r.affects, null, 2)}\n(repeat with --yes)`);
    return 2;
  }
  console.error(ctx.json ? JSON.stringify(r, null, 2) : `error (${r.code}): ${r.message}`);
  return EXIT[r.code] ?? 1;
}

