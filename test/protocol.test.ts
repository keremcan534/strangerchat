import { describe, expect, it } from 'vitest';
import { parseClientMessage } from '../src/chat/protocol.js';
import { normaliseInterests, normaliseLanguage } from '../src/config/languages.js';

const MAX = 2000;

describe('normaliseLanguage', () => {
  it('accepts supported codes regardless of case or region', () => {
    expect(normaliseLanguage('TR')).toBe('tr');
    expect(normaliseLanguage('en-GB')).toBe('en');
    expect(normaliseLanguage('zh_Hans')).toBe('zh');
  });

  it('rejects unsupported or empty input', () => {
    expect(normaliseLanguage('klingon')).toBeUndefined();
    expect(normaliseLanguage('')).toBeUndefined();
    expect(normaliseLanguage(null)).toBeUndefined();
  });
});

describe('normaliseInterests', () => {
  it('keeps only known interests, de-duplicated and capped', () => {
    expect(normaliseInterests(['Gaming', 'gaming', 'music', 'nonsense'])).toEqual([
      'gaming',
      'music',
    ]);
    expect(
      normaliseInterests(['gaming', 'music', 'movies', 'technology', 'sports', 'travel']),
    ).toHaveLength(5);
  });

  it('tolerates junk input', () => {
    expect(normaliseInterests('gaming')).toEqual([]);
    expect(normaliseInterests([1, null, {}])).toEqual([]);
  });
});

describe('parseClientMessage', () => {
  it('rejects malformed payloads', () => {
    expect(parseClientMessage('not json', MAX).ok).toBe(false);
    expect(parseClientMessage('[]', MAX).ok).toBe(false);
    expect(parseClientMessage('{"noType":1}', MAX).ok).toBe(false);
    expect(parseClientMessage('{"type":"nope"}', MAX).ok).toBe(false);
  });

  it('requires a supported language on hello', () => {
    expect(parseClientMessage('{"type":"hello","language":"klingon"}', MAX).ok).toBe(false);
    const parsed = parseClientMessage('{"type":"hello","language":"tr","interests":["gaming"]}', MAX);
    expect(parsed.ok).toBe(true);
    expect(parsed.message).toMatchObject({ type: 'hello', language: 'tr', interests: ['gaming'] });
  });

  it('only accepts a well-formed anonymous id', () => {
    const good = parseClientMessage('{"type":"hello","language":"tr","anonymousUserId":"anon_1234"}', MAX);
    expect(good.message).toHaveProperty('anonymousUserId', 'anon_1234');

    const bad = parseClientMessage('{"type":"hello","language":"tr","anonymousUserId":"../../etc"}', MAX);
    expect(bad.message).not.toHaveProperty('anonymousUserId');
  });

  it('rejects empty and oversized messages', () => {
    expect(parseClientMessage('{"type":"message","text":"   "}', MAX).ok).toBe(false);
    const long = JSON.stringify({ type: 'message', text: 'a'.repeat(MAX + 1) });
    expect(parseClientMessage(long, MAX).ok).toBe(false);
  });

  it('trims message text', () => {
    const parsed = parseClientMessage('{"type":"message","text":"  hi  "}', MAX);
    expect(parsed.message).toMatchObject({ type: 'message', text: 'hi' });
  });

  it('refuses payloads far larger than the message cap', () => {
    expect(parseClientMessage('x'.repeat(MAX + 2000), MAX).ok).toBe(false);
  });

  it('parses the simple command messages', () => {
    for (const type of ['cancel', 'skip', 'leave', 'accept-bot', 'decline-bot', 'accept-human', 'ping']) {
      expect(parseClientMessage(JSON.stringify({ type }), MAX).message).toEqual({ type });
    }
  });

  it('coerces typing to a boolean', () => {
    expect(parseClientMessage('{"type":"typing","active":"yes"}', MAX).message).toEqual({
      type: 'typing',
      active: false,
    });
  });
});
