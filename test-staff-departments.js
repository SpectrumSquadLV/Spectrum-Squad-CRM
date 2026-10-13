// Employees belong to a department, and a fresh install still seeds.
//
// Company-wide compliance training is assigned by department, and until now
// the CRM only knew a department for a LOGIN (users.department_id). Most
// employees have no login, so for most of the workforce the question had no
// answer anywhere. Employee records now carry one.
//
// THE ORDERING TRAP THIS SUITE EXISTS FOR. ensureSeeded() decides whether a
// database is brand new by counting rows in `departments`. Adding the staffing
// departments before it asks that question tells a fresh install it has
// already been seeded, and it comes up with NO USERS AT ALL -- nobody can sign
// in, and the only symptom is a login that refuses the owner. That is a silent
// catastrophe on a new deploy, so "the owner can still sign in" is an
// assertion here and not an assumption.
//
//   DATABASE_URL=... node run-tests.js test-staff-departments.js
"use strict";

const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3009";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const q = (sql, p) => pool.query(sql, p || []);

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else {
    fail++; failures.push(name);
    console.log("  FAIL  " + name + (detail !== undefined
      ? "  -> " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 300) : ""));
  }
};
const section = (t) => console.log("\n== " + t + " ==");

function client() {
  let jar = "";
  return async (path, opts = {}) => {
    const r = await fetch(BASE + path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", ...(jar ? { Cookie: jar } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      redirect: "manual",
    });
    const setC = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (setC && setC.length) jar = setC.map((c) => c.split(";")[0]).join("; ");
    let data = null; try { data = await r.json(); } catch (e) {}
    return { status: r.status, data };
  };
}

(async () => {
  const owner = client();

  // ==================================================================
  section("A fresh install seeded, and has the staffing departments too");
  const login = await owner("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
  check("THE OWNER CAN SIGN IN -- the install actually seeded", login.status === 200, login.data);
  if (login.status !== 200) {
    // Everything below needs a signed-in owner, and a cascade of twenty
    // follow-on failures buries the one that matters. Say what it means.
    console.log("\n  The owner cannot sign in, which means this database was never seeded.");
    console.log("  The usual cause is something inserting into `departments` before");
    console.log("  ensureSeeded() counts it -- that count is how a first run is");
    console.log("  recognised, so filling the table first makes the app skip seeding.");
    console.log(`\n${pass} passed, ${fail} failed`);
    await pool.end();
    process.exit(1);
  }
  const users = (await q("SELECT COUNT(*)::int AS n FROM users")).rows[0].n;
  check("...and there are seeded accounts, not an empty users table", users >= 4, users);

  const depts = (await owner("/api/departments")).data || [];
  const keys = depts.map((d) => d.key);
  check("the original office departments are untouched",
    ["intake", "clinical", "billing", "scheduling"].every((k) => keys.includes(k)), keys);
  check("the staffing departments are there as well",
    ["rbt", "administration", "hr", "leadership"].every((k) => keys.includes(k)), keys);
  check("...and nothing was duplicated", new Set(keys).size === keys.length, keys);

  // ==================================================================
  section("A department is read from the job title, once");
  const hr = require("./hr.js");
  const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => "$" + ++i); };
  const mod = hr({
    dbGet: async (sql, p) => (await q(toPg(sql), p)).rows[0] || null,
    dbAll: async (sql, p) => (await q(toPg(sql), p)).rows,
    dbRun: async (sql, p) => q(toPg(sql), p),
    nowISO: () => new Date().toISOString(),
    readBody: async () => ({}), json: () => {},
    crypto: require("crypto"), APP_BASE_URL: BASE, sendEmail: async () => ({ ok: true }),
  });
  const { departmentForTitle, inferDepartments } = mod._internal;

  const titles = [
    ["RBT", "rbt"], ["Registered Behavior Technician", "rbt"], ["Behavior Technician", "rbt"],
    ["Squad Leader", "rbt"],
    ["BCBA", "clinical"], ["Board Certified Behavior Analyst", "clinical"], ["BCaBA", "clinical"],
    ["Occupational Therapist", "clinical"], ["Speech Therapist", "clinical"],
    ["HR Generalist", "hr"], ["Recruiter", "hr"],
    ["Clinical Director", "leadership"], ["Owner", "leadership"],
    ["Front Desk", "administration"], ["Office Manager", "administration"],
    ["Billing Specialist", "billing"], ["Scheduler", "scheduling"], ["Intake Coordinator", "intake"],
    ["", null], ["Sous Chef", null],
  ];
  titles.forEach(([title, want]) => {
    check(`"${title || "(blank)"}" -> ${want || "not set"}`, departmentForTitle(title) === want, departmentForTitle(title));
  });
  check("every department it can infer is a real department",
    titles.map(([, w]) => w).filter(Boolean).every((k) => keys.includes(k)),
    titles.map(([, w]) => w).filter(Boolean).filter((k) => !keys.includes(k)));

  const stamp = Date.now().toString(36);
  const mk = async (name, title) => (await owner("/api/hr/employees", { method: "POST", body: { name: `${name} ${stamp}`, role_title: title, email: `${name.toLowerCase()}${stamp}@x.test` } })).data.id;
  const deptOf = async (id) => (await q("SELECT department_key, department_source FROM hr_employees WHERE id = $1", [id])).rows[0];

  const ray = await mk("Ray", "RBT");
  const bea = await mk("Bea", "BCBA");
  const odd = await mk("Odd", "Sous Chef");
  const chosen = await mk("Cho", "RBT");
  await q("UPDATE hr_employees SET department_key = 'leadership', department_source = 'chosen' WHERE id = $1", [chosen]);

  // The boot pass already ran and marked itself done, so clear the mark to
  // run it over these new rows -- which is also what proves the mark works.
  await q("DELETE FROM hr_settings WHERE key = 'departments_inferred'");
  await inferDepartments();

  check("an RBT is put in Clinical — RBT", (await deptOf(ray)).department_key === "rbt", await deptOf(ray));
  check("...and marked as inferred, not chosen", (await deptOf(ray)).department_source === "inferred");
  check("a BCBA is put in Clinical", (await deptOf(bea)).department_key === "clinical", await deptOf(bea));
  check("a title it cannot read is LEFT UNSET rather than guessed",
    (await deptOf(odd)).department_key === null, await deptOf(odd));
  check("a department somebody chose is not overwritten",
    (await deptOf(chosen)).department_key === "leadership" && (await deptOf(chosen)).department_source === "chosen", await deptOf(chosen));

  // It is a one-time pass: a title corrected later is for a person to act on.
  await q("UPDATE hr_employees SET department_key = NULL, department_source = NULL WHERE id = $1", [ray]);
  await inferDepartments();
  check("a second boot does not re-decide a department somebody cleared",
    (await deptOf(ray)).department_key === null, await deptOf(ray));

  // ==================================================================
  section("Setting a department by hand");
  const set = await owner(`/api/hr/employees/${odd}`, { method: "PATCH", body: { department_key: "administration" } });
  check("HR can set a department", set.status === 200, set.data);
  check("...and it is recorded as chosen", (await deptOf(odd)).department_source === "chosen", await deptOf(odd));
  const bogus = await owner(`/api/hr/employees/${odd}`, { method: "PATCH", body: { department_key: "not-a-department" } });
  check("a department that does not exist is refused", bogus.status === 400, bogus.data);
  check("...and the old value is still there", (await deptOf(odd)).department_key === "administration");
  const cleared = await owner(`/api/hr/employees/${odd}`, { method: "PATCH", body: { department_key: "" } });
  check("it can be cleared back to not set", cleared.status === 200 && (await deptOf(odd)).department_key === null, await deptOf(odd));

  check("the roster carries the department for everyone",
    ((await owner("/api/hr/employees")).data || []).some((e) => e.id === bea && e.department_key === "clinical"));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("\nFailures:"); failures.forEach((f) => console.log("  - " + f)); }
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await pool.end(); } catch (x) {} process.exit(1); });
