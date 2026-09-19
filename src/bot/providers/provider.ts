/**
 * §24 — AI provider abstraction, so that "cloud model today, local model when
 * volume makes it cheaper" is a configuration change rather than a rewrite.
 */
import type { BotTurn } from '../../types.js';

export interface BotReply {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface BotCompletionOptions {
  system: string;
  turns: BotTurn[];
  maxTokens: number;
  timeoutMs: number;
}

export interface AiProvider {
  readonly name: string;
  readonly configured: boolean;
  /** USD cost of one exchange, used by the cost dashboard (§34). */
  costOf(inputTokens: number, outputTokens: number): number;
  complete(options: BotCompletionOptions): Promise<BotReply>;
}

export class AiProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new AiProviderError(`${res.status} ${body.slice(0, 300)}`, res.status);
    }
    return await res.json();
  } catch (err) {
    if (err instanceof AiProviderError) throw err;
    const message = (err as Error).name === 'AbortError' ? 'request timed out' : (err as Error).message;
    throw new AiProviderError(message);
  } finally {
    clearTimeout(timer);
  }
}
