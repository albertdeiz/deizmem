import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { capture } from '../../core/ops/capture';
import { list, original, setHidden, setText, show } from '../../core/ops/memories';
import { pending, PENDING_KINDS, type PendingKind } from '../../core/ops/pending';
import { reprocess } from '../../core/ops/reprocess';
import { archiveDomain, classify, createDomain, editDomain, listDomains, mergeDomains } from '../../core/ops/domains';
import { archiveFactType, createFactType, editFactType, listFactTypes } from '../../core/facts/registry';
import { putFacts, queryFacts } from '../../core/facts/facts';
import { verify } from '../../core/ops/verify';
import { spaceStatus, syncSpaces } from '../../core/ops/embeddings';
import { listSessions, mintPairingCode, redeemPairingCode, revokeSession } from '../../core/ops/identity';
import { serveHttp, serveStdio } from '../mcp/server';
import { retrieve } from '../../core/ops/retrieve';
import { drain, work } from '../../core/worker';
import { emit, type Command } from './io';

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

async function stdin(): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of process.stdin) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

const date = (d: string | null) => d ?? '          ';

export const commands: Record<string, Command> = {
  /** dm capture <file> | --text "..." | - [--note --title --occurred --wait] */
  async capture(ctx) {
    const actor = await ctx.actor();
    const src = ctx.args[0];
    const bytes = src === '-' ? await stdin() : src ? await readFile(src) : null;
    const r = await capture(ctx.deps, actor, {
      source: 'cli', bytes, filename: src && src !== '-' ? basename(src) : str(ctx.flags.filename) ?? null,
      text: str(ctx.flags.text), note: str(ctx.flags.note), title: str(ctx.flags.title),
      occurredAt: str(ctx.flags.occurred), maxBytes: ctx.cfg.maxUploadBytes,
    });
    if (r.kind === 'ok' && ctx.flags.wait) await drain(ctx.deps);
    const final = r.kind === 'ok' && ctx.flags.wait ? await show(ctx.deps, actor, r.value.id) : null;
    return emit(ctx, r, (v) =>
      `${v.deduped ? 'already stored' : 'stored'} ${v.id.slice(0, 8)} · ${final?.kind === 'ok' ? final.value.status : v.status}`);
  },

  async ls(ctx) {
    const r = await list(ctx.deps, await ctx.actor(), {
      domain: str(ctx.flags.domain), from: str(ctx.flags.from), to: str(ctx.flags.to),
      status: str(ctx.flags.status), includeHidden: ctx.flags.all === true,
      query: ctx.args.join(' ') || null, limit: Number(ctx.flags.limit ?? 20),
    });
    return emit(ctx, r, (v) => v.items.map((m) =>
      `${m.id.slice(0, 8)}  ${date(m.occurredAt)}  ${m.status.padEnd(10)} ${(m.domain ?? '-').padEnd(10)} ${m.title ?? m.filename ?? ''}`,
    ).join('\n') || '(nothing)');
  },

  /** dm search <question> [--domain --from --to --limit] — the retrieval the agent uses. */
  async search(ctx) {
    const r = await retrieve(ctx.deps, await ctx.actor(), {
      query: ctx.args.join(' '), domain: str(ctx.flags.domain), from: str(ctx.flags.from),
      to: str(ctx.flags.to), limit: Number(ctx.flags.limit ?? 8),
    });
    return emit(ctx, r, (v) => [`vector: ${v.vector}`, ...v.passages.map((p) =>
      `${p.memoryId.slice(0, 8)}#${p.seq}  ${p.score.toFixed(3)} ${p.via.padEnd(7)} ${p.title ?? ''}\n    ${p.content.replace(/\s+/g, ' ').slice(0, 160)}`,
    )].join('\n'));
  },

  async show(ctx) {
    return emit(ctx, await show(ctx.deps, await ctx.actor(), ctx.args[0] ?? ''));
  },

  /** dm open <id> [--out file] — writes the original. */
  async open(ctx) {
    const r = await original(ctx.deps, await ctx.actor(), ctx.args[0] ?? '');
    if (r.kind !== 'ok') return emit(ctx, r);
    const out = str(ctx.flags.out) ?? r.value.filename;
    await writeFile(out, r.value.bytes);
    console.log(`${out} (${r.value.mediaType}, ${r.value.bytes.length} bytes)`);
    return 0;
  },

  async hide(ctx) { return emit(ctx, await setHidden(ctx.deps, await ctx.actor(), ctx.args[0] ?? '', true)); },
  async unhide(ctx) { return emit(ctx, await setHidden(ctx.deps, await ctx.actor(), ctx.args[0] ?? '', false)); },

  /** dm text <id> "<text>" — what the agent does with memory_set_text. */
  async text(ctx) {
    return emit(ctx, await setText(ctx.deps, await ctx.actor(), ctx.args[0] ?? '', ctx.args.slice(1).join(' '), 'cli'));
  },

  async pending(ctx) {
    const kind = ctx.args[0] as PendingKind | undefined;
    if (kind && !PENDING_KINDS.includes(kind)) { console.error(`kinds: ${PENDING_KINDS.join(', ')}`); return 1; }
    return emit(ctx, await pending(ctx.deps, await ctx.actor(), kind), (v) => [
      PENDING_KINDS.map((k) => `${k} ${v.counts[k]}`).join(' · '),
      ...v.items.map((m) => `${m.id.slice(0, 8)}  ${m.reasons.join(',').padEnd(24)} ${m.title ?? m.filename ?? ''}${m.statusDetail ? `  (${m.statusDetail})` : ''}`),
    ].join('\n'));
  },

  /** dm reprocess [--status needs_text,failed] [--all] [--by <agent>] */
  async reprocess(ctx) {
    const status = str(ctx.flags.status)?.split(',').map((s) => s.trim()).filter(Boolean);
    return emit(ctx, await reprocess(ctx.deps, await ctx.actor(), {
      status, all: ctx.flags.all === true, by: str(ctx.flags.by) ?? null,
    }), (v) => `re-reading ${v.normalize} · re-queued for the agent ${v.requeued}`);
  },

  /** dm mcp [--stdio]: the agent's interface. HTTP by default. */
  async mcp(ctx) {
    if (ctx.flags.stdio) {
      await serveStdio(ctx.deps, ctx.cfg, process.env.DM_MCP_TOKEN);
    } else {
      serveHttp(ctx.deps, ctx.cfg, (s) => console.log(`${new Date().toISOString()} ${s}`));
    }
    await new Promise(() => {}); // runs until killed
    return 0;
  },

  /** dm pair: a one-use code, 15 minutes, to redeem with `dm token <code>`. */
  async pair(ctx) {
    return emit(ctx, await mintPairingCode(ctx.deps, await ctx.actor()),
      (v) => `code ${v.code} (until ${v.expiresAt})\nredeem: dm token ${v.code} --label hermes`);
  },

  async token(ctx) {
    return emit(ctx, await redeemPairingCode(ctx.deps, ctx.args[0] ?? '', str(ctx.flags.label)),
      (v) => `${v.token}\n(session ${v.sessionId.slice(0, 8)}, until ${v.expiresAt}; shown once)`);
  },

  async sessions(ctx) {
    const v = await listSessions(ctx.deps, await ctx.actor());
    return emit(ctx, { kind: 'ok', value: v }, (xs) => xs.map((s) =>
      `${s.id.slice(0, 8)}  ${s.channel}  ${(s.label ?? '').padEnd(12)} ${s.revoked ? 'revoked' : `until ${s.expiresAt.slice(0, 10)}`}  last ${s.lastUsedAt ?? 'never'}`).join('\n') || '(none)');
  },

  async revoke(ctx) {
    return emit(ctx, await revokeSession(ctx.deps, await ctx.actor(), ctx.args[0] ?? ''));
  },

  /** dm domains [create <slug> --description .. | edit <slug> | archive <slug> | merge <a> <b>] [--yes] */
  async domains(ctx) {
    const [sub, a, b] = ctx.args;
    const actor = await ctx.actor();
    const yes = ctx.flags.yes === true;
    if (sub === 'create') return emit(ctx, await createDomain(ctx.deps, actor, { slug: a ?? '', label: str(ctx.flags.label), description: str(ctx.flags.text) ?? '' }, yes));
    if (sub === 'edit') return emit(ctx, await editDomain(ctx.deps, actor, a ?? '', { label: str(ctx.flags.label), description: str(ctx.flags.text) }, yes));
    if (sub === 'archive') return emit(ctx, await archiveDomain(ctx.deps, actor, a ?? '', yes));
    if (sub === 'merge') return emit(ctx, await mergeDomains(ctx.deps, actor, a ?? '', b ?? '', yes));
    const v = await listDomains(ctx.deps, actor, ctx.flags.all === true);
    return emit(ctx, { kind: 'ok', value: v }, (xs) => xs.map((d) =>
      `${d.slug.padEnd(14)} ${String(d.memories).padStart(4)}  ${d.active ? '' : '(archived) '}${d.description}`).join('\n') || '(none)');
  },

  /** dm classify <id> <domain|-> [--title --occurred --by] */
  async classify(ctx) {
    const [id, domain] = ctx.args;
    return emit(ctx, await classify(ctx.deps, await ctx.actor(), {
      id: id ?? '', domain: domain && domain !== '-' ? domain : null, title: str(ctx.flags.title),
      occurredAt: str(ctx.flags.occurred), by: str(ctx.flags.by) ?? 'cli',
    }));
  },

  /** dm types [create <json|@file> | edit <slug> <json> | archive <slug>] [--yes] */
  async types(ctx) {
    const [sub, a, b] = ctx.args;
    const actor = await ctx.actor();
    const yes = ctx.flags.yes === true;
    const json = async (s?: string) => JSON.parse(s?.startsWith('@') ? await readFile(s.slice(1), 'utf8') : s ?? '{}');
    if (sub === 'create') return emit(ctx, await createFactType(ctx.deps, actor, await json(a), yes));
    if (sub === 'edit') return emit(ctx, await editFactType(ctx.deps, actor, a ?? '', await json(b), yes));
    if (sub === 'archive') return emit(ctx, await archiveFactType(ctx.deps, actor, a ?? '', yes));
    const v = await listFactTypes(ctx.deps, actor, ctx.flags.all === true);
    return emit(ctx, { kind: 'ok', value: v }, (xs) => xs.map((t) =>
      `${t.slug.padEnd(20)} ${t.kind}/${t.cardinality}  [${t.fields.map((f) => `${f.name}:${f.kind}`).join(', ')}]${t.active ? '' : ' (archived)'}`).join('\n') || '(none)');
  },

  /** dm facts <type> [--identity --at --all]  ·  dm facts put <memory> <json|@file> [--by] */
  async facts(ctx) {
    const actor = await ctx.actor();
    if (ctx.args[0] === 'put') {
      const body = JSON.parse(ctx.args[2]?.startsWith('@') ? await readFile(ctx.args[2].slice(1), 'utf8') : ctx.args[2] ?? '{}');
      return emit(ctx, await putFacts(ctx.deps, actor, { memoryId: ctx.args[1] ?? '', type: body.type, instances: body.instances ?? [], by: str(ctx.flags.by) ?? 'cli' }));
    }
    return emit(ctx, await queryFacts(ctx.deps, actor, {
      type: ctx.args[0] ?? '', identity: str(ctx.flags.label), at: str(ctx.flags.to), history: ctx.flags.all === true,
    }), (v) => v.facts.map((f) =>
      `${f.status.padEnd(10)} ${f.identity.padEnd(14)} ${JSON.stringify(f.payload)}  ← ${f.memoryId.slice(0, 8)}`).join('\n') || '(none)');
  },

  /** dm verify "<text>" <memory ids...> */
  async verify(ctx) {
    const [text, ...ids] = ctx.args;
    return emit(ctx, await verify(ctx.deps, await ctx.actor(), { text: text ?? '', memoryIds: ids }),
      (v) => v.ok ? 'every figure is backed' : `not in the memories: ${v.missing.join(', ')}`);
  },

  /** dm index [--status]: embedding spaces and their progress; without --status, syncs with the lane. */
  async index(ctx) {
    if (!ctx.flags.status) {
      const s = await syncSpaces(ctx.deps);
      console.log(`${s.state}: ${s.action}`);
    }
    const v = await spaceStatus(ctx.deps);
    return emit(ctx, { kind: 'ok', value: v }, (xs) => xs.map((x) =>
      `${String(x.id).padStart(3)}  ${x.status.padEnd(9)} ${x.model} (${x.dimensions}d)  ${x.embedded} / ${x.chunks} chunks`).join('\n') || '(no spaces yet)');
  },

  /** The long-running job loop. */
  async worker(ctx) {
    const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
    log('worker up');
    await work(ctx.deps, log);
    return 0;
  },
};
