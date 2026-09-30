import type { IncomingMessage } from 'node:http';

/**
 * An encrypted PDF's password rides in a header, never in the query: a query
 * ends up in logs and proxies. Percent-encoded, because a header is Latin-1 and
 * a password may not be.
 */
export const PASSWORD_HEADER = 'x-dm-password';

export function headerPassword(req: IncomingMessage): { ok: true; value: string | null } | { ok: false } {
  const raw = req.headers[PASSWORD_HEADER];
  if (raw === undefined || raw === '') return { ok: true, value: null };
  try {
    return { ok: true, value: decodeURIComponent(Array.isArray(raw) ? raw[0]! : raw) };
  } catch {
    return { ok: false };
  }
}
