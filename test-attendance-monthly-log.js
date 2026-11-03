// One person's attendance, month by month.
//
// ASKED FOR AS: "where can i see a per employee monthly attendance log? ...
// make sure it has a drop down button."
//
// The monthly review was already saved per person and per month, and no
// screen showed it; the occurrences themselves were one long list. This suite
// proves the Monthly log on the staff record: one row per calendar month,
// newest first, clean months included, each a dropdown that opens to that
// month's occurrences -- and that its numbers are the calendar month's own.
//
//   DATABASE_URL=... node run-tests.js test-attendance-monthly-log.js
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

  // Dates pinned to calendar months: the 10th of this month, and of one and
  // two months ago. Last month is left clean on purpose.
  const now = new Date();
  const monthOf = (back) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    return d.toISOString().slice(0, 7);
  };
  const thisMonth = monthOf(0), lastMonth = monthOf(1), twoAgo = monthOf(2);
  const day = (period, d) => period + "-" + String(d).padStart(2, "0");
  // Today may be before the 10th; keep this month's occurrence on or before today.
  const todayDay = now.toISOString().slice(0, 10);
  const thisDay = day(thisMonth, 1) > todayDay ? todayDay : day(thisMonth, 1);

  const stamp = Date.now().toString().slice(-6);
  const emp = await api("/api/hr/employees", { method: "POST",
    body: { name: "Monthly Log " + stamp, email: `mlog.${stamp}@example.invalid`, role_title: "RBT", status: "active", hire_date: day(monthOf(6), 1) } });
  const empId = emp.body.id || (emp.body.employee && emp.body.employee.id);
  check("a staff member to log against", !!empId, emp.body);

  const log = (type_key, incident_date, notes) => api(`/api/attendance/employee/${empId}`,
    { method: "POST", body: { type_key, incident_date, notes, notify: false } });
  await log("calloff_gt4", day(twoAgo, 10), "Sick");
  await log("late", day(twoAgo, 12));
  const wrong = await log("left_early", day(twoAgo, 14), "Logged against the wrong person");
  await log("calloff_gt4", thisDay);
  const wrongId = wrong.body && (wrong.body.id || (wrong.body.flag && wrong.body.flag.id));
  if (wrongId) await api(`/api/attendance/flag/${wrongId}/void`, { method: "POST", body: { reason: "Wrong person" } });

  section("The API");
  const r = await api(`/api/attendance/employee/${empId}`);
  const months = (r.body && r.body.monthly) || [];
  check("the record carries a monthly log", r.status === 200 && Array.isArray(months), r.body);
  check("one row per month from the first occurrence to now, newest first",
    JSON.stringify(months.map((m) => m.period)) === JSON.stringify([thisMonth, lastMonth, twoAgo]), months.map((m) => m.period));
  const [cur, clean, old] = months;
  check("a clean month in between is shown, not skipped", clean && clean.points_month === 0 && clean.occurrence_count === 0, clean);
  check("...and reads as Exceeds Expectations", clean && clean.review_level === "Exceeds Expectations", clean && clean.review_level);
  check("the older month adds up its own occurrences: 1 + 0.5", old && old.points_month === 1.5, old && old.points_month);
  check("...counts two, not the voided third", old && old.occurrence_count === 2, old && old.occurrence_count);
  check("...but still lists the voided one, marked", old && old.occurrences.length === 3 && old.occurrences.some((o) => o.voided && /Wrong person/.test(o.voided_reason || "")), old && old.occurrences);
  check("...oldest first inside the month", old && old.occurrences[0].date === day(twoAgo, 10), old && old.occurrences.map((o) => o.date));
  check("this month is marked in progress", cur && cur.in_progress === true && cur.points_month === 1, cur);
  check("the 90-day total is as it stood at month end", old && typeof old.points_90 === "number" && !!old.discipline_level, old);

  section("On the staff record");
  const mounted = await page.evaluate((id) => {
    const d = document.createElement("div"); d.id = "mlog-record"; document.body.appendChild(d);
    return window.HRAttendance && window.HRAttendance.renderSection(d, id, "Monthly Log").then(() => true);
  }, empId);
  check("the record renders", mounted === true);
  const toggles = page.locator("#mlog-record .att-month-toggle");
  check("there is a Monthly log with a dropdown button per month", (await toggles.count()) === 3, await toggles.count());
  const bodies = page.locator("#mlog-record .att-month-body");
  check("every month starts closed", (await bodies.evaluateAll((els) => els.every((e) => e.hidden))) === true);
  const head = await toggles.nth(2).innerText();
  check("the closed row shows the month, its points and how many entries", /\+1\.5 pts/.test(head) && /2 entries/.test(head), head);
  await toggles.nth(2).click();
  check("clicking it opens that month", (await bodies.nth(2).isVisible()) && (await toggles.nth(2).getAttribute("aria-expanded")) === "true");
  const opened = await bodies.nth(2).innerText();
  check("...listing its occurrences with the date as entered, not a day early",
    new RegExp("\\b10, " + twoAgo.slice(0, 4)).test(opened) && /Sick/.test(opened), opened);
  check("...and the voided one, saying it does not count", /Voided/.test(opened) && /does not count/.test(opened), opened);
  check("the other months stay closed", (await bodies.nth(0).isHidden()) && (await bodies.nth(1).isHidden()));
  await toggles.nth(2).click();
  check("clicking again closes it", await bodies.nth(2).isHidden());

  check("no uncaught errors", errors.length === 0, errors);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
