/** Media type from magic bytes first, extension second. */

const EXT: Record<string, string> = {
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  json: 'application/json', html: 'text/html', htm: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', msg: 'application/vnd.ms-outlook',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  wav: 'audio/wav', webm: 'audio/webm',
};

export function detectMediaType(bytes: Buffer, filename?: string | null, claimed?: string | null): string {
  const h = bytes.subarray(0, 16);
  const ascii = h.toString('latin1');
  if (ascii.startsWith('%PDF')) return 'application/pdf';
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return 'image/jpeg';
  if (ascii.startsWith('\x89PNG')) return 'image/png';
  if (ascii.startsWith('OggS')) return 'audio/ogg';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  if (ascii.slice(4, 8) === 'ftyp') {
    const brand = ascii.slice(8, 12);
    if (/^(heic|heix|mif1|msf1|heif)$/.test(brand)) return 'image/heic';
    if (/^(M4A |mp42|isom|M4B )$/.test(brand)) return 'audio/mp4';
  }
  const ext = filename?.split('.').pop()?.toLowerCase();
  if (ext && EXT[ext]) return EXT[ext]!;
  if (claimed && claimed !== 'application/octet-stream') return claimed;
  return 'application/octet-stream';
}

export type LaneKind = 'inline' | 'document' | 'vision' | 'audio' | 'none';

/** Which lane reads a media type first (§8). */
export function laneFor(mediaType: string): LaneKind {
  if (/^text\/(plain|markdown|csv)$/.test(mediaType) || mediaType === 'application/json') return 'inline';
  if (mediaType.startsWith('image/')) return mediaType === 'image/tiff' ? 'none' : 'vision';
  if (mediaType.startsWith('audio/')) return 'audio';
  if (mediaType === 'application/octet-stream') return 'none';
  return 'document';
}
