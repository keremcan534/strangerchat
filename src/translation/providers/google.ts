/**
 * Google Cloud Translation provider (§8).
 *
 * Two authentication shapes are supported, because the two useful deployment
 * stories differ:
 *
 *   - API key  -> Cloud Translation **v2** REST. Cheapest thing to stand up.
 *   - Service account -> Cloud Translation **v3** REST, via a self-signed JWT
 *     exchanged for an access token. What you actually want in production.
 *
 * Credentials never leave the backend. The frontend has no idea Google exists.
 */
import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { config } from '../../config/index.js';
import { log } from '../../logger.js';
import {
  TranslationProviderError,
  type ProviderTranslation,
  type TranslationProvider,
} from './provider.js';

const V2_BASE = 'https://translation.googleapis.com/language/translate/v2';
const V3_BASE = 'https://translate.googleapis.com/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-translation';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export class GoogleTranslationProvider implements TranslationProvider {
  readonly name = 'google';

  private serviceAccount: ServiceAccount | null = null;
  private serviceAccountLoaded = false;
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly apiKey = config.translation.google.apiKey,
    private readonly credentialsFile = config.translation.google.credentialsFile,
    private readonly projectId = config.translation.google.projectId,
    private readonly location = config.translation.google.location,
  ) {}

  get configured(): boolean {
    return Boolean(this.apiKey || (this.credentialsFile && this.projectId));
  }

  /** v3 needs both a service-account file and a project id. */
  private get useV3(): boolean {
    return !this.apiKey && Boolean(this.credentialsFile && this.projectId);
  }

  // ------------------------------------------------------------------- auth

  private async loadServiceAccount(): Promise<ServiceAccount> {
    if (this.serviceAccountLoaded && this.serviceAccount) return this.serviceAccount;
    if (!this.credentialsFile) {
      throw new TranslationProviderError('GOOGLE_APPLICATION_CREDENTIALS is not set', undefined, false);
    }
    const raw = await readFile(this.credentialsFile, 'utf8');
    const parsed = JSON.parse(raw) as ServiceAccount;
    if (!parsed.client_email || !parsed.private_key) {
      throw new TranslationProviderError('service account file is missing client_email/private_key', undefined, false);
    }
    this.serviceAccount = parsed;
    this.serviceAccountLoaded = true;
    return parsed;
  }

  /** Self-signed JWT -> OAuth2 access token, cached until shortly before expiry. */
  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && this.accessToken.expiresAt - 60_000 > now) {
      return this.accessToken.value;
    }
    const sa = await this.loadServiceAccount();
    const issuedAt = Math.floor(now / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(
      JSON.stringify({
        iss: sa.client_email,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: issuedAt,
        exp: issuedAt + 3600,
      }),
    );
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const signature = base64url(signer.sign(sa.private_key));
    const assertion = `${header}.${claims}.${signature}`;

    const res = await this.fetchWithTimeout(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    if (!res.ok) {
      throw new TranslationProviderError(
        `token exchange failed: ${res.status} ${await safeText(res)}`,
        res.status,
        res.status >= 500,
      );
    }
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) {
      throw new TranslationProviderError('token exchange returned no access_token');
    }
    this.accessToken = {
      value: body.access_token,
      expiresAt: now + (body.expires_in ?? 3600) * 1000,
    };
    return this.accessToken.value;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.translation.google.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      const message = (err as Error).name === 'AbortError' ? 'request timed out' : (err as Error).message;
      throw new TranslationProviderError(message);
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------- translate

  async translate(text: string, targetLanguage: string, sourceLanguage?: string): Promise<ProviderTranslation> {
    return this.useV3
      ? this.translateV3(text, targetLanguage, sourceLanguage)
      : this.translateV2(text, targetLanguage, sourceLanguage);
  }

  private async translateV2(
    text: string,
    targetLanguage: string,
    sourceLanguage?: string,
  ): Promise<ProviderTranslation> {
    const payload: Record<string, unknown> = { q: text, target: targetLanguage, format: 'text' };
    // Omitting `source` lets Google auto-detect, which the product relies on
    // when the user's declared language and what they actually type disagree.
    if (sourceLanguage) payload.source = sourceLanguage;

    const res = await this.fetchWithTimeout(`${V2_BASE}?key=${encodeURIComponent(this.apiKey!)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw await httpError(res);

    const body = (await res.json()) as {
      data?: { translations?: { translatedText?: string; detectedSourceLanguage?: string }[] };
    };
    const first = body.data?.translations?.[0];
    if (!first?.translatedText) {
      throw new TranslationProviderError('empty translation response');
    }
    return {
      text: decodeEntities(first.translatedText),
      detectedSourceLanguage: first.detectedSourceLanguage ?? null,
    };
  }

  private async translateV3(
    text: string,
    targetLanguage: string,
    sourceLanguage?: string,
  ): Promise<ProviderTranslation> {
    const token = await this.getAccessToken();
    const url = `${V3_BASE}/projects/${this.projectId}/locations/${this.location}:translateText`;
    const payload: Record<string, unknown> = {
      contents: [text],
      targetLanguageCode: targetLanguage,
      mimeType: 'text/plain',
    };
    if (sourceLanguage) payload.sourceLanguageCode = sourceLanguage;

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw await httpError(res);

    const body = (await res.json()) as {
      translations?: { translatedText?: string; detectedLanguageCode?: string }[];
    };
    const first = body.translations?.[0];
    if (!first?.translatedText) {
      throw new TranslationProviderError('empty translation response');
    }
    return {
      text: decodeEntities(first.translatedText),
      detectedSourceLanguage: first.detectedLanguageCode ?? null,
    };
  }

  // ----------------------------------------------------------------- detect

  async detect(text: string): Promise<string | null> {
    try {
      if (this.useV3) {
        const token = await this.getAccessToken();
        const url = `${V3_BASE}/projects/${this.projectId}/locations/${this.location}:detectLanguage`;
        const res = await this.fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ content: text, mimeType: 'text/plain' }),
        });
        if (!res.ok) throw await httpError(res);
        const body = (await res.json()) as { languages?: { languageCode?: string }[] };
        return body.languages?.[0]?.languageCode ?? null;
      }

      const res = await this.fetchWithTimeout(`${V2_BASE}/detect?key=${encodeURIComponent(this.apiKey!)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q: text }),
      });
      if (!res.ok) throw await httpError(res);
      const body = (await res.json()) as {
        data?: { detections?: { language?: string }[][] };
      };
      return body.data?.detections?.[0]?.[0]?.language ?? null;
    } catch (err) {
      // Detection is a nice-to-have; the user's declared language is the source
      // of truth for matching (§2), so a failure here is never fatal.
      log.debug('language detection failed', { error: (err as Error).message });
      return null;
    }
  }
}

async function httpError(res: Response): Promise<TranslationProviderError> {
  const body = await safeText(res);
  // 4xx other than 429 means our request is wrong — retrying will not help.
  const retryable = res.status === 429 || res.status >= 500;
  return new TranslationProviderError(`google translation failed: ${res.status} ${body}`, res.status, retryable);
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}

/** The v2 API returns HTML-escaped text even with format=text. */
function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}
