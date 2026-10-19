import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

/**
 * `.prsentinel.yaml` schema.
 *
 * Every field has a sensible default so a repo can adopt prsentinel with an
 * empty (or absent) config file and get a useful review immediately.
 */

export const CONFIG_FILENAMES = ['.prsentinel.yaml', '.prsentinel.yml'] as const;

export const configSchema = z.object({
  /** 1..5. Higher = deeper context and higher token budget. */
  effort: z.number().int().min(1).max(5).default(3),

  reviews: z
    .object({
      enabled: z.boolean().default(true),
      /** Skip draft PRs entirely. */
      drafts: z.boolean().default(false),
      /** Hard caps that protect the token budget on giant PRs. */
      max_files: z.number().int().min(1).max(1000).default(50),
      max_file_bytes: z.number().int().min(1024).default(200_000),
      max_total_diff_bytes: z.number().int().min(1024).default(1_500_000),
      max_comments_per_file: z.number().int().min(0).max(50).default(5),
      max_comments_per_pr: z.number().int().min(0).max(200).default(20),
      /** Drop findings whose LLM-reported confidence is below this. */
      confidence_threshold: z.number().min(0).max(1).default(0.6),
      /** Only review commits since the last prsentinel review. */
      incremental: z.boolean().default(true),
      /** Emit REQUEST_CHANGES instead of COMMENT when a critical is found. */
      request_changes_on_critical: z.boolean().default(false),
      /** Path filters. A leading `!` negates. Last match wins. */
      path_filters: z.array(z.string()).default([]),
      /** Suppress style findings when a linter is already configured. */
      respect_linters: z.boolean().default(true),
    })
    .default({}),

  chat: z
    .object({
      auto_reply: z.boolean().default(true),
    })
    .default({}),

  /** Hint injected into the prompt. Empty = let the model infer. */
  language: z.string().default(''),

  models: z
    .object({
      /** Model id for the review pipeline. e.g. "openai/gpt-4o-mini". */
      review: z.string().default(''),
      /** Cheaper model for chat/explain. Falls back to `review`. */
      chat: z.string().default(''),
    })
    .default({}),

  /**
   * Inline comment markdown template shown above every finding.
   * Placeholders: {{severity}}, {{category}}, {{title}}.
   */
  comment_prefix: z.string().default('**{{severity}}** · `{{category}}` · {{title}}'),
});

export type Config = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG: Config = configSchema.parse({});

/** Parse YAML text into a validated Config, merging over defaults. */
export function parseConfig(text: string): Config {
  const raw = parseYaml(text);
  if (raw === null || raw === undefined) return DEFAULT_CONFIG;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('.prsentinel.yaml must be a YAML mapping of settings');
  }
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid .prsentinel.yaml:\n${issues}`);
  }
  return result.data;
}

/** Load config from disk, or return defaults if no config file is present. */
export function loadConfig(repoRoot: string): { config: Config; path: string | null } {
  for (const name of CONFIG_FILENAMES) {
    const full = `${repoRoot}/${name}`;
    if (existsSync(full)) {
      return { config: parseConfig(readFileSync(full, 'utf8')), path: full };
    }
  }
  return { config: DEFAULT_CONFIG, path: null };
}

/**
 * Evaluate prsentinel path filters against a file path.
 *
 * Grammar is gitignore-adjacent and deliberately tiny:
 *   "docs/**"      → matches everything under docs/
 *   "!src/gen/**"  → negated, re-includes what a prior rule excluded
 *   "*.min.js"     → suffix match at any depth
 *
 * Last matching pattern wins, like gitignore.
 */
export function isPathFiltered(filters: string[], filePath: string): boolean {
  if (filters.length === 0) return false;
  const normalized = filePath.replace(/\\/g, '/');
  let ignored = false;
  for (const raw of filters) {
    const negate = raw.startsWith('!');
    const pattern = (negate ? raw.slice(1) : raw).trim();
    if (pattern === '') continue;
    if (globMatches(pattern, normalized)) ignored = !negate;
  }
  return ignored;
}

/** Minimal glob with gitignore semantics. Supports `**`, `*`, and literals. */
export function globMatches(pattern: string, value: string): boolean {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const two = pattern.slice(i, i + 2);
    const one = pattern[i]!;
    if (two === '**') {
      if (pattern.slice(i + 2, i + 3) === '/') {
        // `**/` matches zero or more leading directory segments.
        re += '(?:[^/]+/)*';
        i += 3;
      } else {
        re += '.*';
        i += 2;
      }
    } else if (one === '*') {
      re += '[^/]*';
      i += 1;
    } else {
      re += one.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${re}$`).test(value);
}

/** Effort → how many lines of surrounding context to gather per hunk. */
export function contextLinesForEffort(effort: number): number {
  switch (effort) {
    case 1:
      return 8;
    case 2:
      return 15;
    case 3:
      return 30;
    case 4:
      return 50;
    default:
      return 80;
  }
}
