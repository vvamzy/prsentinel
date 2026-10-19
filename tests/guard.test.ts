import { describe, it, expect } from 'vitest';
import {
  checkWorkflowText,
  findViolations,
  isPrivileged,
} from '../scripts/check-pr-target-safety.mjs';

/**
 * The security guard is the thing that stops prsentinel from becoming a
 * remote-code-execution vector. If the guard silently stops working, nothing
 * else will catch the mistake — so it gets its own tests.
 */

describe('isPrivileged', () => {
  it('detects pull_request_target', () => {
    expect(isPrivileged('on:\n  pull_request_target:\n    types: [opened]')).toBe(true);
  });

  it('detects issue_comment', () => {
    expect(isPrivileged('on:\n  issue_comment:\n    types: [created]')).toBe(true);
  });

  it('detects pull_request_review_comment', () => {
    expect(isPrivileged('on:\n  pull_request_review_comment:\n    types: [created]')).toBe(true);
  });

  it('ignores an unprivileged event', () => {
    expect(isPrivileged('on:\n  pull_request:\n    types: [opened]')).toBe(false);
  });

  it('does not match the event name buried in prose', () => {
    // Only a YAML key at the event-list indentation counts.
    expect(isPrivileged('# we could use pull_request_target here\non:\n  push:')).toBe(false);
  });
});

describe('findViolations', () => {
  it('catches a head sha checkout', () => {
    const wf = `
on:
  pull_request_target:
jobs:
  a:
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}
`;
    const v = findViolations(wf);
    expect(v).toHaveLength(1);
    expect(v[0]?.value).toContain('head.sha');
  });

  it('catches github.head_ref', () => {
    expect(findViolations('        ref: ${{ github.head_ref }}')).toHaveLength(1);
  });

  it('catches a head ref reached through the issue object', () => {
    const wf = '        ref: ${{ github.event.issue.pull_request.head.sha }}';
    expect(findViolations(wf).length).toBeGreaterThan(0);
  });

  it('allows the base sha', () => {
    const wf = '        ref: ${{ github.event.pull_request.base.sha }}';
    expect(findViolations(wf)).toEqual([]);
  });

  it('allows the default branch', () => {
    const wf = '        ref: ${{ github.event.repository.default_branch }}';
    expect(findViolations(wf)).toEqual([]);
  });
});

describe('checkWorkflowText', () => {
  const dangerous = `
on:
  pull_request_target:
jobs:
  a:
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}
`;

  const safe = `
on:
  pull_request_target:
jobs:
  a:
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.base.sha }}
`;

  it('flags a dangerous privileged workflow', () => {
    expect(checkWorkflowText(dangerous).length).toBeGreaterThan(0);
  });

  it('passes a safe privileged workflow', () => {
    expect(checkWorkflowText(safe)).toEqual([]);
  });

  it('ignores a head-ref checkout on an unprivileged event', () => {
    // `pull_request` gives a read-only token, so checking out the head is fine.
    const unprivileged = dangerous.replace('pull_request_target', 'pull_request');
    expect(checkWorkflowText(unprivileged)).toEqual([]);
  });
});
