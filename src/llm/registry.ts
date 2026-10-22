import type { CompleteRequest, CompleteResult, LLMProvider } from './provider.js';
import { OpenAICompatProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { isLocalModel } from './local.js';

/**
 * Resolves a model string like `anthropic/claude-sonnet` or `openai/gpt-4o`
 * to the right provider instance.
 *
 * Routing rules, in order:
 *   1. `anthropic/*` or `claude*`  → AnthropicProvider
 *   2. `github/*`                  → OpenAICompatProvider pointed at models.github.ai
 *   3. Anything with an explicit provider prefix (`openai/`, `groq/`, ...)
 *      → OpenAICompatProvider at that provider's baseUrl
 *   4. Bare model name             → OpenAICompatProvider at api.openai.com
 *
 * `local/*` never reaches here on its own: those models are served by a
 * llama-server that `ensureLocalServer` starts, and arrive as a bare model name
 * with an explicit `baseUrl` of `http://127.0.0.1:<port>/v1`.
 */

export interface ProviderCredentials {
  /** Primary key used for whichever provider is selected. */
  apiKey: string;
  /** Optional override of the API base URL. */
  baseUrl?: string;
  /** Optional extra headers (e.g. OpenRouter `HTTP-Referer`). */
  extraHeaders?: Record<string, string>;
}

/** Known OpenAI-compatible hosts, keyed by the prefix used in model ids. */
const COMPAT_HOSTS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.xyz/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  deepseek: 'https://api.deepseek.com/v1',
  xai: 'https://api.x.ai/v1',
  mistral: 'https://api.mistral.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  github: 'https://models.github.ai/inference',
  ollama: 'http://localhost:11434/v1',
  vllm: 'http://localhost:8000/v1',
};

export function resolveProvider(
  model: string,
  creds: ProviderCredentials,
): { provider: LLMProvider; model: string } {
  const slash = model.indexOf('/');
  const prefix = slash === -1 ? '' : model.slice(0, slash);
  const bareModel = slash === -1 ? model : model.slice(slash + 1);

  // Anthropic is the only non-OpenAI-compatible API we ship.
  if (prefix === 'anthropic' || model.startsWith('claude')) {
    return { provider: new AnthropicProvider(creds.apiKey, creds.baseUrl), model: bareModel };
  }

  // A `local/*` id without a base URL means someone wired the model straight
  // into the registry and skipped the llama-server bootstrap. Fail loudly
  // instead of silently sending the request to api.openai.com.
  if (prefix === 'local' && !creds.baseUrl) {
    throw new Error(
      `"${model}" is a local model and must be started first. ` +
        'Local models are bootstrapped by ensureLocalServer() in src/llm/local.ts, ' +
        'which provides the base URL this call is missing.',
    );
  }

  // Explicit base URL wins over any prefix lookup.
  const baseUrl =
    creds.baseUrl ?? COMPAT_HOSTS[prefix] ?? 'https://api.openai.com/v1';

  const provider = new OpenAICompatProvider(creds.apiKey, baseUrl, creds.extraHeaders, {
    stream: isLoopbackUrl(baseUrl),
  });

  // For prefixed ids we strip the prefix before sending; for unprefixed
  // ids (e.g. `gpt-4o-mini`) the model string is already correct.
  return { provider, model: prefix === '' ? bareModel : bareModel };
}

/** Concurrent requests a hosted API is willing to take. */
export const DEFAULT_CONCURRENCY = 6;

/**
 * What the review pipeline needs from an LLM.
 *
 * The pipeline talks to this, not to a concrete provider, so a test or an
 * offline harness can stand in for a real model. It is an interface rather
 * than the `LLM` class on purpose: a stub that implements the shape is checked
 * by the compiler, where a hand-rolled object with the right methods today
 * silently loses whatever the facade gains tomorrow.
 */
export interface LLMFacade {
  complete(model: string, req: Omit<CompleteRequest, 'model'>): Promise<CompleteResult>;
  /** How many requests this model's server can usefully take at once. */
  concurrency(model: string): number;
}

/**
 * A thin facade the review pipeline talks to. It owns routing and retries
 * so callers never touch providers directly.
 */
export class LLM implements LLMFacade {
  constructor(private readonly creds: ProviderCredentials) {}

  async complete(model: string, req: Omit<CompleteRequest, 'model'>): Promise<CompleteResult> {
    const { provider, model: resolved } = resolveProvider(model, this.creds);
    return provider.complete({ ...req, model: resolved });
  }

  /**
   * How many requests this model's server can usefully take at once.
   *
   * Fanning out to a server on loopback is not merely useless, it is harmful:
   * the server holds a request in its queue without sending a byte, and the
   * client abandons a request that has produced no response headers for 300
   * seconds. That is how a 14-file review came back with 12 files missing.
   * Hosted APIs are built to fan out, so they keep the default.
   */
  concurrency(model: string): number {
    const slash = model.indexOf('/');
    const prefix = slash === -1 ? '' : model.slice(0, slash);
    if (prefix === 'local') return 1;
    const baseUrl = this.creds.baseUrl ?? COMPAT_HOSTS[prefix];
    return baseUrl !== undefined && isLoopbackUrl(baseUrl) ? 1 : DEFAULT_CONCURRENCY;
  }
}

/**
 * True when the base URL points at this machine.
 *
 * A server on loopback is one running beside the action — the bundled
 * `local/…` models, and the self-hosted Ollama/vLLM setups the README suggests.
 * Two things follow, and both are why this is checked rather than configured:
 *
 *   - Latency is unbounded (a CPU-only runner, or the user's own hardware), so
 *     responses are streamed to keep the connection alive.
 *   - Extra client concurrency buys nothing, because such a server serves one
 *     request at a time. `LLM.concurrency` reads the same signal.
 */
export function isLoopbackUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

/** Extract the provider prefix from a model id, for logging. */
export function modelProvider(model: string): string {
  const slash = model.indexOf('/');
  return slash === -1 ? 'openai' : model.slice(0, slash);
}

/**
 * Does this configuration need an API key at all?
 *
 * Two kinds of setup do not. A bundled `local/…` model is served by prsentinel
 * itself, and a base URL you own — Ollama and vLLM are routinely run with no
 * auth at all — is reachable without one. Requiring a dummy key for those only
 * taught people to paste `ollama` into a secret, which hides the real question
 * of whether the endpoint is protected.
 *
 * Everything else does, including GitHub Models, where the key is the workflow
 * token rather than a provider secret.
 */
export function needsApiKey(model: string, baseUrl?: string): boolean {
  if (isLocalModel(model)) return false;
  return (baseUrl ?? '').trim() === '';
}
