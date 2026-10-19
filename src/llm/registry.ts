import type { CompleteRequest, CompleteResult, LLMProvider } from './provider.js';
import { OpenAICompatProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';

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

  const provider = new OpenAICompatProvider(creds.apiKey, baseUrl, creds.extraHeaders);

  // For prefixed ids we strip the prefix before sending; for unprefixed
  // ids (e.g. `gpt-4o-mini`) the model string is already correct.
  return { provider, model: prefix === '' ? bareModel : bareModel };
}

/**
 * A thin facade the review pipeline talks to. It owns routing and retries
 * so callers never touch providers directly.
 */
export class LLM {
  constructor(private readonly creds: ProviderCredentials) {}

  async complete(model: string, req: Omit<CompleteRequest, 'model'>): Promise<CompleteResult> {
    const { provider, model: resolved } = resolveProvider(model, this.creds);
    return provider.complete({ ...req, model: resolved });
  }
}

/** Extract the provider prefix from a model id, for logging. */
export function modelProvider(model: string): string {
  const slash = model.indexOf('/');
  return slash === -1 ? 'openai' : model.slice(0, slash);
}
