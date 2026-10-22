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
  `max-files` (default 3) bounds the run, because a local model is served one
  request at a time and a whole pull request is an hour rather than a smoke test.
- **`scripts/verify-local-model.sh`**: starts the bundled server inside the built
  image against a 1 MB test model and speaks the real `/v1/chat/completions`
  route. It runs on every change (as the `Docker image builds` job) and locally
  against a local image, with no model weights to download.
- **`ROADMAP.md`**, recording the self-hosted-inference-server path and the
  larger-runner/GPU option, with the reasons each is not built yet.
- **Live-PR harness**: `npm run dev:pr -- owner/repo#123` fetches a real pull
  request over the API and runs the full pipeline against a real model, with
  `--out` saving it as a fixture so it can be re-run for free.
- **A quality eval harness** (`npm run eval`, `evals/`): runs the real pipeline
  over labelled diffs and scores precision, recall, and anchoring per case, so
  "is the review any good?" has a number instead of an anecdote. The suite
  deliberately includes *clean* diffs where the right answer is silence, because
  inventing a problem — not missing one — is the failure mode that annoys
  people. Every false positive is printed with its file and line, so a bad run
  is diagnosable. `--min-precision`/`--min-recall` make it a gate, and
  `--json`/`--markdown-file` make it CI-shaped, which is what the manual
  **Quality eval** workflow uses. `npm run eval:stub` runs the whole thing with
  no model and no network, so the harness is covered by ordinary CI.
- **A self-hosted inference guide**
  ([docs/self-hosted-models.md](docs/self-hosted-models.md)): Ollama and vLLM
  set-ups, TLS, an internal-only endpoint, and the two ways your own server
  differs from a hosted API — concurrency, and the 300-second first-token
  timeout on a non-loopback URL. It also says plainly that prsentinel is the
  bot, and the model is something you point it at.
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
- **309 tests**, including an end-to-end pipeline test with a stub LLM, an
  offline fixture harness (`npm run dev:review`), and unit tests for the eval
  scorer — the instrument behind every quality number this project reports.
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
- **Responses from a server on loopback are streamed, and no longer fanned out.**
  A local model has unbounded latency and serves one request at a time, so
  concurrency bought nothing and cost a lot. `LLM.concurrency` now returns 1 for a
  bundled `local/…` model and for any loopback `llm-base-url` (`localhost`,
  `127.0.0.1`, `[::1]` — which covers the Ollama and vLLM defaults), and the
  hosted default of 6 everywhere else.
- **The map prompt asks the model to check its own claims.** A bundled 7B on the
  first real local run reported that a changelog "does not specify the default
  size" on the very line that specified it, and that a file had trailing
  whitespace it did not have. The prompt now says to read the changed lines back
  before reporting, to leave whitespace to the linter, and to answer a suggestion
  with replacement code or nothing.
- **The LLM facade is an interface now.** The pipeline takes `LLMFacade` rather
  than the `LLM` class, so a stub written against it is checked by the compiler
  instead of quietly losing whatever the facade gains next.
- **`LLM_MODEL` overrides `.prsentinel.yaml` in the development harness**, where
  it did not: the environment asked for a model and the repository's own config
  silently answered with a cloud one, so the run measured something else. The
  Action keeps the config in charge — there the config is the project's
  decision, and the input is one pull request's.
- **Token budgets are bounded to what the answer needs.** A map call may spend
  1024 tokens and a reduce call 1024, down from 4096 each. On a CPU-only runner
  a token costs about a quarter of a second, so the old ceiling was a
  seventeen-minute promise per call — and a model that started rambling spent
  all of it and returned unparseable JSON. One file of the first real local run
  burned thirteen and a half minutes of a 4096-token budget and produced nothing
  usable.
- **The reduce phase judges findings by id instead of rewriting them.** It used
  to answer with the whole finding set — title, body and replacement code for
  every finding — and that echo was the largest thing it asked a model to
  write. On a CPU-only runner it was two thirds of the review's wall clock (11
  minutes of a 17-minute run), and a model asked to repeat a finding will
  happily rewrite it into something else. It now answers with the walkthrough,
  a summary per file, and the ids of the findings to remove. The findings
  themselves are the map phase's, unchanged. A finding survives unless its id
  is in the drop list, so a response that was cut off before the list — or that
  named ids that do not exist — can no longer silently delete a real finding.
  It did: a truncated reduce response took every finding of the review with it.
- **Measured, on a free 4 vCPU runner with the bundled 7B**: a one-file review
  went from 17 minutes of wall clock to 3–6, and a three-file review from 13
  minutes to 9. The reduce phase is now about a minute instead of eleven; the
  map phase is one to three minutes per file, depending on whether the model
  keeps its answer short or has to be cut off at the token limit. The 1.5B
  reviews three files in 5 minutes.
- **The prompts bound the answer, not just the tokens.** Every map call is now
  told to report at most five findings and to keep the summary short, and the
  reduce call is told to keep the walkthrough to a few paragraphs. Before this
  only a "large change" got a limit, so an ordinary small diff had no bound at
  all and the model could keep writing.
- **The smoke test is quick by default**: `max-files` 3 → 1 and a 30-minute job
  timeout instead of 60. A single-file review of a pull request is the check
  worth repeating; measuring a whole pull request is a separate, deliberate
  thing. Dispatch it with `model: local/qwen2.5-coder-1.5b-instruct` for a
  fast pass that only proves the pipeline still runs.

### Fixed
- **The reusable workflow could not be called from another repository.** It ran
  the action as `uses: ./`, which resolves against the *caller's* checkout —
  where there is no `action.yml` — so every cross-repository call failed at its
  first step. It now references the published action, and `llm-api-key` is
  optional (it was required, which made the bundled model unreachable through
  this workflow entirely). The model weights are cached and the job has a
  timeout, so one file the model never finishes cannot hold a runner for six
  hours.
- **A keyless self-hosted endpoint no longer demands a dummy key.** Setting
  `llm-base-url` — Ollama, vLLM, an internal gateway — means the endpoint is
  yours, and those are routinely served with no auth at all. The run used to
  fail with "No LLM API key configured" until you pasted an invented string into
  a secret. An empty key now also omits the `Authorization` header instead of
  sending a malformed `Bearer `, which a strict gateway would reject.
- **A review posted `null` as the suggested change.** Asked to leave a
  suggestion out, the bundled 7B wrote the *string* `"null"`, and the parser
  took any non-null value as code — so the review offered the reader a change
  that replaced their line with the word `null`. `"null"`, `"none"`,
  `"undefined"`, `"n/a"` and `"-"` now all mean "no suggestion". The prompt was
  reworded too: it asks for an empty suggestion rather than for `null`, which
  is a word a small model will happily copy.
- **A response cut off mid-JSON threw the file away.** A model that hits the
  token limit leaves half an object behind, and the file was dropped even
  though the call had already cost minutes. The truncated object is now closed
  and parsed, and the log says so, so a partial answer is visible rather than
  silent. The reduce phase goes one step further: a truncated walkthrough is
  cut back to its last complete sentence.
- **The offline harness stopped working.** Its stub reviewer had a `complete`
  method and nothing else, so when the facade grew `concurrency()` — which
  `mapPhase` reads to size its worker pool — `npm run dev:review -- --stub`
  died with `TypeError: llm.concurrency is not a function`. The harness also
  stops the bundled server it starts, instead of leaving it holding gigabytes
  of weights.
- **Bundled local models skipped most of the files and reported success.** A
  single map call on a 7B model takes longer than five minutes on a free 4 vCPU
  runner, and a non-streaming completion sends no bytes at all until the whole
  thing has been generated — so Node's `fetch` abandoned the request at its
  300-second response-headers timeout, the pipeline logged `TypeError: fetch
  failed`, dropped that file, and carried on. The first real run of the smoke test
  reviewed **2 of 14 files** and went green. Loopback responses are now streamed:
  the headers arrive immediately and the body keeps the connection alive token by
  token, so a slow local model can take as long as it needs.
- **`TypeError: fetch failed` said nothing about what had failed.** `fetch`
  reports every transport error — timeout, reset, refused connection — the same
  way, and buries the reason in `cause`. Error messages now include it, which is
  what turned the run above from a mystery into a diagnosis.
- **A prose "suggestion" was posted as an applicable change.** GitHub renders a
  ```suggestion block as a change the reader can apply, so a model that answered
  "remove the trailing whitespace" instead of writing the replacement code would
  have replaced the commented line with that sentence. A suggestion that is prose
  is now stripped from code files — documentation is exempt, because there prose
  *is* the content — and the finding keeps its explanation.
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
