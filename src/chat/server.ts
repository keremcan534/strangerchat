/**
 * Chat server (§44).
 *
 * Holds the live state — connections, sessions, rooms — and drives one tick
 * loop that asks the matching engine for pairings and for availability. The
 * bot is attached to the *availability* output, never to the matching itself
 * (§42).
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { WebSocket, WebSocketServer } from 'ws';
import { config } from '../config/index.js';
import { englishName, normaliseInterests, normaliseLanguage } from '../config/languages.js';
import { log } from '../logger.js';
import type { BudgetTracker } from '../cost/budget.js';
import type { Database } from '../store/db.js';
import { BotManager, shouldOfferBot } from '../bot/manager.js';
import type { MatchEngine } from '../matching/engine.js';
import { AbuseClusterRegistry } from '../safety/abuse-clusters.js';
import type { RelationshipService } from '../safety/relationships.js';
import type { LanguageStats } from '../stats/language-stats.js';
import type { TranslationService } from '../translation/service.js';
import type { ChatSession, MatchResult, SessionId } from '../types.js';
import { parseClientMessage, type ServerMessage, type TranslationBanner } from './protocol.js';
import { RoomRegistry } from './rooms.js';

interface Connection {
  socket: WebSocket;
  session: ChatSession;
  /** Sliding window of send timestamps, for the per-session rate limit. */
  sendTimes: number[];
  lastSeen: number;
  /** Highest search level already announced, so status lines are not repeated. */
  announcedLevel: 0 | 1 | 2 | 3;
  botOfferSent: boolean;
  humanAvailableSent: boolean;
  translationDegradedSent: boolean;
  /** Cleared once Google has told us what language they actually write in (§3). */
  detectionDone: boolean;
  /** Whether this connection is currently counted in the active-user gauge. */
  counted: boolean;
}

export interface ChatServerDeps {
  engine: MatchEngine;
  bot: BotManager;
  translation: TranslationService;
  stats: LanguageStats;
  relationships: RelationshipService;
  budget: BudgetTracker;
  db: Database;
}

export class ChatServer {
  private readonly connections = new Map<SessionId, Connection>();
  private readonly rooms = new RoomRegistry();
  private readonly abuseClusters = new AbuseClusterRegistry();
  private tickTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: ChatServerDeps) {}

  // ------------------------------------------------------------- lifecycle

  attach(wss: WebSocketServer): void {
    wss.on('connection', (socket, request) => this.onConnection(socket, request));
    this.start();
  }

  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      void this.tick().catch((err) => log.error('tick failed', { error: (err as Error).message }));
    }, config.matching.tickIntervalMs);
    this.tickTimer.unref?.();

    this.heartbeatTimer = setInterval(() => this.sweepConnections(), config.chat.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.tickTimer = null;
    this.heartbeatTimer = null;
  }

  stateSnapshot(): Record<string, unknown> {
    return {
      connections: this.connections.size,
      waiting: this.deps.engine.size,
      rooms: this.rooms.size,
      botSessions: this.deps.bot.activeSessions,
    };
  }

  // ------------------------------------------------------------ connections

  private onConnection(socket: WebSocket, request: IncomingMessage): void {
    const session: ChatSession = {
      id: `sess_${randomUUID()}`,
      anonymousUserId: `anon_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
      preferredLanguage: 'en',
      detectedLanguage: null,
      translationEnabled: true,
      translationTargetLanguage: null,
      interests: [],
      createdAt: Date.now(),
      searchStartedAt: null,
      state: 'idle',
      roomId: null,
      botSessionId: null,
      networkKey: AbuseClusterRegistry.networkKey(remoteAddress(request)),
      abuseCluster: null,
    };

    const connection: Connection = {
      socket,
      session,
      sendTimes: [],
      lastSeen: Date.now(),
      announcedLevel: 1,
      botOfferSent: false,
      humanAvailableSent: false,
      translationDegradedSent: false,
      detectionDone: false,
      counted: false,
    };
    this.connections.set(session.id, connection);

    socket.on('message', (data) => {
      void this.onMessage(connection, data.toString()).catch((err) =>
        log.error('message handling failed', { error: (err as Error).message }),
      );
    });
    socket.on('pong', () => {
      connection.lastSeen = Date.now();
    });
    socket.on('close', () => {
      void this.onClose(connection);
    });
    socket.on('error', () => {
      void this.onClose(connection);
    });
  }

  private async onClose(connection: Connection): Promise<void> {
    const { session } = connection;
    if (!this.connections.has(session.id)) return;
    this.connections.delete(session.id);

    if (session.state === 'searching' || session.state === 'bot-offered') {
      this.deps.engine.dequeue(session.id);
      this.recordSearchAbandoned(session);
    }
    await this.leaveRoom(connection, 'disconnected', false);
    if (session.botSessionId) {
      await this.deps.bot.end(session.botSessionId);
      session.botSessionId = null;
    }
    if (connection.counted) {
      connection.counted = false;
      this.deps.stats.userDisconnected(session.preferredLanguage);
    }
    session.state = 'closed';
  }

  private sweepConnections(): void {
    const cutoff = Date.now() - config.chat.heartbeatTimeoutMs;
    for (const connection of this.connections.values()) {
      if (connection.lastSeen < cutoff) {
        try {
          connection.socket.terminate();
        } catch {
          /* already gone */
        }
        void this.onClose(connection);
        continue;
      }
      try {
        connection.socket.ping();
      } catch {
        /* handled by the close handler */
      }
    }
  }

  private send(connection: Connection, message: ServerMessage): void {
    if (connection.socket.readyState !== 1) return;
    try {
      connection.socket.send(JSON.stringify(message));
    } catch (err) {
      log.debug('send failed', { error: (err as Error).message });
    }
  }

  private sendTo(sessionId: SessionId, message: ServerMessage): void {
    const connection = this.connections.get(sessionId);
    if (connection) this.send(connection, message);
  }

  // --------------------------------------------------------- inbound routing

  private async onMessage(connection: Connection, raw: string): Promise<void> {
    connection.lastSeen = Date.now();

    const parsed = parseClientMessage(raw, config.chat.maxMessageLength);
    if (!parsed.ok || !parsed.message) {
      this.send(connection, { type: 'error', code: 'bad-request', message: parsed.error ?? 'invalid' });
      return;
    }

    const message = parsed.message;
    switch (message.type) {
      case 'ping':
        this.send(connection, { type: 'pong', at: Date.now() });
        return;
      case 'hello':
        return this.handleHello(connection, message.language, message.interests ?? [], message.anonymousUserId);
      case 'start':
        return this.handleStart(connection, message.language, message.interests);
      case 'cancel':
        return this.handleCancel(connection);
      case 'message':
        return this.handleChatMessage(connection, message.text, message.clientId);
      case 'typing':
        return this.handleTyping(connection, message.active);
      case 'skip':
        return this.handleSkip(connection);
      case 'leave':
        return this.handleLeave(connection);
      case 'accept-bot':
      case 'request-bot':
        return this.handleBotAccepted(connection, message.type === 'request-bot');
      case 'decline-bot':
        return this.handleBotDeclined(connection);
      case 'accept-human':
        return this.handleHumanHandoff(connection);
      case 'stay-with-bot':
        connection.humanAvailableSent = false;
        return;
      case 'block':
        return this.handleBlock(connection);
      case 'report':
        return this.handleReport(connection, message.reason);
      default:
        return;
    }
  }

  private handleHello(
    connection: Connection,
    language: string,
    interests: string[],
    anonymousUserId?: string,
  ): void {
    const { session } = connection;
    const previousLanguage = session.preferredLanguage;

    if (anonymousUserId) session.anonymousUserId = anonymousUserId;
    session.preferredLanguage = language;
    session.interests = normaliseInterests(interests);

    // One connection contributes exactly one active user, to whichever language
    // it currently declares — a repeated `hello` must not inflate the gauge.
    if (!connection.counted) {
      connection.counted = true;
      this.deps.stats.userConnected(language);
    } else if (previousLanguage !== language) {
      this.deps.stats.userDisconnected(previousLanguage);
      this.deps.stats.userConnected(language);
    }

    this.send(connection, {
      type: 'session',
      sessionId: session.id,
      anonymousUserId: session.anonymousUserId,
      language: session.preferredLanguage,
      interests: session.interests,
      botEnabled: config.bot.enabled,
      botMode: config.bot.mode,
    });
  }

  private async handleStart(
    connection: Connection,
    language?: string,
    interests?: string[],
  ): Promise<void> {
    const { session } = connection;

    if (session.roomId) await this.leaveRoom(connection, 'left', true);
    if (session.botSessionId) {
      await this.deps.bot.end(session.botSessionId);
      session.botSessionId = null;
    }

    if (language) {
      const next = normaliseLanguage(language);
      if (next && next !== session.preferredLanguage) {
        if (connection.counted) {
          this.deps.stats.userDisconnected(session.preferredLanguage);
          this.deps.stats.userConnected(next);
        }
        session.preferredLanguage = next;
      }
    }
    if (interests) session.interests = normaliseInterests(interests);

    this.enterQueue(connection, Date.now());
  }

  /**
   * Puts a session into the waiting pool.
   *
   * `enqueuedAt` can be backdated so that time already spent waiting still
   * counts — used by the bot→human handoff (§29), where the user has in truth
   * been waiting since before the AI conversation started.
   */
  private enterQueue(connection: Connection, enqueuedAt: number): void {
    const { session } = connection;
    session.state = 'searching';
    session.searchStartedAt = enqueuedAt;
    session.roomId = null;
    // Tier 1 needs no announcement — the `searching` message already said it.
    connection.announcedLevel = 1;
    connection.botOfferSent = false;
    connection.humanAvailableSent = false;
    connection.translationDegradedSent = false;

    // Only a network that has actually attracted reports counts as a cluster.
    session.abuseCluster = this.abuseClusters.clusterFor(session.networkKey);

    this.deps.engine.enqueue({
      sessionId: session.id,
      anonymousUserId: session.anonymousUserId,
      language: session.preferredLanguage,
      interests: session.interests,
      enqueuedAt,
      abuseCluster: session.abuseCluster,
      botOfferDeclined: false,
    });

    this.send(connection, {
      type: 'searching',
      startedAt: enqueuedAt,
      language: session.preferredLanguage,
    });
  }

  private handleCancel(connection: Connection): void {
    const { session } = connection;
    if (session.state !== 'searching' && session.state !== 'bot-offered') return;
    this.deps.engine.dequeue(session.id);
    this.recordSearchAbandoned(session);
    session.state = 'idle';
    session.searchStartedAt = null;
    this.send(connection, { type: 'ended', reason: 'cancelled' });
  }

  private recordSearchAbandoned(session: ChatSession): void {
    if (session.searchStartedAt === null) return;
    this.deps.stats.record(
      session.preferredLanguage,
      Date.now() - session.searchStartedAt,
      false,
      false,
    );
    session.searchStartedAt = null;
  }

  private handleTyping(connection: Connection, active: boolean): void {
    const partner = this.rooms.partnerOf(connection.session.id);
    if (partner) this.sendTo(partner, { type: 'partner-typing', active });
  }

  // ------------------------------------------------------------- rate limit

  private rateLimited(connection: Connection): boolean {
    const now = Date.now();
    connection.sendTimes = connection.sendTimes.filter((t) => now - t < 10_000);
    if (connection.sendTimes.length >= config.chat.messageRateLimit) return true;
    connection.sendTimes.push(now);
    return false;
  }

  // ---------------------------------------------------------- chat messages

  private async handleChatMessage(
    connection: Connection,
    text: string,
    clientId?: string,
  ): Promise<void> {
    const { session } = connection;

    if (this.rateLimited(connection)) {
      this.send(connection, { type: 'error', code: 'rate-limited', message: 'Slow down a little.' });
      return;
    }

    if (session.botSessionId) return this.handleBotMessage(connection, text, clientId);

    const room = this.rooms.forSession(session.id);
    const partnerId = this.rooms.partnerOf(session.id);
    if (!room || !partnerId) {
      this.send(connection, { type: 'error', code: 'no-partner', message: 'You are not in a chat.' });
      return;
    }

    const partner = this.connections.get(partnerId);
    room.messageCount += 1;
    const at = Date.now();
    const id = randomUUID();

    // Sending a message means you have stopped typing. Doing this server-side
    // means a client that drops mid-keystroke cannot leave the dots stuck on.
    if (partner) this.send(partner, { type: 'partner-typing', active: false });

    // The sender always sees exactly what they typed.
    this.send(connection, {
      type: 'message',
      id,
      from: 'you',
      kind: 'human',
      text,
      translated: false,
      at,
      ...(clientId ? { clientId } : {}),
    });

    if (!partner) return;

    const source = session.preferredLanguage;
    const target = partner.session.preferredLanguage;

    if (!room.translationRequired || source === target) {
      this.send(partner, {
        type: 'message',
        id,
        from: 'partner',
        kind: 'human',
        text,
        translated: false,
        at,
      });
      return;
    }

    // §8/§9 — on the first translated message we let Google auto-detect so we
    // can record what the user actually writes in (§3); afterwards we pass the
    // declared source, which is cheaper and more accurate.
    const outcome = await this.deps.translation.translate(
      text,
      target,
      connection.detectionDone ? source : undefined,
    );

    if (outcome.ok && outcome.result) {
      if (!connection.detectionDone) {
        connection.detectionDone = true;
        session.detectedLanguage = outcome.result.detectedSourceLanguage ?? source;
      }
      session.translationTargetLanguage = target;

      this.send(partner, {
        type: 'message',
        id,
        from: 'partner',
        kind: 'human',
        text: outcome.result.text,
        // §10 — the original always travels with the translation so the reader
        // can open "Show original".
        originalText: text,
        translated: true,
        sourceLanguage: outcome.result.detectedSourceLanguage ?? source,
        targetLanguage: target,
        at,
      });
      return;
    }

    // §15 — translation failed or the budget is gone: forward the original and
    // say so once, rather than dropping the conversation.
    this.send(partner, {
      type: 'message',
      id,
      from: 'partner',
      kind: 'human',
      text,
      translated: false,
      sourceLanguage: source,
      at,
    });

    if (!partner.translationDegradedSent) {
      partner.translationDegradedSent = true;
      connection.translationDegradedSent = true;
      const reason = outcome.reason ?? 'provider-error';
      this.send(partner, { type: 'translation-degraded', reason });
      this.send(connection, { type: 'translation-degraded', reason });
    }
  }

  private async handleBotMessage(
    connection: Connection,
    text: string,
    clientId?: string,
  ): Promise<void> {
    const { session } = connection;
    const botSessionId = session.botSessionId!;
    const at = Date.now();

    this.send(connection, {
      type: 'message',
      id: randomUUID(),
      from: 'you',
      kind: 'bot',
      text,
      translated: false,
      at,
      ...(clientId ? { clientId } : {}),
    });

    const botSession = this.deps.bot.get(botSessionId);
    if (botSession && this.deps.bot.expired(botSession)) {
      await this.endBotSession(connection, 'bot-session-limit');
      return;
    }

    this.send(connection, { type: 'partner-typing', active: true });
    const reply = await this.deps.bot.reply(botSessionId, text);
    if (!reply) {
      this.send(connection, { type: 'partner-typing', active: false });
      return;
    }

    // A tiny pause so the AI does not answer before the user's message renders.
    await sleep(reply.typingDelayMs);
    this.send(connection, { type: 'partner-typing', active: false });
    this.send(connection, {
      type: 'message',
      id: randomUUID(),
      from: 'partner',
      kind: 'bot',
      text: reply.text,
      translated: false,
      at: Date.now(),
    });
  }

  // ------------------------------------------------------------ leaving

  /** Closes the room this connection is in and tells the partner why. */
  private async leaveRoom(
    connection: Connection,
    reason: 'left' | 'skipped' | 'disconnected' | 'ended',
    notify: boolean,
  ): Promise<void> {
    const { session } = connection;
    const room = this.rooms.forSession(session.id);
    if (!room) return;

    const partnerId = room.a === session.id ? room.b : room.a;
    this.rooms.close(room.id);
    session.roomId = null;

    const partner = this.connections.get(partnerId);
    if (partner) {
      partner.session.roomId = null;
      partner.session.state = 'idle';
      await this.deps.relationships.recordDeparture(
        session.anonymousUserId,
        partner.session.anonymousUserId,
      );
      if (notify) this.sendTo(partnerId, { type: 'partner-left', reason });
    }
  }

  private async handleLeave(connection: Connection): Promise<void> {
    const { session } = connection;
    if (session.botSessionId) return this.endBotSession(connection, 'left');
    await this.leaveRoom(connection, 'left', true);
    session.state = 'idle';
    this.send(connection, { type: 'ended', reason: 'left' });
  }

  /** "Next stranger": end this conversation and go straight back to searching. */
  private async handleSkip(connection: Connection): Promise<void> {
    const { session } = connection;
    if (session.botSessionId) {
      await this.deps.bot.end(session.botSessionId);
      session.botSessionId = null;
    } else {
      await this.leaveRoom(connection, 'skipped', true);
    }
    this.enterQueue(connection, Date.now());
  }

  private async handleBlock(connection: Connection): Promise<void> {
    const partnerId = this.rooms.partnerOf(connection.session.id);
    if (partnerId) {
      const partner = this.connections.get(partnerId);
      if (partner) {
        await this.deps.relationships.block(
          connection.session.anonymousUserId,
          partner.session.anonymousUserId,
          'user-block',
        );
        this.abuseClusters.flag(partner.session.networkKey);
      }
    }
    await this.handleSkip(connection);
  }

  private async handleReport(connection: Connection, reason?: string): Promise<void> {
    const partnerId = this.rooms.partnerOf(connection.session.id);
    const partner = partnerId ? this.connections.get(partnerId) : undefined;
    // Reports are logged, not stored against a profile — there are no profiles.
    log.warn('user report', {
      reporter: connection.session.anonymousUserId,
      reported: partner?.session.anonymousUserId ?? null,
      reason: reason ?? null,
    });
    if (partner) {
      await this.deps.relationships.block(
        connection.session.anonymousUserId,
        partner.session.anonymousUserId,
        reason ?? 'report',
      );
      this.abuseClusters.flag(partner.session.networkKey);
    }
    await this.handleSkip(connection);
  }

  // ----------------------------------------------------------------- the bot

  private async handleBotAccepted(connection: Connection, explicit: boolean): Promise<void> {
    const { session } = connection;
    if (session.botSessionId) return;
    if (session.state !== 'searching' && session.state !== 'bot-offered') {
      this.send(connection, { type: 'error', code: 'not-searching', message: 'Start a search first.' });
      return;
    }

    const availability = await this.deps.bot.canStart(session.id);
    if (!availability.allowed) {
      this.send(connection, {
        type: 'bot-unavailable',
        reason: availability.reason ?? 'unavailable',
        ...(availability.retryAfterMs ? { retryAfterMs: availability.retryAfterMs } : {}),
      });
      return;
    }

    const waited = session.searchStartedAt === null ? 0 : Date.now() - session.searchStartedAt;
    this.deps.engine.dequeue(session.id);
    // A bot conversation is not a successful human match — that distinction is
    // what makes match_success_rate and bot_usage_rate meaningful (§27).
    this.deps.stats.record(session.preferredLanguage, waited, false, true);

    const botSession = await this.deps.bot.start({
      sessionId: session.id,
      anonymousUserId: session.anonymousUserId,
      language: session.preferredLanguage,
      interests: session.interests,
    });

    session.botSessionId = botSession.id;
    session.state = 'bot-chatting';
    connection.humanAvailableSent = false;

    const limit = config.bot.sessionLimitMs;
    this.send(connection, {
      type: 'bot-matched',
      botSessionId: botSession.id,
      language: botSession.language,
      personality: botSession.personalityId,
      limitMs: limit > 0 ? limit : null,
    });

    log.info('bot session started', {
      language: botSession.language,
      explicit,
      provider: this.deps.bot.providerName,
    });

    const greeting = await this.deps.bot.greeting(botSession.id);
    if (greeting && session.botSessionId === botSession.id) {
      await sleep(greeting.typingDelayMs);
      this.send(connection, {
        type: 'message',
        id: randomUUID(),
        from: 'partner',
        kind: 'bot',
        text: greeting.text,
        translated: false,
        at: Date.now(),
      });
    }
  }

  private handleBotDeclined(connection: Connection): void {
    const { session } = connection;
    this.deps.engine.declineBotOffer(session.id);
    session.state = 'searching';
    // botOfferSent stays true: the user asked to keep waiting, so we do not
    // interrupt them again. The client keeps a "Talk to AI" button available.
  }

  /** §29 — the user was told a real person is available and chose them. */
  private async handleHumanHandoff(connection: Connection): Promise<void> {
    const { session } = connection;
    if (!session.botSessionId) return;

    await this.deps.bot.end(session.botSessionId, true);
    session.botSessionId = null;

    // The time they already spent waiting still counts, so the handoff lands on
    // a match immediately instead of restarting their ladder from zero.
    const maxBackdate = config.matching.crossLanguageMs;
    const backdated =
      session.searchStartedAt === null
        ? Date.now()
        : Math.max(session.searchStartedAt, Date.now() - maxBackdate);
    this.enterQueue(connection, backdated);
  }

  private async endBotSession(connection: Connection, reason: string): Promise<void> {
    const { session } = connection;
    if (session.botSessionId) await this.deps.bot.end(session.botSessionId);
    session.botSessionId = null;
    session.state = 'idle';
    this.send(connection, { type: 'ended', reason });
  }

  // -------------------------------------------------------------- tick loop

  private async tick(): Promise<void> {
    const now = Date.now();

    for (const match of await this.deps.engine.tick(now)) {
      await this.pairUp(match, now);
    }

    for (const availability of this.deps.engine.availability(now)) {
      const connection = this.connections.get(availability.sessionId);
      if (!connection) {
        // The socket went away between ticks.
        this.deps.engine.dequeue(availability.sessionId);
        continue;
      }
      const { session } = connection;

      if (availability.level > connection.announcedLevel) {
        connection.announcedLevel = availability.level;
        this.send(connection, {
          type: 'search-status',
          level: availability.level,
          waitedMs: Math.round(availability.waitedMs),
          language: session.preferredLanguage,
          sameLanguageWaiting: availability.sameLanguageWaiting,
          statusKey: STATUS_KEYS[availability.level],
        });
      }

      if (connection.botOfferSent) continue;
      const entry = this.deps.engine.get(session.id);
      const offer = shouldOfferBot({
        mode: config.bot.mode,
        botOfferDue: availability.botOfferDue,
        pressure: this.deps.stats.pressure(session.preferredLanguage),
        declined: entry?.botOfferDeclined ?? false,
        botEnabled: config.bot.enabled,
      });
      if (!offer) continue;
      if (!(await this.deps.bot.canStart(session.id)).allowed) continue;

      connection.botOfferSent = true;
      session.state = 'bot-offered';
      this.send(connection, {
        type: 'bot-offer',
        reason: 'no-human-available',
        waitedMs: Math.round(availability.waitedMs),
      });
    }

    await this.watchBotSessions();
  }

  /** §18 scenario D / §29 — a human turning up while the user is with the AI. */
  private async watchBotSessions(): Promise<void> {
    let waitingByLanguage: Map<string, Set<string>> | null = null;

    for (const connection of this.connections.values()) {
      const { session } = connection;
      if (!session.botSessionId) continue;

      const botSession = this.deps.bot.get(session.botSessionId);
      if (botSession && this.deps.bot.expired(botSession)) {
        await this.endBotSession(connection, 'bot-session-limit');
        continue;
      }

      if (connection.humanAvailableSent) continue;
      waitingByLanguage ??= this.deps.engine.waitingByLanguage();

      const sameLanguage = waitingByLanguage.get(session.preferredLanguage);
      // Someone other than this user has to be waiting — their own second tab
      // is not "a real person is available".
      const waitingSameLanguage =
        sameLanguage !== undefined &&
        (sameLanguage.size > 1 || !sameLanguage.has(session.anonymousUserId));
      if (!waitingSameLanguage) continue;

      connection.humanAvailableSent = true;
      this.deps.bot.markHumanAvailable(session.botSessionId, true);
      this.send(connection, {
        type: 'human-available',
        waitingIn: session.preferredLanguage,
      });
    }
  }

  private async pairUp(match: MatchResult, now: number): Promise<void> {
    const a = this.connections.get(match.a.sessionId);
    const b = this.connections.get(match.b.sessionId);

    // If one side vanished, put the other straight back into the pool rather
    // than dropping them into an empty room.
    if (!a || !b) {
      const survivor = a ?? b;
      if (survivor) this.enterQueue(survivor, survivor.session.searchStartedAt ?? now);
      return;
    }

    const room = this.rooms.create({
      a: a.session.id,
      b: b.session.id,
      tier: match.tier,
      translationRequired: match.translationRequired,
      commonInterests: match.commonInterests,
    });

    for (const [self, other] of [
      [a, b],
      [b, a],
    ] as const) {
      self.session.roomId = room.id;
      self.session.state = 'chatting';
      self.session.translationEnabled = match.translationRequired;
      self.session.translationTargetLanguage = match.translationRequired
        ? other.session.preferredLanguage
        : null;
      self.translationDegradedSent = false;
      self.detectionDone = false;

      const waited = self.session.searchStartedAt === null ? 0 : now - self.session.searchStartedAt;
      this.deps.stats.record(self.session.preferredLanguage, waited, true, false);
      self.session.searchStartedAt = null;

      this.send(self, {
        type: 'matched',
        partnerKind: 'human',
        roomId: room.id,
        tier: match.tier,
        commonInterests: match.commonInterests,
        translation: banner(
          match.translationRequired && this.deps.translation.enabled,
          self.session.preferredLanguage,
          other.session.preferredLanguage,
        ),
      });
    }

    log.debug('matched', {
      tier: match.tier,
      score: match.score,
      translation: match.translationRequired,
    });
  }
}

const STATUS_KEYS: Record<1 | 2 | 3, string> = {
  1: 'searching',
  2: 'still-looking-same-language',
  3: 'expanding-other-languages',
};

/** §14 — what the chat header tells the user about translation. */
function banner(enabled: boolean, yourLanguage: string, partnerLanguage: string): TranslationBanner {
  return {
    enabled,
    yourLanguage,
    yourLanguageName: englishName(yourLanguage),
    partnerLanguage,
    partnerLanguageName: englishName(partnerLanguage),
  };
}

/** The client address, honouring X-Forwarded-For only when TRUST_PROXY is on. */
function remoteAddress(request: IncomingMessage): string | null {
  const forwarded = config.trustProxy
    ? (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    : undefined;
  return forwarded || request.socket.remoteAddress || null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
