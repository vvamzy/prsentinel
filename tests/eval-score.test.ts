import { describe, it, expect } from 'vitest';
import {
  matches,
  precision,
  recall,
  scoreFindings,
  sumScores,
  type Expectation,
} from '../scripts/lib/eval-score.js';
import type { Finding, ReviewComment } from '../src/review/types.js';

/**
 * The scorer is the measuring instrument for the whole quality harness. If it
 * is wrong, every number the project reports is wrong, so it is tested directly
 * rather than only through a pipeline run.
 */

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: 'src/pager.ts',
    line: 12,
    severity: 'major',
    category: 'bug',
    title: 'Off-by-one in the page slice',
    body: 'The exclusive end drops the last item.',
    confidence: 0.9,
    ...over,
  };
}

function expectation(over: Partial<Expectation> = {}): Expectation {
  return {
    id: 'off-by-one',
    path: 'src/pager.ts',
    line: 12,
    match: ['off-by-one'],
    ...over,
  };
}

describe('matches', () => {
  it('requires the path, normalising separators', () => {
    expect(matches({ path: 'src/pager.ts', match: ['off-by-one'] }, finding())).toBe(true);
    expect(matches({ path: 'src\\pager.ts', match: ['off-by-one'] }, finding())).toBe(true);
    expect(matches({ path: 'src/other.ts', match: ['off-by-one'] }, finding())).toBe(false);
  });

  it('is case-insensitive and searches title and body', () => {
    expect(matches({ path: 'src/pager.ts', match: ['OFF-BY-ONE'] }, finding())).toBe(true);
    expect(matches({ path: 'src/pager.ts', match: ['exclusive end'] }, finding())).toBe(true);
  });

  it('requires every term in `match`, any term in `match_any`', () => {
    const f = finding();
    expect(matches({ path: 'src/pager.ts', match: ['off-by-one', 'pagination'] }, f)).toBe(false);
    expect(
      matches({ path: 'src/pager.ts', match: ['off-by-one'], match_any: ['slice', 'pagination'] }, f),
    ).toBe(true);
    expect(
      matches({ path: 'src/pager.ts', match_any: ['sql injection', 'xss'] }, f),
    ).toBe(false);
  });

  it('does not match a finding that only mentions the file name', () => {
    // A comment on the right file, about something else, is not the issue.
    expect(
      matches({ path: 'src/pager.ts', match: ['off-by-one'] }, finding({ title: 'Nit', body: 'Rename this.' })),
    ).toBe(false);
  });
});

describe('scoreFindings', () => {
  it('reports one comment meeting one expectation', () => {
    const s = scoreFindings({ expectations: [expectation()], findings: [finding()] });
    expect(s.expected).toBe(1);
    expect(s.matched).toBe(1);
    expect(s.anchored).toBe(1);
    expect(s.truePositives).toBe(1);
    expect(s.falsePositives).toBe(0);
    expect(s.missed).toEqual([]);
    expect(precision(s)).toBe(1);
    expect(recall(s)).toBe(1);
  });

  it('counts a comment with no expectation as a false positive', () => {
    const s = scoreFindings({
      expectations: [expectation()],
      findings: [finding(), finding({ title: 'Consider renaming this', body: 'Shorter name?' })],
    });
    expect(s.truePositives).toBe(1);
    expect(s.falsePositives).toBe(1);
    expect(s.falsePositiveDetails).toEqual([
      { file: 'src/pager.ts', line: 12, title: 'Consider renaming this' },
    ]);
    expect(precision(s)).toBe(0.5);
  });

  it('treats a repeat of a claimed expectation as a duplicate, not recall', () => {
    const s = scoreFindings({
      expectations: [expectation()],
      findings: [finding(), finding({ line: 13 })],
    });
    expect(s.matched).toBe(1);
    expect(s.truePositives).toBe(1);
    expect(s.duplicates).toBe(1);
    expect(precision(s)).toBe(0.5);
    expect(recall(s)).toBe(1);
  });

  it('lets one comment satisfy two expectations without calling it a duplicate', () => {
    const s = scoreFindings({
      expectations: [expectation(), expectation({ id: 'exclusive-end', match: ['exclusive end'] })],
      findings: [finding()],
    });
    expect(s.matched).toBe(2);
    expect(s.truePositives).toBe(1);
    expect(s.duplicates).toBe(0);
  });

  it('scores anchoring separately from substance', () => {
    const s = scoreFindings({
      expectations: [expectation({ line: 20, tolerance: 2 })],
      findings: [finding({ line: 12 })],
    });
    expect(s.matched).toBe(1);
    expect(s.anchored).toBe(0);
    expect(s.misanchored).toEqual(['off-by-one']);
    expect(recall(s)).toBe(1);
  });

  it('accepts an anchor within tolerance', () => {
    const s = scoreFindings({
      expectations: [expectation({ line: 12, tolerance: 2 })],
      findings: [finding({ line: 14 })],
    });
    expect(s.anchored).toBe(1);
    expect(s.misanchored).toEqual([]);
  });

  it('does not check anchoring when no line is declared', () => {
    const s = scoreFindings({
      expectations: [expectation({ line: undefined })],
      findings: [finding({ line: 999 })],
    });
    expect(s.anchored).toBe(1);
  });

  it('reports missed expectations by id', () => {
    const s = scoreFindings({ expectations: [expectation()], findings: [] });
    expect(s.missed).toEqual(['off-by-one']);
    expect(s.matched).toBe(0);
    expect(recall(s)).toBe(0);
    expect(precision(s)).toBeNull();
  });

  it('isolates explicitly allowed comments from precision', () => {
    const s = scoreFindings({
      expectations: [expectation()],
      allow: [{ path: 'src/pager.ts', match: ['nit'] }],
      findings: [finding(), finding({ title: 'Nit: rename', body: 'Cosmetic.' })],
    });
    expect(s.falsePositives).toBe(0);
    expect(s.allowed).toBe(1);
    expect(precision(s)).toBe(1);
  });

  it('counts unanchored comments, which are always a defect', () => {
    const comments: ReviewComment[] = [
      { path: 'src/pager.ts', line: 12, side: 'RIGHT', body: 'x' },
      { path: 'src/pager.ts', line: 13, side: 'RIGHT', body: 'y' },
    ];
    const s = scoreFindings({
      expectations: [expectation()],
      findings: [finding()],
      comments,
      isAnchored: (c) => c.line === 12,
    });
    expect(s.unanchored).toBe(1);
  });

  it('defaults rawFindings to the filtered count', () => {
    const s = scoreFindings({ expectations: [], findings: [finding()] });
    expect(s.rawFindings).toBe(1);
    expect(s.filter).toBeUndefined();
  });

  it('carries the filter counters, so a low comment count is explainable', () => {
    // "0 posted" reads the same whether the model said nothing or the filter
    // removed everything. The counters are what tell the two apart.
    const s = scoreFindings({
      expectations: [],
      findings: [],
      rawFindings: 3,
      filter: {
        droppedConfidence: 3,
        droppedOutOfHunk: 0,
        droppedFilteredPath: 0,
        droppedDuplicate: 0,
        droppedCap: 0,
        suppressedStyle: 0,
        strippedProseSuggestion: 0,
      },
    });
    expect(s.rawFindings).toBe(3);
    expect(s.findings).toBe(0);
    expect(s.filter?.droppedConfidence).toBe(3);
  });
});

describe('sumScores', () => {
  it('sums counts and derives rates from the totals', () => {
    const a = scoreFindings({ expectations: [expectation()], findings: [finding()] });
    const b = scoreFindings({
      expectations: [expectation(), expectation({ id: 'second', match: ['exclusive end'] })],
      findings: [finding({ title: 'Unrelated', body: 'Nothing to do with it.' })],
    });

    const suite = sumScores([a, b]);
    expect(suite.expected).toBe(3);
    expect(suite.matched).toBe(1);
    expect(suite.truePositives).toBe(1);
    expect(suite.falsePositives).toBe(1);
    // 1 of 2 scored comments: a per-case average would have said 75%.
    expect(precision(suite)).toBe(0.5);
    expect(recall(suite)).toBeCloseTo(1 / 3);
  });

  it('sums usage and duration', () => {
    const a = scoreFindings({ expectations: [], findings: [], durationMs: 100, inputTokens: 10, outputTokens: 2 });
    const b = scoreFindings({ expectations: [], findings: [], durationMs: 250, inputTokens: 5, outputTokens: 3 });
    const suite = sumScores([a, b]);
    expect(suite.durationMs).toBe(350);
    expect(suite.inputTokens).toBe(15);
    expect(suite.outputTokens).toBe(5);
  });
});
