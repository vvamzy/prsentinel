# Configuration reference

prsentinel reads `.prsentinel.yaml` (or `.prsentinel.yml`) from the repository
root. Every field is optional; the defaults below apply when a file is absent.

```yaml
effort: 3

reviews:
  enabled: true
  drafts: false
  max_files: 50
  max_file_bytes: 200000
  max_total_diff_bytes: 1500000
  max_comments_per_file: 5
  max_comments_per_pr: 20
  confidence_threshold: 0.6
  incremental: true
  request_changes_on_critical: false
  path_filters: []
  respect_linters: true

chat:
  auto_reply: true

commands:
  enabled: true
  allowed_associations: ["OWNER", "MEMBER", "COLLABORATOR"]
  max_explain_files: 5

language: ''

models:
  review: ''
  chat: ''

comment_prefix: '**{{severity}}** · `{{category}}` · {{title}}'
```

## `effort`

`1`–`5`. Controls how much surrounding context is gathered per changed hunk,
and how aggressively large changes are summarized.

| Value | Context lines per hunk | Use when |
|---|---|---|
| 1 | 8 | Large mechanical diffs; you want speed and low cost. |
| 2 | 15 | Everyday small PRs. |
| 3 | 30 | **Default.** Balanced. |
| 4 | 50 | Complex logic you want reviewed deeply. |
| 5 | 80 | Security-sensitive or high-risk changes. |

## `reviews`

### `enabled`
Turn the whole bot off without removing the workflow. Default `true`.

### `drafts`
Review draft PRs. Default `false` — drafts are usually still in flux.

### `max_files`
Maximum number of changed files to send to the model, after filtering.
Default `50`. Files beyond the cap are listed as skipped in the review body.

### `max_file_bytes`
Per-file ceiling on fetched file content used as context. Default `200000`.
Larger files are still reviewed from their patch; only the extra context is
dropped.

### `max_total_diff_bytes`
Global ceiling on total diff bytes across all reviewed files. Default
`1500000` (~1.5 MB). This is the main token-cost circuit breaker.

### `max_comments_per_file`
Default `5`. Caps the noisiest dimension — one file generating twenty comments.

### `max_comments_per_pr`
Default `20`. Hard ceiling on inline comments in a single review. Findings are
sorted by severity before the cap is applied, so criticals always survive.

### `confidence_threshold`
`0`–`1`, default `0.6`. Findings the model reports below this confidence are
dropped. Raising it makes the bot quieter; lowering it makes it chattier.

### `incremental`
Default `true`. On a `synchronize` event, review only the files touched by
commits added since the last prsentinel review. The last-reviewed commit SHAs
is stored in an invisible marker in the previous review body, so there is no
external state to manage. If the marker is missing, prsentinel falls back to a
full review.

### `request_changes_on_critical`
Default `false`. When `true`, a `critical` finding submits the review as
`REQUEST_CHANGES`, which can block merging on protected branches. Use with
care — a false positive then blocks a PR.

### `path_filters`
Gitignore-style list. A plain pattern **excludes** matching paths; a `!`
prefix re-includes. Last match wins.

```yaml
path_filters:
  - "docs/**"                 # exclude all docs
  - "!docs/architecture.md"   # ...but review this one
  - "**/*.min.js"             # exclude minified files
  - "migrations/**"           # exclude generated migrations
```

Glob semantics:

| Pattern | Matches |
|---|---|
| `*.min.js` | `app.min.js` — but **not** `a/app.min.js` |
| `**/*.min.js` | `app.min.js` and `a/app.min.js` |
| `docs/**` | everything under `docs/` |
| `**/lock.json` | `lock.json` and `x/y/lock.json` |

### `respect_linters`
Default `true`. When the PR touches a linter or formatter config (ESLint,
Prettier, Ruff, RuboCop, rustfmt, clang-format, `pyproject.toml`,
`.editorconfig`, …), prsentinel suppresses all `style` findings. If your repo
already lints, style comments are pure noise.

## `chat`

### `auto_reply`
Default `true`. When enabled, prsentinel answers replies inside review threads
that it started. It never joins a thread between two humans.

## `commands`

Slash commands and their permissions.

```yaml
commands:
  enabled: true
  allowed_associations: ["OWNER", "MEMBER", "COLLABORATOR"]
  max_explain_files: 5
```

### `enabled`
Default `true`. Turn off all slash commands without removing the workflow.

### `allowed_associations`
Default `["OWNER", "MEMBER", "COLLABORATOR"]`.

The comments that trigger commands are untrusted input, and every command costs
tokens (and could be used to exhaust your API quota). prsentinel compares the
commenter's GitHub `author_association` against this list.

GitHub's possible values: `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`,
`FIRST_TIME_CONTRIBUTOR`, `NONE`.

When a commenter is not permitted, prsentinel posts a short note explaining the
rule rather than failing silently — so contributors understand why nothing
happened.

> **Think before adding `CONTRIBUTOR`.** It means anyone whose PR was merged
> once can trigger LLM calls on any PR in the repository.

### `max_explain_files`
Default `5`. Caps how many files `/explain` and `/generate-tests` inline into
the prompt. Raise it for better answers on large PRs, at higher token cost.

## `language`
An optional hint about the codebase's primary language. Improves prompt quality
on polyglot repos. Empty means "infer it".

## `models`

### `review`
Model id for the review pipeline. Overrides the `llm-model` Action input when
set, and prsentinel warns when the two disagree so an override is never silent.

Besides the hosted providers, `local/<id>` runs a bundled GGUF on the runner —
see [Local models](../README.md#local-models-no-key-no-third-party). The default
7B model needs no key, but a free runner is 4 vCPU with no GPU, so a review
takes minutes rather than seconds.

### `chat`
Cheaper model for conversational follow-ups. Falls back to `review`.

Two models is deliberate: spend on review quality, save on chat.

## `comment_prefix`
Markdown template rendered at the top of every inline comment.
Placeholders: `{{severity}}`, `{{category}}`, `{{title}}`.

```yaml
comment_prefix: '[{{severity}}] {{title}}'
```

## Generated files

These are never sent to a model, regardless of configuration:

```
**/package-lock.json  **/yarn.lock       **/pnpm-lock.yaml   **/bun.lockb
**/Cargo.lock         **/go.sum          **/poetry.lock      **/composer.lock
**/Gemfile.lock       **/dist/**         **/build/**         **/node_modules/**
**/*.min.js           **/*.min.css       **/*.map            **/*.snap
**/generated/**       **/__generated__/**  **/*.pb.go        **/*.generated.*
```

## Validation

An invalid config fails the run with a message naming the offending field:

```
Invalid .prsentinel.yaml:
  reviews.confidence_threshold: Number must be less than or equal to 1
```
