// Saying which appointment types are billable.
//
// classifyBillable could only ever recognise a label containing the word
// "billable". Real appointment types are called "Parent Training", "Drive
// Time", "Supervision" -- so every one of those hours landed in the
// unclassified bucket, was excluded from PTO accrual, and nobody had any way
// to say otherwise. The values were already being recorded on every sync;
// there was simply no picker for them.
//
// The rule itself is unit-tested in test-rethink.js against a stubbed
// database. THIS suite is about the route: who may save a mapping, what it
// refuses, and whether saving tells the truth about what it has and has not
// changed.
//
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-billable-map.js
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
  const other = client();

  check("owner signs in", (await owner("/api/auth/login", {
    method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);

  // A REAL ADMIN, not a clinical account: this suite is about owner-only, and
  // an account refused earlier for an unrelated reason would prove nothing.
  await pool.query("UPDATE users SET role = 'admin' WHERE email = 'scheduling@spectrumsquadlv.com'");
  check("a full admin signs in", (await other("/api/auth/login", {
    method: "POST", body: { email: "scheduling@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);

  const cfg = async () => (await pool.query("SELECT * FROM rethink_config WHERE id = 1")).rows[0];
  const reset = async () => pool.query(
    "UPDATE rethink_config SET billable_values = NULL, nonbillable_values = NULL WHERE id = 1");
  await reset();

  // ==================================================================
  section("WHO MAY ANSWER THIS");
  const theirs = await other("/api/rethink/billable-map", {
    method: "PUT", body: { billable_values: ["Parent Training"], nonbillable_values: [] } });
  check("AN ADMIN CANNOT SET WHICH TYPES ARE BILLABLE — it moves real PTO hours",
    theirs.status === 403, theirs);
  const untouched = await cfg();
  check("and nothing was written by the attempt",
    !untouched.billable_values || untouched.billable_values === "[]", untouched.billable_values);

  // ==================================================================
  section("WHAT IT REFUSES");
  const both = await owner("/api/rethink/billable-map", {
    method: "PUT", body: { billable_values: ["Parent Training"], nonbillable_values: ["parent training"] } });
  check("A TYPE CANNOT BE BOTH — a contradiction is refused rather than resolved silently",
    both.status === 400, both);
  check("and the refusal names the type, so it can be fixed without guessing",
    /parent training/i.test(String(both.data && both.data.error || "")), both.data);
  const afterBoth = await cfg();
  check("nothing was saved from the contradictory request",
    !afterBoth.billable_values || afterBoth.billable_values === "[]", afterBoth.billable_values);

  // ==================================================================
  section("SAVING, AND WHAT IT SAYS ABOUT WHAT IT DID NOT DO");
  // Hours already stored were classified under the old answer. The route must
  // say so rather than leaving somebody to wonder why the figures are the same.
  await pool.query("DELETE FROM rethink_provider_day WHERE rethink_staff_id = 'bm-test'").catch(() => {});
  await pool.query(
    `INSERT INTO rethink_provider_day (rethink_staff_id, day, month, billable_hours, nonbillable_hours,
       unclassified_hours, computed_at)
     VALUES ('bm-test','2026-07-10','2026-07', 0, 0, 5, now()::text)
     ON CONFLICT (rethink_staff_id, day) DO UPDATE SET unclassified_hours = 5`);

  const saved = await owner("/api/rethink/billable-map", {
    method: "PUT", body: { billable_values: ["Parent Training", " Direct Therapy "], nonbillable_values: ["Drive Time"] } });
  check("the owner can save it", saved.status === 200, saved);
  const row = await cfg();
  check("the billable list is stored", JSON.parse(row.billable_values || "[]").includes("Parent Training"),
    row.billable_values);
  check("surrounding whitespace is trimmed, so a stray space is not a different type",
    JSON.parse(row.billable_values || "[]").includes("Direct Therapy"), row.billable_values);
  check("the non-billable list is stored", JSON.parse(row.nonbillable_values || "[]").includes("Drive Time"),
    row.nonbillable_values);
  check("SAVING NAMES THE MONTHS THAT STILL HOLD UNCLASSIFIED HOURS, because saving alone changes none of them",
    (saved.data.months_to_resync || []).includes("2026-07"), saved.data.months_to_resync);

  // ==================================================================
  section("IT COMES BACK OUT WHERE THE SCREEN READS IT");
  const status = await owner("/api/rethink/status?month=2026-07");
  check("the integration status carries the mapping",
    status.status === 200 && status.data.filter
    && (status.data.filter.billable_values || []).includes("Parent Training"),
    status.data && status.data.filter);
  check("and the non-billable side too",
    (status.data.filter.nonbillable_values || []).includes("Drive Time"),
    status.data && status.data.filter);

  // ==================================================================
  section("CLEARING IT");
  const cleared = await owner("/api/rethink/billable-map", {
    method: "PUT", body: { billable_values: [], nonbillable_values: [] } });
  check("an empty mapping is allowed — a wrong answer must be removable",
    cleared.status === 200, cleared);
  const afterClear = await cfg();
  check("and it really is empty afterwards",
    JSON.parse(afterClear.billable_values || "[]").length === 0
    && JSON.parse(afterClear.nonbillable_values || "[]").length === 0,
    [afterClear.billable_values, afterClear.nonbillable_values]);

  await pool.query("DELETE FROM rethink_provider_day WHERE rethink_staff_id = 'bm-test'").catch(() => {});
  await reset();
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
