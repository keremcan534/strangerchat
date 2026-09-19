/**
 * End-to-end tests over a real HTTP + WebSocket server.
 *
 * The ladder timings are compressed so the full escalation — same language,
 * cross language with translation, AI offer — runs in under a second.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { identityAnswer } from '../src/bot/identity.js';

process.env.LOG_LEVEL = 'error';
process.env.MATCH_TICK_MS = '40';
process.env.MATCH_TIER1_MS = '150';
process.env.MATCH_TIER2_MS = '300';
process.env.MATCH_TIER3_MS = '800';
process.env.MATCH_DYNAMIC_THRESHOLDS = 'false';
process.env.TRANSLATION_PROVIDER = 'echo';
process.env.BOT_PROVIDER = 'scripted';
process.env.BOT_MIN_TYPING_MS = '0';
process.env.BOT_TYPING_MS_PER_CHAR = '0';
process.env.BOT_MAX_TYPING_MS = '0';
process.env.BOT_COOLDOWN_MS = '0';

const { createApp } = await import('../src/app.js');

type Msg = Record<string, any>;

/** Test client: buffers everything, lets a test await the next message of a type. */
class Client {
  private readonly socket: WebSocket;
  private readonly inbox: Msg[] = [];
  private readonly waiters: { type: string; resolve: (m: Msg) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Msg;
      const index = this.waiters.findIndex((w) => w.type === message.type);
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter!.timer);
        waiter!.resolve(message);
      } else {
        this.inbox.push(message);
      }
    });
  }

  static async connect(port: number): Promise<Client> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    return new Client(socket);
  }

  send(message: Msg): void {
    this.socket.send(JSON.stringify(message));
  }

  /** Resolves with the first buffered or future message of `type`. */
  next(type: string, timeoutMs = 4000): Promise<Msg> {
    const index = this.inbox.findIndex((m) => m.type === type);
    if (index >= 0) return Promise.resolve(this.inbox.splice(index, 1)[0]!);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`timed out waiting for "${type}"; saw: ${this.inbox.map((m) => m.type).join(', ')}`));
      }, timeoutMs);
      this.waiters.push({ type, resolve, reject, timer });
    });
  }

  received(type: string): boolean {
    return this.inbox.some((m) => m.type === type);
  }

  async hello(language: string, interests: string[] = []): Promise<Msg> {
    this.send({ type: 'hello', language, interests });
    return this.next('session');
  }

  close(): void {
    this.socket.close();
  }
}

let app: Awaited<ReturnType<typeof createApp>>;
let port: number;
const clients: Client[] = [];

async function client(language: string, interests: string[] = []): Promise<Client> {
  const c = await Client.connect(port);
  clients.push(c);
  await c.hello(language, interests);
  return c;
}

beforeAll(async () => {
  app = await createApp();
  port = await app.listen(0, '127.0.0.1');
});

afterAll(async () => {
  for (const c of clients) c.close();
  await app.close();
});

describe('HTTP surface', () => {
  it('serves the frontend shell', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>Talk to a Stranger</title>');
  });

  it('exposes the language and interest vocabulary', async () => {
    const body = (await (await fetch(`http://127.0.0.1:${port}/api/config`)).json()) as Msg;
    expect(body.languages.map((l: Msg) => l.code)).toContain('tr');
    expect(body.interests).toContain('gaming');
  });

  it('hides the admin dashboard when no token is configured', async () => {
    expect((await fetch(`http://127.0.0.1:${port}/api/admin/cost`)).status).toBe(404);
  });

  it('never serves files outside public/', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/../package.json`);
    expect(res.status).not.toBe(200);
  });
});

describe('same-language matching (§4)', () => {
  it('pairs two users who share a language and an interest, and relays messages', async () => {
    const a = await client('tr', ['gaming', 'music']);
    const b = await client('tr', ['gaming']);

    a.send({ type: 'start' });
    b.send({ type: 'start' });

    const [matchA, matchB] = await Promise.all([a.next('matched'), b.next('matched')]);
    expect(matchA.tier).toBe('same-language-interest');
    expect(matchA.partnerKind).toBe('human');
    expect(matchA.translation.enabled).toBe(false);
    expect(matchA.commonInterests).toContain('gaming');
    expect(matchB.roomId).toBe(matchA.roomId);

    a.send({ type: 'message', text: 'selam' });
    const delivered = await b.next('message');
    expect(delivered.from).toBe('partner');
    expect(delivered.kind).toBe('human');
    expect(delivered.text).toBe('selam');
    expect(delivered.translated).toBe(false);

    a.send({ type: 'leave' });
    const left = await b.next('partner-left');
    expect(left.reason).toBe('left');
  });
});

describe('cross-language matching with translation (§9, §10, §14)', () => {
  it('waits for the cross-language tier, then translates in both directions', async () => {
    const tr = await client('tr', ['movies']);
    const en = await client('en', ['movies']);

    tr.send({ type: 'start' });
    en.send({ type: 'start' });

    const [matchTr, matchEn] = await Promise.all([tr.next('matched'), en.next('matched')]);
    expect(matchTr.tier).toBe('cross-language');

    // §14 — each side is told who speaks what.
    expect(matchTr.translation).toMatchObject({
      enabled: true,
      yourLanguageName: 'Turkish',
      partnerLanguageName: 'English',
    });
    expect(matchEn.translation).toMatchObject({
      enabled: true,
      yourLanguageName: 'English',
      partnerLanguageName: 'Turkish',
    });

    tr.send({ type: 'message', text: 'Bugün nasılsın?' });

    // The sender always sees their own words untouched.
    const echo = await tr.next('message');
    expect(echo.from).toBe('you');
    expect(echo.text).toBe('Bugün nasılsın?');
    expect(echo.translated).toBe(false);

    // §10 — the partner gets the translation plus the original.
    const received = await en.next('message');
    expect(received.translated).toBe(true);
    expect(received.text).toBe('[en] Bugün nasılsın?');
    expect(received.originalText).toBe('Bugün nasılsın?');
    expect(received.targetLanguage).toBe('en');

    en.send({ type: 'message', text: "I'm doing great." });
    const back = await tr.next('message');
    expect(back.text).toBe("[tr] I'm doing great.");
    expect(back.originalText).toBe("I'm doing great.");

    tr.send({ type: 'leave' });
    await en.next('partner-left');
  });
});

describe('search escalation and the AI fallback (§28, §37)', () => {
  it('announces the escalation, offers the AI, and starts an AI chat on accept', async () => {
    const lonely = await client('fi', ['books']);
    lonely.send({ type: 'start' });
    await lonely.next('searching');

    const status = await lonely.next('search-status');
    expect(status.statusKey).toBe('still-looking-same-language');
    expect(status.language).toBe('fi');

    const offer = await lonely.next('bot-offer');
    expect(offer.reason).toBe('no-human-available');

    lonely.send({ type: 'accept-bot' });
    const matched = await lonely.next('bot-matched');
    expect(matched.language).toBe('fi');
    expect(matched.personality).toBe('general');

    // The bot opens the conversation itself.
    const greeting = await lonely.next('message');
    expect(greeting.kind).toBe('bot');
    expect(greeting.from).toBe('partner');
    expect(greeting.text).toBeTruthy();

    // §20 — the identity guard answers in the user's own language.
    lonely.send({ type: 'message', text: 'are you human?' });
    await lonely.next('message'); // the echo of what the user sent
    const answer = await lonely.next('message');
    expect(answer.kind).toBe('bot');
    expect(answer.text).toBe(identityAnswer('fi'));

    lonely.send({ type: 'leave' });
    await lonely.next('ended');
  });

  it('keeps searching when the user declines the AI', async () => {
    const waiting = await client('fa');
    waiting.send({ type: 'start' });
    await waiting.next('bot-offer');

    waiting.send({ type: 'decline-bot' });
    await new Promise((r) => setTimeout(r, 400));
    expect(waiting.received('bot-offer')).toBe(false);

    // Still in the pool: a compatible partner still matches.
    const partner = await client('fa');
    partner.send({ type: 'start' });
    const [matched] = await Promise.all([waiting.next('matched'), partner.next('matched')]);
    expect(matched.partnerKind).toBe('human');

    waiting.send({ type: 'leave' });
    await partner.next('partner-left');
  });
});

describe('bot to human handoff (§29)', () => {
  it('tells an AI chatter when a real person shows up and moves them over', async () => {
    const botUser = await client('uk');
    botUser.send({ type: 'start' });
    await botUser.next('bot-offer');
    botUser.send({ type: 'accept-bot' });
    await botUser.next('bot-matched');

    const human = await client('uk');
    human.send({ type: 'start' });

    const notice = await botUser.next('human-available');
    expect(notice.waitingIn).toBe('uk');

    botUser.send({ type: 'accept-human' });
    const [matchedBot, matchedHuman] = await Promise.all([
      botUser.next('matched'),
      human.next('matched'),
    ]);
    expect(matchedBot.partnerKind).toBe('human');
    expect(matchedHuman.roomId).toBe(matchedBot.roomId);

    human.send({ type: 'leave' });
    await botUser.next('partner-left');
  });
});

describe('skip and block', () => {
  it('requeues both sides on skip', async () => {
    const a = await client('ko');
    const b = await client('ko');
    a.send({ type: 'start' });
    b.send({ type: 'start' });
    await Promise.all([a.next('matched'), b.next('matched')]);

    a.send({ type: 'skip' });
    const [left, searching] = await Promise.all([b.next('partner-left'), a.next('searching')]);
    expect(left.reason).toBe('skipped');
    expect(searching.language).toBe('ko');

    a.send({ type: 'cancel' });
    await a.next('ended');
  });

  it('never re-pairs two users after a block', async () => {
    const a = await client('nl');
    const b = await client('nl');
    a.send({ type: 'start' });
    b.send({ type: 'start' });
    await Promise.all([a.next('matched'), b.next('matched')]);

    a.send({ type: 'block' });
    await a.next('searching');
    b.send({ type: 'start' });

    // Both are searching again; the only candidate for each is now blocked.
    await new Promise((r) => setTimeout(r, 700));
    expect(a.received('matched')).toBe(false);
    expect(b.received('matched')).toBe(false);

    a.send({ type: 'cancel' });
    b.send({ type: 'cancel' });
  });
});

describe('active-user accounting', () => {
  // A connection that says hello and then leaves without searching used to
  // leak an active user, because the gauge was released only for sessions that
  // had reached a non-idle state.
  it('releases the gauge for a connection that never searched', async () => {
    const before = app.stats.snapshot('sv').activeUsers;

    const c = await Client.connect(port);
    await c.hello('sv');
    expect(app.stats.snapshot('sv').activeUsers).toBe(before + 1);

    c.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(app.stats.snapshot('sv').activeUsers).toBe(before);
  });

  it('counts one connection once, however many times it says hello', async () => {
    const before = app.stats.snapshot('pl').activeUsers;

    const c = await Client.connect(port);
    await c.hello('pl');
    await c.hello('pl');
    await c.hello('pl');
    expect(app.stats.snapshot('pl').activeUsers).toBe(before + 1);

    c.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(app.stats.snapshot('pl').activeUsers).toBe(before);
  });

  it('moves the gauge when a connection changes language', async () => {
    const c = await Client.connect(port);
    await c.hello('it');
    expect(app.stats.snapshot('it').activeUsers).toBe(1);

    await c.hello('pt');
    expect(app.stats.snapshot('it').activeUsers).toBe(0);
    expect(app.stats.snapshot('pt').activeUsers).toBe(1);

    c.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(app.stats.snapshot('pt').activeUsers).toBe(0);
  });
});
