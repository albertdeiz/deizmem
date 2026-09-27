/**
 * Language-free text primitives (CLAUDE.md §6). Nothing here knows a word of any
 * language: it compares code points, tokens and digit sequences.
 */

/** NFKC, casefold, strip combining marks, collapse whitespace. */
export function fold(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Letter/number runs of the folded text. The unit of lexical search. */
export function tokens(s: string): string[] {
  return fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Number-like runs in a text: digits with the separators people write inside them. */
export function numberRuns(s: string): string[] {
  return s.normalize('NFKC').match(/\p{Nd}(?:[\p{Nd}.,'’  ]*\p{Nd})?/gu) ?? [];
}

const digitsOnly = (s: string) => s.replace(/\D/gu, '');

/** Strips a zero fraction: "3,0" and "3" are the same datum. */
const trimFraction = (intPart: string, frac: string) =>
  /^0*$/.test(frac) ? intPart : `${intPart}.${frac.replace(/0+$/, '')}`;

/**
 * Every canonical reading of a written number. "1.500" is 1500 or 1.5 depending
 * on the locale, and the memory does not know the locale — so it keeps both and
 * a match on any reading counts.
 */
export function readings(raw: string): Set<string> {
  const s = raw.normalize('NFKC').replace(/[  '’]/g, '');
  const out = new Set<string>();
  const all = digitsOnly(s).replace(/^0+(?=\d)/, '');
  if (all) out.add(all);
  for (const sep of ['.', ',']) {
    const i = s.lastIndexOf(sep);
    if (i < 0) continue;
    const intPart = digitsOnly(s.slice(0, i)).replace(/^0+(?=\d)/, '') || '0';
    const frac = digitsOnly(s.slice(i + 1));
    if (frac) out.add(trimFraction(intPart, frac));
  }
  return out;
}

/** Canonical readings of a value given as a number (the agent's canonical form). */
export function readingsOfValue(v: number | string): Set<string> {
  const s = typeof v === 'number' ? String(v) : v;
  if (/^-?\d+(\.\d+)?$/.test(s.trim())) {
    const [i, f = ''] = s.trim().replace(/^-/, '').split('.');
    return new Set([trimFraction(i!.replace(/^0+(?=\d)/, '') || '0', f)]);
  }
  return readings(s);
}

/** Whether any number written in `text` has a reading shared with `wanted`. */
export function containsNumber(text: string, wanted: Set<string>): boolean {
  for (const run of numberRuns(text)) {
    for (const r of readings(run)) if (wanted.has(r)) return true;
    // A run like "1.747.885 3" may glue two numbers; also try each spaced part.
    for (const part of run.split(/[  ]+/)) for (const r of readings(part)) if (wanted.has(r)) return true;
  }
  return false;
}
