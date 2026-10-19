# Changelog

All notable changes to prsentinel are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Bundled local models** (`llm-model: local/…`). prsentinel can now run the
  model itself, inside the action container, with no API key and no code leaving
  the job. `llama-server` is started on loopback and reached through the
  existing OpenAI-compatible provider, so the review pipeline is unchanged.
  Three Qwen2.5-Coder sizes ship (`7b`, `3b`, `1.5b`), each verified against the
  SHA-256 recorded in its HuggingFace LFS pointer, with the 7B as the default
  because the free runner has 4 vCPU and CPU throughput — not RAM — is the real
  constraint. Weights are cached between runs, and a half-written download is
  never mistaken for a complete one.
- **`local-model-cache` input** to point the weight cache at an
  `actions/cache` directory.
- **Container image published to GHCR** (`publish.yml`), tagged per branch
  (`main`, `dev`), per commit, and per semantic version. The action still builds
  from its own `Dockerfile` — that is what keeps `uses: ./` dogfooding honest, so
  the image is an additive path for anyone who would rather pull than build. Tags
  are explicit rather than `latest`-based, because the default branch is `dev`
  and an automatic `latest` would track unreleased code.
- **A reproducible local-model smoke test**
  (`.github/workflows/local-model-smoke.yml`, manual dispatch): pulls the
  published image, points the repository's config at a bundled model, runs a real
  dry-run review of a chosen pull request, caches the weights, and reports
  wall-clock time, the comment count, and the walkthrough length. This is the
  only thing that measures what a bundled model actually costs on a free runner.
- **`scripts/verify-local-model.sh`**: starts the bundled server inside the built
  image against a 1 MB test model and speaks the real `/v1/chat/completions`
  route. It runs on every change (as the `Docker image builds` job) and locally
  against a local image, with no model weights to download.
- **`ROADMAP.md`**, recording the self-hosted-inference-server path and the
  larger-runner/GPU option, with the reasons each is not built yet.
- **Live-PR harness**: `npm run dev:pr -- owner/repo#123` fetches a real pull
  request over the API and runs the full pipeline against a real model, with
  `--out` saving it as a fixture so it can be re-run for free. This is the only
  way to judge whether the *suggestions* are good, which the offline stub
  harness cannot assess.
- **`/resolve`**: resolves the review threads prsentinel opened, via the
  GraphQL thread node id that no REST endpoint exposes. Only threads *we*
  started are touched — a reviewer's thread we merely replied to is left alone —
  and one failure does not stop the rest.
- **GitHub App authentication**: set `app-id` + `app-private-key` and prsentinel
  posts as `<app>[bot]` instead of `github-actions[bot]`, with its own rate
  limit and no dependence on `GITHUB_TOKEN` write access. The App JWT is signed
  with `node:crypto` (no new dependency); the private key is accepted as a PEM,
  a `\n`-escaped PEM, or base64; the installation id is discovered from the
  repository. `github-token` still works and is used when no App is configured.
  `parseSlashCommand` now takes every identity at once, so `@your-app` keeps
  matching under a custom App slug (a GitHub App is *logged* as `your-app[bot]`
  but *mentioned* as `@your-app`), and a mention no longer matches a longer name
  that merely starts with it.
- **Reusable workflow accepts App secrets** (`app-id`, `app-private-key`,
  `installation-id`), so other repositories can call it without a PAT.
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
- **257 tests**, including an end-to-end pipeline test with a stub LLM and an
  offline fixture harness (`npm run dev:review`).
- Docker container action, Apache-2.0 licensed.

### Changed
- **`llm-model` no longer carries an action-level default**, so an unset input
  is distinguishable from one set to `openai/gpt-4o-mini`. The default still
  applies, in code. This also lets prsentinel warn when `.prsentinel.yaml`
  overrides a model the workflow explicitly asked for — previously that
  mismatch was silent, which made switching models look broken.
- **Install instructions pin `@main`**, not the not-yet-existing `@v1`. `v1`
  will be tagged once the review prompts have been validated against real pull
  requests.
- **Workflow actions updated to their current majors** (`actions/checkout@v7`,
  `actions/setup-node@v7`). `checkout` v7 also refuses to check out a fork PR
  under `pull_request_target` or `workflow_run`, which prsentinel never does —
  a second line of defence behind the safety guard.
- **`pr-number` accepts `PR_NUMBER` from the environment**, like every other
  input. It was the only one without a fallback, which left the container
  impossible to drive by hand outside Actions.
- **Input and environment resolution moved to `src/env.ts`** so it can be tested
  without executing the action — `index.ts` runs `main()` on import, which is
  right for an entry point and useless for a unit test.

### Fixed
- **`config-path` did nothing.** `action.yml`, the README, and the reusable
  workflow all advertised `config-path`, but the code read an *undeclared*
  `repo-root` input, so the documented knob was silently ignored and the
  repository root always fell back to `GITHUB_WORKSPACE`.
- **The bundled inference server could not start.** The runtime image was missing
  `libgomp.so.1` — llama.cpp links the GNU OpenMP runtime — so every `local/…`
  model died at launch with an unresolved-library error.
- **The Docker check could not fail.** It ran `llama-server --help` under
  `|| true` and asserted only that the output was non-empty, so the crash message
  above satisfied it and a completely broken image reported success. It now
  rejects an unresolved-library message and, more to the point, runs real
  inference. `ldd` was misleading for the same reason: it exits 0 with a
  dependency missing, so the Dockerfile now reads its output rather than trusting
  its status.
- **The CI smoke test failed on every pull request.** `Verify the bundle runs`
  executed the bundle against the ambient GitHub event, so under `pull_request`
  it correctly started reviewing the PR and then died on credentials that CI
  deliberately does not have. Having never seen a pull request, the job had
  always passed on `push`. It now runs against an event with no pull request,
  which is what it was trying to assert.
- **The dogfooding job reported an unconfigured secret as a broken change.**
  `self-test.yml` now skips with a notice when `LLM_API_KEY` is unset.

### Notes
- Runs on `pull_request_target` so fork PRs can be reviewed. This requires the
  "never execute PR code" rule documented in `docs/SECURITY.md`.

### Not yet implemented
- Local CLI for pre-push review.
- Indexing the repository for cross-file context beyond the changed files.
