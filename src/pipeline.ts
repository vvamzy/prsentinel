import type { Config } from './config.js';
import type { GitHubClient } from './github/client.js';
import { gatherContexts } from './github/context.js';
import { buildReviewPayload } from './github/review.js';
import { parsePatch } from './github/diff.js';
import type { LLMFacade } from './llm/registry.js';
import { log } from './log.js';
import { mapPhase, type ChangedFile, type FileContext } from './review/map.js';
import { reducePhase } from './review/reduce.js';
import { buildPatchIndex, filterFindings } from './review/filter.js';
import { selectFiles, type SkippedFile } from './review/select.js';
import { findLastReviewedSha } from './state.js';
import { emptyUsage, type ReviewPayload, type ReviewPlan } from './review/types.js';

/**
 * The review pipeline, extracted from the Action entry point so it can be
 * driven by more than one trigger:
 *
 *   - the automatic `pull_request_target` review
 *   - the `/review` slash command
 *
 * Keeping it here (rather than in index.ts) also means tests and the offline
 * harness can exercise it without side effects.
 */

export interface ReviewOptions {
  client: GitHubClient;
  config: Config;
  llm: LLMFacade;
  model: string;
  prNumber: number;
  /**
   * Restrict the review to these paths. Used by `/review <path>` to re-review
   * a single file or directory.
   */
  scope?: string[];
  /**
   * Ignore the incremental marker and review everything. Used by
   * `/review all`.
   */
  full?: boolean;
  signal?: AbortSignal;
}

export interface ReviewOutcome {
  payload: ReviewPayload;
  plan: ReviewPlan;
  skipped: SkippedFile[];
  headSha: string;
  /** True when the incremental filter narrowed the file set. */
  incremental: boolean;
  pr: { number: number; title: string; body: string; draft: boolean; headSha: string; baseSha: string; headRef: string; baseRef: string; author: string };
}

/** Restrict changed files to an explicit path scope. */
export function applyScope(files: ChangedFile[], scope: string[] | undefined): ChangedFile[] {
  if (!scope || scope.length === 0) return files;
  const normalized = scope.map((s) => s.replace(/\\/g, '/').replace(/^\.\//, ''));
  return files.filter((f) => {
    const name = f.filename.replace(/\\/g, '/');
    return normalized.some((s) => name === s || name.startsWith(`${s.replace(/\/$/, '')}/`) || name.endsWith(`/${s}`));
  });
}

/** Restrict to files touched since a previous review SHA. */
export async function filesSinceSha(
  client: GitHubClient,
  files: ChangedFile[],
  sinceSha: string | null,
  headSha: string,
): Promise<ChangedFile[]> {
  if (!sinceSha || sinceSha === headSha) return files;
  try {
    const changedSince = new Set(await client.compareCommits(sinceSha, headSha));
    if (changedSince.size === 0) return [];
    return files.filter((f) => changedSince.has(f.filename));
  } catch (err) {
    log.warn(`incremental compare failed, falling back to full review: ${String(err)}`);
    return files;
  }
}

/**
 * Run gather → map → reduce → filter → payload.
 *
 * Does not post anything; the caller decides whether to submit a review or
 * write a dry-run file.
 */
export async function runReview(opts: ReviewOptions): Promise<ReviewOutcome> {
  const { client, config, llm, model, prNumber, signal } = opts;

  const pr = await client.getPullRequest(prNumber);
  log.kv({ pr: pr.number, title: pr.title, head: pr.headSha.slice(0, 7) });

  let changedFiles = await client.getChangedFiles(prNumber);
  let incremental = false;

  if (config.reviews.incremental && !opts.full) {
    const reviews = await client.listReviews(prNumber);
    const lastSha = findLastReviewedSha(reviews);
    if (lastSha && lastSha !== pr.headSha) {
      const before = changedFiles.length;
      changedFiles = await filesSinceSha(client, changedFiles, lastSha, pr.headSha);
      incremental = true;
      log.info(`Incremental: ${before} changed files → ${changedFiles.length} since last review`);
    }
  }

  if (opts.scope && opts.scope.length > 0) {
    const before = changedFiles.length;
    changedFiles = applyScope(changedFiles, opts.scope);
    log.info(`Scope: ${before} changed files → ${changedFiles.length} matching ${opts.scope.join(', ')}`);
  }

  const { selected, skipped } = selectFiles(changedFiles, config);
  log.kv({
    files_total: changedFiles.length,
    files_selected: selected.length,
    files_skipped: skipped.length,
  });

  if (selected.length === 0) {
    return {
      payload: {
        event: 'COMMENT',
        commit_id: pr.headSha,
        body: emptyReviewBody(opts.scope),
        comments: [],
      },
      plan: { walkthrough: '', findings: [], fileSummaries: [], usage: emptyUsage() },
      skipped,
      headSha: pr.headSha,
      incremental,
      pr,
    };
  }

  const skipSet = new Set(skipped.map((s) => s.file));
  const contexts: Map<string, FileContext> = (
    await gatherContexts(client, pr.headSha, selected, {
      config,
      skipFiles: skipSet,
      totalBudget: config.reviews.max_total_diff_bytes,
      perFileCap: config.reviews.max_file_bytes,
      ...(signal ? { signal } : {}),
    })
  ).contexts;

  // --- Map ---
  const gathered = {
    title: pr.title,
    body: pr.body,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    number: pr.number,
    files: selected,
    contexts,
    skipped,
  };

  const analyses = await mapPhase(llm, model, gathered, config, signal);
  const totalFindings = analyses.reduce((n, a) => n + a.findings.length, 0);
  log.info(`Map phase: ${analyses.length} files, ${totalFindings} raw findings`);

  // --- Reduce ---
  let plan: ReviewPlan;
  try {
    plan = await reducePhase(llm, model, { prTitle: pr.title, prBody: pr.body, analyses });
  } catch (err) {
    log.warn(`Reduce phase failed, using per-file summaries: ${String(err)}`);
    plan = {
      walkthrough: analyses
        .filter((a) => a.summary)
        .map((a) => `- \`${a.file}\` — ${a.summary}`)
        .join('\n'),
      findings: analyses.flatMap((a) => a.findings),
      fileSummaries: analyses
        .filter((a) => a.summary)
        .map((a) => ({ file: a.file, summary: a.summary })),
      usage: emptyUsage(),
    };
  }

  // --- Filter ---
  const parsedByFile = buildPatchIndex(selected);
  for (const f of selected) {
    if (!parsedByFile.has(f.filename) && f.patch) {
      try {
        parsedByFile.set(f.filename, parsePatch(f.patch));
      } catch {
        /* leave unindexed so findings on it are dropped safely */
      }
    }
  }

  const filtered = filterFindings(plan.findings, {
    config,
    changedFiles: selected,
    parsedByFile,
    allPrFiles: changedFiles.map((f) => f.filename),
  });
  log.kv({
    findings_before: filtered.stats.before,
    findings_after: filtered.stats.after,
    dropped_confidence: filtered.stats.droppedConfidence,
    dropped_out_of_hunk: filtered.stats.droppedOutOfHunk,
    dropped_duplicate: filtered.stats.droppedDuplicate,
    dropped_cap: filtered.stats.droppedCap,
    suppressed_style: filtered.stats.suppressedStyle,
    stripped_prose_suggestion: filtered.stats.strippedProseSuggestion,
  });

  const finalPlan: ReviewPlan = { ...plan, findings: filtered.findings };
  const payload = buildReviewPayload(finalPlan, config, { headSha: pr.headSha, skipped });

  return { payload, plan: finalPlan, skipped, headSha: pr.headSha, incremental, pr };
}

/** Body used when a scoped review matched nothing. */
export function emptyReviewBody(scope: string[] | undefined): string {
  if (scope && scope.length > 0) {
    return `No changed files matched \`${scope.join('`, `')}\`.`;
  }
  return 'No reviewable files were found after filtering.';
}
