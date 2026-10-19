import type { GitHubClient } from './client.js';
import type { ChangedFile, FileContext } from '../review/map.js';
import { contextLinesForEffort, type Config } from '../config.js';
import { log } from '../log.js';

/**
 * Context gathering.
 *
 * For each changed file we decide whether to fetch its full head content.
 * Fetching every file is expensive and often pointless — lockfiles and
 * generated code are pure noise. We only fetch content for files that are
 * (a) not generated, (b) within the byte cap, and (c) small enough to be
 * useful to the model.
 */

export interface GatherOptions {
  config: Config;
  /** Filenames we already know are generated/filtered, skip fetching these. */
  skipFiles: Set<string>;
  /** Global byte budget across all fetched context. */
  totalBudget: number;
  /** Per-file byte cap. */
  perFileCap: number;
  signal?: AbortSignal;
}

/**
 * Fetch head-version content for the changed files that matter, staying
 * inside the byte budget. Returns a map of filename → context.
 */
export async function gatherContexts(
  client: GitHubClient,
  headSha: string,
  files: ChangedFile[],
  opts: GatherOptions,
): Promise<{ contexts: Map<string, FileContext>; bytesUsed: number; skipped: Array<{ file: string; reason: string }> }> {
  const contexts = new Map<string, FileContext>();
  const skipped: Array<{ file: string; reason: string }> = [];
  let bytesUsed = 0;

  for (const f of files) {
    if (opts.signal?.aborted) break;
    if (opts.skipFiles.has(f.filename)) {
      skipped.push({ file: f.filename, reason: 'filtered or generated' });
      continue;
    }
    // Removed files have no head content to fetch.
    if (f.status === 'removed') continue;
    // If the patch was included, the model already sees the change; only
    // fetch full content when the patch was truncated or the file is large.
    if (f.patch && f.changes <= 200) continue;

    if (bytesUsed >= opts.totalBudget) {
      skipped.push({ file: f.filename, reason: 'context byte budget exhausted' });
      continue;
    }

    const res = await client.getFileContent(f.filename, headSha);
    if (!res) {
      skipped.push({ file: f.filename, reason: 'content unavailable' });
      continue;
    }
    if (res.content.length > opts.perFileCap) {
      skipped.push({ file: f.filename, reason: 'file exceeds per-file cap' });
      continue;
    }

    bytesUsed += res.content.length;
    contexts.set(f.filename, {
      filename: f.filename,
      content: res.content,
      truncated: res.truncated,
    });
  }

  log.kv({ context_files: contexts.size, context_bytes: bytesUsed });
  return { contexts, bytesUsed, skipped };
}

/**
 * Slice a window of lines around the changed region. Used when we have full
 * file content and want to show the model its surroundings without sending
 * the entire file.
 */
export function windowAround(
  content: string,
  changedLines: number[],
  radius: number,
): { before: string; after: string } {
  if (changedLines.length === 0) return { before: '', after: '' };
  const lines = content.split('\n');
  const min = Math.min(...changedLines);
  const max = Math.max(...changedLines);
  const beforeStart = Math.max(0, min - 1 - radius);
  const afterEnd = Math.min(lines.length, max + radius);
  return {
    before: lines.slice(beforeStart, Math.max(beforeStart, min - 1)).join('\n'),
    after: lines.slice(max, afterEnd).join('\n'),
  };
}

export { contextLinesForEffort };
