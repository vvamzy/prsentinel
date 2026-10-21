import { describe, it, expect, afterEach, vi } from 'vitest';
import { mapPhase, normalizeFindings, type GatheredPr } from '../src/review/map.js';
import { chunkPatch } from '../src/review/chunker.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { LLM } from '../src/llm/registry.js';

describe('normalizeFindings', () => {
  it('keeps a well-formed finding', () => {
    const out = normalizeFindings('a.ts', [
      { line: 10, start_line: 8, severity: 'major', category: 'bug', title: 'T', body: 'B', suggestion: 'x', confidence: 0.9 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ file: 'a.ts', line: 10, startLine: 8, severity: 'major', category: 'bug', suggestion: 'x', confidence: 0.9 });
  });

  it('coerces string line numbers', () => {
    const out = normalizeFindings('a.ts', [{ line: '12', severity: 'minor', category: 'test', title: 'T', body: 'B', confidence: 0.7 }]);
    expect(out[0]?.line).toBe(12);
  });

  it('drops findings with no valid line', () => {
    expect(normalizeFindings('a.ts', [{ line: 0, title: 'T', body: 'B' }])).toHaveLength(0);
    expect(normalizeFindings('a.ts', [{ title: 'T', body: 'B' }])).toHaveLength(0);
    expect(normalizeFindings('a.ts', [{ line: 'abc', title: 'T', body: 'B' }])).toHaveLength(0);
  });

  it('drops findings with no content', () => {
    expect(normalizeFindings('a.ts', [{ line: 3, title: '', body: '' }])).toHaveLength(0);
  });

  it('defaults unknown severity/category', () => {
    const out = normalizeFindings('a.ts', [{ line: 3, title: 'T', body: 'B' }]);
    expect(out[0]?.severity).toBe('info');
    expect(out[0]?.category).toBe('maintainability');
  });

  it('clamps confidence to 0..1', () => {
    const hi = normalizeFindings('a.ts', [{ line: 3, title: 'T', body: 'B', confidence: 5 }]);
    const lo = normalizeFindings('a.ts', [{ line: 3, title: 'T', body: 'B', confidence: -1 }]);
    const nan = normalizeFindings('a.ts', [{ line: 3, title: 'T', body: 'B', confidence: 'nope' }]);
    expect(hi[0]?.confidence).toBe(1);
    expect(lo[0]?.confidence).toBe(0);
    expect(nan[0]?.confidence).toBe(0.5);
  });

  it('ignores non-object entries', () => {
    expect(normalizeFindings('a.ts', [null, 'string', 42])).toHaveLength(0);
  });

  it('drops start_line >= line', () => {
    const out = normalizeFindings('a.ts', [{ line: 5, start_line: 9, title: 'T', body: 'B' }]);
    expect(out[0]?.startLine).toBeUndefined();
  });

  it('omits an empty suggestion', () => {
    const out = normalizeFindings('a.ts', [{ line: 5, title: 'T', body: 'B', suggestion: '  ' }]);
    expect(out[0]?.suggestion).toBeUndefined();
  });

  // A model asked for "no suggestion" answers with the string "null" as often
  // as with JSON null. Posting that would offer the reader a change that
  // replaces their line with the word null.
  it('treats a spelled-out absence as no suggestion', () => {
    for (const word of ['null', 'NULL', ' none ', 'undefined', 'n/a', '-']) {
      const out = normalizeFindings('a.ts', [{ line: 5, title: 'T', body: 'B', suggestion: word }]);
      expect(out[0]?.suggestion).toBeUndefined();
    }
  });

  it('keeps a suggestion that merely mentions null', () => {
    const out = normalizeFindings('a.ts', [
      { line: 5, title: 'T', body: 'B', suggestion: 'const value = null;' },
    ]);
    expect(out[0]?.suggestion).toBe('const value = null;');
  });
});

describe('chunkPatch', () => {
  const smallPatch = `@@ -1,3 +1,4 @@
 a
+added
 b
 c`;

  it('returns one chunk for a small patch', () => {
    const chunks = chunkPatch(smallPatch, 10_000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.minLine).toBeGreaterThan(0);
  });

  it('splits at hunk boundaries when over budget', () => {
    // Build a patch with several hunks far apart.
    const hunks = [1, 50, 100, 150].map(
      (start) => `@@ -${start},2 +${start},2 @@\n old${start}\n-new${start}\n+changed${start}`,
    );
    const patch = hunks.join('\n');
    // Tiny budget forces more than one chunk.
    const chunks = chunkPatch(patch, 120);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk's line range must be within the patch's overall range.
    for (const c of chunks) {
      expect(c.minLine).toBeGreaterThan(0);
      expect(c.maxLine).toBeGreaterThanOrEqual(c.minLine);
    }
  });

  it('never splits mid-hunk', () => {
    const hunks = [1, 50].map(
      (start) => `@@ -${start},2 +${start},2 @@\n old${start}\n-new${start}\n+changed${start}`,
    );
    const patch = hunks.join('\n');
    const chunks = chunkPatch(patch, 90);
    for (const c of chunks) {
      // A chunk containing a hunk must contain its whole header set.
      expect(c.text).toMatch(/^@@/);
    }
  });

  it('returns empty for an unparseable patch', () => {
    expect(chunkPatch('not a patch', 100)).toEqual([]);
  });
});

describe('mapPhase concurrency', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const gathered: GatheredPr = {
    title: 't',
    body: 'b',
    headSha: 'h',
    baseSha: 'b',
    number: 1,
    files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((filename) => ({
      filename,
      status: 'modified',
      patch: null,
      changes: 1,
    })),
    contexts: new Map(),
    skipped: [],
  };

  /** Answer every request, recording how many were in flight at once. */
  function stubCountingFetch(peak: { value: number }): void {
    let active = 0;
    vi.stubGlobal('fetch', async () => {
      active++;
      peak.value = Math.max(peak.value, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      const frame = `data: ${JSON.stringify({
        choices: [{ delta: { content: '{"summary":"s","findings":[]}' } }],
      })}\n\ndata: [DONE]\n\n`;
      return new Response(frame, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
  }

  it('runs one file at a time for a bundled local model', async () => {
    const peak = { value: 0 };
    stubCountingFetch(peak);

    const llm = new LLM({ apiKey: 'local', baseUrl: 'http://127.0.0.1:8080/v1' });
    const analyses = await mapPhase(llm, 'local/qwen2.5-coder-7b-instruct', gathered, DEFAULT_CONFIG);

    // A single-slot server gains nothing from a queue, and a queued request that
    // has sent no headers for 300 seconds is dropped by the client.
    expect(peak.value).toBe(1);
    expect(analyses).toHaveLength(4);
    expect(analyses[0]?.summary).toBe('s');
  });

  it('fans out to a hosted API', async () => {
    const peak = { value: 0 };
    stubCountingFetch(peak);

    const llm = new LLM({ apiKey: 'k' });
    await mapPhase(llm, 'openai/gpt-4o-mini', gathered, DEFAULT_CONFIG);

    expect(peak.value).toBeGreaterThan(1);
  });
});
