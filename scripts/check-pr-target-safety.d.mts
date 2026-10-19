/**
 * Type declarations for the CI safety guard.
 *
 * The guard is deliberately a plain `.mjs` script so it can run under bare
 * Node in CI without a build step. These declarations let the TypeScript test
 * suite import and exercise it.
 */

export const WORKFLOW_DIR: string;
export const DANGEROUS_REF_PATTERNS: RegExp[];
export const PRIVILEGED_EVENTS: string[];

export interface WorkflowViolation {
  line: number;
  text: string;
  value: string;
  pattern: string;
}

export function isPrivileged(text: string): boolean;
export function findViolations(text: string): WorkflowViolation[];
export function checkWorkflowText(text: string): WorkflowViolation[];
