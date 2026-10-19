import * as core from '@actions/core';
import * as github from '@actions/github';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { loadConfig, type Config } from './config.js';
import { log } from './log.js';
import { GitHubClient } from './github/client.js';
import { gatherContexts } from './github/context.js';
import { buildReviewPayload, serializePayload } from './github/review.js';
import { parsePatch } from './github/diff.js';
import { LLM } from './llm/registry.js';
import { mapPhase, type ChangedFile } from './review/map.js';
import { reducePhase } from './review/reduce.js';
import { buildPatchIndex, filterFindings } from './review/filter.js';
import { selectFiles } from './review/select.js';
import { findLastReviewedSha } from './state.js';
import type { ReviewPlan } from './review/types.js';
import { emptyUsage } from './review/types.js';

/**
 * prsentinel entry point.
 *
 * Flow: gather → map → reduce → filter → post.
 * Every stage is isolated so it can be unit-tested against fixtures.
 */

interface RunEnv {
  token: string;
  llmKey: string;
  llmBaseUrl: string | undefined;
  llmModel: string;
  prNumber: number;
  dryRun: boolean;
  repoRoot: string;
}

function readEnv(): RunEnv {
  const token = core.getInput('github-token') || process.env.GITHUB_TOKEN || '';
  const llmKey =
    core.getInput('llm-api-key') || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';
  const llmBaseUrl =
    core.getInput('llm-base-url') || process.env.LLM_BASE_URL || undefined;
  const llmModel =
    core.getInput('llm-model') || process.env.LLM_MODEL || 'openai/gpt-4o-mini';
  const dryRunRaw = (core.getInput('dry-run') || process.env.DRY_RUN || 'false').toLowerCase();
  const repoRoot = core.getInput('repo-root') || process.env.GITHUB_WORKSPACE || process.cwd();

  const prNumber =
    Number(core.getInput('pr-number')) ||
    contextPrNumber() ||
    0;

  return {
    token,
    llmKey,
    llmBaseUrl: llmBaseUrl || undefined,
    llmModel,
    prNumber,
    dryRun: dryRunRaw === 'true' || dryRunRaw === '1',
    repoRoot,
  };
}

/**
 * Best-effort PR number from the event payload.
 *
 * `github.context.repo`/`.issue` throw when GITHUB_REPOSITORY is unset, which
 * is exactly the case when a contributor runs this locally. Never let that
 * crash the run.
 */
function contextPrNumber(): number {
  try {
    const payload = github.context.payload as {
      pull_request?: { number?: number };
      issue?: { number?: number };
    };
    return payload?.pull_request?.number ?? payload?.issue?.number ?? 0;
  } catch {
    return 0;
  }
}

/** Decide which files survive config filters and hard caps. */

/**
 * Restrict to files touched since a previous review SHA (incremental mode).
 * Falls back to all files when the comparison can't be made.
 */
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

async function main(): Promise<void> {
  const env = readEnv();

  if (env.prNumber === 0) {
    log.info('No pull request context; nothing to do.');
    return;
  }
  if (env.token === '') {
    core.setFailed('A github-token is required.');
    return;
  }

  const { config, path: configPath } = loadConfig(env.repoRoot);
  log.info(`Config: ${configPath ?? 'defaults (no .prsentinel.yaml found)'}`);

  if (!config.reviews.enabled) {
    log.info('Reviews disabled in config; exiting.');
    return;
  }

  const client = new GitHubClient(env.token);
  const pr = await client.getPullRequest(env.prNumber);

  if (pr.draft && !config.reviews.drafts) {
    log.info('Draft PR and drafts are disabled in config; skipping.');
    return;
  }

  log.kv({ pr: pr.number, title: pr.title, head: pr.headSha.slice(0, 7) });

  // --- Gather ------------------------------------------------------------
  let changedFiles = await client.getChangedFiles(env.prNumber);

  if (config.reviews.incremental) {
    const reviews = await client.listReviews(env.prNumber);
    const lastSha = findLastReviewedSha(reviews);
    if (lastSha) {
      const before = changedFiles.length;
      changedFiles = await filesSinceSha(client, changedFiles, lastSha, pr.headSha);
      log.info(`Incremental: ${before} changed files → ${changedFiles.length} since last review`);
    }
  }

  const { selected, skipped } = selectFiles(changedFiles, config);
  log.kv({ files_total: changedFiles.length, files_selected: selected.length, files_skipped: skipped.length });

  if (selected.length === 0) {
    log.info('No reviewable files after filtering.');
    return;
  }

  const skipSet = new Set(skipped.map((s) => s.file));
  const { contexts } = await gatherContexts(client, pr.headSha, selected, {
    config,
    skipFiles: skipSet,
    totalBudget: config.reviews.max_total_diff_bytes,
    perFileCap: config.reviews.max_file_bytes,
  });

  // --- LLM setup ---------------------------------------------------------
  const model = config.models.review || env.llmModel;
  if (env.llmKey === '' && !env.dryRun) {
    core.setFailed('No LLM API key configured. Set llm-api-key input or LLM_API_KEY secret.');
    return;
  }
  const llm = new LLM({ apiKey: env.llmKey, ...(env.llmBaseUrl ? { baseUrl: env.llmBaseUrl } : {}) });

  // --- Map ---------------------------------------------------------------
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

  const analyses = await mapPhase(llm, model, gathered, config);
  const totalFindings = analyses.reduce((n, a) => n + a.findings.length, 0);
  log.info(`Map phase: ${analyses.length} files, ${totalFindings} raw findings`);

  // --- Reduce ------------------------------------------------------------
  let plan: ReviewPlan;
  try {
    plan = await reducePhase(llm, model, {
      prTitle: pr.title,
      prBody: pr.body,
      analyses,
    });
  } catch (err) {
    log.warn(`Reduce phase failed, using per-file summaries: ${String(err)}`);
    plan = {
      walkthrough: analyses
        .filter((a) => a.summary)
        .map((a) => `- \`${a.file}\` — ${a.summary}`)
        .join('\n'),
      findings: analyses.flatMap((a) => a.findings),
      fileSummaries: analyses.filter((a) => a.summary).map((a) => ({ file: a.file, summary: a.summary })),
      usage: emptyUsage(),
    };
  }

  // --- Filter ------------------------------------------------------------
  const parsedByFile = buildPatchIndex(selected);
  // Also index files whose patches we skipped but might have context.
  for (const f of selected) {
    if (!parsedByFile.has(f.filename) && f.patch) {
      try {
        parsedByFile.set(f.filename, parsePatch(f.patch));
      } catch {
        /* leave unindexed */
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
  });

  const finalPlan: ReviewPlan = { ...plan, findings: filtered.findings };

  // --- Emit --------------------------------------------------------------
  const payload = buildReviewPayload(finalPlan, config, {
    headSha: pr.headSha,
    skipped,
  });

  if (env.dryRun) {
    const outDir = join(env.repoRoot, 'out');
    mkdirSync(outDir, { recursive: true });
    const outFile = join(outDir, `review-${pr.number}-${pr.headSha.slice(0, 7)}.json`);
    writeFileSync(outFile, serializePayload(payload), 'utf8');
    log.notice(`Dry run: wrote ${outFile} (${payload.comments.length} comments, not posted)`);
    core.setOutput('payload-file', outFile);
    core.setOutput('comment-count', String(payload.comments.length));
    return;
  }

  if (payload.comments.length === 0 && finalPlan.walkthrough.trim() === '') {
    log.info('Nothing to post.');
    return;
  }

  const res = await client.createReview({
    number: pr.number,
    commitId: pr.headSha,
    body: payload.body,
    event: payload.event,
    comments: payload.comments,
  });
  log.notice(`Review posted: ${res.url} (${payload.comments.length} inline comments)`);
  core.setOutput('review-url', res.url);
  core.setOutput('comment-count', String(payload.comments.length));
  core.setOutput('finding-count', String(finalPlan.findings.length));
}

main().catch((err) => {
  core.setFailed(err instanceof Error ? err.stack ?? err.message : String(err));
});
