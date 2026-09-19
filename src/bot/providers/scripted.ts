/**
 * Offline provider.
 *
 * Runs when no AI credentials are configured, so that the whole fallback path
 * — offer, accept, converse, hand off to a human — is exercisable locally and
 * in tests without a network or a bill. It is a stand-in, not a chatbot: the
 * replies are short, localised acknowledgements that keep the UI honest.
 */
import type { AiProvider, BotCompletionOptions, BotReply } from './provider.js';

type Phrasebook = { opener: string; prompts: string[] };

const PHRASES: Record<string, Phrasebook> = {
  en: {
    opener: "Hey! I'm an AI, so no pressure — what's on your mind?",
    prompts: [
      'That makes sense. What got you into it?',
      'Interesting — tell me more about that.',
      'Fair enough. How has your day been so far?',
      'I hear you. What do you usually do to unwind?',
    ],
  },
  tr: {
    opener: 'Selam! Ben bir yapay zekâyım, rahat ol — aklında ne var?',
    prompts: [
      'Anladım. Bu ilgin nasıl başladı?',
      'İlginç — biraz daha anlatır mısın?',
      'Olur tabii. Günün nasıl geçiyor?',
      'Seni anlıyorum. Kafa dağıtmak için genelde ne yaparsın?',
    ],
  },
  de: {
    opener: 'Hi! Ich bin eine KI, also ganz entspannt — worüber willst du reden?',
    prompts: [
      'Verstehe. Wie bist du dazu gekommen?',
      'Spannend — erzähl mir mehr.',
      'Alles klar. Wie war dein Tag bisher?',
      'Kann ich nachvollziehen. Wie schaltest du normalerweise ab?',
    ],
  },
  es: {
    opener: '¡Hola! Soy una IA, así que tranquilo: ¿de qué quieres hablar?',
    prompts: [
      'Tiene sentido. ¿Cómo empezaste con eso?',
      'Interesante, cuéntame más.',
      'Vale. ¿Qué tal te va el día?',
      'Te entiendo. ¿Qué haces para desconectar?',
    ],
  },
  fr: {
    opener: "Salut ! Je suis une IA, donc pas de pression — de quoi veux-tu parler ?",
    prompts: [
      'Je vois. Comment tu as commencé ?',
      'Intéressant, raconte-moi.',
      "D'accord. Ta journée se passe comment ?",
      'Je comprends. Tu fais quoi pour décompresser ?',
    ],
  },
  ja: {
    opener: 'こんにちは！私はAIです。気楽にどうぞ — 何を話しましょうか？',
    prompts: [
      'なるほど。どうして興味を持ったんですか？',
      '面白いですね、もう少し聞かせてください。',
      'そうなんですね。今日はどんな一日でしたか？',
      'わかります。普段はどうやってリラックスしていますか？',
    ],
  },
};

export class ScriptedProvider implements AiProvider {
  readonly name = 'scripted';
  readonly configured = true;

  costOf(): number {
    return 0;
  }

  async complete(options: BotCompletionOptions): Promise<BotReply> {
    // The manager encodes the language into the system prompt; recover it here.
    const language = /language:\s*([a-z-]+)/i.exec(options.system)?.[1]?.toLowerCase() ?? 'en';
    const book = PHRASES[language] ?? PHRASES.en!;
    const userTurns = options.turns.filter((t) => t.role === 'user').length;

    const text =
      userTurns <= 1 ? book.opener : book.prompts[(userTurns - 2) % book.prompts.length]!;

    return { text, inputTokens: 0, outputTokens: 0 };
  }
}
