// Weekly billable requirements for clinical staff.
//
// Each BCBA carries a WEEKLY requirement and gets an email at the end of the
// month showing each week against it. Weeks run Monday to Sunday and a partial
// week expects the FULL figure -- it is not pro-rated.
//
// Only appointments Rethink classifies as BILLABLE count towards it. That is a
// different question from the supervision and payroll figure, which counts
// every delivered, verified session: an hour can be genuinely worked, count
// towards supervision, and not be billable. The two rules must never be
// merged, and this suite checks that they have not been.
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
    await pool.query("DELETE FROM rethink_provider_day WHERE month = $1", [PERIOD]).catch(() => {});
    await pool.query("DELETE FROM hr_employees WHERE name LIKE 'BILL %'").catch(() => {});
    await pool.query("DELETE FROM rethink_sync_log WHERE month = $1", [PERIOD]).catch(() => {});
    await pool.query("DELETE FROM notifications_log WHERE type = 'billable_monthly'").catch(() => {});
  };
  await purge();

  const mkEmp = async (name, email, target) => (await pool.query(
    `INSERT INTO hr_employees (name, email, role_title, weekly_billable_target, status)
     VALUES ($1, $2, 'BCBA', $3, 'active') RETURNING id`, [name, email, target]
  )).rows[0].id;

  // Monday-based week starts overlapping the period, computed the same way the
  // server does -- the boundary weeks are the point of storing days.
  const weekStartsFor = (month) => {
    const [y, m] = month.split("-").map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const startOf = (d) => { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x; };
    const out = [];
    let cur = startOf(new Date(Date.UTC(y, m - 1, 1)));
    const end = new Date(Date.UTC(y, m - 1, lastDay));
    while (cur <= end) { out.push(cur.toISOString().slice(0, 10)); const n = new Date(cur.getTime()); n.setUTCDate(n.getUTCDate() + 7); cur = n; }
    return out;
  };
  const WEEKS = weekStartsFor(PERIOD);

  // Billable hours for every week overlapping the month. The day chosen is the
  // week start, which always exists even for a week that begins in the previous
  // month -- that row still belongs to this period's sync.
  const giveBillableWeeks = async (empId, perWeek, opts = {}) => {
    for (const ws of WEEKS) {
      await pool.query(
        `INSERT INTO rethink_provider_day
           (rethink_staff_id, day, month, employee_id, billable_hours, nonbillable_hours, unclassified_hours, billable_appointments, computed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()::text)
         ON CONFLICT (rethink_staff_id, day) DO UPDATE SET
           billable_hours = EXCLUDED.billable_hours, nonbillable_hours = EXCLUDED.nonbillable_hours,
           unclassified_hours = EXCLUDED.unclassified_hours, employee_id = EXCLUDED.employee_id`,
        [`rt-${empId}`, ws, PERIOD, empId, perWeek, opts.nonbillable || 0, opts.unclassified || 0, 4]
      );
    }
  };

  const giveHours = async (empId, hours, { provisional = false, appts = 10 } = {}) =>
    pool.query(
      `INSERT INTO rethink_provider_month (rethink_staff_id, month, employee_id, staff_name_hint, verified_hours, appointment_count, provisional, computed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now()::text)
       ON CONFLICT (rethink_staff_id, month) DO UPDATE SET verified_hours = EXCLUDED.verified_hours, provisional = EXCLUDED.provisional`,
      [`rt-${empId}`, PERIOD, empId, "BILL hint", hours, appts, provisional]
    );

  const met = await mkEmp("BILL Met", "bill-met@example.invalid", 20);
  const under = await mkEmp("BILL Under", "bill-under@example.invalid", 25);
  const noTarget = await mkEmp("BILL NoTarget", "bill-notarget@example.invalid", null);
  const noEmail = (await pool.query(
    `INSERT INTO hr_employees (name, role_title, weekly_billable_target, status)
     VALUES ('BILL NoEmail', 'BCBA', 22, 'active') RETURNING id`)).rows[0].id;
  const prov = await mkEmp("BILL Provisional", "bill-prov@example.invalid", 18);
  const noHours = await mkEmp("BILL NoHours", "bill-nohours@example.invalid", 15);

  // The month row still carries the PROVISIONAL flag, which is a statement
  // about the Rethink filter and applies to every figure from that sync.
  await giveHours(met, 92.5);
  await giveHours(under, 71.25);
  await giveHours(noTarget, 50);
  await giveHours(noEmail, 95);
  await giveHours(prov, 88, { provisional: true });
  // noHours deliberately gets none.

  // Billable hours, the figure the requirement is actually measured against.
  // "met" clears 20 a week; "under" falls short of 25 every week. The
  // non-billable and unclassified hours on "met" are the ones that must NOT be
  // counted -- 25 billable plus 9 of other kinds is still 25 billable.
  await giveBillableWeeks(met, 25, { nonbillable: 6, unclassified: 3 });
  await giveBillableWeeks(under, 12);
  await giveBillableWeeks(noTarget, 30);
  await giveBillableWeeks(noEmail, 30);
  await giveBillableWeeks(prov, 30);

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
  check("someone clearing their weekly requirement is marked met",
    findRow(met).met === true, { weeks: findRow(met).weeks_met, of: findRow(met).weeks_scored });
  check("and every week is counted, including ones straddling the month",
    findRow(met).weeks_scored === WEEKS.length,
    { scored: findRow(met).weeks_scored, expected: WEEKS.length });
  check("someone under it every week is marked not met",
    findRow(under).met === false && findRow(under).weeks_met === 0,
    { weeks_met: findRow(under).weeks_met, of: findRow(under).weeks_scored });

  // THE RULE SEPARATION, checked from the outside. This person delivered 25
  // billable, 6 non-billable and 3 unlabelled hours a week. Only the 25 count.
  section("Only billable hours count towards a billable requirement");
  check("non-billable hours are not counted towards it",
    findRow(met).weeks.every((w) => w.billable_hours === 25),
    JSON.stringify(findRow(met).weeks || []).slice(0, 300));
  check("unlabelled hours are not quietly counted as billable",
    findRow(met).weeks.every((w) => w.billable_hours !== 28),
    JSON.stringify(findRow(met).weeks || []).slice(0, 300));
  check("but the unlabelled hours are reported rather than hidden",
    findRow(met).unclassified_hours > 0, findRow(met).unclassified_hours);
  // The supervision figure for the same person is untouched by any of this.
  const supHours = Number((await pool.query(
    "SELECT verified_hours FROM rethink_provider_month WHERE employee_id = $1 AND month = $2",
    [met, PERIOD])).rows[0].verified_hours);
  check("the supervision figure is NOT changed by the billable rule",
    supHours === 92.5, supHours);

  section("A partial week still expects the full requirement");
  check("no week is pro-rated, however few of its days fall in the month",
    findRow(under).weeks.every((w) => w.met === false),
    JSON.stringify(findRow(under).weeks || []).slice(0, 300));

  section("Nobody is emailed a figure that cannot be stood behind");
  check("provisional hours are held back",
    findRow(prov).trustworthy === false && /provisional/i.test(findRow(prov).note || ""), findRow(prov).note);
  check("a person with no matched appointments is held back",
    findRow(noHours).trustworthy === false && /no rethink appointments/i.test(findRow(noHours).note || ""),
    findRow(noHours).note);

  section("And nobody is emailed a requirement they do not have");
  check("no requirement set means no requirement invented",
    findRow(noTarget).has_requirement === false && findRow(noTarget).weekly_target_hours === null, findRow(noTarget));
  // A monthly figure left on a record is NOT silently converted into a weekly
  // one: monthly / 4.33 is a guess, and a guessed requirement is one somebody
  // gets judged against.
  await pool.query("UPDATE hr_employees SET monthly_billable_target = 100 WHERE id = $1", [noTarget]);
  const afterLegacy = (await owner(`/api/billable/summary?month=${PERIOD}`)).data;
  const legacyRow = (afterLegacy.staff || []).find((r) => r.employee_id === noTarget) || {};
  check("an old monthly figure is not converted into a weekly requirement",
    legacyRow.has_requirement === false && legacyRow.weekly_target_hours === null, legacyRow);
  check("but it is reported, so the person is not silently left out",
    Number(legacyRow.legacy_monthly_target) === 100, legacyRow.legacy_monthly_target);
  await pool.query("UPDATE hr_employees SET monthly_billable_target = NULL WHERE id = $1", [noTarget]);

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
  check("it states the weekly requirement", /25 billable hours a week/i.test(body), body.slice(0, 400));
  check("it shows each week, not one lump figure", /12 hrs/.test(body), body.slice(0, 700));
  check("it says how many weeks were met", /0 of \d+/.test(body), body.slice(0, 400));
  check("it says a partial week is not reduced",
    /not reduced because the month started or ended/i.test(body), body.slice(-600));
  check("it says only billable appointments count",
    /classifies as <strong>billable<\/strong>/i.test(body), body.slice(-600));
  check("and says plainly it is neither payroll nor supervision hours",
    /not a payroll figure/i.test(body) && /supervision/i.test(body), body.slice(-600));

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
  check("and reads back as a WEEKLY requirement", Number((await pool.query(
    "SELECT weekly_billable_target FROM hr_employees WHERE id = $1", [noTarget])).rows[0].weekly_billable_target) === 65);
  check("setting a weekly figure does not touch the retired monthly one",
    (await pool.query("SELECT monthly_billable_target FROM hr_employees WHERE id = $1", [noTarget])).rows[0].monthly_billable_target === null);
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
