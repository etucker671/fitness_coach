import { createClient } from '@supabase/supabase-js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';

// Most rows any read (REST GET or the list_entries tool) will return.
const MAX_ROWS = 500;

// YYYY-MM-DD for N days ago, used by the `days` filter.
const cutoffDate = (days) => new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

// Handles every MCP message (initialize, tools/list, tools/call) sent to /mcp.
async function handleMcp(request, supabase) {
  const server = new McpServer({ name: 'fitness-coach', version: '1.0.0' });

  server.registerTool(
    'get_goals',
    { description: "Get the user's current fitness plan document: their goals, daily targets, and any rules or notes they have stored. The structure is user-defined and may change, so read what is there instead of assuming specific fields." },
    async () => {
      const { data, error } = await supabase.from('user_goals').select('*');
      if (error) return { isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] };
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'log_body_metrics',
    {
      description:
        'Log weight and/or waist measurement for a date. One row per date: calling again for the same date merges the fields you send and leaves the others untouched.',
      inputSchema: {
        log_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
          .describe("The date this measurement is for, in the user's local time (YYYY-MM-DD)"),
        weight_lbs: z.number().optional().describe('Body weight in pounds'),
        waist_inches: z.number().optional().describe('Waist measurement in inches'),
      },
    },
    async (row) => {
      const { data, error } = await supabase
        .from('body_metrics')
        .upsert([row], { onConflict: 'log_date' })
        .select();
      if (error) return { isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] };
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'log_daily_note',
    {
      description:
        'Journal how the day went: energy level, challenges, victories, or general notes. One row per date: calling again for the same date merges the fields you send and leaves the others untouched.',
      inputSchema: {
        log_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
          .describe("The date this note is for, in the user's local time (YYYY-MM-DD)"),
        energy_level: z.number().int().min(1).max(10).optional().describe('Energy from 1 (drained) to 10 (great)'),
        challenges: z.string().optional().describe('What was hard today'),
        victories: z.string().optional().describe('What went well today'),
        general_notes: z.string().optional().describe('Anything else worth recording'),
      },
    },
    async (row) => {
      const { data, error } = await supabase
        .from('daily_notes')
        .upsert([row], { onConflict: 'log_date' })
        .select();
      if (error) return { isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] };
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  const mealItem = z.object({
    log_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
      .describe("The date eaten, in the user's local time (YYYY-MM-DD)"),
    log_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Use HH:MM or HH:MM:SS').optional().describe('Time eaten, if known'),
    meal_type: z.enum(['breakfast', 'lunch', 'snack', 'dinner']).optional(),
    food_name: z.string().describe('What was eaten, e.g. "Scrambled eggs"'),
    quantity: z.number().describe('How much, in the given units'),
    units: z.string().describe('e.g. "large", "slice", "g", "cup"'),
    calories: z.number().int().describe('Estimated calories for this item'),
    protein_g: z.number().optional(),
    carbs_g: z.number().optional(),
    fat_g: z.number().optional(),
    metadata: z.record(z.string(), z.any()).optional().describe('Optional extra details'),
  });

  server.registerTool(
    'log_meals',
    {
      description:
        'Log one or more food items. Estimate calories and macros yourself from what the user described before calling. Send each food as its own item in the meals array. All items are saved together or not at all.',
      inputSchema: { meals: z.array(mealItem).min(1) },
    },
    async ({ meals }) => {
      // defaultToNull: false so fields omitted from some items use the column default (0), not NULL.
      const { data, error } = await supabase.from('meals').insert(meals, { defaultToNull: false }).select();
      if (error) return { isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] };
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  const exerciseItem = z.object({
    log_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
      .describe("The date of the activity, in the user's local time (YYYY-MM-DD)"),
    activity_description: z.string().describe('What was done, e.g. "Back squat 5x5" or "Easy run"'),
    sets: z.number().int().optional(),
    reps: z.number().int().optional().describe('Reps per set'),
    weight_lbs: z.number().optional().describe('Weight used, in pounds'),
    distance_miles: z.number().optional(),
    step_count: z.number().int().optional(),
    calories_burned: z
      .number()
      .int()
      .positive()
      .describe('Estimated calories burned. Must be a real estimate greater than 0, never a placeholder.'),
    metadata: z.record(z.string(), z.any()).optional().describe('Optional extra details'),
  });

  server.registerTool(
    'log_exercise',
    {
      description:
        'Log one or more exercise entries. Before calling, make sure you have enough detail (duration, distance, pace, or sets/reps/weight) to produce a real calories_burned estimate. If the user only said something vague like "ran" or "lifted weights", ask one clarifying question first. Never invent a number or use 0. All items are saved together or not at all.',
      inputSchema: { exercises: z.array(exerciseItem).min(1) },
    },
    async ({ exercises }) => {
      // defaultToNull: false so fields omitted from some items use the column default, not NULL.
      const { data, error } = await supabase.from('exercises').insert(exercises, { defaultToNull: false }).select();
      if (error) return { isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] };
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'list_entries',
    {
      description: `List logged rows from meals, exercises, body_metrics, or daily_notes, newest first, including each row's id (needed to edit or delete a row). Returns at most ${MAX_ROWS} rows; use days to narrow the window when a table could have more.`,
      inputSchema: {
        table: z.enum(['meals', 'exercises', 'body_metrics', 'daily_notes']),
        days: z.number().int().positive().optional().describe('Only rows from the last N days'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ table, days }) => {
      let query = supabase.from(table).select('*');
      if (days) query = query.gte('log_date', cutoffDate(days));
      const { data, error } = await query
        .order('log_date', { ascending: false })
        .order('id', { ascending: false })
        .limit(MAX_ROWS);
      if (error) return { isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] };
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  // Stateless: a fresh server and transport per request, which suits Workers.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

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
    const validTables = ['user_goals', 'body_metrics', 'daily_notes', 'meals', 'exercises', 'daily_summaries'];
    const upsertByDate = ['body_metrics', 'daily_notes'];

    // If MCP is requested, handle it with the MCP server
    if (resource === 'mcp') {
      return handleMcp(request, supabase);
    }

    // Otherwise use REST (below)
    if (!validTables.includes(resource)) {
      return Response.json({ error: "Invalid Endpoint" }, { status: 404 });
    }

    // GET: Query logs or goals
    if (request.method === 'GET') {
      let query = supabase.from(resource).select('*');
      const days = url.searchParams.get('days');
      if (days) {
        query = query.gte(resource === 'user_goals' ? 'updated_at' : 'log_date', cutoffDate(days));
      }
      // Newest first, so the row cap keeps the most recent entries (user_goals is one row, no log_date).
      if (resource !== 'user_goals') query = query.order('log_date', { ascending: false });
      const { data, error } = await query.limit(MAX_ROWS);
      return Response.json(error || data);
    }

    // POST: Log new entries (or, for date-unique tables, merge into that date's row)
    if (request.method === 'POST') {
      const body = await request.json();
      const rows = Array.isArray(body) ? body : [body];
      const { data, error } = upsertByDate.includes(resource)
        ? await supabase.from(resource).upsert(rows, { onConflict: 'log_date' }).select()
        : await supabase.from(resource).insert(rows).select();
      return Response.json(error || data);
    }

    // PATCH: Modify entries by id (or the goal JSON document, which is always id=1)
    if (request.method === 'PATCH') {
      const id = url.searchParams.get('id');
      if (!id && resource !== 'user_goals') {
        return Response.json({ error: "Missing required 'id' query parameter" }, { status: 400 });
      }
      const body = await request.json();
      const { data, error } = await supabase.from(resource).update(body).eq('id', id || 1).select();
      return Response.json(error || data);
    }

    // DELETE: Remove a single entry by id
    if (request.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) {
        return Response.json({ error: "Missing required 'id' query parameter" }, { status: 400 });
      }
      const { data, error } = await supabase.from(resource).delete().eq('id', id).select();
      return Response.json(error || data);
    }

    return new Response("Method Not Allowed", { status: 405 });
  }
};