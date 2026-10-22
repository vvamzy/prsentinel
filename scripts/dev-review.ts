#!/usr/bin/env tsx
/**
 * Offline review harness for contributors.
 *
 * Runs the full pipeline (select → map → reduce → filter → payload) against a
 * saved PR fixture, or against a live pull request, with no GitHub API calls
 * unless you ask for one.
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
 * same PR can be re-run for free afterwards — which is also the first step
 * towards adding it to `evals/`.
 *
 * `--stub` uses a deterministic heuristic reviewer that flags TODO/FIXME and
 * stray console.log calls. That is enough to exercise filtering, line mapping,
 * and payload rendering — the parts most likely to break — for free.
 *
 * What this harness cannot tell you is whether the *suggestions are good*.
 * `scripts/eval.ts` is the one that scores that.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadConfig, parseConfig } from '../src/config.js';
import { buildPatchIndex } from '../src/review/filter.js';
import { isLocalModel, stopLocalServers } from '../src/llm/local.js';
import type { LLMFacade } from '../src/llm/registry.js';
import { fetchFixture, loadFixture, runFixture, stubLLM, type Fixture } from './lib/fixture-review.js';

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
    : loadFixture(resolve(fixturePath!));

  if (prRef && outPath) {
    writeFileSync(resolve(outPath), `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
    console.log(`Saved fixture to ${outPath}`);
  }

  const config = configPath
    ? parseConfig(readFileSync(resolve(configPath), 'utf8'))
    : loadConfig(process.cwd()).config;

  let llm: LLMFacade = stubLLM;
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

  const run = await runFixture(fixture, config, llm, model);

  console.log(`Source:  ${prRef ?? fixturePath}`);
  console.log(`Files:   ${run.allFiles.length} total, ${run.selected.length} selected, ${run.skipped.length} skipped`);
  for (const s of run.skipped) console.log(`         skip ${s.file} (${s.reason})`);
  console.log(`Model:   ${model}${useStub ? ' (stub, offline)' : ''}\n`);

  console.log('--- MAP ---');
  for (const a of run.analyses) {
    console.log(`  ${a.file}: ${a.findings.length} finding(s) — ${a.summary || '(no summary)'}`);
  }

  console.log(`\n--- REDUCE ---\n  ${run.reduced.findings.length} finding(s) after reduce`);

  const stats = run.filtered.stats;
  console.log('\n--- FILTER ---');
  console.log(`  before: ${stats.before}  after: ${stats.after}`);
  console.log(
    `  dropped: confidence=${stats.droppedConfidence} ` +
      `out-of-hunk=${stats.droppedOutOfHunk} ` +
      `filtered-path=${stats.droppedFilteredPath} ` +
      `duplicate=${stats.droppedDuplicate} ` +
      `cap=${stats.droppedCap} style=${stats.suppressedStyle} ` +
      `prose-suggestion=${stats.strippedProseSuggestion}`,
  );

  console.log('\n--- PAYLOAD (would be posted) ---');
  console.log(JSON.stringify(run.payload, null, 2));

  // Sanity check: every comment must land on a line present in the diff.
  const index = buildPatchIndex(run.selected);
  let bad = 0;
  for (const c of run.payload.comments) {
    const parsed = index.get(c.path);
    if (!parsed || !parsed.attachableNewLines.has(c.line)) {
      console.error(`  ✖ comment on ${c.path}:${c.line} is NOT in the diff`);
      bad++;
    }
  }
  if (bad === 0) {
    console.log(`\n✓ All ${run.payload.comments.length} comment(s) anchored to real diff lines.`);
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
