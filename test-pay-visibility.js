// test-pay-visibility.js -- what somebody earns, and who the CRM hands it to.
//
// hourly_rate lives on hr_employees because the raise calculator needs a place
// to keep it. hr.js reads employees with SELECT *, so the column arrived in
// every staff payload the moment RBT Fidelity added it -- and the HR module
// lets in roles that are deliberately refused every raise route. A hiring
// manager and an interviewer were being handed the whole roster's pay.
//
// The rule this suite exists to hold: NOBODY SEES WHAT ANYBODY EARNS unless
// pay is their job. Every assertion is paired with a positive control, because
// an absent field is also what a request that failed looks like.
//
//   DATABASE_URL=... node server.js
//   node test-pay-visibility.js
"use strict";

const BASE = process.env.BASE || "http://localhost:3009";
const OWNER_PW = process.env.OWNER_PASSWORD || "TestOwner123!";

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

async function login(email, password) {
  const res = await fetch(BASE + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error("login failed for " + email + ": " + res.status);
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  return async (path, opts = {}) => {
    const r = await fetch(BASE + path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, data: ct.includes("json") ? await r.json().catch(() => ({})) : await r.text() };
  };
}

(async () => {
  const owner = await login("admin@spectrumsquadlv.com", OWNER_PW);
  const stamp = Date.now().toString().slice(-6);
  const PW = "PayVisible123!";

  const mkUser = async (label, role) => {
    const email = `pay.${label}.${stamp}@example.invalid`;
    const c = await owner("/api/admin/users", {
      method: "POST", body: { name: `Pay ${label} ${stamp}`, email, password: PW, role },
    });
    if (c.status !== 201) throw new Error(`could not create ${label}: ${JSON.stringify(c.data)}`);
    return { id: c.data.id, email, req: await login(email, PW) };
  };

  const e = await owner("/api/hr/employees", {
    method: "POST",
    body: { name: `Pay Emp ${stamp}`, email: `payemp.${stamp}@example.invalid`,
            role_title: "RBT", status: "active", hire_date: "2024-01-01" },
  });
  const empId = e.data && e.data.id;
  if (!empId) throw new Error("no employee: " + JSON.stringify(e.data));

  const RATE = 27.5;
  const setRate = await owner(`/api/fidelity/employee/${empId}/pay`, {
    method: "PUT", body: { hourly_rate: RATE },
  });
  check("a pay rate can be put on file from the raise screen", setRate.status === 200, setRate.data);

  // ================================================================
  section("The owner can see pay — the positive control for everything below");

  let r = await owner(`/api/hr/employees/${empId}`);
  check("the owner's staff record carries the rate",
    r.status === 200 && Number(r.data.hourly_rate) === RATE, r.data && r.data.hourly_rate);
  r = await owner("/api/hr/employees");
  let row = (r.data || []).find((x) => x.id === empId);
  check("...and so does the roster", !!row && Number(row.hourly_rate) === RATE, row && row.hourly_rate);

  // ================================================================
  section("Nobody else is handed what somebody earns");

  // Every one of these roles reaches the HR module. None of them may see a
  // raise -- so none of them may see the number a raise is calculated from.
  for (const role of ["admin", "hr_admin", "hiring_manager", "interviewer"]) {
    const u = await mkUser(role, role);

    const list = await u.req("/api/hr/employees");
    const listed = (list.data || []).find((x) => x.id === empId);
    check(`a ${role} still gets the staff roster`, list.status === 200 && !!listed, list.status);
    check(`...with NO pay on it`,
      !!listed && !("hourly_rate" in listed), listed && listed.hourly_rate);

    const det = await u.req(`/api/hr/employees/${empId}`);
    check(`a ${role} still gets the staff record`, det.status === 200 && det.data.id === empId, det.status);
    check(`...with NO pay on it either`,
      det.status === 200 && !("hourly_rate" in det.data), det.data && det.data.hourly_rate);
    check(`...and the record is genuinely populated, not an empty object`,
      det.status === 200 && !!det.data.name, det.data && det.data.name);

    const raise = await u.req(`/api/fidelity/raise/${empId}`);
    check(`...and the raise itself is refused to a ${role}`, raise.status === 403, raise.status);
  }

  // A clinical user is outside HR altogether. Asserted so the suite would
  // notice if the module gate itself ever opened up.
  const clin = await mkUser("clinical", "clinical");
  r = await clin.req("/api/hr/employees");
  check("a clinical user is refused the staff roster outright", r.status === 403, r.status);

  // ================================================================
  section("Setting pay is leadership's, not HR's");

  const hrAdmin = await mkUser("hrpay", "hr_admin");
  r = await hrAdmin.req(`/api/fidelity/employee/${empId}/pay`, {
    method: "PUT", body: { hourly_rate: 99 },
  });
  check("an hr_admin cannot set a pay rate", r.status === 403, r.status);
  r = await owner(`/api/hr/employees/${empId}`);
  check("...and the rate on file is untouched", Number(r.data.hourly_rate) === RATE, r.data.hourly_rate);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness error:", (e && e.stack) || e); process.exit(1); });
