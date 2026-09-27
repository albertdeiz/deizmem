#!/usr/bin/env node
// Calls one MCP tool like an agent would. For manual testing against the Pi:
//   ssh -fNL 4319:127.0.0.1:4319 albertdeiz@192.168.100.17
//   DM_MCP_TOKEN=... node scripts/mcp-call.mjs memory_retrieve '{"query":"deducible"}'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [tool, args = '{}'] = process.argv.slice(2);
const c = new Client({ name: 'mcp-call', version: '0' });
await c.connect(new StreamableHTTPClientTransport(new URL(process.env.DM_MCP_URL ?? 'http://127.0.0.1:4319/mcp'), {
  requestInit: { headers: { authorization: `Bearer ${process.env.DM_MCP_TOKEN}` } },
}));
if (!tool || tool === 'list') {
  for (const t of (await c.listTools()).tools) console.log(t.name);
} else {
  const r = await c.callTool({ name: tool, arguments: JSON.parse(args) });
  console.log(JSON.stringify(r.structuredContent ?? r.content, null, 2));
  if (r.isError) process.exitCode = 1;
}
await c.close();
