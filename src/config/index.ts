/**
 * Central runtime configuration.
 *
 * Everything is environment driven and every knob the product document calls
 * "tunable" (§7 wait thresholds, §13 translation budget, §25 bot limits,
 * §26-27 language-based fallback aggressiveness) is exposed here.
 */

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function optionalStr(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export type BotMode = 'launch' | 'mature';

export const config = {
  env: str('NODE_ENV', 'development'),
  port: int('PORT', 3000),
  host: str('HOST', '0.0.0.0'),
  logLevel: str('LOG_LEVEL', 'info'),
  trustProxy: bool('TRUST_PROXY', false),

  redisUrl: optionalStr('REDIS_URL'),
  databaseUrl: optionalStr('DATABASE_URL'),

  /** Admin dashboard (§34-35) token. When unset the dashboard API is disabled. */
  adminToken: optionalStr('ADMIN_TOKEN'),

  chat: {
    /** Hard cap on a single chat message, in characters. */
    maxMessageLength: int('MAX_MESSAGE_LENGTH', 2000),
    /** Messages per 10s per session before we start dropping. */
    messageRateLimit: int('MESSAGE_RATE_LIMIT', 15),
    /** Drop a socket that has not pinged in this long. */
    heartbeatTimeoutMs: int('HEARTBEAT_TIMEOUT_MS', 45_000),
    heartbeatIntervalMs: int('HEARTBEAT_INTERVAL_MS', 15_000),
  },

  matching: {
    /** §7 escalation ladder, in milliseconds. */
    sameLanguageInterestMs: int('MATCH_TIER1_MS', 5_000),
    sameLanguageAnyMs: int('MATCH_TIER2_MS', 10_000),
    crossLanguageMs: int('MATCH_TIER3_MS', 20_000),
    /** How often the engine sweeps the waiting pool. */
    tickIntervalMs: int('MATCH_TICK_MS', 500),
    /** §5 scoring weights. */
    weights: {
      sameLanguage: int('SCORE_SAME_LANGUAGE', 100),
      firstCommonInterest: int('SCORE_FIRST_INTEREST', 30),
      extraCommonInterest: int('SCORE_EXTRA_INTEREST', 10),
      neverMatchedBefore: int('SCORE_NEVER_MATCHED', 10),
      translationRequired: int('SCORE_TRANSLATION_PENALTY', -20),
      recentlyLeft: int('SCORE_RECENTLY_LEFT', -50),
      blocked: int('SCORE_BLOCKED', -9999),
      sameAbuseCluster: int('SCORE_ABUSE_CLUSTER', -9999),
    },
    /** A pair counts as "recently left" for this long after they disconnect. */
    recentlyLeftWindowMs: int('RECENTLY_LEFT_WINDOW_MS', 10 * 60_000),
    /** How long we remember who a session already talked to. */
    partnerHistoryTtlMs: int('PARTNER_HISTORY_TTL_MS', 6 * 60 * 60_000),
    /** Any candidate scoring at or below this is never matched. */
    rejectScoreThreshold: int('REJECT_SCORE_THRESHOLD', -1000),
    /**
     * §7: thresholds adapt to the observed match time of a language. The
     * effective threshold is clamped into [min, max] multiples of the base.
     */
    dynamicThresholds: bool('MATCH_DYNAMIC_THRESHOLDS', true),
    dynamicMinFactor: num('MATCH_DYNAMIC_MIN_FACTOR', 0.5),
    dynamicMaxFactor: num('MATCH_DYNAMIC_MAX_FACTOR', 2.5),
  },

  translation: {
    provider: str('TRANSLATION_PROVIDER', 'auto') as 'auto' | 'google' | 'echo' | 'none',
    google: {
      apiKey: optionalStr('GOOGLE_TRANSLATE_API_KEY'),
      projectId: optionalStr('GOOGLE_CLOUD_PROJECT'),
      location: str('GOOGLE_TRANSLATE_LOCATION', 'global'),
      credentialsFile: optionalStr('GOOGLE_APPLICATION_CREDENTIALS'),
      /** v2 is the API-key REST surface, v3 needs a service account. */
      timeoutMs: int('TRANSLATE_TIMEOUT_MS', 4_000),
    },
    /** §12 cache. Short lived on purpose — these are user messages. */
    cacheTtlSeconds: int('TRANSLATION_CACHE_TTL_S', 900),
    cacheMaxEntries: int('TRANSLATION_CACHE_MAX_ENTRIES', 5_000),
    /** Only cache short, likely-repeated strings ("hi", "how are you"). */
    cacheMaxChars: int('TRANSLATION_CACHE_MAX_CHARS', 120),
    /** §13 daily character budget across the whole platform. */
    dailyCharacterLimit: int('TRANSLATION_DAILY_CHAR_LIMIT', 500_000),
    warnRatio: num('TRANSLATION_WARN_RATIO', 0.8),
    /** USD per million characters, for the cost dashboard. */
    costPerMillionChars: num('TRANSLATION_COST_PER_M_CHARS', 20),
    retryAttempts: int('TRANSLATION_RETRY_ATTEMPTS', 1),
  },

  bot: {
    enabled: bool('BOT_ENABLED', true),
    /** §43: launch = automatic fallback, mature = only on explicit request. */
    mode: str('BOT_MODE', 'launch') as BotMode,
    provider: str('BOT_PROVIDER', 'auto') as 'auto' | 'anthropic' | 'openai-compatible' | 'scripted',
    anthropic: {
      apiKey: optionalStr('ANTHROPIC_API_KEY'),
      model: str('BOT_ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001'),
      baseUrl: str('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
      version: str('ANTHROPIC_VERSION', '2023-06-01'),
      /** USD per million tokens, for the cost dashboard. */
      inputCostPerMTok: num('BOT_INPUT_COST_PER_MTOK', 1),
      outputCostPerMTok: num('BOT_OUTPUT_COST_PER_MTOK', 5),
    },
    /** "Local AI" branch of §24 — any OpenAI-compatible server (Ollama, vLLM…). */
    openaiCompatible: {
      baseUrl: optionalStr('LOCAL_AI_BASE_URL'),
      apiKey: optionalStr('LOCAL_AI_API_KEY'),
      model: str('LOCAL_AI_MODEL', 'llama3.1'),
    },
    timeoutMs: int('BOT_TIMEOUT_MS', 20_000),
    maxReplyTokens: int('BOT_MAX_REPLY_TOKENS', 220),
    /** How much of the conversation is replayed to the model. */
    historyTurns: int('BOT_HISTORY_TURNS', 16),
    /** §25 usage limits. Set sessionLimitMs to 0 to disable the cap. */
    sessionLimitMs: int('BOT_SESSION_LIMIT_MS', 10 * 60_000),
    cooldownMs: int('BOT_COOLDOWN_MS', 2 * 60_000),
    /** Generous at launch so the product is never empty (§25). */
    dailyMessageLimit: int('BOT_DAILY_MESSAGE_LIMIT', 20_000),
    dailyCostLimitUsd: num('BOT_DAILY_COST_LIMIT_USD', 25),
    /** Simulated typing delay so replies do not land instantly. */
    minTypingMs: int('BOT_MIN_TYPING_MS', 700),
    typingMsPerChar: int('BOT_TYPING_MS_PER_CHAR', 18),
    maxTypingMs: int('BOT_MAX_TYPING_MS', 4_000),
  },

  /** §26-27: how aggressively we offer the bot, per language. */
  fallback: {
    /** A language is "healthy" above this success rate; bot pressure drops. */
    healthySuccessRate: num('FALLBACK_HEALTHY_SUCCESS_RATE', 0.8),
    /** …and below this average match time (ms). */
    healthyAverageMatchMs: int('FALLBACK_HEALTHY_AVG_MATCH_MS', 8_000),
    /** Minimum samples before the stats are trusted at all. */
    minSamples: int('FALLBACK_MIN_SAMPLES', 20),
  },

  stats: {
    /** How often language_statistics is recomputed and flushed. */
    flushIntervalMs: int('STATS_FLUSH_INTERVAL_MS', 15_000),
    /** Rolling window used for average match time / success rate. */
    windowMs: int('STATS_WINDOW_MS', 15 * 60_000),
  },
} as const;

export type AppConfig = typeof config;
