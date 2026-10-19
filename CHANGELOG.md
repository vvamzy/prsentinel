# Changelog

All notable changes to prsentinel are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
- Slash commands (`/review`, `/explain`, `/generate-tests`) — parser exists in
  `src/state.ts`, wiring lands in Phase 2.
- Conversational replies on review threads.
- GitHub App authentication (fork-PR support currently relies on
  `pull_request_target`).
- Local CLI for pre-push review.
