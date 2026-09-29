import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { loadConfig } from '../../src/config';
import { mintPairingCode } from '../../src/core/ops/identity';
import { drain } from '../../src/core/worker';
import { serveWeb } from '../../src/adapters/web/server';
import { stack, unwrap, type Stack } from '../helpers/stack';

let s: Stack;
let http: Server;
let base: string;

beforeAll(async () => {
  s = await stack();
  const cfg = { ...loadConfig({}), webHost: '127.0.0.1', webPort: 0, maxUploadBytes: 64 * 1024 };
  http = serveWeb(s.deps, cfg, () => {});
  await new Promise((r) => http.once('listening', r));
  const addr = http.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => { http.close(); await s.close(); });

const WRITE = { 'x-dm-web': '1', 'content-type': 'application/json' };

async function login(actor = s.actor): Promise<string> {
  const code = unwrap(await mintPairingCode(s.deps, actor)).code;
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: WRITE, body: JSON.stringify({ code, label: 'test' }) });
  expect(r.status).toBe(200);
  const cookie = r.headers.get('set-cookie') ?? '';
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/SameSite=Strict/i);
  return cookie.split(';')[0]!;
}

const get = (cookie: string, path: string) => fetch(`${base}${path}`, { headers: { cookie } });
const post = (cookie: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { ...WRITE, cookie }, body: JSON.stringify(body) });

describe('web', () => {
  it('refuses without a session, and a code works once', async () => {
    expect((await fetch(`${base}/api/memories`)).status).toBe(401);
    const code = unwrap(await mintPairingCode(s.deps, s.actor)).code;
    const once = () => fetch(`${base}/api/login`, { method: 'POST', headers: WRITE, body: JSON.stringify({ code }) });
    expect((await once()).status).toBe(200);
    expect((await once()).status).toBe(403);
  });

  it('refuses a write without the same-origin header', async () => {
    const cookie = await login();
    const r = await fetch(`${base}/api/capture`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ note: 'x' }),
    });
    expect(r.status).toBe(403);
    const cross = await fetch(`${base}/api/capture`, {
      method: 'POST', headers: { ...WRITE, cookie, origin: 'http://evil.example' }, body: JSON.stringify({ note: 'x' }),
    });
    expect(cross.status).toBe(403);
  });

  it('captures a note and a file, lists, shows, hides and classifies', async () => {
    const cookie = await login();
    const note = await (await post(cookie, '/api/capture', { note: 'poliza auto BP-9344586 deducible 150.000', tags: ['auto'] })).json();
    expect(note.id).toBeTruthy();

    const file = await fetch(`${base}/api/capture?filename=receta.txt&title=Receta&tag=salud`, {
      method: 'POST', headers: { 'x-dm-web': '1', 'content-type': 'text/plain', cookie }, body: 'paracetamol 500 mg cada 8 horas',
    });
    expect(file.status).toBe(200);
    const fileId = (await file.json()).id;
    await drain(s.deps, () => {});

    const listed = await (await get(cookie, '/api/memories?query=paracetamol')).json();
    expect(listed.items.map((m: { id: string }) => m.id)).toEqual([fileId]);

    const shown = await (await get(cookie, `/api/memories/${fileId}`)).json();
    expect(shown.title).toBe('Receta');
    expect(shown.facts).toEqual([]);

    const orig = await get(cookie, `/api/memories/${fileId}/original`);
    expect(orig.headers.get('content-disposition')).toMatch(/^inline/);
    expect(await orig.text()).toBe('paracetamol 500 mg cada 8 horas');

    expect((await post(cookie, `/api/memories/${note.id}/hide`, { hidden: true })).status).toBe(200);
    const visible = await (await get(cookie, '/api/memories')).json();
    expect(visible.items.map((m: { id: string }) => m.id)).not.toContain(note.id);

    const c = await post(cookie, `/api/memories/${fileId}/classify`, { title: 'Receta paracetamol', tags: ['salud', 'receta'] });
    expect(c.status).toBe(200);
    const after = await (await get(cookie, `/api/memories/${fileId}`)).json();
    expect(after.classifiedBy).toBe('person/web');
    expect(after.tags).toEqual(['salud', 'receta']);
  });

  it('never serves a stored HTML file inline', async () => {
    const cookie = await login();
    const r = await fetch(`${base}/api/capture?filename=x.html&media_type=text/html`, {
      method: 'POST', headers: { 'x-dm-web': '1', 'content-type': 'text/html', cookie }, body: '<script>alert(1)</script>',
    });
    const id = (await r.json()).id;
    const orig = await get(cookie, `/api/memories/${id}/original`);
    expect(orig.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(orig.headers.get('content-security-policy')).toMatch(/sandbox/);
  });

  it('keeps owners apart', async () => {
    const a = await login(s.actor);
    const b = await login(s.other);
    const mine = await (await post(a, '/api/capture', { note: 'solo de alice' })).json();
    expect((await get(b, `/api/memories/${mine.id}`)).status).toBe(404);
  });

  it('logs out by revoking the session', async () => {
    const cookie = await login();
    expect((await get(cookie, '/api/overview')).status).toBe(200);
    expect((await post(cookie, '/api/logout', {})).status).toBe(200);
    expect((await get(cookie, '/api/overview')).status).toBe(401);
  });
});
