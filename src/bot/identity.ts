/**
 * §20 — the bot must never claim to be human, and a direct "are you human?"
 * must get a straight "no".
 *
 * Relying on the system prompt alone would make that guarantee probabilistic.
 * Direct identity questions are therefore answered deterministically, before
 * the model is ever called, in the user's own language.
 */

const IDENTITY_PATTERNS: RegExp[] = [
  // English
  /\b(are|r)\s+(you|u)\s+(a\s+)?(human|real|person|bot|ai|robot|machine|chatbot)\b/i,
  /\b(is\s+this|am\s+i\s+talking\s+to)\s+(a\s+)?(bot|ai|human|real\s+person|robot)\b/i,
  /\b(you'?re|your)\s+(a\s+)?(bot|ai|robot)\b\s*\??/i,
  // Turkish
  /\b(ger[çc]ek\s+(bir\s+)?(insan|ki[şs]i)\s*m[ıi]s[ıi]n)/i,
  /\b(insan\s*m[ıi]s[ıi]n|bot\s*mu?sun|robot\s*mu?sun|yapay\s+zek[âa]\s*m[ıi]s[ıi]n)/i,
  // German
  /\bbist\s+du\s+(ein\s+)?(mensch|echt|bot|roboter|ki)\b/i,
  // Spanish
  /\b(eres\s+(un[ao]?\s+)?(humano|persona|real|bot|robot|ia))\b/i,
  // French
  /\b(es[- ]tu\s+(un[e]?\s+)?(humain|vrai|robot|bot|ia))\b/i,
  // Italian / Portuguese
  /\b(sei\s+(un[a]?\s+)?(umano|robot|bot))\b/i,
  /\b(voc[eê]\s+[eé]\s+(um[a]?\s+)?(humano|rob[oô]|bot|pessoa\s+real))\b/i,
  // Russian
  /\b(ты|вы)\s+(человек|бот|робот|ии)\b/i,
  // Japanese / Korean / Chinese
  /(人間ですか|ボットですか|AIですか)/i,
  /(사람이에요|사람인가요|봇이에요|인공지능인가요)/,
  /(你是(真)?人吗|你是机器人吗|你是(不是)?AI)/,
];

/** Canonical answers to a direct identity question, per language (§20). */
const IDENTITY_ANSWERS: Record<string, string> = {
  en: "No. I'm an AI conversation partner, not a person.",
  tr: 'Hayır. Ben bir yapay zekâ sohbet arkadaşıyım, gerçek bir insan değilim.',
  de: 'Nein. Ich bin ein KI-Gesprächspartner, kein Mensch.',
  es: 'No. Soy una IA con la que puedes conversar, no una persona.',
  fr: "Non. Je suis une IA avec qui discuter, pas une personne.",
  it: 'No. Sono un interlocutore basato su IA, non una persona.',
  pt: 'Não. Sou uma IA para conversar, não uma pessoa.',
  ru: 'Нет. Я — ИИ-собеседник, а не человек.',
  ar: 'لا. أنا شريك محادثة يعمل بالذكاء الاصطناعي، ولست إنساناً.',
  hi: 'नहीं। मैं एक एआई बातचीत साथी हूँ, कोई इंसान नहीं।',
  ja: 'いいえ。私は人間ではなく、AIの会話相手です。',
  ko: '아니요. 저는 사람이 아니라 AI 대화 상대예요.',
  zh: '不是。我是一个 AI 聊天伙伴，不是真人。',
  pl: 'Nie. Jestem rozmówcą AI, nie człowiekiem.',
  nl: 'Nee. Ik ben een AI-gesprekspartner, geen mens.',
  sv: 'Nej. Jag är en AI-samtalspartner, inte en människa.',
  fi: 'En. Olen tekoälykeskustelukumppani, en ihminen.',
  id: 'Bukan. Saya teman mengobrol AI, bukan manusia.',
  uk: 'Ні. Я — ШІ-співрозмовник, а не людина.',
  fa: 'نه. من یک همصحبت هوش مصنوعی هستم، نه یک انسان.',
};

export function isIdentityQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > 200) return false;
  return IDENTITY_PATTERNS.some((re) => re.test(trimmed));
}

export function identityAnswer(language: string): string {
  return IDENTITY_ANSWERS[language] ?? IDENTITY_ANSWERS.en!;
}

/**
 * Last line of defence: if a model ever produces "I am a real human", the claim
 * is replaced rather than forwarded. Rare, but the product promise in §17/§20
 * is that this cannot happen.
 */
const HUMAN_CLAIM_PATTERNS: RegExp[] = [
  /\bi(?:'| a)?m\s+(a\s+)?(real\s+)?(human|person)\b/i,
  /\bi\s+am\s+(a\s+)?(real\s+)?(human|person)\b/i,
  /\bnot\s+a\s+(bot|ai|robot)\b/i,
  /\bben\s+ger[çc]ek\s+bir\s+insan[ıi]m\b/i,
  /\bbot\s+de[ğg]ilim\b/i,
];

export function violatesIdentityRule(reply: string): boolean {
  return HUMAN_CLAIM_PATTERNS.some((re) => re.test(reply));
}
