/**
 * Postgres-backed persistence with a no-op fallback.
 *
 * The chat itself is entirely in memory (§44: Postgres sits beside the chat
 * server, not in its hot path). Postgres only receives telemetry and the small
 * amount of state that must outlive a process: match events, bot sessions,
 * rolled-up language statistics, daily usage and block lists.
 *
 * When DATABASE_URL is unset the platform runs fully in memory, which is what
 * local development and the test suite use.
 */
import { log } from '../logger.js';
import type { LanguageStatsSnapshot } from '../types.js';

export interface MatchEventRow {
  languageCode: string;
  partnerLanguage: string | null;
  tier: string;
  translationRequired: boolean;
  matched: boolean;
  waitMs: number;
  commonInterests: number;
}

export interface BotSessionRow {
  id: string;
  anonymousUserId: string;
  language: string;
  personality: string;
}

export interface BotSessionClose {
  id: string;
  messageCount: number;
  humanMatchAvailable: boolean;
  handoffOffered: boolean;
  handoffAccepted: boolean;
}

export interface UsageDelta {
  translationCharacters?: number;
  translationRequests?: number;
  translationCostUsd?: number;
  botMessages?: number;
  botInputTokens?: number;
  botOutputTokens?: number;
  botCostUsd?: number;
  botSessions?: number;
}

export interface Database {
  readonly enabled: boolean;
  migrate(): Promise<void>;
  recordMatchEvent(row: MatchEventRow): Promise<void>;
  startBotSession(row: BotSessionRow): Promise<void>;
  endBotSession(row: BotSessionClose): Promise<void>;
  upsertLanguageStats(snapshots: LanguageStatsSnapshot[]): Promise<void>;
  addUsage(day: string, delta: UsageDelta): Promise<void>;
  getUsage(day: string): Promise<Record<string, number> | null>;
  isBlocked(a: string, b: string): Promise<boolean>;
  addBlock(blocker: string, blocked: string, reason: string | null): Promise<void>;
  close(): Promise<void>;
}

/** Used when DATABASE_URL is not configured. Every write is dropped. */
export class NullDatabase implements Database {
  readonly enabled = false;
  async migrate(): Promise<void> {}
  async recordMatchEvent(): Promise<void> {}
  async startBotSession(): Promise<void> {}
  async endBotSession(): Promise<void> {}
  async upsertLanguageStats(): Promise<void> {}
  async addUsage(): Promise<void> {}
  async getUsage(): Promise<Record<string, number> | null> {
    return null;
  }
  async isBlocked(): Promise<boolean> {
    return false;
  }
  async addBlock(): Promise<void> {}
  async close(): Promise<void> {}
}

interface PoolLike {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export class PostgresDatabase implements Database {
  readonly enabled = true;
  constructor(private readonly pool: PoolLike, private readonly migrationSql: string) {}

  /** Swallows write errors: telemetry must never break a live conversation. */
  private async safeQuery(text: string, values?: unknown[]): Promise<void> {
    try {
      await this.pool.query(text, values);
    } catch (err) {
      log.warn('db write failed', { error: (err as Error).message });
    }
  }

  async migrate(): Promise<void> {
    await this.pool.query(this.migrationSql);
  }

  async recordMatchEvent(row: MatchEventRow): Promise<void> {
    await this.safeQuery(
      `INSERT INTO match_events
         (language_code, partner_language, tier, translation_required, matched, wait_ms, common_interests)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.languageCode,
        row.partnerLanguage,
        row.tier,
        row.translationRequired,
        row.matched,
        Math.round(row.waitMs),
        row.commonInterests,
      ],
    );
  }

  async startBotSession(row: BotSessionRow): Promise<void> {
    await this.safeQuery(
      `INSERT INTO bot_sessions (id, anonymous_user_id, language, personality)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [row.id, row.anonymousUserId, row.language, row.personality],
    );
  }

  async endBotSession(row: BotSessionClose): Promise<void> {
    await this.safeQuery(
      `UPDATE bot_sessions
          SET ended_at = NOW(),
              message_count = $2,
              human_match_available = $3,
              handoff_offered = $4,
              handoff_accepted = $5
        WHERE id = $1`,
      [row.id, row.messageCount, row.humanMatchAvailable, row.handoffOffered, row.handoffAccepted],
    );
  }

  async upsertLanguageStats(snapshots: LanguageStatsSnapshot[]): Promise<void> {
    for (const s of snapshots) {
      await this.safeQuery(
        `INSERT INTO language_statistics
           (language_code, active_users, waiting_users, average_match_time, match_success_rate, bot_usage_rate, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (language_code) DO UPDATE SET
           active_users = EXCLUDED.active_users,
           waiting_users = EXCLUDED.waiting_users,
           average_match_time = EXCLUDED.average_match_time,
           match_success_rate = EXCLUDED.match_success_rate,
           bot_usage_rate = EXCLUDED.bot_usage_rate,
           updated_at = NOW()`,
        [
          s.languageCode,
          s.activeUsers,
          s.waitingUsers,
          s.averageMatchTimeMs === null ? null : Math.round(s.averageMatchTimeMs),
          s.matchSuccessRate,
          s.botUsageRate,
        ],
      );
    }
  }

  async addUsage(day: string, delta: UsageDelta): Promise<void> {
    await this.safeQuery(
      `INSERT INTO usage_daily
         (day, translation_characters, translation_requests, translation_cost_usd,
          bot_messages, bot_input_tokens, bot_output_tokens, bot_cost_usd, bot_sessions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (day) DO UPDATE SET
         translation_characters = usage_daily.translation_characters + EXCLUDED.translation_characters,
         translation_requests   = usage_daily.translation_requests   + EXCLUDED.translation_requests,
         translation_cost_usd   = usage_daily.translation_cost_usd   + EXCLUDED.translation_cost_usd,
         bot_messages           = usage_daily.bot_messages           + EXCLUDED.bot_messages,
         bot_input_tokens       = usage_daily.bot_input_tokens       + EXCLUDED.bot_input_tokens,
         bot_output_tokens      = usage_daily.bot_output_tokens      + EXCLUDED.bot_output_tokens,
         bot_cost_usd           = usage_daily.bot_cost_usd           + EXCLUDED.bot_cost_usd,
         bot_sessions           = usage_daily.bot_sessions           + EXCLUDED.bot_sessions`,
      [
        day,
        delta.translationCharacters ?? 0,
        delta.translationRequests ?? 0,
        delta.translationCostUsd ?? 0,
        delta.botMessages ?? 0,
        delta.botInputTokens ?? 0,
        delta.botOutputTokens ?? 0,
        delta.botCostUsd ?? 0,
        delta.botSessions ?? 0,
      ],
    );
  }

  async getUsage(day: string): Promise<Record<string, number> | null> {
    try {
      const { rows } = await this.pool.query('SELECT * FROM usage_daily WHERE day = $1', [day]);
      const row = rows[0];
      if (!row) return null;
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(row)) {
        if (k === 'day') continue;
        out[k] = typeof v === 'string' ? Number.parseFloat(v) : Number(v);
      }
      return out;
    } catch (err) {
      log.warn('db read failed', { error: (err as Error).message });
      return null;
    }
  }

  async isBlocked(a: string, b: string): Promise<boolean> {
    try {
      const { rows } = await this.pool.query(
        `SELECT 1 FROM blocks
          WHERE ((blocker_anonymous_id = $1 AND blocked_anonymous_id = $2)
             OR  (blocker_anonymous_id = $2 AND blocked_anonymous_id = $1))
            AND (expires_at IS NULL OR expires_at > NOW())
          LIMIT 1`,
        [a, b],
      );
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  async addBlock(blocker: string, blocked: string, reason: string | null): Promise<void> {
    await this.safeQuery(
      `INSERT INTO blocks (blocker_anonymous_id, blocked_anonymous_id, reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (blocker_anonymous_id, blocked_anonymous_id) DO NOTHING`,
      [blocker, blocked, reason],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export async function createDatabase(databaseUrl: string | undefined): Promise<Database> {
  if (!databaseUrl) return new NullDatabase();
  try {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sqlPath = path.resolve(here, '../../db/migrations/001_init.sql');
    const sql = await readFile(sqlPath, 'utf8');

    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: databaseUrl, max: 8 });
    const db = new PostgresDatabase(pool as unknown as PoolLike, sql);
    await db.migrate();
    log.info('postgres connected');
    return db;
  } catch (err) {
    log.warn('postgres unavailable, running without persistence', {
      error: (err as Error).message,
    });
    return new NullDatabase();
  }
}
