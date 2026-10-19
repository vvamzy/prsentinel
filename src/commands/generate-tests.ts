import { TESTS_SYSTEM, testsUserPrompt } from '../review/prompts.js';
import { log } from '../log.js';
import { prepareFiles, splitScopeAndQuestion, trimToWindow } from './shared.js';
import type { CommandContext, CommandHandler } from './shared.js';

/**
 * `/generate-tests [path…] [extra instructions]`
 *
 * Proposes tests for the changed code. When we can find a sibling test file we
 * show it to the model so the output matches the repository's existing style
 * instead of inventing a framework.
 */
export const generateTestsCommand: CommandHandler = async (ctx) => {
  const changed = await ctx.client.getChangedFiles(ctx.prNumber);
  const changedPaths = changed.map((f) => f.filename);

  const { scope, question } = splitScopeAndQuestion(ctx.args, changedPaths);

  const { files } = await prepareFiles(
    { client: ctx.client, config: ctx.config, prNumber: ctx.prNumber },
    { scope: scope.length > 0 ? scope : undefined, limit: ctx.config.commands.max_explain_files },
  );

  if (files.length === 0) {
    return {
      comment: scope.length
        ? `I could not find any changed file matching \`${scope.join('`, `')}\`.`
        : 'I could not find any reviewable changed files to write tests for.',
    };
  }

  log.info(`Command /generate-tests: files=${files.length} question="${question}"`);

  // One file per request keeps the reply readable.
  const target = files[0]!;
  const pr = await ctx.client.getPullRequest(ctx.prNumber);
  const example = await findTestStyle(ctx, target.filename, pr.headSha);

  const res = await ctx.llm.complete(ctx.model, {
    messages: [
      { role: 'system', content: TESTS_SYSTEM },
      {
        role: 'user',
        content: testsUserPrompt({
          file: target.filename,
          annotatedPatch: trimToWindow(target.annotated, 30),
          existingTestExample: example,
          question,
        }),
      },
    ],
    maxTokens: 3000,
  });

  const body = res.text.trim() || '_I could not generate tests for this change._';
  const others =
    files.length > 1
      ? `\n\n<sub>Other changed files not covered here: ${files
          .slice(1)
          .map((f) => `\`${f.filename}\``)
          .join(', ')} — ask again with a path to focus on one.</sub>`
      : '';

  return {
    comment: `**Tests for \`${target.filename}\`**\n\n${body}${others}\n\n---\n<sub>🤖 prsentinel</sub>`,
    summary: `Proposed tests for ${target.filename}`,
  };
};

/**
 * Find a plausible existing test file for `filename` and return a truncated
 * slice of it, so the model can match the repository's conventions.
 *
 * Best-effort: returns '' when nothing obvious exists.
 */
async function findTestStyle(
  ctx: CommandContext,
  filename: string,
  headSha: string,
): Promise<string> {
  // Don't try to find tests for a test file.
  if (/(^|\/)(tests?|__tests__|spec)\//.test(filename) || /\.(test|spec)\./.test(filename)) {
    return '';
  }

  const tree = await ctx.client.listTreePaths(headSha);
  if (tree.length === 0) return '';

  const base = filename.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
  const stem = filename.replace(/\.[^.]+$/, '');
  const ext = filename.match(/\.[^.]+$/)?.[0] ?? '';

  const candidates = [
    `tests/${base}.test${ext}`,
    `test/${base}.test${ext}`,
    `__tests__/${base}.test${ext}`,
    `${stem}.test${ext}`,
    `${stem}.spec${ext}`,
    `tests/test_${base}.py`,
    `test_${base}.py`,
    `${base}_test.go`,
    `${stem}_test${ext}`,
  ];

  const found = tree.find((p) => candidates.some((c) => p === c || p.endsWith(`/${c}`)));
  if (!found) return '';

  const file = await ctx.client.getFileContent(found, headSha);
  if (!file) return '';

  // Enough to convey style, not enough to blow the token budget.
  const lines = file.content.split('\n').slice(0, 80).join('\n');
  return `// ${found}\n${lines}`;
}
