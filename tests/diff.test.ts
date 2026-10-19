import { describe, it, expect } from 'vitest';
import { parsePatch, clampRange, annotatePatch, renderPatch } from '../src/github/diff.js';

/**
 * Line-number correctness is the single most important invariant in
 * prsentinel: a wrong number means a suggestion lands on the wrong code.
 * These tests pin it down against hand-written patches.
 */

const SIMPLE_PATCH = `@@ -1,5 +1,6 @@
 import a from './a';
+import b from './b';
 
 function main() {
-  return a;
+  return a + b;
 }`;

describe('parsePatch', () => {
  it('numbers added lines on the new side', () => {
    const p = parsePatch(SIMPLE_PATCH);
    // New file: 1=import a, 2=import b, 3=blank, 4=function, 5=return, 6=}
    expect(p.attachableNewLines.has(2)).toBe(true); // the new import
    expect(p.attachableNewLines.has(5)).toBe(true); // the new return
    // Content preserves the code's own indentation; only the +/- marker is stripped.
    expect(p.newLineContent.get(2)).toBe("import b from './b';");
    expect(p.newLineContent.get(5)).toBe('  return a + b;');
  });

  it('does not mark deleted lines as attachable', () => {
    const p = parsePatch(SIMPLE_PATCH);
    // Old line 4 was "return a;" — deleted. There is no new line 4
    // that is an addition; new line 4 is the context "function main() {".
    // Verify the deleted content never lands in newLineContent.
    for (const [, content] of p.newLineContent) {
      expect(content).not.toBe('  return a;'.trim());
    }
  });

  it('handles multiple hunks with independent counters', () => {
    const patch = `@@ -10,3 +10,4 @@
 ctx1
+add1
 ctx2
 ctx3
@@ -40,3 +41,3 @@
 ctxA
-removed
+added
 ctxB`;
    const p = parsePatch(patch);
    expect(p.hunks).toHaveLength(2);
    // Hunk 1: newStart 10 → ctx=10, add=11, ctx=12, ctx=13
    expect(p.attachableNewLines.has(11)).toBe(true);
    // Hunk 2: newStart 41 → ctx=41, add=42, ctx=43
    expect(p.attachableNewLines.has(42)).toBe(true);
    expect(p.newLineContent.get(42)).toBe('added');
  });

  it('treats a bare header count as 1', () => {
    const p = parsePatch('@@ -7 +8 @@\n-old\n+new');
    expect(p.hunks[0]?.oldCount).toBe(1);
    expect(p.hunks[0]?.newCount).toBe(1);
    expect(p.attachableNewLines.has(8)).toBe(true);
  });

  it('ignores diff metadata before the first hunk', () => {
    const patch = `diff --git a/src/x.ts b/src/x.ts
index 111..222 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,2 +1,3 @@
 keep
+added
 tail`;
    const p = parsePatch(patch);
    expect(p.hunks).toHaveLength(1);
    expect(p.attachableNewLines.has(2)).toBe(true);
  });

  it('skips "\\ No newline at end of file" without shifting counters', () => {
    const patch = '@@ -1,2 +1,2 @@\n a\n-b\n+b\n\\ No newline at end of file';
    const p = parsePatch(patch);
    expect(p.attachableNewLines.has(1)).toBe(true);
    expect(p.attachableNewLines.has(2)).toBe(true);
    expect(p.hunks[0]?.lines.some((l) => l.kind === 'add')).toBe(true);
  });

  it('throws on a malformed header rather than mis-numbering', () => {
    expect(() => parsePatch('@@ garbage @@\n+x')).toThrow(/Malformed hunk header/);
  });

  it('records min and max attachable new lines', () => {
    const p = parsePatch(SIMPLE_PATCH);
    expect(p.minNewLine).toBe(1);
    expect(p.maxNewLine).toBe(6);
  });
});

describe('clampRange', () => {
  it('passes through a fully attachable range', () => {
    const p = parsePatch(SIMPLE_PATCH);
    const r = clampRange(p, 4, 5); // function line + return line, both context/add
    expect(r).toEqual({ startLine: 4, endLine: 5 });
  });

  it('returns null when the end line is not in the diff', () => {
    const p = parsePatch(SIMPLE_PATCH);
    expect(clampRange(p, 1, 99)).toBeNull();
  });

  it('clamps the start to the contiguous run', () => {
    // Build a patch with a gap: lines 1-2 attachable, 3 not, 4-5 attachable.
    const patch = `@@ -1,2 +1,2 @@
 a
-b
@@ -4,2 +3,2 @@
 c
-d
+e
 f`;
    const p = parsePatch(patch);
    // newLine 1 attachable, newLine 3 attachable, newLine 4 attachable.
    const r = clampRange(p, 1, 4);
    // The run containing 4 is {3,4}; start clamps to max(1,3)=3.
    expect(r).toEqual({ startLine: 3, endLine: 4 });
  });

  it('normalizes a reversed range', () => {
    const p = parsePatch(SIMPLE_PATCH);
    expect(clampRange(p, 5, 4)).toEqual({ startLine: 4, endLine: 5 });
  });
});

describe('annotatePatch / renderPatch', () => {
  it('round-trips markers', () => {
    const p = parsePatch(SIMPLE_PATCH);
    const rendered = renderPatch(p);
    expect(rendered).toContain('+import b from');
    expect(rendered).toContain('-  return a;');
    const annotated = annotatePatch(p);
    expect(annotated).toMatch(/^\s*\d+ \+ /m);
  });
});
