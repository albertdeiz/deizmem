import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { capture } from '../../core/ops/capture';
import { list, original, setHidden, setText, show } from '../../core/ops/memories';
import { pending, PENDING_KINDS, type PendingKind } from '../../core/ops/pending';
import { reprocess } from '../../core/ops/reprocess';
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

  /** The long-running job loop. */
  async worker(ctx) {
    const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
    log('worker up');
    await work(ctx.deps, log);
    return 0;
  },
};
