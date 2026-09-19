import { describe, expect, it } from 'vitest';
import { AbuseClusterRegistry } from '../src/safety/abuse-clusters.js';
import { RelationshipService } from '../src/safety/relationships.js';
import { NullDatabase } from '../src/store/db.js';
import { MemoryStore } from '../src/store/kv.js';
import { config } from '../src/config/index.js';
import { parseClientMessage } from '../src/chat/protocol.js';
import type { WaitingEntry } from '../src/types.js';

describe('AbuseClusterRegistry (§5)', () => {
  it('reduces addresses to a coarse, hashed prefix', () => {
    const a = AbuseClusterRegistry.networkKey('203.0.113.7');
    const b = AbuseClusterRegistry.networkKey('203.0.113.250');
    const c = AbuseClusterRegistry.networkKey('198.51.100.7');

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    // The raw address must not survive into the key.
    expect(a).not.toContain('203');
    expect(AbuseClusterRegistry.networkKey(null)).toBeNull();
  });

  it('groups IPv6 addresses by /48', () => {
    expect(AbuseClusterRegistry.networkKey('2001:db8:1234:5678::1')).toBe(
      AbuseClusterRegistry.networkKey('2001:db8:1234:abcd::9'),
    );
  });

  // The bug this class exists to prevent: everyone behind one NAT — a campus,
  // a carrier, or localhost in development — being unable to match at all.
  it('does not treat a merely shared network as a cluster', () => {
    const registry = new AbuseClusterRegistry();
    const key = AbuseClusterRegistry.networkKey('203.0.113.7');

    expect(registry.clusterFor(key)).toBeNull();
    registry.flag(key);
    expect(registry.clusterFor(key)).toBeNull();
  });

  it('becomes a cluster once the network attracts enough reports', () => {
    const registry = new AbuseClusterRegistry({ threshold: 3 });
    const key = AbuseClusterRegistry.networkKey('203.0.113.7');

    registry.flag(key);
    registry.flag(key);
    expect(registry.isFlagged(key)).toBe(false);
    registry.flag(key);
    expect(registry.isFlagged(key)).toBe(true);
    expect(registry.clusterFor(key)).toBe(key);
  });

  it('lets a flagged network age out', () => {
    const registry = new AbuseClusterRegistry({ threshold: 1, windowMs: -1 });
    const key = AbuseClusterRegistry.networkKey('203.0.113.7');

    registry.flag(key);
    expect(registry.isFlagged(key)).toBe(false);
  });

  it('ignores a missing network key', () => {
    const registry = new AbuseClusterRegistry({ threshold: 1 });
    registry.flag(null);
    expect(registry.clusterFor(null)).toBeNull();
    expect(registry.size).toBe(0);
  });
});

describe('RelationshipService', () => {
  function make() {
    return new RelationshipService(new MemoryStore(), new NullDatabase());
  }

  function entry(id: string): WaitingEntry {
    return {
      sessionId: id,
      anonymousUserId: `anon_${id}`,
      language: 'tr',
      interests: [],
      enqueuedAt: 0,
      abuseCluster: null,
      botOfferDeclined: false,
    };
  }

  it('treats blocks as symmetric', async () => {
    const service = make();
    await service.block('anon_a', 'anon_b');

    expect(await service.isBlocked('anon_a', 'anon_b')).toBe(true);
    expect(await service.isBlocked('anon_b', 'anon_a')).toBe(true);
    expect(await service.isBlocked('anon_a', 'anon_c')).toBe(false);
  });

  it('remembers a pairing in both directions', async () => {
    const service = make();
    await service.recordMatch('anon_a', 'anon_b');

    expect((await service.context(entry('a'), entry('b'))).matchedBefore).toBe(true);
    expect((await service.context(entry('b'), entry('a'))).matchedBefore).toBe(true);
  });

  it('marks a recent departure inside the window', async () => {
    const service = make();
    await service.recordDeparture('anon_a', 'anon_b');
    expect((await service.context(entry('a'), entry('b'))).recentlyLeft).toBe(true);
  });

  it('only calls two sessions the same cluster when both carry one', async () => {
    const service = make();
    const a = { ...entry('a'), abuseCluster: null };
    const b = { ...entry('b'), abuseCluster: null };
    expect((await service.context(a, b)).sameAbuseCluster).toBe(false);

    const flaggedA = { ...entry('a'), abuseCluster: 'net-1' };
    const flaggedB = { ...entry('b'), abuseCluster: 'net-1' };
    expect((await service.context(flaggedA, flaggedB)).sameAbuseCluster).toBe(true);

    const other = { ...entry('b'), abuseCluster: 'net-2' };
    expect((await service.context(flaggedA, other)).sameAbuseCluster).toBe(false);
  });
});

describe('start message handling', () => {
  // A bare {"type":"start"} used to wipe the interests set during `hello`,
  // silently downgrading every such user to interest-free matching.
  it('leaves interests untouched when the client does not send them', () => {
    const parsed = parseClientMessage('{"type":"start"}', config.chat.maxMessageLength);
    expect(parsed.ok).toBe(true);
    expect(parsed.message).not.toHaveProperty('interests');
  });

  it('replaces interests when the client does send them', () => {
    const parsed = parseClientMessage(
      '{"type":"start","interests":["gaming"]}',
      config.chat.maxMessageLength,
    );
    expect(parsed.message).toHaveProperty('interests', ['gaming']);
  });

  it('treats an explicitly empty list as clearing them', () => {
    const parsed = parseClientMessage('{"type":"start","interests":[]}', config.chat.maxMessageLength);
    expect(parsed.message).toHaveProperty('interests', []);
  });
});
