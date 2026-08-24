// Monthly billable requirements for clinical staff.
//
// Each BCBA carries a different monthly requirement and gets an email once a
// month with their requirement and what they actually delivered.
//
// The risk here is not a crash. It is emailing a clinician a WRONG NUMBER
// about their own performance — from a month that never synced, from
// provisional hours, or from a mid-month figure that makes everyone look
// behind. Those cases are indistinguishable from "a quiet month" unless
// something checks, so most of this suite checks them.
//
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-billable.js
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

const PERIOD = "2026-05";
const mailsFor = async (addr) =>
  Number((await pool.query(
    "SELECT count(*) FROM notifications_log WHERE recipient = $1 AND type = 'billable_monthly'", [addr]
  )).rows[0].count);

(async () => {
  const owner = client();
  check("owner signs in", (await owner("/api/auth/login", {
    method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" },
  })).status === 200);

  const purge = async () => {
    await pool.query("DELETE FROM billable_notices WHERE employee_id IN (SELECT id FROM hr_employees WHERE name LIKE 'BILL %')").catch(() => {});
    await pool.query("DELETE FROM rethink_provider_month WHERE staff_name_hint LIKE 'BILL %'").catch(() => {});
    await pool.query("DELETE FROM hr_employees WHERE name LIKE 'BILL %'").catch(() => {});
    await pool.query("DELETE FROM rethink_sync_log WHERE month = $1", [PERIOD]).catch(() => {});
    await pool.query("DELETE FROM notifications_log WHERE type = 'billable_monthly'").catch(() => {});
  };
  await purge();

  const mkEmp = async (name, email, target) => (await pool.query(
    `INSERT INTO hr_employees (name, email, role_title, monthly_billable_target, status)
     VALUES ($1, $2, 'BCBA', $3, 'active') RETURNING id`, [name, email, target]
  )).rows[0].id;

  const giveHours = async (empId, hours, { provisional = false, appts = 10 } = {}) =>
    pool.query(
      `INSERT INTO rethink_provider_month (rethink_staff_id, month, employee_id, staff_name_hint, verified_hours, appointment_count, provisional, computed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now()::text)
       ON CONFLICT (rethink_staff_id, month) DO UPDATE SET verified_hours = EXCLUDED.verified_hours, provisional = EXCLUDED.provisional`,
      [`rt-${empId}`, PERIOD, empId, "BILL hint", hours, appts, provisional]
    );

  const met = await mkEmp("BILL Met", "bill-met@example.invalid", 80);
  const under = await mkEmp("BILL Under", "bill-under@example.invalid", 100);
  const noTarget = await mkEmp("BILL NoTarget", "bill-notarget@example.invalid", null);
  const noEmail = (await pool.query(
    `INSERT INTO hr_employees (name, role_title, monthly_billable_target, status)
     VALUES ('BILL NoEmail', 'BCBA', 90, 'active') RETURNING id`)).rows[0].id;
  const prov = await mkEmp("BILL Provisional", "bill-prov@example.invalid", 70);
  const noHours = await mkEmp("BILL NoHours", "bill-nohours@example.invalid", 60);

  await giveHours(met, 92.5);
  await giveHours(under, 71.25);
  await giveHours(noTarget, 50);
  await giveHours(noEmail, 95);
  await giveHours(prov, 88, { provisional: true });
  // noHours deliberately gets none.

  section("Without a successful sync, nothing is trusted");
  // A month that never synced looks exactly like a month where nobody worked.
  // Emailing "you delivered 0 hours against your 100" off the back of that is
  // the single worst thing this feature could do.
  let sum = (await owner(`/api/billable/summary?month=${PERIOD}`)).data;
  check("the summary loads", !!sum && Array.isArray(sum.staff), sum);
  check("it reports the sync as not ok", sum.sync_ok === false, sum.sync_ok);
  const findRow = (id) => (sum.staff || []).find((r) => r.employee_id === id) || {};
  check("every figure is marked untrustworthy", (sum.staff || []).every((r) => r.trustworthy === false));
  check("and says why in words", /has not completed successfully/i.test(findRow(met).note || ""), findRow(met).note);

  let run = (await owner("/api/billable/run", { method: "POST", body: { month: PERIOD } })).data;
  check("the run sends nothing at all", run.sent === 0, run);
  check("and it says why for each person", (run.skipped || []).length > 0, run.skipped);

  section("With a good sync, the arithmetic is right");
  await pool.query(
    `INSERT INTO rethink_sync_log (kind, month, status, finished_at) VALUES ('supervision_hours', $1, 'success', now()::text)`,
    [PERIOD]
  );
  sum = (await owner(`/api/billable/summary?month=${PERIOD}`)).data;
  check("the sync now reads ok", sum.sync_ok === true);
  check("someone over their requirement is marked met",
    findRow(met).met === true && findRow(met).variance === 12.5,
    { actual: findRow(met).actual_hours, target: findRow(met).target_hours, variance: findRow(met).variance });
  // 71.25 delivered shows as 71.3, and the variance is taken FROM the shown
  // figure so the three numbers in the email add up. A variance of -28.75
  // beside a delivered figure of 71.3 would not.
  check("someone under it is marked not met",
    findRow(under).met === false && findRow(under).variance === -28.7,
    { actual: findRow(under).actual_hours, variance: findRow(under).variance });
  check("the variance agrees with the displayed hours, so the email adds up",
    Math.round((findRow(under).target_hours + findRow(under).variance) * 10) / 10 === findRow(under).actual_hours,
    { target: findRow(under).target_hours, variance: findRow(under).variance, actual: findRow(under).actual_hours });

  section("Nobody is emailed a figure that cannot be stood behind");
  check("provisional hours are held back",
    findRow(prov).trustworthy === false && /provisional/i.test(findRow(prov).note || ""), findRow(prov).note);
  check("a person with no matched appointments is held back",
    findRow(noHours).trustworthy === false && /no rethink appointments/i.test(findRow(noHours).note || ""),
    findRow(noHours).note);

  section("And nobody is emailed a requirement they do not have");
  check("no requirement set means no requirement invented",
    findRow(noTarget).has_requirement === false && findRow(noTarget).target_hours === null, findRow(noTarget));

  section("The send goes to exactly the right people");
  run = (await owner("/api/billable/run", { method: "POST", body: { month: PERIOD } })).data;
  check("two people were emailed", run.sent === 2, run);
  check("the one who met it got their email", (await mailsFor("bill-met@example.invalid")) === 1);
  check("so did the one who was under", (await mailsFor("bill-under@example.invalid")) === 1);
  check("the one with no requirement did not", (await mailsFor("bill-notarget@example.invalid")) === 0);
  check("nor did the one on provisional hours", (await mailsFor("bill-prov@example.invalid")) === 0);
  check("nor the one with no matched hours", (await mailsFor("bill-nohours@example.invalid")) === 0);
  const whys = (run.skipped || []).map((s) => s.why).join(" | ");
  check("someone with no email address is reported, not silently dropped",
    /no email address/i.test(whys), whys);

  section("The email says what the number actually is");
  const body = (await pool.query(
    "SELECT body FROM notifications_log WHERE recipient = 'bill-under@example.invalid' AND type = 'billable_monthly' LIMIT 1"
  )).rows[0].body || "";
  check("it states the requirement", /100/.test(body));
  check("it states what was delivered", /71\.3|71\.25/.test(body), body.slice(0, 200));
  check("it says how far under", /28\.7/.test(body), body.slice(0, 300));
  check("it calls them verified session hours, not billed hours",
    /verified session hours/i.test(body) && !/you billed/i.test(body));
  check("and says plainly it is not a payroll or claims figure",
    /not a payroll or claims figure/i.test(body));

  section("Running it again does not email anyone twice");
  const second = (await owner("/api/billable/run", { method: "POST", body: { month: PERIOD } })).data;
  check("the second run sends nothing", second.sent === 0, second);
  check("and says they were already sent", /already sent/i.test((second.skipped || []).map((s) => s.why).join(" ")));
  check("still exactly one email each", (await mailsFor("bill-met@example.invalid")) === 1);

  section("Forcing a resend is possible, and deliberate");
  const forced = (await owner("/api/billable/run", { method: "POST", body: { month: PERIOD, force: true } })).data;
  check("forcing sends again", forced.sent === 2, forced);

  section("It reports a finished month, not a half-finished one");
  const billable = require("./billable")({
    dbGet: async () => null, dbAll: async () => [], dbRun: async () => ({}),
    sendEmail: async () => ({}), nowISO: () => "", readBody: async () => ({}), json: () => {},
  });
  check("January reports the previous December", billable.previousMonth("2026-01") === "2025-12");
  check("March reports February", billable.previousMonth("2026-03") === "2026-02");
  check("the label is readable", /May 2026/.test(billable.monthLabel("2026-05")), billable.monthLabel("2026-05"));

  section("Setting a requirement");
  check("it can be set", (await owner(`/api/billable/target/${noTarget}`, { method: "PUT", body: { target_hours: 65 } })).status === 200);
  check("and reads back", Number((await pool.query(
    "SELECT monthly_billable_target FROM hr_employees WHERE id = $1", [noTarget])).rows[0].monthly_billable_target) === 65);
  check("it can be cleared", (await owner(`/api/billable/target/${noTarget}`, { method: "PUT", body: { target_hours: "" } })).status === 200);
  check("nonsense is refused rather than stored",
    (await owner(`/api/billable/target/${noTarget}`, { method: "PUT", body: { target_hours: "lots" } })).status === 400);
  check("a negative requirement is refused",
    (await owner(`/api/billable/target/${noTarget}`, { method: "PUT", body: { target_hours: -5 } })).status === 400);

  section("Not everyone may see or set this");
  const clinical = client();
  await clinical("/api/auth/login", { method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } });
  check("a clinical user cannot read the summary",
    (await clinical(`/api/billable/summary?month=${PERIOD}`)).status === 403);
  check("nor set a requirement",
    (await clinical(`/api/billable/target/${met}`, { method: "PUT", body: { target_hours: 1 } })).status === 403);

  await purge();
  await pool.end();
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
