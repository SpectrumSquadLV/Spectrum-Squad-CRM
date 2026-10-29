// Picking up a last-minute shift, in one click.
//
// REPORTED AS: "there needs to be an option where staff pick up last minute
// shifts and this is a point that counts towards their score ... we didn't
// see the drop down."
//
// The matrix already had it -- picked_up_shift, -1 -- but the only way to log
// it was the last option of an "Occurrence" dropdown inside the staff card,
// under a "+ Log occurrence" button that reads as bad news. This suite proves
// the button on the roster and on the record logs exactly that earn-back.
//
//   DATABASE_URL=... node run-tests.js test-attendance-pickup.js
"use strict";

const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3009";

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "\n          -> " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : "")); }
  };
  const section = (t) => console.log("\n== " + t + " ==");

  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('#login-form input[name="email"]', { timeout: 20000 });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', "TestOwner123!");
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(2500);

  const api = (p, o) => page.evaluate(async ({ p, o }) => {
    const r = await fetch(p, { method: (o && o.method) || "GET", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: o && o.body ? JSON.stringify(o.body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { p, o });

  const stamp = Date.now().toString().slice(-6);
  const daysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  const emp = await api("/api/hr/employees", { method: "POST",
    body: { name: "Pickup Test " + stamp, email: `pickup.${stamp}@example.invalid`, role_title: "RBT", status: "active", hire_date: daysAgo(300) } });
  const empId = emp.body.id || (emp.body.employee && emp.body.employee.id);
  check("a staff member to log against", !!empId, emp.body);
  // Two call-offs: 2 points, so an earn-back has something to take off.
  await api(`/api/attendance/employee/${empId}`, { method: "POST", body: { type_key: "calloff_gt4", incident_date: daysAgo(3), notify: false } });
  await api(`/api/attendance/employee/${empId}`, { method: "POST", body: { type_key: "calloff_gt4", incident_date: daysAgo(5), notify: false } });
  const points90 = async () => {
    const r = await api(`/api/attendance/employee/${empId}`);
    return r.body && r.body.score ? Number(r.body.score.points_90) : NaN;
  };
  check("they start on 2 points", (await points90()) === 2, await points90());

  section("From the Staff Attendance list");
  await page.evaluate(() => { location.hash = "#/attendance"; });
  await page.waitForTimeout(2500);
  const btn = page.locator(`[data-att-pickup="${empId}"]`);
  check("every row has a + Picked up a shift button", (await btn.count()) === 1);
  await btn.click();
  await page.waitForSelector("#att-pu-save", { timeout: 5000 }).catch(() => {});
  const modal = await page.locator(".modal").innerText().catch(() => "");
  check("it opens its own short form, not the staff card", /Picked up a last-minute shift/.test(modal) && /1 point/.test(modal), modal);
  await page.uncheck("#att-pu-notify");
  await page.fill("#att-pu-notes", "Covered a call-off");
  await page.click("#att-pu-save");
  await page.waitForTimeout(1500);
  check("saving takes a point off", (await points90()) === 1, await points90());
  const flags = (await api(`/api/attendance/employee/${empId}`)).body.flags || [];
  const logged = flags.find((f) => f.type_key === "picked_up_shift");
  check("...logged as the matrix's picked_up_shift earn-back, at -1", logged && Number(logged.points) === -1, logged);
  check("...with the note", logged && logged.notes === "Covered a call-off", logged);

  section("From inside the staff record");
  const mount = await page.evaluate((id) => {
    const d = document.createElement("div"); d.id = "pickup-record"; document.body.appendChild(d);
    return window.HRAttendance && window.HRAttendance.renderSection(d, id, "Pickup Test").then(() => true);
  }, empId);
  check("the record renders", mount === true);
  await page.waitForSelector("#pickup-record #att-pickup-btn", { timeout: 5000 }).catch(() => {});
  check("the record has the button beside + Log occurrence", (await page.locator("#pickup-record #att-pickup-btn").count()) === 1);
  await page.click("#pickup-record #att-pickup-btn");
  await page.waitForSelector("#att-pu-save", { timeout: 5000 }).catch(() => {});
  await page.uncheck("#att-pu-notify");
  await page.click("#att-pu-save");
  await page.waitForTimeout(1500);
  check("a second pick-up takes them to 0", (await points90()) === 0, await points90());

  check("no uncaught errors", errors.length === 0, errors);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
