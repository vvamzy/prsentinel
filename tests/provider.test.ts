import { describe, it, expect, afterEach, vi } from 'vitest';
import { extractJson, mapWithConcurrency } from '../src/llm/provider.js';
import {
  DEFAULT_CONCURRENCY,
  LLM,
  isLoopbackUrl,
  modelProvider,
  resolveProvider,
} from '../src/llm/registry.js';
import { OpenAICompatProvider } from '../src/llm/openai.js';

describe('extractJson', () => {
  it('parses a bare object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses a fenced block', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses an unfenced block', () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('skips leading prose', () => {
    expect(extractJson('Here is the result:\n{"a":1}')).toEqual({ a: 1 });
  });

  it('skips trailing commentary', () => {
    expect(extractJson('{"a":1}\nHope that helps!')).toEqual({ a: 1 });
  });

  it('handles nested objects and strings containing braces', () => {
    const text = 'noise {"a":{"b":"}"},"c":2} more noise';
    expect(extractJson(text)).toEqual({ a: { b: '}' }, c: 2 });
  });

  it('returns null for unparseable text', () => {
    expect(extractJson('no json here')).toBeNull();
    expect(extractJson('{"a":')).toBeNull();
  });
});

describe('mapWithConcurrency', () => {
  it('resolves in input order', async () => {
    const out = await mapWithConcurrency([3, 1, 2], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n * 10));
      return n * 10;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it('respects the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('handles an empty input', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});

describe('resolveProvider', () => {
  const creds = { apiKey: 'k' };

  it('routes anthropic/ to the Anthropic provider', () => {
    const { provider, model } = resolveProvider('anthropic/claude-sonnet', creds);
    expect(provider.name).toBe('anthropic');
    expect(model).toBe('claude-sonnet');
  });

  it('routes bare claude ids to Anthropic', () => {
    const { provider } = resolveProvider('claude-3-5-sonnet', creds);
    expect(provider.name).toBe('anthropic');
  });

  it('routes openai/ to the OpenAI-compatible provider', () => {
    const { provider, model } = resolveProvider('openai/gpt-4o-mini', creds);
    expect(provider.name).toBe('openai-compat');
    expect(model).toBe('gpt-4o-mini');
  });

  it('routes groq/ and strips the prefix', () => {
    const { model } = resolveProvider('groq/llama-3.1-8b', creds);
    expect(model).toBe('llama-3.1-8b');
  });

  it('keeps an explicit base URL', () => {
    const { provider } = resolveProvider('ollama/qwen2.5', {
      apiKey: 'k',
      baseUrl: 'http://gpu:11434/v1',
    });
    expect(provider.name).toBe('openai-compat');
  });

  it('passes bare model ids through unchanged', () => {
    const { model } = resolveProvider('gpt-4o-mini', creds);
    expect(model).toBe('gpt-4o-mini');
  });
});

describe('modelProvider', () => {
  it('extracts the prefix', () => {
    expect(modelProvider('anthropic/claude')).toBe('anthropic');
    expect(modelProvider('gpt-4o')).toBe('openai');
  });
});

/** Build an OpenAI-style SSE body from a list of frames. */
function eventStream(frames: string[]): string {
  return frames.join('');
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

describe('OpenAICompatProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Record every request body, and answer with `respond`. */
  function stub(respond: (attempt: number) => Response): Record<string, any>[] {
    const bodies: Record<string, any>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      return respond(bodies.length);
    });
    return bodies;
  }

  it('reads a single JSON body', async () => {
    stub(
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'hello' } }],
            usage: { prompt_tokens: 3, completion_tokens: 4 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const provider = new OpenAICompatProvider('k', 'https://api.openai.com/v1');
    const res = await provider.complete({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.text).toBe('hello');
    expect(res.usage).toEqual({ input: 3, output: 4 });
  });

  it('does not ask for a stream unless told to', async () => {
    const bodies = stub(() => new Response('{}', { status: 200 }));
    const provider = new OpenAICompatProvider('k', 'http://127.0.0.1:8080/v1');
    await provider.complete({ model: 'm', messages: [] });
    expect(bodies[0]?.stream).toBeUndefined();
  });

  it('asks for a stream, and accumulates the deltas', async () => {
    const bodies = stub(
      () =>
        new Response(
          eventStream([
            sseFrame({ choices: [{ delta: { content: '{"a":' } }] }),
            ': keep-alive\n\n',
            sseFrame({ choices: [{ delta: { content: '1}' } }] }),
            sseFrame({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } }),
            'data: [DONE]\n\n',
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const provider = new OpenAICompatProvider('k', 'http://127.0.0.1:8080/v1', {}, { stream: true });
    const res = await provider.complete({
      model: 'qwen2.5-coder-7b-instruct',
      messages: [{ role: 'user', content: 'hi' }],
      schema: { type: 'object' },
    });

    expect(bodies[0]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(res.text).toBe('{"a":1}');
    expect(res.parsed).toEqual({ a: 1 });
    expect(res.usage).toEqual({ input: 7, output: 2 });
  });

  it('handles a frame split across two reads', async () => {
    const frame = sseFrame({ choices: [{ delta: { content: 'split' } }] });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frame.slice(0, 12)));
        controller.enqueue(encoder.encode(frame.slice(12)));
        controller.close();
      },
    });
    stub(() => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));

    const provider = new OpenAICompatProvider('k', 'http://127.0.0.1:8080/v1', {}, { stream: true });
    const res = await provider.complete({ model: 'm', messages: [] });
    expect(res.text).toBe('split');
  });

  it('trusts the response content type over the request', async () => {
    // A server that answers a streaming request with one JSON body.
    stub(
      () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'json anyway' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const provider = new OpenAICompatProvider('k', 'http://127.0.0.1:8080/v1', {}, { stream: true });
    const res = await provider.complete({ model: 'm', messages: [] });
    expect(res.text).toBe('json anyway');
  });

  it('retries once without the optional fields, keeping stream', async () => {
    const bodies = stub((attempt) =>
      attempt === 1
        ? new Response('unsupported', { status: 400 })
        : new Response(
            eventStream([sseFrame({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n']),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
    );
    const provider = new OpenAICompatProvider('k', 'http://127.0.0.1:8080/v1', {}, { stream: true });
    const res = await provider.complete({
      model: 'm',
      messages: [],
      schema: { type: 'object' },
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toHaveProperty('response_format');
    expect(bodies[1]).not.toHaveProperty('response_format');
    expect(bodies[1]).not.toHaveProperty('stream_options');
    expect(bodies[1]?.stream).toBe(true);
    expect(res.text).toBe('ok');
  });

  it('surfaces the status and body of a failed request', async () => {
    stub(() => new Response('{"error":"nope"}', { status: 503, statusText: 'Service Unavailable' }));
    const provider = new OpenAICompatProvider('k', 'http://127.0.0.1:8080/v1');
    await expect(provider.complete({ model: 'm', messages: [] })).rejects.toThrow(/503.*nope/s);
  });

  it('reports what fetch buried in cause', async () => {
    // This is the failure that silently cost 12 of 14 files in the first local
    // smoke run: a bare "TypeError: fetch failed" with the real reason hidden.
    vi.stubGlobal('fetch', async () => {
      const err = new Error('fetch failed');
      (err as { cause?: unknown }).cause = new Error('Headers Timeout Error');
      throw err;
    });
    const provider = new OpenAICompatProvider('k', 'http://127.0.0.1:8080/v1');
    await expect(provider.complete({ model: 'm', messages: [] })).rejects.toThrow(
      /Headers Timeout Error/,
    );
  });
});

describe('isLoopbackUrl', () => {
  it('recognises loopback hosts', () => {
    expect(isLoopbackUrl('http://localhost:11434/v1')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1:8080/v1')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:8080/v1')).toBe(true);
  });

  it('rejects remote hosts and unparseable input', () => {
    expect(isLoopbackUrl('http://gpu:11434/v1')).toBe(false);
    expect(isLoopbackUrl('https://api.openai.com/v1')).toBe(false);
    expect(isLoopbackUrl('http://127.0.0.2:8080/v1')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
  });
});

describe('LLM.concurrency', () => {
  it('is 1 for a bundled local model', () => {
    const llm = new LLM({ apiKey: 'local', baseUrl: 'http://127.0.0.1:8080/v1' });
    expect(llm.concurrency('local/qwen2.5-coder-7b-instruct')).toBe(1);
  });

  it('is 1 for a self-hosted server on loopback', () => {
    expect(
      new LLM({ apiKey: 'k', baseUrl: 'http://localhost:11434/v1' }).concurrency('ollama/qwen2.5'),
    ).toBe(1);
    // The built-in hosts for Ollama and vLLM are loopback too.
    expect(new LLM({ apiKey: 'k' }).concurrency('ollama/qwen2.5')).toBe(1);
    expect(new LLM({ apiKey: 'k' }).concurrency('vllm/qwen2.5')).toBe(1);
  });

  it('is the hosted default for a cloud model', () => {
    expect(new LLM({ apiKey: 'k' }).concurrency('openai/gpt-4o-mini')).toBe(DEFAULT_CONCURRENCY);
    expect(new LLM({ apiKey: 'k' }).concurrency('gpt-4o-mini')).toBe(DEFAULT_CONCURRENCY);
    expect(new LLM({ apiKey: 'k' }).concurrency('anthropic/claude-sonnet')).toBe(DEFAULT_CONCURRENCY);
  });

  it('is the hosted default for a model server somewhere else', () => {
    expect(
      new LLM({ apiKey: 'k', baseUrl: 'http://gpu-box:11434/v1' }).concurrency('ollama/qwen2.5'),
    ).toBe(DEFAULT_CONCURRENCY);
  });
});

describe('LLM against a loopback server', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks a local server to stream', async () => {
    const bodies: Record<string, any>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const llm = new LLM({ apiKey: 'local', baseUrl: 'http://127.0.0.1:8080/v1' });
    await llm.complete('local/qwen2.5-coder-7b-instruct', { messages: [] });

    expect(bodies[0]?.stream).toBe(true);
    // The `local/` prefix is stripped; the server knows the model by bare name.
    expect(bodies[0]?.model).toBe('qwen2.5-coder-7b-instruct');
  });

  it('does not stream to a hosted API', async () => {
    const bodies: Record<string, any>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const llm = new LLM({ apiKey: 'k' });
    await llm.complete('openai/gpt-4o-mini', { messages: [] });
    expect(bodies[0]?.stream).toBeUndefined();
  });
});
