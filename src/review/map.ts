import type { LLMFacade } from '../llm/registry.js';
import { mapWithConcurrency } from '../llm/provider.js';
import { contextLinesForEffort, isPathFiltered, type Config } from '../config.js';
import { log } from '../log.js';
import {
  MAP_SCHEMA,
  SYSTEM_PROMPT,
  mapUserPrompt,
} from './prompts.js';
import { annotatePatch, parsePatch } from '../github/diff.js';
import {
  addUsage,
  emptyUsage,
  type FileAnalysis,
  type FileSummary,
  type Finding,
  type ReviewPlan,
} from './types.js';

/** One changed file, already fetched from the GitHub API. */
export interface ChangedFile {
  filename: string;
  previous_filename?: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  /** Raw unified diff patch. Null when GitHub truncated or it's binary. */
  patch: string | null;
  /** Total changed lines, from the API's `changes` field. */
  changes: number;
}

/** Full head-version content of a file, used as context. */
export interface FileContext {
  filename: string;
  content: string;
  truncated: boolean;
}

export interface GatheredPr {
  title: string;
  body: string;
  headSha: string;
  baseSha: string;
  number: number;
  files: ChangedFile[];
  /** filename → full head content, only for files we decided to fetch. */
  contexts: Map<string, FileContext>;
  /** Files skipped by filters/caps, with the reason, for the summary. */
  skipped: Array<{ file: string; reason: string }>;
}

/** Map phase: run one independent LLM call per changed file, in parallel. */
export async function mapPhase(
  llm: LLMFacade,
  model: string,
  gathered: GatheredPr,
  config: Config,
  signal?: AbortSignal,
): Promise<FileAnalysis[]> {
  const languageHint = config.language;
  // A server on loopback serves one request at a time, so the facade caps this
  // at 1 rather than letting six calls queue behind a single slot.
  const concurrency = Math.min(llm.concurrency(model), Math.max(1, gathered.files.length));

  const results = await mapWithConcurrency(gathered.files, concurrency, async (file) => {
    if (signal?.aborted) {
      return emptyAnalysis(file.filename);
    }
    const parsed = file.patch ? parsePatch(file.patch) : null;
    const isLarge = file.changes > 400;
    const context = gathered.contexts.get(file.filename);

    const annotated = parsed
      ? annotatePatch(parsed)
      : '(patch unavailable — the file was too large or binary to include)';

    const prompt = mapUserPrompt({
      file: file.filename,
      status: file.status,
      languageHint,
      annotatedPatch: annotated,
      ...(context?.content ? { contextAfter: context.content } : {}),
      isLarge,
    });

    try {
      const res = await llm.complete(model, {
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        schema: MAP_SCHEMA,
        // One file, a summary and at most five findings. A generous cap is not
        // free: a CPU-only runner generates a few tokens per second, so 4096
        // tokens is a seventeen-minute ceiling, and a model that starts
        // rambling spends all of it and returns unparseable JSON.
        maxTokens: 1024,
      });

      const parsed = res.parsed as { summary?: string; findings?: unknown[] } | undefined;
      if (!parsed) {
        log.warn(`map: no structured output for ${file.filename}; skipping`);
        return { ...emptyAnalysis(file.filename), usage: res.usage };
      }

      if (res.repaired) {
        log.warn(
          `map: ${file.filename} hit the token limit; recovered a truncated response`,
        );
      }

      const findings = normalizeFindings(file.filename, parsed.findings ?? []);
      return {
        file: file.filename,
        findings,
        summary: (parsed.summary ?? '').trim(),
        usage: res.usage,
      } satisfies FileAnalysis;
    } catch (err) {
      log.warn(`map: analysis failed for ${file.filename}: ${String(err)}`);
      return emptyAnalysis(file.filename);
    }
  });

  return results.filter((r): r is FileAnalysis => r !== null);
}

function emptyAnalysis(file: string): FileAnalysis {
  return { file, findings: [], summary: '', usage: emptyUsage() };
}

/**
 * Coerce untyped model output into Finding[].
 *
 * Deliberately lenient on types (numbers may arrive as strings) but strict
 * on invariants: line must be a positive integer, confidence clamped to 0..1.
 */
export function normalizeFindings(file: string, raw: unknown[]): Finding[] {
  const out: Finding[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;

    const line = toPositiveInt(r.line);
    if (line === null) continue;

    const startRaw = r.start_line ?? r.startLine ?? null;
    const startLine = toPositiveInt(startRaw);

    const severity = String(r.severity ?? 'info').toLowerCase();
    if (!['critical', 'major', 'minor', 'info'].includes(severity)) continue;

    const category = String(r.category ?? 'maintainability').toLowerCase();
    const safeCategory = (
      ['bug', 'security', 'performance', 'maintainability', 'style', 'test', 'docs'].includes(category)
        ? category
        : 'maintainability'
    ) as Finding['category'];

    const title = String(r.title ?? '').trim();
    const body = String(r.body ?? '').trim();
    if (title === '' && body === '') continue;

    const suggestion = readSuggestion(r.suggestion);

    const confidence = clamp01(Number(r.confidence));

    const finding: Finding = {
      file,
      line,
      severity: severity as Finding['severity'],
      category: safeCategory,
      title: title || 'Issue',
      body,
      confidence,
    };
    if (startLine !== null && startLine < line) finding.startLine = startLine;
    if (suggestion !== undefined && suggestion.trim() !== '') finding.suggestion = suggestion;
    out.push(finding);
  }
  return out;
}

function toPositiveInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.floor(n);
}

/**
 * Read the model's replacement code, if it offered any.
 *
 * A model asked for "no suggestion" will answer in more ways than JSON null:
 * the string "null", "none", "n/a", an empty string. All of them mean the same
 * thing, and posting any of them as a ```suggestion block would offer the
 * reader a change that replaces their line with the word "null".
 */
function readSuggestion(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const text = String(raw);
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  if (['null', 'undefined', 'none', 'n/a', 'na', '-'].includes(trimmed.toLowerCase())) {
    return undefined;
  }
  return text;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

export { addUsage, isPathFiltered, contextLinesForEffort };
export type { FileSummary };
