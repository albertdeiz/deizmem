import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from '../../config';
import { capture } from '../../core/ops/capture';
import { list, original, setHidden, setText, show } from '../../core/ops/memories';
import { pending, PENDING_KINDS } from '../../core/ops/pending';
import { retrieve } from '../../core/ops/retrieve';
import type { Actor, Deps } from '../../core/ports';
import type { Result } from '../../core/result';
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

/** Registers every tool. The actor is fixed per connection: no tool takes an owner. */
export function registerTools(server: McpServer, deps: Deps, actor: Actor, cfg: Config): void {
  const tool = server.registerTool.bind(server);

  tool('memory_capture', {
    description: 'Store a file or a note. Returns at once; reading the file happens in the background. Send `text` when you already have the content (a transcript, a handwriting read) and lanes are skipped. `note` is the person\'s own words.',
    inputSchema: {
      content_base64: z.string().optional().describe('The file bytes, base64'),
      filename: z.string().optional().describe('Only with content_base64'),
      media_type: z.string().optional().describe('Only with content_base64'),
      text: z.string().optional(),
      note: z.string().optional(),
      title: z.string().optional(),
      occurred_at: date.optional().describe('When the event happened, if known'),
      tags: z.array(z.string()).optional(),
    },
  }, async (a) => {
    const bytes = a.content_base64 ? Buffer.from(a.content_base64, 'base64') : null;
    return toMcp(await capture(deps, actor, {
      source: 'mcp', bytes, filename: a.filename, mediaType: a.media_type, text: a.text, note: a.note,
      title: a.title, occurredAt: a.occurred_at, tags: a.tags, maxBytes: cfg.maxUploadBytes,
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
