/**
 * Local AI branch of §24.
 *
 * Any server exposing the OpenAI chat-completions shape works here — Ollama,
 * vLLM, llama.cpp, LM Studio — which is the escape hatch the document asks for
 * when bot volume makes per-token cloud pricing the wrong trade.
 */
import { config } from '../../config/index.js';
import {
  AiProviderError,
  fetchJson,
  type AiProvider,
  type BotCompletionOptions,
  type BotReply,
} from './provider.js';

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAiCompatibleProvider implements AiProvider {
  readonly name = 'openai-compatible';

  constructor(
    private readonly baseUrl = config.bot.openaiCompatible.baseUrl,
    private readonly apiKey = config.bot.openaiCompatible.apiKey,
    private readonly model = config.bot.openaiCompatible.model,
  ) {}

  get configured(): boolean {
    return Boolean(this.baseUrl);
  }

  /** Self-hosted inference has no per-token price attached to it. */
  costOf(): number {
    return 0;
  }

  async complete(options: BotCompletionOptions): Promise<BotReply> {
    if (!this.baseUrl) throw new AiProviderError('LOCAL_AI_BASE_URL is not set');

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const body = await fetchJson(
      `${this.baseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          max_tokens: options.maxTokens,
          messages: [
            { role: 'system', content: options.system },
            ...options.turns.map((t) => ({ role: t.role, content: t.content })),
          ],
        }),
      },
      options.timeoutMs,
    );

    const parsed = body as ChatCompletionResponse;
    const text = parsed.choices?.[0]?.message?.content?.trim();
    if (!text) throw new AiProviderError('model returned no text');

    return {
      text,
      inputTokens: parsed.usage?.prompt_tokens ?? 0,
      outputTokens: parsed.usage?.completion_tokens ?? 0,
    };
  }
}
