import { COMMAND_SYSTEM, explainUserPrompt, renderFileSections } from '../review/prompts.js';
import { log } from '../log.js';
import { prepareFiles, splitScopeAndQuestion, trimToWindow } from './shared.js';
import type { CommandHandler } from './shared.js';

/**
 * `/explain [path…] [question]`
 *
 * Answers a question about the PR, or explains the change when asked nothing
 * in particular. Posts a normal comment — there is no single line to anchor
 * an inline comment to.
 */
export const explainCommand: CommandHandler = async (ctx) => {
  const changed = await ctx.client.getChangedFiles(ctx.prNumber);
  const changedPaths = changed.map((f) => f.filename);

  const { scope, question } = splitScopeAndQuestion(ctx.args, changedPaths);

  const { files, skipped } = await prepareFiles(
    { client: ctx.client, config: ctx.config, prNumber: ctx.prNumber },
    { scope: scope.length > 0 ? scope : undefined, limit: ctx.config.commands.max_explain_files },
  );

  log.info(
    `Command /explain: scope=${scope.length ? scope.join(',') : '(all)'} files=${files.length} question="${question}"`,
  );

  if (files.length === 0) {
    return {
      comment: scope.length
        ? `I could not find any changed file matching \`${scope.join('`, `')}\`.`
        : 'I could not find any reviewable changed files in this pull request.',
    };
  }

  const pr = await ctx.client.getPullRequest(ctx.prNumber);

  const fileSections = renderFileSections(
    files.map((f) => ({
      filename: f.filename,
      annotated: trimToWindow(f.annotated, 40),
    })),
  );

  const res = await ctx.llm.complete(ctx.model, {
    messages: [
      { role: 'system', content: COMMAND_SYSTEM },
      {
        role: 'user',
        content: explainUserPrompt({
          prTitle: pr.title,
          prBody: pr.body,
          question,
          fileSections,
        }),
      },
    ],
    maxTokens: 2048,
  });

  const body = res.text.trim() || '_I could not generate an explanation for this change._';
  const footer = footerFor(files.length, skipped.length);

  return {
    comment: body + footer,
    summary: `Explained ${files.length} file(s)`,
  };
};

function footerFor(fileCount: number, skippedCount: number): string {
  const bits = [`Reviewed ${fileCount} file(s)`];
  if (skippedCount > 0) bits.push(`${skippedCount} skipped`);
  return `\n\n---\n<sub>${bits.join(' · ')} · 🤖 prsentinel</sub>`;
}
