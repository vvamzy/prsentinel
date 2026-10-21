import type { LLMFacade } from '../llm/registry.js';
import { REDUCE_SCHEMA, SYSTEM_PROMPT, reduceUserPrompt } from './prompts.js';
import { log } from '../log.js';
import {
  addUsage,
  emptyUsage,
  type FileAnalysis,
  type FileSummary,
  type Finding,
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
  llm: LLMFacade,
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

  // Number the findings so the model can talk about them without repeating
  // them. The suggestion code is left out of the prompt: it is the bulkiest
  // part of a finding and the model has no reason to judge on it.
  const candidates: Array<{ id: string; finding: Finding }> = [];
  for (const a of nonEmpty) {
    for (const f of a.findings) {
      candidates.push({ id: `F${candidates.length + 1}`, finding: { ...f, file: a.file } });
    }
  }

  const findingsJson = JSON.stringify(
    candidates.map(({ id, finding }) => ({
      id,
      file: finding.file,
      line: finding.line,
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
      body: finding.body,
      confidence: finding.confidence,
    })),
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
    // The reduce phase now writes a walkthrough, a summary per file and a list
    // of ids to drop — not the findings themselves. The same arithmetic as the
    // map phase: on a CPU-only runner every token costs real seconds, so an
    // unbounded cap is an unbounded wait.
    maxTokens: 1024,
  });

  const parsed = res.parsed as
    | {
        walkthrough?: string;
        file_summaries?: Array<{ file: string; summary: string }>;
        drop?: unknown[];
      }
    | undefined;

  if (!parsed) {
    // Degrade gracefully: fall back to per-file summaries and raw findings.
    return {
      walkthrough: buildFallbackWalkthrough(prTitle, nonEmpty),
      findings: candidates.map((c) => c.finding),
      fileSummaries: nonEmpty
        .filter((a) => a.summary)
        .map((a) => ({ file: a.file, summary: a.summary })),
      usage: res.usage,
    };
  }

  if (res.repaired) {
    log.warn('Reduce phase hit the token limit; recovered a truncated response');
  }

  const fileSummaries: FileSummary[] = (parsed.file_summaries ?? [])
    .filter((s) => typeof s.file === 'string' && typeof s.summary === 'string')
    .map((s) => ({ file: s.file as string, summary: (s.summary as string).trim() }));

  // The model judges; it does not rewrite. A finding survives unless its id is
  // in `drop`, so a response that was cut off before the list — or that named
  // ids that do not exist — cannot silently remove a real finding.
  const dropped = new Set(
    (parsed.drop ?? [])
      .filter((id): id is string => typeof id === 'string')
      .map((id) => id.trim().toUpperCase()),
  );
  const findings = candidates
    .filter(({ id }) => !dropped.has(id))
    .map(({ finding }) => finding);

  const walkthrough = (parsed.walkthrough ?? '').trim();
  return {
    // A repaired response may end mid-sentence; publish the part that is whole.
    walkthrough: walkthrough
      ? res.repaired
        ? trimToLastSentence(walkthrough)
        : walkthrough
      : buildFallbackWalkthrough(prTitle, nonEmpty),
    findings,
    fileSummaries: fileSummaries.length > 0 ? fileSummaries : fallbackFileSummaries(nonEmpty),
    usage: addUsage(res.usage, emptyUsage()),
  };
}

function fallbackFileSummaries(analyses: FileAnalysis[]): FileSummary[] {
  return analyses
    .filter((a) => a.summary)
    .map((a) => ({ file: a.file, summary: a.summary }));
}

/** Cut a truncated walkthrough back to its last complete sentence. */
function trimToLastSentence(text: string): string {
  const cut = Math.max(text.lastIndexOf('. '), text.lastIndexOf('.\n'), text.lastIndexOf('\n'));
  if (cut === -1) return text;
  return text.slice(0, cut + 1).trim();
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
