/**
 * Unified-diff parsing.
 *
 * This is the most bug-prone code in prsentinel: every inline comment and
 * every ```suggestion block depends on getting new-file line numbers exactly
 * right. The invariants below are asserted in tests/fixtures.
 *
 * Terminology:
 *   old side  = the base branch (LEFT)
 *   new side  = the PR head   (RIGHT)  ← we comment on this side
 */

export type LineKind = 'add' | 'del' | 'ctx';

export interface DiffLine {
  kind: LineKind;
  /** Line content without the leading +/-/space marker. */
  content: string;
  /** 1-based line number on the new (RIGHT) side, if the line exists there. */
  newLine?: number;
  /** 1-based line number on the old (LEFT) side, if the line exists there. */
  oldLine?: number;
}

export interface Hunk {
  /** Raw header, e.g. `@@ -12,7 +12,9 @@ function foo()`. */
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface ParsedPatch {
  hunks: Hunk[];
  /**
   * Set of new-file line numbers that are "attachable" — i.e. a review
   * comment can be placed there. This covers added lines and context lines
   * inside hunks. Deleted lines are NOT attachable on the RIGHT side.
   */
  attachableNewLines: Set<number>;
  /** Map of new-file line number → that line's content. */
  newLineContent: Map<number, string>;
  /** Inclusive new-file line range covered by the patch, for bounds checks. */
  minNewLine: number;
  maxNewLine: number;
}

/**
 * Parse a unified diff patch (the `patch` field from the GitHub
 * `pulls/{n}/files` API) into structured hunks.
 *
 * Throws on a malformed hunk header rather than silently mis-numbering
 * lines — a wrong comment is worse than no comment.
 */
export function parsePatch(patch: string): ParsedPatch {
  const lines = patch.split('\n');
  const hunks: Hunk[] = [];
  const attachableNewLines = new Set<number>();
  const newLineContent = new Map<number, string>();

  let current: Hunk | null = null;
  let oldCursor = 0;
  let newCursor = 0;

  for (const raw of lines) {
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw);
      if (!m) {
        throw new Error(`Malformed hunk header: ${raw}`);
      }
      current = {
        header: raw,
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      hunks.push(current);
      oldCursor = current.oldStart;
      newCursor = current.newStart;
      continue;
    }

    // Lines before the first hunk header (e.g. `diff --git`, `index ...`)
    // are metadata; ignore them.
    if (!current) continue;

    // A trailing empty string from split() is not a diff line.
    if (raw === '') continue;

    const marker = raw[0];
    const content = raw.slice(1);

    if (marker === '+') {
      current.lines.push({ kind: 'add', content, newLine: newCursor });
      attachableNewLines.add(newCursor);
      newLineContent.set(newCursor, content);
      newCursor++;
    } else if (marker === '-') {
      current.lines.push({ kind: 'del', content, oldLine: oldCursor });
      oldCursor++;
    } else if (marker === ' ' || marker === undefined) {
      // Context line. Some diffs emit a bare empty line for context.
      current.lines.push({ kind: 'ctx', content, newLine: newCursor, oldLine: oldCursor });
      attachableNewLines.add(newCursor);
      newLineContent.set(newCursor, content);
      oldCursor++;
      newCursor++;
    } else if (marker === '\\') {
      // e.g. "\ No newline at end of file" — informational only.
      continue;
    } else {
      // Unknown marker; skip rather than corrupt line counters.
      continue;
    }
  }

  const allNew = [...attachableNewLines];
  return {
    hunks,
    attachableNewLines,
    newLineContent,
    minNewLine: allNew.length ? Math.min(...allNew) : 0,
    maxNewLine: allNew.length ? Math.max(...allNew) : 0,
  };
}

/**
 * Determine the widest contiguous attachable range that contains `line`.
 *
 * GitHub requires a multi-line review comment to cover lines that all exist
 * in the diff. When a finding spans lines that GitHub won't accept, we clamp
 * to the largest valid subrange so the comment still posts instead of the
 * whole review failing with a 422.
 */
export function clampRange(
  parsed: ParsedPatch,
  startLine: number,
  endLine: number,
): { startLine: number; endLine: number } | null {
  if (endLine < startLine) [startLine, endLine] = [endLine, startLine];
  if (!parsed.attachableNewLines.has(endLine)) return null;

  // Walk down from endLine to find the start of the contiguous run.
  let runStart = endLine;
  while (runStart > startLine && parsed.attachableNewLines.has(runStart - 1)) {
    runStart--;
  }
  // If the requested start is inside the run (or beyond), use max(start, runStart).
  const clampedStart = Math.max(startLine, runStart);
  if (clampedStart > endLine) return null;
  return { startLine: clampedStart, endLine };
}

/** Render a patch back to text — used in prompts and fixtures. */
export function renderPatch(parsed: ParsedPatch): string {
  return parsed.hunks
    .map((h) => {
      const body = h.lines
        .map((l) => {
          const marker = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
          return marker + l.content;
        })
        .join('\n');
      return `${h.header}\n${body}`;
    })
    .join('\n');
}

/** Human-readable line annotation for prompts: `  142 | const x = 1;`. */
export function annotatePatch(parsed: ParsedPatch): string {
  const out: string[] = [];
  for (const h of parsed.hunks) {
    out.push(h.header);
    for (const l of h.lines) {
      const num = l.newLine ?? l.oldLine ?? 0;
      const marker = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
      out.push(`${String(num).padStart(5)} ${marker} ${l.content}`);
    }
  }
  return out.join('\n');
}
