/**
 * Composition root.
 *
 * Builds the object graph of §44 and hands back a started server. Kept separate
 * from `index.ts` so tests can boot a real instance on an ephemeral port.
 */
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { config } from './config/index.js';
import { log } from './logger.js';
import { BotManager } from './bot/manager.js';
import type { AiProvider } from './bot/providers/provider.js';
import { ChatServer } from './chat/server.js';
import { BudgetTracker } from './cost/budget.js';
import { createRequestHandler } from './http/api.js';
import { MatchEngine } from './matching/engine.js';
import { RelationshipService } from './safety/relationships.js';
import { LanguageStats } from './stats/language-stats.js';
import { createDatabase, type Database } from './store/db.js';
import { createKeyValueStore, type KeyValueStore } from './store/kv.js';
import { TranslationService } from './translation/service.js';
import type { TranslationProvider } from './translation/providers/provider.js';

export interface AppOverrides {
  translationProvider?: TranslationProvider;
  aiProvider?: AiProvider;
}

export interface App {
  httpServer: Server;
  wss: WebSocketServer;
  chat: ChatServer;
  stats: LanguageStats;
  budget: BudgetTracker;
  bot: BotManager;
  translation: TranslationService;
  engine: MatchEngine;
  kv: KeyValueStore;
  db: Database;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

export async function createApp(overrides: AppOverrides = {}): Promise<App> {
  const kv = await createKeyValueStore(config.redisUrl);
  const db = await createDatabase(config.databaseUrl);

  const budget = new BudgetTracker(kv, db);
  const stats = new LanguageStats(db);
  const relationships = new RelationshipService(kv, db);
  const translation = new TranslationService(kv, budget, overrides.translationProvider);
  const bot = new BotManager(budget, db, kv, overrides.aiProvider);
  const engine = new MatchEngine(relationships, stats);

  const chat = new ChatServer({ engine, bot, translation, stats, relationships, budget, db });
  const handler = createRequestHandler({ stats, budget, bot, translation, chat });

  const httpServer = createServer((req, res) => {
    void handler(req, res).catch((err) => {
      log.error('request failed', { error: (err as Error).message });
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"internal"}');
    });
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 64 * 1024 });
  chat.attach(wss);
  stats.startFlushing();

  return {
    httpServer,
    wss,
    chat,
    stats,
    budget,
    bot,
    translation,
    engine,
    kv,
    db,
    listen(port = config.port, host = config.host) {
      return new Promise<number>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          const address = httpServer.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        });
      });
    },
    async close() {
      chat.stop();
      stats.stop();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await Promise.allSettled([kv.close(), db.close()]);
    },
  };
}
