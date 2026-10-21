import { describe, it, expect } from 'vitest';
import { mapPhase, type ChangedFile, type GatheredPr } from '../src/review/map.js';
import { reducePhase } from '../src/review/reduce.js';
import { filterFindings, buildPatchIndex } from '../src/review/filter.js';
import { buildReviewPayload } from '../src/github/review.js';
import { parseConfig } from '../src/config.js';
import type { CompleteRequest, CompleteResult, LLMProvider } from '../src/llm/provider.js';
import type { LLMFacade } from '../src/llm/registry.js';

/**
 * End-to-end pipeline test with a stub LLM.
 *
 * This is the closest thing to a fixture test we can run without network
 * access: it exercises map → reduce → filter → payload and asserts the
 * suggestion block lands on a line that is genuinely in the diff.
 */

const PATCH = `@@ -1,6 +1,7 @@
 import a from './a';
+import b from './b';
 
 function main() {
-  return a;
+  return a + b;
 }`;

/** A provider that returns canned, deterministic structured output. */
class StubProvider implements LLMProvider {
  readonly name = 'stub';
  supports(): boolean {
    return true;
  }
  async complete(req: CompleteRequest): Promise<CompleteResult> {
    // MAP schema has `summary`; REDUCE has `walkthrough`.
    if (req.schema && 'walkthrough' in (req.schema as any).properties) {
      return {
        text: '',
        parsed: {
          walkthrough: 'Adds a new dependency `b` and returns the sum.',
          file_summaries: [{ file: 'src/a.ts', summary: 'Imports b and returns a + b.' }],
          // The reduce phase judges findings by id; it does not write them out.
          drop: [],
        },
        usage: { input: 10, output: 10 },
      };
    }
    return {
      text: '',
      parsed: {
        summary: 'Imports b and returns a + b.',
        findings: [
          {
            line: 5,
            start_line: null,
            severity: 'major',
            category: 'bug',
            title: 'B may be undefined',
            body: '`b` is imported but never validated.',
            suggestion: 'return a + (b ?? 0);',
            confidence: 0.92,
          },
          {
            line: 999, // out of hunk → must be filtered
            start_line: null,
            severity: 'info',
            category: 'docs',
            title: 'Ghost finding',
            body: 'Should be dropped.',
            suggestion: null,
            confidence: 0.99,
          },
          {
            line: 2,
            start_line: null,
            severity: 'minor',
            category: 'style',
            title: 'Low confidence nit',
            body: 'Should be dropped by threshold.',
            suggestion: null,
            confidence: 0.2,
          },
        ],
      },
      usage: { input: 20, output: 20 },
    };
  }
}

/** Minimal LLM facade matching the shape the pipeline expects. */
const stubLLM: LLMFacade = {
  async complete(model: string, req: any) {
    return new StubProvider().complete({ ...req, model });
  },
  // A hosted-model fan-out; `mapPhase` reads this to size its worker pool.
  concurrency: () => 6,
};

function makeGathered(): GatheredPr {
  const file: ChangedFile = {
    filename: 'src/a.ts',
    status: 'modified',
    patch: PATCH,
    changes: 3,
  };
  return {
    title: 'Add b',
    body: 'Adds b to the return value.',
    headSha: 'abcdef1234567890',
    baseSha: '1234567890abcdef',
    number: 7,
    files: [file],
    contexts: new Map(),
    skipped: [],
  };
}

describe('pipeline (map → reduce → filter → payload)', () => {
  it('produces an inline comment on a line that is in the diff', async () => {
    const gathered = makeGathered();
    const config = parseConfig('');

    const analyses = await mapPhase(stubLLM, 'stub/model', gathered, config);
    expect(analyses).toHaveLength(1);
    expect(analyses[0]?.findings.length).toBeGreaterThan(0);

    const reduced = await reducePhase(stubLLM, 'stub/model', {
      prTitle: gathered.title,
      prBody: gathered.body,
      analyses,
    });
    expect(reduced.walkthrough).toContain('Adds a new dependency');

    const parsedByFile = buildPatchIndex(gathered.files);
    const filtered = filterFindings(reduced.findings, {
      config,
      changedFiles: gathered.files,
      parsedByFile,
      allPrFiles: gathered.files.map((f) => f.filename),
    });

    // Ghost (line 999) and low-confidence style are gone; the real one stays.
    expect(filtered.findings).toHaveLength(1);
    expect(filtered.findings[0]?.line).toBe(5);

    const payload = buildReviewPayload({ ...reduced, findings: filtered.findings }, config, {
      headSha: gathered.headSha,
      skipped: gathered.skipped,
    });

    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0]?.path).toBe('src/a.ts');
    expect(payload.comments[0]?.line).toBe(5);
    expect(payload.comments[0]?.side).toBe('RIGHT');
    expect(payload.body).toContain('prsentinel:last-reviewed:abcdef1234567890');
    expect(payload.body).toContain('<details>');

    // The suggestion must be present and correctly fenced.
    const body = payload.comments[0]?.body ?? '';
    expect(body).toContain('```suggestion');
    expect(body).toContain('return a + (b ?? 0);');
  });

  it('is deterministic: two runs produce identical payloads', async () => {    const config = parseConfig('');
    const runOnce = async () => {
      const gathered = makeGathered();
      const analyses = await mapPhase(stubLLM, 'm', gathered, config);
      const reduced = await reducePhase(stubLLM, 'm', {
        prTitle: gathered.title,
        prBody: gathered.body,
        analyses,
      });
      const filtered = filterFindings(reduced.findings, {
        config,
        changedFiles: gathered.files,
        parsedByFile: buildPatchIndex(gathered.files),
        allPrFiles: gathered.files.map((f) => f.filename),
      });
      return buildReviewPayload({ ...reduced, findings: filtered.findings }, config, {
        headSha: gathered.headSha,
        skipped: [],
      });
    };
    expect(JSON.stringify(await runOnce())).toBe(JSON.stringify(await runOnce()));
  });
});

describe('reduce phase (judge by id, do not rewrite)', () => {
  const gathered = (): GatheredPr => ({
    title: 'Add b',
    body: '',
    headSha: 'abcdef1234567890',
    baseSha: '1234567890abcdef',
    number: 7,
    files: [{ filename: 'src/a.ts', status: 'modified', patch: PATCH, changes: 3 }],
    contexts: new Map(),
    skipped: [],
  });

  /** A facade whose reduce answer is fixed, whatever it is asked for. */
  function llmReturning(reduce: unknown): LLMFacade {
    return {
      async complete(_model: string, req: any) {
        if (req.schema && 'walkthrough' in (req.schema as any).properties) {
          return { text: '', parsed: reduce, usage: { input: 1, output: 1 } };
        }
        return new StubProvider().complete({ ...req, model: 'stub' });
      },
      concurrency: () => 1,
    };
  }

  async function reduceWith(reduce: unknown) {
    const g = gathered();
    const config = parseConfig('');
    const analyses = await mapPhase(llmReturning(reduce), 'stub/model', g, config);
    return reducePhase(llmReturning(reduce), 'stub/model', {
      prTitle: g.title,
      prBody: g.body,
      analyses,
    });
  }

  it('drops the findings the model names by id', async () => {
    const reduced = await reduceWith({
      walkthrough: 'A walkthrough.',
      file_summaries: [],
      drop: ['F2'],
    });
    // The map phase produced three findings; the model dropped the second.
    expect(reduced.findings).toHaveLength(2);
    expect(reduced.findings.map((f) => f.title)).not.toContain('Ghost finding');
    expect(reduced.findings[0]?.title).toBe('B may be undefined');
  });

  it('keeps every finding when the model names none', async () => {
    const reduced = await reduceWith({
      walkthrough: 'A walkthrough.',
      file_summaries: [],
      drop: [],
    });
    expect(reduced.findings).toHaveLength(3);
  });

  it('ignores ids that do not exist', async () => {
    const reduced = await reduceWith({
      walkthrough: 'A walkthrough.',
      file_summaries: [],
      drop: ['F99', 'not-an-id'],
    });
    expect(reduced.findings).toHaveLength(3);
  });

  it('keeps the findings when the response was cut off before the drop list', async () => {
    // A truncated answer must not silently delete a real finding.
    const reduced = await reduceWith({
      walkthrough: 'A walkthrough that stops mid',
      file_summaries: [],
    });
    expect(reduced.findings).toHaveLength(3);
  });
});
