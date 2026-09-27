import { containsNumber, fold, numberRuns, readings, readingsOfValue } from '../text';

/**
 * Evidence checks (CLAUDE.md §6). The agent extracts; the memory checks that the
 * value is in the quoted evidence and the evidence is in the document — without
 * knowing any language. Where that is impossible (a month written as a word, a
 * currency written as a symbol), the agent's claim is taken and the loss is named.
 */

export type FieldKind = 'text' | 'number' | 'money' | 'date' | 'phone';
export const FIELD_KINDS: FieldKind[] = ['text', 'number', 'money', 'date', 'phone'];

export type Canonical = string | number | { amount: number; currency: string };

/** Validates and normalizes the agent's canonical value for a kind. */
export function canonical(kind: FieldKind, value: unknown): { ok: true; value: Canonical } | { ok: false; reason: string } {
  switch (kind) {
    case 'text': {
      if (typeof value !== 'string' || !value.trim()) return { ok: false, reason: 'text value must be a non-empty string' };
      if (value.length > 500) return { ok: false, reason: 'text value longer than 500 characters' };
      return { ok: true, value: value.trim() };
    }
    case 'number': {
      const n = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, reason: 'number value must be a plain number (use . for decimals, no separators)' };
    }
    case 'money': {
      const v = value as { amount?: unknown; currency?: unknown } | null;
      const amount = canonical('number', v?.amount);
      if (!amount.ok) return { ok: false, reason: `money.amount: ${amount.reason}` };
      if (typeof v?.currency !== 'string' || !v.currency.trim() || v.currency.length > 12) {
        return { ok: false, reason: 'money.currency must be a short string, e.g. "CLP", "UF", "USD"' };
      }
      return { ok: true, value: { amount: amount.value as number, currency: v.currency.trim().toUpperCase() } };
    }
    case 'date': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return { ok: false, reason: 'date value must be YYYY-MM-DD' };
      const d = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return { ok: false, reason: `${value} is not a real date` };
      return { ok: true, value };
    }
    case 'phone': {
      if (typeof value !== 'string' || value.replace(/\D/g, '').length < 3) return { ok: false, reason: 'phone value must contain digits' };
      return { ok: true, value: value.trim() };
    }
  }
}

const digits = (s: string) => s.normalize('NFKC').replace(/\D/gu, '');

/** Whether the value is visibly in the evidence, by kind. */
function inEvidence(kind: FieldKind, value: Canonical, evidence: string): string | null {
  switch (kind) {
    case 'text':
      return fold(evidence).includes(fold(value as string)) ? null : 'value not found in evidence';
    case 'number':
      return containsNumber(evidence, readingsOfValue(value as number)) ? null : 'number not found in evidence';
    case 'money':
      // The currency is the agent's claim: "$" means CLP or USD depending on the country.
      return containsNumber(evidence, readingsOfValue((value as { amount: number }).amount)) ? null : 'amount not found in evidence';
    case 'phone':
      return digits(evidence).includes(digits(value as string)) ? null : 'phone digits not found in evidence';
    case 'date': {
      // Year and day must appear as numbers; the month is the agent's claim —
      // reading "Enero" is knowing Spanish.
      const [y, , d] = (value as string).split('-');
      const nums = new Set(numberRuns(evidence).flatMap((r) => r.split(/[.,'’  ]+/)).flatMap((r) => [...readings(r)]));
      const day = String(Number(d));
      const yearOk = nums.has(y!) || nums.has(y!.slice(2));
      return yearOk && nums.has(day) ? null : 'year and day of the date not found in evidence';
    }
  }
}

export interface FieldCheck { ok: boolean; value?: Canonical; reason?: string }

/**
 * The full check for one field: canonical value, evidence in the document,
 * value in the evidence, and a short value quoted with its label.
 */
export function checkField(kind: FieldKind, raw: unknown, evidence: unknown, documentText: string): FieldCheck {
  const c = canonical(kind, raw);
  if (!c.ok) return { ok: false, reason: c.reason };
  if (typeof evidence !== 'string' || !evidence.trim()) return { ok: false, reason: 'evidence is required: copy the line from the document' };
  if (evidence.length > 1000) return { ok: false, reason: 'evidence longer than 1000 characters: quote the line, not the page' };
  if (!fold(documentText).includes(fold(evidence))) return { ok: false, reason: 'evidence is not in the memory text (copy it literally)' };
  const shown = typeof c.value === 'object' ? String(c.value.amount) : String(c.value);
  if (fold(shown).length <= 2 && fold(evidence).length < fold(shown).length + 3) {
    return { ok: false, reason: 'a value this short needs its label in the evidence (quote the whole line)' };
  }
  const miss = inEvidence(kind, c.value, evidence);
  return miss ? { ok: false, reason: miss } : { ok: true, value: c.value };
}
