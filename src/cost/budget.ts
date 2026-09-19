/**
 * Translation and AI spend tracking (§13, §34, §35).
 *
 * The two budgets are deliberately independent: the document is explicit that
 * translation cost and AI cost are different variables and must be watched
 * separately. Counters live in the KV store (Redis in production) keyed per UTC
 * day, and are mirrored into Postgres for the dashboard history.
 */
import type { KeyValueStore } from '../store/kv.js';
import type { Database } from '../store/db.js';
import { config } from '../config/index.js';
import { log } from '../logger.js';

export type BudgetState = 'ok' | 'warning' | 'exhausted';

export interface TranslationBudgetStatus {
  charactersUsed: number;
  characterLimit: number;
  ratio: number;
  state: BudgetState;
  estimatedCostUsd: number;
}

export interface BotBudgetStatus {
  messages: number;
  messageLimit: number;
  costUsd: number;
  costLimitUsd: number;
  state: BudgetState;
}

export function utcDay(at: number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

function secondsUntilEndOfUtcDay(at: number = Date.now()): number {
  const now = new Date(at);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  // A little slack so a counter never expires before the day it belongs to.
  return Math.max(60, Math.ceil((end - at) / 1000) + 3600);
}

export class BudgetTracker {
  /** Remembers whether we already logged the 80% warning today. */
  private warnedTranslationDay: string | null = null;

  constructor(private readonly kv: KeyValueStore, private readonly db: Database) {}

  private key(kind: string, day: string): string {
    return `usage:${day}:${kind}`;
  }

  private async read(kind: string, day: string): Promise<number> {
    const raw = await this.kv.get(this.key(kind, day));
    const n = raw === null ? 0 : Number.parseFloat(raw);
    return Number.isFinite(n) ? n : 0;
  }

  // ---------------------------------------------------------------- translation

  async translationStatus(day = utcDay()): Promise<TranslationBudgetStatus> {
    const used = await this.read('translation_chars', day);
    const limit = config.translation.dailyCharacterLimit;
    const ratio = limit > 0 ? used / limit : 0;
    let state: BudgetState = 'ok';
    if (limit > 0 && used >= limit) state = 'exhausted';
    else if (ratio >= config.translation.warnRatio) state = 'warning';
    return {
      charactersUsed: used,
      characterLimit: limit,
      ratio,
      state,
      estimatedCostUsd: (used / 1_000_000) * config.translation.costPerMillionChars,
    };
  }

  /**
   * §13: a request is admitted only if the whole string fits in what is left,
   * so we never half-translate a message and never overshoot the daily cap.
   */
  async canTranslate(characters: number): Promise<boolean> {
    const limit = config.translation.dailyCharacterLimit;
    if (limit <= 0) return true;
    const used = await this.read('translation_chars', utcDay());
    return used + characters <= limit;
  }

  async recordTranslation(characters: number): Promise<TranslationBudgetStatus> {
    const day = utcDay();
    const ttl = secondsUntilEndOfUtcDay();
    await this.kv.incrBy(this.key('translation_chars', day), characters, ttl);
    await this.kv.incrBy(this.key('translation_requests', day), 1, ttl);

    const status = await this.translationStatus(day);
    if (status.state !== 'ok' && this.warnedTranslationDay !== day) {
      this.warnedTranslationDay = day;
      log.warn('translation budget threshold crossed', {
        state: status.state,
        charactersUsed: status.charactersUsed,
        characterLimit: status.characterLimit,
      });
    }

    void this.db.addUsage(day, {
      translationCharacters: characters,
      translationRequests: 1,
      translationCostUsd: (characters / 1_000_000) * config.translation.costPerMillionChars,
    });
    return status;
  }

  // ------------------------------------------------------------------------ bot

  async botStatus(day = utcDay()): Promise<BotBudgetStatus> {
    const [messages, costUsd] = await Promise.all([
      this.read('bot_messages', day),
      this.read('bot_cost', day),
    ]);
    const messageLimit = config.bot.dailyMessageLimit;
    const costLimit = config.bot.dailyCostLimitUsd;
    let state: BudgetState = 'ok';
    if ((messageLimit > 0 && messages >= messageLimit) || (costLimit > 0 && costUsd >= costLimit)) {
      state = 'exhausted';
    } else if (
      (messageLimit > 0 && messages / messageLimit >= 0.8) ||
      (costLimit > 0 && costUsd / costLimit >= 0.8)
    ) {
      state = 'warning';
    }
    return { messages, messageLimit, costUsd, costLimitUsd: costLimit, state };
  }

  async canUseBot(): Promise<boolean> {
    const status = await this.botStatus();
    return status.state !== 'exhausted';
  }

  async recordBotMessage(inputTokens: number, outputTokens: number, costUsd: number): Promise<void> {
    const day = utcDay();
    const ttl = secondsUntilEndOfUtcDay();
    await this.kv.incrBy(this.key('bot_messages', day), 1, ttl);
    await this.kv.incrBy(this.key('bot_input_tokens', day), inputTokens, ttl);
    await this.kv.incrBy(this.key('bot_output_tokens', day), outputTokens, ttl);
    await this.kv.incrByFloat(this.key('bot_cost', day), costUsd, ttl);

    void this.db.addUsage(day, {
      botMessages: 1,
      botInputTokens: inputTokens,
      botOutputTokens: outputTokens,
      botCostUsd: costUsd,
    });
  }

  async recordBotSessionStarted(): Promise<void> {
    const day = utcDay();
    await this.kv.incrBy(this.key('bot_sessions', day), 1, secondsUntilEndOfUtcDay());
    void this.db.addUsage(day, { botSessions: 1 });
  }

  // ------------------------------------------------------------------ dashboard

  /** Shape consumed by the admin cost dashboard (§35). */
  async dashboard(day = utcDay()): Promise<Record<string, unknown>> {
    const [translation, bot, sessions, requests, inputTokens, outputTokens] = await Promise.all([
      this.translationStatus(day),
      this.botStatus(day),
      this.read('bot_sessions', day),
      this.read('translation_requests', day),
      this.read('bot_input_tokens', day),
      this.read('bot_output_tokens', day),
    ]);
    const avgCostPerSession = sessions > 0 ? bot.costUsd / sessions : 0;
    return {
      day,
      translation: {
        charactersUsed: translation.charactersUsed,
        characterLimit: translation.characterLimit,
        requests,
        state: translation.state,
        costUsd: round(translation.estimatedCostUsd, 4),
      },
      ai: {
        messages: bot.messages,
        messageLimit: bot.messageLimit,
        sessions,
        inputTokens,
        outputTokens,
        state: bot.state,
        costUsd: round(bot.costUsd, 4),
        costLimitUsd: bot.costLimitUsd,
        averageCostPerSessionUsd: round(avgCostPerSession, 4),
      },
      totalCostUsd: round(translation.estimatedCostUsd + bot.costUsd, 4),
    };
  }
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
