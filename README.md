# strangerchat

Anonymous one-to-one text chat, matched by **language first**.

The product rule is not "talk to a random stranger" but:

> Talk to a real person in the language you chose — and if we can't find one,
> don't leave you waiting.

So every search walks the same ladder:

```
real human, same language, shared interest
        ↓
real human, same language
        ↓
real human, another language + machine translation
        ↓
an AI, clearly labelled as an AI
```

The AI never replaces a person. It exists so the product does not collapse into
an empty "Searching…" screen at 3am, and it is labelled 🤖 at every step.

---

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
```

No credentials, Redis or Postgres are required to run or develop. Without them:

- translation uses a local **echo** provider that marks strings instead of
  translating them, so you can see exactly what would have been billed;
- the bot uses short **scripted** replies;
- state lives in memory.

With Docker:

```bash
cp .env.example .env
docker compose up --build
```

### Tests

```bash
npm test         # 94 tests: unit + full websocket end-to-end
npm run typecheck
```

The end-to-end suite boots a real HTTP + WebSocket server and drives it with
real clients through same-language matching, cross-language translation, the AI
offer, the AI→human handoff, skip and block.

---

## Configuration

Everything is environment driven; see [`.env.example`](.env.example) for the
full list. The pieces worth knowing:

| Variable | What it does |
| --- | --- |
| `MATCH_TIER1_MS` / `TIER2` / `TIER3` | The wait ladder: 5s / 10s / 20s by default |
| `MATCH_DYNAMIC_THRESHOLDS` | Scale the ladder per language by observed match time |
| `TRANSLATION_PROVIDER` | `auto` (default), `google`, `echo`, `none` |
| `GOOGLE_TRANSLATE_API_KEY` | Cloud Translation **v2** |
| `GOOGLE_APPLICATION_CREDENTIALS` + `GOOGLE_CLOUD_PROJECT` | Cloud Translation **v3** |
| `TRANSLATION_DAILY_CHAR_LIMIT` | Platform-wide daily character cap |
| `BOT_MODE` | `launch` (auto fallback) or `mature` (AI only on request) |
| `BOT_PROVIDER` | `auto`, `anthropic`, `openai-compatible`, `scripted` |
| `BOT_DAILY_COST_LIMIT_USD` | Hard stop on AI spend per day |
| `ADMIN_TOKEN` | Enables the cost dashboard endpoints |

Translation credentials stay on the server. The browser talks only to this
backend and has no idea which translation vendor is behind it.

---

## HTTP API

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Liveness plus live counts |
| `GET /api/config` | Language list, interest vocabulary, bot mode |
| `GET /api/languages` | How many people are waiting per language |
| `GET /api/admin/stats` | Per-language health, queue state, cache hit rate |
| `GET /api/admin/cost` | Translation spend and AI spend, tracked separately |

The admin endpoints return `404` unless `ADMIN_TOKEN` is set and sent as
`Authorization: Bearer …` or `X-Admin-Token`.

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" localhost:3000/api/admin/cost
```

```json
{
  "day": "2026-09-19",
  "translation": { "charactersUsed": 41500, "state": "ok", "costUsd": 0.83 },
  "ai": { "messages": 132, "sessions": 41, "costUsd": 1.24,
          "averageCostPerSessionUsd": 0.0302, "state": "ok" },
  "totalCostUsd": 2.07
}
```

---

## Architecture

```
                         FRONTEND
                            │  WebSocket /ws
                            ▼
                   ┌────────────────┐
                   │  CHAT SERVER   │
                   └───────┬────────┘
            ┌──────────────┼───────────────┐
            ▼              ▼               ▼
      MATCH ENGINE       REDIS         POSTGRES
            │
     ┌──────┴────────┐
     ▼               ▼
 HUMAN MATCH     BOT MANAGER ──▶ AI MODEL
     │
     ▼
TRANSLATION SERVICE ──▶ GOOGLE CLOUD TRANSLATION
```

The bot hangs off the match engine's *availability result*, not off the match
engine itself. The engine only ever answers "is a human available, and at which
tier" — it has no idea a bot exists. That is what makes turning the AI fallback
down (or off) later a config change rather than a rewrite.

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) walks through each subsystem and
maps it back to the product document.

---

## Privacy

There are no profiles and no accounts. Message bodies are never written to a
database or a log. What is stored is operational only: how long matching took,
what the bot cost, and block relationships keyed by a throwaway anonymous id.

The translation cache holds short strings for 15 minutes, keyed by a hash of the
text rather than the text itself, so that "hello" is not re-billed a thousand
times a day without turning the cache into a record of conversations.

Network addresses are never stored. They are reduced to a hashed /24 or /48
prefix, used only to notice a network that has repeatedly been reported.
