import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from '../../config';
import { capture } from '../../core/ops/capture';
import { list, original, setHidden, setText, show } from '../../core/ops/memories';
import { pending, PENDING_KINDS } from '../../core/ops/pending';
import { retrieve } from '../../core/ops/retrieve';
import { MAX_PASSWORD, unlock } from '../../core/ops/unlock';
import type { Actor, Deps } from '../../core/ports';
import type { Result } from '../../core/result';
import { readAllowedPath } from './read-path';
import { registerKnowledgeTools } from './tools-knowledge';

/** Result → MCP. ok → structured value; err/confirmation → isError with a stable code. */
export function toMcp<T>(r: Result<T>): CallToolResult {
  if (r.kind === 'ok') {
    const value = (r.value !== null && typeof r.value === 'object' && !Array.isArray(r.value))
      ? r.value as Record<string, unknown> : { value: r.value };
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
  }
  const body = r.kind === 'err'
    ? { code: r.code, message: r.message, ...(r.detail === undefined ? {} : { detail: r.detail }) }
    : { code: 'requires_confirmation', message: r.message, affects: r.affects };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export const byField = z.string().min(1).max(120).describe('Who decided: "<agent>/<model>", e.g. "hermes/qwen3-8b"');

/**
 * registerTool with a strict input schema. By default an unknown argument is dropped
 * in silence, and the call goes through with what is left: a capture sent with an
 * unsupported `path` and a note came back ready, holding only the note. Refusing the
 * argument makes the agent see its mistake.
 */
export function strictTools(server: McpServer) {
  return <S extends z.ZodRawShape>(
    name: string, config: { description: string; inputSchema: S },
    cb: (a: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>,
  ) => server.registerTool(name, { ...config, inputSchema: z.strictObject(config.inputSchema) }, cb as never);
}

/** Registers every tool. The actor is fixed per connection: no tool takes an owner. */
export function registerTools(server: McpServer, deps: Deps, actor: Actor, cfg: Config): void {
  const tool = strictTools(server);

  tool('memory_capture', {
    description: 'Store a file or a note. Returns at once; reading the file happens in the background. Send `text` when you already have the content (a transcript, a handwriting read) and lanes are skipped. `note` is the person\'s own words. For a file you cannot copy exactly as base64 (anything beyond a few KB), POST its raw bytes to /capture next to this /mcp endpoint, with the same Bearer and filename, note, title, occurred_at, tag in the query. If the file sits in a directory the server shares with you, send its absolute `path` instead and the server reads it. For an encrypted PDF, pass `password`: the file is read in this call, the password is used once and never stored, and a wrong one still stores the file (the answer carries `unlock` with the reason).',
    inputSchema: {
      content_base64: z.string().optional().describe('The file bytes, base64'),
      path: z.string().optional().describe('Absolute path of the file on the server, inside a shared directory. Instead of content_base64'),
      filename: z.string().optional().describe('Only with content_base64 or path'),
      media_type: z.string().optional().describe('Only with content_base64 or path'),
      text: z.string().optional(),
      note: z.string().optional(),
      title: z.string().optional(),
      occurred_at: date.optional().describe('When the event happened, if known'),
      tags: z.array(z.string()).optional(),
      password: z.string().min(1).max(MAX_PASSWORD).optional().describe('Opens an encrypted PDF. Used once, never stored or returned'),
    },
  }, async (a) => {
    let bytes: Buffer | null = a.content_base64 ? Buffer.from(a.content_base64, 'base64') : null;
    let filename = a.filename;
    if (a.path !== undefined) {
      if (bytes) return toMcp({ kind: 'err', code: 'invalid', message: 'send content_base64 or path, not both' });
      const f = await readAllowedPath(a.path, cfg.captureDirs, cfg.maxUploadBytes);
      if (f.kind !== 'ok') return toMcp(f);
      bytes = f.value.bytes;
      filename = a.filename ?? f.value.filename;
    }
    return toMcp(await capture(deps, actor, {
      source: 'mcp', bytes, filename, mediaType: a.media_type, text: a.text, note: a.note,
      title: a.title, occurredAt: a.occurred_at, tags: a.tags, password: a.password, maxBytes: cfg.maxUploadBytes,
    }));
  });

  tool('memory_retrieve', {
    description: 'Find the passages that answer a question. Hybrid lexical + vector search over chunks; each passage carries memoryId and seq to cite. `vector` tells whether vectors were used.',
    inputSchema: {
      query: z.string().min(1),
      terms: z.array(z.string()).optional().describe('Extra variants: synonyms, translations, spellings'),
      domain: z.string().optional().describe('Domain slug to narrow to'),
      from: date.optional(), to: date.optional(),
      limit: z.number().int().min(1).max(30).optional(),
    },
  }, async (a) => toMcp(await retrieve(deps, actor, a)));

  tool('memory_search', {
    description: 'List memories (newest event first), optionally filtered by text, domain, dates or status. Page with `cursor`.',
    inputSchema: {
      query: z.string().optional(), domain: z.string().optional(), from: date.optional(), to: date.optional(),
      status: z.enum(['pending', 'ready', 'needs_text', 'failed']).optional(),
      limit: z.number().int().min(1).max(100).optional(), cursor: z.number().int().min(0).optional(),
    },
  }, async (a) => toMcp(await list(deps, actor, a)));

  tool('memory_get', {
    description: 'One memory in full: metadata, the person\'s note, the extracted text, and its status.',
    inputSchema: { id: z.string().describe('Memory id or a unique prefix of 6+ characters') },
  }, async (a) => toMcp(await show(deps, actor, a.id)));

  tool('memory_original', {
    description: 'The original file, base64. Use it to read what no lane could (vision, audio), or to hand the file to the person.',
    inputSchema: { id: z.string() },
  }, async (a) => {
    const r = await original(deps, actor, a.id);
    if (r.kind !== 'ok') return toMcp(r);
    return toMcp({ kind: 'ok', value: {
      filename: r.value.filename, mediaType: r.value.mediaType, size: r.value.bytes.length,
      content_base64: r.value.bytes.toString('base64'),
    } });
  });

  tool('memory_set_text', {
    description: 'Provide the text of a memory no lane could read (status needs_text). Replaces the extracted text, never the person\'s note.',
    inputSchema: { id: z.string(), text: z.string().min(1), by: byField },
  }, async (a) => toMcp(await setText(deps, actor, a.id, a.text, a.by)));

  tool('memory_unlock', {
    description: 'Open an encrypted PDF already stored (needs_text with password_required, or a wrong password before). Reads it now; the password is used once, never stored, and never appears in an answer. Never write the password into a note, text, fact or your own reply.',
    inputSchema: { id: z.string(), password: z.string().min(1).max(MAX_PASSWORD) },
  }, async (a) => toMcp(await unlock(deps, actor, a.id, a.password)));

  tool('memory_hide', {
    description: 'Hide a memory from results (reversible). Nothing is deleted.',
    inputSchema: { id: z.string(), hidden: z.boolean().default(true) },
  }, async (a) => toMcp(await setHidden(deps, actor, a.id, a.hidden)));

  tool('pending_list', {
    description: 'Your work queue: needs_text (read it and call memory_set_text), unclassified (memory_classify), unextracted (facts_put), review (flagged doubtful), failed.',
    inputSchema: { kind: z.enum(PENDING_KINDS as [string, ...string[]]).optional(), limit: z.number().int().min(1).max(100).optional() },
  }, async (a) => toMcp(await pending(deps, actor, a.kind as never, a.limit)));

  registerKnowledgeTools(server, deps, actor);
}
