/**
 * Small key/value + counter abstraction.
 *
 * Redis is the production backend (§44), but the whole platform has to boot and
 * be testable without it, so an in-process implementation with the same
 * semantics ships alongside. Only the operations the app actually needs are
 * modelled: expiring get/set, atomic counters and sorted "recent" sets.
 */

export interface KeyValueStore {
  readonly name: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Atomically adds `by` and returns the new value. */
  incrBy(key: string, by: number, ttlSeconds?: number): Promise<number>;
  incrByFloat(key: string, by: number, ttlSeconds?: number): Promise<number>;
  /** Adds a member with `now` as score; used for "did these two meet before". */
  markPair(key: string, member: string, ttlSeconds: number): Promise<void>;
  /** Returns the timestamp the pair was marked at, or null. */
  pairMarkedAt(key: string, member: string): Promise<number | null>;
  close(): Promise<void>;
}

interface Entry {
  value: string;
  expiresAt: number | null;
}

export class MemoryStore implements KeyValueStore {
  readonly name = 'memory';
  private readonly data = new Map<string, Entry>();
  private readonly pairs = new Map<string, Map<string, Entry>>();

  private live(entry: Entry | undefined): Entry | undefined {
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) return undefined;
    return entry;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.live(this.data.get(key));
    if (!entry) {
      this.data.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.data.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
  }

  async del(key: string): Promise<void> {
    this.data.delete(key);
  }

  private bump(key: string, by: number, ttlSeconds: number | undefined, float: boolean): number {
    const existing = this.live(this.data.get(key));
    const current = existing ? Number.parseFloat(existing.value) : 0;
    const next = (Number.isFinite(current) ? current : 0) + by;
    const value = float ? String(next) : String(Math.round(next));
    this.data.set(key, {
      value,
      expiresAt: existing?.expiresAt ?? (ttlSeconds ? Date.now() + ttlSeconds * 1000 : null),
    });
    return Number.parseFloat(value);
  }

  async incrBy(key: string, by: number, ttlSeconds?: number): Promise<number> {
    return this.bump(key, by, ttlSeconds, false);
  }

  async incrByFloat(key: string, by: number, ttlSeconds?: number): Promise<number> {
    return this.bump(key, by, ttlSeconds, true);
  }

  async markPair(key: string, member: string, ttlSeconds: number): Promise<void> {
    let bucket = this.pairs.get(key);
    if (!bucket) {
      bucket = new Map();
      this.pairs.set(key, bucket);
    }
    bucket.set(member, { value: String(Date.now()), expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async pairMarkedAt(key: string, member: string): Promise<number | null> {
    const entry = this.live(this.pairs.get(key)?.get(member));
    return entry ? Number.parseInt(entry.value, 10) : null;
  }

  async close(): Promise<void> {
    this.data.clear();
    this.pairs.clear();
  }
}

/** Minimal surface of ioredis that this store uses, so the import stays lazy. */
interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, ttl?: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  incrby(key: string, by: number): Promise<number>;
  incrbyfloat(key: string, by: number): Promise<string>;
  expire(key: string, ttl: number): Promise<unknown>;
  ttl(key: string): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zscore(key: string, member: string): Promise<string | null>;
  quit(): Promise<unknown>;
}

export class RedisStore implements KeyValueStore {
  readonly name = 'redis';
  constructor(private readonly redis: RedisLike) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) await this.redis.set(key, value, 'EX', ttlSeconds);
    else await this.redis.set(key, value);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  /** Applies the TTL only on creation so a daily counter keeps its window. */
  private async applyTtl(key: string, ttlSeconds: number | undefined): Promise<void> {
    if (!ttlSeconds) return;
    const ttl = await this.redis.ttl(key);
    if (ttl < 0) await this.redis.expire(key, ttlSeconds);
  }

  async incrBy(key: string, by: number, ttlSeconds?: number): Promise<number> {
    const next = await this.redis.incrby(key, by);
    await this.applyTtl(key, ttlSeconds);
    return next;
  }

  async incrByFloat(key: string, by: number, ttlSeconds?: number): Promise<number> {
    const next = await this.redis.incrbyfloat(key, by);
    await this.applyTtl(key, ttlSeconds);
    return Number.parseFloat(next);
  }

  async markPair(key: string, member: string, ttlSeconds: number): Promise<void> {
    await this.redis.zadd(key, Date.now(), member);
    await this.redis.expire(key, ttlSeconds);
  }

  async pairMarkedAt(key: string, member: string): Promise<number | null> {
    const score = await this.redis.zscore(key, member);
    return score === null ? null : Number.parseFloat(score);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

/**
 * Connects to Redis when REDIS_URL is set and reachable, otherwise falls back
 * to the in-process store. Never throws: a missing cache degrades the product
 * (cold translation cache, per-instance counters) but must not stop it booting.
 */
export async function createKeyValueStore(redisUrl: string | undefined): Promise<KeyValueStore> {
  if (!redisUrl) return new MemoryStore();
  try {
    const { Redis } = await import('ioredis');
    const client = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
    });
    client.on('error', () => {
      /* handled by the connect() rejection and by per-call fallbacks */
    });
    await client.connect();
    return new RedisStore(client as unknown as RedisLike);
  } catch {
    return new MemoryStore();
  }
}
