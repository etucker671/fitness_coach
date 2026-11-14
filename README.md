# Fitness Coach MCP Server

A Cloudflare Worker in front of a Supabase database that stores my meals, exercise, body metrics,
daily notes and fitness plan. AI apps (Perplexity, Claude, ChatGPT and others) connect to it as an
**MCP connector**, sign in with OAuth, and log and read entries through ten tools.

## Architecture

```
AI app (Perplexity, Claude, ...)
   │  MCP over HTTPS, OAuth access token
   ▼
Cloudflare Worker  fitness-memory-worker
   ├─ /mcp                    MCP server (10 tools)
   ├─ /authorize              sign-in page (owner password)
   ├─ /oauth/*, /.well-known  OAuth endpoints (handled by the library)
   ├─ /meals, /exercises ...  REST routes (bearer token)
   └─ cron, daily             keep-alive query
   │  Supabase secret key
   ▼
Supabase (PostgreSQL)  Row Level Security on, no policies: only the Worker can reach the data
```

- **Live URL:** `https://fitness-memory-worker.etucker-fitness-coach.workers.dev`
- **MCP endpoint:** `<live URL>/mcp`
- **OAuth:** [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider).
  Apps register themselves (dynamic client registration), send me to `/authorize`, and get an access
  token (1 hour) plus a refresh token. A sign-in expires after 90 days without use.
- **Cron:** once a day (12:00 UTC) the Worker runs one small query so the free Supabase project is
  not paused for inactivity.

## MCP tools

| Tool | What it does |
|---|---|
| `get_goals` | Read the plan document (goals, targets, rules) |
| `update_goals` | Replace the plan. Needs `confirm: true`; refuses to drop top-level sections unless `allow_key_removal` |
| `log_meals` | Log one or more meals |
| `log_exercise` | Log a workout |
| `log_body_metrics` | Weight and/or waist for a date (merges with that date's existing row) |
| `log_daily_note` | Free-text note for a date (merges with that date's existing row) |
| `list_entries` | Rows from one log table, newest first, with ids; date filters |
| `get_daily_summaries` | Per-day calorie and macro totals, newest first |
| `update_entry` | Change fields on one row by id. Needs `confirm: true` |
| `delete_entry` | Delete one row by id. Needs `confirm: true` |

The server's instructions explain how the tools fit together and deliberately contain no
personality. Tone and role go in the app: see [docs/coach-persona.md](docs/coach-persona.md).

## Authentication

| Route | Accepts |
|---|---|
| `/mcp` | An OAuth access token issued by this Worker, **or** `CUSTOM_API_SECRET` (for scripts and curl) |
| REST routes | `Authorization: Bearer <CUSTOM_API_SECRET>` |
| `/authorize` | No token: it is the browser sign-in page, guarded by `OWNER_PASSWORD` |

There is one user (me), so signing in is a single password. There is no rate limiting on the
sign-in page, so the production `OWNER_PASSWORD` must be long and random.

## Code layout

| File | Purpose |
|---|---|
| `src/index.js` | Entry point: builds the OAuth provider, routes requests, cron handler |
| `src/authorize.js` | The `/authorize` sign-in and consent page |
| `src/mcp.js` | MCP server: tools, server instructions, helpers |
| `src/rest.js` | REST routes |
| `src/shared.js` | Shared constants and `secretsMatch()` (constant-time comparison) |
| `db/schema.sql` | Database schema |
| `scripts/smoke.py` | 59 checks against REST and MCP (throwaway rows dated 2000-01-01) |
| `scripts/oauth_test.py` | End-to-end OAuth sign-in check (17 checks; `--browser` to sign in yourself) |
| `legacy/` | The old ChatGPT Custom GPT setup (`openapi.json`, `instructions.md`), kept for reference |

## Setup

```
npm install
npx wrangler login      # the login expires; run again if wrangler says you are not logged in
```

### Configuration

| Name | Kind | Local (`.dev.vars`) | Production |
|---|---|---|---|
| `SUPABASE_URL` | secret | yes | `wrangler secret put` |
| `SUPABASE_SECRET_KEY` | secret (`sb_secret_...`, bypasses RLS) | yes | `wrangler secret put` |
| `CUSTOM_API_SECRET` | secret, made up (`openssl rand -hex 32`) | yes | `wrangler secret put` |
| `OWNER_PASSWORD` | secret, sign-in password | a throwaway value | `wrangler secret put` (the real one) |
| `PUBLIC_URL` | plain variable, the Worker's own address | `http://localhost:8799` | `[vars]` in `wrangler.toml` |
| `OAUTH_KV` | KV namespace (clients, grants, tokens) | simulated automatically | `[[kv_namespaces]]` in `wrangler.toml` |

`.dev.vars` is gitignored and holds `NAME=value` lines. Locally, its values override `[vars]`.
`npx wrangler secret list` shows which secrets are set in production (names only).

If the Supabase keys are lost, they are in the Supabase dashboard (Project Settings, API Keys).

## Run and test locally

```
npx wrangler dev --port 8799 --test-scheduled < /dev/null    # terminal 1 (Ctrl+C to stop)
python3 scripts/smoke.py                                    # terminal 2
python3 scripts/oauth_test.py                               # asks for OWNER_PASSWORD
curl "http://localhost:8799/__scheduled?cron=0+12+*+*+*"    # run the cron handler once
```

The `< /dev/null` stops wrangler's keyboard shortcuts from opening a browser. Both scripts accept the
live URL as an argument to test production.

## Deploy

```
git status              # deploy uploads files as they are on disk, so commit first
npx wrangler deploy
python3 scripts/smoke.py https://fitness-memory-worker.etucker-fitness-coach.workers.dev
python3 scripts/oauth_test.py https://fitness-memory-worker.etucker-fitness-coach.workers.dev
```

Past cron runs: Cloudflare dashboard, Workers, fitness-memory-worker.

## Connect an app

Add a custom connector (Perplexity: Settings, Connectors; Claude: Settings, Connectors, Add custom
connector) with the `/mcp` URL and OAuth authentication, leaving client ID and secret empty. Your
browser opens the sign-in page: check the "Access will be sent to" host is the app's, enter the owner
password and click Allow. Then paste [docs/coach-persona.md](docs/coach-persona.md) into the app's
instructions (a Perplexity Space, a Claude Project).

## Gotchas

- **Free Supabase projects pause after about 7 days without database activity.** The daily cron
  prevents this. If it happens anyway, restore the project from the Supabase dashboard; the Worker
  then answers Cloudflare error 1016 until it is back.
- **Cloudflare blocks the default `Python-urllib` user agent** on workers.dev (error 1010), so the
  scripts send their own.
- **Client ID Metadata Documents (CIMD)** are off. If an app refuses to register, enabling them needs
  the `global_fetch_strictly_public` compatibility flag and `clientIdMetadataDocumentEnabled: true`.
