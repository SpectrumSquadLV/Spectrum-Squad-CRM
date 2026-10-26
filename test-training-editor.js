// A training-only login with the Onboarding Training Editor grant writes the
// onboarding training, and reaches nothing else.
//
// ASKED FOR AS: "Mia is not clinical. She is coming on to help me strictly
// with the onboarding training creation and editing. She doesn't need access
// to anything else" -- and the screen she was on told her she was not an
// assigned employee.
//
// Authoring the Academy curriculum was the owner's alone, hard-coded, so no
// Access setting could hand it to anybody. The grant does that one thing: it
// does not make anybody leadership or a mentor, so no trainee's record comes
// with it, and on a training-only login it opens no other part of the CRM.
//
//   DATABASE_URL=... node run-tests.js test-training-editor.js
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

function client() {
  let jar = "";
  return async (path, opts = {}) => {
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
}
const login = async (email, password) => {
  const c = client();
  const r = await c("/api/auth/login", { method: "POST", body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status}`);
  return c;
};

const EMAIL = "training-editor@example.com";
const PASSWORD = "EditorPass123!";

(async () => {
  const owner = await login("admin@spectrumsquadlv.com", "TestOwner123!");

  section("The owner sets her up");
  const made = await owner("/api/admin/users", {
    method: "POST", body: { name: "Training Editor", email: EMAIL, password: PASSWORD, role: "employee" },
  });
  check("a training-only login is created", made.status === 200 || made.status === 201, made);
  const id = made.body && (made.body.id || (made.body.user && made.body.user.id));

  let mia = await login(EMAIL, PASSWORD);
  {
    const r = await mia("/api/academy/programs", { method: "POST", body: { name: "Not yet" } });
    check("before the grant she cannot write training", r.status === 403, r);
  }

  const g = await owner("/api/admin/users/" + id, { method: "PATCH", body: { module_access: { "training-author": true } } });
  check("the Onboarding Training Editor grant saves", g.status === 200, g);
  mia = await login(EMAIL, PASSWORD);

  section("What the grant gives her");
  {
    const e = await mia("/api/academy/enrollments");
    check("she is told she may author", e.status === 200 && e.body.can_author === true, e);
    check("...and sees nobody's onboarding record", e.body && Array.isArray(e.body.enrollments) && e.body.enrollments.length === 0, e.body);

    const p = await mia("/api/academy/programs");
    check("she can read the programmes", p.status === 200 && Array.isArray(p.body.programs), p);

    const mk = await mia("/api/academy/programs", { method: "POST", body: { name: "RBT Onboarding (test)" } });
    check("she can create a programme", mk.status === 200 || mk.status === 201, mk);
  }

  section("What it does NOT give her");
  for (const path of ["/api/clients", "/api/staff", "/api/hr/employees", "/api/admin/users",
                      "/api/academy/reports", "/api/compliance/courses", "/api/dashboard/pipeline-v2"]) {
    const r = await mia(path);
    check("refused: " + path, r.status === 403 || r.status === 404, { status: r.status });
  }

  section("Without the grant, a training-only login still cannot reach the Academy");
  {
    await owner("/api/admin/users/" + id, { method: "PATCH", body: { module_access: {} } });
    const plain = await login(EMAIL, PASSWORD);
    const r = await plain("/api/academy/programs");
    check("the Academy stays closed to an ordinary training-only login", r.status === 403, r);
    await owner("/api/admin/users/" + id, { method: "PATCH", body: { module_access: { "training-author": true } } });
  }

  section("In the browser");
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(BASE + "/", { waitUntil: "networkidle" });
    await p.fill('#login-form input[name="email"]', EMAIL);
    await p.fill('#login-form input[name="password"]', PASSWORD);
    await p.click('#login-form button[type="submit"]');
    await p.waitForTimeout(2500);
    check("she lands on the Training Editor", (await p.evaluate(() => location.hash)) === "#/training-editor",
      await p.evaluate(() => location.hash));
    const text = await p.locator("#view-mount").innerText().catch(() => "");
    check("the curriculum editor is on screen", /Edit curriculum/.test(text), text.slice(0, 300));
    check("it does not tell her she has no employee record", !/not linked to an employee record|No employee record/.test(text), text.slice(0, 300));
    const nav = await p.locator(".sidebar, nav").first().innerText().catch(() => "");
    check("her sidebar offers the editor", /Onboarding Training Editor/.test(nav), nav);
    check("...and not My Training, Clients or Staff", !/My Training|Clients|Staff/.test(nav), nav);
    check("no uncaught errors", errors.length === 0, errors);
    await ctx.close();
  } finally {
    await browser.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
