// The attendance bonus cycle has to read the hire date staff actually enter.
//
// hr_employees carries TWO hire-date columns. `hire_date` is the original;
// `hr_hire_date` was added later and is the one the Staff card writes and the
// offer-accepted flow sets. Attendance read only the old one -- so for anybody
// hired through the app the bonus cycle reported "No hire date on file" and
// never started, which is what Quiana saw.
//
// The Staff card displays `hr_hire_date || hire_date`, so the rule this pins
// is: attendance agrees with what a person sees on screen.
//
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-attendance-hire-date.js
"use strict";
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : "")); }
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

const ago = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

(async () => {
  const owner = client();
  check("owner signs in", (await owner("/api/auth/login", {
    method: "POST",
    body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" },
  })).status === 200);

  await pool.query("DELETE FROM hr_employees WHERE name LIKE 'HIREDATE %'");

  // Hired through the app: only the new column is set. This is the case that
  // was broken -- and it is the normal one for anyone onboarded since the
  // column was added.
  const viaApp = (await pool.query(
    `INSERT INTO hr_employees (name, email, hr_hire_date, status)
     VALUES ('HIREDATE ViaApp', 'hd-app@example.invalid', $1, 'active') RETURNING id`,
    [ago(200)]
  )).rows[0].id;

  // An older record that only has the original column.
  const legacy = (await pool.query(
    `INSERT INTO hr_employees (name, email, hire_date, status)
     VALUES ('HIREDATE Legacy', 'hd-legacy@example.invalid', $1, 'active') RETURNING id`,
    [ago(200)]
  )).rows[0].id;

  // Both set and disagreeing: the Staff card shows hr_hire_date, so that wins.
  const both = (await pool.query(
    `INSERT INTO hr_employees (name, email, hire_date, hr_hire_date, status)
     VALUES ('HIREDATE Both', 'hd-both@example.invalid', $1, $2, 'active') RETURNING id`,
    [ago(900), ago(200)]
  )).rows[0].id;

  // Cleared on screen stores "" rather than NULL. COALESCE alone would hand
  // back the empty string as though a date were set, and the cycle would then
  // fail on an unparseable date instead of saying plainly that none is on file.
  const blanked = (await pool.query(
    `INSERT INTO hr_employees (name, email, hire_date, hr_hire_date, status)
     VALUES ('HIREDATE Blanked', 'hd-blank@example.invalid', $1, '', 'active') RETURNING id`,
    [ago(200)]
  )).rows[0].id;

  // Genuinely none.
  const none = (await pool.query(
    `INSERT INTO hr_employees (name, email, status)
     VALUES ('HIREDATE None', 'hd-none@example.invalid', 'active') RETURNING id`
  )).rows[0].id;

  const roster = (await owner("/api/attendance/roster")).data;
  const rows = (roster && roster.staff) || [];
  check("the roster loads", Array.isArray(rows) && rows.length > 0, roster);
  const find = (id) => rows.find((r) => Number(r.employee_id) === Number(id)) || {};

  section("A hire date entered in the app is seen by attendance");
  const app = find(viaApp);
  check("the roster carries the hire date", !!app.hire_date, app);
  check("and the bonus cycle actually started",
    app.bonus_status && app.bonus_status !== "No hire date on file", app.bonus_status);
  check("with a next bonus date to work towards", !!app.bonus_next_date || !!app.bonus_cycle_start, app);

  section("An older record with only the original column still works");
  const leg = find(legacy);
  check("the legacy hire date is read", !!leg.hire_date, leg);
  check("its cycle started too",
    leg.bonus_status && leg.bonus_status !== "No hire date on file", leg.bonus_status);

  section("When both are set, the one on screen wins");
  const bo = find(both);
  check("hr_hire_date takes precedence, matching the Staff card",
    (bo.hire_date || "").slice(0, 10) === ago(200), { got: bo.hire_date, expected: ago(200) });

  section("An empty string is not a date");
  const bl = find(blanked);
  check("a blanked new column falls back to the old one rather than to ''",
    (bl.hire_date || "").slice(0, 10) === ago(200), { got: bl.hire_date });
  check("and the cycle runs on it",
    bl.bonus_status && bl.bonus_status !== "No hire date on file", bl.bonus_status);

  section("No hire date still says so plainly");
  const nn = find(none);
  check("it is reported as missing rather than guessed",
    nn.bonus_status === "No hire date on file", nn.bonus_status);
  check("and nobody is marked eligible on no information", nn.bonus_eligible !== true, nn.bonus_eligible);

  section("The precedence lives in one place");
  const fs = require("fs");
  const src = fs.readFileSync(require("path").join(__dirname, "hr-attendance.js"), "utf8");
  check("there is a single shared expression for it", /const HIRE_DATE_SQL\s*=/.test(src));
  check("no query still selects the bare old column",
    !/SELECT[^`"']*[^_]hire_date,[^`"']*FROM hr_employees/.test(src));

  await pool.query("DELETE FROM hr_employees WHERE name LIKE 'HIREDATE %'");
  await pool.end();
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
