#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from '../../config';
import { systemClock, type Deps } from '../../core/ports';
import { createOwner, listOwners, resolveOperatorActor } from '../../core/ops/owners';
import { doctor } from '../../core/ops/doctor';
import { fsBlobStore } from '../blobs/fs';
import { migrate, openDb } from '../db/pg';
import { lanesFromConfig } from '../lanes/http';
import { commands as memoryCommands } from './commands';
import { CliExit, EXIT, emit, type Command, type Ctx } from './io';

const core: Record<string, Command> = {
  async migrate(ctx) {
    const applied = await migrate(ctx.deps.db, ctx.cfg.migrationsDir);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
    return 0;
  },

  /** Migrates and creates the first owner. Idempotent. */
  async init(ctx) {
    const applied = await migrate(ctx.deps.db, ctx.cfg.migrationsDir);
    if (applied.length) console.log(`applied: ${applied.join(', ')}`);
    const owners = await listOwners(ctx.deps.db);
    const name = typeof ctx.flags.owner === 'string' ? ctx.flags.owner : 'me';
    if (owners.length === 0 || typeof ctx.flags.owner === 'string') {
      return emit(ctx, await createOwner(ctx.deps.db, name), (o) => `owner ${o.name} (${o.id})`);
    }
    console.log(`owners: ${owners.map((o) => o.name).join(', ')}`);
    return 0;
  },

  async owners(ctx) {
    const owners = await listOwners(ctx.deps.db);
    return emit(ctx, { kind: 'ok', value: owners }, (v) => v.map((o) => `${o.id}  ${o.name}`).join('\n') || '(none)');
  },

  async doctor(ctx) {
    const r = await doctor(ctx.deps);
    if (ctx.json) { console.log(JSON.stringify(r, null, 2)); return r.db.ok ? 0 : 1; }
    const fmt = (h: { ok: boolean; detail: string } | 'off') =>
      h === 'off' ? 'off' : `${h.ok ? 'ok' : 'FAIL'}  ${h.detail}`;
    console.log(`db        ${fmt(r.db)}`);
    for (const [k, v] of Object.entries(r.lanes)) console.log(`${k.padEnd(9)} ${fmt(v)}`);
    console.log(`queue     ${r.queue.pending} pending · ${r.queue.failed} failed`);
    console.log(`memories  ${r.memories.total} total · ${r.memories.needsText} needs_text · ${r.memories.failed} failed`);
    return r.db.ok ? 0 : 1;
  },
};

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv, allowPositionals: true, strict: false,
    // Every option is declared: in non-strict mode an unknown `--note "x"` becomes a
    // boolean and "x" a positional — which is how a note once got read as a file path.
    options: {
      json: { type: 'boolean' }, yes: { type: 'boolean' }, all: { type: 'boolean' }, wait: { type: 'boolean' },
      actor: { type: 'string' }, owner: { type: 'string' }, note: { type: 'string' }, text: { type: 'string' },
      title: { type: 'string' }, occurred: { type: 'string' }, filename: { type: 'string' },
      domain: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, status: { type: 'string' },
      limit: { type: 'string' }, stdio: { type: 'boolean' }, out: { type: 'string' }, by: { type: 'string' }, label: { type: 'string' },
    },
  });
  const [name, ...args] = positionals;
  const all: Record<string, Command> = { ...core, ...memoryCommands };
  if (!name || name === 'help' || !all[name]) {
    console.log(`usage: dm <command>\ncommands: ${Object.keys(all).sort().join(' · ')}`);
    return name && name !== 'help' ? 1 : 0;
  }
  const cfg = loadConfig();
  const { db, close } = openDb(cfg.databaseUrl);
  const deps: Deps = { db, blobs: fsBlobStore(cfg.blobRoot), lanes: lanesFromConfig(cfg), clock: systemClock };
  const ctx: Ctx = {
    deps, args, cfg,
    flags: values as Ctx['flags'],
    json: values.json === true,
    actor: async () => {
      const r = await resolveOperatorActor(db, typeof values.actor === 'string' ? values.actor : undefined);
      if (r.kind !== 'ok') throw new CliExit(r.kind === 'err' ? (EXIT[r.code] ?? 1) : 1, r.message);
      return r.value;
    },
  };
  try {
    return await all[name]!(ctx);
  } catch (e) {
    if (e instanceof CliExit) { console.error(e.message); return e.code; }
    throw e;
  } finally {
    // Long-running commands (mcp, worker) never return, so this only closes one-shots.
    await close();
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
