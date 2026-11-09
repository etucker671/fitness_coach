# Where this project stands, and what is left

Written when work paused (2026-11). Everything described as "done" is committed and pushed on the
`feature/mcp` branch. `main` still points at the RLS commit (`a78dd68`) and has not been updated.

## What exists

A Cloudflare Worker (`src/`) in front of Supabase, with two doors:

- **REST routes** (`/meals`, `/exercises`, `/body_metrics`, `/daily_notes`, `/user_goals`,
  `/daily_summaries`), guarded by a bearer token (`CUSTOM_API_SECRET`). Originally built for a
  ChatGPT Custom GPT Action (`openapi.json`, `instructions.md`). OpenAI is retiring Custom GPTs.
- **An MCP server at `/mcp`** (Streamable HTTP, stateless) with 10 tools: `get_goals`, `update_goals`,
  `log_meals`, `log_exercise`, `log_body_metrics`, `log_daily_note`, `list_entries`,
  `get_daily_summaries`, `update_entry`, `delete_entry`. `update_entry`, `delete_entry` and
  `update_goals` require `confirm: true`; `update_goals` also refuses to drop top-level plan sections
  unless `allow_key_removal` is true. Server instructions (in `src/mcp.js`) describe how the tools fit
  together and deliberately contain no persona.

Code layout: `index.js` (auth + router), `mcp.js`, `rest.js`, `shared.js`. `scripts/smoke.py` runs 59
checks against REST and MCP using throwaway rows dated 2000-01-01 (never touches the goals plan).

Supabase has Row Level Security on with no policies; the Worker uses the **secret key**
(`SUPABASE_SECRET_KEY`), which bypasses RLS. The publishable key is useless against the data.

## What is NOT done

1. **OAuth on `/mcp`.** Without it, no phone app can connect (Claude and ChatGPT connectors need
   OAuth; they cannot send a custom bearer header). Right now `/mcp` is only guarded by the same
   bearer token as REST, which works for curl and the smoke test only.
2. **Deploy.** The live Worker (`https://fitness-memory-worker.etucker-fitness-coach.workers.dev`)
   still runs the old REST-only code (`POST /mcp` returns 404). Nothing from `feature/mcp` is deployed.
3. **Connect and test** with real clients (see below).
4. **Merge `feature/mcp` into `main`** only after 1 to 3 work (main = known-good). It can fast-forward:
   `git checkout main && git merge --ff-only feature/mcp && git push`.
5. **README.md** does not mention `/mcp`, the tools, OAuth, or the smoke test yet.
6. **Archive** `openapi.json` and `instructions.md` into a `legacy/` folder (`git mv`). Nothing in the
   code references them.

## Getting set up again after a break

- `npm install`, then `npx wrangler login` (the login expires).
- `.dev.vars` is gitignored and holds `SUPABASE_URL`, `SUPABASE_ANON_KEY` (unused now),
  `SUPABASE_SECRET_KEY`, `CUSTOM_API_SECRET`. If it is lost, Supabase URL and keys are in the
  dashboard (Project Settings, API Keys). `CUSTOM_API_SECRET` is a made-up password (`openssl rand -hex 32`);
  set the same value in Cloudflare with `npx wrangler secret put CUSTOM_API_SECRET`.
- Cloudflare should hold secrets `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `CUSTOM_API_SECRET`
  (`npx wrangler secret list` to check; `SUPABASE_ANON_KEY` was deleted on purpose).
- Run locally: `npx wrangler dev --port 8799 < /dev/null` (the redirect stops wrangler's keyboard
  shortcuts from opening your browser), then `python3 scripts/smoke.py` in another terminal.

## OAuth design (the plan, from a draft that was built, tested locally, then rolled back)

Library: `@cloudflare/workers-oauth-provider` (1.2.x). One Worker is both authorization server and
resource server.

- Wrap the Worker in `OAuthProvider`: `apiRoute: '/mcp'` (handler = the MCP code), `defaultHandler` for
  `/authorize` and the existing bearer-token REST routes, `tokenEndpoint: '/oauth/token'`,
  `clientRegistrationEndpoint: '/oauth/register'`, `scopesSupported: ['fitness']`, and
  `resourceMetadata: { resource: PUBLIC_URL + '/mcp', authorization_servers: [PUBLIC_URL] }`.
- Build the provider per request so `PUBLIC_URL` can come from `env` (it differs locally:
  `http://localhost:8799` in `.dev.vars`, the workers.dev URL in `wrangler.toml` `[vars]`). Tokens are
  audience-bound, so a hardcoded production URL fails locally.
- Needs a KV namespace bound as `OAUTH_KV` (`npx wrangler kv namespace create OAUTH_KV`, then add the
  binding to `wrangler.toml`). The earlier namespace was deleted when the draft was rolled back.
- New secret: `OWNER_PASSWORD`. `/authorize` shows one page: client name, redirect host, a password
  field, Allow and Deny. Flow: `parseAuthRequest`, `describeConsent`, `beginConsent` (renders the form
  with its one-time handle), then on POST check the password with a constant-time comparison
  **before** `approveConsent` (which consumes the handle), then `completeAuthorization` with a fixed
  `userId: 'owner'`. Escape every client-supplied string in the HTML.
- No rate limiting on the password page, so make `OWNER_PASSWORD` long and random.
- `wrangler dev` needs `nodejs_compat` and a recent `compatibility_date` only if the build complains
  (the draft used `compatibility_date = "2025-09-01"` with `nodejs_compat`).
- Test locally with a script that registers a client (dynamic registration), loads `/authorize`,
  posts a wrong then right password, exchanges the code with PKCE (S256), then calls `/mcp`
  `initialize` and `tools/list`. Add it to `scripts/` once it works.

## After OAuth works

- Add the connector in Claude (Settings, Connectors, Add custom connector) with the `/mcp` URL; sign in
  with the owner password; check it appears in the mobile app.
- Put the coaching persona and tone in a Claude Project's instructions (it was removed from the
  server on purpose), for example: personal fitness coach, concise, direct, supportive, lead with numbers.
- Try deleting a test row from the phone and see whether the app prompts you (this shows what
  `destructiveHint` and `confirm` do in practice).
- ChatGPT: custom MCP connectors may need a paid plan and may not be available on mobile; check.
  Gemini Enterprise needs a fixed OAuth client ID and secret (create one with the provider's
  `createClient` helper).

## Parked ideas

- Weekday support (a `weekday` column on the `daily_summaries` view, maybe generated columns on
  `meals` and `exercises`; re-run `ALTER VIEW daily_summaries SET (security_invoker = true)` after
  replacing the view).
- Date-range parameters and a column allowlist for the REST routes (the MCP tools already have both).
- Proper automated tests (Vitest with the Workers pool); `scripts/smoke.py` is the stopgap.
- `npm audit` reports 3 high findings in wrangler's local-dev dependencies (`sharp`); not shipped code.
