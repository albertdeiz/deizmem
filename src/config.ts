import { isAbsolute } from 'node:path';

/** Everything the process reads from the environment, in one place. */
export interface Config {
  databaseUrl: string;
  blobRoot: string;
  migrationsDir: string;
  documentUrl: string | null;
  visionUrl: string | null;
  audioUrl: string | null;
  embedUrl: string | null;
  mcpHost: string;
  mcpPort: number;
  webHost: string;
  webPort: number;
  /** The built React bundle (npm run build:web). */
  webRoot: string;
  maxUploadBytes: number;
  /** Where memory_capture may read a `path` from. Empty: capture by path is off. */
  captureDirs: string[];
}

/** DM_CAPTURE_DIRS: absolute directories, colon-separated. A relative one is a mistake, and loud. */
function dirs(v: string | undefined): string[] {
  const list = (v ?? '').split(':').map((d) => d.trim()).filter(Boolean);
  const bad = list.filter((d) => !isAbsolute(d));
  if (bad.length) throw new Error(`DM_CAPTURE_DIRS must be absolute paths: ${bad.join(', ')}`);
  return list;
}

const opt = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    databaseUrl: env.DM_DATABASE_URL ?? 'postgres://deizmem:deizmem@127.0.0.1:5432/deizmem',
    blobRoot: env.DM_BLOB_ROOT ?? './data/blobs',
    migrationsDir: env.DM_MIGRATIONS_DIR ?? './migrations',
    documentUrl: opt(env.DM_DOCUMENT_URL),
    visionUrl: opt(env.DM_VISION_URL),
    audioUrl: opt(env.DM_AUDIO_URL),
    embedUrl: opt(env.DM_EMBED_URL),
    mcpHost: env.DM_MCP_HOST ?? '127.0.0.1',
    mcpPort: Number(env.DM_MCP_PORT ?? 4319),
    webHost: env.DM_WEB_HOST ?? '127.0.0.1',
    webPort: Number(env.DM_WEB_PORT ?? 4320),
    webRoot: env.DM_WEB_ROOT ?? './dist/web',
    maxUploadBytes: Number(env.DM_MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024),
    captureDirs: dirs(env.DM_CAPTURE_DIRS),
  };
}
