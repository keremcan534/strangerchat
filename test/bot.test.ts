import { describe, expect, it } from 'vitest';
import { BotManager, shouldOfferBot } from '../src/bot/manager.js';
import { identityAnswer, isIdentityQuestion, violatesIdentityRule } from '../src/bot/identity.js';
import { getPersonality, pickPersonality } from '../src/bot/personalities.js';
import type { AiProvider, BotCompletionOptions, BotReply } from '../src/bot/providers/provider.js';
import { BudgetTracker } from '../src/cost/budget.js';
import { NullDatabase } from '../src/store/db.js';
import { MemoryStore } from '../src/store/kv.js';
import { config } from '../src/config/index.js';

class StubProvider implements AiProvider {
  readonly name = 'stub';
  readonly configured = true;
  lastOptions: BotCompletionOptions | null = null;
  constructor(private readonly reply = 'Sure, tell me more.') {}

  costOf(inputTokens: number, outputTokens: number): number {
    return (inputTokens + outputTokens) / 1_000_000;
  }

  async complete(options: BotCompletionOptions): Promise<BotReply> {
    this.lastOptions = options;
    return { text: this.reply, inputTokens: 100, outputTokens: 40 };
  }
}

function makeManager(provider: AiProvider = new StubProvider()) {
  const kv = new MemoryStore();
  const db = new NullDatabase();
  const budget = new BudgetTracker(kv, db);
  return { manager: new BotManager(budget, db, kv, provider), budget };
}

describe('bot identity rules (§20)', () => {
  it('recognises direct identity questions in several languages', () => {
    for (const question of [
      'are you human?',
      'Are you a real person',
      'r u a bot',
      'gerçek bir insan mısın?',
      'bot musun',
      'bist du ein Mensch?',
      '¿eres humano?',
      '人間ですか',
      '사람이에요?',
    ]) {
      expect(isIdentityQuestion(question), question).toBe(true);
    }
  });

  it('does not fire on ordinary conversation', () => {
    for (const line of [
      'what do you do for fun?',
      'I am human after all, we all make mistakes',
      'bugün hava çok güzel',
    ]) {
      expect(isIdentityQuestion(line), line).toBe(false);
    }
  });

  it('answers in the user language without calling the model', async () => {
    const provider = new StubProvider();
    const { manager } = makeManager(provider);
    const session = await manager.start({
      sessionId: 's1',
      anonymousUserId: 'anon_1',
      language: 'tr',
      interests: [],
    });

    const reply = await manager.reply(session.id, 'gerçek bir insan mısın?');
    expect(reply?.guarded).toBe(true);
    expect(reply?.text).toBe(identityAnswer('tr'));
    expect(provider.lastOptions).toBeNull();
  });

  it('replaces a model reply that claims to be human', async () => {
    const { manager } = makeManager(new StubProvider('I am a real human, promise.'));
    const session = await manager.start({
      sessionId: 's2',
      anonymousUserId: 'anon_2',
      language: 'en',
      interests: [],
    });

    const reply = await manager.reply(session.id, 'what did you do today?');
    expect(violatesIdentityRule('I am a real human, promise.')).toBe(true);
    expect(reply?.text).toBe(identityAnswer('en'));
    expect(reply?.guarded).toBe(true);
  });
});

describe('bot language and context (§19, §22)', () => {
  it('instructs the model to answer in the user language', async () => {
    const provider = new StubProvider();
    const { manager } = makeManager(provider);
    const session = await manager.start({
      sessionId: 's3',
      anonymousUserId: 'anon_3',
      language: 'ja',
      interests: ['gaming', 'movies'],
    });

    await manager.reply(session.id, 'hello');
    const system = provider.lastOptions!.system;
    expect(system).toContain('Language: ja');
    expect(system).toContain('Japanese');
    expect(system).toContain('gaming, movies');
    expect(system).toMatch(/never claim/i);
  });

  it('uses General Conversation for the MVP', () => {
    expect(pickPersonality(['gaming']).id).toBe('general');
    expect(pickPersonality(['gaming'], false).id).toBe('gamer');
    expect(getPersonality('nope').id).toBe('general');
  });
});

describe('bot budget and limits (§25, §34)', () => {
  it('records spend per reply', async () => {
    const { manager, budget } = makeManager();
    const session = await manager.start({
      sessionId: 's4',
      anonymousUserId: 'anon_4',
      language: 'en',
      interests: [],
    });

    await manager.reply(session.id, 'hi there');
    const status = await budget.botStatus();
    expect(status.messages).toBe(1);
    expect(status.costUsd).toBeGreaterThan(0);
  });

  it('degrades gracefully instead of failing when the budget is gone', async () => {
    const { manager, budget } = makeManager();
    const session = await manager.start({
      sessionId: 's5',
      anonymousUserId: 'anon_5',
      language: 'en',
      interests: [],
    });

    await budget.recordBotMessage(0, 0, config.bot.dailyCostLimitUsd);
    const reply = await manager.reply(session.id, 'still there?');

    expect(reply?.degraded).toBe(true);
    expect(reply?.text).toBeTruthy();
  });

  it('puts a session on cooldown once it ends', async () => {
    const { manager } = makeManager();
    const session = await manager.start({
      sessionId: 's6',
      anonymousUserId: 'anon_6',
      language: 'en',
      interests: [],
    });

    await manager.end(session.id);
    const availability = await manager.canStart('s6');
    expect(availability.allowed).toBe(false);
    expect(availability.reason).toBe('cooldown');
    expect(availability.retryAfterMs).toBeGreaterThan(0);
  });

  it('survives a provider failure without throwing', async () => {
    const failing: AiProvider = {
      name: 'broken',
      configured: true,
      costOf: () => 0,
      complete: async () => {
        throw new Error('model unavailable');
      },
    };
    const { manager } = makeManager(failing);
    const session = await manager.start({
      sessionId: 's7',
      anonymousUserId: 'anon_7',
      language: 'tr',
      interests: [],
    });

    const reply = await manager.reply(session.id, 'merhaba');
    expect(reply?.degraded).toBe(true);
  });
});

describe('bot offer policy (§28, §43)', () => {
  const base = { mode: 'launch' as const, botOfferDue: true, pressure: 'high' as const, declined: false, botEnabled: true };

  it('offers once the wait threshold is crossed', () => {
    expect(shouldOfferBot(base)).toBe(true);
  });

  it('does not offer before the threshold', () => {
    expect(shouldOfferBot({ ...base, botOfferDue: false })).toBe(false);
  });

  it('respects a user who chose to keep waiting', () => {
    expect(shouldOfferBot({ ...base, declined: true })).toBe(false);
  });

  it('never offers automatically in mature mode', () => {
    expect(shouldOfferBot({ ...base, mode: 'mature' })).toBe(false);
  });

  it('never offers when the bot is switched off', () => {
    expect(shouldOfferBot({ ...base, botEnabled: false })).toBe(false);
  });
});
