/**
 * Bot Manager (§23).
 *
 * Owns BotSession / BotContext / BotLanguage / BotPersonality /
 * ConversationState. It is deliberately a *consumer* of the matching engine's
 * availability result rather than a branch inside it (§42), so switching from
 * "AI fallback" to "AI only on request" (§43) is a mode flag, not surgery.
 *
 * The bot always speaks the user's chosen language directly — it is never
 * routed through the translation service (§19, §30).
 */
import { randomUUID } from 'node:crypto';
import { config, type BotMode } from '../config/index.js';
import { englishName } from '../config/languages.js';
import { log } from '../logger.js';
import type { BudgetTracker } from '../cost/budget.js';
import type { Database } from '../store/db.js';
import type { KeyValueStore } from '../store/kv.js';
import type { BotTurn, FallbackPressure } from '../types.js';
import { identityAnswer, isIdentityQuestion, violatesIdentityRule } from './identity.js';
import { DEFAULT_PERSONALITY, getPersonality, pickPersonality } from './personalities.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAiCompatibleProvider } from './providers/openai-compatible.js';
import type { AiProvider } from './providers/provider.js';
import { ScriptedProvider } from './providers/scripted.js';

export type ConversationState = 'active' | 'handoff-offered' | 'ended';

export interface BotSession {
  id: string;
  sessionId: string;
  anonymousUserId: string;
  /** BotLanguage — always the user's preferred language. */
  language: string;
  personalityId: string;
  startedAt: number;
  turns: BotTurn[];
  messageCount: number;
  state: ConversationState;
  humanMatchAvailable: boolean;
  handoffOffered: boolean;
  handoffAccepted: boolean;
  /** Interests, used as BotContext (§22). */
  interests: string[];
}

export interface BotReplyResult {
  text: string;
  /** Milliseconds of simulated typing before the text should be delivered. */
  typingDelayMs: number;
  /** True when the reply came from the deterministic identity guard (§20). */
  guarded: boolean;
  degraded: boolean;
}

export interface BotAvailability {
  allowed: boolean;
  reason?: 'disabled' | 'budget-exhausted' | 'cooldown';
  /** When on cooldown, when the user may start another AI chat. */
  retryAfterMs?: number;
}

export function selectAiProvider(): AiProvider {
  const choice = config.bot.provider;
  if (choice === 'scripted') return new ScriptedProvider();
  if (choice === 'anthropic') return new AnthropicProvider();
  if (choice === 'openai-compatible') return new OpenAiCompatibleProvider();

  const anthropic = new AnthropicProvider();
  if (anthropic.configured) return anthropic;
  const local = new OpenAiCompatibleProvider();
  if (local.configured) return local;
  log.warn('no AI credentials found — the bot will use scripted replies');
  return new ScriptedProvider();
}

/**
 * §28 — whether an AI offer is warranted yet.
 *
 * "Human unlikely" is the trigger, not "human not found instantly": a language
 * that reliably matches in two seconds should keep searching, a language with a
 * 40-second average should not pretend otherwise.
 */
export function shouldOfferBot(input: {
  mode: BotMode;
  botOfferDue: boolean;
  pressure: FallbackPressure;
  declined: boolean;
  botEnabled: boolean;
}): boolean {
  if (!input.botEnabled) return false;
  // §43 mature mode: the bot stays available, but only when asked for.
  if (input.mode === 'mature') return false;
  if (input.declined) return false;
  return input.botOfferDue;
}

export class BotManager {
  private readonly sessions = new Map<string, BotSession>();
  /** sessionId -> timestamp the cooldown ends (§25). */
  private readonly cooldowns = new Map<string, number>();

  constructor(
    private readonly budget: BudgetTracker,
    private readonly db: Database,
    private readonly kv: KeyValueStore,
    private readonly provider: AiProvider = selectAiProvider(),
  ) {}

  get providerName(): string {
    return this.provider.name;
  }

  get activeSessions(): number {
    return this.sessions.size;
  }

  // ------------------------------------------------------------ eligibility

  async canStart(sessionId: string): Promise<BotAvailability> {
    if (!config.bot.enabled) return { allowed: false, reason: 'disabled' };

    const until = this.cooldowns.get(sessionId);
    if (until && until > Date.now()) {
      return { allowed: false, reason: 'cooldown', retryAfterMs: until - Date.now() };
    }
    if (!(await this.budget.canUseBot())) {
      return { allowed: false, reason: 'budget-exhausted' };
    }
    return { allowed: true };
  }

  // --------------------------------------------------------------- lifecycle

  async start(input: {
    sessionId: string;
    anonymousUserId: string;
    language: string;
    interests: string[];
    personalityId?: string;
  }): Promise<BotSession> {
    const personality = input.personalityId
      ? getPersonality(input.personalityId)
      : pickPersonality(input.interests);

    const session: BotSession = {
      id: `bot_${randomUUID()}`,
      sessionId: input.sessionId,
      anonymousUserId: input.anonymousUserId,
      language: input.language,
      personalityId: personality.id,
      startedAt: Date.now(),
      turns: [],
      messageCount: 0,
      state: 'active',
      humanMatchAvailable: false,
      handoffOffered: false,
      handoffAccepted: false,
      interests: input.interests,
    };

    this.sessions.set(session.id, session);
    await this.budget.recordBotSessionStarted();
    void this.db.startBotSession({
      id: session.id,
      anonymousUserId: session.anonymousUserId,
      language: session.language,
      personality: session.personalityId,
    });
    return session;
  }

  get(botSessionId: string): BotSession | null {
    return this.sessions.get(botSessionId) ?? null;
  }

  /** §25 — how long this AI conversation may still run. 0 means unlimited. */
  remainingMs(session: BotSession): number {
    if (config.bot.sessionLimitMs <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, config.bot.sessionLimitMs - (Date.now() - session.startedAt));
  }

  expired(session: BotSession): boolean {
    return this.remainingMs(session) <= 0;
  }

  markHumanAvailable(botSessionId: string, offered: boolean): void {
    const s = this.sessions.get(botSessionId);
    if (!s) return;
    s.humanMatchAvailable = true;
    if (offered) {
      s.handoffOffered = true;
      s.state = 'handoff-offered';
    }
  }

  async end(botSessionId: string, handoffAccepted = false): Promise<void> {
    const session = this.sessions.get(botSessionId);
    if (!session) return;
    session.state = 'ended';
    session.handoffAccepted = handoffAccepted;
    this.sessions.delete(botSessionId);

    if (config.bot.cooldownMs > 0) {
      this.cooldowns.set(session.sessionId, Date.now() + config.bot.cooldownMs);
    }

    void this.db.endBotSession({
      id: session.id,
      messageCount: session.messageCount,
      humanMatchAvailable: session.humanMatchAvailable,
      handoffOffered: session.handoffOffered,
      handoffAccepted,
    });
  }

  // ------------------------------------------------------------------ replies

  /** §19/§22 — language and interests are carried in the system prompt. */
  buildSystemPrompt(session: BotSession): string {
    const personality = getPersonality(session.personalityId);
    const lang = englishName(session.language);
    const interests =
      session.interests.length > 0 ? session.interests.join(', ') : 'none given';

    return [
      `You are the AI conversation partner on an anonymous random text chat platform.`,
      `The user was told clearly that they are talking to an AI, not a person.`,
      ``,
      `Language: ${session.language}`,
      `Write every reply in ${lang}, and only in ${lang}, whatever language the user writes in.`,
      `User interests: ${interests}`,
      `Conversation style: ${personality.label}. ${personality.prompt}`,
      ``,
      `Rules:`,
      `- Never claim or imply that you are a human. If asked, say plainly that you are an AI.`,
      `- Do not invent a human backstory, a name, a job, a city or personal experiences.`,
      `- Keep replies short: one to three sentences, like a real chat message.`,
      `- Match the user's tone and register. No bullet points, no headings, no markdown.`,
      `- Do not offer assistant-style help, task lists or disclaimers unless asked.`,
      `- If the user wants to stop or asks for a real person, tell them they can leave the`,
      `  AI chat and keep searching for someone.`,
      `- Decline sexual content involving minors, threats, and requests for personal data.`,
    ].join('\n');
  }

  private typingDelay(text: string): number {
    return Math.min(
      config.bot.maxTypingMs,
      config.bot.minTypingMs + text.length * config.bot.typingMsPerChar,
    );
  }

  /**
   * Produces the bot's reply to one user message.
   *
   * Never throws: on a provider failure the caller gets a degraded, localised
   * message and the conversation stays alive, mirroring the translation
   * fallback in §15.
   */
  async reply(botSessionId: string, userMessage: string): Promise<BotReplyResult | null> {
    const session = this.sessions.get(botSessionId);
    if (!session) return null;

    session.turns.push({ role: 'user', content: userMessage });
    if (session.turns.length > config.bot.historyTurns) {
      session.turns.splice(0, session.turns.length - config.bot.historyTurns);
    }

    // §20 — identity questions bypass the model entirely.
    if (isIdentityQuestion(userMessage)) {
      const text = identityAnswer(session.language);
      session.turns.push({ role: 'assistant', content: text });
      session.messageCount += 1;
      return { text, typingDelayMs: this.typingDelay(text), guarded: true, degraded: false };
    }

    if (!(await this.budget.canUseBot())) {
      const text = degradedMessage(session.language);
      session.turns.push({ role: 'assistant', content: text });
      return { text, typingDelayMs: config.bot.minTypingMs, guarded: false, degraded: true };
    }

    try {
      const reply = await this.provider.complete({
        system: this.buildSystemPrompt(session),
        turns: session.turns,
        maxTokens: config.bot.maxReplyTokens,
        timeoutMs: config.bot.timeoutMs,
      });

      const text = violatesIdentityRule(reply.text) ? identityAnswer(session.language) : reply.text;

      session.turns.push({ role: 'assistant', content: text });
      session.messageCount += 1;

      await this.budget.recordBotMessage(
        reply.inputTokens,
        reply.outputTokens,
        this.provider.costOf(reply.inputTokens, reply.outputTokens),
      );

      return {
        text,
        typingDelayMs: this.typingDelay(text),
        guarded: text !== reply.text,
        degraded: false,
      };
    } catch (err) {
      log.warn('bot reply failed', { error: (err as Error).message, provider: this.provider.name });
      const text = degradedMessage(session.language);
      session.turns.push({ role: 'assistant', content: text });
      return { text, typingDelayMs: config.bot.minTypingMs, guarded: false, degraded: true };
    }
  }

  /** Opening line when the user accepts the AI offer. */
  async greeting(botSessionId: string): Promise<BotReplyResult | null> {
    const session = this.sessions.get(botSessionId);
    if (!session) return null;
    return this.reply(botSessionId, GREETING_TRIGGER[session.language] ?? GREETING_TRIGGER.en!);
  }

  stats(): Record<string, unknown> {
    return {
      provider: this.provider.name,
      mode: config.bot.mode,
      enabled: config.bot.enabled,
      activeSessions: this.sessions.size,
      defaultPersonality: DEFAULT_PERSONALITY.id,
    };
  }
}

/** A neutral first user turn, so the model opens the conversation naturally. */
const GREETING_TRIGGER: Record<string, string> = {
  en: 'hi',
  tr: 'selam',
  de: 'hallo',
  es: 'hola',
  fr: 'salut',
  it: 'ciao',
  pt: 'oi',
  ru: 'привет',
  ja: 'こんにちは',
  ko: '안녕하세요',
  zh: '你好',
};

const DEGRADED: Record<string, string> = {
  en: "I'm having trouble replying right now. Give me a moment, or head back and keep looking for a person.",
  tr: 'Şu anda cevap vermekte zorlanıyorum. Biraz bekleyebilir ya da geri dönüp gerçek biri aramaya devam edebilirsin.',
  de: 'Ich kann gerade nicht antworten. Warte kurz, oder such weiter nach einer echten Person.',
  es: 'Ahora mismo no puedo responder. Espera un momento o vuelve a buscar a una persona.',
  fr: "Je n'arrive pas à répondre pour le moment. Patiente un instant, ou retourne chercher une vraie personne.",
  ja: '今はうまく返信できません。少し待つか、戻って人を探してみてください。',
};

function degradedMessage(language: string): string {
  return DEGRADED[language] ?? DEGRADED.en!;
}
