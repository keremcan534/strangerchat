# Deploying

The app is a single long-lived process: it holds WebSocket connections, keeps
the waiting pool and rooms in memory, and sweeps the pool on a timer. That rules
out static hosts and shapes every option below.

- **GitHub Pages** — static files only. It can serve `public/`, but not the chat
  server, which is the part that matters. No.
- **Vercel** — Functions gained native WebSocket support in 2026, but a
  connection is pinned to one function instance and *subsequent* connections are
  not guaranteed the same one. Two users landing on different instances would
  never see each other, so the matching engine breaks. There is also a 5-minute
  connection cap (30 on Pro, in beta). Running here means moving the queue,
  rooms, bot sessions and message relay into Redis and pub/sub first — see
  "Making it serverless" below.
- **Any container host** — works as-is. The whole thing, frontend included, is
  one image on one URL.

For a demo, use a container host.

---

## Fastest path: Render (free)

The free instance type supports WebSockets, which is all this needs. `render.yaml`
is already in the repo.

1. Push the branch to GitHub (done).
2. Go to [dashboard.render.com](https://dashboard.render.com) → **New** →
   **Blueprint**.
3. Pick this repository and the branch. Render reads `render.yaml`, sees
   `runtime: docker`, and builds from the `Dockerfile`.
4. It will ask for `ANTHROPIC_API_KEY`, `GOOGLE_TRANSLATE_API_KEY` and
   `ADMIN_TOKEN`. **All three can be left blank** — see the next section.
5. **Apply**. First build takes a few minutes; then you have
   `https://<name>.onrender.com`.

Nothing else is required. No database, no Redis, no credentials: without
`DATABASE_URL` and `REDIS_URL` the platform runs entirely in memory, which is
exactly right for one instance serving a demo.

### Free-plan caveats worth knowing before you demo

- The service **sleeps after 15 minutes** with no traffic and takes about a
  minute to wake. Open the link yourself a minute or two before showing anyone.
  Once a chat is live, WebSocket messages count as traffic, so it stays awake.
- 750 instance-hours per month per workspace.
- One instance, no persistent disk. Fine here — two people in the same
  conversation are always on that one instance — but a restart drops in-flight
  chats.

### Making the demo look right

Without credentials the app falls back to stand-in providers, and the home
screen says so in a yellow notice. Specifically:

- translated messages come back tagged (`[en] Bugün nasılsın?`) instead of
  actually translated;
- the AI answers from a short phrasebook rather than a model.

Both are correct behaviour, but to someone being *shown* the product they read
as broken. For a demo that lands, set two variables in the Render dashboard
(Environment → Add) and redeploy:

| Variable | Gets you |
| --- | --- |
| `GOOGLE_TRANSLATE_API_KEY` | Real translation via Cloud Translation v2 |
| `ANTHROPIC_API_KEY` | A real AI conversation partner |

The yellow notice disappears on its own once either is set. Costs are capped by
`TRANSLATION_DAILY_CHAR_LIMIT` (500k characters/day) and
`BOT_DAILY_COST_LIMIT_USD` ($25/day), so a demo cannot run away with your bill.

### Demo pacing

`render.yaml` shortens the wait ladder to 3s / 6s / 12s, because the real
defaults (5s / 10s / 20s) make a live demo drag. Delete those three variables
to get the documented behaviour back.

### Showing it off in two minutes

1. Open the link in two windows, one of them a private window — matching refuses
   to pair a browser with itself.
2. Pick **Türkçe** in one and **English** in the other, and the same interest in
   both. They match across languages and messages are translated in both
   directions, with **Show original** on each one.
3. In a third window pick a language nobody else is using — Suomi, say. After
   about 12 seconds you get the AI offer. Accept it, then ask the bot
   "are you human?".
4. Leave that AI chat open and start a search in a fourth window in the same
   language — the AI chatter is offered the real person.

---

## Other container hosts

`railway.json` and `fly.toml` are in the repo and use the same `Dockerfile`.

- **Railway** — New Project → Deploy from GitHub repo. No free tier any more;
  trial credits, then usage-based.
- **Fly.io** — `fly launch --no-deploy` then `fly deploy`. No free tier for new
  accounts either; a couple of dollars a month for an always-on machine.
- **Your own VPS** — `docker compose up -d --build` brings up the app with Redis
  and Postgres. Put a reverse proxy in front that forwards `Upgrade` and
  `Connection` headers for `/ws`, and set `TRUST_PROXY=true`.

---

## Going past a demo

The single-instance setup holds until one process stops being enough. Then, in
order:

1. Add `DATABASE_URL` and `REDIS_URL`. Nothing in the code changes — telemetry
   starts persisting, the translation cache and daily counters become shared,
   and cost tracking survives restarts.
2. To run more than one instance, the state that is still in memory — the
   waiting pool, rooms and bot sessions — has to move to Redis, with pub/sub
   relaying messages between instances. That is the same work "Making it
   serverless" needs, and it is the point at which Vercel becomes viable.

Until then, one instance is not a shortcut: it is the reason the matching
engine can be simple.
