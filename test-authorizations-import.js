// test-authorizations-import.js -- the authorization import's own shape.
//
// authorizations.js holds every number the Authorization work is built on --
// authorized, scheduled, delivered, the scheduling goal, the payer, the CPT --
// and it had no suite of its own. This is the first one, and it starts with the
// failure mode that would be worst and quietest: the INSERT's column list, its
// placeholder count and the values array drifting apart.
//
// That bug does not throw on a good day. It writes the payer into the service
// line, or the goal into the authorized hours, and every screen downstream
// reports confident nonsense.
"use strict";

const fs = require("fs");
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else {
    fail++;
    const d = detail === undefined ? "" : "\n          -> " +
      String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400);
    console.log("  FAIL  " + name + d);
  }
};
const section = (t) => console.log("\n== " + t + " ==");

const SRC = fs.readFileSync("authorizations.js", "utf8");

(async () => {
  section("The INSERT cannot silently shift a value into the wrong column");

  const insert = SRC.slice(SRC.indexOf("INSERT INTO client_authorizations"));
  const colsBlock = insert.slice(insert.indexOf("(") + 1, insert.indexOf(")"));
  const cols = colsBlock.split(",").map((c) => c.trim()).filter(Boolean);
  const valuesLine = insert.slice(insert.indexOf("VALUES ("));
  const placeholders = (valuesLine.slice(0, valuesLine.indexOf(")")).match(/\?/g) || []).length;
  check("every column has exactly one placeholder",
    cols.length === placeholders, { columns: cols.length, placeholders });

  // created_at and updated_at are appended after the vals array, so the array
  // is two shorter than the column list by design.
  const valsBlock = SRC.slice(SRC.indexOf("const vals = ["), SRC.indexOf("];", SRC.indexOf("const vals = [")));
  const valsCount = valsBlock.split("\n").slice(1)
    .join("\n")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v && !v.startsWith("//")).length;
  check("...and the values array fills all but the two timestamps",
    valsCount === cols.length - 2, { vals: valsCount, columns: cols.length });

  section("The UPDATE writes the same columns as the INSERT");

  const upd = SRC.slice(SRC.indexOf("UPDATE client_authorizations SET"));
  const updBlock = upd.slice(0, upd.indexOf("WHERE id = ?"));
  // Both plain "col = ?" and the COALESCE-guarded form count as updated.
  const updCols = [...updBlock.matchAll(/(\w+)\s*=\s*(?:COALESCE\(\?|\?)/g)].map((m) => m[1]);
  const missing = cols.filter((c) => c !== "created_at" && !updCols.includes(c));
  check("no column is inserted but never updated, which would freeze it at import one",
    missing.length === 0, missing);

  // THE ONE COLUMN THAT MUST NOT BE OVERWRITTEN BLINDLY. client_id is null
  // until a person confirms which child an exported line belongs to. A later
  // import that wrote null over that decision would un-match every
  // authorization somebody had already matched, silently.
  check("a re-import cannot un-match a client somebody confirmed",
    /client_id = COALESCE\(\?, client_id\)/.test(updBlock), updBlock.slice(0, 200));

  section("The scheduling goal's period total is kept");

  // Spectrum Squad's authorizations ARE the clinical recommendation -- the
  // authorization is granted to the recommended level. goal_total is what makes
  // that checkable per row instead of taken on trust: it is the goal as a
  // period total, sitting beside total_auth_hours. It used to be parsed and
  // then dropped on commit, so nothing downstream could compare them.
  check("goal_total is a column on the table",
    /ADD COLUMN IF NOT EXISTS goal_total REAL/.test(SRC));
  check("...it is written on insert", cols.includes("goal_total"), cols);
  check("...and refreshed on every later import", updCols.includes("goal_total"), updCols);
  check("...from the sheet's own Total Sched Goal column",
    /J: "goal_total"/.test(SRC) && /goal_total: numOrNull\(c\.J\)/.test(SRC));

  section("And it reaches a real database");

  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'client_authorizations'`);
  const live = rows.map((r) => r.column_name);
  check("the running server created the column", live.includes("goal_total"), live.length);
  for (const c of ["total_auth_hours", "scheduled_hours", "verified_hours", "goal_hours",
                   "goal_frequency", "billing_code", "payer", "expiration_date"]) {
    check(`...alongside ${c}, which the utilization figures need`, live.includes(c), live.slice(0, 12));
  }

  await pool.end();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness error:", (e && e.stack) || e); process.exit(1); });
