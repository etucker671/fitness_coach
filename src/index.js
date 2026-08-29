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
    const resource = url.pathname.replace(/^\/+/, '');
    const validTables = ['user_goals', 'body_metrics', 'daily_notes', 'meals', 'exercises', 'daily_summaries'];
    const upsertByDate = ['body_metrics', 'daily_notes'];

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

    // POST: Log new entries (or, for date-unique tables, merge into that date's row)
    if (request.method === 'POST') {
      const body = await request.json();
      const rows = Array.isArray(body) ? body : [body];
      const { data, error } = upsertByDate.includes(resource)
        ? await supabase.from(resource).upsert(rows, { onConflict: 'log_date' })
        : await supabase.from(resource).insert(rows);
      return Response.json(error || data);
    }

    // PATCH: Modify entries by id (or the goal JSON document, which is always id=1)
    if (request.method === 'PATCH') {
      const id = url.searchParams.get('id');
      if (!id && resource !== 'user_goals') {
        return Response.json({ error: "Missing required 'id' query parameter" }, { status: 400 });
      }
      const body = await request.json();
      const { data, error } = await supabase.from(resource).update(body).eq('id', id || 1);
      return Response.json(error || data);
    }

    // DELETE: Remove a single entry by id
    if (request.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) {
        return Response.json({ error: "Missing required 'id' query parameter" }, { status: 400 });
      }
      const { data, error } = await supabase.from(resource).delete().eq('id', id);
      return Response.json(error || data);
    }

    return new Response("Method Not Allowed", { status: 405 });
  }
};