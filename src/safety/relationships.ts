/**
 * Pair history and hard exclusions feeding the -9999 / -50 / +10 terms of §5.
 *
 * Pairs are keyed by the two anonymous ids sorted, so the relation is
 * symmetric regardless of who is searching.
 */
import type { Database } from '../store/db.js';
import type { KeyValueStore } from '../store/kv.js';
import type { WaitingEntry } from '../types.js';
import { config } from '../config/index.js';
import type { PairContext } from '../matching/scoring.js';

function pairKey(prefix: string, a: string, b: string): { key: string; member: string } {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return { key: `${prefix}:${lo}`, member: hi };
}

export class RelationshipService {
  /** In-process block list, so a block takes effect even without Postgres. */
  private readonly localBlocks = new Set<string>();

  constructor(private readonly kv: KeyValueStore, private readonly db: Database) {}

  private blockKey(a: string, b: string): string {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return `${lo}|${hi}`;
  }

  async block(blocker: string, blocked: string, reason: string | null = null): Promise<void> {
    this.localBlocks.add(this.blockKey(blocker, blocked));
    await this.db.addBlock(blocker, blocked, reason);
  }

  async isBlocked(a: string, b: string): Promise<boolean> {
    if (this.localBlocks.has(this.blockKey(a, b))) return true;
    return this.db.isBlocked(a, b);
  }

  /** Called when two users are paired — powers the "never matched before" bonus. */
  async recordMatch(a: string, b: string): Promise<void> {
    const { key, member } = pairKey('pairhist', a, b);
    await this.kv.markPair(key, member, Math.ceil(config.matching.partnerHistoryTtlMs / 1000));
  }

  /** Called when a conversation ends — powers the "recently left" penalty. */
  async recordDeparture(a: string, b: string): Promise<void> {
    const { key, member } = pairKey('pairleft', a, b);
    await this.kv.markPair(key, member, Math.ceil(config.matching.recentlyLeftWindowMs / 1000));
  }

  async context(seeker: WaitingEntry, candidate: WaitingEntry): Promise<PairContext> {
    const a = seeker.anonymousUserId;
    const b = candidate.anonymousUserId;

    const histKey = pairKey('pairhist', a, b);
    const leftKey = pairKey('pairleft', a, b);

    const [blocked, matchedAt, leftAt] = await Promise.all([
      this.isBlocked(a, b),
      this.kv.pairMarkedAt(histKey.key, histKey.member),
      this.kv.pairMarkedAt(leftKey.key, leftKey.member),
    ]);

    return {
      blocked,
      sameAbuseCluster:
        seeker.abuseCluster !== null &&
        candidate.abuseCluster !== null &&
        seeker.abuseCluster === candidate.abuseCluster,
      matchedBefore: matchedAt !== null,
      recentlyLeft: leftAt !== null && Date.now() - leftAt <= config.matching.recentlyLeftWindowMs,
    };
  }
}
