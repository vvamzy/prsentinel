#!/usr/bin/env tsx
/**
 * Offline review harness for contributors.
 *
 * Runs the full pipeline (map → reduce → filter → payload) against a saved PR
 * fixture, with no GitHub API calls and no network unless you pass a real key.
 *
 * Usage:
 *   npx tsx scripts/dev-review.ts fixtures/sample-pr.json --stub
 *   LLM_API_KEY=sk-... npx tsx scripts/dev-review.ts fixtures/sample-pr.json
 *
 * `--stub` uses a deterministic heuristic reviewer that flags TODO/FIXME and
 * stray console.log calls. That is enough to exercise filtering, line mapping,
 * and payload rendering — the parts most likely to break — for free.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadConfig, parseConfig } from '../src/config.js';
import { mapPhase, type ChangedFile, type GatheredPr } from '../src/review/map.js';
import { reducePhase } from '../src/review/reduce.js';
import { buildPatchIndex, filterFindings } from '../src/review/filter.js';
import { selectFiles } from '../src/review/select.js';
import { buildReviewPayload } from '../src/github/review.js';
import { emptyUsage, type FileAnalysis, type Finding } from '../src/review/types.js';
import type { CompleteRequest, CompleteResult, LLMProvider } from '../src/llm/provider.js';

interface Fixture {
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

/** Deterministic fake reviewer: flags markers we can grep for. */
class StubProvider implements LLMProvider {
  readonly name = 'stub';
  supports(): boolean {
    return true;
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const isReduce = req.schema && 'walkthrough' in (req.schema as any).properties;
    if (isReduce) {
      // Pass through: reduce is exercised but does no useful work in stub mode.
      const userText = req.messages.find((m) => m.role === 'user')?.content ?? '';
      const findings = extractFindingsFromPrompt(userText);
      return {
        text: '',
        parsed: {
          walkthrough: `_Stub review._ Detected ${findings.length} candidate finding(s).`,
          file_summaries: [],
          findings,
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
const stubLLM = {
  complete: (_model: string, req: Omit<CompleteRequest, 'model'>) =>
    new StubProvider().complete({ ...req, model: 'stub' }),
} as any;

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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fixturePath = args.find((a) => !a.startsWith('--'));
  const useStub = args.includes('--stub');
  const configIdx = args.indexOf('--config');
  const configPath = configIdx !== -1 ? args[configIdx + 1] : undefined;

  if (!fixturePath) {
    console.error('Usage: npx tsx scripts/dev-review.ts <fixture.json> [--stub] [--config path]');
    process.exit(2);
  }

  const fixture = JSON.parse(readFileSync(resolve(fixturePath), 'utf8')) as Fixture;

  const config = configPath
    ? parseConfig(readFileSync(resolve(configPath), 'utf8'))
    : loadConfig(process.cwd()).config;

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

  let llm = stubLLM;
  let model = 'stub';
  if (!useStub) {
    const key = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY;
    if (!key) {
      console.error('No LLM_API_KEY set. Re-run with --stub for an offline run.');
      process.exit(2);
    }
    const { LLM } = await import('../src/llm/registry.js');
    llm = new LLM({ apiKey: key, ...(process.env.LLM_BASE_URL ? { baseUrl: process.env.LLM_BASE_URL } : {}) });
    model = config.models.review || process.env.LLM_MODEL || 'openai/gpt-4o-mini';
  }

  console.log(`Fixture: ${fixturePath}`);
  console.log(`Files:   ${allFiles.length} total, ${selected.length} selected, ${skipped.length} skipped`);
  for (const s of skipped) console.log(`         skip ${s.file} (${s.reason})`);
  console.log(`Model:   ${model}${useStub ? ' (stub, offline)' : ''}\n`);

  const analyses: FileAnalysis[] = await mapPhase(llm, model, gathered, config);
  console.log('--- MAP ---');
  for (const a of analyses) {
    console.log(`  ${a.file}: ${a.findings.length} finding(s) — ${a.summary || '(no summary)'}`);
  }

  const reduced = await reducePhase(llm, model, {
    prTitle: fixture.title,
    prBody: fixture.body,
    analyses,
  });
  console.log(`\n--- REDUCE ---\n  ${reduced.findings.length} finding(s) after reduce`);

  const filtered = filterFindings(reduced.findings, {
    config,
    changedFiles: selected,
    parsedByFile: buildPatchIndex(selected),
    allPrFiles: allFiles.map((f) => f.filename),
  });
  console.log('\n--- FILTER ---');
  console.log(`  before: ${filtered.stats.before}  after: ${filtered.stats.after}`);
  console.log(`  dropped: confidence=${filtered.stats.droppedConfidence} ` +
    `out-of-hunk=${filtered.stats.droppedOutOfHunk} ` +
    `filtered-path=${filtered.stats.droppedFilteredPath} ` +
    `duplicate=${filtered.stats.droppedDuplicate} ` +
    `cap=${filtered.stats.droppedCap} style=${filtered.stats.suppressedStyle}`);

  const payload = buildReviewPayload({ ...reduced, findings: filtered.findings }, config, {
    headSha: fixture.headSha,
    skipped: gathered.skipped,
  });

  console.log('\n--- PAYLOAD (would be posted) ---');
  console.log(JSON.stringify(payload, null, 2));

  // Sanity check: every comment must land on a line present in the diff.
  const index = buildPatchIndex(selected);
  let bad = 0;
  for (const c of payload.comments) {
    const parsed = index.get(c.path);
    if (!parsed || !parsed.attachableNewLines.has(c.line)) {
      console.error(`  ✖ comment on ${c.path}:${c.line} is NOT in the diff`);
      bad++;
    }
  }
  if (bad === 0) {
    console.log(`\n✓ All ${payload.comments.length} comment(s) anchored to real diff lines.`);
  } else {
    console.error(`\n✖ ${bad} comment(s) are not anchored to diff lines.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
