/**
 * The ports. The core imports nothing concrete: a database, a blob store, the
 * optional lanes and a clock. There is no LLM port, on purpose (CLAUDE.md §2).
 */

export interface Db {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
  /** Runs `fn` inside a transaction; the callback receives a Db bound to it. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

export interface BlobStore {
  put(sha256: string, bytes: Buffer): Promise<void>;
  get(sha256: string): Promise<Buffer | null>;
  delete(sha256: string): Promise<void>;
}

export interface LaneHealth { ok: boolean; detail: string }

/**
 * A lane that is up but cannot read this particular file (a corrupt docx, a
 * format it does not know). Not retried: the next lane gets its turn.
 */
export class LaneRefused extends Error {
  constructor(message: string) { super(message); this.name = 'LaneRefused'; }
}

/** Bytes to text. One per lane; `null` in `Lanes` means not configured. */
export interface Converter {
  extract(input: { bytes: Buffer; filename: string; mediaType: string }): Promise<{ text: string }>;
  health(): Promise<LaneHealth>;
}

/** Text to vectors. Declares its model so the worker can detect a change (§7). */
export interface Embedder {
  info(): Promise<{ model: string; dimensions: number }>;
  embed(texts: string[], mode: 'query' | 'passage'): Promise<number[][]>;
  health(): Promise<LaneHealth>;
}

export interface Lanes {
  document: Converter | null;
  vision: Converter | null;
  audio: Converter | null;
  embed: Embedder | null;
}

export const noLanes: Lanes = { document: null, vision: null, audio: null, embed: null };

export interface Clock { now(): Date }
export const systemClock: Clock = { now: () => new Date() };

export interface Deps {
  db: Db;
  blobs: BlobStore;
  lanes: Lanes;
  clock: Clock;
}

/** Who is acting. It only ever comes from a token or from the operator's CLI. */
export interface Actor {
  ownerId: string;
}
