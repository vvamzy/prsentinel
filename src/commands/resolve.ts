import { log } from '../log.js';
import { isOurLogin } from '../state.js';
import type { CommandHandler } from './shared.js';

/**
 * `/resolve`
 *
 * Resolves the review threads prsentinel opened on this pull request, so a
 * maintainer can clear the conversation with one command instead of clicking
 * "Resolve conversation" on each finding.
 *
 * Deliberately narrow: only threads whose *first* comment we wrote are
 * touched. A thread a reviewer started, even one we replied to, is left alone —
 * marking someone else's discussion resolved is not ours to do.
 *
 * Resolving needs the GraphQL thread node id, which no REST endpoint exposes,
 * which is why this command took longer to implement than the others.
 */
export const resolveCommand: CommandHandler = async (ctx) => {
  const threads = await ctx.client.listReviewThreads(ctx.prNumber);
  const open = threads.filter((t) => !t.isResolved && isOurLogin(t.author, ctx.botLogins));

  log.info(
    `Command /resolve: ${threads.length} thread(s) on the PR, ${open.length} ours and open.`,
  );

  if (open.length === 0) {
    return {
      comment: 'Nothing to resolve — I have no open review threads on this pull request.',
      summary: 'No open prsentinel threads',
    };
  }

  // A dry run must not mutate anything, but it should still report what it
  // *would* do so the behaviour can be checked without side effects.
  if (ctx.dryRun) {
    return {
      comment: `**Dry run** — I would resolve ${open.length} review thread(s).`,
      summary: `Would resolve ${open.length} thread(s)`,
    };
  }

  let resolved = 0;
  const failed: string[] = [];

  for (const thread of open) {
    try {
      await ctx.client.resolveThread(thread.id);
      resolved++;
    } catch (err) {
      // One failure must not abort the rest — a thread can become unresolvable
      // if someone resolved it in the browser a second earlier.
      failed.push(`${thread.path}${thread.line !== null ? `:${thread.line}` : ''}`);
      log.warn(`Could not resolve thread ${thread.id} (${thread.path}): ${String(err)}`);
    }
  }

  const lines = [`Resolved **${resolved}** review thread(s).`];
  if (failed.length > 0) {
    lines.push(
      '',
      `Could not resolve ${failed.length}: ${failed.map((f) => `\`${f}\``).join(', ')}.`,
    );
  }

  return {
    comment: lines.join('\n'),
    summary: `Resolved ${resolved}/${open.length} thread(s)`,
  };
};
