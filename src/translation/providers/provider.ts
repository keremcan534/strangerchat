/**
 * §11 — the chat server never talks to Google directly. It talks to the
 * Translation Service, which talks to a TranslationProvider. Swapping Google
 * for a local model or a future vendor is a provider change, nothing else.
 */
export interface ProviderTranslation {
  text: string;
  detectedSourceLanguage: string | null;
}

export interface TranslationProvider {
  readonly name: string;
  /** Whether the provider has enough configuration to be usable. */
  readonly configured: boolean;
  translate(text: string, targetLanguage: string, sourceLanguage?: string): Promise<ProviderTranslation>;
  detect(text: string): Promise<string | null>;
}

export class TranslationProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = true) {
    super(message);
    this.name = 'TranslationProviderError';
  }
}
