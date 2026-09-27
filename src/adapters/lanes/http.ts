import type { Converter, Embedder, LaneHealth, Lanes } from '../../core/ports';
import type { Config } from '../../config';

async function call<T>(service: string, url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const msg = (e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message;
    throw new Error(`${service} at ${url}: ${msg}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${service} answered ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
  }
  return (await res.json()) as T;
}

const health = (service: string, base: string) => async (): Promise<LaneHealth> => {
  await call(service, `${base}/health`, {}, 3_000);
  return { ok: true, detail: base };
};

/**
 * A text lane speaking the sidecar contract: POST multipart `file` to /convert,
 * get `{ text }` back. markitdown, OCR and Whisper all answer the same shape.
 */
export function httpConverter(service: string, base: string, timeoutMs: number): Converter {
  return {
    async extract({ bytes, filename, mediaType }) {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(bytes)], { type: mediaType }), filename);
      const r = await call<{ text: string }>(service, `${base}/convert`, { method: 'POST', body: form }, timeoutMs);
      return { text: r.text ?? '' };
    },
    health: health(service, base),
  };
}

/** The embeddings lane: GET /info, POST /embed { texts, mode } → { vectors }. */
export function httpEmbedder(base: string): Embedder {
  return {
    info: () => call('embed', `${base}/info`, {}, 5_000),
    async embed(texts, mode) {
      const r = await call<{ vectors: number[][] }>('embed', `${base}/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ texts, mode }),
      }, 120_000);
      return r.vectors;
    },
    health: health('embed', base),
  };
}

export function lanesFromConfig(cfg: Config): Lanes {
  return {
    document: cfg.documentUrl ? httpConverter('documents', cfg.documentUrl, 120_000) : null,
    vision: cfg.visionUrl ? httpConverter('ocr', cfg.visionUrl, 300_000) : null,
    audio: cfg.audioUrl ? httpConverter('whisper', cfg.audioUrl, 600_000) : null,
    embed: cfg.embedUrl ? httpEmbedder(cfg.embedUrl) : null,
  };
}
