import type { TokenUsage } from '../review/types.js';
import {
  extractJson,
  type CompleteRequest,
  type CompleteResult,
  type LLMProvider,
} from './provider.js';

/**
 * OpenAI-compatible chat-completions provider.
 *
 * This single implementation covers a lot of ground because everyone
 * implements the OpenAI API: OpenAI, OpenRouter, Groq, Together, Fireworks,
 * DeepSeek, LM Studio, Ollama, and vLLM. Point `baseUrl` at the right host
 * and pass an API key.
 *
 * Structured output: when a schema is provided we attach it via
 * `response_format.json_schema` with strict mode. Providers that don't
 * support it will reject the field, so we retry once without it and rely on
 * `extractJson` as the fallback.
 */
export class OpenAICompatProvider implements LLMProvider {
  readonly name = 'openai-compat';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = 'https://api.openai.com/v1',
    private readonly extraHeaders: Record<string, string> = {},
  ) {}

  supports(model: string): boolean {
    // The registry routes by explicit prefix first; this is the fallback.
    return !model.includes('/');
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`;
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const body = {
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature ?? 0.1,
      ...(req.schema
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'response', strict: true, schema: req.schema },
            },
          }
        : {}),
    };

    let res = await this.post(this.url('/chat/completions'), body);

    // Some providers reject response_format entirely; retry once without it.
    if (!res.ok && req.schema && (res.status === 400 || res.status === 422)) {
      const { response_format: _drop, ...retryBody } = body;
      res = await this.post(this.url('/chat/completions'), retryBody);
    }

    if (!res.ok) {
      const detail = await safeText(res);
      throw new Error(`${this.name}: ${res.status} ${res.statusText} — ${detail}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const text = json.choices?.[0]?.message?.content ?? '';
    const usage: TokenUsage = {
      input: json.usage?.prompt_tokens ?? 0,
      output: json.usage?.completion_tokens ?? 0,
    };

    const result: CompleteResult = { text, usage };
    if (req.schema) {
      const parsed = extractJson(text);
      if (parsed !== null) result.parsed = parsed;
    }
    return result;
  }

  private async post(url: string, body: unknown): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
        ...this.extraHeaders,
      },
      body: JSON.stringify(body),
    });
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.length > 800 ? `${t.slice(0, 800)}…` : t;
  } catch {
    return '(no body)';
  }
}
