import { createClient } from '@supabase/supabase-js';

export default {
  async fetch(request, env) {
    // 1. Bearer Token Security Check
    const authHeader = request.headers.get('Authorization');
    if (authHeader !== `Bearer ${env.CUSTOM_API_SECRET}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
    const url = new URL(request.url);
    const resource = url.pathname.replace('/', '');
    const validTables = ['user_goals', 'body_metrics', 'daily_notes', 'meals', 'exercises', 'daily_summaries'];

    if (!validTables.includes(resource)) {
      return Response.json({ error: "Invalid Endpoint" }, { status: 404 });
    }

    // GET: Query logs or goals
    if (request.method === 'GET') {
      let query = supabase.from(resource).select('*');
      const days = url.searchParams.get('days');
      if (days) {
        const cutoff = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
        query = query.gte(resource === 'user_goals' ? 'updated_at' : 'log_date', cutoff);
      }
      const { data, error } = await query;
      return Response.json(error || data);
    }

    // POST: Log new entries
    if (request.method === 'POST') {
      const body = await request.json();
      const { data, error } = await supabase.from(resource).insert(Array.isArray(body) ? body : [body]);
      return Response.json(error || data);
    }

    // PATCH: Modify entries or goal JSON document
    if (request.method === 'PATCH') {
      const id = url.searchParams.get('id');
      const body = await request.json();
      const { data, error } = await supabase.from(resource).update(body).eq('id', id || 1);
      return Response.json(error || data);
    }

    return new Response("Method Not Allowed", { status: 405 });
  }
};