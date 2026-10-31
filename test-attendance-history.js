// Infraction history: every attendance occurrence, in one list.
//
// REPORTED AS: "Whatever happened to the list of attendance infractions in
// the CRM? ... I need the history of all reported attendance infractions."
//
// Nothing had been deleted. Occurrences were only ever readable one staff card
// at a time, and the Squad Leader QR reports had a management API
// (/api/squad/admin/reports) but no screen ever called it. This suite proves
// the Staff Attendance page now has one list holding all of them: QR reports,
// office-logged occurrences, voided ones (hidden until asked for) and former
// staff -- with the dates as entered, not a day early.
//
//   DATABASE_URL=... node run-tests.js test-attendance-history.js
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

  // Nobody signed in gets nothing.
  const anon = await fetch(BASE + "/api/attendance/history");
  check("the history is not readable without signing in", anon.status === 401 || anon.status === 403, anon.status);

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

  const RUN = Date.now().toString().slice(-6);
  const mk = async (name, slug) => {
    const r = await api("/api/hr/employees", { method: "POST",
      body: { name: name + " " + RUN, email: `${slug}.${RUN}@spectrumsquadlv.com`, role_title: "RBT", status: "active", hire_date: "2025-01-06" } });
    return r.body.id || (r.body.employee && r.body.employee.id);
  };
  const leaderId = await mk("Hist Lead", "histlead");
  const memberId = await mk("Hist Member", "histmember");
  const leaverId = await mk("Hist Leaver", "histleaver");
  check("three staff to work with", leaderId && memberId && leaderId && leaverId);

  section("Occurrences from every channel");
  // Office-logged, on the staff card.
  await api(`/api/attendance/employee/${memberId}`, { method: "POST",
    body: { type_key: "late", incident_date: "2026-09-02", notes: "Office-logged late", notify: false } });
  // A voided one, logged in error.
  await api(`/api/attendance/employee/${memberId}`, { method: "POST",
    body: { type_key: "left_early", incident_date: "2026-09-03", notes: "Logged in error", notify: false } });
  const memberFlags = (await api(`/api/attendance/employee/${memberId}`)).body.flags || [];
  const wrong = memberFlags.find((f) => f.notes === "Logged in error");
  await api(`/api/attendance/flag/${wrong && wrong.id}/void`, { method: "POST", body: { reason: "Wrong person" } });
  // Somebody who has since left.
  await api(`/api/attendance/employee/${leaverId}`, { method: "POST",
    body: { type_key: "ncns", incident_date: "2026-08-14", notes: "Before they left", notify: false } });
  await api(`/api/hr/employees/${leaverId}`, { method: "PATCH", body: { status: "terminated" } });

  // A Squad Leader report over the QR channel, signed in with a PIN.
  const sq = await api("/api/squad/admin/squads", { method: "POST", body: { name: `Hist Squad ${RUN}`, leader_employee_id: leaderId } });
  const squadId = ((sq.body.squads || []).find((s) => s.name === `Hist Squad ${RUN}`) || {}).id;
  await api("/api/squad/admin/members", { method: "POST", body: { squad_id: squadId, employee_ids: [memberId] } });
  await api("/api/squad/admin/pin", { method: "POST", body: { employee_id: leaderId, pin: "739184" } });
  const leader = await browser.newContext();
  const lp = await leader.newPage();
  await lp.goto(BASE + "/squad-report", { waitUntil: "domcontentloaded" });
  const lapi = (p, o) => lp.evaluate(async ({ p, o }) => {
    const r = await fetch(p, { method: (o && o.method) || "GET", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: o && o.body ? JSON.stringify(o.body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { p, o });
  const login = await lapi("/api/squad/public/login", { method: "POST", body: { email: `histlead.${RUN}@spectrumsquadlv.com`, pin: "739184" } });
  check("the Squad Leader signs in with their PIN", login.status === 200, login.body);
  const filed = await lapi("/api/squad/public/report", { method: "POST",
    body: { employee_id: memberId, type_key: "calloff_gt4", incident_date: "2026-09-10", incident_time: "07:45", notes: "QR report" } });
  check("...and files a report", filed.status === 201, filed.body);
  const self = await lapi("/api/squad/public/report", { method: "POST",
    body: { employee_id: leaderId, type_key: "late", incident_date: "2026-09-11", notes: "Reported myself" } });
  check("...and one about themselves", self.status === 201, self.body);
  check("a squad session cannot read the history", (await lapi("/api/attendance/history")).status >= 401);
  await leader.close();

  section("The history API");
  const h = await api("/api/attendance/history");
  check("management can read it", h.status === 200, h.status);
  const rows = (h.body.flags || []).filter((f) => (f.employee_name || "").endsWith(RUN));
  const by = (note) => rows.find((f) => f.notes === note);
  check("it holds every occurrence for these staff, voided included", rows.length === 5, rows.map((r) => r.notes));
  check("office-logged rows are marked as such", by("Office-logged late") && by("Office-logged late").source === "office", by("Office-logged late"));
  const qr = by("QR report");
  check("QR reports name the leader and squad",
    qr && qr.source === "squad_qr" && qr.reported_by_name === `Hist Lead ${RUN}` && qr.squad_name === `Hist Squad ${RUN}`, qr);
  check("...carry the infraction label and the time", qr && /Call-off/.test(qr.type_label) && qr.incident_time === "07:45", qr);
  check("a leader reporting themselves is flagged", by("Reported myself") && by("Reported myself").self_reported === true, by("Reported myself"));
  check("a voided row comes back marked voided, with its reason",
    by("Logged in error") && by("Logged in error").voided === true && by("Logged in error").voided_reason === "Wrong person", by("Logged in error"));
  check("former staff are still in the history",
    by("Before they left") && by("Before they left").employee_status === "terminated", by("Before they left"));
  check("signatures and signing tokens are not sent", rows.every((r) => !("signature" in r) && !("ack_token" in r)));
  const order = rows.map((r) => r.incident_date);
  check("newest first", JSON.stringify(order) === JSON.stringify(order.slice().sort().reverse()), order);

  section("The screen");
  await page.evaluate(() => { location.hash = "#/attendance"; });
  await page.waitForSelector("#att-history-btn", { timeout: 8000 }).catch(() => {});
  check("Staff Attendance has an Infraction history button", (await page.locator("#att-history-btn").count()) === 1);
  await page.click("#att-history-btn");
  await page.waitForSelector("#ah-rows tr", { timeout: 8000 }).catch(() => {});
  await page.fill("#ah-q", RUN);
  await page.waitForTimeout(300);
  let body = await page.locator("#ah-rows").innerText();
  check("it lists the occurrences", /QR report/.test(body) && /Office-logged late/.test(body) && /Before they left/.test(body), body);
  check("voided rows are hidden by default", !/Logged in error/.test(body), body);
  check("dates read as entered, not a day early (9/10/2026)", /9\/10\/2026/.test(body) && !/9\/9\/2026/.test(body), body);
  check("the leader and squad are shown", body.includes(`Hist Lead ${RUN} · Hist Squad ${RUN}`), body);
  check("former staff are labelled", /Former/.test(body), body);
  await page.check("#ah-voided");
  body = await page.locator("#ah-rows").innerText();
  check("Show voided brings it back, with the reason", /Logged in error/.test(body) && /Voided: Wrong person/.test(body), body);
  await page.selectOption("#ah-src", "squad_qr");
  body = await page.locator("#ah-rows").innerText();
  check("filtering to Squad Leader reports leaves only those",
    /QR report/.test(body) && /Reported myself/.test(body) && !/Office-logged late/.test(body), body);
  await page.selectOption("#ah-src", "");
  await page.fill("#ah-from", "2026-09-01");
  await page.fill("#ah-to", "2026-09-05");
  body = await page.locator("#ah-rows").innerText();
  check("a date range narrows it", /Office-logged late/.test(body) && !/QR report/.test(body) && !/Before they left/.test(body), body);
  const summary = await page.locator("#ah-summary").innerText();
  check("the summary counts what is shown", /^2 shown/.test(summary), summary);

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 5000 }).catch(() => null),
    page.click("#ah-csv"),
  ]);
  let csv = "";
  if (download) { const fs = require("fs"); csv = fs.readFileSync(await download.path(), "utf8"); }
  check("Download CSV exports the filtered rows", /^Date,Time,Staff/.test(csv) && /Office-logged late/.test(csv) && !/QR report/.test(csv), csv.slice(0, 300));

  check("no uncaught errors", errors.length === 0, errors);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
