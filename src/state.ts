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
 */
export function parseSlashCommand(
  body: string,
  botLogin: string,
): { command: KnownCommand; args: string } | null {
  const escaped = botLogin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const trigger = new RegExp(`(?:^|[\\s(])(?:@${escaped}|/)\\s*`, 'i');
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
