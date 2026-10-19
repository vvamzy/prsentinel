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

      - uses: your-org/prsentinel@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          llm-api-key: ${{ secrets.LLM_API_KEY }}
          llm-model: openai/gpt-4o-mini
```

Add your API key as a repository secret named `LLM_API_KEY`. Done.

> **Why `pull_request_target`?** On a fork PR the normal `pull_request` event
> gets a read-only token and cannot post a review. `pull_request_target` gets a
> write-scoped token — and therefore must never execute PR code. prsentinel
> reads the diff as data through the API only.

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
| `github-token` | `${{ github.token }}` | Token used to read the PR and post the review. |
| `llm-api-key` | — | API key. Falls back to `LLM_API_KEY` / `OPENAI_API_KEY`. |
| `llm-model` | `openai/gpt-4o-mini` | Model id. |
| `llm-base-url` | — | Override the API base URL. |
| `pr-number` | auto | Pull request number. |
| `config-path` | `.` | Where to look for `.prsentinel.yaml`. |
| `dry-run` | `false` | Write the payload to `out/` instead of posting. |

## Outputs

| Output | Description |
|---|---|
| `review-url` | HTML URL of the posted review. |
| `payload-file` | Path to the payload in dry-run mode. |
| `comment-count` | Number of inline comments. |
| `finding-count` | Findings after filtering. |

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
bundled CI guard (`scripts/check-pr-target-safety.mjs`) fails the build if any
privileged workflow ever adds a head-ref checkout. See
[docs/SECURITY.md](docs/SECURITY.md).

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
npm test          # 100 tests, no network required
npm run build
```

The test suite includes an end-to-end pipeline test with a stub LLM, so you can
iterate on prompts and filtering without spending a cent.

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
