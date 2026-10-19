import * as core from '@actions/core';
import * as github from '@actions/github';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig, type Config } from './config.js';
import { log } from './log.js';
import { GitHubClient, resolveRepoContext } from './github/client.js';
import { resolveAuth, hasAnyCredentials, type AuthInputs } from './github/auth.js';
import { serializePayload } from './github/review.js';
import { LLM } from './llm/registry.js';
import { runReview } from './pipeline.js';
import { getCommandHandler, commandHelp } from './commands/index.js';
import { runChat } from './chat.js';
import { parseSlashCommand, mentionNames, type KnownCommand } from './state.js';
import type { ReviewPayload } from './review/types.js';

/**
 * prsentinel entry point.
 *
 * Routes on the GitHub event:
 *
 *   pull_request_target       → automatic review
 *   issue_comment             → slash command  (`/review`, `/explain`, …)
 *   pull_request_review_comment → conversational reply in a review thread
 *
 * All three share the same config, client, and LLM facade.
 */

const DEFAULT_BOT_LOGINS = ['prsentinel', 'github-actions[bot]'];

interface RunEnv {
  token: string;
  appId: string;
  appPrivateKey: string;
  installationId: number | undefined;
  llmKey: string;
  llmBaseUrl: string | undefined;
  llmModel: string;
  prNumber: number;
  dryRun: boolean;
  repoRoot: string;
  eventName: string;
  botLogins: string[];
}

function readEnv(): RunEnv {
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
  const llmModel = core.getInput('llm-model') || process.env.LLM_MODEL || 'openai/gpt-4o-mini';
  const dryRunRaw = (core.getInput('dry-run') || process.env.DRY_RUN || 'false').toLowerCase();
  const repoRoot = core.getInput('repo-root') || process.env.GITHUB_WORKSPACE || process.cwd();
  const botLogin = core.getInput('bot-login') || process.env.PRSENTINEL_BOT_LOGIN || '';

  const configuredModel = core.getInput('llm-model') || process.env.LLM_MODEL || '';
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
    llmModel: configuredModel || llmModel,
    prNumber: Number(core.getInput('pr-number')) || contextPrNumber() || 0,
    dryRun: dryRunRaw === 'true' || dryRunRaw === '1',
    repoRoot,
    eventName: process.env.GITHUB_EVENT_NAME ?? github.context.eventName ?? '',
    botLogins,
  };
}

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

/** Resolve the model for review work, preferring config over the input. */
function reviewModel(config: Config, env: RunEnv): string {
  return config.models.review || env.llmModel;
}

/** Cheaper model for conversation; falls back to the review model. */
function chatModel(config: Config, env: RunEnv): string {
  return config.models.chat || reviewModel(config, env);
}

function makeLlm(env: RunEnv): LLM {
  return new LLM({
    apiKey: env.llmKey,
    ...(env.llmBaseUrl ? { baseUrl: env.llmBaseUrl } : {}),
  });
}

/** Collect credential inputs for `resolveAuth`, resolving owner/repo. */
function authInputs(env: RunEnv): AuthInputs {
  const { owner, repo } = resolveRepoContext();
  return {
    token: env.token,
    appId: env.appId,
    appPrivateKey: env.appPrivateKey,
    ...(env.installationId ? { installationId: env.installationId } : {}),
    configuredBotLogins: env.botLogins,
    owner,
    repo,
  };
}

// ---------------------------------------------------------------------------
// Automatic review (pull_request_target)
// ---------------------------------------------------------------------------

async function runAutoReview(
  env: RunEnv,
  client: GitHubClient,
  config: Config,
  llm: LLM,
): Promise<void> {
  const outcome = await runReview({
    client,
    config,
    llm,
    model: reviewModel(config, env),
    prNumber: env.prNumber,
  });

  if (outcome.pr.draft && !config.reviews.drafts) {
    log.info('Draft PR and drafts are disabled in config; skipping.');
    return;
  }

  await emit(env, client, outcome.payload, outcome.plan.findings.length);
}

// ---------------------------------------------------------------------------
// Slash commands (issue_comment)
// ---------------------------------------------------------------------------

async function runCommandFlow(
  env: RunEnv,
  client: GitHubClient,
  config: Config,
  llm: LLM,
  botLogins: string[],
): Promise<void> {
  if (!config.commands.enabled) {
    log.info('Commands are disabled in config; ignoring comment.');
    return;
  }

  const payload = github.context.payload as {
    comment?: { id?: number };
    issue?: { number?: number; pull_request?: unknown };
  };

  if (!payload.issue?.pull_request) {
    log.info('Comment is not on a pull request; nothing to do.');
    return;
  }

  const commentId = payload.comment?.id;
  if (typeof commentId !== 'number') {
    log.info('No comment id in payload; nothing to do.');
    return;
  }

  // Re-fetch so `body` and `author_association` are authoritative.
  const comment = await client.getIssueComment(commentId);
  if (!comment) {
    log.warn(`Could not fetch comment ${commentId}; nothing to do.`);
    return;
  }

  // Never act on our own comment, or another bot's.
  if (isBotLogin(comment.author, botLogins) || comment.author.endsWith('[bot]')) {
    log.info('Comment is from a bot; ignoring.');
    return;
  }

  const parsed = parseSlashCommand(comment.body, mentionNames(botLogins));
  if (!parsed) {
    log.info('No prsentinel command in comment; nothing to do.');
    return;
  }

  log.kv({ command: parsed.command, author: comment.author, association: comment.authorAssociation });

  // Cost and abuse control: comments are untrusted, every command spends tokens.
  if (!config.commands.allowed_associations.includes(comment.authorAssociation as never)) {
    log.warn(
      `Ignoring /${parsed.command} from ${comment.author} (author_association=${comment.authorAssociation}).`,
    );
    await client.createComment(
      env.prNumber,
      `> [!NOTE]\n> \`/${parsed.command}\` is restricted to ${config.commands.allowed_associations.join(
        ', ',
      )}. Your association is \`${comment.authorAssociation}\`. Ask a maintainer to run it.`,
    );
    return;
  }

  const handler = getCommandHandler(parsed.command as KnownCommand);
  if (!handler) {
    await client.createComment(env.prNumber, commandHelp());
    return;
  }

  const result = await handler({
    client,
    config,
    llm,
    model: chatModel(config, env),
    prNumber: env.prNumber,
    comment,
    command: parsed.command as KnownCommand,
    args: parsed.args,
    dryRun: env.dryRun,
    repoRoot: env.repoRoot,
    botLogin: mentionNames(botLogins)[0] ?? 'prsentinel',
  });

  if (result.summary) log.info(result.summary);

  if (result.review) {
    await emit(env, client, result.review, result.review.comments.length);
    return;
  }

  if (result.comment) {
    if (env.dryRun) {
      log.notice(`Dry run: would post comment:\n${result.comment}`);
      core.setOutput('comment-body', result.comment);
    } else {
      const posted = await client.createComment(env.prNumber, result.comment);
      log.notice(`Comment posted: ${posted.url}`);
      core.setOutput('comment-url', posted.url);
    }
  }
}

function isBotLogin(login: string, botLogins: string[]): boolean {
  const l = login.toLowerCase();
  return botLogins.some((b) => l === b.toLowerCase() || l.includes(b.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

/**
 * Post a review, or write it to `out/` in dry-run mode.
 * Shared by the automatic review and `/review`.
 */
async function emit(
  env: RunEnv,
  client: GitHubClient,
  payload: ReviewPayload,
  findingCount: number,
): Promise<void> {
  if (env.dryRun) {
    const outDir = join(env.repoRoot, 'out');
    mkdirSync(outDir, { recursive: true });
    const outFile = join(outDir, `review-${env.prNumber}-${payload.commit_id.slice(0, 7)}.json`);
    writeFileSync(outFile, serializePayload(payload), 'utf8');
    log.notice(`Dry run: wrote ${outFile} (${payload.comments.length} comments, not posted)`);
    core.setOutput('payload-file', outFile);
    core.setOutput('comment-count', String(payload.comments.length));
    return;
  }

  if (payload.comments.length === 0 && payload.body.trim() === '') {
    log.info('Nothing to post.');
    return;
  }

  const res = await client.createReview({
    number: env.prNumber,
    commitId: payload.commit_id,
    body: payload.body,
    event: payload.event,
    comments: payload.comments,
  });
  log.notice(`Review posted: ${res.url} (${payload.comments.length} inline comments)`);
  core.setOutput('review-url', res.url);
  core.setOutput('comment-count', String(payload.comments.length));
  core.setOutput('finding-count', String(findingCount));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const env = readEnv();
  const auth = authInputs(env);

  if (env.eventName === 'pull_request_review_comment') {
    // Chat replies do not need a PR number up front — the payload carries it.
    if (!hasAnyCredentials(auth)) {
      core.setFailed('Credentials are required: set app-id + app-private-key, or github-token.');
      return;
    }
    const config = loadConfig(env.repoRoot).config;
    if (!config.chat.auto_reply) {
      log.info('chat.auto_reply is disabled; not replying.');
      return;
    }
    const resolved = await resolveAuth(auth);
    const client = resolved.client;
    const prNumber = client.prNumberFromReviewComment() ?? env.prNumber;
    if (!prNumber) {
      log.info('No pull request in review-comment payload; nothing to do.');
      return;
    }
    await runChat({
      client,
      config,
      llm: makeLlm(env),
      model: chatModel(config, env),
      prNumber,
      botLogins: resolved.botLogins,
      dryRun: env.dryRun,
    });
    return;
  }

  if (env.prNumber === 0) {
    log.info('No pull request context; nothing to do.');
    return;
  }
  if (!hasAnyCredentials(auth)) {
    core.setFailed('Credentials are required: set app-id + app-private-key, or github-token.');
    return;
  }

  const { config, path: configPath } = loadConfig(env.repoRoot);
  log.info(`Config: ${configPath ?? 'defaults (no .prsentinel.yaml found)'}`);

  const resolved = await resolveAuth(auth);
  const client = resolved.client;
  const llm = makeLlm(env);

  if (env.eventName === 'issue_comment') {
    await runCommandFlow(env, client, config, llm, resolved.botLogins);
    return;
  }

  // Default: an automatic review.
  if (!config.reviews.enabled) {
    log.info('Reviews disabled in config; exiting.');
    return;
  }
  if (env.llmKey === '' && !env.dryRun) {
    core.setFailed('No LLM API key configured. Set the llm-api-key input or LLM_API_KEY secret.');
    return;
  }

  await runAutoReview(env, client, config, llm);
}

main().catch((err) => {
  core.setFailed(err instanceof Error ? err.stack ?? err.message : String(err));
});
