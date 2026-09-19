-- Random Text Chat Platform — base schema (spec §32, §33).
--
-- Design note: the platform is profile-less and anonymous, so nothing here
-- stores message bodies or anything that identifies a person. Rows are
-- operational telemetry (how long matching took, what the bot cost) plus the
-- minimum state needed to keep abuse controls working across restarts.

CREATE TABLE IF NOT EXISTS chat_sessions (
    id                          TEXT PRIMARY KEY,
    anonymous_user_id           TEXT        NOT NULL,
    preferred_language          TEXT        NOT NULL,
    detected_language           TEXT,
    translation_enabled         BOOLEAN     NOT NULL DEFAULT TRUE,
    translation_target_language TEXT,
    interests                   TEXT[]      NOT NULL DEFAULT '{}',
    started_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at                    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS chat_sessions_anon_idx  ON chat_sessions (anonymous_user_id);
CREATE INDEX IF NOT EXISTS chat_sessions_start_idx ON chat_sessions (started_at DESC);

-- One row per completed matching attempt. Feeds average_match_time and
-- match_success_rate in language_statistics.
CREATE TABLE IF NOT EXISTS match_events (
    id                   BIGSERIAL PRIMARY KEY,
    language_code        TEXT        NOT NULL,
    partner_language     TEXT,
    tier                 TEXT        NOT NULL,   -- same-language-interest | same-language | cross-language | bot | abandoned
    translation_required BOOLEAN     NOT NULL DEFAULT FALSE,
    matched              BOOLEAN     NOT NULL,
    wait_ms              INTEGER     NOT NULL,
    common_interests     INTEGER     NOT NULL DEFAULT 0,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS match_events_lang_time_idx ON match_events (language_code, created_at DESC);

-- §32 — rolled up periodically from match_events plus live queue state.
CREATE TABLE IF NOT EXISTS language_statistics (
    language_code      TEXT PRIMARY KEY,
    active_users       INTEGER     NOT NULL DEFAULT 0,
    waiting_users      INTEGER     NOT NULL DEFAULT 0,
    average_match_time INTEGER,                  -- milliseconds
    match_success_rate REAL,
    bot_usage_rate     REAL,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- §33
CREATE TABLE IF NOT EXISTS bot_sessions (
    id                    TEXT PRIMARY KEY,
    anonymous_user_id     TEXT        NOT NULL,
    language              TEXT        NOT NULL,
    personality           TEXT        NOT NULL,
    started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at              TIMESTAMPTZ,
    message_count         INTEGER     NOT NULL DEFAULT 0,
    human_match_available BOOLEAN     NOT NULL DEFAULT FALSE,
    handoff_offered       BOOLEAN     NOT NULL DEFAULT FALSE,
    handoff_accepted      BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS bot_sessions_started_idx ON bot_sessions (started_at DESC);

-- §34-35 — translation and AI spend are tracked separately, per UTC day.
CREATE TABLE IF NOT EXISTS usage_daily (
    day                    DATE PRIMARY KEY,
    translation_characters BIGINT NOT NULL DEFAULT 0,
    translation_requests   BIGINT NOT NULL DEFAULT 0,
    translation_cost_usd   NUMERIC(12, 6) NOT NULL DEFAULT 0,
    bot_messages           BIGINT NOT NULL DEFAULT 0,
    bot_input_tokens       BIGINT NOT NULL DEFAULT 0,
    bot_output_tokens      BIGINT NOT NULL DEFAULT 0,
    bot_cost_usd           NUMERIC(12, 6) NOT NULL DEFAULT 0,
    bot_sessions           BIGINT NOT NULL DEFAULT 0
);

-- §5 — hard exclusions. Stored by anonymous id, expires on its own.
CREATE TABLE IF NOT EXISTS blocks (
    blocker_anonymous_id TEXT        NOT NULL,
    blocked_anonymous_id TEXT        NOT NULL,
    reason               TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at           TIMESTAMPTZ,
    PRIMARY KEY (blocker_anonymous_id, blocked_anonymous_id)
);

CREATE INDEX IF NOT EXISTS blocks_blocked_idx ON blocks (blocked_anonymous_id);

CREATE TABLE IF NOT EXISTS abuse_clusters (
    anonymous_user_id TEXT PRIMARY KEY,
    cluster_id        TEXT        NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS abuse_clusters_cluster_idx ON abuse_clusters (cluster_id);
