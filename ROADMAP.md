# Roadmap

Things that are understood, decided, and deliberately not built yet. Each entry
records *why* it was deferred, so a future reader does not have to re-derive it.

## Hosted models that need no key at all

`llm-model: local/…` runs a GGUF on the Actions runner. It is genuinely private
— no code leaves the job — but it is the slowest and weakest option, because the
free runner has 4 vCPU and no GPU.

The obvious improvement is a **self-hosted inference server**: you keep one
Ollama or vLLM process warm on your own hardware, and prsentinel points at it.

```yaml
llm-model: ollama/qwen2.5-coder
llm-base-url: http://your-gpu-host:11434/v1
```

This already works today — the provider is OpenAI-compatible and `llm-base-url`
routes to it. What is missing is the *documentation*: it is currently buried in
the provider list, and the README once implied prsentinel itself was the model
server, which is not true and caused a real misunderstanding.

**To do**

- [ ] A "Run the model on your own hardware" guide covering a warm server,
      TLS, an internal-only endpoint, and the tradeoff against a cloud key.
- [ ] Say plainly in the README that prsentinel is the *bot*, and the model is
      something you point it at.
- [ ] Consider a `cache` action input so the bundled-model path can restore
      weights automatically instead of relying on a hand-written
      `actions/cache` step.

## Bigger runners, if this ever moves to an organisation

The bundled model is sized for the free tier on purpose: 4 vCPU / 16 GB, no GPU.
Larger and GPU runners would change the calculus completely — a 14B model at
interactive speed, or a 32B model at all.

They are not available to a personal account, and they are never free:

| Runner | CPU | RAM | Cost |
|---|---|---|---|
| `ubuntu-latest` (free tier) | 4 | 16 GB | free for public repos |
| Larger runner | 16–96 | up to ~380 GB | billed per minute, org + paid plan only |
| `linux_4_core_gpu` | 4 + GPU | 16 GB | $0.052/min, org + paid plan only |

**To do**

- [ ] If prsentinel ever moves under an org, re-evaluate the bundled model size
      against a 16 vCPU runner.
- [ ] Make the model's `ctx` and thread count inputs rather than environment
      variables, so a larger runner needs no code change.
