import { describe, it, expect } from 'vitest';
import { splitScopeAndQuestion, trimToWindow } from '../src/commands/shared.js';
import type { CommandContext } from '../src/commands/shared.js';
import { applyScope } from '../src/pipeline.js';
import { getCommandHandler, commandHelp } from '../src/commands/index.js';
import { resolveCommand } from '../src/commands/resolve.js';
import type { Config } from '../src/config.js';
import type { GitHubClient, ReviewThread } from '../src/github/client.js';
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
    expect(getCommandHandler('resolve')).toBeTypeOf('function');
  });

  it('every parsed command has a handler, so the parser never offers a dead command', () => {
    for (const c of ['review', 'explain', 'generate-tests', 'resolve'] as const) {
      expect(getCommandHandler(c), c).toBeTypeOf('function');
    }
  });

  it('help text mentions every implemented command', () => {
    const help = commandHelp();
    expect(help).toContain('/review');
    expect(help).toContain('/explain');
    expect(help).toContain('/generate-tests');
    expect(help).toContain('/resolve');
  });
});

describe('resolveCommand', () => {
  const OURS = ['prsentinel[bot]', 'prsentinel', 'github-actions[bot]'];

  function ctxFor(threads: ReviewThread[], opts: { dryRun?: boolean } = {}) {
    const resolved: string[] = [];
    const client = {
      listReviewThreads: async () => threads,
      resolveThread: async (id: string) => {
        resolved.push(id);
      },
    };
    const ctx = {
      client: client as unknown as GitHubClient,
      config: {} as Config,
      llm: {} as never,
      model: 'test',
      prNumber: 1,
      comment: {
        id: 1,
        body: '/resolve',
        author: 'maintainer',
        authorAssociation: 'OWNER',
        createdAt: '',
      },
      command: 'resolve',
      args: '',
      dryRun: opts.dryRun ?? false,
      repoRoot: '.',
      botLogin: 'prsentinel',
      botLogins: OURS,
    } as unknown as CommandContext;
    return { ctx, resolved };
  }

  function thread(over: Partial<ReviewThread> = {}): ReviewThread {
    return {
      id: 'PRRT_1',
      isResolved: false,
      path: 'src/a.ts',
      line: 12,
      author: 'prsentinel[bot]',
      ...over,
    };
  }

  it('resolves our open threads', async () => {
    const { ctx, resolved } = ctxFor([thread({ id: 'T1' }), thread({ id: 'T2' })]);
    const res = await resolveCommand(ctx);
    expect(resolved).toEqual(['T1', 'T2']);
    expect(res.comment).toContain('**2**');
  });

  it('leaves already-resolved threads alone', async () => {
    const { ctx, resolved } = ctxFor([thread({ id: 'T1', isResolved: true })]);
    const res = await resolveCommand(ctx);
    expect(resolved).toEqual([]);
    expect(res.comment).toContain('Nothing to resolve');
  });

  it('never resolves a thread a reviewer started', async () => {
    const { ctx, resolved } = ctxFor([thread({ author: 'a-human' })]);
    const res = await resolveCommand(ctx);
    expect(resolved).toEqual([]);
    expect(res.comment).toContain('Nothing to resolve');
  });

  it('recognises our App login as well as the bot login', async () => {
    const { ctx, resolved } = ctxFor([thread({ author: 'github-actions[bot]' })]);
    await resolveCommand(ctx);
    expect(resolved).toEqual(['PRRT_1']);
  });

  it('does not treat a similarly-named user as us', async () => {
    const { ctx, resolved } = ctxFor([thread({ author: 'not-prsentinel' })]);
    await resolveCommand(ctx);
    expect(resolved).toEqual([]);
  });

  it('does not mutate anything on a dry run but reports the count', async () => {
    const { ctx, resolved } = ctxFor([thread({ id: 'T1' }), thread({ id: 'T2' })], { dryRun: true });
    const res = await resolveCommand(ctx);
    expect(resolved).toEqual([]);
    expect(res.comment).toContain('Dry run');
    expect(res.comment).toContain('2');
  });

  it('keeps going when one thread fails and reports the failures', async () => {
    const resolved: string[] = [];
    const client = {
      listReviewThreads: async () => [thread({ id: 'T1' }), thread({ id: 'T2', path: 'src/b.ts' })],
      resolveThread: async (id: string) => {
        if (id === 'T1') throw new Error('boom');
        resolved.push(id);
      },
    };
    const { ctx } = ctxFor([]);
    (ctx as { client: unknown }).client = client as unknown as GitHubClient;

    const res = await resolveCommand(ctx);
    expect(resolved).toEqual(['T2']);
    expect(res.comment).toContain('**1**');
    expect(res.comment).toContain('src/a.ts:12');
  });
});
