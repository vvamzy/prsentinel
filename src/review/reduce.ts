import type { LLM } from '../llm/registry.js';
import { REDUCE_SCHEMA, SYSTEM_PROMPT, reduceUserPrompt } from './prompts.js';
import { normalizeFindings } from './map.js';
import {
  addUsage,
  emptyUsage,
  type FileAnalysis,
  type FileSummary,
  type ReviewPlan,
} from './types.js';

/**
 * Reduce phase: one LLM call that synthesizes the walkthrough and
 * de-duplicates the per-file findings.
 *
 * We deliberately feed the model the file *summaries*, not the raw diffs.
 * That keeps the walkthrough readable and the token count bounded even on a
 * 50-file PR.
 */
export async function reducePhase(
  llm: LLM,
  model: string,
  params: {
    prTitle: string;
    prBody: string;
    analyses: FileAnalysis[];
  },
): Promise<ReviewPlan> {
  const { prTitle, prBody, analyses } = params;

  // Nothing to summarize.
  const nonEmpty = analyses.filter((a) => a.summary !== '' || a.findings.length > 0);
  if (nonEmpty.length === 0) {
    return {
      walkthrough: 'No reviewable changes were found.',
      findings: [],
      fileSummaries: [],
      usage: emptyUsage(),
    };
  }

  const fileSummariesText = nonEmpty
    .map((a) => `### ${a.file}\n${a.summary || '(no summary)'}`)
    .join('\n\n');

  const findingsJson = JSON.stringify(
    nonEmpty.flatMap((a) => a.findings.map((f) => ({ ...f, file: a.file }))),
    null,
    1,
  );

  const res = await llm.complete(model, {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: reduceUserPrompt({
          prTitle,
          prBody,
          fileSummaries: fileSummariesText,
          findingsJson,
          changedFiles: nonEmpty.map((a) => a.file),
        }),
      },
    ],
    schema: REDUCE_SCHEMA,
    maxTokens: 4096,
  });

  const parsed = res.parsed as
    | { walkthrough?: string; file_summaries?: Array<{ file: string; summary: string }>; findings?: unknown[] }
    | undefined;

  if (!parsed) {
    // Degrade gracefully: fall back to per-file summaries and raw findings.
    return {
      walkthrough: buildFallbackWalkthrough(prTitle, nonEmpty),
      findings: nonEmpty.flatMap((a) => a.findings),
      fileSummaries: nonEmpty
        .filter((a) => a.summary)
        .map((a) => ({ file: a.file, summary: a.summary })),
      usage: res.usage,
    };
  }

  const fileSummaries: FileSummary[] = (parsed.file_summaries ?? [])
    .filter((s) => typeof s.file === 'string' && typeof s.summary === 'string')
    .map((s) => ({ file: s.file as string, summary: (s.summary as string).trim() }));

  // Re-normalize reduce findings through the same lenient parser.
  const findings = (parsed.findings ?? []).flatMap((f) => {
    const rec = f as Record<string, unknown>;
    const file = typeof rec.file === 'string' ? rec.file : '';
    if (file === '') return [];
    return normalizeFindings(file, [rec]);
  });

  return {
    walkthrough: (parsed.walkthrough ?? '').trim() || buildFallbackWalkthrough(prTitle, nonEmpty),
    findings,
    fileSummaries,
    usage: addUsage(res.usage, emptyUsage()),
  };
}

function buildFallbackWalkthrough(title: string, analyses: FileAnalysis[]): string {
  const lines = [`**${title}**`, ''];
  for (const a of analyses) {
    if (a.summary) lines.push(`- \`${a.file}\` — ${a.summary}`);
  }
  const total = analyses.reduce((n, a) => n + a.findings.length, 0);
  if (total > 0) {
    lines.push('', `${total} finding(s) inline.`);
  }
  return lines.join('\n');
}
