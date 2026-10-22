/**
 * Shared plumbing for the offline harnesses (`dev-review.ts`, `eval.ts`).
 *
 * Both tools need the same three things: a saved PR fixture, a deterministic
 * stand-in model, and a way to run the real pipeline (select → map → reduce →
 * filter → payload) without touching GitHub. Keeping that here means the
 * quality harness measures exactly the code path the Action runs, rather than
 * a lookalike that can drift.
 */

import { readFileSync } from 'node:fs';

import { parsePrRef } from '../../src/github/pr-ref.js';
import { buildReviewPayload } from '../../src/github/review.js';
import { mapPhase, type ChangedFile, type GatheredPr } from '../../src/review/map.js';
import { reducePhase } from '../../src/review/reduce.js';
import { buildPatchIndex, filterFindings, type FilterResult } from '../../src/review/filter.js';
import { selectFiles, type SkippedFile } from '../../src/review/select.js';
import {
  emptyUsage,
  type FileAnalysis,
  type Finding,
  type ReviewPayload,
  type ReviewPlan,
} from '../../src/review/types.js';
import type { Config } from '../../src/config.js';
import type { CompleteRequest, CompleteResult, LLMProvider } from '../../src/llm/provider.js';
import type { LLMFacade } from '../../src/llm/registry.js';

/** The on-disk shape of a saved pull request. */
export interface Fixture {
  title: string;
  body: string;
  number: number;
  headSha: string;
  baseSha: string;
  files: Array<{
    filename: string;
    status: ChangedFile['status'];
    changes: number;
    patch: string | null;
  }>;
}

export function loadFixture(path: string): Fixture {
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}

/** Pull the parts of a PR we need, over the API, without checking anything out. */
export async function fetchFixture(ref: string): Promise<Fixture> {
  const parsed = parsePrRef(ref);
  if (!parsed) {
    throw new Error(`Could not parse "${ref}". Use owner/repo#123 or a GitHub pull URL.`);
  }

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
  if (!token) {
    throw new Error('Fetching a live pull request needs GITHUB_TOKEN (or GH_TOKEN).');
  }

  const { GitHubClient } = await import('../../src/github/client.js');
  const client = new GitHubClient(token, parsed.owner, parsed.repo);

  const [pr, files] = await Promise.all([
    client.getPullRequest(parsed.number),
    client.getChangedFiles(parsed.number),
  ]);

  console.log(
    `Fetched ${parsed.owner}/${parsed.repo}#${parsed.number}: "${pr.title}" (${files.length} file(s))`,
  );

  return {
    title: pr.title,
    body: pr.body,
    number: pr.number,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    files: files.map((f) => ({
      filename: f.filename,
      status: f.status,
      changes: f.changes,
      patch: f.patch,
    })),
  };
}

/**
 * Deterministic fake reviewer: flags markers we can grep for.
 *
 * It exists to exercise filtering, line mapping, and payload rendering for
 * free. It is not a quality oracle — `eval.ts --stub` only proves that the
 * harness itself runs.
 */
class StubProvider implements LLMProvider {
  readonly name = 'stub';
  supports(): boolean {
    return true;
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const isReduce = req.schema && 'walkthrough' in (req.schema as any).properties;
    if (isReduce) {
      // Pass through: reduce is exercised but does no useful work in stub mode.
      // The reduce phase judges findings by id now, so the stub drops nothing.
      const userText = req.messages.find((m) => m.role === 'user')?.content ?? '';
      const findings = extractFindingsFromPrompt(userText);
      return {
        text: '',
        parsed: {
          walkthrough: `_Stub review._ Detected ${findings.length} candidate finding(s).`,
          file_summaries: [],
          drop: [],
        },
        usage: emptyUsage(),
      };
    }

    const userText = req.messages.find((m) => m.role === 'user')?.content ?? '';
    const fileMatch = /`([^`]+)`/.exec(userText);
    const file = fileMatch?.[1] ?? 'unknown';
    const findings = heuristicFindings(file, userText);
    return {
      text: '',
      parsed: {
        summary: `${findings.length} issue(s) detected by the stub reviewer.`,
        findings: findings.map((f) => ({ ...f, start_line: f.startLine ?? null })),
      },
      usage: emptyUsage(),
    };
  }
}

/** Adapter so the pipeline can call the stub through the `LLM` facade shape. */
export const stubLLM: LLMFacade = {
  complete: (_model: string, req: Omit<CompleteRequest, 'model'>) =>
    new StubProvider().complete({ ...req, model: 'stub' }),
  // The stub answers instantly, so it can take as many requests at once as the
  // pipeline wants to give it.
  concurrency: () => 6,
};

function heuristicFindings(file: string, annotated: string): Finding[] {
  const out: Finding[] = [];
  const lines = annotated.split('\n');
  for (const raw of lines) {
    // Annotation format: "  142 + content"
    const m = /^\s*(\d+)\s\+\s(.*)$/.exec(raw);
    if (!m) continue;
    const line = Number(m[1]);
    const content = m[2] ?? '';
    if (/TODO|FIXME/.test(content)) {
      out.push({
        file,
        line,
        severity: 'minor',
        category: 'maintainability',
        title: 'Unresolved TODO',
        body: 'This TODO should be tracked in an issue before merging.',
        confidence: 0.7,
      });
    } else if (/console\.log\(/.test(content)) {
      out.push({
        file,
        line,
        severity: 'minor',
        category: 'maintainability',
        title: 'Stray console.log',
        body: 'Remove debug logging before merging.',
        // Comment it out rather than deleting, so the suggestion block has
        // something visible to replace the line with.
        suggestion: `// ${content.trim()}`,
        confidence: 0.85,
      });
    }
  }
  return out;
}

function extractFindingsFromPrompt(userText: string): unknown[] {
  // In stub mode the reduce prompt contains the JSON we produced in map.
  const start = userText.indexOf('[');
  const end = userText.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    return JSON.parse(userText.slice(start, end + 1)) as unknown[];
  } catch {
    return [];
  }
}

/** Everything the pipeline produced for one fixture. */
export interface FixtureRun {
  allFiles: ChangedFile[];
  selected: ChangedFile[];
  skipped: SkippedFile[];
  analyses: FileAnalysis[];
  /** After reduce, before the deterministic filter. */
  reduced: ReviewPlan;
  filtered: FilterResult;
  payload: ReviewPayload;
}

/**
 * Run select → map → reduce → filter → payload against a fixture.
 *
 * No GitHub calls: context gathering is skipped, just as it is in the dev
 * harness. That is a real difference from production (the model sees the diff
 * without the surrounding file), but it is the same difference for every model
 * under test, so comparisons stay fair.
 */
export async function runFixture(
  fixture: Fixture,
  config: Config,
  llm: LLMFacade,
  model: string,
): Promise<FixtureRun> {
  const allFiles: ChangedFile[] = fixture.files.map((f) => ({
    filename: f.filename,
    status: f.status,
    patch: f.patch,
    changes: f.changes,
  }));

  // Apply the same pre-flight filtering the real Action does, so skipped
  // files never reach the model (or the token budget).
  const { selected, skipped } = selectFiles(allFiles, config);

  const gathered: GatheredPr = {
    title: fixture.title,
    body: fixture.body,
    headSha: fixture.headSha,
    baseSha: fixture.baseSha,
    number: fixture.number,
    files: selected,
    contexts: new Map(),
    skipped,
  };

  const analyses = await mapPhase(llm, model, gathered, config);
  const reduced = await reducePhase(llm, model, {
    prTitle: fixture.title,
    prBody: fixture.body,
    analyses,
  });

  const filtered = filterFindings(reduced.findings, {
    config,
    changedFiles: selected,
    parsedByFile: buildPatchIndex(selected),
    allPrFiles: allFiles.map((f) => f.filename),
  });

  const payload = buildReviewPayload({ ...reduced, findings: filtered.findings }, config, {
    headSha: fixture.headSha,
    skipped,
  });

  return { allFiles, selected, skipped, analyses, reduced, filtered, payload };
}
