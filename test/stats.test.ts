import { describe, expect, it } from 'vitest';
import { LanguageStats } from '../src/stats/language-stats.js';
import { NullDatabase } from '../src/store/db.js';
import { config } from '../src/config/index.js';

function makeStats() {
  return new LanguageStats(new NullDatabase());
}

describe('LanguageStats (§6, §27)', () => {
  it('tracks waiting counts per language', () => {
    const stats = makeStats();
    stats.enteredQueue('tr');
    stats.enteredQueue('en');
    stats.enteredQueue('en');

    expect(stats.density()).toEqual({ tr: 1, en: 2 });
    stats.leftQueue('en');
    expect(stats.waitingIn('en')).toBe(1);
  });

  it('never lets a counter go negative', () => {
    const stats = makeStats();
    stats.leftQueue('tr');
    stats.userDisconnected('tr');
    expect(stats.waitingIn('tr')).toBe(0);
    expect(stats.snapshot('tr').activeUsers).toBe(0);
  });

  it('computes average match time from successful matches only', () => {
    const stats = makeStats();
    stats.record('tr', 2_000, true);
    stats.record('tr', 3_000, true);
    stats.record('tr', 60_000, false);

    const snapshot = stats.snapshot('tr');
    expect(snapshot.averageMatchTimeMs).toBe(2_500);
    expect(snapshot.matchSuccessRate).toBeCloseTo(2 / 3, 5);
  });

  it('reports bot usage separately from match success', () => {
    const stats = makeStats();
    stats.record('fi', 40_000, false, true);
    stats.record('fi', 4_000, true, false);

    const snapshot = stats.snapshot('fi');
    expect(snapshot.botUsageRate).toBeCloseTo(0.5, 5);
    expect(snapshot.matchSuccessRate).toBeCloseTo(0.5, 5);
  });

  // The document's own example: a healthy Turkish queue vs a struggling Finnish one.
  it('marks a fast, reliable language as low fallback pressure', () => {
    const stats = makeStats();
    for (let i = 0; i < config.fallback.minSamples; i += 1) stats.record('tr', 2_100, true);
    expect(stats.snapshot('tr').fallbackPressure).toBe('low');
  });

  it('marks a slow, unreliable language as high fallback pressure', () => {
    const stats = makeStats();
    for (let i = 0; i < config.fallback.minSamples; i += 1) {
      stats.record('fi', 42_000, i % 3 === 0, i % 3 !== 0);
    }
    expect(stats.snapshot('fi').fallbackPressure).toBe('high');
  });

  it('uses the live queue as evidence before enough samples exist', () => {
    const stats = makeStats();
    expect(stats.pressure('fi')).toBe('high');

    for (let i = 0; i < 6; i += 1) stats.enteredQueue('en');
    expect(stats.pressure('en')).toBe('low');
  });

  it('stretches the wait ladder for a fast language and shortens it for a slow one', () => {
    const fast = makeStats();
    for (let i = 0; i < config.fallback.minSamples; i += 1) fast.record('tr', 2_000, true);
    expect(fast.thresholdFactor('tr')).toBeGreaterThan(1);

    const slow = makeStats();
    for (let i = 0; i < config.fallback.minSamples; i += 1) slow.record('fi', 42_000, true);
    expect(slow.thresholdFactor('fi')).toBeLessThan(1);
  });

  it('clamps the threshold factor to the configured range', () => {
    const stats = makeStats();
    for (let i = 0; i < config.fallback.minSamples; i += 1) stats.record('tr', 1, true);
    expect(stats.thresholdFactor('tr')).toBeLessThanOrEqual(config.matching.dynamicMaxFactor);
  });

  it('stays neutral until there is enough data', () => {
    const stats = makeStats();
    stats.record('tr', 1_000, true);
    expect(stats.thresholdFactor('tr')).toBe(1);
  });
});
