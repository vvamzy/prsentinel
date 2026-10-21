import type { Config } from '../config.js';
import type { GitHubClient, IssueComment } from '../github/client.js';
import { annotatePatch, parsePatch } from '../github/diff.js';
import type { LLMFacade } from '../llm/registry.js';
import { contextLinesForEffort } from '../config.js';
import { selectFiles } from '../review/select.js';
import type { ChangedFile } from '../review/map.js';
import type { ReviewPayload } from '../review/types.js';
import type { KnownCommand } from '../state.js';

/**
 * Shared types and helpers for slash commands.
 *
 * The dispatcher owns posting so individual handlers only have to produce
 * content. That keeps the "where does this text go" decision in one place.
 */

export interface CommandContext {
  client: GitHubClient;
  config: Config;
  llm: LLMFacade;
  /** Model id for conversational work (falls back to the review model). */
  model: string;
  prNumber: number;
  /** The comment that triggered the command. */
  comment: IssueComment;
  command: KnownCommand;
  /** Everything after the command word. */
  args: string;
  dryRun: boolean;
  repoRoot: string;
  /** The mention form of our identity, for prompts. */
  botLogin: string;
  /** Every login we answer to, for telling our comments apart from others'. */
  botLogins: string[];
}

export interface CommandResult {
  /** Markdown to post as a plain PR comment. */
  comment?: string;
  /** A full review to submit with inline comments. */
  review?: ReviewPayload;
  /** Shown in the Action log only. */
  summary?: string;
}

export type CommandHandler = (ctx: CommandContext) => Promise<CommandResult>;

/** One changed file prepared for a prompt. */
export interface PreparedFile {
  filename: string;
  annotated: string;
  maxLine: number;
}

/**
 * Load changed files, apply config filtering and an optional path scope, and
 * render each one as an annotated patch.
 *
 * `limit` caps how many files end up in the prompt.
 */
export async function prepareFiles(
  ctx: Pick<CommandContext, 'client' | 'config' | 'prNumber'>,
  opts: { scope?: string[]; limit?: number; includeNoDiff?: boolean } = {},
): Promise<{ files: PreparedFile[]; skipped: Array<{ file: string; reason: string }> }> {
  const changed = await ctx.client.getChangedFiles(ctx.prNumber);
  const { selected, skipped } = selectFiles(changed, ctx.config);

  let scoped = selected;
  if (opts.scope && opts.scope.length > 0) {
    const norm = opts.scope.map((s) => s.replace(/\\/g, '/').replace(/^\.\//, ''));
    scoped = selected.filter((f) => matchesAnyScope(f.filename, norm));
  }

  const limited = opts.limit ? scoped.slice(0, opts.limit) : scoped;

  const files: PreparedFile[] = [];
  for (const f of limited) {
    if (!f.patch) continue;
    try {
      const parsed = parsePatch(f.patch);
      files.push({
        filename: f.filename,
        annotated: annotatePatch(parsed),
        maxLine: parsed.maxNewLine,
      });
    } catch {
      skipped.push({ file: f.filename, reason: 'unparseable patch' });
    }
  }

  return { files, skipped };
}

function matchesAnyScope(filename: string, scopes: string[]): boolean {
  const name = filename.replace(/\\/g, '/');
  return scopes.some(
    (s) =>
      name === s ||
      name.startsWith(`${s.replace(/\/$/, '')}/`) ||
      name.endsWith(`/${s}`) ||
      name.includes(s),
  );
}

/**
 * Split command args into a path scope and a free-text remainder.
 *
 *   `/explain src/payments/charge.ts why is this not transactional`
 *      → scope: ['src/payments/charge.ts'], question: 'why is this not transactional'
 *
 *   `/explain why is this not transactional`
 *      → scope: [], question: 'why is this not transactional'
 *
 * A token only becomes a scope if it actually matches a changed file, so a
 * genuine question that happens to contain a word like `src` is not swallowed.
 */
export function splitScopeAndQuestion(
  args: string,
  changedFiles: string[],
): { scope: string[]; question: string } {
  const trimmed = args.trim();
  if (trimmed === '') return { scope: [], question: '' };

  const tokens = trimmed.split(/\s+/);
  const scope: string[] = [];
  const rest: string[] = [];
  const normFiles = changedFiles.map((f) => f.replace(/\\/g, '/'));

  for (const token of tokens) {
    const candidate = token.replace(/^`|`$/g, '').replace(/^\.\//, '');
    const isPath = candidate.includes('/') || /\.[A-Za-z0-9]+$/.test(candidate);
    const matched =
      isPath && normFiles.some((f) => f === candidate || f.startsWith(`${candidate.replace(/\/$/, '')}/`) || f.endsWith(`/${candidate}`));
    if (matched) scope.push(candidate);
    else rest.push(token);
  }

  return { scope, question: rest.join(' ').trim() };
}

/** Narrow an annotated patch to a window of lines around the changes. */
export function trimToWindow(annotated: string, radius: number): string {
  // Annotation rows look like "  142 + content". Keep every hunk header and
  // any row whose line number is within `radius` of a changed (+) row.
  const lines = annotated.split('\n');
  const changedNums: number[] = [];
  for (const l of lines) {
    const m = /^\s*(\d+)\s\+\s/.exec(l);
    if (m) changedNums.push(Number(m[1]));
  }
  if (changedNums.length === 0) return annotated;

  const min = Math.min(...changedNums) - radius;
  const max = Math.max(...changedNums) + radius;

  const out: string[] = [];
  for (const l of lines) {
    if (l.startsWith('@@')) {
      out.push(l);
      continue;
    }
    const m = /^\s*(\d+)\s/.exec(l);
    if (!m) continue;
    const n = Number(m[1]);
    if (n >= min && n <= max) out.push(l);
  }
  return out.join('\n');
}

export { contextLinesForEffort };
export type { ChangedFile };
