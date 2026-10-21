import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import type { TokenUsage } from '../review/types.js';
import {
  extractJson,
  repairTruncatedJson,
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
 *
 * Responses can also be streamed, which matters for a model server running
 * next to us. A non-streaming response sends no bytes at all until the entire
 * completion has been generated, and Node's `fetch` abandons a request whose
 * response headers have not arrived within 300 seconds. A single 7B map call on
 * a free-runner CPU takes longer than that, so non-streaming local runs lost
 * files to an opaque `TypeError: fetch failed` — the whole point of streaming
 * here is that the headers arrive immediately and the body then keeps the
 * connection alive token by token.
 */

export interface OpenAICompatOptions {
  /**
   * Ask the server to stream the completion. Set for servers on loopback, where
   * latency is unbounded and the payload is free.
   */
  stream?: boolean;
}

export class OpenAICompatProvider implements LLMProvider {
  readonly name = 'openai-compat';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = 'https://api.openai.com/v1',
    private readonly extraHeaders: Record<string, string> = {},
    private readonly options: OpenAICompatOptions = {},
  ) {}

  supports(model: string): boolean {
    // The registry routes by explicit prefix first; this is the fallback.
    return !model.includes('/');
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`;
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const stream = this.options.stream === true;
    const body: Record<string, unknown> = {
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
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };

    const url = this.url('/chat/completions');
    let res = await this.post(url, body);

    // Some providers reject these optional fields outright. Retry once without
    // them, but keep `stream`: it is the part a slow server cannot do without.
    if (!res.ok && (req.schema || stream) && (res.status === 400 || res.status === 422)) {
      const { response_format: _schema, stream_options: _options, ...retryBody } = body;
      res = await this.post(url, retryBody);
    }

    if (!res.ok) {
      const detail = await safeText(res);
      throw new Error(`${this.name}: ${res.status} ${res.statusText} — ${detail}`);
    }

    // Trust the response, not the request: a server is free to answer a
    // streaming request with a single JSON body, and one that answers with
    // `text/event-stream` is streaming whether or not we asked.
    const streamed = (res.headers.get('content-type') ?? '').includes('text/event-stream');
    const { text, usage } = streamed ? await readEventStream(res) : await readJsonBody(res);

    const result: CompleteResult = { text, usage };
    if (req.schema) {
      const parsed = extractJson(text);
      if (parsed !== null) {
        result.parsed = parsed;
      } else {
        // The model ran out of tokens mid-object. Recover what it did finish
        // rather than dropping the file the call already cost minutes for.
        const repaired = repairTruncatedJson(text);
        if (repaired !== null) {
          result.parsed = repaired;
          result.repaired = true;
        }
      }
    }
    return result;
  }

  private async post(url: string, body: unknown): Promise<Response> {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          ...this.extraHeaders,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // `fetch` rejects with a bare "TypeError: fetch failed" and hides the
      // reason — a timeout, a reset, a refused connection — in `cause`. Without
      // it a failure is undiagnosable, which is exactly how a run that dropped
      // 12 of 14 files still looked healthy.
      throw new Error(`${this.name}: POST ${url} failed — ${describeCause(err)}`);
    }
  }
}

async function readJsonBody(res: Response): Promise<{ text: string; usage: TokenUsage }> {
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: json.choices?.[0]?.message?.content ?? '',
    usage: {
      input: json.usage?.prompt_tokens ?? 0,
      output: json.usage?.completion_tokens ?? 0,
    },
  };
}

/**
 * Accumulate an OpenAI-style `text/event-stream` response.
 *
 * Each `data:` frame carries a delta, and the stream ends with `data: [DONE]`.
 * Frames that do not parse are skipped rather than fatal: keep-alive comments,
 * blank separators, and a frame split across two reads are all normal.
 */
async function readEventStream(res: Response): Promise<{ text: string; usage: TokenUsage }> {
  const usage: TokenUsage = { input: 0, output: 0 };
  let text = '';
  if (!res.body) return { text, usage };

  const consume = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice('data:'.length).trim();
    if (payload === '' || payload === '[DONE]') return;

    let frame: {
      choices?: Array<{ delta?: { content?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      frame = JSON.parse(payload) as typeof frame;
    } catch {
      return;
    }

    text += frame.choices?.[0]?.delta?.content ?? '';
    if (frame.usage) {
      usage.input = frame.usage.prompt_tokens ?? usage.input;
      usage.output = frame.usage.completion_tokens ?? usage.output;
    }
  };

  const decoder = new TextDecoder();
  let buffer = '';
  const stream = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk as Buffer, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      consume(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  consume(buffer);

  return { text, usage };
}

/** Render an error and whatever `fetch` tucked into `cause`. */
function describeCause(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  const detail =
    cause instanceof Error
      ? `${cause.name}: ${cause.message}`
      : cause === undefined
        ? ''
        : String(cause);
  return detail === '' ? err.message : `${err.message} (${detail})`;
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.length > 800 ? `${t.slice(0, 800)}…` : t;
  } catch {
    return '(no body)';
  }
}
