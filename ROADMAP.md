# Roadmap

Things that are understood, decided, and deliberately not built yet. Each entry
records *why* it was deferred, so a future reader does not have to re-derive it.

## Self-hosted inference servers

`llm-model: local/…` runs a GGUF on the Actions runner. It is genuinely private
— no code leaves the job — but it is the slowest and weakest option, because the
free runner has 4 vCPU and no GPU.

The stronger no-third-party option is a **self-hosted inference server**: one
Ollama or vLLM process kept warm on your own hardware, with prsentinel pointing
at it.

```yaml
llm-model: ollama/qwen2.5-coder:14b
llm-base-url: http://your-gpu-host:11434/v1
```

That works today, and it is documented now: see
[docs/self-hosted-models.md](docs/self-hosted-models.md) for a warm server, TLS,
an internal-only endpoint, sizing concurrency, and the tradeoff against a cloud
key. The README also says plainly that prsentinel is the *bot* and the model is
something you point it at — an earlier version implied prsentinel was the server,
which caused a real misunderstanding.

**To do**

- [ ] Consider a `cache` action input so the bundled-model path can restore
      weights automatically instead of relying on a hand-written
      `actions/cache` step.
- [ ] An `llm-concurrency` input. A remote server often has fewer slots than the
      default of six in flight, and today the only fix is to edit code.

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
