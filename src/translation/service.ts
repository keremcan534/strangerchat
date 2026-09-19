/**
 * Translation Service (§11).
 *
 * Owns everything between "the chat server has a message" and "a translated
 * string comes back": provider selection, the cache (§12), the daily budget
 * (§13) and the retry-once-then-degrade path (§15).
 *
 * The contract the chat server depends on: **this never throws and never
 * blocks a conversation.** A failed translation returns the original text with
 * a reason attached; the chat continues either way.
 */
import { config } from '../config/index.js';
import { log } from '../logger.js';
import type { BudgetTracker } from '../cost/budget.js';
import type { KeyValueStore } from '../store/kv.js';
import type { TranslationOutcome } from '../types.js';
import { normaliseLanguage } from '../config/languages.js';
import { TranslationCache } from './cache.js';
import { EchoTranslationProvider } from './providers/echo.js';
import { GoogleTranslationProvider } from './providers/google.js';
import { TranslationProviderError, type TranslationProvider } from './providers/provider.js';

export function selectProvider(): TranslationProvider | null {
  const choice = config.translation.provider;
  if (choice === 'none') return null;
  if (choice === 'echo') return new EchoTranslationProvider();
  if (choice === 'google') return new GoogleTranslationProvider();

  // auto: prefer a real provider, fall back to echo so local dev still works.
  const google = new GoogleTranslationProvider();
  if (google.configured) return google;
  log.warn('no Google Translation credentials found — using the echo provider');
  return new EchoTranslationProvider();
}

export class TranslationService {
  private readonly cache: TranslationCache;
  private degradedUntil = 0;

  constructor(
    kv: KeyValueStore,
    private readonly budget: BudgetTracker,
    private readonly provider: TranslationProvider | null = selectProvider(),
  ) {
    this.cache = new TranslationCache(kv);
  }

  get providerName(): string {
    return this.provider?.name ?? 'none';
  }

  /** A provider is configured at all — stable, unlike `available`. */
  get enabled(): boolean {
    return this.provider !== null;
  }

  /** Configured *and* not inside a post-failure back-off window. */
  get available(): boolean {
    return this.provider !== null && Date.now() >= this.degradedUntil;
  }

  /**
   * Translates `text` into `target`.
   *
   * `source` is the sender's declared language and is passed through to the
   * provider; when it is unknown we let the provider auto-detect (§8).
   */
  async translate(text: string, target: string, source?: string): Promise<TranslationOutcome> {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, result: null, reason: 'empty' };
    if (!this.provider) return { ok: false, result: null, reason: 'disabled' };
    if (source && source === target) return { ok: false, result: null, reason: 'same-language' };
    if (Date.now() < this.degradedUntil) return { ok: false, result: null, reason: 'provider-error' };

    const cacheSource = source ?? 'auto';
    const cached = await this.cache.get(cacheSource, target, trimmed);
    if (cached) {
      return {
        ok: true,
        result: {
          text: cached.text,
          detectedSourceLanguage: cached.detectedSourceLanguage,
          cached: true,
          provider: this.provider.name,
          charactersBilled: 0,
        },
      };
    }

    // §13 — a message is only sent to the API if it fits in today's budget.
    if (!(await this.budget.canTranslate(trimmed.length))) {
      log.warn('translation refused: daily character budget exhausted', { characters: trimmed.length });
      return { ok: false, result: null, reason: 'budget-exhausted' };
    }

    const attempts = Math.max(1, config.translation.retryAttempts + 1);
    let lastError: unknown = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const out = await this.provider.translate(trimmed, target, source);
        await this.budget.recordTranslation(trimmed.length);
        await this.cache.set(cacheSource, target, trimmed, {
          text: out.text,
          detectedSourceLanguage: out.detectedSourceLanguage,
        });
        return {
          ok: true,
          result: {
            text: out.text,
            detectedSourceLanguage: normaliseLanguage(out.detectedSourceLanguage) ?? out.detectedSourceLanguage,
            cached: false,
            provider: this.provider.name,
            charactersBilled: trimmed.length,
          },
        };
      } catch (err) {
        lastError = err;
        const retryable = err instanceof TranslationProviderError ? err.retryable : true;
        if (!retryable) break;
      }
    }

    // §15 — one retry, then degrade. Back off briefly so a provider outage does
    // not turn every message into a doomed API call.
    this.degradedUntil = Date.now() + 15_000;
    log.warn('translation failed, falling back to original text', {
      error: (lastError as Error | null)?.message,
      provider: this.provider.name,
    });
    return { ok: false, result: null, reason: 'provider-error' };
  }

  /** Best-effort language detection used to sanity-check the declared language. */
  async detect(text: string): Promise<string | null> {
    if (!this.provider) return null;
    const detected = await this.provider.detect(text.slice(0, 200));
    return normaliseLanguage(detected) ?? null;
  }

  cacheStats(): ReturnType<TranslationCache['stats']> {
    return this.cache.stats();
  }
}
