import { createClient } from '@supabase/supabase-js';
import { handleMcp } from './mcp.js';
import { handleRest } from './rest.js';

export default {
  async fetch(request, env) {
    // 1. Bearer Token Security Check
    const authHeader = request.headers.get('Authorization');
    if (authHeader !== `Bearer ${env.CUSTOM_API_SECRET}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const url = new URL(request.url);
    const resource = url.pathname.replace(/^\/+/, '');

    // If MCP is requested, handle it with the MCP server
    if (resource === 'mcp') {
      return handleMcp(request, supabase);
    }

    // Otherwise use REST
    return handleRest(request, url, resource, supabase);
  },

  // Runs on the cron schedule in wrangler.toml, not on web requests.
  // One tiny read counts as database activity, so the free Supabase
  // project is not paused for inactivity.
  async scheduled(controller, env) {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
    const { error } = await supabase.from('user_goals').select('id').limit(1);
    if (error) {
      // Throwing marks this run as failed in the Cloudflare dashboard.
      throw new Error(`Keep-alive query failed: ${error.message}`);
    }
    console.log('Keep-alive query OK');
  }
};
