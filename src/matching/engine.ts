/**
 * Human matching engine (§4, §7, §31, §42).
 *
 * §42 is the important constraint: the bot is **not** part of this engine. The
 * engine only ever answers "is a human available for this person, and under
 * which tier". Whether the absence of a human turns into an AI offer is the Bot
 * Manager's problem, which is what makes the bot removable later without
 * touching matching.
 *
 * Escalation (§7) is per user: everyone climbs their own ladder from
 * "same language + shared interest" up to "any language, with translation".
 * A pairing is only made when the tier it requires is unlocked for *both*
 * sides — otherwise a user who just arrived would be robbed of their own
 * same-language priority window by someone who has been waiting longer.
 */
import { config } from '../config/index.js';
import type { LanguageStats } from '../stats/language-stats.js';
import type { RelationshipService } from '../safety/relationships.js';
import type { MatchResult, MatchTier, SessionId, WaitingEntry } from '../types.js';
import { scorePair } from './scoring.js';

/** How far up the ladder a waiting user currently is. */
export type TierLevel = 1 | 2 | 3;

export interface AvailabilityResult {
  sessionId: SessionId;
  waitedMs: number;
  level: TierLevel;
  /** True once the wait has passed the point where an AI offer is warranted. */
  botOfferDue: boolean;
  sameLanguageWaiting: number;
}

/** Multiplies the bot-offer threshold: healthy languages hold out longer (§28). */
const PRESSURE_MULTIPLIER: Record<string, number> = { low: 2, medium: 1, high: 0.6 };

export class MatchEngine {
  private readonly waiting = new Map<SessionId, WaitingEntry>();

  constructor(
    private readonly relationships: RelationshipService,
    private readonly stats: LanguageStats,
  ) {}

  get size(): number {
    return this.waiting.size;
  }

  has(sessionId: SessionId): boolean {
    return this.waiting.has(sessionId);
  }

  enqueue(entry: WaitingEntry): void {
    if (this.waiting.has(entry.sessionId)) return;
    this.waiting.set(entry.sessionId, entry);
    this.stats.enteredQueue(entry.language);
  }

  dequeue(sessionId: SessionId): WaitingEntry | null {
    const entry = this.waiting.get(sessionId);
    if (!entry) return null;
    this.waiting.delete(sessionId);
    this.stats.leftQueue(entry.language);
    return entry;
  }

  get(sessionId: SessionId): WaitingEntry | null {
    return this.waiting.get(sessionId) ?? null;
  }

  /** Marks that the user chose "keep waiting" over the AI offer (§37). */
  declineBotOffer(sessionId: SessionId): void {
    const entry = this.waiting.get(sessionId);
    if (entry) entry.botOfferDeclined = true;
  }

  // ------------------------------------------------------------------ tiers

  /**
   * Effective ladder thresholds for a language, scaled by how well that
   * language is actually matching right now (§7, §27).
   */
  thresholds(language: string): { tier2: number; tier3: number; botOffer: number } {
    const factor = this.stats.thresholdFactor(language);
    const { sameLanguageInterestMs, sameLanguageAnyMs, crossLanguageMs } = config.matching;
    const pressure = this.stats.pressure(language);
    return {
      tier2: sameLanguageInterestMs * factor,
      tier3: sameLanguageAnyMs * factor,
      botOffer: crossLanguageMs * factor * (PRESSURE_MULTIPLIER[pressure] ?? 1),
    };
  }

  private levelFor(entry: WaitingEntry, now: number): TierLevel {
    const waited = now - entry.enqueuedAt;
    const { tier2, tier3 } = this.thresholds(entry.language);
    if (waited < tier2) return 1;
    if (waited < tier3) return 2;
    return 3;
  }

  /** The minimum tier level at which a given pairing becomes acceptable. */
  private requiredLevel(sameLanguage: boolean, sharedInterests: number): TierLevel {
    if (!sameLanguage) return 3;
    return sharedInterests > 0 ? 1 : 2;
  }

  private tierName(sameLanguage: boolean, sharedInterests: number): MatchTier {
    if (!sameLanguage) return 'cross-language';
    return sharedInterests > 0 ? 'same-language-interest' : 'same-language';
  }

  // --------------------------------------------------------------- matching

  /**
   * Sweeps the waiting pool and returns the pairings made this tick.
   *
   * Users are served longest-waiting-first, and each participant can only be
   * used once per sweep.
   */
  async tick(now: number = Date.now()): Promise<MatchResult[]> {
    const results: MatchResult[] = [];
    const entries = [...this.waiting.values()].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    const consumed = new Set<SessionId>();

    for (const seeker of entries) {
      if (consumed.has(seeker.sessionId)) continue;
      const seekerLevel = this.levelFor(seeker, now);

      const candidates = entries.filter(
        (c) =>
          c.sessionId !== seeker.sessionId &&
          !consumed.has(c.sessionId) &&
          c.anonymousUserId !== seeker.anonymousUserId,
      );
      if (candidates.length === 0) continue;

      let best: { result: MatchResult; score: number } | null = null;

      for (const candidate of candidates) {
        const sameLanguage = candidate.language === seeker.language;
        // Cheap structural filters before paying for the relationship lookup.
        if (seekerLevel < 3 && !sameLanguage) continue;

        const ctx = await this.relationships.context(seeker, candidate);
        const scored = scorePair(seeker, candidate, ctx);
        if (scored.rejected) continue;

        const required = this.requiredLevel(sameLanguage, scored.commonInterests.length);
        const candidateLevel = this.levelFor(candidate, now);
        if (seekerLevel < required || candidateLevel < required) continue;

        if (best === null || scored.score > best.score) {
          best = {
            score: scored.score,
            result: {
              a: seeker,
              b: candidate,
              tier: this.tierName(sameLanguage, scored.commonInterests.length),
              score: scored.score,
              translationRequired: scored.translationRequired,
              commonInterests: scored.commonInterests,
            },
          };
        }
      }

      if (best) {
        consumed.add(seeker.sessionId);
        consumed.add(best.result.b.sessionId);
        this.dequeue(seeker.sessionId);
        this.dequeue(best.result.b.sessionId);
        await this.relationships.recordMatch(seeker.anonymousUserId, best.result.b.anonymousUserId);
        results.push(best.result);
      }
    }

    return results;
  }

  /**
   * §42 — the engine's other output: "no human yet, and here is how that
   * search is going". The Bot Manager consumes this; the engine never decides
   * to start a bot conversation itself.
   */
  availability(now: number = Date.now()): AvailabilityResult[] {
    const out: AvailabilityResult[] = [];
    for (const entry of this.waiting.values()) {
      const waited = now - entry.enqueuedAt;
      const { botOffer } = this.thresholds(entry.language);
      out.push({
        sessionId: entry.sessionId,
        waitedMs: waited,
        level: this.levelFor(entry, now),
        botOfferDue: waited >= botOffer,
        sameLanguageWaiting: Math.max(0, this.stats.waitingIn(entry.language) - 1),
      });
    }
    return out;
  }

  /**
   * Waiting anonymous ids grouped by language.
   *
   * Built once per tick so the bot watcher does not rescan the pool for every
   * AI conversation in progress.
   */
  waitingByLanguage(): Map<string, Set<string>> {
    const index = new Map<string, Set<string>>();
    for (const entry of this.waiting.values()) {
      let bucket = index.get(entry.language);
      if (!bucket) {
        bucket = new Set();
        index.set(entry.language, bucket);
      }
      bucket.add(entry.anonymousUserId);
    }
    return index;
  }

  /** True when at least one other waiting user could plausibly pair with this one. */
  hasPlausibleHuman(sessionId: SessionId): boolean {
    const entry = this.waiting.get(sessionId);
    if (!entry) return false;
    for (const other of this.waiting.values()) {
      if (other.sessionId === entry.sessionId) continue;
      if (other.anonymousUserId === entry.anonymousUserId) continue;
      return true;
    }
    return false;
  }

  clear(): void {
    for (const id of [...this.waiting.keys()]) this.dequeue(id);
  }
}
