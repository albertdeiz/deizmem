import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capture } from '../../src/core/ops/capture';
import { setText, show } from '../../src/core/ops/memories';
import { reprocess } from '../../src/core/ops/reprocess';
import { retrieve } from '../../src/core/ops/retrieve';
import { reread, unlock } from '../../src/core/ops/unlock';
import { LaneRefused, type Converter } from '../../src/core/ports';
import { drain } from '../../src/core/worker';
import { fakeLane, stack, unwrap, type Stack } from '../helpers/stack';

const SECRET = 'sésamo-ÁBRETE-42';
const TEXT = 'Liquidación de sueldo de marzo. Líquido a pagar 1.747.885 pesos. Documento protegido con clave del empleador.';

/**
 * A document lane holding a locked PDF. It echoes the password in its refusal on
 * purpose: whatever a lane answers, the password must not get past the core.
 */
const lockedLane = (down = { now: false }): Converter => ({
  async extract({ password }) {
    if (down.now) throw new Error(`documents at http://documents:8000: connection refused (${password})`);
    if (password === SECRET) return { text: TEXT };
    throw new LaneRefused(password
      ? `documents answered 422: wrong_password: tried ${password}`
      : 'documents answered 422: password_required: the PDF is encrypted');
  },
  async health() { return { ok: true, detail: 'fake' }; },
});

let s: Stack;
const down = { now: false };
beforeAll(async () => { s = await stack({ document: lockedLane(down) }); });
afterAll(() => s.close());

let n = 0;
/** A fresh "encrypted PDF" every time, so dedup only happens where a test wants it. */
const pdf = () => Buffer.from(`%PDF-1.7 locked ${++n}`);
const cap = (input: Partial<Parameters<typeof capture>[2]>) =>
  capture(s.deps, s.actor, { source: 'cli', maxBytes: 1_000_000, ...input });

/** Every row of every table, as text: the password must be in none of them. */
async function everywhere(): Promise<string> {
  const tables = await s.deps.db.query<{ tablename: string }>(`select tablename from pg_tables where schemaname = 'public'`);
  const out: string[] = [];
  for (const { tablename } of tables.rows) {
    const r = await s.deps.db.query<{ row: string }>(`select to_jsonb(t)::text as row from "${tablename}" t`);
    out.push(...r.rows.map((x) => x.row));
  }
  return out.join('\n');
}

describe('encrypted PDFs', () => {
  it('a locked file lands in needs_text saying it needs a password', async () => {
    const r = unwrap(await cap({ bytes: pdf(), filename: 'liquidacion.pdf' }));
    await drain(s.deps);
    const m = unwrap(await show(s.deps, s.actor, r.id));
    expect(m.status).toBe('needs_text');
    expect(m.statusDetail).toContain('password_required');
  });

  it('a wrong password is refused, redacted, and leaves the file as it was', async () => {
    const r = unwrap(await cap({ bytes: pdf(), filename: 'liquidacion.pdf' }));
    await drain(s.deps);
    const u = await unlock(s.deps, s.actor, r.id, 'no-es-esta');
    expect(u.kind === 'err' && u.code).toBe('wrong_password');
    expect(u.kind === 'err' && u.message).not.toContain('no-es-esta');
    const m = unwrap(await show(s.deps, s.actor, r.id));
    expect(m.status).toBe('needs_text');
    expect(m.statusDetail).toContain('[redacted]');
    expect(await everywhere()).not.toContain('no-es-esta');
  });

  it('the right password reads it now, and nothing keeps the password', async () => {
    const r = unwrap(await cap({ bytes: pdf(), filename: 'liquidacion.pdf' }));
    await drain(s.deps);
    const u = unwrap(await unlock(s.deps, s.actor, r.id.slice(0, 8), SECRET));
    expect(u).toMatchObject({ status: 'ready', lane: 'document' });
    await drain(s.deps);
    const m = unwrap(await show(s.deps, s.actor, r.id));
    expect(m).toMatchObject({ status: 'ready', passwordProtected: true, text: TEXT });
    const found = unwrap(await retrieve(s.deps, s.actor, { query: 'liquidación de sueldo' }));
    expect(found.passages.map((p) => p.memoryId)).toContain(r.id);
    expect(await everywhere()).not.toContain(SECRET);
  });

  it('a capture with the password reads it in the call, with no job carrying it', async () => {
    const jobs = async () => Number((await s.deps.db.query<{ n: string }>(`select count(*) as n from jobs where kind = 'normalize'`)).rows[0]!.n);
    const before = await jobs();
    const r = unwrap(await cap({ bytes: pdf(), filename: 'liquidacion.pdf', password: SECRET }));
    expect(r.status).toBe('ready');
    expect(r.unlock).toBeUndefined();
    expect(await jobs()).toBe(before);
    expect(await everywhere()).not.toContain(SECRET);
  });

  it('a capture with a wrong password still stores the file, and says why it is unread', async () => {
    const r = unwrap(await cap({ bytes: pdf(), filename: 'liquidacion.pdf', password: 'otra' }));
    expect(r.status).toBe('needs_text');
    expect(r.unlock?.code).toBe('wrong_password');
    expect(r.unlock?.message).not.toContain('otra');
    expect(unwrap(await show(s.deps, s.actor, r.id)).status).toBe('needs_text');
  });

  it('the same locked file sent again with its password is the retry', async () => {
    const bytes = pdf();
    const first = unwrap(await cap({ bytes, filename: 'liquidacion.pdf' }));
    await drain(s.deps);
    const again = unwrap(await cap({ bytes, filename: 'liquidacion.pdf', password: SECRET }));
    expect(again).toMatchObject({ id: first.id, deduped: true, status: 'ready' });
  });

  it('a lane that is down leaves the file unread and asks for the password again', async () => {
    const r = unwrap(await cap({ bytes: pdf(), filename: 'liquidacion.pdf' }));
    await drain(s.deps);
    down.now = true;
    try {
      const u = await unlock(s.deps, s.actor, r.id, SECRET);
      expect(u.kind === 'err' && u.code).toBe('unavailable');
      expect(u.kind === 'err' && u.message).not.toContain(SECRET);
    } finally { down.now = false; }
    expect(unwrap(await show(s.deps, s.actor, r.id)).status).toBe('needs_text');
    expect(await everywhere()).not.toContain(SECRET);
  });

  it('with no lane on, a password gets unavailable, not a verdict on the password', async () => {
    const lane = s.deps.lanes.document;
    s.deps.lanes.document = null;
    try {
      const r = unwrap(await cap({ bytes: pdf(), filename: 'liquidacion.pdf', password: SECRET }));
      expect(r.unlock?.code).toBe('unavailable');
    } finally { s.deps.lanes.document = lane; }
  });

  it('a password needs a file, and does not go with text', async () => {
    expect((await cap({ note: 'mi nota', password: SECRET })).kind).toBe('err');
    expect((await cap({ bytes: pdf(), filename: 'x.pdf', text: 'ya leído', password: SECRET })).kind).toBe('err');
  });

  it('only an unread file, or one read with its password, is unlocked; owners stay apart', async () => {
    const note = unwrap(await cap({ note: 'sin archivo' }));
    expect((await unlock(s.deps, s.actor, note.id, SECRET)).kind).toBe('err');
    const r = unwrap(await cap({ bytes: pdf(), filename: 'liquidacion.pdf' }));
    await drain(s.deps);
    const theirs = await unlock(s.deps, s.other, r.id, SECRET);
    expect(theirs.kind === 'err' && theirs.code).toBe('not_found');
    unwrap(await unlock(s.deps, s.actor, r.id, SECRET));
    // Read with a password before: it may be read again with it.
    expect((await unlock(s.deps, s.actor, r.id, SECRET)).kind).toBe('ok');
    // And a wrong one then takes nothing away.
    expect((await unlock(s.deps, s.actor, r.id, 'mala')).kind).toBe('err');
    expect(unwrap(await show(s.deps, s.actor, r.id))).toMatchObject({ status: 'ready', text: TEXT });
  });

  it('reprocess and reread never lose the text of a file read with a password', async () => {
    const r = unwrap(await cap({ bytes: pdf(), filename: 'liquidacion.pdf', password: SECRET }));
    await drain(s.deps);
    unwrap(await reprocess(s.deps, s.actor, { all: true }));
    await drain(s.deps);
    expect(unwrap(await show(s.deps, s.actor, r.id))).toMatchObject({ status: 'ready', text: TEXT });
    const again = await reread(s.deps, s.actor, r.id);
    expect(again.kind === 'err' && again.code).toBe('conflict');
  });
});

describe('reread', () => {
  it('reads a file again once its lane is on', async () => {
    const r = unwrap(await cap({ bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00, 1, 2]), filename: 'boleta.jpg' }));
    await drain(s.deps);
    expect(unwrap(await show(s.deps, s.actor, r.id)).status).toBe('needs_text');
    s.deps.lanes.vision = fakeLane('Boleta farmacia total 12.990');
    try {
      expect(unwrap(await reread(s.deps, s.actor, r.id)).status).toBe('pending');
      await drain(s.deps);
    } finally { s.deps.lanes.vision = null; }
    expect(unwrap(await show(s.deps, s.actor, r.id))).toMatchObject({ status: 'ready', lane: 'vision' });
  });

  it('does not replace what an agent or the person wrote, nor touch a note', async () => {
    const r = unwrap(await cap({ bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00, 9]), filename: 'receta.jpg' }));
    await drain(s.deps);
    unwrap(await setText(s.deps, s.actor, r.id, 'Amoxicilina 500 mg', 'test-agent'));
    expect((await reread(s.deps, s.actor, r.id)).kind).toBe('err');
    const note = unwrap(await cap({ note: 'solo una nota' }));
    expect((await reread(s.deps, s.actor, note.id)).kind).toBe('err');
  });
});
