import { CHUNK_MAX_CHARS, CHUNK_OVERLAP_CHARS } from "../config.ts";

// Char-based, boundary-aware chunker. Most memos fit in one chunk; long notes are split on
// paragraph/line/space boundaries near the limit, with overlap to preserve cross-boundary context.
export function chunkText(
  text: string,
  maxChars = CHUNK_MAX_CHARS,
  overlap = CHUNK_OVERLAP_CHARS,
): string[] {
  if (text.trim().length === 0) return [];
  if (text.length <= maxChars) return [text];

  // Clamp overlap so each window advances by at least half of maxChars, preventing
  // pathological quadratic re-chunking when a caller passes overlap close to maxChars.
  overlap = Math.min(overlap, Math.floor(maxChars / 2));

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const minBreak = Math.floor(maxChars / 2);
      const bp = lastBoundary(text.slice(start, end), minBreak);
      if (bp > 0) end = start + bp;
    }
    const piece = text.slice(start, end);
    if (piece.trim().length > 0) chunks.push(piece);
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

// Returns an index just past the best break separator at or after minIndex, or 0 if none found.
function lastBoundary(slice: string, minIndex: number): number {
  const para = slice.lastIndexOf("\n\n");
  if (para >= minIndex) return para + 2;
  const line = slice.lastIndexOf("\n");
  if (line >= minIndex) return line + 1;
  const space = slice.lastIndexOf(" ");
  if (space >= minIndex) return space + 1;
  return 0;
}
