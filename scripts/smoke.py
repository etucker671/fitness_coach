#!/usr/bin/env python3
"""Smoke test for the fitness Worker (REST routes and MCP tools).

Usage:
    npx wrangler dev --port 8799 < /dev/null     # in one terminal
    python3 scripts/smoke.py                      # in another
    python3 scripts/smoke.py https://fitness-memory-worker.<account>.workers.dev

Reads CUSTOM_API_SECRET from .dev.vars (or the environment). Talks to the real database, so it only
writes throwaway rows dated 2000-01-01 and deletes them afterwards. It never changes the goals plan.
Exits non-zero if any check fails.
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8799").rstrip("/")
TEST_DATE = "2000-01-01"
LOG_TABLES = ["meals", "exercises", "body_metrics", "daily_notes"]
ALL_TABLES = LOG_TABLES + ["user_goals", "daily_summaries"]
EXPECTED_TOOLS = {
    "get_goals", "update_goals", "log_meals", "log_exercise", "log_body_metrics", "log_daily_note",
    "list_entries", "get_daily_summaries", "update_entry", "delete_entry",
}


def load_secret():
    if os.environ.get("CUSTOM_API_SECRET"):
        return os.environ["CUSTOM_API_SECRET"]
    path = os.path.join(os.path.dirname(__file__), "..", ".dev.vars")
    with open(path) as f:
        for line in f:
            if line.startswith("CUSTOM_API_SECRET="):
                return line.split("=", 1)[1].strip()
    sys.exit("CUSTOM_API_SECRET not found in .dev.vars or the environment")


SECRET = load_secret()
failures = []


def check(label, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        failures.append(label)


def http(method, path, body=None, token=SECRET, extra=None):
    headers = dict(extra or {})
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    req = urllib.request.Request(f"{BASE}/{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            status, text = r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        status, text = e.code, e.read().decode()
    try:
        return status, json.loads(text)
    except ValueError:
        return status, text


def rest(table, query=""):
    return http("GET", f"{table}{query}")[1]


def rpc(method, params=None, token=SECRET):
    body = {"jsonrpc": "2.0", "id": 1, "method": method}
    if params is not None:
        body["params"] = params
    return http("POST", "mcp", body, token=token, extra={"Accept": "application/json, text/event-stream"})


def tool(name, **arguments):
    """Call an MCP tool. Returns (is_error, parsed_json_or_text)."""
    _, reply = rpc("tools/call", {"name": name, "arguments": arguments})
    result = reply["result"]
    text = result["content"][0]["text"]
    try:
        return result.get("isError", False), json.loads(text)
    except ValueError:
        return result.get("isError", False), text


def counts():
    return {t: len(rest(t)) for t in ["meals", "exercises", "body_metrics", "daily_notes", "user_goals"]}


def cleanup():
    for table in LOG_TABLES:
        for row in rest(table):
            if row["log_date"] == TEST_DATE:
                http("DELETE", f"{table}?id={row['id']}")


def main():
    cleanup()  # in case an earlier run was interrupted
    before = counts()
    plan_before = rest("user_goals")[0]["plan_data"]
    print(f"Target: {BASE}\nRow counts before: {before}\n")

    print("REST: auth and routing")
    check("no token is 401", http("GET", "meals", token=None)[0] == 401)
    check("wrong token is 401", http("GET", "meals", token="nope")[0] == 401)
    check("unknown table is 404", http("GET", "nope")[0] == 404)
    check("unsupported method is 405", http("PUT", "meals", {})[0] == 405)
    check("PATCH without id is 400", http("PATCH", "meals", {})[0] == 400)
    check("DELETE without id is 400", http("DELETE", "meals")[0] == 400)

    print("REST: reads")
    for t in ALL_TABLES:
        status, rows = http("GET", t)
        check(f"GET /{t} returns a list", status == 200 and isinstance(rows, list))
    for t in LOG_TABLES + ["daily_summaries"]:
        dates = [r["log_date"] for r in rest(t)]
        check(f"/{t} is newest first", dates == sorted(dates, reverse=True))
    check("?days= narrows results", len(rest("meals", "?days=30")) <= len(rest("meals")))

    print("REST: write cycle on throwaway rows")
    _, meal = http("POST", "meals", [{"log_date": TEST_DATE, "food_name": "SMOKE", "quantity": 1, "units": "g", "calories": 10}])
    check("POST /meals inserts", isinstance(meal, list) and meal[0]["food_name"] == "SMOKE")
    _, patched = http("PATCH", f"meals?id={meal[0]['id']}", {"calories": 20})
    check("PATCH /meals?id updates", patched[0]["calories"] == 20)
    _, first = http("POST", "body_metrics", {"log_date": TEST_DATE, "weight_lbs": 1})
    _, second = http("POST", "body_metrics", {"log_date": TEST_DATE, "waist_inches": 2})
    check("POST /body_metrics upserts and merges", second[0]["id"] == first[0]["id"] and second[0]["weight_lbs"] == 1)
    cleanup()
    check("REST test rows removed", all(r["log_date"] != TEST_DATE for t in LOG_TABLES for r in rest(t)))

    print("MCP: protocol")
    check("/mcp without a token is 401", http("POST", "mcp", {}, token=None)[0] == 401)
    _, init = rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "smoke", "version": "1"}})
    check("initialize returns instructions", len(init["result"].get("instructions", "")) > 500)
    tools = {t["name"]: t for t in rpc("tools/list")[1]["result"]["tools"]}
    check("all 10 tools are listed", set(tools) == EXPECTED_TOOLS, str(set(tools) ^ EXPECTED_TOOLS))
    check("delete_entry is flagged destructive", tools["delete_entry"]["annotations"]["destructiveHint"] is True)
    check("read tools are flagged read-only", all(tools[n]["annotations"]["readOnlyHint"] for n in ["get_goals", "list_entries", "get_daily_summaries"]))
    for n in ["update_entry", "delete_entry", "update_goals"]:
        check(f"{n} requires confirm", "confirm" in tools[n]["inputSchema"]["required"])

    print("MCP: reads")
    err, goals = tool("get_goals")
    check("get_goals returns the plan", not err and "plan_data" in goals[0])
    err, rows = tool("list_entries", table="meals", days=30)
    check("list_entries days=30 matches REST", not err and len(rows) == len(rest("meals", "?days=30")))
    err, one = tool("list_entries", table="meals", start_date="2026-09-29", end_date="2026-09-29")
    check("list_entries single day", not err and all(r["log_date"] == "2026-09-29" for r in one))
    check("days with a date range is rejected", tool("list_entries", table="meals", days=7, start_date="2026-09-01")[0])
    check("start after end is rejected", tool("list_entries", table="meals", start_date="2026-09-10", end_date="2026-09-01")[0])
    err, days = tool("get_daily_summaries", days=30)
    check("get_daily_summaries works", not err and isinstance(days, list))

    print("MCP: write cycle on throwaway rows")
    err, m = tool("log_meals", meals=[{"log_date": TEST_DATE, "food_name": "SMOKE", "quantity": 1, "units": "g", "calories": 50}])
    check("log_meals inserts", not err and m[0]["protein_g"] == 0)
    err, x = tool("log_exercise", exercises=[{"log_date": TEST_DATE, "activity_description": "SMOKE", "calories_burned": 5}])
    check("log_exercise inserts", not err)
    check("log_exercise rejects calories_burned 0", tool("log_exercise", exercises=[{"log_date": TEST_DATE, "activity_description": "x", "calories_burned": 0}])[0])
    err, b1 = tool("log_body_metrics", log_date=TEST_DATE, weight_lbs=1)
    err, b2 = tool("log_body_metrics", log_date=TEST_DATE, waist_inches=2)
    check("log_body_metrics merges on the same date", not err and b2[0]["id"] == b1[0]["id"] and b2[0]["weight_lbs"] == 1)
    err, n = tool("log_daily_note", log_date=TEST_DATE, energy_level=5)
    check("log_daily_note inserts", not err)
    check("log_daily_note rejects energy 11", tool("log_daily_note", log_date=TEST_DATE, energy_level=11)[0])
    mid = m[0]["id"]
    check("update_entry without confirm is refused", tool("update_entry", table="meals", id=mid, fields={"calories": 1})[0])
    check("...and changed nothing", [r for r in rest("meals") if r["id"] == mid][0]["calories"] == 50)
    err, upd = tool("update_entry", table="meals", id=mid, fields={"calories": 75}, confirm=True)
    check("update_entry with confirm works", not err and upd[0]["calories"] == 75)
    check("update_entry rejects non-editable columns", tool("update_entry", table="meals", id=mid, fields={"id": 999}, confirm=True)[0])
    check("update_entry on a missing id errors", tool("update_entry", table="meals", id=987654321, fields={"calories": 1}, confirm=True)[0])
    check("delete_entry without confirm is refused", tool("delete_entry", table="meals", id=mid)[0])
    check("...and deleted nothing", any(r["id"] == mid for r in rest("meals")))
    for table, row in [("meals", m[0]), ("exercises", x[0]), ("body_metrics", b1[0]), ("daily_notes", n[0])]:
        err, gone = tool("delete_entry", table=table, id=row["id"], confirm=True)
        check(f"delete_entry removes a {table} row", not err and gone[0]["id"] == row["id"])
    check("delete_entry on a missing id errors", tool("delete_entry", table="meals", id=mid, confirm=True)[0])

    print("MCP: update_goals refusals (nothing is written)")
    check("no confirm is refused", tool("update_goals", plan_data=plan_before)[0])
    check("empty plan is refused", tool("update_goals", plan_data={}, confirm=True)[0])
    first_key = next(iter(plan_before))
    err, msg = tool("update_goals", plan_data={first_key: plan_before[first_key]}, confirm=True)
    check("partial plan is refused", err and "missing these existing top-level sections" in msg)
    check("plan is unchanged", rest("user_goals")[0]["plan_data"] == plan_before)

    cleanup()
    after = counts()
    print(f"\nRow counts after: {after}")
    check("real data untouched (row counts unchanged)", before == after)
    print(f"\n{len(failures)} failed" if failures else "\nAll checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        code = main()
    finally:
        cleanup()
    sys.exit(code)
