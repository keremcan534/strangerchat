import type { ProviderTranslation, TranslationProvider } from './provider.js';

/**
 * Development / offline provider.
 *
 * It does not translate — it marks the text so that anybody looking at a local
 * environment can see exactly which strings *would* have been sent to a paid
 * API, without spending anything. Never selected when a real provider is
 * configured.
 */
export class EchoTranslationProvider implements TranslationProvider {
  readonly name = 'echo';
  readonly configured = true;

  async translate(text: string, targetLanguage: string): Promise<ProviderTranslation> {
    return { text: `[${targetLanguage}] ${text}`, detectedSourceLanguage: null };
  }

  async detect(): Promise<string | null> {
    return null;
  }
}
