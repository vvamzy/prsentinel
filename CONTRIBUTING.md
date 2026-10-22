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

A release is that PR, a tag on `main`, and a flip of every install example to
the new ref — all three, or the docs end up running different code from the
workflow they describe. The full checklist is
[docs/RELEASING.md](docs/RELEASING.md).

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
    reduce.ts         walkthrough + the ids of the findings to drop
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

# Against a bundled model, with no key at all (needs llama-server on PATH):
LLM_MODEL=local/qwen2.5-coder-7b-instruct \
  npm run dev:review -- fixtures/sample-pr.json

# Against a real pull request, saving it as a fixture for next time:
GITHUB_TOKEN=ghp_... LLM_API_KEY=sk-... \
  npm run dev:pr -- acme/widgets#42 --out fixtures/pr-42.json
```

`LLM_MODEL` wins over `.prsentinel.yaml` here, which is the opposite of the
Action: the harness is how you ask "how would model X review this?", and this
repository's own config pins a cloud model, which would make the question
unanswerable. The Action keeps the config in charge, because there the config
is the project's decision and the input is one pull request's.

`--pr` reads the diff through the API — the same read-as-data path the Action
uses, with no checkout — so it is safe to point at any public PR.

The last thing the harness prints is a check that every comment anchors to a
line that genuinely exists in the diff. Treat a non-zero exit there as a bug,
because it is: that is the failure that produces a 422 from GitHub, or worse, a
comment on unrelated code.

## Measuring quality

`dev-review` tells you what the bot *would* post. It cannot tell you whether
that is right. `scripts/eval.ts` can: it runs the same pipeline over labelled
diffs and compares what was posted with what a human says is actually there.

```bash
npm run eval:stub                        # offline; proves the harness runs
LLM_API_KEY=sk-... npm run eval          # the cloud model you ship
LLM_MODEL=local/qwen2.5-coder-7b-instruct npm run eval
```

Per case it reports:

- **precision** — of the comments posted, how many were true. A comment matching
  nothing in the case counts against it, so noise on a clean diff shows up as
  0%, not as a neutral blank.
- **recall** — of the labelled issues, how many were found.
- **anchoring** — whether each comment's line exists in the diff. This is never
  allowed to fail: an unanchored comment is a 422, not a style issue.

The text report also prints every false positive it saw, which is the useful
part when a model is bad: it shows exactly what was invented.

`--min-precision` and `--min-recall` turn the report into a gate; `--json` and
`--markdown-file` make it usable from CI, which is what the **Quality eval**
workflow does. That workflow is manual because a model run is slow and
stochastic, and the thresholds are a policy choice, so they start empty.

### Adding a case

1. Save the diff:
   `npm run dev:pr -- owner/repo#123 --out fixtures/pr-123.json` (API read,
   no checkout).
2. Read it and write down what is genuinely wrong. **The `match` terms describe
   the problem, not the fix** — a model that explains the bug differently must
   still score. Keep them short and hard to avoid: `off-by-one`, `unawaited`,
   `sql injection`.
3. Add `evals/<name>.json` with the fixture path, the expectations, and a
   `notes` field saying why those are the right ones. Give the line number too,
   so anchoring is scored.
4. Run `npm run eval -- --only <name>` and sanity-check that the labels agree
   with a model you trust.

A clean change is a case as well, with `"expect": []`. Those are the most
valuable ones: the observed failure mode is not missing bugs, it is inventing
them, and on a diff that is genuinely fine every comment is a false positive.

Use `allow` sparingly, and only for things the fixture cannot show — a missing
test when the fixture is a snippet, say. An `allow` rule that matches a real bug
is how a suite starts lying.

The suite is small and mostly self-authored. Treat its numbers as a floor on
confidence rather than a verdict, and add cases from your own repository: those
are the ones that predict what your team will actually see.

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
  the Dockerfile. It defaults to `max-files: 1`, because local inference is
  serialized and a full pull request would outlast the job; raise it — and the
  timeout — only when you mean to measure the whole thing. Dispatch it with
  `model: local/qwen2.5-coder-1.5b-instruct` for a fast pass that only proves
  the pipeline still runs. It **fails** if the pipeline logs that it dropped a
  file, so a green run means every selected file was actually reviewed.

A bundled model is served by a single `llama-server` slot (`--parallel 1`) on a
runner with no GPU, so one call can take minutes. Three rules follow, and they
are enforced in code rather than left to callers:

- **Stream.** `OpenAICompatProvider` asks a server on loopback to stream, so the
  response headers arrive immediately. A non-streaming response sends nothing at
  all until the whole completion exists, and `fetch` abandons a request that has
  produced no headers for 300 seconds — which is how the first local run lost 12
  of 14 files while still reporting success.
- **Do not fan out.** `LLM.concurrency` returns 1 for anything on loopback, and
  `mapPhase` sizes its worker pool from it. A request queued behind the single
  slot receives no bytes while it waits, so it trips the same timeout.
- **Budget the tokens.** A map call may spend 1024 tokens and a reduce call
  2048. On four vCPUs a token costs roughly a quarter of a second, so an
  unbounded budget is an unbounded wait — and a model that starts rambling
  spends all of it and returns half an object. The prompts bound the answer as
  well (at most five findings, a short summary, a walkthrough of a few
  paragraphs), so the model is not invited to keep writing.

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
