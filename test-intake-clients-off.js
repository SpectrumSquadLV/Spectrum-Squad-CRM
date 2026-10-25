// An Intake account with Clients switched off can still sign in.
//
// REPORTED AS: Mia (Intake) "keeps it stuck on the first page", and after a
// reload the CRM was a blank page.
//
// Intake is one of the roles that may open client records, so the first page
// loaded the client list for her. Her Access had Clients explicitly OFF, the
// server honoured that and refused, and the refusal threw out of the router:
// nothing was drawn. The sign-in card stayed on screen, or after a reload the
// page was blank.
//
//   DATABASE_URL=... node run-tests.js test-intake-clients-off.js
"use strict";

const { chromium } = require("playwright");

const BASE = process.env.BASE || "http://localhost:3009";

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else {
    fail++;
    console.log("  FAIL  " + name + (detail !== undefined
      ? "\n          -> " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : ""));
  }
};
const section = (t) => console.log("\n== " + t + " ==");

async function ownerApi() {
  let jar = "";
  const call = async (path, opts = {}) => {
    const r = await fetch(BASE + path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", ...(jar ? { Cookie: jar } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const setC = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (setC && setC.length) jar = setC.map((c) => c.split(";")[0]).join("; ");
    let body = null;
    try { body = await r.json(); } catch (e) { body = null; }
    return { status: r.status, body };
  };
  const r = await call("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
  if (r.status !== 200) throw new Error("owner login failed: " + r.status);
  return call;
}

// Her Access exactly as it was saved: Dashboard, BCBA Hub and Policies on,
// everything else -- Clients included -- off.
const MIA_ACCESS = {
  dashboard: true, pipeline: false, tasks: false, staff: false, attendance: false,
  billable: false, pto: false, supervision: false, "client-behavior": false,
  "bcba-hub": true, rethink: false, "rethink-clients": false, "rethink-staff": false,
  "dob-check": false, fidelity: false, policies: true, map: false, hr: false,
  credentialing: false, compliance: false, outbox: false, "financial-center": false,
  "signnow-import": false, "email-templates": false, "failed-emails": false,
};

(async () => {
  const owner = await ownerApi();
  const users = await owner("/api/admin/users");
  const rows = Array.isArray(users.body) ? users.body : (users.body && (users.body.users || users.body.data)) || [];
  const mia = rows.find((u) => String(u.email).startsWith("intake"));
  check("an Intake account exists to stand in for her", !!mia, users.body);

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const s = await owner("/api/admin/users/" + mia.id, { method: "PATCH", body: { module_access: MIA_ACCESS } });
    check("her Access saves", s.status === 200, s);

    section("Signing in");
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(BASE + "/", { waitUntil: "networkidle" });
    await p.fill('#login-form input[name="email"]', "intake@spectrumsquadlv.com");
    await p.fill('#login-form input[name="password"]', "TestStaff123!");
    await p.click('#login-form button[type="submit"]');
    await p.waitForTimeout(2000);
    check("THE SIGN-IN CARD GOES AWAY -- the bug that was reported",
      (await p.locator("#login-form").count()) === 0);
    check("the CRM's sidebar is drawn", (await p.locator("#view-mount").count()) === 1);

    section("Reloading");
    await p.reload({ waitUntil: "networkidle" });
    await p.waitForTimeout(2000);
    const text = await p.locator("#app").innerText().catch(() => "");
    check("a reload is not a blank page", text.trim().length > 0 && (await p.locator("#view-mount").count()) === 1, text.slice(0, 200));
    check("no uncaught errors along the way", errors.length === 0, errors);
    await ctx.close();
  } finally {
    await owner("/api/admin/users/" + mia.id, { method: "PATCH", body: { module_access: {} } }).catch(() => {});
    await browser.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
