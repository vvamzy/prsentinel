#!/usr/bin/env tsx
/**
 * Quality harness: run the real review pipeline over labelled diffs and score
 * what comes back.
 *
 * `dev-review.ts` answers "what would the bot post on this PR?". This answers
 * "is what it posts *correct*?" — precision (how much of a review is true),
 * recall (how many real issues it finds), and anchoring (whether the comments
 * land on lines GitHub will accept).
 *
 * Usage:
 *   npx tsx scripts/eval.ts --stub                    # harness self-check, offline
 *   LLM_API_KEY=sk-... npx tsx scripts/eval.ts        # the cloud model you ship
 *   LLM_MODEL=local/qwen2.5-coder-7b-instruct npx tsx scripts/eval.ts
 *   npx tsx scripts/eval.ts --only clean-refactor --markdown
 *
 * A case is a JSON file in `evals/` holding a saved PR fixture and a list of
 * expectations. Expectations are written by a human who read the diff; see
 * CONTRIBUTING.md for how to add one.
 *
 * Two things are scored, and they are deliberately separate:
 *
 *   precision / recall   — did the bot say true things, and find the real ones?
 *   anchoring            — would GitHub even accept the comment?
 *
 * A model whose comments are perfect but anchored one line off is worse than
 * useless: `pulls.createReview` rejects the whole review with a 422. So an
 * unanchored comment is always a failure, while the rate thresholds are opt-in.
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

import { configSchema, parseConfig, type Config } from '../src/config.js';
import { buildPatchIndex, isDocumentationFile, isProse } from '../src/review/filter.js';
import type { Finding, ReviewComment } from '../src/review/types.js';
import { isLocalModel, stopLocalServers } from '../src/llm/local.js';
import type { LLMFacade } from '../src/llm/registry.js';
import { loadFixture, runFixture, stubLLM, type Fixture } from './lib/fixture-review.js';
import {
  precision,
  recall,
  scoreFindings,
  sumScores,
  type EvalCase,
  type FixtureScore,
  type SuiteScore,
} from './lib/eval-score.js';

/** Flags that consume the following argument. */
const VALUE_FLAGS = new Set([
  '--model',
  '--config',
  '--only',
  '--json',
  '--markdown-file',
  '--min-precision',
  '--min-recall',
  '--fixtures',
]);

const BOOLEAN_FLAGS = new Set(['--stub', '--markdown', '--help']);

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Loading cases
// ---------------------------------------------------------------------------

function jsonFilesIn(dir: string): string[] {
  const full = resolve(dir);
  if (!statSync(full).isDirectory()) return [full];
  return readdirSync(full)
    .sort()
    .map((name) => join(full, name))
    .filter((p) => extname(p) === '.json' && statSync(p).isFile());
}

function loadCase(path: string): EvalCase {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as EvalCase;
  const where = relative(process.cwd(), path);

  if (!raw.name) throw new Error(`${where}: missing "name"`);
  if (!raw.fixture && !raw.pr) throw new Error(`${where}: needs "fixture" (path) or "pr" (inline)`);

  const ids = new Set<string>();
  for (const e of raw.expect ?? []) {
    if (!e.id) throw new Error(`${where}: expectation without an id`);
    if (ids.has(e.id)) throw new Error(`${where}: duplicate expectation id "${e.id}"`);
    ids.add(e.id);
    if (!e.path) throw new Error(`${where}: expectation "${e.id}" needs a path`);
    if (!e.match?.length && !e.match_any?.length) {
      throw new Error(
        `${where}: expectation "${e.id}" needs "match" or "match_any" — ` +
          'a path alone would match any comment on the file',
      );
    }
  }
  for (const a of raw.allow ?? []) {
    if (!a.path || (!a.match?.length && !a.match_any?.length)) {
      throw new Error(`${where}: an "allow" rule needs a path and match terms`);
    }
  }

  return raw;
}

function resolveFixture(c: EvalCase, casePath: string): Fixture {
  if (c.pr) return c.pr as Fixture;
  return loadFixture(resolve(dirname(casePath), c.fixture!));
}

/** The harness defaults are the library defaults: no repo policy leaks in. */
function baseConfig(): Config {
  return configSchema.parse({});
}

function mergeConfig(base: Config, overrides: Record<string, unknown> | undefined): Config {
  if (!overrides) return base;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const existing = (base as Record<string, unknown>)[key];
    merged[key] =
      value && typeof value === 'object' && !Array.isArray(value) &&
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as object), ...(value as object) }
        : value;
  }
  return configSchema.parse(merged);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function pct(x: number | null, digits = 0): string {
  return x === null ? '—' : `${(x * 100).toFixed(digits)}%`;
}

function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function table(rows: string[][], align: Array<'l' | 'r'>): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows
    .map((row) =>
      row
        .map((cell, i) => (align[i] === 'r' ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

const HEADER = ['case', 'exp', 'met', 'exact', 'cmts', 'tp', 'dup', 'fp', 'prec', 'recall', 'notes'];
const ALIGN: Array<'l' | 'r'> = ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'l'];

/** Filter counters that remove a finding entirely (unlike a stripped suggestion). */
const DROP_KEYS = [
  'droppedConfidence',
  'droppedOutOfHunk',
  'droppedFilteredPath',
  'droppedDuplicate',
  'droppedCap',
  'suppressedStyle',
] as const;

const DROP_LABELS: Record<(typeof DROP_KEYS)[number], string> = {
  droppedConfidence: 'below the confidence floor',
  droppedOutOfHunk: 'outside the diff',
  droppedFilteredPath: 'on a filtered path',
  droppedDuplicate: 'duplicate',
  droppedCap: 'over a cap',
  suppressedStyle: 'style, and the repo lints',
};

function caseRow(s: FixtureScore): string[] {
  const defects: string[] = [];
  if (s.unanchored > 0) defects.push(`${s.unanchored} unanchored!`);
  if (s.proseSuggestions > 0) defects.push(`${s.proseSuggestions} prose suggestion!`);
  return [
    s.name,
    String(s.expected),
    String(s.matched),
    String(s.anchored),
    String(s.findings),
    String(s.truePositives),
    String(s.duplicates),
    String(s.falsePositives),
    pct(precision(s)),
    pct(recall(s)),
    defects.join(', ') || 'ok',
  ];
}

function suiteRow(s: SuiteScore): string[] {
  return [
    'TOTAL',
    String(s.expected),
    String(s.matched),
    String(s.anchored),
    String(s.findings),
    String(s.truePositives),
    String(s.duplicates),
    String(s.falsePositives),
    pct(precision(s)),
    pct(recall(s)),
    '',
  ];
}

function printText(suite: SuiteScore): void {
  console.log('');
  console.log(table([HEADER, ...suite.cases.map(caseRow), suiteRow(suite)], ALIGN));
  console.log(
    `\n${suite.cases.length} case(s) · ${short(suite.inputTokens)} in / ${short(suite.outputTokens)} out tokens · ` +
      `${seconds(suite.durationMs)} wall clock`,
  );
  // The metric a reader actually feels. Precision can look respectable while a
  // comment still lands on a diff that needed no comment, which is the thing
  // that makes a reviewer tiresome.
  console.log(
    `  ${suite.cleanComments} comment(s) on ${suite.cleanCases} clean case(s)` +
      (suite.cleanComments === 0 ? ' — silence, as intended' : ''),
  );
  if (suite.allowed > 0) console.log(`  ${suite.allowed} comment(s) matched an explicit allow rule`);

  // Why raw findings did not become comments. "0 posted" on its own cannot
  // distinguish a silent model from an aggressive filter.
  const filtered: string[] = [];
  for (const s of suite.cases) {
    if (!s.filter || s.rawFindings === s.findings) continue;
    const reasons = DROP_KEYS.filter((k) => s.filter![k] > 0).map(
      (k) => `${s.filter![k]} ${DROP_LABELS[k]}`,
    );
    filtered.push(`  ${s.name}: ${s.rawFindings} raw → ${s.findings} posted (${reasons.join(', ')})`);
  }
  if (filtered.length > 0) console.log(`\nFiltered out:\n${filtered.join('\n')}`);

  const details: string[] = [];
  for (const s of suite.cases) {
    if (s.missed.length > 0) details.push(`  ${s.name}: missed ${s.missed.join(', ')}`);
    if (s.misanchored.length > 0) details.push(`  ${s.name}: off-anchor ${s.misanchored.join(', ')}`);
  }
  if (details.length > 0) console.log(`\n${details.join('\n')}`);

  // The most useful part of a failing run: exactly what it said that was wrong.
  const junk = suite.cases.filter((s) => s.falsePositiveDetails.length > 0);
  if (junk.length > 0) {
    console.log('\nFalse positives:');
    for (const s of junk) {
      console.log(`  ${s.name}:`);
      for (const f of s.falsePositiveDetails.slice(0, 8)) {
        console.log(`    ${f.file}:${f.line} — ${f.title}`);
      }
      if (s.falsePositiveDetails.length > 8) {
        console.log(`    …and ${s.falsePositiveDetails.length - 8} more`);
      }
    }
  }
}

function markdownTable(suite: SuiteScore, model: string): string {
  const rate = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
  const lines = [
    `**prsentinel eval — \`${model}\`**`,
    '',
    '| case | expected | met | exact | comments | true | dup | false | precision | recall |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...suite.cases.map(
      (s) =>
        `| ${s.name} | ${s.expected} | ${s.matched} | ${s.anchored} | ${s.findings} | ` +
        `${s.truePositives} | ${s.duplicates} | ${s.falsePositives} | ` +
        `${rate(precision(s))} | ${rate(recall(s))} |`,
    ),
    `| **total** | **${suite.expected}** | **${suite.matched}** | **${suite.anchored}** | ` +
      `**${suite.findings}** | **${suite.truePositives}** | **${suite.duplicates}** | ` +
      `**${suite.falsePositives}** | **${rate(precision(suite))}** | **${rate(recall(suite))}** |`,
    '',
    `<sub>${seconds(suite.durationMs)} wall clock · ${short(suite.inputTokens)} in / ` +
      `${short(suite.outputTokens)} out tokens · ` +
      `**${suite.cleanComments} comment(s) on ${suite.cleanCases} clean case(s)**</sub>`,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  for (const flag of args.filter((a) => a.startsWith('--'))) {
    if (!VALUE_FLAGS.has(flag) && !BOOLEAN_FLAGS.has(flag)) {
      console.error(`Unknown flag: ${flag}\nRun with --help for usage.`);
      process.exit(2);
    }
  }

  if (args.includes('--help')) {
    console.log(
      [
        'Usage: npx tsx scripts/eval.ts [case.json ...] [options]',
        '',
        'Options:',
        '  --stub                 deterministic offline model (harness self-check)',
        '  --model <id>           override LLM_MODEL / the default model',
        '  --config <path>        .prsentinel.yaml to use as the base config',
        '  --only <name>          run a single case',
        '  --fixtures <dir>       directory of cases (default: evals)',
        '  --json <path>          write the machine-readable report',
        '  --markdown             print a Markdown table (for $GITHUB_STEP_SUMMARY)',
        '  --markdown-file <path> append the Markdown table to a file',
        '  --min-precision <0..1> exit non-zero below this precision',
        '  --min-recall <0..1>    exit non-zero below this recall',
      ].join('\n'),
    );
    return;
  }

  const useStub = args.includes('--stub');
  const markdown = args.includes('--markdown');
  const only = argValue(args, '--only');
  const explicitPaths = positionalArgs(args);
  const fixturesDir = argValue(args, '--fixtures') ?? 'evals';
  const configPath = argValue(args, '--config');
  const jsonOut = argValue(args, '--json');
  const markdownFile = argValue(args, '--markdown-file');
  const minPrecision = argValue(args, '--min-precision');
  const minRecall = argValue(args, '--min-recall');

  // ---- cases ----
  const files = explicitPaths.length > 0 ? explicitPaths.map((p) => resolve(p)) : jsonFilesIn(fixturesDir);
  let cases = files.map((p) => ({ path: p, case: loadCase(p) }));
  if (only) {
    cases = cases.filter((c) => c.case.name === only);
    if (cases.length === 0) {
      console.error(`No case named "${only}".`);
      process.exit(2);
    }
  }
  if (cases.length === 0) {
    console.error(`No eval cases found in ${resolve(fixturesDir)}.`);
    process.exit(2);
  }

  // ---- model ----
  const model = useStub
    ? 'stub'
    : argValue(args, '--model') || process.env.LLM_MODEL || 'openai/gpt-4o-mini';
  let llm: LLMFacade = stubLLM;
  if (!useStub) {
    if (isLocalModel(model)) {
      const { ensureLocalServer } = await import('../src/llm/local.js');
      const server = await ensureLocalServer(model, {
        cacheDir: resolve(process.cwd(), '.prsentinel/models'),
      });
      const { LLM } = await import('../src/llm/registry.js');
      llm = new LLM({ apiKey: 'local', baseUrl: server.baseUrl });
      console.log(`Local model: ${server.baseUrl}`);
    } else {
      const key = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY;
      if (!key) {
        console.error('No LLM_API_KEY set. Re-run with --stub for an offline self-check.');
        process.exit(2);
      }
      const { LLM } = await import('../src/llm/registry.js');
      llm = new LLM({
        apiKey: key,
        ...(process.env.LLM_BASE_URL ? { baseUrl: process.env.LLM_BASE_URL } : {}),
      });
    }
  }

  const base = configPath ? parseConfig(readFileSync(resolve(configPath), 'utf8')) : baseConfig();

  // ---- run ----
  const scores: FixtureScore[] = [];
  for (const { path, case: c } of cases) {
    const fixture = resolveFixture(c, path);
    const config = mergeConfig(base, c.config);
    console.log(`▸ ${c.name} — ${fixture.files.length} file(s) · ${fixture.title}`);
    const started = Date.now();
    try {
      const run = await runFixture(fixture, config, llm, model);
      const elapsed = Date.now() - started;

      const index = buildPatchIndex(run.selected);
      const isAnchored = (comment: ReviewComment): boolean => {
        const parsed = index.get(comment.path);
        return Boolean(parsed && parsed.attachableNewLines.has(comment.line));
      };

      const proseSuggestions = run.filtered.findings.filter(
        (f: Finding) => f.suggestion !== undefined && !isDocumentationFile(f.file) && isProse(f.suggestion),
      ).length;

      const usage = run.analyses.reduce(
        (acc, a) => ({ input: acc.input + a.usage.input, output: acc.output + a.usage.output }),
        { input: 0, output: 0 },
      );

      const score = scoreFindings({
        name: c.name,
        expectations: c.expect ?? [],
        allow: c.allow ?? [],
        findings: run.filtered.findings,
        rawFindings: run.reduced.findings.length,
        comments: run.payload.comments,
        isAnchored,
        proseSuggestions,
        filter: run.filtered.stats,
        durationMs: elapsed,
        inputTokens: usage.input + run.reduced.usage.input,
        outputTokens: usage.output + run.reduced.usage.output,
      });
      scores.push(score);

      console.log(
        `  ${score.rawFindings} raw → ${score.findings} posted · ` +
          `${score.matched}/${score.expected} met · prec ${pct(precision(score))} · ` +
          `recall ${pct(recall(score))} · ${seconds(elapsed)}`,
      );
      if (score.missed.length > 0) console.log(`  missed: ${score.missed.join(', ')}`);
      if (score.misanchored.length > 0) console.log(`  off-anchor: ${score.misanchored.join(', ')}`);
    } catch (err) {
      console.error(`  ✖ ${c.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  }

  const suite = sumScores(scores);

  if (markdown) console.log(markdownTable(suite, model));
  else printText(suite);

  if (markdownFile) {
    appendFileSync(resolve(markdownFile), `\n${markdownTable(suite, model)}\n`, 'utf8');
  }

  if (jsonOut) {
    const full = resolve(jsonOut);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(
      full,
      `${JSON.stringify({ model, stub: useStub, generatedAt: new Date().toISOString(), suite }, null, 2)}\n`,
      'utf8',
    );
    console.error(`\nReport written to ${full}`);
  }

  // A comment GitHub cannot anchor breaks the whole review, so it is never
  // acceptable, however creative the model. Precision and recall are gated only
  // when asked: they are stochastic, and a threshold is a policy choice.
  if (suite.unanchored > 0) {
    console.error(`\n✖ ${suite.unanchored} comment(s) are not anchored to a diff line.`);
    process.exitCode = 1;
  }
  if (minPrecision !== undefined) {
    const p = precision(suite);
    if (p === null || p < Number(minPrecision)) {
      console.error(`\n✖ precision ${pct(p)} is below --min-precision ${pct(Number(minPrecision))}`);
      process.exitCode = 1;
    }
  }
  if (minRecall !== undefined) {
    const r = recall(suite);
    if (r === null || r < Number(minRecall)) {
      console.error(`\n✖ recall ${pct(r)} is below --min-recall ${pct(Number(minRecall))}`);
      process.exitCode = 1;
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopLocalServers();
  });
