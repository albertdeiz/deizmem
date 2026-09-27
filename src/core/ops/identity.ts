import { createHash, randomBytes } from 'node:crypto';
import type { Actor, Deps } from '../ports';
import { err, ok, type Result } from '../result';

/**
 * Identity (§9): no accounts, no passwords. A short-lived pairing code, minted by
 * the operator, is redeemed once for a long-lived bearer token. Only hashes are
 * stored; the raw code and token are shown once.
 */

export const PAIRING_TTL_MS = 15 * 60 * 1000;
/** A daemon token that dies at 30 days is a scheduled outage; a year, and revocable. */
export const MCP_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L: it gets read aloud

function code(len = 8): string {
  const b = randomBytes(len);
  return Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join('');
}

export async function mintPairingCode(deps: Deps, actor: Actor): Promise<Result<{ code: string; expiresAt: string }>> {
  const c = code();
  const expires = new Date(deps.clock.now().getTime() + PAIRING_TTL_MS);
  await deps.db.query(
    `insert into pairing_codes (code_hash, owner_id, channel, expires_at) values ($1, $2, 'mcp', $3)`,
    [hash(c), actor.ownerId, expires]);
  return ok({ code: c, expiresAt: expires.toISOString() });
}

export interface Token { token: string; sessionId: string; ownerId: string; expiresAt: string }

export async function redeemPairingCode(deps: Deps, raw: string, label?: string | null): Promise<Result<Token>> {
  const c = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  return deps.db.tx(async (db) => {
    const r = await db.query<{ owner_id: string }>(
      `update pairing_codes set used_at = now()
        where code_hash = $1 and used_at is null and expires_at > $2
        returning owner_id`, [hash(c), deps.clock.now()]);
    const ownerId = r.rows[0]?.owner_id;
    if (!ownerId) return err<Token>('forbidden', 'code is unknown, used or expired');
    const token = `dm_${randomBytes(32).toString('base64url')}`;
    const expires = new Date(deps.clock.now().getTime() + MCP_TOKEN_TTL_MS);
    const s = await db.query<{ id: string }>(
      `insert into sessions (owner_id, channel, label, token_hash, expires_at)
       values ($1, 'mcp', $2, $3, $4) returning id`, [ownerId, label ?? null, hash(token), expires]);
    return ok({ token, sessionId: s.rows[0]!.id, ownerId, expiresAt: expires.toISOString() });
  });
}

/** The only way MCP gets an Actor (hard rule 9). */
export async function actorForToken(deps: Deps, token: string | null | undefined): Promise<Actor | null> {
  if (!token) return null;
  const r = await deps.db.query<{ owner_id: string }>(
    `update sessions set last_used_at = now()
      where token_hash = $1 and revoked_at is null and expires_at > $2
      returning owner_id`, [hash(token.trim()), deps.clock.now()]);
  return r.rows[0] ? { ownerId: r.rows[0].owner_id } : null;
}

export interface SessionSummary {
  id: string; channel: string; label: string | null; createdAt: string; expiresAt: string;
  lastUsedAt: string | null; revoked: boolean;
}

export async function listSessions(deps: Deps, actor: Actor): Promise<SessionSummary[]> {
  const r = await deps.db.query<Record<string, any>>(
    `select id, channel, label, created_at, expires_at, last_used_at, revoked_at from sessions
      where owner_id = $1 order by created_at desc`, [actor.ownerId]);
  return r.rows.map((x) => ({
    id: x.id, channel: x.channel, label: x.label, createdAt: x.created_at.toISOString(),
    expiresAt: x.expires_at.toISOString(), lastUsedAt: x.last_used_at?.toISOString() ?? null, revoked: !!x.revoked_at,
  }));
}

export async function revokeSession(deps: Deps, actor: Actor, id: string): Promise<Result<{ id: string }>> {
  const found = await deps.db.query<{ id: string }>(
    `select id from sessions where owner_id = $1 and id::text like $2 and revoked_at is null limit 2`,
    [actor.ownerId, `${id}%`]);
  if (found.rows.length > 1) return err('ambiguous', 'prefix matches several sessions');
  if (!found.rows[0]) return err('not_found', `no active session ${id}`);
  await deps.db.query('update sessions set revoked_at = now() where id = $1', [found.rows[0].id]);
  return ok({ id: found.rows[0].id });
}
