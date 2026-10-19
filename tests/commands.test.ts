import { describe, it, expect } from 'vitest';
import { splitScopeAndQuestion, trimToWindow } from '../src/commands/shared.js';
import { applyScope } from '../src/pipeline.js';
import { getCommandHandler, commandHelp } from '../src/commands/index.js';
import type { ChangedFile } from '../src/review/map.js';

function file(filename: string): ChangedFile {
  return { filename, status: 'modified', patch: '@@ -1,2 +1,3 @@\n a\n+b\n c', changes: 3 };
}

describe('splitScopeAndQuestion', () => {
  const files = ['src/payments/charge.ts', 'src/lib/rate-limit.ts', 'docs/rate-limiting.md'];

  it('extracts a matching path and keeps the rest as the question', () => {
    const r = splitScopeAndQuestion('src/payments/charge.ts why not transactional', files);
    expect(r.scope).toEqual(['src/payments/charge.ts']);
    expect(r.question).toBe('why not transactional');
  });

  it('treats a bare question as a question when no path matches', () => {
    const r = splitScopeAndQuestion('why is this not transactional', files);
    expect(r.scope).toEqual([]);
    expect(r.question).toBe('why is this not transactional');
  });

  it('accepts a directory prefix and strips backticks', () => {
    const r = splitScopeAndQuestion('`src/lib` what does this do', files);
    expect(r.scope).toEqual(['src/lib']);
    expect(r.question).toBe('what does this do');
  });

  it('does not swallow a word that merely looks like a path', () => {
    const r = splitScopeAndQuestion('src is confusing', files);
    // "src" is not itself a changed file nor a prefix of one -> question.
    expect(r.scope).toEqual([]);
    expect(r.question).toBe('src is confusing');
  });

  it('returns empty for empty args', () => {
    expect(splitScopeAndQuestion('', files)).toEqual({ scope: [], question: '' });
  });

  it('supports multiple paths', () => {
    const r = splitScopeAndQuestion('src/lib/rate-limit.ts docs/rate-limiting.md explain both', files);
    expect(r.scope).toEqual(['src/lib/rate-limit.ts', 'docs/rate-limiting.md']);
    expect(r.question).toBe('explain both');
  });
});

describe('trimToWindow', () => {
  const annotated = [
    '@@ -1,20 +1,21 @@',
    '   1   a',
    '   2   b',
    '   3 + added',
    '   4   c',
    '   5   d',
    '   6   e',
    '   7   f',
    '   8   g',
  ].join('\n');

  it('keeps a hunk header', () => {
    expect(trimToWindow(annotated, 1)).toContain('@@ -1,20 +1,21 @@');
  });

  it('drops rows far from any changed line', () => {
    const trimmed = trimToWindow(annotated, 1);
    expect(trimmed).toContain('added');
    expect(trimmed).not.toContain('   8   g');
  });

  it('returns the input unchanged when there are no changed rows', () => {
    const noAdds = '@@ -1,3 +1,3 @@\n   1   a\n   2   b\n   3   c';
    expect(trimToWindow(noAdds, 2)).toBe(noAdds);
  });
});

describe('applyScope', () => {
  const files = [file('src/a.ts'), file('src/lib/b.ts'), file('docs/c.md')];

  it('returns everything for an empty scope', () => {
    expect(applyScope(files, undefined).map((f) => f.filename)).toEqual([
      'src/a.ts',
      'src/lib/b.ts',
      'docs/c.md',
    ]);
  });

  it('matches an exact file', () => {
    expect(applyScope(files, ['src/a.ts']).map((f) => f.filename)).toEqual(['src/a.ts']);
  });

  it('matches a directory prefix', () => {
    expect(applyScope(files, ['src/lib']).map((f) => f.filename)).toEqual(['src/lib/b.ts']);
  });

  it('matches a basename suffix', () => {
    expect(applyScope(files, ['b.ts']).map((f) => f.filename)).toEqual(['src/lib/b.ts']);
  });

  it('normalizes a leading ./', () => {
    expect(applyScope(files, ['./src/a.ts']).map((f) => f.filename)).toEqual(['src/a.ts']);
  });
});

describe('command registry', () => {
  it('resolves implemented commands', () => {
    expect(getCommandHandler('review')).toBeTypeOf('function');
    expect(getCommandHandler('explain')).toBeTypeOf('function');
    expect(getCommandHandler('generate-tests')).toBeTypeOf('function');
  });

  it('returns null for a command that is parsed but not implemented', () => {
    // `resolve` is recognised by the parser but deliberately unimplemented.
    expect(getCommandHandler('resolve')).toBeNull();
  });

  it('help text mentions every implemented command', () => {
    const help = commandHelp();
    expect(help).toContain('/review');
    expect(help).toContain('/explain');
    expect(help).toContain('/generate-tests');
  });
});
