/** Cloud AI branch of §24 — Anthropic Messages API. */
import { config } from '../../config/index.js';
import {
  AiProviderError,
  fetchJson,
  type AiProvider,
  type BotCompletionOptions,
  type BotReply,
} from './provider.js';

interface MessagesResponse {
  content?: { type?: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';

  constructor(
    private readonly apiKey = config.bot.anthropic.apiKey,
    private readonly model = config.bot.anthropic.model,
    private readonly baseUrl = config.bot.anthropic.baseUrl,
  ) {}

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  costOf(inputTokens: number, outputTokens: number): number {
    const { inputCostPerMTok, outputCostPerMTok } = config.bot.anthropic;
    return (inputTokens / 1_000_000) * inputCostPerMTok + (outputTokens / 1_000_000) * outputCostPerMTok;
  }

  async complete(options: BotCompletionOptions): Promise<BotReply> {
    if (!this.apiKey) throw new AiProviderError('ANTHROPIC_API_KEY is not set');

    const body = await fetchJson(
      `${this.baseUrl}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': config.bot.anthropic.version,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: options.maxTokens,
          system: options.system,
          messages: options.turns.map((t) => ({ role: t.role, content: t.content })),
        }),
      },
      options.timeoutMs,
    );

    const parsed = body as MessagesResponse;
    const text = (parsed.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text!)
      .join('')
      .trim();

    if (!text) throw new AiProviderError('model returned no text');

    return {
      text,
      inputTokens: parsed.usage?.input_tokens ?? 0,
      outputTokens: parsed.usage?.output_tokens ?? 0,
    };
  }
}
