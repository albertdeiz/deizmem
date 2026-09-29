import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import type { Config } from '../../config';
import { queryFacts, type FactHit } from '../../core/facts/facts';
import { listFactTypes } from '../../core/facts/registry';
import { capture } from '../../core/ops/capture';
import { doctor } from '../../core/ops/doctor';
import { classify, listDomains } from '../../core/ops/domains';
import { actorForToken, listSessions, redeemPairingCode, revokeSession, revokeToken } from '../../core/ops/identity';
import { list, original, setHidden, setText, show } from '../../core/ops/memories';
import { pending, PENDING_KINDS, type PendingKind } from '../../core/ops/pending';
import { retrieve } from '../../core/ops/retrieve';
import type { Actor, Deps } from '../../core/ports';
import type { Result } from '../../core/result';

/**
 * The person's window onto their memory. Same ops as MCP and the CLI, no logic of
 * its own. Identity is the pairing of §9: a code from `dm pair` becomes a token
 * that lives in an HttpOnly cookie, and `dm revoke` cuts it like any other.
 * What MCP does not expose, the web does not either: no purge, no reprocess, no pair.
 */

const COOKIE = 'dm_web';
/** Who decided, when the person does it from the web (the `by` of §3.6). */
const BY = 'person/web';

const ERR_STATUS: Record<string, number> = {
  invalid: 400, forbidden: 403, not_found: 404, conflict: 409, ambiguous: 409, too_large: 413, unavailable: 503,
};

/** A Result as HTTP: the body keeps the stable `code`, the prose is the page's. */
function reply<T>(res: Response, r: Result<T>) {
  if (r.kind === 'ok') return res.json(r.value);
  if (r.kind === 'requires_confirmation') {
    return res.status(409).json({ code: 'requires_confirmation', message: r.message, affects: r.affects });
  }
  return res.status(ERR_STATUS[r.code] ?? 500)
    .json({ code: r.code, message: r.message, ...(r.detail === undefined ? {} : { detail: r.detail }) });
}

const fail = (res: Response, status: number, code: string, message: string) => res.status(status).json({ code, message });

function cookieToken(req: Request): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

const cookieOpts = { httpOnly: true, sameSite: 'strict' as const, path: '/' };

/**
 * Another site can make the browser send a POST here; it cannot add a custom
 * header without a preflight this server never answers. With SameSite=Strict on
 * the cookie, that closes cross-site writes.
 */
function sameOrigin(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.headers.origin;
  if (req.headers['x-dm-web'] !== '1' || (origin && origin !== `http://${req.headers.host}`)) {
    return fail(res, 403, 'forbidden', 'cross-site request');
  }
  next();
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const int = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);
const strings = (v: unknown) => (Array.isArray(v) ? v : v === undefined ? [] : [v])
  .filter((t): t is string => typeof t === 'string' && !!t.trim()).map((t) => t.trim());

/** Every fact backed by one memory, with the status the fact mode computes. */
async function factsOf(deps: Deps, actor: Actor, memoryId: string): Promise<FactHit[]> {
  const out: FactHit[] = [];
  for (const t of await listFactTypes(deps, actor, true)) {
    const r = await queryFacts(deps, actor, { type: t.slug, memoryId, history: true });
    if (r.kind === 'ok') out.push(...r.value.facts);
  }
  return out;
}

/** Only inert types open in place: a stored HTML or SVG must never run as this page. */
const INLINE = /^(image\/(png|jpeg|gif|webp|avif)|audio\/[\w.+-]+|video\/[\w.+-]+|text\/plain)(;|$)/;

const CSP = "default-src 'self'; img-src 'self' blob: data:; media-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

type Authed = Request & { actor: Actor };
const run = (fn: (req: Authed, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req as Authed, res).catch(next); };

export function webApp(deps: Deps, cfg: Config, log: (s: string) => void) {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use((_req, res, next) => {
    res.set({ 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    next();
  });
  app.get('/health', (_req, res) => { res.json({ ok: true, service: 'deizmem-web' }); });

  const api = express.Router();
  api.use((_req, res, next) => { res.set('cache-control', 'no-store'); next(); });
  api.use(sameOrigin);
  api.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => log(`${req.method} ${req.path.replace(/[0-9a-f-]{6,36}/g, ':id')} ${res.statusCode} ${Date.now() - t0}ms`));
    next();
  });
  const json = express.json({ limit: '1mb' });

  api.post('/login', json, async (req, res, next) => {
    try {
      const r = await redeemPairingCode(deps, typeof req.body?.code === 'string' ? req.body.code : '', str(req.body?.label) ?? 'web');
      if (r.kind !== 'ok') return reply(res, r);
      log(`login owner=${r.value.ownerId.slice(0, 8)} session=${r.value.sessionId.slice(0, 8)}`);
      res.cookie(COOKIE, r.value.token, { ...cookieOpts, expires: new Date(r.value.expiresAt) });
      res.json({ ok: true, expiresAt: r.value.expiresAt });
    } catch (e) { next(e); }
  });

  api.post('/logout', async (req, res, next) => {
    try {
      const token = cookieToken(req);
      if (token) await revokeToken(deps, token);
      res.clearCookie(COOKIE, cookieOpts).json({ ok: true });
    } catch (e) { next(e); }
  });

  // From here on every route needs a session, checked before any body is read. The
  // actor comes from the cookie, never from a parameter (hard rule 9).
  api.use((req, res, next) => {
    actorForToken(deps, cookieToken(req)).then((actor) => {
      if (!actor) return fail(res, 401, 'unauthenticated', 'pair this browser with a code from dm pair');
      (req as Authed).actor = actor;
      next();
    }, next);
  });

  api.get('/overview', run(async (req, res) => {
    const [health, queue, domains] = await Promise.all([doctor(deps), pending(deps, req.actor, null, 1), listDomains(deps, req.actor)]);
    // The doctor's memory counts span every owner: only the host's health leaves it.
    res.json({ db: health.db, lanes: health.lanes, spaces: health.spaces, pending: queue.kind === 'ok' ? queue.value.counts : null, domains });
  }));

  api.get('/memories', run(async (req, res) => {
    const q = req.query;
    reply(res, await list(deps, req.actor, {
      query: str(q.query), domain: str(q.domain), status: str(q.status), from: str(q.from), to: str(q.to),
      includeHidden: q.hidden === '1', limit: int(q.limit), cursor: int(q.cursor),
    }));
  }));

  api.get('/memories/:id', run(async (req, res) => {
    const m = await show(deps, req.actor, String(req.params.id));
    if (m.kind !== 'ok') return reply(res, m);
    res.json({ ...m.value, facts: await factsOf(deps, req.actor, m.value.id) });
  }));

  api.get('/memories/:id/original', run(async (req, res) => {
    const r = await original(deps, req.actor, String(req.params.id));
    if (r.kind !== 'ok') return reply(res, r);
    const { bytes, mediaType, filename } = r.value;
    const pdf = mediaType === 'application/pdf';
    const inline = req.query.download !== '1' && (pdf || INLINE.test(mediaType));
    res.set({
      // Browsers refuse to render a sandboxed PDF; its viewer is its own sandbox.
      'content-security-policy': pdf ? "default-src 'none'; object-src 'self'"
        : "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
      'content-type': mediaType,
      'cache-control': 'private, max-age=300',
    });
    res.attachment(filename);
    if (inline) res.set('content-disposition', res.get('content-disposition')!.replace(/^attachment/, 'inline'));
    res.end(bytes);
  }));

  api.post('/memories/:id/hide', json, run(async (req, res) => {
    reply(res, await setHidden(deps, req.actor, String(req.params.id), req.body?.hidden !== false));
  }));

  api.post('/memories/:id/text', json, run(async (req, res) => {
    reply(res, await setText(deps, req.actor, String(req.params.id), typeof req.body?.text === 'string' ? req.body.text : '', BY));
  }));

  api.post('/memories/:id/classify', json, run(async (req, res) => {
    const b = req.body ?? {};
    reply(res, await classify(deps, req.actor, {
      id: String(req.params.id), domain: str(b.domain) ?? null, title: str(b.title), occurredAt: str(b.occurred_at),
      tags: Array.isArray(b.tags) ? strings(b.tags) : undefined,
      // The person deciding is as sure as it gets, and it leaves the review queue.
      confidence: 1, needsReview: false, by: BY,
    }));
  }));

  /** A file as the raw body with its metadata in the query, or a JSON note. */
  api.post('/capture',
    express.json({ limit: '1mb' }),
    express.raw({ type: (req) => !String(req.headers['content-type'] ?? '').startsWith('application/json'), limit: cfg.maxUploadBytes }),
    run(async (req, res) => {
      const base = { source: 'web' as const, maxBytes: cfg.maxUploadBytes };
      if (!Buffer.isBuffer(req.body)) {
        const b = req.body ?? {};
        return reply(res, await capture(deps, req.actor, {
          ...base, note: str(b.note), title: str(b.title), occurredAt: str(b.occurred_at), tags: strings(b.tags),
        }));
      }
      if (!req.body.length) return fail(res, 400, 'invalid', 'empty body: send the file bytes');
      const q = req.query;
      reply(res, await capture(deps, req.actor, {
        ...base, bytes: req.body, filename: str(q.filename), mediaType: str(q.media_type), note: str(q.note),
        title: str(q.title), occurredAt: str(q.occurred_at), tags: strings(q.tag),
      }));
    }));

  api.get('/pending', run(async (req, res) => {
    const k = str(req.query.kind);
    const kind = k && (PENDING_KINDS as string[]).includes(k) ? (k as PendingKind) : null;
    reply(res, await pending(deps, req.actor, kind, int(req.query.limit) ?? 100));
  }));

  api.get('/retrieve', run(async (req, res) => {
    reply(res, await retrieve(deps, req.actor, {
      query: str(req.query.query) ?? '', domain: str(req.query.domain), limit: int(req.query.limit),
    }));
  }));

  api.get('/domains', run(async (req, res) => { res.json({ domains: await listDomains(deps, req.actor, true) }); }));
  api.get('/fact-types', run(async (req, res) => { res.json({ types: await listFactTypes(deps, req.actor, true) }); }));
  api.get('/sessions', run(async (req, res) => { res.json({ sessions: await listSessions(deps, req.actor) }); }));
  api.post('/sessions/:id/revoke', run(async (req, res) => {
    reply(res, await revokeSession(deps, req.actor, String(req.params.id)));
  }));

  api.use((req, res) => fail(res, 404, 'not_found', `no route ${req.method} ${req.path}`));
  api.use((e: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    const status = e.status ?? 500;
    if (status >= 500) log(`error: ${e.message}`);
    const code = status === 413 ? 'too_large' : status === 400 ? 'invalid' : 'internal';
    if (!res.headersSent) fail(res, status, code, e.message);
  });
  app.use('/api', api);

  // The React bundle. Everything that is not /api or a file is the page (client routes use #).
  app.use(express.static(cfg.webRoot, { index: 'index.html', maxAge: 0 }));
  app.use((_req, res) => fail(res, 404, 'not_found', 'not found'));
  return app;
}

export function serveWeb(deps: Deps, cfg: Config, log: (s: string) => void): Server {
  const app = webApp(deps, cfg, log);
  return app.listen(cfg.webPort, cfg.webHost, () => log(`web listening on http://${cfg.webHost}:${cfg.webPort}/`));
}
