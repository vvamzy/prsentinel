<h1 align="center">prsentinel</h1>

<p align="center">
  <b>Open-source AI code review for pull requests — running entirely inside your GitHub Actions pipeline.</b>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
  <img alt="Status" src="https://img.shields.io/badge/status-early%20preview-orange.svg">
</p>

---

prsentinel reviews your pull requests the way a good senior engineer would: it
reads the diff, explains what the change does, and leaves specific, applyable
comments only where something is actually wrong.

It is a self-hostable alternative to hosted review bots. There is no signup, no
dashboard, and **no server** — the whole thing runs as a GitHub Action in your
own CI, using an LLM provider of your choice.

## What you get on every PR

| | |
|---|---|
| **Walkthrough** | A short summary of what the PR does and what a reviewer must check. |
| **File summaries** | A collapsible list of per-file explanations, so you can orient fast. |
| **Inline findings** | Specific comments anchored to exact lines, tagged by severity and category. |
| **One-click suggestions** | GitHub `suggestion` blocks you can apply without leaving the PR. |

All three layers arrive in a **single review** — not a stream of separate
comments.

## Quick start

Create `.github/workflows/prsentinel.yml` in your repository:

```yaml
name: prsentinel

on:
  pull_request_target:
    types: [opened, synchronize, ready_for_review]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      # Check out the BASE branch, never the PR head.
      # See "Security model" below — this is not optional.
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.base.sha }}

      - uses: vvamzy/prsentinel@v1
        with:
          # Recommended: post as <your-app>[bot]. See "Register the GitHub App".
          app-id: ${{ secrets.APP_ID }}
          app-private-key: ${{ secrets.APP_PRIVATE_KEY }}
          llm-api-key: ${{ secrets.LLM_API_KEY }}
          llm-model: openai/gpt-4o-mini
```

Add `LLM_API_KEY` as a repository secret, then register a GitHub App (below)
and add `APP_ID` and `APP_PRIVATE_KEY`. That is the whole setup.

> **In a hurry?** Delete the two `app-*` lines and prsentinel falls back to the
> workflow's own `${{ github.token }}`, posting as `github-actions[bot]`. No App
> required — but you get a shared rate limit and a generic identity.

> **Why `pull_request_target`?** On a fork PR the normal `pull_request` event
> gets a read-only token and cannot post a review. `pull_request_target` gets a
> write-scoped token — and therefore must never execute PR code. prsentinel
> reads the diff as data through the API only.

### Register the GitHub App

The App is what gives prsentinel its own identity: it posts as `your-app[bot]`
rather than `github-actions[bot]`, gets its own rate limit, and does not depend
on the repository allowing `GITHUB_TOKEN` to write (many organisations disable
that).

1. Create a GitHub App under **Settings → Developer settings → GitHub Apps**.
   Leave the webhook disabled; prsentinel is driven by Actions, not by
   deliveries.
2. Grant repository permissions **Contents: read**, **Pull requests: write**,
   **Issues: write**. (`Metadata: read` is added automatically.)
3. Generate a private key and download the `.pem` file.
4. Install the App on the repository you want reviewed.
5. Add two repository secrets: `APP_ID` and `APP_PRIVATE_KEY` — paste the whole
   PEM, including the `BEGIN`/`END` lines.

The installation is discovered from the repository, so you never have to look up
an `installation-id`. If a key arrives with literal `\n` sequences or
base64-encoded, prsentinel handles that too. When both an App and a token are
configured, the App wins.

> The App changes **who** posts the review. It does not change **when** the
> workflow runs — `pull_request_target` is still required, because the LLM key
> has to come from a secret and GitHub does not pass secrets to `pull_request`
> runs from forks.

## Providers

Set `llm-model` using a `provider/model` id. Anything OpenAI-compatible works:

```yaml
# Hosted
llm-model: openai/gpt-4o-mini
llm-model: anthropic/claude-sonnet
llm-model: groq/llama-3.1-70b
llm-model: openrouter/anthropic/claude-3.5-sonnet
llm-model: deepseek/deepseek-chat

# GitHub-hosted models (no extra key — uses the workflow token)
llm-model: github/gpt-4o-mini

# Self-hosted — the reason prsentinel exists
llm-model: ollama/qwen2.5-coder
llm-base-url: http://your-gpu-host:11434/v1
```

Because `ollama` and `vllm` are OpenAI-compatible, you can run prsentinel
against a model on your own hardware and send **no code to a third party**.

## Commands

Add a second workflow to enable slash commands and review-thread replies:

```yaml
# .github/workflows/prsentinel-commands.yml
name: prsentinel commands
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
permissions:
  contents: read
  pull-requests: write
  issues: write
jobs:
  command:
    if: github.event.comment.user.type != 'Bot'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.repository.default_branch }}
      - uses: vvamzy/prsentinel@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          llm-api-key: ${{ secrets.LLM_API_KEY }}
```

Then, in a PR comment:

| Command | What it does |
|---|---|
| `/review` | Review the commits added since the last review. |
| `/review all` | Re-review the whole pull request. |
| `/review <path>` | Re-review one file or directory. |
| `/explain` | Explain what the change does. |
| `/explain <path> <question>` | Answer a question about a file. |
| `/generate-tests [path]` | Propose tests for the changed code. |
| `/resolve` | Resolve the review threads prsentinel opened. |

You can also mention the bot: `@prsentinel explain the retry logic`. If you
registered an App under a different slug, mention that instead — `@your-app`.
prsentinel recognises its own login (`your-app[bot]`) and its mention form.

**Reply to a finding** and prsentinel answers in the thread — it reads the hunk
and the discussion so far, and will concede when you are right.

> **Who can run commands?** Only people with write access by default
> (`OWNER`, `MEMBER`, `COLLABORATOR`). Every command spends tokens, and
> comments are untrusted input, so this is configurable but conservative:
>
> ```yaml
> commands:
>   allowed_associations: ["OWNER", "MEMBER", "COLLABORATOR"]
> ```

## Configuration

Drop a `.prsentinel.yaml` in your repo root. Everything is optional.

```yaml
# 1 (terse, cheap) .. 5 (thorough, expensive)
effort: 3

reviews:
  drafts: false
  max_files: 50
  max_comments_per_file: 5
  max_comments_per_pr: 20
  confidence_threshold: 0.6      # drop hedged findings below this
  incremental: true               # only review new commits on later pushes
  request_changes_on_critical: false
  respect_linters: true           # suppress style nits when a linter exists
  path_filters:
    - "docs/**"
    - "!docs/architecture.md"     # ...but keep reviewing this one
    - "**/*.lock"

language: typescript

models:
  review: anthropic/claude-sonnet  # quality where it counts
  chat: openai/gpt-4o-mini         # cheap model for follow-ups
```

See [docs/configuration.md](docs/configuration.md) for the full reference.

## Action inputs

| Input | Default | Description |
|---|---|---|
| `github-token` | `${{ github.token }}` | Token used to read the PR and post the review. Ignored when App credentials are set. |
| `app-id` | — | GitHub App id. With `app-private-key`, posts as `<app>[bot]`. |
| `app-private-key` | — | GitHub App private key. PEM, `\n`-escaped PEM, or base64 PEM. Use a secret. |
| `installation-id` | auto | App installation id. Discovered from the repository when omitted. |
| `llm-api-key` | — | API key. Falls back to `LLM_API_KEY` / `OPENAI_API_KEY`. |
| `llm-model` | `openai/gpt-4o-mini` | Model id. |
| `llm-base-url` | — | Override the API base URL. |
| `pr-number` | auto | Pull request number. |
| `config-path` | `.` | Where to look for `.prsentinel.yaml`. |
| `dry-run` | `false` | Write the payload to `out/` instead of posting. |
| `bot-login` | auto | Login prsentinel posts as, for detecting its own comments. |

## Outputs

| Output | Description |
|---|---|
| `review-url` | HTML URL of the posted review. |
| `payload-file` | Path to the payload in dry-run mode. |
| `comment-count` | Number of inline comments. |
| `finding-count` | Findings after filtering. |
| `comment-url` | URL of a comment posted by a slash command. |
| `reply-url` | URL of a review-thread reply. |

## How it works

```
gather ──▶ map ──▶ reduce ──▶ filter ──▶ one review
```

1. **Gather** — fetch the diff, then full head content for files that need it.
2. **Map** — one independent LLM call per changed file, in parallel. Each
   returns findings plus a summary. Cheaper and higher quality than one giant
   prompt.
3. **Reduce** — a single call synthesizes the walkthrough and de-duplicates
   findings. It sees the *summaries*, not the raw diffs, which keeps the top
   comment readable.
4. **Filter** — deterministic, LLM-free noise reduction: hunk containment,
   confidence thresholds, generated-file skipping, linter detection, dedupe,
   and caps.
5. **Post** — one `pulls.createReview` call with every inline comment.

Step 4 is the part that matters most. Most review bots are "LLM + GitHub API";
the difference between useful and obnoxious is entirely in the filtering.

## Security model

Running on `pull_request_target` means the workflow has a **write token and
access to secrets** while a fork PR could contain hostile code. The rule is
absolute:

> Never check out, build, or execute code from the PR head.

prsentinel reads patches and file contents as data through the GitHub API. The
same applies to the command workflows: `issue_comment` and
`pull_request_review_comment` can be triggered by anyone who can comment, so
they check out the default branch and refuse commands from users without write
access.

The bundled CI guard (`scripts/check-pr-target-safety.mjs`) fails the build if
any privileged workflow ever adds a head-ref checkout. The guard has its own
tests (`tests/guard.test.ts`) because a silently broken guard is worse than no
guard. See [docs/SECURITY.md](docs/SECURITY.md).

Using a GitHub App does not change this. The App token replaces `GITHUB_TOKEN`
and gives the review a real identity, but the workflow is still privileged and
still must never touch PR code.

## Cost control

Token spend is the failure mode that kills self-hosted review bots. prsentinel
caps it from several directions:

- `max_files`, `max_total_diff_bytes`, `max_file_bytes` hard limits
- lockfiles, build output, and minified files are never sent to a model
- `effort` scales how much surrounding context is gathered
- `confidence_threshold` keeps low-value findings out of the prompt budget
- a separate cheaper `chat` model

Use `dry-run: true` to see exactly what would be posted, for free.

## Development

```bash
npm ci
npm run typecheck
npm test          # 149 tests, no network required
npm run build
```

The test suite includes an end-to-end pipeline test with a stub LLM, so you can
iterate on prompts and filtering without spending a cent.

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
