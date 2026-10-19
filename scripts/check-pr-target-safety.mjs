#!/usr/bin/env node
/**
 * CI guard: fail the build if any workflow that runs on `pull_request_target`
 * (or `workflow_run` with elevated permissions) checks out the PR head ref.
 *
 * This is the one mistake that turns a PR-review bot into a remote code
 * execution vector: pull_request_target runs with a write-scoped token and
 * access to secrets, so checking out and executing head code is exploitable.
 *
 * prsentinel only ever reads the diff as data, and this guard keeps it that
 * way as the project grows.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOW_DIR = '.github/workflows';

/** Ref expressions that resolve to attacker-controlled PR code. */
const DANGEROUS_REF_PATTERNS = [
  /github\.event\.pull_request\.head\.(sha|ref)/,
  /github\.head_ref/,
  /github\.event\.pull_request\.head_ref/,
];

/** Events that grant a write token + secrets in the base repo context. */
const PRIVILEGED_EVENTS = ['pull_request_target', 'workflow_run'];

function listWorkflowFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => join(dir, f));
}

/** Crude but effective: find checkout steps and inspect their `ref:`. */
function findViolations(text) {
  const violations = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A `ref:` line inside a checkout step.
    const m = /^\s*ref:\s*(.+)$/.exec(line);
    if (!m) continue;
    const value = m[1];
    for (const pattern of DANGEROUS_REF_PATTERNS) {
      if (pattern.test(value)) {
        violations.push({ line: i + 1, text: line.trim(), value: value.trim() });
      }
    }
  }
  return violations;
}

function isPrivileged(text) {
  return PRIVILEGED_EVENTS.some((evt) => new RegExp(`^\\s{2}${evt}:`, 'm').test(text));
}

let failed = false;

for (const file of listWorkflowFiles(WORKFLOW_DIR)) {
  const text = readFileSync(file, 'utf8');
  if (!isPrivileged(text)) continue;

  const violations = findViolations(text);
  if (violations.length > 0) {
    failed = true;
    console.error(`\n✖ ${file} uses a privileged event AND checks out PR code:`);
    for (const v of violations) {
      console.error(`    line ${v.line}: ${v.text}`);
    }
  }
}

if (failed) {
  console.error(
    '\nRefuse to build: a workflow on a privileged event checks out attacker-controlled code.\n' +
      'Check out the base ref instead, or read the diff via the API. See docs/SECURITY.md.\n',
  );
  process.exit(1);
}

console.log('✓ No privileged workflow checks out PR head code.');
