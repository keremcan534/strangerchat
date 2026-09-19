/**
 * Per-language health (§6, §26, §27).
 *
 * The central product decision of §26 is that "we have 10,000 users" says
 * nothing about whether a Turkish speaker will find someone. So availability is
 * measured per language: how many are online, how many are waiting, how long a
 * match takes and how often it succeeds. Those numbers then drive two things —
 * how fast the matching ladder escalates (§7) and how eagerly we offer the bot
 * (§28).
 */
import { config } from '../config/index.js';
import type { Database } from '../store/db.js';
import type { FallbackPressure, LanguageStatsSnapshot } from '../types.js';

interface Sample {
  at: number;
  waitMs: number;
  matched: boolean;
  usedBot: boolean;
}

interface LanguageState {
  active: number;
  waiting: number;
  samples: Sample[];
}

export class LanguageStats {
  private readonly languages = new Map<string, LanguageState>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly db: Database) {}

  private state(language: string): LanguageState {
    let s = this.languages.get(language);
    if (!s) {
      s = { active: 0, waiting: 0, samples: [] };
      this.languages.set(language, s);
    }
    return s;
  }

  // ------------------------------------------------------------- live gauges

  userConnected(language: string): void {
    this.state(language).active += 1;
  }

  userDisconnected(language: string): void {
    const s = this.state(language);
    s.active = Math.max(0, s.active - 1);
  }

  enteredQueue(language: string): void {
    this.state(language).waiting += 1;
  }

  leftQueue(language: string): void {
    const s = this.state(language);
    s.waiting = Math.max(0, s.waiting - 1);
  }

  // ----------------------------------------------------------------- samples

  /** Records the outcome of one search. `usedBot` marks an AI fallback. */
  record(language: string, waitMs: number, matched: boolean, usedBot = false): void {
    const s = this.state(language);
    s.samples.push({ at: Date.now(), waitMs, matched, usedBot });
    this.prune(s);
  }

  private prune(s: LanguageState): void {
    const cutoff = Date.now() - config.stats.windowMs;
    while (s.samples.length > 0 && s.samples[0]!.at < cutoff) s.samples.shift();
    // Bound memory for very busy languages; the window is what matters.
    if (s.samples.length > 5_000) s.samples.splice(0, s.samples.length - 5_000);
  }

  // ---------------------------------------------------------------- readouts

  snapshot(language: string): LanguageStatsSnapshot {
    const s = this.state(language);
    this.prune(s);

    const samples = s.samples;
    const matchedSamples = samples.filter((x) => x.matched);
    const averageMatchTimeMs =
      matchedSamples.length > 0
        ? matchedSamples.reduce((acc, x) => acc + x.waitMs, 0) / matchedSamples.length
        : null;
    const matchSuccessRate = samples.length > 0 ? matchedSamples.length / samples.length : null;
    const botUsageRate =
      samples.length > 0 ? samples.filter((x) => x.usedBot).length / samples.length : null;

    return {
      languageCode: language,
      activeUsers: s.active,
      waitingUsers: s.waiting,
      averageMatchTimeMs,
      matchSuccessRate,
      botUsageRate,
      samples: samples.length,
      fallbackPressure: this.pressureFrom(s.waiting, averageMatchTimeMs, matchSuccessRate, samples.length),
      updatedAt: Date.now(),
    };
  }

  all(): LanguageStatsSnapshot[] {
    return [...this.languages.keys()]
      .map((code) => this.snapshot(code))
      .sort((a, b) => b.activeUsers - a.activeUsers || a.languageCode.localeCompare(b.languageCode));
  }

  /** §6 — how many people are waiting in each language, right now. */
  density(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [code, s] of this.languages) out[code] = s.waiting;
    return out;
  }

  waitingIn(language: string): number {
    return this.languages.get(language)?.waiting ?? 0;
  }

  /**
   * §27 — how badly this language needs the AI fallback.
   *
   * Before we have enough samples the live queue is the only evidence we have,
   * so an empty queue reads as high pressure and a busy one as low.
   */
  private pressureFrom(
    waiting: number,
    averageMatchTimeMs: number | null,
    matchSuccessRate: number | null,
    sampleCount: number,
  ): FallbackPressure {
    if (sampleCount < config.fallback.minSamples) {
      if (waiting >= 5) return 'low';
      if (waiting >= 1) return 'medium';
      return 'high';
    }
    const healthySuccess =
      matchSuccessRate !== null && matchSuccessRate >= config.fallback.healthySuccessRate;
    const healthySpeed =
      averageMatchTimeMs !== null && averageMatchTimeMs <= config.fallback.healthyAverageMatchMs;

    if (healthySuccess && healthySpeed) return 'low';
    if (healthySuccess || healthySpeed) return 'medium';
    return 'high';
  }

  pressure(language: string): FallbackPressure {
    return this.snapshot(language).fallbackPressure;
  }

  /**
   * §7 — scales the wait ladder by how fast this language actually matches.
   *
   * A language that matches in 2s can afford to hold out for a same-language
   * partner; one that averages 40s should escalate quickly instead of parking
   * the user on a spinner.
   */
  thresholdFactor(language: string): number {
    if (!config.matching.dynamicThresholds) return 1;
    const snap = this.snapshot(language);
    if (snap.samples < config.fallback.minSamples || snap.averageMatchTimeMs === null) return 1;
    if (snap.averageMatchTimeMs <= 0) return config.matching.dynamicMaxFactor;

    const raw = config.fallback.healthyAverageMatchMs / snap.averageMatchTimeMs;
    return Math.min(
      config.matching.dynamicMaxFactor,
      Math.max(config.matching.dynamicMinFactor, raw),
    );
  }

  // ------------------------------------------------------------ persistence

  startFlushing(): void {
    if (this.timer || !this.db.enabled) return;
    this.timer = setInterval(() => {
      void this.db.upsertLanguageStats(this.all());
    }, config.stats.flushIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
