#!/usr/bin/env node
/**
 * CI guard: fail the build if any workflow that runs on a privileged event
 * checks out the PR head ref.
 *
 * Why this exists: `pull_request_target`, `workflow_run`, `issue_comment`, and
 * `pull_request_review_comment` all run with a write-scoped `GITHUB_TOKEN` and
 * access to repository secrets, while being triggerable by people outside the
 * repository. Checking out and executing head code in that context is how a
 * PR-review bot becomes a remote code execution vector.
 *
 * prsentinel only ever reads the diff as data, and this guard keeps it that
 * way as the project grows.
 *
 * The detection functions are exported so they can be unit-tested
 * (see tests/guard.test.ts).
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKFLOW_DIR = '.github/workflows';

/** Ref expressions that resolve to attacker-controlled PR code. */
export const DANGEROUS_REF_PATTERNS = [
  /github\.event\.pull_request\.head\.(sha|ref|label)/,
  /github\.head_ref/,
  /github\.event\.pull_request\.head_ref/,
  // `issue_comment` / `pull_request_review_comment` expose a PR head through
  // the issue object as well.
  /github\.event\.issue\.pull_request\.head/,
];

/**
 * Events that run with secrets and a write-scoped token while being
 * triggerable by people outside the repository.
 *
 * `workflow_call` is included because a reusable workflow inherits the
 * privilege of whatever calls it — so it must never check out a head ref
 * either.
 */
export const PRIVILEGED_EVENTS = [
  'pull_request_target',
  'workflow_run',
  'workflow_call',
  'issue_comment',
  'pull_request_review_comment',
];

/** True when the workflow declares a privileged trigger. */
export function isPrivileged(text) {
  return PRIVILEGED_EVENTS.some((evt) => new RegExp(`^\\s{2}${evt}:`, 'm').test(text));
}

/** Find every `ref:` whose value resolves to PR-controlled code. */
export function findViolations(text) {
  const violations = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^\s*ref:\s*(.+)$/.exec(line);
    if (!m) continue;
    const value = m[1].trim();
    for (const pattern of DANGEROUS_REF_PATTERNS) {
      if (pattern.test(value)) {
        violations.push({ line: i + 1, text: line.trim(), value, pattern: String(pattern) });
      }
    }
  }
  return violations;
}

/** All violations for a workflow's text (empty when the event is not privileged). */
export function checkWorkflowText(text) {
  if (!isPrivileged(text)) return [];
  return findViolations(text);
}

function listWorkflowFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => join(dir, f));
}

function main() {
  let failed = false;

  for (const file of listWorkflowFiles(WORKFLOW_DIR)) {
    const text = readFileSync(file, 'utf8');
    const violations = checkWorkflowText(text);
    if (violations.length > 0) {
      failed = true;
      console.error(`\n✖ ${file} uses a privileged event AND checks out PR code:`);
      for (const v of violations) console.error(`    line ${v.line}: ${v.text}`);
    }
  }

  if (failed) {
    console.error(
      '\nRefuse to build: a workflow on a privileged event checks out attacker-controlled code.\n' +
        'Check out a base ref instead, or read the diff via the API. See docs/SECURITY.md.\n',
    );
    process.exit(1);
  }

  console.log('✓ No privileged workflow checks out PR head code.');
}

// Only run the scan when invoked directly, so the module can be imported by tests.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
