import { isPathFiltered, type Config } from '../config.js';
import { isGeneratedFile } from './filter.js';
import type { ChangedFile } from './map.js';

/**
 * Pre-flight file selection.
 *
 * Runs BEFORE any LLM call so that skipped files never cost a token. This is
 * the first line of defence for the token budget; the filter phase is the
 * second.
 *
 * Kept in its own module (rather than in index.ts) so tests and the offline
 * dev harness can use it without triggering the Action entry point.
 */

export interface SkippedFile {
  file: string;
  reason: string;
}

export function selectFiles(
  files: ChangedFile[],
  config: Config,
): { selected: ChangedFile[]; skipped: SkippedFile[] } {
  const skipped: SkippedFile[] = [];
  const selected: ChangedFile[] = [];
  let totalDiffBytes = 0;

  for (const f of files) {
    if (selected.length >= config.reviews.max_files) {
      skipped.push({ file: f.filename, reason: 'max_files cap reached' });
      continue;
    }
    if (isGeneratedFile(f.filename)) {
      skipped.push({ file: f.filename, reason: 'generated or lockfile' });
      continue;
    }
    if (isPathFiltered(config.reviews.path_filters, f.filename)) {
      skipped.push({ file: f.filename, reason: 'path filter' });
      continue;
    }
    if (f.patch === null && f.changes > 0) {
      // GitHub omits the patch when a file is too large or binary.
      skipped.push({ file: f.filename, reason: 'patch unavailable (too large or binary)' });
      continue;
    }
    const size = f.patch?.length ?? 0;
    if (size > config.reviews.max_total_diff_bytes) {
      skipped.push({ file: f.filename, reason: 'single file exceeds diff size cap' });
      continue;
    }
    if (totalDiffBytes + size > config.reviews.max_total_diff_bytes) {
      skipped.push({ file: f.filename, reason: 'total diff size cap reached' });
      continue;
    }
    totalDiffBytes += size;
    selected.push(f);
  }

  return { selected, skipped };
}
