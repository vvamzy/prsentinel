import { describe, it, expect } from 'vitest';
import { selectFiles } from '../src/review/select.js';
import { parseConfig, DEFAULT_CONFIG } from '../src/config.js';
import type { ChangedFile } from '../src/review/map.js';

function file(filename: string, over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    filename,
    status: 'modified',
    patch: '@@ -1,3 +1,4 @@\n a\n+b\n c\n d',
    changes: 4,
    ...over,
  };
}

describe('selectFiles', () => {
  it('selects ordinary source files', () => {
    const r = selectFiles([file('src/a.ts'), file('src/b.ts')], DEFAULT_CONFIG);
    expect(r.selected.map((f) => f.filename)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(r.skipped).toEqual([]);
  });

  it('skips generated files and lockfiles', () => {
    const r = selectFiles([file('package-lock.json'), file('src/a.ts')], DEFAULT_CONFIG);
    expect(r.selected.map((f) => f.filename)).toEqual(['src/a.ts']);
    expect(r.skipped[0]?.reason).toMatch(/generated or lockfile/);
  });

  it('skips paths matched by path_filters', () => {
    const config = parseConfig('reviews:\n  path_filters:\n    - "docs/**"\n');
    const r = selectFiles([file('docs/x.md'), file('src/a.ts')], config);
    expect(r.selected.map((f) => f.filename)).toEqual(['src/a.ts']);
    expect(r.skipped[0]?.reason).toBe('path filter');
  });

  it('skips files whose patch GitHub omitted', () => {
    const r = selectFiles([file('big.bin', { patch: null, changes: 5000 })], DEFAULT_CONFIG);
    expect(r.selected).toHaveLength(0);
    expect(r.skipped[0]?.reason).toMatch(/patch unavailable/);
  });

  it('enforces max_files', () => {
    const config = parseConfig('reviews:\n  max_files: 2\n');
    const r = selectFiles([file('a.ts'), file('b.ts'), file('c.ts')], config);
    expect(r.selected).toHaveLength(2);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]?.reason).toMatch(/max_files/);
  });

  it('enforces the total diff byte budget', () => {
    const big = 'x'.repeat(600);
    const config = parseConfig('reviews:\n  max_total_diff_bytes: 1024\n');
    const r = selectFiles([file('a.ts', { patch: big }), file('b.ts', { patch: big })], config);
    expect(r.selected).toHaveLength(1);
    expect(r.skipped[0]?.reason).toMatch(/total diff size cap/);
  });

  it('never sends a token for a skipped file', () => {
    const config = parseConfig('reviews:\n  max_files: 1\n');
    const r = selectFiles([file('a.ts'), file('b.ts')], config);
    // The point: `b.ts` is excluded from `selected`, so mapPhase never sees it.
    expect(r.selected.some((f) => f.filename === 'b.ts')).toBe(false);
  });

  it('handles an empty file list', () => {
    const r = selectFiles([], DEFAULT_CONFIG);
    expect(r.selected).toEqual([]);
    expect(r.skipped).toEqual([]);
  });
});
