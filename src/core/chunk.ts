/**
 * Paragraph-aware chunking. A chunk is what gets searched and what gets cited.
 * Sizes carried over from deiz-memory, where they were measured on real policies.
 */
export const TARGET_CHARS = 900;
const OVERLAP_CHARS = 150;
const MIN_CHARS = 40;

export function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= TARGET_CHARS) return [clean];

  const chunks: string[] = [];
  let current = '';
  const push = () => {
    const t = current.trim();
    if (t.length >= MIN_CHARS) chunks.push(t);
    else if (t && chunks.length) chunks[chunks.length - 1] += `\n\n${t}`;
    else if (t) chunks.push(t);
    current = '';
  };

  for (const p of clean.split(/\n\s*\n/)) {
    const paragraph = p.trim();
    if (!paragraph) continue;
    if (paragraph.length > TARGET_CHARS) {
      push();
      for (let i = 0; i < paragraph.length; i += TARGET_CHARS - OVERLAP_CHARS) {
        const piece = paragraph.slice(i, i + TARGET_CHARS).trim();
        if (piece.length >= MIN_CHARS || !chunks.length) chunks.push(piece);
        if (i + TARGET_CHARS >= paragraph.length) break;
      }
      continue;
    }
    if (current.length + paragraph.length + 2 > TARGET_CHARS) push();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  push();
  return chunks;
}
