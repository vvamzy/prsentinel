import * as github from '@actions/github';
import type { ChangedFile } from '../review/map.js';
import { log } from '../log.js';

/**
 * Thin wrapper over octokit. Keeps all GitHub API shapes in one place so the
 * pipeline modules stay provider-agnostic and easy to unit test.
 */

export type Octokit = ReturnType<typeof github.getOctokit>;

/**
 * Resolve owner/repo without throwing when GITHUB_REPOSITORY is unset.
 *
 * `github.context.repo` throws outside Actions, which breaks local dry-runs
 * and tests. Fall back to parsing the env var directly.
 */
export function resolveRepoContext(): { owner: string; repo: string } {
  try {
    const ctx = github.context;
    if (ctx?.repo?.owner && ctx?.repo?.repo) {
      return { owner: ctx.repo.owner, repo: ctx.repo.repo };
    }
  } catch {
    /* not running in Actions */
  }
  const env = process.env.GITHUB_REPOSITORY ?? '';
  const [owner = '', repo = ''] = env.split('/');
  return { owner, repo };
}

export interface PrInfo {
  number: number;
  title: string;
  body: string;
  draft: boolean;
  headSha: string;
  baseSha: string;
  headRef: string;
  baseRef: string;
  author: string;
}

export class GitHubClient {
  private readonly octokit: Octokit;
  readonly owner: string;
  readonly repo: string;

  constructor(token: string, owner?: string, repo?: string) {
    this.octokit = github.getOctokit(token);
    const { owner: ctxOwner, repo: ctxRepo } = resolveRepoContext();
    this.owner = owner ?? ctxOwner;
    this.repo = repo ?? ctxRepo;
    if (!this.owner || !this.repo) {
      throw new Error(
        'Could not determine the repository. Set GITHUB_REPOSITORY to "owner/repo" or run inside GitHub Actions.',
      );
    }
  }

  async getPullRequest(number: number): Promise<PrInfo> {
    const { data } = await this.octokit.rest.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: number,
    });
    return {
      number: data.number,
      title: data.title,
      body: data.body ?? '',
      draft: data.draft ?? false,
      headSha: data.head.sha,
      baseSha: data.base.sha,
      headRef: data.head.ref,
      baseRef: data.base.ref,
      author: data.user?.login ?? 'unknown',
    };
  }

  /**
   * Fetch every changed file, following pagination.
   *
   * GitHub caps the response at 3000 files and truncates the `patch` field
   * for very large files. We surface truncation via `patch === null` so the
   * caller can decide whether to fetch full content.
   */
  async getChangedFiles(number: number): Promise<ChangedFile[]> {
    const files: ChangedFile[] = [];
    const iterator = this.octokit.paginate.iterator(this.octokit.rest.pulls.listFiles, {
      owner: this.owner,
      repo: this.repo,
      pull_number: number,
      per_page: 100,
    });
    for await (const page of iterator) {
      for (const f of page.data) {
        files.push({
          filename: f.filename,
          ...(f.previous_filename ? { previous_filename: f.previous_filename } : {}),
          status: f.status as ChangedFile['status'],
          patch: f.patch ?? null,
          changes: f.changes,
        });
      }
    }
    return files;
  }

  /** Fetch a file's content at a given ref via the Contents API. */
  async getFileContent(path: string, ref: string): Promise<{ content: string; truncated: boolean } | null> {
    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path,
        ref,
      });
      if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) return null;
      const content = Buffer.from(data.content, 'base64').toString('utf8');
      return { content, truncated: data.size > 300_000 };
    } catch {
      return null;
    }
  }

  /** List file paths at a ref, used for linter/marker detection. */
  async listTreePaths(ref: string): Promise<string[]> {
    try {
      const { data } = await this.octokit.rest.git.getTree({
        owner: this.owner,
        repo: this.repo,
        tree_sha: ref,
        recursive: 'true',
      });
      return (data.tree ?? [])
        .filter((t) => t.type === 'blob' && t.path)
        .map((t) => t.path as string);
    } catch (err) {
      log.warn(`listTreePaths failed: ${String(err)}`);
      return [];
    }
  }

  /** Compare two commits; used for incremental review scoping. */
  async compareCommits(
    base: string,
    head: string,
  ): Promise<string[]> {
    const { data } = await this.octokit.rest.repos.compareCommits({
      owner: this.owner,
      repo: this.repo,
      base,
      head,
    });
    return (data.files ?? []).map((f) => f.filename);
  }

  /** List reviews on a PR, newest last. */
  async listReviews(number: number): Promise<Array<{ body: string; user: string; id: number }>> {
    const reviews = await this.octokit.paginate(this.octokit.rest.pulls.listReviews, {
      owner: this.owner,
      repo: this.repo,
      pull_number: number,
      per_page: 100,
    });
    return reviews.map((r) => ({
      body: r.body ?? '',
      user: r.user?.login ?? '',
      id: r.id,
    }));
  }

  /** Post a single review with inline comments. */
  async createReview(params: {
    number: number;
    commitId: string;
    body: string;
    event: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';
    comments: Array<{
      path: string;
      line: number;
      side: 'LEFT' | 'RIGHT';
      start_line?: number;
      start_side?: 'LEFT' | 'RIGHT';
      body: string;
    }>;
  }): Promise<{ id: number; url: string }> {
    const { data } = await this.octokit.rest.pulls.createReview({
      owner: this.owner,
      repo: this.repo,
      pull_number: params.number,
      commit_id: params.commitId,
      body: params.body,
      event: params.event,
      comments: params.comments,
    });
    return { id: data.id, url: data.html_url };
  }

  /** Post a plain issue comment (used for slash commands and chat). */
  async createComment(number: number, body: string): Promise<{ id: number; url: string }> {
    const { data } = await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: number,
      body,
    });
    return { id: data.id, url: data.html_url };
  }

  /** Resolve a conversation thread (used by /resolve). */
  async resolveThread(threadId: string): Promise<void> {
    const graphql = this.octokit.graphql;
    await graphql(
      `mutation($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) {
          thread { isResolved }
        }
      }`,
      { threadId },
    );
  }

  /** Get the PR number from a comment payload, or null if not a PR. */
  static prNumberFromIssueComment(): number | null {
    const payload = github.context.payload;
    const issue = payload.issue;
    if (!issue || !issue.pull_request) return null;
    return issue.number;
  }
}
