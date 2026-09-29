import type { FactHit } from '../../../core/facts/facts';
import type { FactType } from '../../../core/facts/registry';
import type { Domain } from '../../../core/ops/domains';
import type { SessionSummary } from '../../../core/ops/identity';
import type { MemoryDetail, MemorySummary } from '../../../core/ops/memories';
import type { PendingResult } from '../../../core/ops/pending';
import type { RetrieveResult } from '../../../core/ops/retrieve';
import type { DoctorReport } from '../../../core/ops/doctor';

/** The shapes the server sends: the core's own types, so the two cannot drift. */
export type { Domain, FactHit, FactType, MemoryDetail, MemorySummary, PendingResult, RetrieveResult, SessionSummary };
export type Memory = MemoryDetail & { facts: FactHit[] };
export type Overview = Pick<DoctorReport, 'db' | 'lanes' | 'spaces'> & { pending: PendingResult['counts'] | null; domains: Domain[] };
export interface CaptureResult { id: string; status: string; deduped: boolean }

export interface ApiError { status: number; code: string; message: string }
export type Reply<T> = { ok: true; data: T } | { ok: false; error: ApiError };

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

export function qs(params: Record<string, string | number | boolean | string[] | null | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '' || v === false) continue;
    for (const x of Array.isArray(v) ? v : [v]) u.append(k, String(x));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}

/** Every write carries x-dm-web: the server refuses a POST without it (cross-site guard). */
export async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown, raw?: { type: string }): Promise<Reply<T>> {
  const headers: Record<string, string> = { 'x-dm-web': '1' };
  let payload: BodyInit | undefined;
  if (raw) { payload = body as Blob; headers['content-type'] = raw.type || 'application/octet-stream'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  let r: globalThis.Response;
  try {
    r = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
  } catch (e) {
    return { ok: false, error: { status: 0, code: 'network', message: (e as Error).message } };
  }
  const data = await r.json().catch(() => ({}));
  if (r.ok) return { ok: true, data: data as T };
  if (r.status === 401 && path !== '/api/login') onUnauthorized();
  return { ok: false, error: { status: r.status, code: data.code ?? 'error', message: data.message ?? r.statusText } };
}
