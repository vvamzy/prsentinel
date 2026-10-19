/**
 * `readEnv` is the input contract: every workflow-visible knob is resolved here.
 * It was previously buried in `index.ts`, which runs `main()` on import, so none
 * of it was reachable from a test — and two defects hid in it: `config-path` was
 * declared in action.yml but read as an undeclared `repo-root`, and `pr-number`
 * had no environment fallback, leaving the container undriveable by hand.
 *
 * `@actions/core` reads inputs straight from `INPUT_<NAME>` environment
 * variables, so these tests drive it by setting process.env rather than mocking.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readEnv, DEFAULT_BOT_LOGINS } from '../src/env.js';

/** Every key readEnv can observe, so tests cannot leak into each other. */
const MANAGED = [
  'INPUT_GITHUB-TOKEN',
  'INPUT_APP-ID',
  'INPUT_APP-PRIVATE-KEY',
  'INPUT_INSTALLATION-ID',
  'INPUT_LLM-API-KEY',
  'INPUT_LLM-BASE-URL',
  'INPUT_LLM-MODEL',
  'INPUT_LOCAL-MODEL-CACHE',
  'INPUT_DRY-RUN',
  'INPUT_CONFIG-PATH',
  'INPUT_REPO-ROOT',
  'INPUT_BOT-LOGIN',
  'INPUT_PR-NUMBER',
  'GITHUB_TOKEN',
  'GITHUB_WORKSPACE',
  'GITHUB_EVENT_NAME',
  'PRSENTINEL_APP_ID',
  'PRSENTINEL_APP_PRIVATE_KEY',
  'PRSENTINEL_INSTALLATION_ID',
  'PRSENTINEL_LOCAL_CACHE',
  'PRSENTINEL_BOT_LOGIN',
  'LLM_API_KEY',
  'OPENAI_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'DRY_RUN',
  'PR_NUMBER',
];

const original = new Map<string, string | undefined>();

beforeEach(() => {
  if (original.size === 0) {
    for (const key of MANAGED) original.set(key, process.env[key]);
  }
  for (const key of MANAGED) delete process.env[key];
});

afterAll(() => {
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('readEnv working directory', () => {
  it('honours the declared config-path input', () => {
    process.env['INPUT_CONFIG-PATH'] = '/srv/checkout';
    expect(readEnv().repoRoot).toBe('/srv/checkout');
  });

  it('still accepts repo-root, which the code used to read on its own', () => {
    process.env['INPUT_REPO-ROOT'] = '/from/repo-root';
    expect(readEnv().repoRoot).toBe('/from/repo-root');
  });

  it('prefers config-path when both are set', () => {
    process.env['INPUT_CONFIG-PATH'] = '/declared';
    process.env['INPUT_REPO-ROOT'] = '/undeclared';
    expect(readEnv().repoRoot).toBe('/declared');
  });

  it('falls back to GITHUB_WORKSPACE, then the process directory', () => {
    process.env.GITHUB_WORKSPACE = '/github/workspace';
    expect(readEnv().repoRoot).toBe('/github/workspace');

    delete process.env.GITHUB_WORKSPACE;
    expect(readEnv().repoRoot).toBe(process.cwd());
  });
});

describe('readEnv PR number', () => {
  it('prefers the pr-number input', () => {
    process.env['INPUT_PR-NUMBER'] = '41';
    process.env.PR_NUMBER = '42';
    expect(readEnv().prNumber).toBe(41);
  });

  it('falls back to PR_NUMBER so the container can be run by hand', () => {
    process.env.PR_NUMBER = '42';
    expect(readEnv().prNumber).toBe(42);
  });

  it('is 0 when nothing supplies a number', () => {
    expect(readEnv().prNumber).toBe(0);
  });

  it('ignores a non-numeric PR_NUMBER', () => {
    process.env.PR_NUMBER = 'not-a-number';
    expect(readEnv().prNumber).toBe(0);
  });
});

describe('readEnv dry run', () => {
  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['false', false],
    ['', false],
  ])('reads %j as %s', (raw, expected) => {
    process.env['INPUT_DRY-RUN'] = raw;
    expect(readEnv().dryRun).toBe(expected);
  });
});

describe('readEnv model', () => {
  it('defaults to a cloud model and reports the input as unset', () => {
    const env = readEnv();
    expect(env.llmModel).toBe('openai/gpt-4o-mini');
    expect(env.llmModelInput).toBe('');
  });

  it('keeps an empty input distinguishable from an explicit one', () => {
    process.env['INPUT_LLM-MODEL'] = 'local/qwen2.5-coder-7b-instruct';
    const env = readEnv();
    expect(env.llmModel).toBe('local/qwen2.5-coder-7b-instruct');
    expect(env.llmModelInput).toBe('local/qwen2.5-coder-7b-instruct');
  });

  it('accepts LLM_MODEL from the environment', () => {
    process.env.LLM_MODEL = 'anthropic/claude-sonnet';
    expect(readEnv().llmModel).toBe('anthropic/claude-sonnet');
  });
});

describe('readEnv credentials', () => {
  it('falls back through LLM_API_KEY then OPENAI_API_KEY', () => {
    process.env.LLM_API_KEY = 'from-llm';
    process.env.OPENAI_API_KEY = 'from-openai';
    expect(readEnv().llmKey).toBe('from-llm');

    delete process.env.LLM_API_KEY;
    expect(readEnv().llmKey).toBe('from-openai');
  });

  it('treats a non-positive installation id as absent', () => {
    process.env['INPUT_INSTALLATION-ID'] = '0';
    expect(readEnv().installationId).toBeUndefined();

    process.env['INPUT_INSTALLATION-ID'] = '99';
    expect(readEnv().installationId).toBe(99);
  });
});

describe('readEnv bot logins', () => {
  it('uses the defaults when bot-login is unset', () => {
    expect(readEnv().botLogins).toEqual(DEFAULT_BOT_LOGINS);
  });

  it('puts a configured login first and keeps the defaults', () => {
    process.env['INPUT_BOT-LOGIN'] = 'acme-bot[bot]';
    const logins = readEnv().botLogins;
    expect(logins[0]).toBe('acme-bot[bot]');
    expect(logins).toContain('github-actions[bot]');
  });
});
