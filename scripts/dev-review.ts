#!/usr/bin/env tsx
/**
 * Offline review harness for contributors.
 *
 * Runs the full pipeline (map → reduce → filter → payload) against a saved PR
 * fixture, or against a live pull request, with no GitHub API calls unless you
 * ask for one.
 *
 * Usage:
 *   npx tsx scripts/dev-review.ts fixtures/sample-pr.json --stub
 *   LLM_API_KEY=sk-... npx tsx scripts/dev-review.ts fixtures/sample-pr.json
 *   LLM_MODEL=local/qwen2.5-coder-7b-instruct npx tsx scripts/dev-review.ts \
 *       fixtures/sample-pr.json
 *   GITHUB_TOKEN=ghp_... LLM_API_KEY=sk-... npx tsx scripts/dev-review.ts \
 *       --pr acme/widgets#42 --out fixtures/pr-42.json
 *
 * `LLM_MODEL` overrides `.prsentinel.yaml` — the environment wins here, because
 * the harness is how you ask "how would model X review this?" and a config
 * that pins a cloud model would make the question unanswerable.
 *
 * `--pr` fetches a real pull request (patch only — no checkout, so this is the
 * same read-as-data path the Action uses). `--out` saves it as a fixture so the
 * same PR can be re-run for free afterwards.
 *
 * `--stub` uses a deterministic heuristic reviewer that flags TODO/FIXME and
 * stray console.log calls. That is enough to exercise filtering, line mapping,
 * and payload rendering — the parts most likely to break — for free.
 *
 * What this harness cannot tell you is whether the *suggestions are good*.
 * Only a real model on real PRs can answer that.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadConfig, parseConfig } from '../src/config.js';
import { parsePrRef } from '../src/github/pr-ref.js';
import { mapPhase, type ChangedFile, type GatheredPr } from '../src/review/map.js';
import { reducePhase } from '../src/review/reduce.js';
import { buildPatchIndex, filterFindings } from '../src/review/filter.js';
import { selectFiles } from '../src/review/select.js';
import { buildReviewPayload } from '../src/github/review.js';
import { emptyUsage, type FileAnalysis, type Finding } from '../src/review/types.js';
import type { CompleteRequest, CompleteResult, LLMProvider } from '../src/llm/provider.js';
import { isLocalModel, stopLocalServers } from '../src/llm/local.js';
import type { LLMFacade } from '../src/llm/registry.js';

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

/** Flags that consume the following argument. */
const VALUE_FLAGS = new Set(['--config', '--pr', '--out']);

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

/** The first positional argument that is not a flag or a flag's value. */
function positionalArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.has(a)) i++; // skip the value it consumes
      continue;
    }
    return a;
  }
  return undefined;
}

/** Pull the parts of a PR we need, over the API, without checking anything out. */
async function fetchFixture(ref: string): Promise<Fixture> {
  const parsed = parsePrRef(ref);
  if (!parsed) {
    throw new Error(`Could not parse "${ref}". Use owner/repo#123 or a GitHub pull URL.`);
  }

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
  if (!token) {
    throw new Error('Fetching a live pull request needs GITHUB_TOKEN (or GH_TOKEN).');
  }

  const { GitHubClient } = await import('../src/github/client.js');
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
const stubLLM: LLMFacade = {
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fixturePath = positionalArg(args);
  const useStub = args.includes('--stub');
  const configPath = argValue(args, '--config');
  const prRef = argValue(args, '--pr');
  const outPath = argValue(args, '--out');

  if (!fixturePath && !prRef) {
    console.error(
      [
        'Usage: npx tsx scripts/dev-review.ts <fixture.json> [--stub] [--config path]',
        '       npx tsx scripts/dev-review.ts --pr owner/repo#123 [--out fixture.json]',
      ].join('\n'),
    );
    process.exit(2);
  }

  const fixture: Fixture = prRef
    ? await fetchFixture(prRef)
    : (JSON.parse(readFileSync(resolve(fixturePath!), 'utf8')) as Fixture);

  if (prRef && outPath) {
    writeFileSync(resolve(outPath), `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
    console.log(`Saved fixture to ${outPath}`);
  }

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
    // The environment wins over the repository's own config. The harness is
    // how you ask "how would model X review this?", and a config that pins a
    // cloud model — as this repository's does — would otherwise make the
    // question unanswerable.
    model = process.env.LLM_MODEL || config.models.review || 'openai/gpt-4o-mini';

    if (isLocalModel(model)) {
      // A bundled model needs no key, but it does need llama-server on PATH
      // (or $PRSENTINEL_LLAMA_SERVER) and somewhere to keep the weights.
      const { ensureLocalServer } = await import('../src/llm/local.js');
      const server = await ensureLocalServer(model, {
        cacheDir: resolve(process.cwd(), '.prsentinel/models'),
      });
      const { LLM } = await import('../src/llm/registry.js');
      llm = new LLM({ apiKey: 'local', baseUrl: server.baseUrl });
      console.log(`Local model: ${server.baseUrl} (weights in ${resolve(process.cwd(), '.prsentinel/models')})`);
    } else {
      const key = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY;
      if (!key) {
        console.error('No LLM_API_KEY set. Re-run with --stub for an offline run.');
        process.exitCode = 2;
        return;
      }
      const { LLM } = await import('../src/llm/registry.js');
      llm = new LLM({
        apiKey: key,
        ...(process.env.LLM_BASE_URL ? { baseUrl: process.env.LLM_BASE_URL } : {}),
      });
    }
  }

  console.log(`Source:  ${prRef ?? fixturePath}`);
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
    `cap=${filtered.stats.droppedCap} style=${filtered.stats.suppressedStyle} ` +
    `prose-suggestion=${filtered.stats.strippedProseSuggestion}`);

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
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // A bundled model runs as a child process holding gigabytes of weights.
    await stopLocalServers();
  });
