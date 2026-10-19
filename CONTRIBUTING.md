# Contributing to prsentinel

Thanks for helping. This project exists to be a genuinely useful,
self-hostable review bot, and the highest-leverage contributions are usually
about **filtering quality** — not prompt wording.

## Getting started

```bash
git clone https://github.com/your-org/prsentinel
cd prsentinel
npm ci
npm run typecheck
npm test
npm run build
```

Node 20+ is required. The test suite runs without network access and without an
API key.

## Project layout

```
src/
  index.ts            entry point; routes on the GitHub event
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
  github/
    client.ts         octokit wrapper — all GitHub API shapes live here
    diff.ts           unified-diff parsing  ← hardest code, most tests
    context.ts        decides what extra file content to fetch
    review.ts         builds the createReview payload
  llm/
    provider.ts       provider interface, JSON extraction, concurrency pool
    openai.ts         OpenAI-compatible (covers OpenAI/Groq/Ollama/vLLM/…)
    anthropic.ts      Anthropic Messages API
    registry.ts       model id → provider routing
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
- Implementing `/resolve` (needs the GraphQL thread node id)

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
