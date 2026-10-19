import type { TokenUsage } from '../review/types.js';

/**
 * Provider abstraction.
 *
 * One shape for every backend. Implementations translate this into the
 * provider's native structured-output mechanism where one exists, and fall
 * back to prompting for JSON + parsing where one does not.
 */

export interface SystemMessage {
  role: 'system';
  content: string;
}

export interface UserMessage {
  role: 'user';
  content: string;
}

export type Message = SystemMessage | UserMessage;

export interface CompleteRequest {
  messages: Message[];
  /**
   * JSON Schema. When provided, implementations should use the provider's
   * native structured-output/tool mechanism so the model is constrained.
   */
  schema?: Record<string, unknown>;
  /** Model id, e.g. "openai/gpt-4o-mini" or "anthropic/claude-sonnet". */
  model: string;
  maxTokens?: number;
  temperature?: number;
}

export interface CompleteResult {
  text: string;
  /** Parsed `schema` when one was requested and parsing succeeded. */
  parsed?: unknown;
  usage: TokenUsage;
}

export interface LLMProvider {
  /** Human-readable name for logs. */
  readonly name: string;
  /** True if `model` refers to this provider (used by the registry). */
  supports(model: string): boolean;
  complete(req: CompleteRequest): Promise<CompleteResult>;
}

/**
 * Best-effort extraction of a JSON object from model output.
 *
 * Handles the common failure modes: fenced ```json blocks, leading prose,
 * and trailing commentary. Returns null when no object can be recovered.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  // Fast path: whole response is JSON.
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }

  // Fenced block.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }

  // First balanced {...} span.
  const start = trimmed.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = trimmed.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

/** Simple concurrency pool. Resolves in input order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}
