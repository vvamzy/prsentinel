/**
 * Scoring for the quality harness.
 *
 * Pure functions only, so the maths can be unit-tested without a model, and so
 * a change to scoring never silently changes what the harness measures.
 *
 * The unit of truth is an *expectation*: a real issue a human would want
 * flagged. An expectation is "met" when a posted comment names the same file
 * and mentions the same substance. Line numbers are scored separately, as
 * anchoring, because a correct finding on the wrong line is still useful but a
 * misanchor is how reviews break (GitHub rejects the whole review).
 */

import type { Finding, ReviewComment } from '../../src/review/types.js';

/** A file-and-text predicate over a finding. */
export interface FindingMatcher {
  /** File the finding must be on. Exact match after slash normalisation. */
  path: string;
  /**
   * Every one of these substrings must appear (case-insensitive) in the
   * finding's title or body. This is how "the same substance" is tested: they
   * are chosen from the *problem*, never from the proposed fix, so a model that
   * explains an issue differently still scores.
   */
  match?: string[];
  /** At least one of these substrings must appear. Use for synonyms. */
  match_any?: string[];
}

/** A real issue the review is expected to report. */
export interface Expectation extends FindingMatcher {
  /** Stable id, quoted in the report when the finding is missing. */
  id: string;
  /** Where the issue is. Scored as anchoring, with `tolerance`. */
  line?: number;
  /** How many lines off the anchor may be. Default 2. */
  tolerance?: number;
  /** Human note: why this is a real issue. Never scored. */
  why?: string;
}

/** A finding that is tolerated but not required. */
export type Allowance = FindingMatcher & { why?: string };

export interface EvalCase {
  /** Short name, unique across the suite. */
  name: string;
  /** Where the diff came from, so a reader can check the label. */
  source: string;
  /** Why these expectations are the right ones. */
  notes?: string;
  /** `reviews.*` overrides applied on top of the harness defaults. */
  config?: Record<string, unknown>;
  /** Path to a saved PR fixture, relative to this file. */
  fixture?: string;
  /** The PR itself, inline (alternative to `fixture`). */
  pr?: unknown;
  expect?: Expectation[];
  allow?: Allowance[];
}

export interface FixtureScore {
  name: string;
  /** Expectations declared. */
  expected: number;
  /** Expectations met by at least one comment. */
  matched: number;
  /** ...and anchored within tolerance. */
  anchored: number;
  /** Comments that would be posted. */
  findings: number;
  /** Findings before the deterministic filter, for context. */
  rawFindings: number;
  /** Comments that met an expectation the first time. */
  truePositives: number;
  /** Comments repeating an expectation an earlier comment already met. */
  duplicates: number;
  /** Comments that met nothing and were not explicitly allowed. */
  falsePositives: number;
  /** What those comments said, so a run can be debugged from its report. */
  falsePositiveDetails: Array<{ file: string; line: number; title: string }>;
  /** Comments matched by an `allow` rule. */
  allowed: number;
  /** Expectation ids with no comment. */
  missed: string[];
  /** Expectation ids met only off their anchor line. */
  misanchored: string[];
  /** Comments whose line GitHub would reject. Must be zero. */
  unanchored: number;
  /** Suggestion blocks that are prose on a code file. Must be zero. */
  proseSuggestions: number;
  /**
   * Why the raw findings did not all become comments. Without this, "0 posted"
   * is ambiguous: it reads the same whether the model said nothing or the
   * deterministic filter removed everything it said.
   */
  filter?: {
    droppedConfidence: number;
    droppedOutOfHunk: number;
    droppedFilteredPath: number;
    droppedDuplicate: number;
    droppedCap: number;
    suppressedStyle: number;
    strippedProseSuggestion: number;
  };
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Does `finding` satisfy this matcher? */
export function matches(m: FindingMatcher, finding: Finding): boolean {
  if (normalizePath(finding.file) !== normalizePath(m.path)) return false;
  const hay = `${finding.title}\n${finding.body}`.toLowerCase();
  if (m.match && m.match.length > 0) {
    if (!m.match.every((t) => hay.includes(t.toLowerCase()))) return false;
  }
  if (m.match_any && m.match_any.length > 0) {
    if (!m.match_any.some((t) => hay.includes(t.toLowerCase()))) return false;
  }
  return true;
}

/**
 * Score one fixture.
 *
 * Ownership rule: the first comment that satisfies an expectation claims it.
 * Later comments satisfying only already-claimed expectations are duplicates,
 * which count against precision — repeating a finding is noise, not recall.
 */
export function scoreFindings(input: {
  name?: string;
  expectations: Expectation[];
  allow?: Allowance[];
  /** Findings after the deterministic filter (what would be posted). */
  findings: Finding[];
  /** Findings before the filter. */
  rawFindings?: number;
  /** Comment paths that GitHub will accept. */
  isAnchored?: (comment: ReviewComment) => boolean;
  comments?: ReviewComment[];
  /** Suggestion blocks that are prose on a code file, after filtering. */
  proseSuggestions?: number;
  /** The filter phase's drop counts, for explaining a low comment count. */
  filter?: FixtureScore['filter'];
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}): FixtureScore {
  const {
    name = '',
    expectations,
    allow = [],
    findings,
    rawFindings = findings.length,
    isAnchored,
    comments = [],
    proseSuggestions = 0,
    filter,
    durationMs = 0,
    inputTokens = 0,
    outputTokens = 0,
  } = input;

  const satisfied = findings.map((f) => expectations.filter((e) => matches(e, f)).map((e) => e.id));

  const claimed = new Set<string>();
  let truePositives = 0;
  let duplicates = 0;
  let falsePositives = 0;
  let allowed = 0;
  const falsePositiveDetails: Array<{ file: string; line: number; title: string }> = [];

  satisfied.forEach((ids, i) => {
    const finding = findings[i]!;
    if (ids.length === 0) {
      if (allow.some((a) => matches(a, finding))) allowed++;
      else {
        falsePositives++;
        falsePositiveDetails.push({ file: finding.file, line: finding.line, title: finding.title });
      }
      return;
    }
    if (ids.some((id) => !claimed.has(id))) {
      for (const id of ids) claimed.add(id);
      truePositives++;
    } else {
      duplicates++;
    }
  });

  const misanchored: string[] = [];
  for (const e of expectations) {
    if (!claimed.has(e.id) || e.line === undefined) continue;
    const tolerance = e.tolerance ?? 2;
    const onLine = findings.some((f) => matches(e, f) && Math.abs(f.line - e.line!) <= tolerance);
    if (!onLine) misanchored.push(e.id);
  }

  const unanchored = isAnchored
    ? comments.filter((c) => !isAnchored(c)).length
    : 0;

  return {
    name,
    expected: expectations.length,
    matched: claimed.size,
    anchored: claimed.size - misanchored.length,
    findings: findings.length,
    rawFindings,
    truePositives,
    duplicates,
    falsePositives,
    falsePositiveDetails,
    allowed,
    missed: expectations.filter((e) => !claimed.has(e.id)).map((e) => e.id),
    misanchored,
    unanchored,
    proseSuggestions,
    filter: filter
      ? {
          droppedConfidence: filter.droppedConfidence,
          droppedOutOfHunk: filter.droppedOutOfHunk,
          droppedFilteredPath: filter.droppedFilteredPath,
          droppedDuplicate: filter.droppedDuplicate,
          droppedCap: filter.droppedCap,
          suppressedStyle: filter.suppressedStyle,
          strippedProseSuggestion: filter.strippedProseSuggestion,
        }
      : undefined,
    durationMs,
    inputTokens,
    outputTokens,
  };
}

/** Precision: of the comments posted, how many said something true? */
export function precision(
  s: Pick<FixtureScore, 'truePositives' | 'duplicates' | 'falsePositives'>,
): number | null {
  const scored = s.truePositives + s.duplicates + s.falsePositives;
  return scored === 0 ? null : s.truePositives / scored;
}

/** Recall: of the real issues, how many were reported? */
export function recall(s: Pick<FixtureScore, 'expected' | 'matched'>): number | null {
  return s.expected === 0 ? null : s.matched / s.expected;
}

export interface SuiteScore {
  cases: FixtureScore[];
  expected: number;
  matched: number;
  anchored: number;
  findings: number;
  truePositives: number;
  duplicates: number;
  falsePositives: number;
  allowed: number;
  unanchored: number;
  proseSuggestions: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

/** Sum a suite. Rates are computed from the sums, never averaged. */
export function sumScores(cases: FixtureScore[]): SuiteScore {
  const sum = (pick: (s: FixtureScore) => number) => cases.reduce((n, s) => n + pick(s), 0);
  return {
    cases,
    expected: sum((s) => s.expected),
    matched: sum((s) => s.matched),
    anchored: sum((s) => s.anchored),
    findings: sum((s) => s.findings),
    truePositives: sum((s) => s.truePositives),
    duplicates: sum((s) => s.duplicates),
    falsePositives: sum((s) => s.falsePositives),
    allowed: sum((s) => s.allowed),
    unanchored: sum((s) => s.unanchored),
    proseSuggestions: sum((s) => s.proseSuggestions),
    durationMs: sum((s) => s.durationMs),
    inputTokens: sum((s) => s.inputTokens),
    outputTokens: sum((s) => s.outputTokens),
  };
}
