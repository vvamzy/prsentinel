/**
 * Core domain types for prsentinel.
 *
 * These types are the contract between the GitHub layer, the LLM layer, and
 * the review pipeline. Keep them dependency-free so they can be imported
 * from tests and from any module without pulling in octokit.
 */

/** How bad is it? Drives display ordering and the inline comment badge. */
export type Severity = 'critical' | 'major' | 'minor' | 'info';

/** What kind of problem is this? Used for filtering and grouping. */
export type Category =
  | 'bug'
  | 'security'
  | 'performance'
  | 'maintainability'
  | 'style'
  | 'test'
  | 'docs';

/**
 * A single actionable finding, anchored to a line in the NEW (post-PR) file.
 *
 * `line` is a 1-based line number on the RIGHT side of the diff. If
 * `startLine` is set the finding spans `startLine..line` and any `suggestion`
 * replaces that whole contiguous range — which is what makes GitHub's
 * one-click "Apply suggestion" work.
 */
export interface Finding {
  file: string;
  /** 1-based line number in the new file. */
  line: number;
  /** Optional inclusive start of a multi-line range in the new file. */
  startLine?: number;
  severity: Severity;
  category: Category;
  /** Short headline, rendered bold above the body. */
  title: string;
  /** Markdown body. Explain the problem and why it matters. */
  body: string;
  /**
   * Optional replacement code for the `startLine..line` range. Rendered in a
   * ```suggestion block so GitHub offers a one-click Apply button.
   */
  suggestion?: string;
  /** 0..1. Findings below the configured threshold are dropped. */
  confidence: number;
}

/** A high-level summary of what one changed file does. */
export interface FileSummary {
  file: string;
  status?: 'added' | 'modified' | 'removed' | 'renamed';
  /** One or two sentences, rendered in a collapsible section. */
  summary: string;
}

/** The result of analyzing a single file in the MAP phase. */
export interface FileAnalysis {
  file: string;
  findings: Finding[];
  summary: string;
  /** Token usage for this file's LLM call, for cost reporting. */
  usage: TokenUsage;
}

/** Aggregated output of the REDUCE phase. */
export interface ReviewPlan {
  /** Top-level walkthrough, rendered as the review body. */
  walkthrough: string;
  findings: Finding[];
  fileSummaries: FileSummary[];
  usage: TokenUsage;
}

/** What actually gets sent to `pulls.createReview`. */
export interface ReviewPayload {
  event: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';
  commit_id: string;
  body: string;
  comments: ReviewComment[];
}

/** One inline comment in the createReview payload. */
export interface ReviewComment {
  path: string;
  /** Required when side is RIGHT or the comment is multi-line. */
  line: number;
  side: 'LEFT' | 'RIGHT';
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
  body: string;
}

/** Token accounting, used for logging and cost guards. */
export interface TokenUsage {
  input: number;
  output: number;
}

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { input: a.input + b.input, output: a.output + b.output };
}

/** Display ordering: critical first, then by category, then by line. */
const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  info: 3,
};

export function compareFindings(a: Finding, b: Finding): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.line - b.line;
}
