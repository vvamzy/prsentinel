import type { Config } from '../config.js';
import type { Finding } from './types.js';

/**
 * Prompt templates for the review pipeline.
 *
 * Design notes:
 *  - The MAP prompt asks for a JSON object only. No prose. Structured
 *    output is enforced at the provider level where supported.
 *  - Findings must reference a line number that is actually visible in the
 *    annotated patch. The model is told this explicitly, and the filter
 *    phase re-checks it deterministically.
 *  - We ask for `confidence` so the filter can drop hedged, low-value
 *    findings instead of posting them.
 */

export const SYSTEM_PROMPT = `You are prsentinel, a precise and skeptical code reviewer.
You review pull requests for real defects, not style opinions.

Rules:
- Only report problems you are confident about. A wrong comment costs a
  reviewer more than a missed nit.
- Read the changed lines back before you report. If they already do what you
  are about to ask for — or already document what you say is missing — there is
  nothing to report.
- Every finding MUST reference a line number that appears in the annotated
  patch. Never invent line numbers.
- Prefer findings in the changed code. Do not review unchanged lines except
  to explain how a change breaks existing behavior.
- Do not report formatting, naming, or linting issues that an existing
  linter would catch. Assume the repo has a linter unless told otherwise.
  Whitespace is a linter's job, never yours.
- Do not suggest adding logs, comments, or types unless the absence causes a
  concrete bug.
- A suggestion must be a drop-in replacement for the exact lines it spans.
  It must compile and preserve behavior outside the stated problem.
- A suggestion is code, never prose. If you cannot write the replacement code,
  set the suggestion to null and put the advice in the body.

Severity guide:
- critical: security vulnerability, data loss, crash, or logic error that
  will definitely cause a bug in production.
- major: likely bug, broken edge case, race condition, resource leak, or a
  significant performance problem.
- minor: real but narrow issue — dead code, unreachable branch, small
  maintainability hazard, missing test for a tricky path.
- info: useful context or an improvement that is genuinely optional.

Output: emit only the JSON object described in the schema. No prose.`;

export function mapUserPrompt(params: {
  file: string;
  status: string;
  languageHint: string;
  annotatedPatch: string;
  contextBefore?: string;
  contextAfter?: string;
  isLarge: boolean;
}): string {
  const parts: string[] = [];
  parts.push(`Review this pull request change to \`${params.file}\` (status: ${params.status}).`);
  if (params.languageHint) parts.push(`Primary language: ${params.languageHint}.`);
  if (params.isLarge) {
    parts.push(
      'This is a large change. Focus on the highest-impact problems only; do not report more than the five most important findings.',
    );
  }
  if (params.contextBefore) {
    parts.push(`--- Context BEFORE the change (base branch) ---\n${params.contextBefore}`);
  }
  parts.push(`--- Change (annotated: line number, +/- marker, content) ---\n${params.annotatedPatch}`);
  if (params.contextAfter) {
    parts.push(`--- Context AFTER the change (head) ---\n${params.contextAfter}`);
  }
  parts.push('Analyze the change and emit the JSON object.');
  return parts.join('\n\n');
}

export function reduceUserPrompt(params: {
  prTitle: string;
  prBody: string;
  fileSummaries: string;
  findingsJson: string;
  changedFiles: string[];
}): string {
  const parts: string[] = [];
  parts.push(`Summarize this pull request for a reviewer.\n\nTitle: ${params.prTitle}`);
  if (params.prBody) parts.push(`Description:\n${params.prBody.slice(0, 4000)}`);
  parts.push(`Changed files: ${params.changedFiles.join(', ')}`);
  parts.push(`--- Per-file summaries ---\n${params.fileSummaries}`);
  parts.push(`--- Candidate findings (JSON) ---\n${params.findingsJson}`);
  parts.push(
    'Produce: (1) a walkthrough of what the PR does and anything a reviewer must check, ' +
      '(2) the final de-duplicated finding set. Drop findings that are duplicates, ' +
      'speculative, or low-confidence. Re-rank by severity.',
  );
  return parts.join('\n\n');
}

/** JSON Schema handed to providers for the MAP phase. */
export const MAP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: {
      type: 'string',
      description: 'One or two sentences describing what this file change does.',
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          line: { type: 'integer', description: '1-based line number in the NEW file.' },
          start_line: {
            type: ['integer', 'null'],
            description: 'Inclusive start for multi-line findings, else null.',
          },
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'info'] },
          category: {
            type: 'string',
            enum: ['bug', 'security', 'performance', 'maintainability', 'style', 'test', 'docs'],
          },
          title: { type: 'string', description: 'Short headline.' },
          body: { type: 'string', description: 'Markdown explaining the problem.' },
          suggestion: {
            type: ['string', 'null'],
            description:
              'Replacement code for start_line..line, else null. Code only — never prose.',
          },
          confidence: { type: 'number', description: '0..1' },
        },
        required: ['line', 'start_line', 'severity', 'category', 'title', 'body', 'suggestion', 'confidence'],
      },
    },
  },
  required: ['summary', 'findings'],
};

/** JSON Schema for the REDUCE phase. */
export const REDUCE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    walkthrough: {
      type: 'string',
      description: 'Markdown walkthrough for the top of the review.',
    },
    file_summaries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['file', 'summary'],
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          start_line: { type: ['integer', 'null'] },
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'info'] },
          category: {
            type: 'string',
            enum: ['bug', 'security', 'performance', 'maintainability', 'style', 'test', 'docs'],
          },
          title: { type: 'string' },
          body: { type: 'string' },
          suggestion: { type: ['string', 'null'] },
          confidence: { type: 'number' },
        },
        required: ['file', 'line', 'start_line', 'severity', 'category', 'title', 'body', 'suggestion', 'confidence'],
      },
    },
  },
  required: ['walkthrough', 'file_summaries', 'findings'],
};

/** Apply the comment_prefix template to a finding. */
export function renderCommentPrefix(config: Config, f: Finding): string {
  return config.comment_prefix
    .replace(/\{\{severity\}\}/g, f.severity)
    .replace(/\{\{category\}\}/g, f.category)
    .replace(/\{\{title\}\}/g, f.title);
}

/** Assemble the full markdown body of one inline review comment. */
export function renderCommentBody(config: Config, f: Finding): string {
  const parts = [renderCommentPrefix(config, f), '', f.body];
  if (f.suggestion && f.suggestion.trim() !== '') {
    parts.push('', '```suggestion', f.suggestion.replace(/\n$/, ''), '```');
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Slash-command prompts
//
// These render *reply comments*, not inline review comments. They therefore
// return plain markdown rather than a findings array — there is nowhere to
// anchor an inline comment when the user just asks a question.
// ---------------------------------------------------------------------------

export const COMMAND_SYSTEM = `You are prsentinel, a precise and skeptical code reviewer.
You are answering a developer who asked about a specific pull request.

Rules:
- Answer the question that was asked. Do not produce a generic code review.
- Ground every claim in the code you were given. Quote the relevant lines.
- If you are unsure, say so plainly. Do not guess at behaviour you cannot see.
- Use markdown. Prefer short paragraphs and bullet lists over walls of text.
- Reference code as \`path:line\` so the developer can jump straight there.
- Keep it under roughly 400 words unless the question genuinely requires more.

Output: markdown only. No preamble, no closing pleasantries.`;

export function explainUserPrompt(params: {
  prTitle: string;
  prBody: string;
  question: string;
  fileSections: string;
}): string {
  const parts: string[] = [];
  parts.push(`Pull request: ${params.prTitle}`);
  if (params.prBody) parts.push(`Description:\n${params.prBody.slice(0, 2000)}`);
  parts.push(`--- Changed code ---\n${params.fileSections}`);
  parts.push(
    params.question
      ? `--- Question ---\n${params.question}`
      : '--- Question ---\nExplain what this change does, how it affects existing behaviour, and anything a reviewer should scrutinise.',
  );
  return parts.join('\n\n');
}

export const TESTS_SYSTEM = `You are prsentinel, writing tests for a pull request's changed code.

Rules:
- Propose tests that would actually catch a regression in the changed lines.
- Match the framework, style, and naming already used in the repository if
  examples were provided. If none were provided, say which framework you
  assumed.
- Cover the unhappy paths: empty input, boundaries, error propagation, and the
  specific branch the change introduces.
- Do not test framework behaviour or trivial getters.
- Output real, runnable code in fenced blocks with the correct language tag.
- If the change is genuinely untestable as written, say why and suggest the
  smallest refactor that would make it testable.

Output: markdown only.`;

export function testsUserPrompt(params: {
  file: string;
  annotatedPatch: string;
  existingTestExample: string;
  question: string;
}): string {
  const parts: string[] = [];
  parts.push(`Write tests covering this change to \`${params.file}\`.`);
  parts.push(`--- Change (annotated) ---\n${params.annotatedPatch}`);
  if (params.existingTestExample) {
    parts.push(`--- Example of this repository's existing test style ---\n${params.existingTestExample}`);
  }
  if (params.question) parts.push(`--- Additional request ---\n${params.question}`);
  parts.push('Propose the tests.');
  return parts.join('\n\n');
}

export const CHAT_SYSTEM = `You are prsentinel, replying inside a pull request review thread.

Rules:
- A reviewer or author replied to one of your findings. Respond to that reply.
- Be concise: two or three sentences is usually right. This is a thread, not an
  essay.
- If they push back and they are right, concede clearly and say what you got
  wrong. Do not defend a bad finding.
- If they push back and the issue is real, restate the problem in one sentence
  and offer the smallest fix.
- Never repeat the entire original finding back at them.
- If they ask you to do something you cannot do, say so.

Output: markdown only, no preamble.`;

export function chatUserPrompt(params: {
  thread: string;
  diff: string;
  reply: string;
}): string {
  const parts: string[] = [];
  parts.push(`--- Review thread so far ---\n${params.thread}`);
  if (params.diff) parts.push(`--- Relevant diff ---\n${params.diff}`);
  parts.push(`--- Latest reply from the developer ---\n${params.reply}`);
  parts.push('Write your reply.');
  return parts.join('\n\n');
}

/** Render a PR's changed files into compact sections for a prompt. */
export function renderFileSections(
  files: Array<{ filename: string; annotated: string; summary?: string }>,
): string {
  return files
    .map((f) => {
      const head = `### ${f.filename}`;
      const summary = f.summary ? `\n_${f.summary}_\n` : '';
      return `${head}${summary}\n${f.annotated}`;
    })
    .join('\n\n');
}
