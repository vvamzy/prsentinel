import { describe, it, expect } from 'vitest';
import {
  parseConfig,
  globMatches,
  isPathFiltered,
  contextLinesForEffort,
  DEFAULT_CONFIG,
} from '../src/config.js';

describe('parseConfig', () => {
  it('returns defaults for an empty document', () => {
    const c = parseConfig('');
    expect(c.effort).toBe(3);
    expect(c.reviews.max_files).toBe(50);
    expect(c.reviews.confidence_threshold).toBe(0.6);
  });

  it('merges partial overrides over defaults', () => {
    const c = parseConfig('effort: 5\nreviews:\n  max_files: 10\n  confidence_threshold: 0.8\n');
    expect(c.effort).toBe(5);
    expect(c.reviews.max_files).toBe(10);
    expect(c.reviews.confidence_threshold).toBe(0.8);
    // Untouched fields keep defaults.
    expect(c.reviews.max_comments_per_pr).toBe(20);
    expect(c.reviews.incremental).toBe(true);
  });

  it('rejects out-of-range values with a helpful message', () => {
    expect(() => parseConfig('effort: 99\n')).toThrow(/effort/);
    expect(() => parseConfig('reviews:\n  confidence_threshold: 5\n')).toThrow(/confidence_threshold/);
  });

  it('rejects non-mapping documents', () => {
    expect(() => parseConfig('- a\n- b\n')).toThrow(/YAML mapping/);
  });
});

describe('globMatches', () => {
  it('matches literal paths', () => {
    expect(globMatches('docs/readme.md', 'docs/readme.md')).toBe(true);
    expect(globMatches('docs/readme.md', 'docs/other.md')).toBe(false);
  });

  it('treats * as a single-segment wildcard', () => {
    // gitignore semantics: `*` does not cross path separators.
    expect(globMatches('*.min.js', 'app.min.js')).toBe(true);
    expect(globMatches('*.min.js', 'a/app.min.js')).toBe(false);
    expect(globMatches('**/*.min.js', 'a/app.min.js')).toBe(true);
  });

  it('treats ** as crossing path separators', () => {
    expect(globMatches('docs/**', 'docs/a/b/c.md')).toBe(true);
    expect(globMatches('**/package-lock.json', 'web/package-lock.json')).toBe(true);
    expect(globMatches('**/package-lock.json', 'package-lock.json')).toBe(true);
    expect(globMatches('**/dist/**', 'a/dist/b.js')).toBe(true);
  });

  it('escapes regex metacharacters in literals', () => {
    expect(globMatches('a+b.txt', 'a+b.txt')).toBe(true);
    expect(globMatches('a+b.txt', 'aab.txt')).toBe(false);
  });
});

describe('isPathFiltered', () => {
  it('is false with no filters', () => {
    expect(isPathFiltered([], 'src/index.ts')).toBe(false);
  });

  it('ignores a path matched by a plain pattern', () => {
    expect(isPathFiltered(['docs/**'], 'docs/a.md')).toBe(true);
    expect(isPathFiltered(['docs/**'], 'src/a.ts')).toBe(false);
  });

  it('re-includes via a later negated pattern', () => {
    const filters = ['docs/**', '!docs/keep.md'];
    expect(isPathFiltered(filters, 'docs/drop.md')).toBe(true);
    expect(isPathFiltered(filters, 'docs/keep.md')).toBe(false);
  });

  it('last match wins, like gitignore', () => {
    const filters = ['!src/gen/**', 'src/gen/**'];
    expect(isPathFiltered(filters, 'src/gen/x.ts')).toBe(true);
  });
});

describe('contextLinesForEffort', () => {
  it('scales with effort', () => {
    expect(contextLinesForEffort(1)).toBeLessThan(contextLinesForEffort(3));
    expect(contextLinesForEffort(3)).toBeLessThan(contextLinesForEffort(5));
    expect(contextLinesForEffort(3)).toBe(30);
  });
});

describe('DEFAULT_CONFIG', () => {
  it('is immutable-ish and fully populated', () => {
    expect(DEFAULT_CONFIG.models.review).toBe('');
    expect(DEFAULT_CONFIG.reviews.path_filters).toEqual([]);
    expect(DEFAULT_CONFIG.comment_prefix).toContain('{{severity}}');
  });
});
