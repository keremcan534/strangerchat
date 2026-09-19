import { describe, expect, it } from 'vitest';
import { commonInterests, scorePair, NEUTRAL_CONTEXT } from '../src/matching/scoring.js';
import type { WaitingEntry } from '../src/types.js';

function entry(overrides: Partial<WaitingEntry> = {}): WaitingEntry {
  return {
    sessionId: overrides.sessionId ?? 'a',
    anonymousUserId: overrides.anonymousUserId ?? 'anon_a',
    language: overrides.language ?? 'tr',
    interests: overrides.interests ?? [],
    enqueuedAt: overrides.enqueuedAt ?? 0,
    abuseCluster: overrides.abuseCluster ?? null,
    botOfferDeclined: overrides.botOfferDeclined ?? false,
  };
}

describe('commonInterests', () => {
  it('returns the intersection in the seeker order', () => {
    expect(commonInterests(['gaming', 'music', 'technology'], ['music', 'gaming'])).toEqual([
      'gaming',
      'music',
    ]);
  });
});

describe('scorePair (§5)', () => {
  // The document's worked example: user A (tr, gaming/music/technology) with
  // candidates B (tr, gaming/music) and C (en, gaming/music).
  const a = entry({ language: 'tr', interests: ['gaming', 'music', 'technology'] });
  const b = entry({ sessionId: 'b', anonymousUserId: 'anon_b', language: 'tr', interests: ['gaming', 'music'] });
  const c = entry({ sessionId: 'c', anonymousUserId: 'anon_c', language: 'en', interests: ['gaming', 'music'] });

  it('scores a same-language candidate above a cross-language one', () => {
    const scoredB = scorePair(a, b);
    const scoredC = scorePair(a, c);
    expect(scoredB.score).toBeGreaterThan(scoredC.score);
  });

  it('applies the documented weights', () => {
    // 100 same-language + 30 first interest + 10 second + 10 never matched.
    expect(scorePair(a, b).score).toBe(150);
    // -20 translation + 30 + 10 + 10.
    expect(scorePair(a, c).score).toBe(30);
  });

  it('flags cross-language pairs as needing translation', () => {
    expect(scorePair(a, b).translationRequired).toBe(false);
    expect(scorePair(a, c).translationRequired).toBe(true);
  });

  it('drops the never-matched bonus for a repeat pairing', () => {
    const repeat = scorePair(a, b, { ...NEUTRAL_CONTEXT, matchedBefore: true });
    expect(repeat.score).toBe(140);
  });

  it('penalises a partner who just left', () => {
    const scored = scorePair(a, b, { ...NEUTRAL_CONTEXT, recentlyLeft: true });
    expect(scored.score).toBe(100);
    expect(scored.rejected).toBe(false);
  });

  it('rejects blocked pairs outright, however well they match', () => {
    const scored = scorePair(a, b, { ...NEUTRAL_CONTEXT, blocked: true });
    expect(scored.rejected).toBe(true);
  });

  it('rejects pairs from the same abuse cluster', () => {
    const scored = scorePair(a, b, { ...NEUTRAL_CONTEXT, sameAbuseCluster: true });
    expect(scored.rejected).toBe(true);
  });

  it('counts each extra shared interest', () => {
    const many = entry({
      sessionId: 'd',
      anonymousUserId: 'anon_d',
      language: 'tr',
      interests: ['gaming', 'music', 'technology'],
    });
    // 100 + 30 + 10 + 10 + 10 never matched.
    expect(scorePair(a, many).score).toBe(160);
  });
});
