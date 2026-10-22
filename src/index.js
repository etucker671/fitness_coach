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
  }
};
