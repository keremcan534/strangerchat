/**
 * Abuse clustering for the -9999 term in §5.
 *
 * The rule is "never match two people from the same abuse cluster", and the
 * important word is *abuse*. A shared network prefix on its own is not one:
 * campuses, mobile carriers and whole countries sit behind a handful of
 * prefixes, and treating those as clusters would quietly make the platform
 * unusable for the people on them.
 *
 * So a network becomes a cluster only once it has actually produced reports or
 * blocks, and it stops being one when those age out. Until then sessions carry
 * a null cluster and the penalty never fires. (Two tabs from one browser are
 * already handled separately, by the anonymous-id check in the engine.)
 */
import { createHash } from 'node:crypto';

export interface AbuseClusterOptions {
  /** Reports from one network before it counts as a cluster. */
  threshold?: number;
  /** How long reports stay on the record. */
  windowMs?: number;
}

interface NetworkRecord {
  count: number;
  updatedAt: number;
}

export class AbuseClusterRegistry {
  private readonly networks = new Map<string, NetworkRecord>();
  private readonly threshold: number;
  private readonly windowMs: number;

  constructor({ threshold = 3, windowMs = 60 * 60_000 }: AbuseClusterOptions = {}) {
    this.threshold = threshold;
    this.windowMs = windowMs;
  }

  /**
   * Reduces an address to a coarse, hashed network key. IPv4 is truncated to
   * /24 and IPv6 to /48; the raw address is never stored.
   */
  static networkKey(address: string | null | undefined): string | null {
    if (!address) return null;
    let prefix = address;
    if (address.includes('.')) prefix = address.split('.').slice(0, 3).join('.');
    else if (address.includes(':')) prefix = address.split(':').slice(0, 3).join(':');
    return createHash('sha256').update(prefix).digest('base64url').slice(0, 16);
  }

  /** Called when a session from this network is reported or blocked. */
  flag(networkKey: string | null): void {
    if (!networkKey) return;
    const existing = this.live(networkKey);
    this.networks.set(networkKey, {
      count: (existing?.count ?? 0) + 1,
      updatedAt: Date.now(),
    });
  }

  private live(networkKey: string): NetworkRecord | undefined {
    const record = this.networks.get(networkKey);
    if (!record) return undefined;
    if (Date.now() - record.updatedAt > this.windowMs) {
      this.networks.delete(networkKey);
      return undefined;
    }
    return record;
  }

  /** The cluster id for a network, or null when it is not a cluster (yet). */
  clusterFor(networkKey: string | null): string | null {
    if (!networkKey) return null;
    const record = this.live(networkKey);
    return record && record.count >= this.threshold ? networkKey : null;
  }

  isFlagged(networkKey: string | null): boolean {
    return this.clusterFor(networkKey) !== null;
  }

  get size(): number {
    return this.networks.size;
  }
}
