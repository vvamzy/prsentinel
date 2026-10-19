import { describe, it, expect } from 'vitest';
import {
  filterFindings,
  buildPatchIndex,
  isGeneratedFile,
  detectLinters,
} from '../src/review/filter.js';
import { parseConfig, DEFAULT_CONFIG } from '../src/config.js';
import type { Finding } from '../src/review/types.js';
import type { ChangedFile } from '../src/review/map.js';

const PATCH = `@@ -1,4 +1,5 @@
 const a = 1;
+const b = 2;
 const c = 3;
 function f() {
-  return a;
+  return a + b;
 }`;

function makeFile(filename: string, patch: string | null = PATCH): ChangedFile {
  return { filename, status: 'modified', patch, changes: 5 };
}

function makeFinding(over: Partial<Finding> = {}): Finding {
  return {
    file: 'src/a.ts',
    line: 5,
    severity: 'major',
    category: 'bug',
    title: 'Something is wrong',
    body: 'Explanation of the problem.',
    confidence: 0.9,
    ...over,
  };
}

describe('isGeneratedFile', () => {
  it('flags lockfiles and build output', () => {
    expect(isGeneratedFile('package-lock.json')).toBe(true);
    expect(isGeneratedFile('web/yarn.lock')).toBe(true);
    expect(isGeneratedFile('dist/bundle.js')).toBe(true);
    expect(isGeneratedFile('a/b/node_modules/x.js')).toBe(true);
    expect(isGeneratedFile('src/app.min.js')).toBe(true);
  });

  it('does not flag ordinary source', () => {
    expect(isGeneratedFile('src/index.ts')).toBe(false);
    expect(isGeneratedFile('docs/readme.md')).toBe(false);
    // "generated" as a plain directory segment only.
    expect(isGeneratedFile('src/mygenerated.ts')).toBe(false);
  });
});

describe('detectLinters', () => {
  it('detects eslint/prettier/ruff configs anywhere in the tree', () => {
    expect(detectLinters(['.eslintrc.json'])).toBe(true);
    expect(detectLinters(['web/.prettierrc'])).toBe(true);
    expect(detectLinters(['py/ruff.toml'])).toBe(true);
  });

  it('returns false when no linter config is present', () => {
    expect(detectLinters(['src/a.ts', 'README.md'])).toBe(false);
  });
});

describe('filterFindings', () => {
  const parsedByFile = buildPatchIndex([makeFile('src/a.ts')]);
  const changedFiles = [makeFile('src/a.ts')];

  function run(findings: Finding[], config = DEFAULT_CONFIG) {
    return filterFindings(findings, {
      config,
      changedFiles,
      parsedByFile,
      allPrFiles: ['src/a.ts'],
    });
  }

  it('keeps a finding on an attachable line', () => {
    const r = run([makeFinding({ line: 5 })]);
    expect(r.findings).toHaveLength(1);
    expect(r.stats.after).toBe(1);
  });

  it('drops a finding on a line outside the diff', () => {
    const r = run([makeFinding({ line: 999 })]);
    expect(r.findings).toHaveLength(0);
    expect(r.stats.droppedOutOfHunk).toBe(1);
  });

  it('drops a finding when the file has no patch', () => {
    const idx = buildPatchIndex([makeFile('src/a.ts', null)]);
    const r = filterFindings([makeFinding()], {
      config: DEFAULT_CONFIG,
      changedFiles,
      parsedByFile: idx,
      allPrFiles: ['src/a.ts'],
    });
    expect(r.findings).toHaveLength(0);
  });

  it('drops below-threshold findings', () => {
    const r = filterFindings(
      [makeFinding({ confidence: 0.2 }), makeFinding({ line: 2, confidence: 0.95 })],
      {
        config: parseConfig('reviews:\n  confidence_threshold: 0.6\n'),
        changedFiles,
        parsedByFile,
        allPrFiles: ['src/a.ts'],
      },
    );
    expect(r.findings).toHaveLength(1);
    expect(r.stats.droppedConfidence).toBe(1);
  });

  it('suppresses style findings when a linter is configured', () => {
    const r = filterFindings([makeFinding({ line: 2, category: 'style' })], {
      config: parseConfig('reviews:\n  respect_linters: true\n'),
      changedFiles,
      parsedByFile,
      allPrFiles: ['src/a.ts', '.eslintrc.json'],
    });
    expect(r.findings).toHaveLength(0);
    expect(r.stats.suppressedStyle).toBe(1);
  });

  it('keeps style findings when no linter is configured', () => {
    const r = filterFindings([makeFinding({ line: 2, category: 'style' })], {
      config: parseConfig('reviews:\n  respect_linters: true\n'),
      changedFiles,
      parsedByFile,
      allPrFiles: ['src/a.ts'],
    });
    expect(r.findings).toHaveLength(1);
  });

  it('drops findings on generated files', () => {
    const idx = buildPatchIndex([makeFile('package-lock.json')]);
    const r = filterFindings([makeFinding({ file: 'package-lock.json', line: 5 })], {
      config: DEFAULT_CONFIG,
      changedFiles: [makeFile('package-lock.json')],
      parsedByFile: idx,
      allPrFiles: ['package-lock.json'],
    });
    expect(r.findings).toHaveLength(0);
    expect(r.stats.droppedFilteredPath).toBe(1);
  });

  it('honors path_filters with negation', () => {
    const config = parseConfig('reviews:\n  path_filters:\n    - "docs/**"\n    - "!docs/keep.md"\n');
    const idx = buildPatchIndex([
      makeFile('docs/drop.md', PATCH),
      makeFile('docs/keep.md', PATCH),
    ]);
    const r = filterFindings(
      [
        makeFinding({ file: 'docs/drop.md', line: 5 }),
        makeFinding({ file: 'docs/keep.md', line: 5 }),
      ],
      {
        config,
        changedFiles: [makeFile('docs/drop.md'), makeFile('docs/keep.md')],
        parsedByFile: idx,
        allPrFiles: ['docs/drop.md', 'docs/keep.md'],
      },
    );
    expect(r.findings.map((f) => f.file)).toEqual(['docs/keep.md']);
  });

  it('dedupes identical findings and applies caps', () => {
    const findings = [
      makeFinding({ line: 2, title: 'First' }),
      makeFinding({ line: 2, title: 'First' }), // exact dupe
      makeFinding({ line: 5, title: 'Second' }),
    ];
    const r = run(findings);
    expect(r.findings).toHaveLength(2);
    expect(r.stats.droppedDuplicate).toBe(1);
  });

  it('applies the per-file cap', () => {
    const config = parseConfig('reviews:\n  max_comments_per_file: 1\n');
    const findings = [
      makeFinding({ line: 2, title: 'A' }),
      makeFinding({ line: 5, title: 'B' }),
    ];
    const r = filterFindings(findings, { config, changedFiles, parsedByFile, allPrFiles: [] });
    expect(r.findings).toHaveLength(1);
    expect(r.stats.droppedCap).toBe(1);
  });

  it('applies the per-PR cap', () => {
    const config = parseConfig('reviews:\n  max_comments_per_pr: 1\n');
    const findings = [
      makeFinding({ file: 'src/a.ts', line: 2, title: 'A' }),
      makeFinding({ file: 'src/a.ts', line: 5, title: 'B' }),
    ];
    const r = filterFindings(findings, { config, changedFiles, parsedByFile, allPrFiles: [] });
    expect(r.findings).toHaveLength(1);
  });

  it('sorts critical findings first', () => {
    const findings = [
      makeFinding({ line: 2, severity: 'info', title: 'Info' }),
      makeFinding({ line: 5, severity: 'critical', title: 'Crit' }),
    ];
    const r = run(findings);
    expect(r.findings[0]?.severity).toBe('critical');
  });

  it('clamps a multi-line range to the attachable run', () => {
    // startLine 4 and endLine 5 are both in the diff; 1..5 would clamp.
    const r = run([makeFinding({ startLine: 1, line: 5 })]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.startLine).toBeGreaterThanOrEqual(1);
    expect(r.findings[0]?.line).toBeLessThanOrEqual(5);
  });
});
