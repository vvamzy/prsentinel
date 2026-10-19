/**
 * Parsing for pull-request references.
 *
 * The offline harness (`scripts/dev-review.ts`) takes a PR from the command
 * line so a real pull request can be reviewed without hand-writing a fixture.
 * Both forms people actually type are accepted:
 *
 *   owner/repo#123
 *   https://github.com/owner/repo/pull/123
 */

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

/** `https://github.com/owner/repo/pull/123`, with optional trailing `/files`. */
const URL_RE = /^https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/pulls?\/(\d+)(?:[/?#][^\s]*)?$/i;

/** `owner/repo#123`. */
const SHORT_RE = /^([^/#\s]+)\/([^#\s]+)#(\d+)$/;

export function parsePrRef(input: string): PrRef | null {
  const trimmed = input.trim();

  const url = URL_RE.exec(trimmed);
  if (url) return build(url[1]!, url[2]!, url[3]!);

  const short = SHORT_RE.exec(trimmed);
  if (short) return build(short[1]!, short[2]!, short[3]!);

  return null;
}

function build(owner: string, repo: string, numberText: string): PrRef | null {
  const number = Number(numberText);
  if (!Number.isInteger(number) || number <= 0) return null;
  // GitHub renders clone URLs with a `.git` suffix; a pasted one should work.
  return { owner, repo: repo.replace(/\.git$/i, ''), number };
}
