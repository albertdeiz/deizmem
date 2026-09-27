import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../../src/config';
import { mintPairingCode, redeemPairingCode } from '../../src/core/ops/identity';
import { drain } from '../../src/core/worker';
import { serveHttp } from '../../src/adapters/mcp/server';
import { stack, unwrap, type Stack } from '../helpers/stack';

let s: Stack;
let http: Server;
let base: string;
let tokenA: string;
let tokenB: string;

async function client(token: string) {
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return c;
}

const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r = await c.callTool({ name, arguments: args });
  return { isError: !!r.isError, data: r.structuredContent as any };
};

beforeAll(async () => {
  s = await stack();
  const cfg = { ...loadConfig({}), mcpHost: '127.0.0.1', mcpPort: 0 };
  http = serveHttp(s.deps, cfg, () => {});
  await new Promise((r) => http.once('listening', r));
  const addr = http.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  tokenA = unwrap(await redeemPairingCode(s.deps, unwrap(await mintPairingCode(s.deps, s.actor)).code, 'a')).token;
  tokenB = unwrap(await redeemPairingCode(s.deps, unwrap(await mintPairingCode(s.deps, s.other)).code, 'b')).token;
});
afterAll(async () => { http.close(); await s.close(); });

describe('MCP', () => {
  it('refuses without a valid token', async () => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(r.status).toBe(401);
    await expect(client('dm_nope')).rejects.toThrow();
  });

  it('a pairing code works once', async () => {
    const code = unwrap(await mintPairingCode(s.deps, s.actor)).code;
    expect((await redeemPairingCode(s.deps, code)).kind).toBe('ok');
    expect((await redeemPairingCode(s.deps, code)).kind).toBe('err');
  });

  it('lists the tools with instructions, and no purge', async () => {
    const c = await client(tokenA);
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['memory_capture', 'memory_retrieve', 'pending_list', 'memory_set_text']));
    expect(names.some((n) => /purge|reprocess|pair/.test(n))).toBe(false);
    expect(c.getInstructions()).toContain('verify');
    await c.close();
  });

  it('captures, reads back and retrieves with citations', async () => {
    const c = await client(tokenA);
    const cap = await call(c, 'memory_capture', { note: 'Número de emergencia del edificio: +56 2 2345 6789' });
    expect(cap.isError).toBe(false);
    await drain(s.deps);
    const r = await call(c, 'memory_retrieve', { query: 'emergencia edificio' });
    expect(r.data.passages[0].memoryId).toBe(cap.data.id);
    const g = await call(c, 'memory_get', { id: cap.data.id.slice(0, 8) });
    expect(g.data.note).toContain('emergencia');
    const bad = await call(c, 'memory_get', { id: 'zzzz' });
    expect(bad.isError).toBe(true);
    expect(bad.data.code).toBe('invalid');
    await c.close();
  });

  it('round-trips a file through capture and original', async () => {
    const c = await client(tokenA);
    const bytes = Buffer.from('línea uno\nlínea dos\n');
    const cap = await call(c, 'memory_capture', { content_base64: bytes.toString('base64'), filename: 'x.txt' });
    const o = await call(c, 'memory_original', { id: cap.data.id });
    expect(Buffer.from(o.data.content_base64, 'base64').equals(bytes)).toBe(true);
    await c.close();
  });

  it('isolates owners by token', async () => {
    const b = await client(tokenB);
    const r = await call(b, 'memory_retrieve', { query: 'emergencia edificio' });
    expect(r.data.passages).toEqual([]);
    const l = await call(b, 'memory_search', {});
    expect(l.data.items).toEqual([]);
    await b.close();
  });
});
