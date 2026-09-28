import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from '../../config';
import { capture } from '../../core/ops/capture';
import { actorForToken } from '../../core/ops/identity';
import type { Actor, Deps } from '../../core/ports';
import { INSTRUCTIONS } from './contract';
import { registerTools, toMcp } from './tools';

const VERSION = '0.1.0';

export function buildServer(deps: Deps, actor: Actor, cfg: Config): McpServer {
  const server = new McpServer({ name: 'deizmem', version: VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, deps, actor, cfg);
  return server;
}

const MAX_BODY = 40 * 1024 * 1024; // base64 of the upload limit, with room

async function readJson(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
    parts.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8') || 'null');
}

/** Raw bytes, cut off at `max`: the upload limit is checked while reading, not after. */
async function readBytes(req: IncomingMessage, max: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw Object.assign(new Error(`file is larger than ${max} bytes`), { status: 413 });
    parts.push(c as Buffer);
  }
  return Buffer.concat(parts);
}

const ERR_STATUS: Record<string, number> = { invalid: 400, too_large: 413, not_found: 404 };

/**
 * POST /capture: the bytes of one file as the body, its metadata in the query.
 * Same op and same answer as memory_capture, without base64 through the agent's
 * context (CLAUDE.md §5).
 */
async function captureUpload(deps: Deps, cfg: Config, actor: Actor, req: IncomingMessage, url: URL, res: ServerResponse) {
  let bytes: Buffer;
  try {
    bytes = await readBytes(req, cfg.maxUploadBytes);
  } catch (e) {
    return send(res, 413, { code: 'too_large', message: (e as Error).message });
  }
  if (!bytes.length) return send(res, 400, { code: 'invalid', message: 'empty body: send the file bytes' });
  const q = (k: string) => url.searchParams.get(k);
  const r = await capture(deps, actor, {
    source: 'mcp', bytes, filename: q('filename'), mediaType: q('media_type'), note: q('note'),
    title: q('title'), occurredAt: q('occurred_at'), tags: url.searchParams.getAll('tag'),
    maxBytes: cfg.maxUploadBytes,
  });
  if (r.kind === 'ok') return send(res, 200, r.value);
  // capture never asks for confirmation; toMcp gives the body the MCP tool would.
  return send(res, r.kind === 'err' ? ERR_STATUS[r.code] ?? 500 : 409, toMcp(r).structuredContent);
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

/**
 * Streamable HTTP, stateless: every POST gets its own server bound to the actor
 * of its bearer token. No token, no actor; no actor, no tool (hard rule 9).
 * Logs carry tool-free metadata only: never arguments, content or tokens.
 */
export function serveHttp(deps: Deps, cfg: Config, log: (s: string) => void) {
  const http = createServer(async (req, res) => {
    const t0 = Date.now();
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/health') return send(res, 200, { ok: true, service: 'deizmem', version: VERSION });
    if (url.pathname !== '/mcp' && url.pathname !== '/capture') return send(res, 404, { error: 'not found' });
    if (req.method !== 'POST') return send(res, 405, { error: 'stateless server: POST only' });

    const auth = req.headers.authorization ?? '';
    const actor = await actorForToken(deps, auth.startsWith('Bearer ') ? auth.slice(7) : null);
    if (!actor) {
      log(`401 ${req.socket.remoteAddress}`);
      return send(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'missing or invalid bearer token' }, id: null });
    }
    try {
      if (url.pathname === '/capture') {
        await captureUpload(deps, cfg, actor, req, url, res);
        log(`capture ${res.statusCode} owner=${actor.ownerId.slice(0, 8)} ${Date.now() - t0}ms`);
        return;
      }
      const body = await readJson(req);
      const server = buildServer(deps, actor, cfg);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      const method = (body as { method?: string })?.method ?? '?';
      const tool = method === 'tools/call' ? (body as { params?: { name?: string } }).params?.name : '';
      log(`${method}${tool ? ` ${tool}` : ''} owner=${actor.ownerId.slice(0, 8)} ${Date.now() - t0}ms`);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      log(`error ${status}: ${(e as Error).message}`);
      if (!res.headersSent) send(res, status, { jsonrpc: '2.0', error: { code: -32603, message: (e as Error).message }, id: null });
    }
  });
  http.listen(cfg.mcpPort, cfg.mcpHost, () => log(`mcp listening on http://${cfg.mcpHost}:${cfg.mcpPort}/mcp`));
  return http;
}

/** stdio, for an agent on the same host. The token comes from DM_MCP_TOKEN. */
export async function serveStdio(deps: Deps, cfg: Config, token: string | undefined): Promise<void> {
  const actor = await actorForToken(deps, token);
  if (!actor) throw new Error('DM_MCP_TOKEN is missing or invalid');
  const server = buildServer(deps, actor, cfg);
  await server.connect(new StdioServerTransport());
}
