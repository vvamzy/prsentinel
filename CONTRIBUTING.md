# Contributing to prsentinel

Thanks for helping. This project exists to be a genuinely useful,
self-hostable review bot, and the highest-leverage contributions are usually
about **filtering quality** — not prompt wording.

## Getting started

```bash
git clone https://github.com/vvamzy/prsentinel
cd prsentinel
npm ci
npm run typecheck
npm test
npm run build
```

Node 22+ is required (see `engines` in `package.json`). The test suite runs
without network access and without an API key.

## Branches

`dev` is where work lands, and it is the default branch — pull requests target
it unless you say otherwise. `main` is the release branch and only moves when
`dev` is promoted into it.

`main` is protected: merges require a pull request and a passing CI run, and
direct pushes are rejected. So the flow is always `dev` → PR → `main`.

```bash
git switch dev
# ... make your changes ...
git push origin dev
```

## Project layout

```
src/
  index.ts            entry point; routes on the GitHub event
  env.ts              input + environment resolution (testable on its own)
  pipeline.ts         the review pipeline (gather → map → reduce → filter)
  chat.ts             review-thread replies
  config.ts           .prsentinel.yaml schema, glob/path-filter logic
  state.ts            incremental-review markers, slash-command parsing
  commands/
    index.ts          slash-command registry + help text
    shared.ts         scope/question parsing, patch preparation
    review.ts         /review
    explain.ts        /explain
    generate-tests.ts /generate-tests
    resolve.ts        /resolve (GraphQL thread resolution)
  github/
    client.ts         octokit wrapper — all GitHub API shapes live here
    app-auth.ts       GitHub App JWT signing + installation tokens
    auth.ts           credential resolution (App or token)
    diff.ts           unified-diff parsing  ← hardest code, most tests
    context.ts        decides what extra file content to fetch
    review.ts         builds the createReview payload
    pr-ref.ts         parses owner/repo#123 references
  llm/
    provider.ts       provider interface, JSON extraction, concurrency pool
    openai.ts         OpenAI-compatible (covers OpenAI/Groq/Ollama/vLLM/…)
    anthropic.ts      Anthropic Messages API
    registry.ts       model id → provider routing
    local.ts          bundled llama.cpp models (local/…): download, serve
  review/
    prompts.ts        system prompt, per-phase prompts, JSON schemas
    map.ts            per-file analysis (parallel)
    reduce.ts         walkthrough + dedupe
    filter.ts         deterministic noise reduction  ← the moat
    select.ts         pre-flight file selection (cost control)
    chunker.ts        splits oversized patches at hunk boundaries
```

## Where to contribute

**Great first issues**

- Add a linter marker to `STYLE_LINTER_MARKERS` in `src/review/filter.ts`
- Add a generated-file pattern to `GENERATED_PATTERNS`
- Add a provider to `COMPAT_HOSTS` in `src/llm/registry.ts`
- Improve a prompt in `src/review/prompts.ts`

**High impact**

- Better dedupe (see the title-normalization in `filter.ts`)
- Language-aware hunk grouping
- Detecting and skipping vendored code
- Per-category confidence thresholds
- Reviewing prompt output against real PRs (see below)

## Adding a slash command

1. Write a handler in `src/commands/` that returns a `CommandResult`
   (`{ comment }` for a plain comment, `{ review }` for inline comments).
2. Register it in `COMMANDS` in `src/commands/index.ts`.
3. If it has arguments, add it to `KNOWN_COMMANDS` in `src/state.ts` — note
   that `parseSlashCommand` and `src/commands/index.ts` both keep a list, and
   they must stay in sync.
4. Add it to `commandHelp()` and `docs/configuration.md`.

Handlers must not post anything themselves: the dispatcher in `src/index.ts`
owns posting so that `dry-run` keeps working for free.

## Testing rules

1. **Everything that touches line numbers needs a test.** `src/github/diff.ts`
   is the most dangerous module in the codebase. A wrong line number posts a
   suggestion on the wrong code, which is worse than posting nothing.
2. **Prefer deterministic tests.** The pipeline test in
   `tests/pipeline.test.ts` uses a stub provider. Keep it that way — tests must
   never hit a real API.
3. **Add a fixture when you fix a parsing bug.** Real-world patches have edge
   cases (CRLF, no trailing newline, renames, submodule changes) that
   hand-written strings miss.

```bash
npm test                 # all tests
npm run test:watch       # watch mode
npx vitest run tests/diff.test.ts   # one file
```

## Reviewing real pull requests

The unit tests prove the mechanics. They cannot tell you whether the review is
*any good* — that needs a real model on real diffs. `scripts/dev-review.ts`
runs the whole pipeline and prints the payload it would have posted:

```bash
# Offline, deterministic, no key needed:
npm run dev:review -- fixtures/sample-pr.json --stub

# Against a real model on a saved fixture:
LLM_API_KEY=sk-... npm run dev:review -- fixtures/sample-pr.json

# Against a real pull request, saving it as a fixture for next time:
GITHUB_TOKEN=ghp_... LLM_API_KEY=sk-... \
  npm run dev:pr -- acme/widgets#42 --out fixtures/pr-42.json
```

`--pr` reads the diff through the API — the same read-as-data path the Action
uses, with no checkout — so it is safe to point at any public PR.

The last thing the harness prints is a check that every comment anchors to a
line that genuinely exists in the diff. Treat a non-zero exit there as a bug,
because it is: that is the failure that produces a 422 from GitHub, or worse, a
comment on unrelated code.

## The container and the bundled model

The Docker action is what users actually run, and two things about it cannot be
validated any other way. Both are cheap enough to run on every change:

- `scripts/verify-local-model.sh` starts the bundled `llama-server` inside the
  built image against a 1 MB test model and calls `/v1/chat/completions`. It runs
  in CI (`Docker image builds`). To run it against a local image:

  ```bash
  docker build -t prsentinel-action .
  docker run --rm -i --entrypoint /bin/sh prsentinel-action < scripts/verify-local-model.sh
  ```

- **Local model smoke test** (Actions → *Local model smoke test* → Run workflow)
  does a real dry-run review with a bundled model and reports wall-clock time,
  comment count, and walkthrough length. This is the only way to see what a
  bundled 7B costs on a free runner. Use it after changing `src/llm/local.ts` or
  the Dockerfile. It defaults to `max-files: 3`, because local inference is
  serialized and a full pull request would outlast the job; raise it — and the
  timeout — only when you mean to measure the whole thing. It **fails** if the
  pipeline logs that it dropped a file, so a green run means every selected file
  was actually reviewed.

A bundled model is served by a single `llama-server` slot (`--parallel 1`) on a
runner with no GPU, so one call can take minutes. Two rules follow, and they are
enforced in code rather than left to callers:

- **Stream.** `OpenAICompatProvider` asks a server on loopback to stream, so the
  response headers arrive immediately. A non-streaming response sends nothing at
  all until the whole completion exists, and `fetch` abandons a request that has
  produced no headers for 300 seconds — which is how the first local run lost 12
  of 14 files while still reporting success.
- **Do not fan out.** `LLM.concurrency` returns 1 for anything on loopback, and
  `mapPhase` sizes its worker pool from it. A request queued behind the single
  slot receives no bytes while it waits, so it trips the same timeout.

Three things in the Dockerfile are load-bearing and will bite anyone who tidies
them away:

- `llama-server` must stay in the same directory as its `.so` files. `ggml` finds
  its CPU backend by scanning the directory of its own executable, so scattering
  the libraries into `/usr/local/lib` makes the backend disappear — and it can be
  skipped without an error line, so the symptom is a puzzling `(none)` device
  list rather than a failure.
- The runtime base must be glibc. The prebuilt llama.cpp binaries do not run on
  musl.
- `libgomp1` is not in the `ubuntu` base image but llama.cpp links the GNU OpenMP
  runtime, so it must be installed explicitly.

CI publishes the image to GHCR (`.github/workflows/publish.yml`). The action
still builds from the `Dockerfile`; the published image is additive.

## Pull requests

- Keep commits focused; one logical change per commit.
- Run `npm run typecheck && npm test && npm run build` before pushing.
- Describe *why*, not just *what*. Include a before/after review snippet if the
  change affects output.
- New configuration options need a row in `docs/configuration.md` **and** a
  default in `configSchema`.

## Changing the system prompt

Prompt changes are the easiest thing to make worse. If you change
`SYSTEM_PROMPT` or a phase prompt:

- Explain the failure mode you observed.
- Show a real diff where the current prompt misbehaves.
- Note the effect on token usage.

## A note on `pull_request_target`

Any workflow change involving `pull_request_target` gets extra scrutiny. Read
[docs/SECURITY.md](docs/SECURITY.md) first. `scripts/check-pr-target-safety.mjs`
runs in CI and will fail the build if a privileged workflow checks out PR head
code — do not work around it.

## Code style

- TypeScript strict mode; no `any` in new code without a comment.
- Prefer small pure functions in `src/review/` — they are what make this
  testable.
- No new runtime dependencies without discussion. The current set is
  deliberately tiny (`@actions/core`, `@actions/github`, `yaml`, `zod`).

## License

By contributing you agree your contributions are licensed under Apache-2.0.
