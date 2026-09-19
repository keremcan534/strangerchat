import { beforeEach, describe, expect, it } from 'vitest';
import { MatchEngine } from '../src/matching/engine.js';
import { RelationshipService } from '../src/safety/relationships.js';
import { LanguageStats } from '../src/stats/language-stats.js';
import { NullDatabase } from '../src/store/db.js';
import { MemoryStore } from '../src/store/kv.js';
import { config } from '../src/config/index.js';
import type { WaitingEntry } from '../src/types.js';

const T0 = 1_000_000;

function makeEngine() {
  const kv = new MemoryStore();
  const db = new NullDatabase();
  const stats = new LanguageStats(db);
  const relationships = new RelationshipService(kv, db);
  return { engine: new MatchEngine(relationships, stats), stats, relationships, kv };
}

function entry(id: string, language: string, interests: string[], enqueuedAt = T0): WaitingEntry {
  return {
    sessionId: id,
    anonymousUserId: `anon_${id}`,
    language,
    interests,
    enqueuedAt,
    abuseCluster: null,
    botOfferDeclined: false,
  };
}

describe('MatchEngine escalation ladder (§7)', () => {
  let ctx: ReturnType<typeof makeEngine>;

  beforeEach(() => {
    ctx = makeEngine();
  });

  it('pairs same-language users with a shared interest immediately', async () => {
    ctx.engine.enqueue(entry('a', 'tr', ['gaming', 'music']));
    ctx.engine.enqueue(entry('b', 'tr', ['gaming']));

    const matches = await ctx.engine.tick(T0 + 100);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.tier).toBe('same-language-interest');
    expect(matches[0]!.translationRequired).toBe(false);
    expect(ctx.engine.size).toBe(0);
  });

  it('holds back a same-language pair with no shared interest until tier 2', async () => {
    ctx.engine.enqueue(entry('a', 'tr', ['gaming']));
    ctx.engine.enqueue(entry('b', 'tr', ['books']));

    expect(await ctx.engine.tick(T0 + 1_000)).toHaveLength(0);

    const matches = await ctx.engine.tick(T0 + config.matching.sameLanguageInterestMs + 1);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.tier).toBe('same-language');
  });

  it('only crosses languages once both users have reached tier 3', async () => {
    ctx.engine.enqueue(entry('a', 'tr', ['gaming']));
    ctx.engine.enqueue(entry('b', 'en', ['gaming']));

    // A shared interest is not enough: different languages need the top tier.
    expect(await ctx.engine.tick(T0 + 1_000)).toHaveLength(0);
    expect(await ctx.engine.tick(T0 + config.matching.sameLanguageInterestMs + 1)).toHaveLength(0);

    const matches = await ctx.engine.tick(T0 + config.matching.sameLanguageAnyMs + 1);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.tier).toBe('cross-language');
    expect(matches[0]!.translationRequired).toBe(true);
  });

  it('does not steal a newcomer from their own same-language window', async () => {
    // A has waited long enough to cross languages; B has just arrived.
    ctx.engine.enqueue(entry('a', 'tr', [], T0 - 60_000));
    ctx.engine.enqueue(entry('b', 'en', [], T0));

    expect(await ctx.engine.tick(T0 + 100)).toHaveLength(0);
  });

  it('prefers the highest scoring candidate', async () => {
    const late = config.matching.sameLanguageAnyMs + 1;
    ctx.engine.enqueue(entry('seeker', 'tr', ['gaming', 'music']));
    ctx.engine.enqueue(entry('weak', 'en', ['gaming', 'music']));
    ctx.engine.enqueue(entry('strong', 'tr', ['gaming', 'music']));

    const matches = await ctx.engine.tick(T0 + late);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.b.sessionId).toBe('strong');
  });

  it('never pairs a blocked couple', async () => {
    await ctx.relationships.block('anon_a', 'anon_b');
    ctx.engine.enqueue(entry('a', 'tr', ['gaming']));
    ctx.engine.enqueue(entry('b', 'tr', ['gaming']));

    expect(await ctx.engine.tick(T0 + 60_000)).toHaveLength(0);
  });

  it('never pairs two sessions from the same abuse cluster', async () => {
    const a = { ...entry('a', 'tr', ['gaming']), abuseCluster: 'net-1' };
    const b = { ...entry('b', 'tr', ['gaming']), abuseCluster: 'net-1' };
    ctx.engine.enqueue(a);
    ctx.engine.enqueue(b);

    expect(await ctx.engine.tick(T0 + 60_000)).toHaveLength(0);
  });

  it('never pairs a session with itself across two tabs', async () => {
    const a = entry('tab1', 'tr', ['gaming']);
    const b = { ...entry('tab2', 'tr', ['gaming']), anonymousUserId: a.anonymousUserId };
    ctx.engine.enqueue(a);
    ctx.engine.enqueue(b);

    expect(await ctx.engine.tick(T0 + 60_000)).toHaveLength(0);
  });

  it('records the pairing so the next match loses the never-matched bonus', async () => {
    ctx.engine.enqueue(entry('a', 'tr', ['gaming']));
    ctx.engine.enqueue(entry('b', 'tr', ['gaming']));
    await ctx.engine.tick(T0 + 100);

    const context = await ctx.relationships.context(
      entry('a', 'tr', ['gaming']),
      entry('b', 'tr', ['gaming']),
    );
    expect(context.matchedBefore).toBe(true);
  });
});

describe('MatchEngine availability (§42)', () => {
  it('reports the bot offer as due only after the cross-language window', () => {
    const { engine } = makeEngine();
    engine.enqueue(entry('a', 'tr', []));

    expect(engine.availability(T0 + 1_000)[0]!.botOfferDue).toBe(false);
    // Pressure is high for an otherwise empty language, which shortens the wait.
    expect(engine.availability(T0 + config.matching.crossLanguageMs)[0]!.botOfferDue).toBe(true);
  });

  it('exposes the tier level so the UI can explain the wait', () => {
    const { engine } = makeEngine();
    engine.enqueue(entry('a', 'tr', []));

    expect(engine.availability(T0)[0]!.level).toBe(1);
    expect(engine.availability(T0 + config.matching.sameLanguageInterestMs + 1)[0]!.level).toBe(2);
    expect(engine.availability(T0 + config.matching.sameLanguageAnyMs + 1)[0]!.level).toBe(3);
  });

  it('keeps the queue accounting straight', () => {
    const { engine, stats } = makeEngine();
    engine.enqueue(entry('a', 'tr', []));
    engine.enqueue(entry('b', 'tr', []));
    expect(stats.waitingIn('tr')).toBe(2);

    engine.dequeue('a');
    expect(stats.waitingIn('tr')).toBe(1);
    expect(engine.size).toBe(1);
  });
});

describe('MatchEngine waiting index', () => {
  it('groups waiting anonymous ids by language', () => {
    const { engine } = makeEngine();
    engine.enqueue(entry('a', 'tr', []));
    engine.enqueue(entry('b', 'tr', []));
    engine.enqueue(entry('c', 'en', []));

    const index = engine.waitingByLanguage();
    expect(index.get('tr')).toEqual(new Set(['anon_a', 'anon_b']));
    expect(index.get('en')).toEqual(new Set(['anon_c']));
    expect(index.has('de')).toBe(false);
  });

  it('collapses two tabs of one user into a single id', () => {
    const { engine } = makeEngine();
    const a = entry('tab1', 'tr', []);
    engine.enqueue(a);
    engine.enqueue({ ...entry('tab2', 'tr', []), anonymousUserId: a.anonymousUserId });

    expect(engine.waitingByLanguage().get('tr')!.size).toBe(1);
  });

  it('drops a language once its queue empties', () => {
    const { engine } = makeEngine();
    engine.enqueue(entry('a', 'tr', []));
    engine.dequeue('a');
    expect(engine.waitingByLanguage().has('tr')).toBe(false);
  });
});
