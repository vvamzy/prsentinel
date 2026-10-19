import { parsePatch } from '../github/diff.js';

/**
 * Chunking for very large files.
 *
 * GitHub truncates the `patch` field for big files, and even when it doesn't,
 * a 3000-line diff degrades model quality. We split oversized patches at hunk
 * boundaries so each chunk is an independent, line-accurate review unit.
 *
 * Chunk boundaries are always hunk boundaries, so line numbers stay correct
 * without any offset math — the single most common source of bugs in tools
 * that try to chunk diffs.
 */

export interface PatchChunk {
  /** Annotated text the model sees. */
  text: string;
  /** New-file line range covered, inclusive. */
  minLine: number;
  maxLine: number;
}

/** Approximate chars-per-token, used for budgeting. */
const CHARS_PER_TOKEN = 4;

/**
 * Split a patch into chunks whose annotated text stays under
 * `maxChars`. Always returns at least one chunk when the patch parses.
 */
export function chunkPatch(patch: string, maxChars: number): PatchChunk[] {
  const parsed = parsePatch(patch);
  if (parsed.hunks.length === 0) return [];

  const chunks: PatchChunk[] = [];
  let currentLines: string[] = [];
  let currentMin = 0;
  let currentMax = 0;
  let currentSize = 0;

  const flush = () => {
    if (currentLines.length === 0) return;
    chunks.push({
      text: currentLines.join('\n'),
      minLine: currentMin,
      maxLine: currentMax,
    });
    currentLines = [];
    currentSize = 0;
  };

  for (const hunk of parsed.hunks) {
    const hunkLines: string[] = [hunk.header];
    let hunkMin = Number.POSITIVE_INFINITY;
    let hunkMax = 0;
    let hunkSize = hunk.header.length;

    for (const l of hunk.lines) {
      const num = l.newLine ?? l.oldLine ?? 0;
      const marker = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
      const row = `${String(num).padStart(5)} ${marker} ${l.content}`;
      hunkLines.push(row);
      hunkSize += row.length + 1;
      if (l.newLine !== undefined) {
        hunkMin = Math.min(hunkMin, l.newLine);
        hunkMax = Math.max(hunkMax, l.newLine);
      }
    }

    if (!Number.isFinite(hunkMin)) hunkMin = hunk.newStart;

    // If adding this hunk would blow the budget, flush first.
    if (currentLines.length > 0 && currentSize + hunkSize > maxChars) {
      flush();
    }

    if (currentLines.length === 0) {
      currentMin = hunkMin;
    }
    currentLines.push(...hunkLines);
    currentSize += hunkSize;
    currentMax = Math.max(currentMax, hunkMax);
  }

  flush();
  return chunks;
}

/** Budget helper: convert a max token count into a char budget. */
export function tokensToChars(tokens: number): number {
  return tokens * CHARS_PER_TOKEN;
}

/** Should this file be chunked at all? */
export function needsChunking(patch: string, maxChars: number): boolean {
  return patch.length > maxChars;
}
