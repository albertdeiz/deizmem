import type { ApiError } from './api';

/** The core returns stable codes in English; the words for a person live here. */

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | '';

export const STATUS: Record<string, [string, Tone]> = {
  pending: ['leyendo', 'info'], ready: ['lista', 'ok'], needs_text: ['sin texto', 'warn'], failed: ['falló', 'bad'],
};
export const FACT_STATUS: Record<string, [string, Tone]> = {
  current: ['vigente', 'ok'], expired: ['vencido', 'warn'], superseded: ['superado', ''], conflict: ['conflicto', 'bad'],
};
export const PENDING: Record<string, string> = {
  needs_text: 'Sin texto', unclassified: 'Sin categoría', unextracted: 'Sin hechos revisados', review: 'Para revisar', failed: 'Fallidas',
};
export const LANE: Record<string, string> = { inline: 'texto', document: 'documento', vision: 'OCR', audio: 'audio', agent: 'agente' };
export const LANES: Record<string, string> = { document: 'documentos', vision: 'OCR', audio: 'audio', embed: 'vectores' };
const ERRORS: Record<string, string> = {
  invalid: 'Hay un dato inválido', forbidden: 'No permitido', not_found: 'No existe', conflict: 'Conflicto',
  ambiguous: 'El id es ambiguo', too_large: 'El archivo es demasiado grande', unavailable: 'No disponible',
  unauthenticated: 'La sesión expiró', network: 'No se pudo conectar',
  wrong_password: 'La contraseña no abrió el archivo',
};

export const errText = (e: ApiError) => `${ERRORS[e.code] ?? `Error ${e.status}`}${e.message ? `: ${e.message}` : ''}`;
export const day = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : '');
export function when(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });
}
export const short = (id: string) => id.slice(0, 8);
export const titleOf = (m: { id: string; title: string | null; filename: string | null; note?: string | null }) =>
  m.title || m.filename || (m.note ? m.note.slice(0, 60) : `Memoria ${short(m.id)}`);
export const size = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
export function value(v: unknown): string {
  if (v && typeof v === 'object' && 'amount' in v) {
    const m = v as { amount: unknown; currency?: string };
    return `${m.amount} ${m.currency ?? ''}`.trim();
  }
  return v === null || v === undefined ? '' : String(v);
}
export const isPdf = (f: { name?: string; type?: string | null }) =>
  f.type === 'application/pdf' || /\.pdf$/i.test(f.name ?? '');
/** A password travels percent-encoded: a header is Latin-1 and a password may not be. */
export const passwordHeader = (pw: string): Record<string, string> => (pw ? { 'x-dm-password': encodeURIComponent(pw) } : {});
export const splitTags = (s: string) => s.split(',').map((t) => t.trim()).filter(Boolean);
