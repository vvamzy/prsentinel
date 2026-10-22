# Running the model on your own hardware

prsentinel is the **bot**, not the model. It reads a pull request, asks a model
what is wrong, and posts the answer. Where that model runs is your choice:

| Option | Where the model runs | Cost | Speed on a PR | Code leaves the runner |
|---|---|---|---|---|
| **Bundled** (`local/…`) | inside the action container, on the CI runner | free | minutes per file | no |
| **Self-hosted** (this page) | your machine or GPU box | your hardware | seconds per file | no |
| **Hosted API** (`openai/…`, `anthropic/…`) | the provider | per token | seconds | yes |

The bundled path exists so a public repository can have reviews with no key and
no third party. This page is the middle option: you already have a GPU, or a
spare machine, and you would rather keep one model warm than pay per token.

It also removes the two limits of the bundled path. A runner has 4 vCPU and no
GPU, so it can only hold a 7B at a few tokens per second; your hardware can hold
whatever you like, at whatever speed it runs.

## Ollama

On the server:

```bash
ollama pull qwen2.5-coder:14b

# Listen on the network, not just loopback. Put TLS in front of this before it
# is reachable from the internet — see below.
OLLAMA_HOST=0.0.0.0:11434 OLLAMA_NUM_PARALLEL=4 ollama serve
```

Check it speaks the OpenAI-compatible API prsentinel uses — note the `/v1`:

```bash
curl -s http://gpu-box:11434/v1/models | head
```

In the workflow:

```yaml
- uses: vvamzy/prsentinel@main
  with:
    llm-model: ollama/qwen2.5-coder:14b
    llm-base-url: http://gpu-box:11434/v1
```

`llm-model` is `provider/model`, and the prefix is stripped before the request:
Ollama receives `qwen2.5-coder:14b`. The prefix does **not** choose the host when
`llm-base-url` is set — that is why the URL is required here, since the
`ollama/` default is `http://localhost:11434/v1` and `localhost` inside the
action container is the container.

No key is needed for a base URL you configured. If the endpoint does check one,
set `llm-api-key` as usual and it is sent as `Authorization: Bearer …`. (Before
this, an unauthenticated server still demanded a dummy secret. It no longer
does.)

## vLLM

vLLM serves the same API shape on port 8000:

```bash
vllm serve Qwen/Qwen2.5-Coder-14B-Instruct \
  --port 8000 \
  --max-model-len 32768
```

```yaml
- uses: vvamzy/prsentinel@main
  with:
    llm-model: vllm/qwen2.5-coder-14b
    llm-base-url: http://gpu-box:8000/v1
```

Anything that implements `POST /v1/chat/completions` works the same way:
llama.cpp's own server, LM Studio, TGI, LocalAI, an internal gateway.

## TLS, and not exposing the model

A model server has no authentication worth the name: Ollama's API is open to
anyone who can reach the port, and a vLLM started with `--api-key` has exactly
one shared secret. Do not put either on the public internet directly.

- **Prefer a private network.** A self-hosted runner on the same network can
  reach `http://gpu-box:11434/v1` with nothing exposed. This is the simplest
  arrangement that is also safe.
- **Terminate TLS in front.** If the endpoint must be publicly reachable, put
  Caddy, nginx, or a cloud load balancer in front of it, with a real certificate
  and an auth check. Then `llm-base-url: https://review-models.example.com/v1`.
  A bearer token over plain HTTP is a token anyone on the path can replay.
- **Keep the URL and key in secrets.** `llm-base-url` is not secret, but the key
  is: pass it as `${{ secrets.LLM_API_KEY }}`, never inline.

GitHub-hosted runners are on the public internet, so they cannot reach a LAN
address. Your options are a TLS endpoint as above, or a self-hosted runner:

```yaml
jobs:
  review:
    runs-on: [self-hosted, linux]
```

That is safe with prsentinel specifically because it never checks out the pull
request's code: it reads the diff through the API as data, which is what the
`pull_request_target` guard in this repository enforces.

## What is different from a hosted API

A hosted provider is built to be fanned out to, from anywhere, for as long as it
takes. A box in your office is not:

- **A slow response is a timeout.** prsentinel streams responses from a loopback
  endpoint so the connection stays alive; a *remote* one gets the ordinary
  request path, and Node abandons a request that has not produced a response
  within 300 seconds. A GPU answers long before that; a CPU box with a large
  model may not. If it bites, put the runner on the same machine and use
  `http://127.0.0.1:11434/v1`, which is also the path that streams.
- **Concurrency is yours to size.** prsentinel sends up to 6 file reviews at
  once to a remote endpoint. Ollama serves one request at a time by default and
  queues the rest, which looks like a stall rather than an error. Set
  `OLLAMA_NUM_PARALLEL` to what your GPU can actually hold — often two or four —
  and keep pull requests small with `reviews.max_files`. A request that queues
  for longer than the timeout above is abandoned, and that file goes unreviewed.
- **Every model is not a reviewer.** The pipeline needs a model that follows a
  JSON schema and writes code, not just one that chats. Code-tuned models in the
  7B–32B range are the sweet spot; a 70B general model is usually worse at this
  than a 14B coder model.
- **The context window must hold a diff.** prsentinel caps a file at
  `reviews.max_file_bytes` (200 KB) and extracts hunks around each change, but a
  model served with a 4K context will still truncate. 32K is a comfortable
  starting point.

## Checking the result

The same harnesses work against any endpoint, and they cost nothing when the
endpoint is yours:

```bash
# What would it post on this pull request?
LLM_MODEL=ollama/qwen2.5-coder:14b LLM_BASE_URL=http://gpu-box:11434/v1 \
  npm run dev:review -- fixtures/sample-pr.json

# Is what it posts correct? Precision and recall per labelled diff.
LLM_MODEL=ollama/qwen2.5-coder:14b LLM_BASE_URL=http://gpu-box:11434/v1 \
  npm run eval
```

See [CONTRIBUTING.md](../CONTRIBUTING.md#measuring-quality) for adding cases
from your own repository — those are the ones that predict what your team will
actually see. The bundled models score badly on the six cases that ship with
the repo ([numbers in the README](../README.md#development)); a 14B on a real
GPU should beat them, but "should" is why the harness exists.
