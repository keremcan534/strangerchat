import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetTracker } from '../src/cost/budget.js';
import { TranslationService } from '../src/translation/service.js';
import { TranslationProviderError, type ProviderTranslation, type TranslationProvider } from '../src/translation/providers/provider.js';
import { NullDatabase } from '../src/store/db.js';
import { MemoryStore } from '../src/store/kv.js';
import { config } from '../src/config/index.js';

class FakeProvider implements TranslationProvider {
  readonly name = 'fake';
  readonly configured = true;
  calls = 0;
  failures = 0;
  constructor(private readonly behaviour: 'ok' | 'fail' | 'fail-once' | 'fatal' = 'ok') {}

  async translate(text: string, target: string): Promise<ProviderTranslation> {
    this.calls += 1;
    if (this.behaviour === 'fatal') {
      throw new TranslationProviderError('bad request', 400, false);
    }
    if (this.behaviour === 'fail' || (this.behaviour === 'fail-once' && this.calls === 1)) {
      this.failures += 1;
      throw new TranslationProviderError('upstream exploded');
    }
    return { text: `${target}:${text}`, detectedSourceLanguage: 'tr' };
  }

  async detect(): Promise<string | null> {
    return 'tr';
  }
}

function makeService(provider: TranslationProvider) {
  const kv = new MemoryStore();
  const budget = new BudgetTracker(kv, new NullDatabase());
  return { service: new TranslationService(kv, budget, provider), budget, kv };
}

describe('TranslationService', () => {
  it('translates and reports the character count billed', async () => {
    const provider = new FakeProvider();
    const { service } = makeService(provider);

    const outcome = await service.translate('Bugün nasılsın?', 'en', 'tr');
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.text).toBe('en:Bugün nasılsın?');
    expect(outcome.result?.charactersBilled).toBe('Bugün nasılsın?'.length);
  });

  // §12
  it('serves a repeated short string from cache without calling the provider', async () => {
    const provider = new FakeProvider();
    const { service } = makeService(provider);

    await service.translate('Hello', 'tr', 'en');
    const second = await service.translate('Hello', 'tr', 'en');

    expect(provider.calls).toBe(1);
    expect(second.result?.cached).toBe(true);
    expect(second.result?.charactersBilled).toBe(0);
  });

  it('is case- and whitespace-insensitive when caching', async () => {
    const provider = new FakeProvider();
    const { service } = makeService(provider);

    await service.translate('hello', 'tr', 'en');
    await service.translate('  HELLO  ', 'tr', 'en');
    expect(provider.calls).toBe(1);
  });

  it('does not cache long messages', async () => {
    const provider = new FakeProvider();
    const { service } = makeService(provider);
    const long = 'a'.repeat(config.translation.cacheMaxChars + 1);

    await service.translate(long, 'tr', 'en');
    await service.translate(long, 'tr', 'en');
    expect(provider.calls).toBe(2);
  });

  it('skips translation when both sides share a language', async () => {
    const provider = new FakeProvider();
    const { service } = makeService(provider);

    const outcome = await service.translate('merhaba', 'tr', 'tr');
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('same-language');
    expect(provider.calls).toBe(0);
  });

  // §15
  it('retries once and then degrades instead of breaking the chat', async () => {
    const provider = new FakeProvider('fail');
    const { service } = makeService(provider);

    const outcome = await service.translate('merhaba', 'en', 'tr');
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('provider-error');
    expect(provider.calls).toBe(config.translation.retryAttempts + 1);
  });

  it('recovers when the retry succeeds', async () => {
    const provider = new FakeProvider('fail-once');
    const { service } = makeService(provider);

    const outcome = await service.translate('merhaba', 'en', 'tr');
    expect(outcome.ok).toBe(true);
    expect(provider.calls).toBe(2);
  });

  it('does not retry a request the provider rejected as invalid', async () => {
    const provider = new FakeProvider('fatal');
    const { service } = makeService(provider);

    await service.translate('merhaba', 'en', 'tr');
    expect(provider.calls).toBe(1);
  });

  it('stops calling the provider for a short window after a failure', async () => {
    const provider = new FakeProvider('fail');
    const { service } = makeService(provider);

    await service.translate('merhaba', 'en', 'tr');
    const callsAfterFirst = provider.calls;
    await service.translate('nasılsın', 'en', 'tr');

    expect(provider.calls).toBe(callsAfterFirst);
    expect(service.available).toBe(false);
  });

  // §13
  it('refuses to translate once the daily character budget is spent', async () => {
    const provider = new FakeProvider();
    const { service, budget } = makeService(provider);

    await budget.recordTranslation(config.translation.dailyCharacterLimit);
    const outcome = await service.translate('merhaba', 'en', 'tr');

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('budget-exhausted');
    expect(provider.calls).toBe(0);
  });

  it('reports a warning state before the budget is exhausted', async () => {
    const { budget } = makeService(new FakeProvider());
    const limit = config.translation.dailyCharacterLimit;

    await budget.recordTranslation(Math.floor(limit * config.translation.warnRatio));
    expect((await budget.translationStatus()).state).toBe('warning');

    await budget.recordTranslation(limit);
    expect((await budget.translationStatus()).state).toBe('exhausted');
  });

  it('keeps translation and AI spend on separate lines of the dashboard (§35)', async () => {
    const { budget } = makeService(new FakeProvider());
    await budget.recordTranslation(1_000_000);
    await budget.recordBotMessage(1_000, 500, 0.25);

    const dashboard = (await budget.dashboard()) as {
      translation: { costUsd: number };
      ai: { costUsd: number; messages: number };
      totalCostUsd: number;
    };

    expect(dashboard.translation.costUsd).toBeCloseTo(config.translation.costPerMillionChars, 4);
    expect(dashboard.ai.costUsd).toBeCloseTo(0.25, 4);
    expect(dashboard.ai.messages).toBe(1);
    expect(dashboard.totalCostUsd).toBeCloseTo(config.translation.costPerMillionChars + 0.25, 4);
  });
});
