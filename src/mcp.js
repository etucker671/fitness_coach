import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { MAX_ROWS, cutoffDate } from './shared.js';

// Optional date-window inputs shared by the MCP read tools. Dates are inclusive (YYYY-MM-DD).
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const dateWindowInputs = {
  start_date: dateString.optional().describe('First day to include, YYYY-MM-DD. For a single day, set start_date and end_date to the same date.'),
  end_date: dateString.optional().describe('Last day to include, YYYY-MM-DD'),
  days: z.number().int().positive().optional().describe('Shortcut for "the last N days". Cannot be combined with start_date or end_date.'),
};

// The four log tables whose rows can be listed, edited, and deleted by id.
const logTable = z.enum(['meals', 'exercises', 'body_metrics', 'daily_notes']);

// Columns update_entry may change on each table (never id, created_at, or updated_at).
const editableColumns = {
  meals: ['log_date', 'log_time', 'meal_type', 'food_name', 'quantity', 'units', 'calories', 'protein_g', 'carbs_g', 'fat_g', 'metadata'],
  exercises: ['log_date', 'activity_description', 'sets', 'reps', 'weight_lbs', 'distance_miles', 'step_count', 'calories_burned', 'metadata'],
  body_metrics: ['log_date', 'weight_lbs', 'waist_inches'],
  daily_notes: ['log_date', 'energy_level', 'challenges', 'victories', 'general_notes'],
};

// Hints to MCP clients about what each tool does (clients may use them to decide when to ask first).
// Every tool only touches our own database, so none are "open world".
const readOnly = { readOnlyHint: true, openWorldHint: false };
const additive = { destructiveHint: false, idempotentHint: false, openWorldHint: false }; // inserts new rows
const upsertNonDestructive = { destructiveHint: false, idempotentHint: true, openWorldHint: false }; // one row per date
const destructiveIdempotent = { destructiveHint: true, idempotentHint: true, openWorldHint: false }; // overwrites or deletes

// Required on tools that change or remove existing data. A call without it is rejected before any
// database work. Claude sets it deliberately, which is the cue to check with the user first.
const confirmInput = z
  .literal(true, { error: 'confirm must be true. Tell the user exactly what will change and get their go-ahead first.' })
  .describe('Set to true only once the user has asked for or approved this exact change');

const errorResult = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });

// Returns a message if the window inputs are contradictory, otherwise null.
function dateWindowError({ days, start_date, end_date }) {
  if (days && (start_date || end_date)) return 'Use either days or start_date/end_date, not both.';
  if (start_date && end_date && start_date > end_date) return 'start_date must not be after end_date.';
  return null;
}

// Narrows a query on log_date to the requested window.
function applyDateWindow(query, { days, start_date, end_date }) {
  if (days) query = query.gte('log_date', cutoffDate(days));
  if (start_date) query = query.gte('log_date', start_date);
  if (end_date) query = query.lte('log_date', end_date);
  return query;
}

// Sent to the client in the `initialize` reply. These describe how to use this server's tools, not who
// the model is (persona and tone belong to the client). The program itself (goals, targets, schedule)
// lives in the stored plan, which the model reads with get_goals.
const INSTRUCTIONS = `This server stores the user's fitness log (meals, exercise, body measurements, daily notes) and their plan. These notes explain how its tools fit together.

THE PLAN
- The user's program (its name, goals, daily targets, schedule, and rules) lives in the stored plan document, not here. It can change over time. Call get_goals before answering anything about their program, workouts, or daily targets, and follow what it says.
- The plan may contain temporary overrides (for example travel, illness, or injury) with dates. Check whether any cover today's date, or the date being discussed, and let them take priority over the usual plan.

DATES
- The server does not know the user's timezone. Always pass log_date explicitly as YYYY-MM-DD, using the user's current local date unless they name another day ("yesterday", "last Tuesday"). If you are unsure what today's date is, ask.

LOGGING
- Meals: when the user describes food in plain language, estimate calories, protein, carbs, and fat yourself, then call log_meals, one item per food. Follow any macro anchors in the plan.
- Exercise: before calling log_exercise, make sure you have enough detail (duration, distance, pace, or sets/reps/weight) for a real calories_burned estimate. If not, ask one clarifying question first. Never invent a number or use 0.
- Weight, waist, and daily notes are one row per date. Logging again for the same date merges the new fields and keeps the earlier ones.

READING
- Use get_daily_summaries for totals and trends ("how did I do this week?"). Use list_entries to see individual entries or to find a row's id. Narrow the date window with start_date and end_date; results are capped at ${MAX_ROWS} rows.
- A day missing from the summaries means nothing was logged, not zero calories.
- Never invent past entries. If you need history, fetch it.

CHANGING DATA
- To fix or remove an entry, find its id with list_entries, then use update_entry or delete_entry. Both need confirm: true, which you should set only once the user has asked for or approved that exact change. Tell them what was changed or removed afterwards. If a request is vague ("clean up last week"), show what you found and ask first.
- update_goals replaces the whole plan, not just the part you change. Always call get_goals first, change only what was asked, send the complete document, then call get_goals again to check the result.`;

// Handles every MCP message (initialize, tools/list, tools/call) sent to /mcp.
export async function handleMcp(request, supabase) {
  const server = new McpServer({ name: 'fitness-coach', version: '1.0.0' }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'get_goals',
    { description: "Get the user's current fitness plan document: their goals, daily targets, and any rules or notes they have stored. The structure is user-defined and may change, so read what is there instead of assuming specific fields.", annotations: readOnly },
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
      annotations: upsertNonDestructive,
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
      annotations: upsertNonDestructive,
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
      annotations: additive,
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
      annotations: additive,
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
      description: `List logged rows from meals, exercises, body_metrics, or daily_notes, newest first, including each row's id (needed to edit or delete a row). Filter by date with start_date/end_date (inclusive; use the same date for both to get a single day) or with days (the last N days). Returns at most ${MAX_ROWS} rows; narrow the window when a table could have more.`,
      inputSchema: {
        table: logTable,
        ...dateWindowInputs,
      },
      annotations: readOnly,
    },
    async ({ table, ...window }) => {
      const problem = dateWindowError(window);
      if (problem) return { isError: true, content: [{ type: 'text', text: problem }] };
      const { data, error } = await applyDateWindow(supabase.from(table).select('*'), window)
        .order('log_date', { ascending: false })
        .order('id', { ascending: false })
        .limit(MAX_ROWS);
      if (error) return { isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] };
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'get_daily_summaries',
    {
      description: `Per-day totals: calories consumed, protein/carbs/fat grams, calories burned, and net calories, newest day first. Best for questions about totals and trends (e.g. "how am I doing this week?"). Only days with at least one meal or exercise logged appear; a missing day means nothing was logged, not zero calories. Filter with start_date/end_date (inclusive; use the same date for both to get a single day) or with days (the last N days). Returns at most ${MAX_ROWS} days.`,
      inputSchema: dateWindowInputs,
      annotations: readOnly,
    },
    async (window) => {
      const problem = dateWindowError(window);
      if (problem) return { isError: true, content: [{ type: 'text', text: problem }] };
      const { data, error } = await applyDateWindow(supabase.from('daily_summaries').select('*'), window)
        .order('log_date', { ascending: false })
        .limit(MAX_ROWS);
      if (error) return { isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] };
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'update_entry',
    {
      description:
        'Change fields on one existing row, identified by id (get the id from list_entries). Send only the fields to change. Only data columns can be edited, not id or timestamps; the error lists the allowed fields for each table. Requires confirm: true, so make sure the user has asked for or approved this exact change before calling.',
      inputSchema: {
        table: logTable,
        id: z.number().int().describe('Row id from list_entries'),
        fields: z.record(z.string(), z.any()).describe('Column names and their new values'),
        confirm: confirmInput,
      },
      annotations: destructiveIdempotent,
    },
    async ({ table, id, fields }) => {
      const keys = Object.keys(fields);
      if (keys.length === 0) return errorResult('No fields provided.');
      const notEditable = keys.filter((k) => !editableColumns[table].includes(k));
      if (notEditable.length) {
        return errorResult(`Cannot edit ${notEditable.join(', ')} on ${table}. Editable fields: ${editableColumns[table].join(', ')}.`);
      }
      const { data, error } = await supabase.from(table).update(fields).eq('id', id).select();
      if (error) return errorResult(JSON.stringify(error));
      // The database reports success even when no row matched, so check for that.
      if (data.length === 0) return errorResult(`No row with id ${id} in ${table}.`);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'delete_entry',
    {
      description:
        'Permanently delete one row, identified by id (get the id from list_entries). This cannot be undone. Returns the deleted row so you can tell the user exactly what was removed. Requires confirm: true, so make sure the user has asked for or approved deleting this exact row before calling.',
      inputSchema: { table: logTable, id: z.number().int().describe('Row id from list_entries'), confirm: confirmInput },
      annotations: destructiveIdempotent,
    },
    async ({ table, id }) => {
      const { data, error } = await supabase.from(table).delete().eq('id', id).select();
      if (error) return errorResult(JSON.stringify(error));
      // The database reports success even when no row matched, so check for that.
      if (data.length === 0) return errorResult(`No row with id ${id} in ${table}.`);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'update_goals',
    {
      description:
        "REPLACE the user's entire plan document. This is not a merge: anything you leave out is deleted. Always call get_goals first, change only what the user asked for, and send the complete document as plan_data, then call get_goals again to check the result. If the new plan drops a top-level section the current plan has, the call is refused unless allow_key_removal is true. Requires confirm: true, so make sure the user has asked for or approved this exact change before calling.",
      inputSchema: {
        plan_data: z.record(z.string(), z.any()).describe('The complete new plan document'),
        allow_key_removal: z
          .boolean()
          .optional()
          .describe('Set true only if the user explicitly asked to delete a whole top-level section of the plan'),
        confirm: confirmInput,
      },
      annotations: destructiveIdempotent,
    },
    async ({ plan_data, allow_key_removal }) => {
      if (Object.keys(plan_data).length === 0) return errorResult('plan_data is empty. Send the complete plan document.');
      const current = await supabase.from('user_goals').select('plan_data').eq('id', 1).single();
      if (current.error) return errorResult(JSON.stringify(current.error));
      // Guard against a partial document silently deleting the rest of the plan.
      const missing = Object.keys(current.data.plan_data).filter((key) => !(key in plan_data));
      if (missing.length && !allow_key_removal) {
        return errorResult(
          `Refused: plan_data is missing these existing top-level sections: ${missing.join(', ')}. Call get_goals and send the complete document, or set allow_key_removal to true if deleting them is intended.`
        );
      }
      const { data, error } = await supabase.from('user_goals').update({ plan_data }).eq('id', 1).select();
      if (error) return errorResult(JSON.stringify(error));
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
