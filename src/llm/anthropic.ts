import type { TokenUsage } from '../review/types.js';
import {
  extractJson,
  type CompleteRequest,
  type CompleteResult,
  type LLMProvider,
  type Message,
} from './provider.js';

/**
 * Anthropic Messages API provider.
 *
 * Structured output: Anthropic has no `response_format`, but it does have
 * tool use with `tool_choice: { type: 'tool' }` which forces a call. We use
 * that when a schema is present, then read the tool's input block.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = 'https://api.anthropic.com',
    private readonly apiVersion: string = '2023-06-01',
  ) {}

  supports(model: string): boolean {
    return model.startsWith('anthropic/') || model.startsWith('claude');
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    // Anthropic splits system out of the message list.
    const system = req.messages
      .filter((m): m is Extract<Message, { role: 'system' }> => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const model = req.model.startsWith('anthropic/') ? req.model.slice('anthropic/'.length) : req.model;

    const body: Record<string, unknown> = {
      model,
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature ?? 0.1,
      messages,
      ...(system ? { system } : {}),
      ...(req.schema
        ? {
            tools: [
              {
                name: 'emit_response',
                description: 'Emit the structured review response.',
                input_schema: req.schema,
              },
            ],
            tool_choice: { type: 'tool', name: 'emit_response' },
          }
        : {}),
    };

    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': this.apiVersion,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await safeText(res);
      throw new Error(`${this.name}: ${res.status} ${res.statusText} — ${detail}`);
    }

    const json = (await res.json()) as {
      content?: Array<{ type: string; text?: string; input?: unknown }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const usage: TokenUsage = {
      input: json.usage?.input_tokens ?? 0,
      output: json.usage?.output_tokens ?? 0,
    };

    // Tool-use path: the structured payload is in the tool's input block.
    const toolBlock = json.content?.find((b) => b.type === 'tool_use');
    if (toolBlock && req.schema) {
      return { text: JSON.stringify(toolBlock.input), parsed: toolBlock.input, usage };
    }

    const textBlock = json.content?.find((b) => b.type === 'text');
    const text = textBlock?.text ?? '';
    const result: CompleteResult = { text, usage };
    if (req.schema) {
      const parsed = extractJson(text);
      if (parsed !== null) result.parsed = parsed;
    }
    return result;
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
