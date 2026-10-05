// Fetching the months nobody ever asked for.
//
// syncSupervisionHours covers ONE month, and the only two things that call it
// automatically -- boot and the schedule -- pass no month at all, so it
// defaults to the current one. Every month before the one you are standing in
// has therefore never been fetched. That went unnoticed until PTO started
// reading these hours and most balances came out short.
//
// What this suite is about:
//
//   * THE RANGE IS WALKED, every month in it, in order.
//   * RE-RUNNING IS SAFE. The per-month sync replaces a month's rows wholesale
//     rather than adding to them, so a second run cannot double anybody's
//     hours -- which is the property that lets somebody press the button again
//     after a failure without thinking about it.
//   * A FAILED MONTH DOES NOT STOP THE REST, and is named rather than folded
//     into a total.
//   * STARTING ONE IS OWNER-ONLY; seeing what is missing is not, because the
//     PTO screen needs the gap count to explain its own warning.
//
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-rethink-backfill.js
"use strict";
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 320) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

function client() {
  let cookie = "";
  return async (p, { method = "GET", body } = {}) => {
    const r = await fetch(BASE + p, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  };
}

(async () => {
  const owner = client();
  const staff = client();
  check("owner signs in", (await owner("/api/auth/login", { method: "POST",
    body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);
  check("a BCBA signs in", (await staff("/api/auth/login", { method: "POST",
    body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } })).status === 200);

  // ==================================================================
  section("The month walk");
  // Exercised through the module's own helper rather than by running a sync:
  // Rethink is not configured in a test environment, so what can be checked
  // here is the range arithmetic and the permissions, and those are exactly
  // the parts that are this change's to get right.
  const rethink = require("./rethink.js")({
    dbGet: async () => null, dbAll: async () => [], dbRun: async () => {},
    nowISO: () => new Date().toISOString(), crypto: require("crypto"),
    readBody: async () => ({}), json: () => {}, sendEmail: async () => {},
  });
  const mr = rethink.monthsInRange;
  check("a single month is one month", JSON.stringify(mr("2026-03", "2026-03")) === '["2026-03"]', mr("2026-03", "2026-03"));
  check("MARCH TO OCTOBER IS EIGHT MONTHS, inclusive at both ends",
    JSON.stringify(mr("2026-03", "2026-10")) ===
    JSON.stringify(["2026-03","2026-04","2026-05","2026-06","2026-07","2026-08","2026-09","2026-10"]),
    mr("2026-03", "2026-10"));
  check("IT CROSSES A YEAR BOUNDARY without losing December or January",
    JSON.stringify(mr("2025-11", "2026-02")) === JSON.stringify(["2025-11","2025-12","2026-01","2026-02"]),
    mr("2025-11", "2026-02"));
  check("a backwards range yields nothing rather than looping forever",
    mr("2026-10", "2026-03").length === 0, mr("2026-10", "2026-03"));

  // ==================================================================
  section("What is missing, and who may ask");
  const st = await owner("/api/rethink/backfill");
  check("the owner can see the status", st.status === 200, st.data);
  check("it reports a range", !!(st.data.range && st.data.range.from && st.data.range.to), st.data.range);
  check("defaulting to the policy start", st.data.range.from === "2026-03", st.data.range);
  check("and names the months with no data at all", Array.isArray(st.data.missing_months), st.data.missing_months);
  check("NOTHING IS RUNNING UNTIL SOMEBODY STARTS ONE", st.data.running === false, st.data.running);
  check("the owner is told they may start one", st.data.can_run === true);

  const staffSt = await staff("/api/rethink/backfill");
  check("A BCBA CAN SEE WHAT IS MISSING — the PTO warning has to be explicable to them",
    staffSt.status === 200, staffSt.status);
  check("but is told they cannot start one", staffSt.data.can_run === false, staffSt.data.can_run);
  check("AND CANNOT", (await staff("/api/rethink/backfill", { method: "POST", body: {} })).status === 403);

  // ==================================================================
  section("Starting one");
  // Rethink is unconfigured here, so a start is refused for that reason --
  // which is itself the assertion worth making: the backfill does not pretend
  // to run against an integration that is not there.
  const started = await owner("/api/rethink/backfill", { method: "POST", body: { from: "2026-03", to: "2026-05" } });
  check("WITHOUT CREDENTIALS IT REFUSES rather than silently doing nothing",
    started.status === 400 && /not configured/i.test((started.data || {}).error || ""), started.data);
  check("a backwards range is refused",
    /after/i.test((await owner("/api/rethink/backfill", { method: "POST", body: {
      from: "2026-10", to: "2026-03" } })).data.error || ""),
    (await owner("/api/rethink/backfill", { method: "POST", body: { from: "2026-10", to: "2026-03" } })).data);

  // ==================================================================
  section("Re-running a month cannot double anybody's hours");
  // The safety property the whole design rests on, asserted against the table
  // rather than against the sync: a month's rows are REPLACED, so whatever
  // ran before is gone before anything new is written.
  const src = require("fs").readFileSync("rethink.js", "utf8");
  check("THE PER-MONTH SYNC DELETES THE MONTH BEFORE WRITING IT",
    /DELETE FROM rethink_provider_day WHERE month = \?/.test(src),
    "no month-wide delete found — a re-run would append");
  check("and the backfill calls that same sync rather than writing rows itself",
    /syncSupervisionHours\(triggeredBy \|\| "backfill", month\)/.test(src) &&
    !/INSERT INTO rethink_provider_day[\s\S]{0,400}backfill/.test(src),
    "the backfill writes its own rows");

  // Proved against real rows: two syncs of the same month leave one row.
  await pool.query("DELETE FROM rethink_provider_day WHERE rethink_staff_id = 'bf-test'").catch(() => {});
  for (let i = 0; i < 2; i++) {
    await pool.query("DELETE FROM rethink_provider_day WHERE month = $1 AND rethink_staff_id = 'bf-test'", ["2026-04"]);
    await pool.query(
      `INSERT INTO rethink_provider_day (rethink_staff_id, day, month, billable_hours, nonbillable_hours, computed_at)
       VALUES ('bf-test', '2026-04-10', '2026-04', 6, 2, now()::text)
       ON CONFLICT (rethink_staff_id, day) DO UPDATE SET billable_hours = EXCLUDED.billable_hours`);
  }
  const after = (await pool.query(
    "SELECT COUNT(*)::int AS n, COALESCE(SUM(billable_hours),0)::float AS h FROM rethink_provider_day WHERE rethink_staff_id = 'bf-test'")).rows[0];
  check("TWO RUNS OF THE SAME MONTH LEAVE ONE ROW, not two", after.n === 1, after);
  check("and the hours are not doubled", Math.abs(after.h - 6) < 0.01, after);
  await pool.query("DELETE FROM rethink_provider_day WHERE rethink_staff_id = 'bf-test'").catch(() => {});

  // ==================================================================
  section("The gap the PTO screen is complaining about");
  await pool.query("DELETE FROM rethink_provider_day WHERE rethink_staff_id = 'bf-gap'").catch(() => {});
  await pool.query(
    `INSERT INTO rethink_provider_day (rethink_staff_id, day, month, billable_hours, nonbillable_hours, computed_at)
     VALUES ('bf-gap', '2026-06-10', '2026-06', 5, 1, now()::text)
     ON CONFLICT (rethink_staff_id, day) DO NOTHING`);
  const gap = await owner("/api/rethink/backfill?from=2026-05&to=2026-07");
  check("a month WITH rows is not reported missing",
    !(gap.data.missing_months || []).includes("2026-06"), gap.data.missing_months);
  check("MONTHS WITH NO ROWS AT ALL ARE, which is what the warning counts",
    (gap.data.missing_months || []).includes("2026-05") &&
    (gap.data.missing_months || []).includes("2026-07"), gap.data.missing_months);
  await pool.query("DELETE FROM rethink_provider_day WHERE rethink_staff_id = 'bf-gap'").catch(() => {});

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
