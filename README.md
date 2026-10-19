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

> **Pre-release.** These examples pin `@main`, because no stable tag exists yet.
> `@v1` will be tagged once the review prompts have been validated against real
> pull requests — until then, prompt behaviour can change between commits.

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
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.pull_request.base.sha }}

      - uses: vvamzy/prsentinel@main
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

# A model server you run yourself
llm-model: ollama/qwen2.5-coder
llm-base-url: http://your-gpu-host:11434/v1
```

Because `ollama` and `vllm` are OpenAI-compatible, prsentinel can talk to a
model on your own hardware — the model stays warm, and you can use something
much larger than a runner could hold. prsentinel is the *bot*; the model is
something you point it at.

`llm-model` is a workflow input. In `.prsentinel.yaml` the equivalent is
`models.review`, and the config file wins; prsentinel warns when the two
disagree.

## Local models (no key, no third party)

Prefix a model with `local/` and prsentinel downloads a GGUF and runs it **on
the Actions runner**, inside the action container:

```yaml
- uses: vvamzy/prsentinel@main
  with:
    llm-model: local/qwen2.5-coder-7b-instruct
```

Nothing is sent to a third party, and `llm-api-key` is not required.

| Model | Size | Notes |
|---|---|---|
| `local/qwen2.5-coder-7b-instruct` | ~4.4 GB | Default. Best quality that fits the free runner. |
| `local/qwen2.5-coder-3b-instruct` | ~2.0 GB | 2–3× faster, noticeably weaker. |
| `local/qwen2.5-coder-1.5b-instruct` | ~1.0 GB | Fastest. Expect noise. |

> **Read this before choosing it.** A free GitHub-hosted runner is 4 vCPU with
> no GPU, so a 7B model generates a few tokens per second and asks for minutes
> per file. Measured directly with the bundled smoke test: of 14 files, only **2**
> produced a result inside a 300-second budget. prsentinel therefore streams from
> a local server and reviews **one file at a time** — concurrency cannot help,
> because that is all a single-slot server can do anyway — so budget a few minutes
> per file and expect a 20-file pull request to take most of an hour. On quality
> it is plainly below `gpt-4o-mini`, which costs about $0.15 per million input
> tokens. Use it when *privacy or zero cost* matters more than speed and
> precision — not as a default.

Weights are cached and checksummed; a killed job never leaves a half-download
that a later run trusts. To keep them between runs, point `local-model-cache` at
an `actions/cache` directory:

```yaml
- uses: actions/cache@v6
  with:
    path: .prsentinel/models
    key: prsentinel-model-${{ hashFiles('.prsentinel.yaml') }}
- uses: vvamzy/prsentinel@main
  with:
    llm-model: local/qwen2.5-coder-7b-instruct
    local-model-cache: .prsentinel/models
```

See [ROADMAP.md](ROADMAP.md) for the alternative — a warm server on your own
hardware — and why it is not the bundled default.

`llm-model` is not the only thing that chooses a model: `models.review` in
`.prsentinel.yaml` wins over it. If both are set and disagree, prsentinel says so
in the log rather than quietly ignoring one of them.

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
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.repository.default_branch }}
      - uses: vvamzy/prsentinel@main
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
| `llm-api-key` | — | API key. Falls back to `LLM_API_KEY` / `OPENAI_API_KEY`. Not needed for a `local/…` model. |
| `llm-model` | `openai/gpt-4o-mini` | Model id, e.g. `openai/gpt-4o-mini` or `local/qwen2.5-coder-7b-instruct`. Overridden by `models.review`. |
| `llm-base-url` | — | Override the API base URL. |
| `local-model-cache` | `.prsentinel/models` | Where downloaded local model weights are kept. |
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

## Container image

The action is a Docker container action, so GitHub builds it from the
`Dockerfile` on every job. CI also publishes a prebuilt image to the GitHub
Container Registry if you would rather pull one:

```bash
docker pull ghcr.io/vvamzy/prsentinel:main
```

| Tag | Tracks |
|---|---|
| `main` | The current release. |
| `dev` | The integration branch, ahead of `main`. |
| `sha-<short>` | A single commit. |
| `v1`, `v1.2`, `v1.2.3` | Release tags, once `v1` exists. |

Tags are explicit rather than `latest`-based, because the default branch is
`dev` — an automatic `latest` would track unreleased code.

To measure what a bundled model actually costs on a free runner, dispatch the
manual **Local model smoke test** workflow: it pulls this image, reviews a real
pull request with a chosen `local/…` model, and reports wall-clock time and
findings. It fails if any file is dropped, so a green run means the review really
happened.

The image is additive: the action still builds from its own `Dockerfile`, which
is what keeps `.github/workflows/self-test.yml` honest, since `uses: ./`
compiles the exact revision it checked out.

Every input has an environment fallback, so the image can also be driven
directly:

```bash
docker run --rm \
  -v "$PWD:/github/workspace" -w /github/workspace \
  -e GITHUB_WORKSPACE=/github/workspace \
  -e GITHUB_TOKEN -e GITHUB_REPOSITORY \
  -e DRY_RUN=true -e PR_NUMBER=123 \
  -e LLM_MODEL=local/qwen2.5-coder-7b-instruct \
  ghcr.io/vvamzy/prsentinel:main
```

## Development

```bash
npm ci
npm run typecheck
npm test          # no network required
npm run build
```

Two checks cover things the unit tests cannot. Both are documented in
[CONTRIBUTING.md](CONTRIBUTING.md):

- `scripts/verify-local-model.sh` runs in CI on every change. It starts the
  bundled server inside the built image against a 1 MB test model and speaks the
  real `/v1/chat/completions` route. Run it locally against a local image with
  `docker build -t prsentinel-action . && docker run --rm -i --entrypoint /bin/sh prsentinel-action < scripts/verify-local-model.sh`.
- The **Local model smoke test** workflow (manual dispatch) runs a real dry-run
  review with a bundled model and reports wall-clock time and payload size. This
  is the only measurement of what a bundled 7B actually costs on a free runner.

The test suite includes an end-to-end pipeline test with a stub LLM, so you can
iterate on prompts and filtering without spending a cent.

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
