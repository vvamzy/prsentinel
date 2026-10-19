# Changelog

All notable changes to prsentinel are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **GitHub App authentication**: set `app-id` + `app-private-key` and prsentinel
  posts as `<app>[bot]` instead of `github-actions[bot]`, with its own rate
  limit and no dependence on `GITHUB_TOKEN` write access. The App JWT is signed
  with `node:crypto` (no new dependency); the private key is accepted as a PEM,
  a `\n`-escaped PEM, or base64; the installation id is discovered from the
  repository. `github-token` still works and is used when no App is configured.
- **Slash commands** via `issue_comment`: `/review`, `/review all`,
  `/review <path>`, `/explain`, `/explain <path> <question>`, and
  `/generate-tests [path]`. Mentioning the bot (`@prsentinel …`) works too.
- **Review-thread replies** via `pull_request_review_comment`: reply to a
  prsentinel finding and it answers with the hunk and the thread as context.
  It only joins threads it started, and concedes when the developer is right.
- **Command permissions** (`commands.allowed_associations`): commands are
  limited to `OWNER`/`MEMBER`/`COLLABORATOR` by default, because comments are
  untrusted input and every command spends tokens. Refused commands get an
  explanatory note instead of failing silently.
- **Test-style detection** for `/generate-tests`: finds a sibling test file via
  the tree API and shows it to the model so output matches repo conventions.
- **Review pipeline extracted** to `src/pipeline.ts` so the automatic review
  and `/review` share one implementation — including scope narrowing and the
  incremental marker.
- **Testable security guard**: `scripts/check-pr-target-safety.mjs` now exports
  its detection functions and is covered by `tests/guard.test.ts`. The guard
  also covers `issue_comment` and `pull_request_review_comment`, which are
  privileged in the same way `pull_request_target` is.
- **Review pipeline**: gather → map → reduce → filter → single `createReview` call.
- **Walkthrough, file summaries, and inline findings** delivered in one review,
  so a PR gets one coherent comment instead of a stream of noise.
- **Applyable suggestions**: findings may carry a `suggestion` block that
  GitHub renders with a one-click Apply button.
- **Hunk-accurate line mapping** (`src/github/diff.ts`) with range clamping so a
  review never fails with a 422 because a comment landed outside the diff.
- **Deterministic filter phase** (`src/review/filter.ts`): confidence
  thresholds, hunk containment, generated/lockfile skipping, linter detection,
  near-duplicate removal, and per-file/per-PR caps.
- **Pluggable LLM providers**: OpenAI-compatible (OpenAI, OpenRouter, Groq,
  Together, Fireworks, DeepSeek, plus self-hosted **Ollama** and **vLLM**) and
  Anthropic. Model ids route by prefix; `llm-base-url` overrides everything.
- **Two-model support**: a quality model for review and a cheaper one for chat.
- **`.prsentinel.yaml`** configuration with effort levels, path filters,
  comment caps, and per-phase model selection.
- **Incremental review** via an invisible last-reviewed-SHA marker embedded in
  the review body — no external state, self-healing.
- **Dry-run mode** that writes the payload to `out/` instead of posting.
- **In-process cost controls**: files are filtered *before* any model call.
- **Security guard** (`scripts/check-pr-target-safety.mjs`) that fails CI if a
  privileged workflow checks out PR head code.
- **108 tests**, including an end-to-end pipeline test with a stub LLM and an
  offline fixture harness (`npm run dev:review`).
- Docker container action, Apache-2.0 licensed.

### Notes
- Runs on `pull_request_target` so fork PRs can be reviewed. This requires the
  "never execute PR code" rule documented in `docs/SECURITY.md`.

### Not yet implemented
- `/resolve` — the parser recognises it, but resolving a thread needs the
  GraphQL thread node id, which is Phase 3 work.
- GitHub App authentication (fork-PR support currently relies on
  `pull_request_target`).
- Local CLI for pre-push review.
- Indexing the repository for cross-file context beyond the changed files.
