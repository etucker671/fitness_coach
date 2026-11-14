import { createClient } from '@supabase/supabase-js';
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { handleMcp } from './mcp.js';
import { handleRest } from './rest.js';
import { handleAuthorize } from './authorize.js';
import { secretsMatch } from './shared.js';

const supabaseFor = (env) => createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);

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

  // Runs on the cron schedule in wrangler.toml, not on web requests.
  // One tiny read counts as database activity, so the free Supabase
  // project is not paused for inactivity.
  async scheduled(controller, env) {
    const { error } = await supabaseFor(env).from('user_goals').select('id').limit(1);
    if (error) {
      // Throwing marks this run as failed in the Cloudflare dashboard.
      throw new Error(`Keep-alive query failed: ${error.message}`);
    }
    console.log('Keep-alive query OK');
  }
};
