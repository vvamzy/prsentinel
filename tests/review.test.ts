import { describe, it, expect } from 'vitest';
import {
  buildReviewBody,
  buildReviewComments,
  buildReviewPayload,
  countBySeverity,
} from '../src/github/review.js';
import { parseConfig, DEFAULT_CONFIG } from '../src/config.js';
import type { Finding, ReviewPlan } from '../src/review/types.js';

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: 'src/a.ts',
    line: 10,
    severity: 'major',
    category: 'bug',
    title: 'Missing null check',
    body: '`tx` can be undefined here.',
    confidence: 0.9,
    ...over,
  };
}

function plan(over: Partial<ReviewPlan> = {}): ReviewPlan {
  return {
    walkthrough: 'This PR rewires the payment retry logic.',
    findings: [],
    fileSummaries: [{ file: 'src/a.ts', summary: 'Adds retry backoff.' }],
    usage: { input: 100, output: 50 },
    ...over,
  };
}

describe('buildReviewBody', () => {
  it('includes the walkthrough and hides file summaries', () => {
    const body = buildReviewBody(plan(), DEFAULT_CONFIG, { headSha: 'abc123', skipped: [] });
    expect(body).toContain('## 📋 Walkthrough');
    expect(body).toContain('rewires the payment retry');
    expect(body).toContain('<details>');
    expect(body).toContain('`src/a.ts` — Adds retry backoff.');
  });

  it('embeds the last-reviewed marker', () => {
    const body = buildReviewBody(plan(), DEFAULT_CONFIG, { headSha: 'abc123', skipped: [] });
    expect(body).toContain('<!-- prsentinel:last-reviewed:abc123 -->');
  });

  it('lists skipped files', () => {
    const body = buildReviewBody(plan(), DEFAULT_CONFIG, {
      headSha: 'abc',
      skipped: [{ file: 'lock.json', reason: 'generated' }],
    });
    expect(body).toContain('lock.json');
  });

  it('summarizes finding counts by severity', () => {
    const body = buildReviewBody(
      plan({ findings: [finding({ severity: 'critical' }), finding({ severity: 'minor' })] }),
      DEFAULT_CONFIG,
      { headSha: 'abc', skipped: [] },
    );
    expect(body).toContain('1 critical');
    expect(body).toContain('1 minor');
  });
});

describe('countBySeverity', () => {
  it('counts correctly', () => {
    const c = countBySeverity([finding(), finding({ severity: 'critical' })]);
    expect(c.major).toBe(1);
    expect(c.critical).toBe(1);
  });
});

describe('buildReviewComments', () => {
  it('renders a single-line comment without start_line', () => {
    const comments = buildReviewComments(plan({ findings: [finding()] }), DEFAULT_CONFIG);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ path: 'src/a.ts', line: 10, side: 'RIGHT' });
    expect(comments[0]?.start_line).toBeUndefined();
  });

  it('renders a multi-line comment with start_line and start_side', () => {
    const comments = buildReviewComments(
      plan({ findings: [finding({ startLine: 8, line: 10 })] }),
      DEFAULT_CONFIG,
    );
    expect(comments[0]).toMatchObject({
      line: 10,
      start_line: 8,
      side: 'RIGHT',
      start_side: 'RIGHT',
    });
  });

  it('appends a suggestion block when a suggestion is present', () => {
    const comments = buildReviewComments(
      plan({ findings: [finding({ suggestion: 'if (!tx?.id) return;' })] }),
      DEFAULT_CONFIG,
    );
    const body = comments[0]?.body ?? '';
    expect(body).toContain('```suggestion');
    expect(body).toContain('if (!tx?.id) return;');
  });

  it('omits the suggestion block when suggestion is blank', () => {
    const comments = buildReviewComments(
      plan({ findings: [finding({ suggestion: '   ' })] }),
      DEFAULT_CONFIG,
    );
    expect(comments[0]?.body ?? '').not.toContain('```suggestion');
  });

  it('applies the comment_prefix template', () => {
    const config = parseConfig('comment_prefix: "[{{severity}}/{{category}}] {{title}}"\n');
    const comments = buildReviewComments(plan({ findings: [finding()] }), config);
    expect(comments[0]?.body).toContain('[major/bug] Missing null check');
  });

  it('sorts by severity so criticals come first', () => {
    const comments = buildReviewComments(
      plan({
        findings: [
          finding({ line: 2, severity: 'info', title: 'Info' }),
          finding({ line: 5, severity: 'critical', title: 'Crit' }),
        ],
      }),
      DEFAULT_CONFIG,
    );
    expect(comments[0]?.body).toContain('Crit');
  });
});

describe('buildReviewPayload', () => {
  it('defaults to COMMENT event', () => {
    const p = buildReviewPayload(plan({ findings: [finding()] }), DEFAULT_CONFIG, {
      headSha: 'abc',
      skipped: [],
    });
    expect(p.event).toBe('COMMENT');
    expect(p.commit_id).toBe('abc');
  });

  it('emits REQUEST_CHANGES for a critical when configured', () => {
    const config = parseConfig('reviews:\n  request_changes_on_critical: true\n');
    const p = buildReviewPayload(plan({ findings: [finding({ severity: 'critical' })] }), config, {
      headSha: 'abc',
      skipped: [],
    });
    expect(p.event).toBe('REQUEST_CHANGES');
  });

  it('stays COMMENT for criticals when not configured', () => {
    const p = buildReviewPayload(plan({ findings: [finding({ severity: 'critical' })] }), DEFAULT_CONFIG, {
      headSha: 'abc',
      skipped: [],
    });
    expect(p.event).toBe('COMMENT');
  });
});
