/**
 * Resolution of the action's inputs and environment.
 *
 * Kept apart from `index.ts` so it can be tested without executing the action:
 * `index.ts` runs `main()` as a side effect of being imported, which is correct
 * for an entry point and useless for a unit test.
 *
 * Every input has an environment fallback so the container can be driven by a
 * plain `docker run` — which is how `.github/workflows/local-model-smoke.yml`
 * exercises a published image without going through the Actions input plumbing.
 */

import * as core from '@actions/core';
import * as github from '@actions/github';

/** Defaults used to recognise our own comments when `bot-login` is unset. */
export const DEFAULT_BOT_LOGINS = ['prsentinel', 'github-actions[bot]'];

/** Everything a run needs, resolved once up front. */
export interface RunEnv {
  token: string;
  appId: string;
  appPrivateKey: string;
  installationId: number | undefined;
  llmKey: string;
  llmBaseUrl: string | undefined;
  llmModel: string;
  /** The raw `llm-model` input, empty when the workflow did not set it. */
  llmModelInput: string;
  localModelCache: string | undefined;
  prNumber: number;
  dryRun: boolean;
  repoRoot: string;
  eventName: string;
  botLogins: string[];
}

export function readEnv(): RunEnv {
  const token = core.getInput('github-token') || process.env.GITHUB_TOKEN || '';
  const appId = core.getInput('app-id') || process.env.PRSENTINEL_APP_ID || '';
  const appPrivateKey =
    core.getInput('app-private-key') || process.env.PRSENTINEL_APP_PRIVATE_KEY || '';
  const installationId = Number(
    core.getInput('installation-id') || process.env.PRSENTINEL_INSTALLATION_ID || '',
  );
  const llmKey =
    core.getInput('llm-api-key') || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';
  const llmBaseUrl = core.getInput('llm-base-url') || process.env.LLM_BASE_URL || undefined;
  // No `default` in action.yml, so an empty value means "the workflow said
  // nothing" and a config file is free to choose instead.
  const llmModelInput = core.getInput('llm-model') || process.env.LLM_MODEL || '';
  const llmModel = llmModelInput || `openai/gpt-4o-mini`;
  const localModelCache = core.getInput('local-model-cache') || process.env.PRSENTINEL_LOCAL_CACHE || undefined;
  const dryRunRaw = (core.getInput('dry-run') || process.env.DRY_RUN || 'false').toLowerCase();
  // action.yml declares this as `config-path`, matching the README and
  // `.github/workflows/review.yml`. It used to read an undeclared `repo-root`
  // input instead, so the documented one silently did nothing.
  const repoRoot =
    core.getInput('config-path') ||
    core.getInput('repo-root') ||
    process.env.GITHUB_WORKSPACE ||
    process.cwd();
  const botLogin = core.getInput('bot-login') || process.env.PRSENTINEL_BOT_LOGIN || '';
  // `pr-number` used to be the only input with no fallback, which left the
  // container undriveable by hand: every other one can come from the
  // environment.
  const prNumber =
    Number(core.getInput('pr-number')) || Number(process.env.PR_NUMBER) || contextPrNumber() || 0;

  const botLogins = botLogin
    ? [botLogin, ...DEFAULT_BOT_LOGINS.filter((b) => b !== botLogin)]
    : DEFAULT_BOT_LOGINS;

  return {
    token,
    appId,
    appPrivateKey,
    installationId: Number.isFinite(installationId) && installationId > 0 ? installationId : undefined,
    llmKey,
    llmBaseUrl: llmBaseUrl || undefined,
    llmModel,
    llmModelInput,
    localModelCache: localModelCache || undefined,
    prNumber,
    dryRun: dryRunRaw === 'true' || dryRunRaw === '1',
    repoRoot,
    eventName: process.env.GITHUB_EVENT_NAME ?? github.context.eventName ?? '',
    botLogins,
  };
}

/** The PR number from the event payload, for events that carry one. */
function contextPrNumber(): number {
  try {
    const payload = github.context.payload as {
      pull_request?: { number?: number };
      issue?: { number?: number };
    };
    return payload?.pull_request?.number ?? payload?.issue?.number ?? 0;
  } catch {
    return 0;
  }
}
