# Architecture

How the platform is put together, and where each part of the product document
("Random Text Chat Platform — Dil Eşleştirme, Gerçek Zamanlı Çeviri ve AI Bot
Sistemi", v1.1) lives in the code.

---

## 1. The shape of a session

There are no accounts and no profiles (§3). A session is created when a socket
connects and carries only what matching needs:

```
preferred_language            what the user chose; matching uses this
detected_language             what Google says they actually write in
translation_enabled           true while paired across languages
translation_target_language   the partner's language
interests                     up to five, from a fixed vocabulary
```

Interests come from a closed list (`src/config/languages.ts`) so that "shared
interest" is a comparable thing rather than free text.

`src/types.ts`, `src/chat/server.ts`

---

## 2. Matching (§4, §5, §7, §31)

`src/matching/` holds two pieces that are deliberately separate:

**`scoring.ts`** is pure and synchronous. Everything needing I/O — block lists,
"have these two met before" — is resolved into a `PairContext` first, so the
ranking rules can be tested directly.

```
same language                 +100
first shared interest          +30
each further shared interest   +10
never matched before           +10
translation required           -20
partner just left              -50
blocked                      -9999
same abuse cluster           -9999
```

> The document's weight table and its worked example disagree slightly: the
> table says "+30 for a shared interest, +10 for each additional", the example
> scores two shared interests as 30 + 30. The table is implemented, since it is
> the normative list, and both readings give the same ordering in the
> document's own example. Every weight is an environment variable.

**`engine.ts`** owns the waiting pool and the escalation ladder:

| Waited | What becomes matchable |
| --- | --- |
| 0–5s | same language **and** a shared interest |
| 5–10s | same language, any interest |
| 10s+ | any language, with translation |
| 20s+ | the AI offer becomes due |

Each user climbs **their own** ladder, and a pairing is made only when the tier
it needs is unlocked for *both* sides. Without that rule, somebody who just
arrived would be pulled into a cross-language match by a person who had been
waiting for a minute, losing the same-language priority the product promises
them. The cost is that two lonely users in different languages wait out the
shorter of their two ladders; the benefit is that the priority order actually
holds.

---

## 3. Language health (§6, §26, §27)

"We have 10,000 users" says nothing about whether a Turkish speaker will find
someone. So availability is measured per language:

```
active_users  waiting_users  average_match_time  match_success_rate  bot_usage_rate
```

Two things consume it:

- **Ladder scaling.** A language matching in 2s can afford to hold out for a
  same-language partner; one averaging 40s should escalate sooner. The
  thresholds are multiplied by `healthy_avg / observed_avg`, clamped to
  [0.5×, 2.5×].
- **Fallback pressure** (`low` / `medium` / `high`), which decides how eagerly
  the AI is offered. Before there are enough samples the live queue is the only
  evidence available, so an empty queue reads as high pressure.

A bot conversation is recorded as `matched: false, usedBot: true`. Keeping those
apart is what makes `match_success_rate` mean "found a human" rather than
"stopped waiting".

`src/stats/language-stats.ts`

---

## 4. Translation (§8–§15)

```
chat server → TranslationService → TranslationProvider → Google Cloud
```

The chat server never sees a vendor. `TranslationService` owns provider choice,
caching, the budget and the failure path; `TranslationProvider` is the seam
where Google could be swapped for a local model.

**Google** (`providers/google.ts`) supports both authentication shapes:

- an API key, hitting Cloud Translation **v2**;
- a service account, signing a JWT and exchanging it for an access token to hit
  Cloud Translation **v3**.

On a user's *first* translated message the source language is left off so Google
auto-detects it, which is how `detected_language` gets filled. After that the
declared source is passed — cheaper and more accurate.

**Cache (§12).** Only strings of ≤120 characters, for 15 minutes, keyed by a
hash of the normalised text. That covers the repetition that actually drives
cost ("hi", "how are you") without making the cache a durable record of private
messages.

**Budget (§13).** A message is sent to the API only if the whole string fits in
what is left of the daily character allowance, so a message is never
half-translated and the cap is never overshot. At 80% the platform warns; at
100% translation is refused and the chat falls back to original text.

**Failure (§15).** One retry, then degrade. A non-retryable 4xx skips the retry.
After a failure the provider is skipped entirely for 15 seconds so an outage
does not turn every message into a doomed API call. `translate()` never throws:
the caller gets the original text and a reason, and the conversation continues.

`src/translation/`, `src/cost/budget.ts`

---

## 5. The AI fallback (§16–§30, §42, §43)

**The bot is not inside the matching engine.** The engine produces an
availability result — "still waiting, tier 3, nobody else in this language" —
and the Bot Manager consumes it. The engine has no branch for bots. That is what
makes §43's "mature mode" (AI stays, automatic fallback goes) a flag rather than
surgery.

```
MATCH ENGINE
     │
     ├── human matching
     └── availability result
                │
                ▼
          BOT MANAGER ──▶ AI PROVIDER (cloud | local | scripted)
```

**Transparency (§17, §20).** The offer says plainly that it is an AI, the chat
header carries a 🤖 badge, and a direct "are you human?" is answered
deterministically — matched against patterns in a dozen languages and answered
from a fixed table, before the model is ever called. A model reply that claims
to be human is replaced rather than forwarded. Relying on the system prompt
alone would make an explicit product promise merely probable.

**Language (§19, §30).** The bot writes in the user's chosen language directly.
It is never routed through the translation service.

**Handoff (§18 scenario D, §29).** While someone is with the AI, the server
watches the pool for a waiting user in the same language. When one appears the
user is offered the choice. If they take it, the time they already spent waiting
is carried over, so the handoff lands on a match immediately instead of
restarting their ladder from zero.

**Cost (§25, §34).** Per-session time limits, a cooldown between AI chats, and
daily message and dollar caps. Past the cap the bot degrades to a localised "I
can't reply right now" instead of failing.

`src/bot/`

---

## 6. Safety (§5)

Two hard exclusions, both worth −9999:

**Blocks** are symmetric and survive a restart when Postgres is configured.

**Abuse clusters** deserve a note. A shared network prefix is *not* an abuse
cluster. Campuses, mobile carriers and entire countries sit behind a handful of
prefixes, and treating those as clusters makes the platform unusable for the
people on them — an early version did exactly that, and no two users behind one
NAT could ever match. A network becomes a cluster only after it has actually
attracted reports, and it stops being one when those age out. Two tabs from one
browser are handled separately, by the anonymous-id check in the engine.

Addresses are reduced to a hashed /24 or /48 prefix and never stored raw.

`src/safety/`

---

## 7. Transport

One WebSocket at `/ws`, JSON messages, validated and normalised on arrival
(`src/chat/protocol.ts`). Unsupported languages and unknown interests are
rejected at the edge rather than deep in the engine.

Every message the server sends carries what the client needs to render the three
signals of §38 — 🟢 Human, 🌐 Translated, 🤖 AI — so the client never has to
infer what the system did. A translated message always carries its original
alongside it, which is what makes "Show original" (§10) a local toggle rather
than a round-trip.

---

## 8. Storage

| Store | Holds | Required? |
| --- | --- | --- |
| Memory | Connections, rooms, the waiting pool | always |
| Redis | Translation cache, daily counters, pair history | no |
| Postgres | Match events, bot sessions, language stats, usage, blocks | no |

Both backends degrade to in-process implementations with the same semantics, so
the platform boots and the test suite runs without either. Telemetry writes are
fire-and-forget: a database problem must never interrupt a live conversation.

Schema: `db/migrations/001_init.sql`. No message body is ever persisted.

---

## 9. Tuning it in production

The document is right that the wait thresholds should not stay fixed. The
numbers to watch are in `/api/admin/stats`:

- `averageMatchTimeMs` per language — drives ladder scaling automatically.
- `matchSuccessRate` vs `botUsageRate` — if bot usage climbs in a language whose
  success rate is fine, the ladder is escalating too eagerly.
- Translation cache `hitRate` — the cheapest lever on translation spend.
- `/api/admin/cost` — translation and AI tracked separately, because they scale
  with different things.

When a language becomes reliably fast, `BOT_MODE=mature` retires the automatic
offer there without removing the feature.
