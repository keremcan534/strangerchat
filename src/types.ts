/** Shared domain types. */

export type SessionId = string;
/** Stable-ish pseudonymous id for one browser (§3: "anon_8f72"). */
export type AnonymousUserId = string;

export type PartnerKind = 'human' | 'bot';

/** §3 — everything we keep about a user lives on the session, not a profile. */
export interface ChatSession {
  id: SessionId;
  anonymousUserId: AnonymousUserId;
  preferredLanguage: string;
  detectedLanguage: string | null;
  translationEnabled: boolean;
  translationTargetLanguage: string | null;
  interests: string[];
  createdAt: number;
  /** Set when the session entered the waiting pool for the current search. */
  searchStartedAt: number | null;
  state: SessionState;
  /** Populated while paired with a human. */
  roomId: string | null;
  /** Populated while talking to the bot. */
  botSessionId: string | null;
  /** Hashed network prefix; the input to abuse clustering, never matched on directly. */
  networkKey: string | null;
  /** Set only when this session's network is a *flagged* cluster (§5). */
  abuseCluster: string | null;
}

export type SessionState =
  | 'idle'
  | 'searching'
  | 'chatting'
  | 'bot-offered'
  | 'bot-chatting'
  | 'closed';

/** A candidate as the matching engine sees it. */
export interface WaitingEntry {
  sessionId: SessionId;
  anonymousUserId: AnonymousUserId;
  language: string;
  interests: string[];
  enqueuedAt: number;
  abuseCluster: string | null;
  /** True once the user explicitly asked to keep waiting past the bot offer. */
  botOfferDeclined: boolean;
}

export type MatchTier =
  | 'same-language-interest'
  | 'same-language'
  | 'cross-language';

export interface ScoredCandidate {
  entry: WaitingEntry;
  score: number;
  translationRequired: boolean;
  commonInterests: string[];
  rejected: boolean;
  reasons: string[];
}

export interface MatchResult {
  a: WaitingEntry;
  b: WaitingEntry;
  tier: MatchTier;
  score: number;
  translationRequired: boolean;
  commonInterests: string[];
}

export interface TranslationResult {
  text: string;
  detectedSourceLanguage: string | null;
  /** True when the string came back from the short-lived cache (§12). */
  cached: boolean;
  provider: string;
  charactersBilled: number;
}

export interface TranslationOutcome {
  ok: boolean;
  /** Present when ok; equals the original text when translation degraded. */
  result: TranslationResult | null;
  /** Machine-readable reason a translation did not happen. */
  reason?: 'budget-exhausted' | 'provider-error' | 'disabled' | 'same-language' | 'empty';
}

export interface LanguageStatsSnapshot {
  languageCode: string;
  activeUsers: number;
  waitingUsers: number;
  /** Milliseconds. Null when there is not enough data yet. */
  averageMatchTimeMs: number | null;
  matchSuccessRate: number | null;
  botUsageRate: number | null;
  samples: number;
  /** Derived recommendation used by the bot offer policy (§27). */
  fallbackPressure: FallbackPressure;
  updatedAt: number;
}

export type FallbackPressure = 'low' | 'medium' | 'high';

export interface BotPersonality {
  id: string;
  label: string;
  /** Extra guidance appended to the base system prompt. */
  prompt: string;
  /** Interests that make this personality a good pick. */
  interests: string[];
}

export interface BotTurn {
  role: 'user' | 'assistant';
  content: string;
}
