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
  maxUploadBytes: number;
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
    maxUploadBytes: Number(env.DM_MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024),
  };
}
