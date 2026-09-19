/**
 * HTTP surface.
 *
 * Two audiences: the frontend, which needs the language list and a coarse
 * sense of how busy each language is, and operators, who need the §34/§35 cost
 * dashboard. The latter is behind ADMIN_TOKEN and is off entirely when that is
 * not configured.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config/index.js';
import { SUPPORTED_INTERESTS, SUPPORTED_LANGUAGES } from '../config/languages.js';
import type { BudgetTracker } from '../cost/budget.js';
import type { BotManager } from '../bot/manager.js';
import type { ChatServer } from '../chat/server.js';
import type { LanguageStats } from '../stats/language-stats.js';
import type { TranslationService } from '../translation/service.js';
import { serveStatic } from './static.js';

export interface ApiDeps {
  stats: LanguageStats;
  budget: BudgetTracker;
  bot: BotManager;
  translation: TranslationService;
  chat: ChatServer;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function authorised(req: IncomingMessage): boolean {
  if (!config.adminToken) return false;
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const token = bearer ?? (req.headers['x-admin-token'] as string | undefined);
  return token === config.adminToken;
}

export function createRequestHandler(deps: ApiDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const { pathname } = url;

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }

    switch (pathname) {
      case '/healthz':
        json(res, 200, { ok: true, ...deps.chat.stateSnapshot() });
        return;

      case '/api/config':
        json(res, 200, {
          languages: SUPPORTED_LANGUAGES,
          interests: SUPPORTED_INTERESTS,
          bot: { enabled: config.bot.enabled, mode: config.bot.mode },
          translation: { available: deps.translation.available, provider: deps.translation.providerName },
          thresholds: {
            sameLanguageInterestMs: config.matching.sameLanguageInterestMs,
            sameLanguageAnyMs: config.matching.sameLanguageAnyMs,
            crossLanguageMs: config.matching.crossLanguageMs,
          },
        });
        return;

      // §6 — public language density, so the UI can say how busy a language is.
      case '/api/languages': {
        const snapshots = deps.stats.all();
        json(res, 200, {
          density: deps.stats.density(),
          languages: snapshots.map((s) => ({
            languageCode: s.languageCode,
            activeUsers: s.activeUsers,
            waitingUsers: s.waitingUsers,
          })),
        });
        return;
      }

      case '/api/admin/stats':
        if (!authorised(req)) {
          json(res, 404, { error: 'not found' });
          return;
        }
        json(res, 200, {
          languages: deps.stats.all(),
          density: deps.stats.density(),
          chat: deps.chat.stateSnapshot(),
          bot: deps.bot.stats(),
          translation: {
            provider: deps.translation.providerName,
            available: deps.translation.available,
            cache: deps.translation.cacheStats(),
          },
        });
        return;

      // §35 — translation spend and AI spend, tracked separately.
      case '/api/admin/cost': {
        if (!authorised(req)) {
          json(res, 404, { error: 'not found' });
          return;
        }
        const day = url.searchParams.get('day') ?? undefined;
        json(res, 200, await deps.budget.dashboard(day));
        return;
      }

      default:
        break;
    }

    if (pathname.startsWith('/api/')) {
      json(res, 404, { error: 'not found' });
      return;
    }

    if (await serveStatic(req, res, pathname)) return;

    // Single-page app: unknown non-asset paths fall back to the shell.
    if (!pathname.includes('.') && (await serveStatic(req, res, '/'))) return;

    json(res, 404, { error: 'not found' });
  };
}
