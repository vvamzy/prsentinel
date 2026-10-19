import * as core from '@actions/core';
import * as github from '@actions/github';

import type { Config } from './config.js';
import type { GitHubClient } from './github/client.js';
import { annotatePatch, parsePatch } from './github/diff.js';
import type { LLM } from './llm/registry.js';
import { log } from './log.js';
import { CHAT_SYSTEM, chatUserPrompt } from './review/prompts.js';

/**
 * Conversational replies inside an inline review thread.
 *
 * Triggered by `pull_request_review_comment`. If someone replies to a
 * prsentinel finding, we answer in the same thread with the diff hunk and the
 * discussion so far as context.
 *
 * Deliberately narrow: we only reply when the thread was started by us, so the
 * bot never barges into a human-to-human conversation.
 */

export interface ChatOptions {
  client: GitHubClient;
  config: Config;
  llm: LLM;
  model: string;
  prNumber: number;
  botLogins: string[];
  dryRun: boolean;
}

interface ReviewCommentPayload {
  id: number;
  body: string;
  path: string;
  line: number | null;
  inReplyToId: number | null;
  author: string;
  /** GraphQL node id, present on the payload as `node_id`. */
  nodeId?: string;
}

/** Read the triggering review comment out of the event payload. */
export function readTriggeringReviewComment(): ReviewCommentPayload | null {
  const payload = github.context.payload as {
    comment?: {
      id?: number;
      body?: string;
      path?: string;
      line?: number | null;
      original_line?: number | null;
      in_reply_to_id?: number;
      user?: { login?: string };
      node_id?: string;
    };
  };
  const c = payload.comment;
  if (!c || typeof c.id !== 'number') return null;
  return {
    id: c.id,
    body: c.body ?? '',
    path: c.path ?? '',
    line: c.line ?? c.original_line ?? null,
    inReplyToId: c.in_reply_to_id ?? null,
    author: c.user?.login ?? '',
    ...(c.node_id ? { nodeId: c.node_id } : {}),
  };
}

/**
 * Determine whether we should answer.
 *
 * We reply only when the thread was started by the bot: either the comment is a
 * direct reply to one of our comments, or the triggering comment itself is
 * ours (which we then ignore to avoid replying to ourselves).
 */
export function isOurThread(
  trigger: ReviewCommentPayload,
  allComments: Array<{ id: number; author: string; inReplyTo: number | null }>,
  botLogins: string[],
): boolean {
  const isBot = (login: string) =>
    botLogins.some((b) => login.toLowerCase().includes(b.toLowerCase()));

  // Never reply to our own comment.
  if (isBot(trigger.author)) return false;

  const rootId = findRootId(trigger.id, trigger.inReplyToId, allComments);
  const root = allComments.find((c) => c.id === rootId);
  return root ? isBot(root.author) : false;
}

/** Walk `in_reply_to` links up to the thread root. */
export function findRootId(
  commentId: number,
  inReplyToId: number | null,
  allComments: Array<{ id: number; inReplyTo: number | null }>,
): number {
  let current = commentId;
  let parent = inReplyToId;
  // Bounded to avoid an infinite loop on malformed data.
  for (let i = 0; i < 50 && parent !== null; i++) {
    current = parent;
    parent = allComments.find((c) => c.id === parent)?.inReplyTo ?? null;
  }
  return current;
}

/** Render the thread as a compact transcript, oldest first. */
export function renderThread(
  rootId: number,
  allComments: Array<{ id: number; author: string; body: string; inReplyTo: number | null }>,
): string {
  const thread: typeof allComments = [];
  const byParent = new Map<number | null, typeof allComments>();
  for (const c of allComments) {
    const key = c.inReplyTo;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(c);
  }

  const visit = (id: number) => {
    const node = allComments.find((c) => c.id === id);
    if (!node) return;
    thread.push(node);
    for (const child of byParent.get(id) ?? []) visit(child.id);
  };
  visit(rootId);

  if (thread.length === 0) {
    const only = allComments.find((c) => c.id === rootId);
    if (only) thread.push(only);
  }

  return thread.map((c) => `**${c.author}:** ${c.body.trim()}`).join('\n\n');
}

/** Fetch the diff hunk a review comment sits on, for grounding. */
export async function hunkForComment(
  client: GitHubClient,
  prNumber: number,
  path: string,
  line: number | null,
): Promise<string> {
  if (line === null) return '';
  try {
    const files = await client.getChangedFiles(prNumber);
    const file = files.find((f) => f.filename === path);
    if (!file?.patch) return '';
    const parsed = parsePatch(file.patch);
    // Show a window either side of the commented line.
    const annotated = annotatePatch(parsed);
    const rows = annotated.split('\n');
    const keep: string[] = [];
    let inWindow = false;
    let depth = 0;
    for (const row of rows) {
      if (row.startsWith('@@')) {
        depth = 0;
        inWindow = false;
        keep.push(row);
        continue;
      }
      const m = /^\s*(\d+)\s/.exec(row);
      if (!m) continue;
      const n = Number(m[1]);
      if (Math.abs(n - line) <= 12) {
        keep.push(row);
        inWindow = true;
      } else if (inWindow) {
        depth++;
        if (depth > 3) {
          keep.push('   ...');
          inWindow = false;
        }
      }
    }
    return keep.join('\n');
  } catch (err) {
    log.warn(`could not build hunk for ${path}:${line}: ${String(err)}`);
    return '';
  }
}

/**
 * Answer a reply in an inline review thread.
 * Returns the text posted, or null when we decided not to respond.
 */
export async function runChat(opts: ChatOptions): Promise<string | null> {
  const { client, config, llm, model, prNumber, botLogins } = opts;

  const trigger = readTriggeringReviewComment();
  if (!trigger) {
    log.info('No review comment in payload; nothing to do.');
    return null;
  }

  const all = await client.listReviewComments(prNumber, trigger.path);
  if (!isOurThread(trigger, all, botLogins)) {
    log.info('Thread was not started by prsentinel; staying out of it.');
    return null;
  }

  const rootId = findRootId(trigger.id, trigger.inReplyToId, all);
  const thread = renderThread(rootId, all);

  const diff = await hunkForComment(client, prNumber, trigger.path, trigger.line);

  log.kv({ thread_root: rootId, path: trigger.path, line: trigger.line ?? 0 });

  const res = await llm.complete(model, {
    messages: [
      { role: 'system', content: CHAT_SYSTEM },
      { role: 'user', content: chatUserPrompt({ thread, diff, reply: trigger.body }) },
    ],
    maxTokens: 1024,
  });

  const body = res.text.trim();
  if (!body) {
    log.warn('Chat returned an empty response; not posting.');
    return null;
  }

  if (opts.dryRun) {
    log.notice(`Dry run: would reply in thread on ${trigger.path}:${trigger.line}\n${body}`);
    core.setOutput('reply-body', body);
    return body;
  }

  const posted = await client.replyToReviewComment(prNumber, rootId, body);
  log.notice(`Replied in review thread: ${posted.url}`);
  core.setOutput('reply-url', posted.url);
  return body;
}
