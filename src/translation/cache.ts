/**
 * §12 — short-lived translation cache.
 *
 * Deliberately conservative: these are private messages between two strangers,
 * so we only cache short strings (greetings, "how are you", "lol"), only for
 * minutes, and only keyed by a hash of the text rather than the text itself.
 * That covers the repetition that actually drives cost without turning the
 * cache into a durable store of what people said.
 */
import { createHash } from 'node:crypto';
import type { KeyValueStore } from '../store/kv.js';
import { config } from '../config/index.js';

export interface CachedTranslation {
  text: string;
  detectedSourceLanguage: string | null;
}

export class TranslationCache {
  private hits = 0;
  private misses = 0;
  private stores = 0;

  constructor(private readonly kv: KeyValueStore) {}

  /** Long or unusual strings are not worth a round-trip to the cache. */
  cacheable(text: string): boolean {
    return text.length > 0 && text.length <= config.translation.cacheMaxChars;
  }

  private key(source: string, target: string, text: string): string {
    const digest = createHash('sha256')
      .update(text.trim().toLowerCase())
      .digest('base64url')
      .slice(0, 24);
    return `translation:${source}:${target}:${digest}`;
  }

  async get(source: string, target: string, text: string): Promise<CachedTranslation | null> {
    if (!this.cacheable(text)) return null;
    const raw = await this.kv.get(this.key(source, target, text));
    if (raw === null) {
      this.misses += 1;
      return null;
    }
    try {
      this.hits += 1;
      return JSON.parse(raw) as CachedTranslation;
    } catch {
      return null;
    }
  }

  async set(source: string, target: string, text: string, value: CachedTranslation): Promise<void> {
    if (!this.cacheable(text)) return;
    this.stores += 1;
    await this.kv.set(
      this.key(source, target, text),
      JSON.stringify(value),
      config.translation.cacheTtlSeconds,
    );
  }

  stats(): { hits: number; misses: number; stores: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      stores: this.stores,
      hitRate: total === 0 ? 0 : this.hits / total,
    };
  }
}
