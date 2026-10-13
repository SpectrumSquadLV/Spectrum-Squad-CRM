// The training-only login, and the floor underneath it.
//
// Company-wide compliance training has to reach every employee -- RBTs, Squad
// Leaders, front desk -- and adding somebody to the staff directory has never
// created a CRM account. So there is a role whose whole purpose is to let an
// employee sign in, do the training the practice requires of them, and see
// their own record of it.
//
// WHY THIS IS AN ALLOWLIST. Most of this CRM gates on "is your role in this
// list", so a role on no list reaches nothing. Not everything does: the
// dashboard, Tasks & Alerts, the Requests Hub, Report a Concern and
// /api/staff -- which hands over every colleague's name and email -- all
// admit any signed-in user on purpose. The role matrix snapshot is what
// showed the new role arriving with all of them.
//
// Blocking by name would then need revisiting every time a module is added,
// and the failure is silent: nobody notices that the newest screen is on an
// RBT's sidebar. Allowing by name means a new module is closed to this role
// until somebody decides otherwise. That is the property these tests defend,
// so one of them asks about a path that does not exist.
//
//   DATABASE_URL=... node run-tests.js test-employee-role.js
"use strict";

const { Pool } = require("pg");
const crypto = require("crypto");
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
  await owner("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });

  // ==================================================================
  section("The role exists and can be given to somebody");
  const cat = (await owner("/api/admin/users")).data.roles || [];
  const role = cat.find((r) => r.key === "employee");
  check("it is in the role catalogue, so it can be picked in Admin Settings", !!role, cat.map((r) => r.key));
  check("...and is not marked privileged", role && role.privileged === false, role);
  check("...and says what it is for", role && /training/i.test(role.label + " " + role.description), role);

  const EMAIL = "zz.employee.probe@spectrumsquadlv.com";
  const PW = "EmployeeProbe123!";
  await q("DELETE FROM users WHERE lower(email) = lower($1)", [EMAIL]);
  const made = await owner("/api/admin/users", { method: "POST", body: { name: "Zz Employee Probe", email: EMAIL, password: PW, role: "employee" } });
  check("the owner can create an account on it", made.status === 201, made.data);
  if (made.status !== 201 || !made.data || !made.data.id) {
    // Nothing below can run without the account, and twenty follow-on
    // failures bury the one that matters.
    console.log("\n  No account could be created on the 'employee' role, so the rest of");
    console.log("  this suite cannot run. The usual cause is the role missing from");
    console.log("  ROLE_CATALOG in server.js, which is also what makes it unassignable");
    console.log("  in Admin Settings.");
    console.log(`\n${pass} passed, ${fail} failed`);
    await pool.end();
    process.exit(1);
  }

  const emp = client();
  const signedIn = await emp("/api/auth/login", { method: "POST", body: { email: EMAIL, password: PW } });
  check("the employee can sign in", signedIn.status === 200, signedIn.data);

  // ==================================================================
  section("What it may reach");
  const me = await emp("/api/auth/me");
  check("their own account", me.status === 200 && me.data && me.data.user && me.data.user.role === "employee", me.data);
  check("the sidebar's own endpoint", (await emp("/api/nav-order")).status === 200);
  const pol = await emp("/api/policies");
  check("policies, because acknowledging one IS the training", pol.status === 200, pol.status);
  check("their training (nothing there yet, but not refused)",
    [200, 404].includes((await emp("/api/compliance/my-training")).status),
    (await emp("/api/compliance/my-training")).status);

  // ==================================================================
  section("What it may not");
  const DENIED = [
    ["/api/clients", "client records"],
    ["/api/dashboard", "the dashboard"],
    ["/api/dashboard/pipeline-v2", "the client board"],
    ["/api/staff", "the staff directory -- every colleague's name and email"],
    ["/api/staff-tasks", "other people's tasks"],
    ["/api/hr/employees", "HR records"],
    ["/api/admin/users", "user administration"],
    ["/api/departments", "the department list"],
    ["/api/credentialing", "the credentialing tracker"],
    ["/api/academy", "the BCBA Academy"],
    ["/api/concerns", "concern reports"],
    ["/api/supply-requests", "supply requests"],
    ["/api/attendance/roster", "the attendance roster"],
    ["/api/fin/ledger", "anything financial"],
    ["/api/pto/balances", "PTO balances"],
  ];
  for (const [path, what] of DENIED) {
    const r = await emp(path);
    check(`refused: ${what}`, r.status === 403, { path, status: r.status });
  }

  // THE PROPERTY, not the list: a path nobody has written yet is closed.
  const future = await emp("/api/a-module-nobody-has-written-yet/overview");
  check("A PATH THAT DOES NOT EXIST IS REFUSED TOO -- the floor allows, it does not block",
    future.status === 403, future.status);
  check("...and the refusal says why, so it is not read as a bug",
    future.data && /training only/i.test(future.data.error || ""), future.data);

  // ==================================================================
  section("It cannot promote itself or anybody else");
  const promote = await emp(`/api/admin/users/${made.data.id}`, { method: "PATCH", body: { role: "owner" } });
  check("it cannot change its own role", promote.status === 403, promote.status);
  const stillEmployee = (await q("SELECT role FROM users WHERE lower(email) = lower($1)", [EMAIL])).rows[0];
  check("...and the role on file is unchanged", stillEmployee.role === "employee", stillEmployee);

  // ==================================================================
  section("Everyone else is unaffected");
  check("the owner still reads the staff directory", (await owner("/api/staff")).status === 200);
  check("the owner still reads HR", (await owner("/api/hr/employees")).status === 200);
  check("the owner still reads clients", (await owner("/api/clients")).status === 200);

  // ==================================================================
  section("The wiring");
  {
    const fs = require("fs"), path = require("path");
    const SRV = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const IDX = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    const LIB = fs.readFileSync(path.join(__dirname, "role-matrix-lib.js"), "utf8");
    check("the floor is an allowlist, not a list of blocked paths",
      /user\.role === "employee" && pathname\.startsWith\("\/api\/"\)[\s\S]{0,500}const allowed =/.test(SRV));
    check("the role is in the role matrix, so the snapshot records what it reaches",
      /"employee"/.test(LIB.slice(LIB.indexOf("const PART = {"), LIB.indexOf("};", LIB.indexOf("const PART = {")))));
    check("add-ons that admit any signed-in user are told about it in one place",
      /user\.role === "employee"[\s\S]{0,200}EMPLOYEE_ROLE_ALLOWS|EMPLOYEE_ROLE_ALLOWS[\s\S]{0,400}role === "employee"/.test(IDX));
    check("the two that do not consult module access exclude it themselves",
      /state\.user\.role === "employee"\) return false;/.test(fs.readFileSync(path.join(__dirname, "concerns-frontend.js"), "utf8"))
      && /state\.user\.role === "employee"\) return false;/.test(fs.readFileSync(path.join(__dirname, "requests-hub-frontend.js"), "utf8")));
  }

  await q("DELETE FROM users WHERE lower(email) = lower($1)", [EMAIL]).catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("\nFailures:"); failures.forEach((f) => console.log("  - " + f)); }
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await pool.end(); } catch (x) {} process.exit(1); });
