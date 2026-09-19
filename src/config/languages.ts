/**
 * Supported chat languages (spec §2).
 *
 * The list is intentionally curated rather than pulled from the translation
 * provider at boot: the matching engine buckets waiting users by language code,
 * so every code we accept needs to be a code we are willing to keep a queue for.
 */
export interface LanguageDefinition {
  /** BCP-47 / ISO-639-1 code used everywhere in the system. */
  code: string;
  /** Endonym, shown in the picker. */
  label: string;
  /** English name, used in translation banners and bot prompts. */
  englishName: string;
  flag: string;
}

export const SUPPORTED_LANGUAGES: readonly LanguageDefinition[] = [
  { code: 'tr', label: 'Türkçe', englishName: 'Turkish', flag: '🇹🇷' },
  { code: 'en', label: 'English', englishName: 'English', flag: '🇬🇧' },
  { code: 'de', label: 'Deutsch', englishName: 'German', flag: '🇩🇪' },
  { code: 'es', label: 'Español', englishName: 'Spanish', flag: '🇪🇸' },
  { code: 'fr', label: 'Français', englishName: 'French', flag: '🇫🇷' },
  { code: 'it', label: 'Italiano', englishName: 'Italian', flag: '🇮🇹' },
  { code: 'pt', label: 'Português', englishName: 'Portuguese', flag: '🇵🇹' },
  { code: 'ru', label: 'Русский', englishName: 'Russian', flag: '🇷🇺' },
  { code: 'ar', label: 'العربية', englishName: 'Arabic', flag: '🇸🇦' },
  { code: 'hi', label: 'हिन्दी', englishName: 'Hindi', flag: '🇮🇳' },
  { code: 'ja', label: '日本語', englishName: 'Japanese', flag: '🇯🇵' },
  { code: 'ko', label: '한국어', englishName: 'Korean', flag: '🇰🇷' },
  { code: 'zh', label: '中文', englishName: 'Chinese', flag: '🇨🇳' },
  { code: 'pl', label: 'Polski', englishName: 'Polish', flag: '🇵🇱' },
  { code: 'nl', label: 'Nederlands', englishName: 'Dutch', flag: '🇳🇱' },
  { code: 'sv', label: 'Svenska', englishName: 'Swedish', flag: '🇸🇪' },
  { code: 'fi', label: 'Suomi', englishName: 'Finnish', flag: '🇫🇮' },
  { code: 'id', label: 'Bahasa Indonesia', englishName: 'Indonesian', flag: '🇮🇩' },
  { code: 'uk', label: 'Українська', englishName: 'Ukrainian', flag: '🇺🇦' },
  { code: 'fa', label: 'فارسی', englishName: 'Persian', flag: '🇮🇷' },
] as const;

const BY_CODE = new Map(SUPPORTED_LANGUAGES.map((l) => [l.code, l]));

export function isSupportedLanguage(code: string): boolean {
  return BY_CODE.has(code);
}

export function getLanguage(code: string): LanguageDefinition | undefined {
  return BY_CODE.get(code);
}

export function englishName(code: string): string {
  return BY_CODE.get(code)?.englishName ?? code;
}

/**
 * Normalises whatever the client or the provider sent ("TR", "en-GB", "zh-Hans")
 * down to a code we keep a queue for. Returns undefined when unsupported.
 */
export function normaliseLanguage(input: string | null | undefined): string | undefined {
  if (!input) return undefined;
  const base = input.trim().toLowerCase().split(/[-_]/)[0];
  if (!base) return undefined;
  return BY_CODE.has(base) ? base : undefined;
}

/** Interests are a fixed vocabulary so that "common interest" is comparable. */
export const SUPPORTED_INTERESTS: readonly string[] = [
  'gaming',
  'music',
  'movies',
  'technology',
  'sports',
  'travel',
  'books',
  'food',
  'art',
  'science',
  'language-practice',
  'random',
] as const;

const INTEREST_SET = new Set(SUPPORTED_INTERESTS);

export function normaliseInterests(input: unknown, max = 5): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim().toLowerCase();
    if (INTEREST_SET.has(value) && !out.includes(value)) out.push(value);
    if (out.length >= max) break;
  }
  return out;
}
