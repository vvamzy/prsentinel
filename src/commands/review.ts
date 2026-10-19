import { runReview } from '../pipeline.js';
import { log } from '../log.js';
import type { CommandHandler } from './shared.js';

/**
 * `/review [path…|all]`
 *
 * Re-runs the full review pipeline and submits a fresh review.
 *
 * - no args        → normal (incremental) review
 * - `all`          → ignore the incremental marker, review everything
 * - paths          → restrict to files under those paths
 */
export const reviewCommand: CommandHandler = async (ctx) => {
  const args = ctx.args.trim();
  const tokens = args === '' ? [] : args.split(/\s+/);
  const full = tokens.includes('all');
  const scope = tokens.filter((t) => t !== 'all' && t !== '');

  log.info(
    `Command /review: scope=${scope.length ? scope.join(',') : '(all changed)'} full=${full}`,
  );

  const outcome = await runReview({
    client: ctx.client,
    config: ctx.config,
    llm: ctx.llm,
    model: ctx.model,
    prNumber: ctx.prNumber,
    ...(scope.length > 0 ? { scope } : {}),
    ...(full ? { full: true } : {}),
  });

  const inlineCount = outcome.payload.comments.length;
  const summary =
    inlineCount === 0
      ? 'No issues found.'
      : `${inlineCount} inline comment(s).`;

  // Prefix the walkthrough so a scoped re-review is distinguishable from the
  // automatic one, and always mention the scope.
  const header = scope.length > 0 ? `Re-review of \`${scope.join('`, `')}\`` : 'Re-review';
  const marker = `<!-- prsentinel:command-review -->`;
  const body = `${marker}\n${outcome.payload.body}`;

  return {
    review: { ...outcome.payload, body },
    summary: `${header}: ${summary}`,
  };
};
