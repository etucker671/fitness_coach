import { secretsMatch } from './shared.js';

// The day boundary for "today's totals". The database and JavaScript both
// default to UTC, which is already tomorrow after 4 PM Pacific.
const TIME_ZONE = 'America/Los_Angeles';

// Today's date as YYYY-MM-DD and weekday as "Monday", both in Pacific time.
function pacificToday(now = new Date()) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(now);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'long' }).format(now);
  return { date, weekday };
}

// The plan's macro_targets group whose `days` list includes this weekday,
// e.g. high_carb_days on a Monday. Searches every group rather than fixed
// names, because the plan is free-form. Null if nothing matches.
function targetsFor(plan, weekday) {
  const groups = Object.values(plan?.macro_targets ?? {});
  return groups.find((group) => Array.isArray(group?.days) && group.days.includes(weekday)) ?? null;
}

// Today's eaten/burned totals and today's targets.
export async function todaysTotals(supabase) {
  const { date, weekday } = pacificToday();
  const [summary, goals] = await Promise.all([
    supabase.from('daily_summaries').select('*').eq('log_date', date).maybeSingle(),
    supabase.from('user_goals').select('plan_data').eq('id', 1).single(),
  ]);
  if (summary.error) throw new Error(`daily_summaries: ${summary.error.message}`);
  if (goals.error) throw new Error(`user_goals: ${goals.error.message}`);

  // No row yet today means nothing logged yet, so everything is 0.
  const eaten = summary.data ?? {};
  const target = targetsFor(goals.data.plan_data, weekday) ?? {};

  return {
    date,
    weekday,
    consumed: {
      calories: eaten.calories_consumed ?? 0,
      protein_g: eaten.protein_g ?? 0,
      carbs_g: eaten.carbs_g ?? 0,
      fat_g: eaten.fat_g ?? 0,
    },
    burned: eaten.calories_burned ?? 0,
    targets: {
      calories: target.calories ?? null,
      protein_g: target.protein_g ?? null,
      carbs_g: target.carbs_g ?? null,
      fat_g: target.fat_g ?? null,
    },
  };
}

// A whole number with thousands separators for display: 2200 -> "2,200".
const formatWhole = (n) => Math.round(Number(n)).toLocaleString('en-US');

// Sends today's numbers to the Pushcut widget. The input names must match
// the [[...]] variables in the widget's content. PUSHCUT_SECRET is a secret;
// PUSHCUT_WIDGET and PUSHCUT_CONTENT are plain settings in wrangler.toml.
async function pushToWidget(env, totals) {
  const url = `https://api.pushcut.io/${env.PUSHCUT_SECRET}/widgets/${encodeURIComponent(env.PUSHCUT_WIDGET)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: env.PUSHCUT_CONTENT,
      inputs: {
        'cals-consumed': formatWhole(totals.consumed.calories),
        'cals-targeted': totals.targets.calories == null ? '?' : formatWhole(totals.targets.calories),
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Pushcut ${response.status}: ${await response.text()}`);
  }
}

// Supabase occasionally rejects a request for a moment (e.g. "JWT issued at
// future"). The trigger fires only once per change, so try once more after a
// second rather than leaving the widget stale until the next log.
async function withOneRetry(task) {
  try {
    return await task();
  } catch (err) {
    console.warn('Retrying after error:', err.message);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return task();
  }
}

// Reads today's totals and sends them to the widget (retrying once), then
// returns them. Shared by the Supabase trigger route and the midnight cron.
export async function pushTodaysTotals(env, supabase) {
  const totals = await withOneRetry(async () => {
    const result = await todaysTotals(supabase);
    await pushToWidget(env, result);
    return result;
  });
  console.log(
    `Pushed to widget for ${totals.date}: ${formatWhole(totals.consumed.calories)} / ` +
      (totals.targets.calories == null ? '?' : formatWhole(totals.targets.calories))
  );
  return totals;
}

// POST /hooks/totals: called by the Supabase trigger when meals or exercises
// change. Guarded by its own secret (TOTALS_HOOK_SECRET in the X-Hook-Secret
// header), not the master API secret, so the database never holds the master key.
// Reads today's totals, sends them to the Pushcut widget, and returns them.
export async function handleTotalsHook(request, env, supabase) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  const given = request.headers.get('X-Hook-Secret') ?? '';
  if (!(await secretsMatch(given, env.TOTALS_HOOK_SECRET))) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    return Response.json(await pushTodaysTotals(env, supabase));
  } catch (err) {
    console.error('Totals hook failed:', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
