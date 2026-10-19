/**
 * Incremental-review state.
 *
 * We embed a marker in the review body itself:
 *
 *   <!-- prsentinel:last-reviewed:abc123 -->
 *
 * No extra branches, no external store, and it's self-healing: if the marker
 * is lost we simply fall back to a full review.
 */

const MARKER_RE = /<!--\s*prsentinel:last-reviewed:([0-9a-f]{7,40})\s*-->/i;

export function encodeMarker(sha: string): string {
  return `<!-- prsentinel:last-reviewed:${sha} -->`;
}

export function extractLastReviewedSha(body: string): string | null {
  const m = MARKER_RE.exec(body);
  return m?.[1] ?? null;
}

/**
 * Find the last prsentinel review on a PR and return its head SHA.
 * Only reviews authored by a login containing "prsentinel" (or the
 * configured bot login) are considered.
 */
export function findLastReviewedSha(
  reviews: Array<{ body: string; user: string }>,
  botLogins: string[] = ['prsentinel', 'github-actions[bot]'],
): string | null {
  // Reviews come oldest-first; scan backwards for the newest marker.
  for (let i = reviews.length - 1; i >= 0; i--) {
    const r = reviews[i]!;
    const login = r.user.toLowerCase();
    const isOurs = botLogins.some((b) => login.includes(b.toLowerCase()));
    if (!isOurs) continue;
    const sha = extractLastReviewedSha(r.body);
    if (sha) return sha;
  }
  return null;
}

const KNOWN_COMMANDS = ['review', 'explain', 'resolve', 'generate-tests'] as const;
export type KnownCommand = (typeof KNOWN_COMMANDS)[number];

/**
 * Extract a prsentinel command from a PR comment.
 *
 * Accepts both styles:
 *   `/review`                          → { command: 'review', args: '' }
 *   `@prsentinel explain the flow`     → { command: 'explain', args: 'the flow' }
 *   `@prsentinel`                      → { command: 'review', args: '' }
 *
 * The trigger must be at the start of the text or preceded by whitespace, so
 * a `/` inside a URL never matches. Returns null when there is no trigger.
 *
 * `botLogin` accepts several names because an authenticated identity has more
 * than one: a GitHub App is logged as `my-app[bot]` but is *mentioned* as
 * `@my-app`. Pass every candidate.
 */
export function parseSlashCommand(
  body: string,
  botLogin: string | string[],
): { command: KnownCommand; args: string } | null {
  const names = (Array.isArray(botLogin) ? botLogin : [botLogin])
    .map((n) => n.trim())
    .filter((n) => n !== '');
  if (names.length === 0) return null;

  const alternation = names.map(escapeRegExp).join('|');
  // The trailing lookahead stops `@prsentinelx` from being read as a mention of
  // `prsentinel`, and lets a longer name win over a shorter prefix of it.
  const trigger = new RegExp(`(?:^|[\\s(])(?:@(?:${alternation})(?![\\w-])|/)\\s*`, 'i');
  const m = trigger.exec(body);
  if (!m) return null;

  const rest = body.slice(m.index + m[0].length).split('\n')[0] ?? '';
  const tokenMatch = /^([A-Za-z][A-Za-z-]*)\s*/.exec(rest);
  const firstToken = tokenMatch?.[1]?.toLowerCase();

  if (tokenMatch && firstToken && (KNOWN_COMMANDS as readonly string[]).includes(firstToken)) {
    return { command: firstToken as KnownCommand, args: rest.slice(tokenMatch[0].length).trim() };
  }
  // A bare mention defaults to a full review, with the remainder as guidance.
  return { command: 'review', args: rest.trim() };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The `@mention` forms of our own identities.
 *
 * GitHub logs a GitHub App as `my-app[bot]` but users mention it as `@my-app`.
 * Matching the raw login against a comment body never works, so every login is
 * reduced to its mention form and de-duplicated.
 */
export function mentionNames(botLogins: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const login of botLogins) {
    const name = login.replace(/\[bot\]$/i, '').trim();
    if (name === '') continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Whether a comment or review author is one of our identities.
 *
 * Exact and case-insensitive. A substring test would treat a user called
 * `not-prsentinel` as us, and `/resolve` acts on the answer — resolving or
 * leaving alone someone else's threads.
 */
export function isOurLogin(author: string, botLogins: string[]): boolean {
  const a = author.trim().toLowerCase();
  if (a === '') return false;
  return botLogins.some((b) => a === b.trim().toLowerCase());
}
