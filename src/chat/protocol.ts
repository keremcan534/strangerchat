/**
 * WebSocket protocol.
 *
 * Every outbound chat message carries enough information for the client to
 * render the three badges the product requires (§38): 🟢 Human, 🌐 Translated,
 * 🤖 AI. The client is never left guessing what the system did on its behalf.
 */
import { normaliseInterests, normaliseLanguage } from '../config/languages.js';
import type { MatchTier, PartnerKind } from '../types.js';

// ------------------------------------------------------------------ inbound

export type ClientMessage =
  | { type: 'hello'; anonymousUserId?: string; language: string; interests?: string[] }
  | { type: 'start'; language?: string; interests?: string[] }
  | { type: 'cancel' }
  | { type: 'message'; text: string; clientId?: string }
  | { type: 'typing'; active: boolean }
  | { type: 'skip' }
  | { type: 'leave' }
  | { type: 'accept-bot' }
  | { type: 'decline-bot' }
  | { type: 'request-bot' }
  | { type: 'accept-human' }
  | { type: 'stay-with-bot' }
  | { type: 'block' }
  | { type: 'report'; reason?: string }
  | { type: 'ping' };

export interface ParseResult {
  ok: boolean;
  message?: ClientMessage;
  error?: string;
}

const SIMPLE_TYPES = new Set([
  'cancel',
  'skip',
  'leave',
  'accept-bot',
  'decline-bot',
  'request-bot',
  'accept-human',
  'stay-with-bot',
  'block',
  'ping',
]);

export function parseClientMessage(raw: string, maxMessageLength: number): ParseResult {
  if (raw.length > maxMessageLength + 1024) return { ok: false, error: 'payload too large' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, error: 'invalid payload' };

  const obj = parsed as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== 'string') return { ok: false, error: 'missing type' };

  if (SIMPLE_TYPES.has(type)) return { ok: true, message: { type } as ClientMessage };

  switch (type) {
    case 'hello': {
      const language = normaliseLanguage(asString(obj.language));
      if (!language) return { ok: false, error: 'unsupported language' };
      const anonymousUserId = asString(obj.anonymousUserId);
      return {
        ok: true,
        message: {
          type: 'hello',
          language,
          interests: normaliseInterests(obj.interests),
          ...(anonymousUserId && /^[A-Za-z0-9_-]{4,64}$/.test(anonymousUserId)
            ? { anonymousUserId }
            : {}),
        },
      };
    }
    case 'start': {
      const language = normaliseLanguage(asString(obj.language));
      // Interests are only replaced when the client actually sent them, so a
      // bare {"type":"start"} keeps whatever `hello` established.
      return {
        ok: true,
        message: {
          type: 'start',
          ...(language ? { language } : {}),
          ...(Array.isArray(obj.interests) ? { interests: normaliseInterests(obj.interests) } : {}),
        },
      };
    }
    case 'message': {
      const text = asString(obj.text)?.trim();
      if (!text) return { ok: false, error: 'empty message' };
      if (text.length > maxMessageLength) return { ok: false, error: 'message too long' };
      const clientId = asString(obj.clientId);
      return { ok: true, message: { type: 'message', text, ...(clientId ? { clientId } : {}) } };
    }
    case 'typing':
      return { ok: true, message: { type: 'typing', active: obj.active === true } };
    case 'report': {
      const reason = asString(obj.reason)?.slice(0, 200);
      return { ok: true, message: { type: 'report', ...(reason ? { reason } : {}) } };
    }
    default:
      return { ok: false, error: `unknown type: ${type}` };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// ----------------------------------------------------------------- outbound

export interface TranslationBanner {
  enabled: boolean;
  /** Language the user reads in. */
  yourLanguage: string;
  yourLanguageName: string;
  partnerLanguage: string;
  partnerLanguageName: string;
}

export type ServerMessage =
  | {
      type: 'session';
      sessionId: string;
      anonymousUserId: string;
      language: string;
      interests: string[];
      botEnabled: boolean;
      botMode: string;
    }
  | { type: 'searching'; startedAt: number; language: string }
  | {
      type: 'search-status';
      level: 1 | 2 | 3;
      waitedMs: number;
      language: string;
      sameLanguageWaiting: number;
      /** Message key the client localises, e.g. 'still-looking-same-language'. */
      statusKey: string;
    }
  | {
      type: 'matched';
      partnerKind: PartnerKind;
      roomId: string;
      tier: MatchTier;
      commonInterests: string[];
      translation: TranslationBanner;
    }
  | { type: 'bot-offer'; reason: 'no-human-available' | 'requested'; waitedMs: number }
  | {
      type: 'bot-matched';
      botSessionId: string;
      language: string;
      personality: string;
      /** Remaining session allowance in ms; null when unlimited (§25). */
      limitMs: number | null;
    }
  | { type: 'bot-unavailable'; reason: string; retryAfterMs?: number }
  | {
      type: 'message';
      id: string;
      from: 'you' | 'partner' | 'system';
      kind: PartnerKind | 'system';
      text: string;
      /** Present when `text` is a translation — powers "Show original" (§10). */
      originalText?: string;
      translated: boolean;
      sourceLanguage?: string;
      targetLanguage?: string;
      at: number;
      clientId?: string;
    }
  | { type: 'partner-typing'; active: boolean }
  | { type: 'human-available'; waitingIn: string }
  | { type: 'partner-left'; reason: 'left' | 'skipped' | 'disconnected' | 'ended' }
  | { type: 'translation-degraded'; reason: string }
  | { type: 'ended'; reason: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong'; at: number };
