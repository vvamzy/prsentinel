import { describe, it, expect } from 'vitest';
import { extractJson, mapWithConcurrency } from '../src/llm/provider.js';
import { resolveProvider, modelProvider } from '../src/llm/registry.js';

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
