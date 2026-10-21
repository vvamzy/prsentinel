import { parsePatch, clampRange, type ParsedPatch } from '../github/diff.js';
import { globMatches, isPathFiltered, type Config } from '../config.js';
import { compareFindings, type Finding } from './types.js';
import type { ChangedFile } from './map.js';

/**
 * The filter phase.
 *
 * This is deterministic, LLM-free, and the most important module for user
 * trust. Every step here exists because a specific class of bad comment
 * actually shipped and annoyed someone:
 *
 *   1. Hunk containment — a finding must land on lines that are actually in
 *      the diff. Otherwise GitHub 422s the whole review.
 *   2. Confidence threshold — drops hedged, low-value findings.
 *   3. Generated/lockfile skip — never comment on package-lock.json.
 *   4. Linter detection — if the repo already lints, suppress style nits.
 *   5. Caps — per-file and per-PR ceilings.
 *   6. Dedupe — collapse near-identical findings.
 *   7. Suggestion validity — a suggestion is code, not prose, or GitHub would
 *      offer to replace the developer's line with a sentence.
 */

export interface FilterResult {
  findings: Finding[];
  /** Findings demoted out of inline comments, kept for the walkthrough. */
  demoted: Finding[];
  stats: {
    before: number;
    after: number;
    droppedConfidence: number;
    droppedOutOfHunk: number;
    droppedFilteredPath: number;
    droppedDuplicate: number;
    droppedCap: number;
    suppressedStyle: number;
    /** Findings whose suggestion was prose, and so was not a suggestion. */
    strippedProseSuggestion: number;
  };
}

const GENERATED_PATTERNS = [
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/bun.lockb',
  '**/Cargo.lock',
  '**/go.sum',
  '**/poetry.lock',
  '**/composer.lock',
  '**/Gemfile.lock',
  '**/dist/**',
  '**/build/**',
  '**/node_modules/**',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.snap',
  '**/__generated__/**',
  '**/generated/**',
  '**/*.pb.go',
  '**/*.generated.*',
  '**/*.svg',
];

/** Filenames that suggest an existing linter/formatter is configured. */
const STYLE_LINTER_MARKERS: string[] = [
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.ts',
  '.prettierrc',
  '.prettierrc.js',
  '.prettierrc.json',
  'prettier.config.js',
  '.rubocop.yml',
  'ruff.toml',
  '.flake8',
  'setup.cfg',
  'pyproject.toml',
  '.editorconfig',
  '.clang-format',
  'rustfmt.toml',
  '.golangci.yml',
  '.golangci.yaml',
];

export function isGeneratedFile(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  return GENERATED_PATTERNS.some((p) => globMatches(p, normalized));
}

/** Detect whether the PR touches linter config files, implying style is covered. */
export function detectLinters(files: string[]): boolean {
  return files.some((f) => {
    const base = f.split('/').pop() ?? f;
    return STYLE_LINTER_MARKERS.some((m) => base === m || f.endsWith(`/${m}`));
  });
}

/**
 * Apply all filters. `parsedByFile` must contain a parsed patch for every
 * file that has findings.
 */
export function filterFindings(
  findings: Finding[],
  opts: {
    config: Config;
    changedFiles: ChangedFile[];
    /** filename → parsed patch. */
    parsedByFile: Map<string, ParsedPatch>;
    /** Filenames present anywhere in the PR, used for linter detection. */
    allPrFiles: string[];
  },
): FilterResult {
  const { config, changedFiles, parsedByFile, allPrFiles } = opts;
  const stats: FilterResult['stats'] = {
    before: findings.length,
    after: 0,
    droppedConfidence: 0,
    droppedOutOfHunk: 0,
    droppedFilteredPath: 0,
    droppedDuplicate: 0,
    droppedCap: 0,
    suppressedStyle: 0,
    strippedProseSuggestion: 0,
  };

  const respectLinters = config.reviews.respect_linters && detectLinters(allPrFiles);

  // Step 3+4: drop generated files and style nits when a linter exists.
  let working = findings.filter((f) => {
    if (isGeneratedFile(f.file)) {
      stats.droppedFilteredPath++;
      return false;
    }
    if (isPathFiltered(config.reviews.path_filters, f.file)) {
      stats.droppedFilteredPath++;
      return false;
    }
    if (respectLinters && f.category === 'style') {
      stats.suppressedStyle++;
      return false;
    }
    return true;
  });

  // Step 2: confidence threshold.
  const threshold = config.reviews.confidence_threshold;
  working = working.filter((f) => {
    if (f.confidence < threshold) {
      stats.droppedConfidence++;
      return false;
    }
    return true;
  });

  // Step 1: hunk containment + range clamping.
  const inHunk: Finding[] = [];
  for (const f of working) {
    const parsed = parsedByFile.get(f.file);
    if (!parsed) {
      stats.droppedOutOfHunk++;
      continue;
    }
    const start = f.startLine ?? f.line;
    const clamped = clampRange(parsed, start, f.line);
    if (!clamped) {
      stats.droppedOutOfHunk++;
      continue;
    }
    const adjusted: Finding = { ...f, line: clamped.endLine };
    if (clamped.startLine < clamped.endLine) adjusted.startLine = clamped.startLine;
    else delete adjusted.startLine;
    inHunk.push(adjusted);
  }
  working = inHunk;

  // Step 7: a suggestion is code, not prose.
  //
  // GitHub renders a ```suggestion block as an applicable change, so a sentence
  // in one would replace the commented lines with a sentence. A model that was
  // asked for a drop-in replacement and answered with an instruction has not
  // made a suggestion, so the suggestion goes and the explanation stays.
  //
  // Documentation is the exception: there, prose *is* the content, and a
  // replacement for a sentence is a sentence.
  working = working.map((f) => {
    if (f.suggestion === undefined) return f;
    if (isDocumentationFile(f.file)) return f;
    if (!isProse(f.suggestion)) return f;
    stats.strippedProseSuggestion++;
    const { suggestion: _prose, ...rest } = f;
    return rest;
  });

  // Step 6: dedupe by (file, line, category) and by normalized title.
  const seenLine = new Set<string>();
  const seenTitle = new Set<string>();
  working = working.filter((f) => {
    const lineKey = `${f.file}:${f.startLine ?? f.line}:${f.line}:${f.category}`;
    if (seenLine.has(lineKey)) {
      stats.droppedDuplicate++;
      return false;
    }
    const titleKey = `${f.file}:${normalizeTitle(f.title)}`;
    if (seenTitle.has(titleKey)) {
      stats.droppedDuplicate++;
      return false;
    }
    seenLine.add(lineKey);
    seenTitle.add(titleKey);
    return true;
  });

  // Sort, then apply per-file and per-PR caps.
  working.sort(compareFindings);

  const perFileCap = config.reviews.max_comments_per_file;
  const perPrCap = config.reviews.max_comments_per_pr;
  const perFileCount = new Map<string, number>();
  let prCount = 0;
  working = working.filter((f) => {
    if (prCount >= perPrCap) {
      stats.droppedCap++;
      return false;
    }
    const n = perFileCount.get(f.file) ?? 0;
    if (n >= perFileCap) {
      stats.droppedCap++;
      return false;
    }
    perFileCount.set(f.file, n + 1);
    prCount++;
    return true;
  });

  stats.after = working.length;
  return { findings: working, demoted: [], stats };
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
}

/**
 * True when a block of text reads as prose rather than code.
 *
 * The test is deliberately conservative: a line only counts as prose when it
 * reads like a sentence — several words, ending in sentence punctuation, and
 * free of the punctuation that code is made of. Diff markers and comments are
 * neither, so a suggestion that is a diff with a sentence wrapped around it
 * still counts as prose: the sentence is the part that would land in the
 * developer's file.
 */
export function isProse(text: string): boolean {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return false;

  let prose = 0;
  let code = 0;
  for (const line of lines) {
    if (/^[+\-@]/.test(line)) continue;
    if (/^(?:\/\/|#|\*|\/\*)/.test(line)) continue;
    if (isSentence(line)) prose++;
    else code++;
  }
  return prose > 0 && code === 0;
}

/** True when a line reads like an English sentence. */
function isSentence(line: string): boolean {
  // A suggestion often ends inside a quotation, so the closing quote is not
  // part of the sentence's punctuation.
  const trimmed = line.replace(/["'`)\]}]+$/, '').trim();
  if (!/[.!?]$/.test(trimmed)) return false;
  if (trimmed.split(/\s+/).length < 4) return false;
  // Code does not usually end a line with a full stop after several words.
  if (/[=;{}[\]]|=>|\b(?:function|const|let|var|return|import|export)\b/.test(trimmed)) return false;
  return true;
}

/** Extensions whose content is prose, where a prose replacement is content. */
const DOCUMENTATION_EXTENSIONS = ['.md', '.markdown', '.mdx', '.rst', '.txt', '.adoc', '.asciidoc'];

/** True for files whose lines are prose rather than code. */
export function isDocumentationFile(file: string): boolean {
  const lower = file.toLowerCase();
  return DOCUMENTATION_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Build the parsed-patch index used by the filter. Files without a patch
 * simply aren't indexed, so findings on them are dropped as out-of-hunk.
 */
export function buildPatchIndex(files: ChangedFile[]): Map<string, ParsedPatch> {
  const index = new Map<string, ParsedPatch>();
  for (const f of files) {
    if (!f.patch) continue;
    try {
      index.set(f.filename, parsePatch(f.patch));
    } catch {
      // Malformed patch; leave unindexed so findings get dropped safely.
    }
  }
  return index;
}

export { isPathFiltered };
