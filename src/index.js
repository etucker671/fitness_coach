import { createClient } from '@supabase/supabase-js';
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { handleMcp } from './mcp.js';
import { handleRest } from './rest.js';
import { handleAuthorize } from './authorize.js';
import { handleTotalsHook, pushTodaysTotals } from './widget.js';
import { secretsMatch } from './shared.js';

const NINETY_DAYS = 90 * 24 * 60 * 60; // in seconds
const supabaseFor =(env) => createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);

// /mcp: only reached once the provider has accepted the token
// (an OAuth access token, or the master secret via resolveExternalToken).
const mcpHandler = {
  fetch(request, env) {
    return handleMcp(request, supabaseFor(env));
  }
};

// Everything that is not /mcp and not an OAuth endpoint the library serves.
const defaultHandler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const resource = url.pathname.replace(/^\/+/, '');

    // The sign-in page is opened in a browser, which has no bearer token,
    // so it is routed before the bearer check. It is guarded by OWNER_PASSWORD.
    if (resource === 'authorize') {
      return handleAuthorize(request, env);
    }

    // Called by the Supabase trigger, which has its own secret (not the
    // master bearer token), so it is also routed before the bearer check.
    if (resource === 'hooks/totals') {
      return handleTotalsHook(request, env, supabaseFor(env));
    }

    // Bearer token check for the REST routes (unchanged).
    const authHeader = request.headers.get('Authorization') ?? '';
    if (!(await secretsMatch(authHeader, `Bearer ${env.CUSTOM_API_SECRET}`))) {
      return new Response('Unauthorized', { status: 401 });
    }

    return handleRest(request, url, resource, supabaseFor(env));
  }
};

// Built per request because the URLs depend on env.PUBLIC_URL
// (http://localhost:8799 locally, the workers.dev address when deployed).
function buildProvider(env) {
  return new OAuthProvider({
    apiRoute: '/mcp',
    apiHandler: mcpHandler,
    defaultHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: ['fitness'],
    // A sign-in lasts as long as the app keeps using it, and expires after
    // 90 days without use (refreshTokenTTL covers a brand-new sign-in,
    // refreshTokenIdleTTL every refresh after that). Access tokens: 1 hour.
    refreshTokenTTL: NINETY_DAYS,
    refreshTokenIdleTTL: NINETY_DAYS,
    resourceMetadata: {
      resource: `${env.PUBLIC_URL}/mcp`,
      authorization_servers: [env.PUBLIC_URL],
    },
    // Option B: /mcp also accepts the master secret, so smoke.py and curl keep working.
    // Called only when the token is not one this provider issued.
    async resolveExternalToken({ token, env }) {
      if (!(await secretsMatch(token, env.CUSTOM_API_SECRET))) return null;
      return { props: { userId: 'owner', via: 'master-secret' }, audience: `${env.PUBLIC_URL}/mcp` };
    },
  });
}

export default {
  fetch(request, env, ctx) {
    return buildProvider(env).fetch(request, env, ctx);
  },

  // Runs on the cron schedule in wrangler.toml (07:01 and 08:01 UTC), not on
  // web requests. It does two jobs:
  // 1. Widget reset: one of the two runs is always 12:01 AM Pacific (08:01 in
  //    winter/PST, 07:01 in summer/PDT), so the widget shows the new day's
  //    totals instead of yesterday's until the first log. The other run is harmless.
  // 2. Supabase keep-alive: reading the totals counts as database activity, so
  //    the free project is not paused for inactivity. If the widget push is
  //    ever removed, keep a small Supabase read here.
  // An error (Supabase or Pushcut) throws, which marks the run as failed in
  // the dashboard; the Supabase reads happen before the Pushcut call either way.
  async scheduled(controller, env) {
    await pushTodaysTotals(env, supabaseFor(env));
  }
};
