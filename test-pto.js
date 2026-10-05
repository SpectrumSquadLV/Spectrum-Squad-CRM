// PTO accrual, under the Spectrum Squad policy effective 1 March 2026.
//
// 0.038 hours earned per hour ACTUALLY WORKED, after a 90-day waiting period,
// and never for an hour worked before the policy existed.
//
// This suite replaced one that asserted the previous behaviour, because that
// behaviour was the defect. Three things it used to require are now forbidden,
// and each has an assertion here saying so:
//
//   * accrual from approved TIMECARDS. Clocked time and delivered service time
//     overlap for a clinician, so summing both counts an hour twice. Rethink's
//     per-day billable/non-billable split is now the single source.
//
//   * accrual from an ASSUMED STANDARD WEEK when no timecard existed. This
//     accrued PTO on hours nobody worked. Nothing may stand in for a
//     measurement now -- an unsynced month earns nothing and says so.
//
//   * a 40-hour statutory CAP by default. The written policy is
//     `balance = worked x 0.038 - used`, with no ceiling in it, and at this
//     rate a 40-hour cap silently discards about half of a full-time year.
//
// The arithmetic examples are the owner's own, checked literally.
//
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-pto.js
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
const near = (a, b, tol = 0.02) => a != null && Math.abs(a - b) <= tol;
// Rates are three orders of magnitude smaller than hours, so they need their
// own tolerance. With the hours tolerance, 0.038 and 0.01923 compare as equal
// -- which would silently pass the one comparison this whole audit turns on.
const sameRate = (a, b) => a != null && Math.abs(a - b) < 0.0005;
const AS_OF = "2027-02-28";   // a fixed horizon, so the suite does not drift with the clock

(async () => {
  const owner = client();
  const staff = client();
  check("owner signs in", (await owner("/api/auth/login", {
    method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);
  check("a BCBA signs in", (await staff("/api/auth/login", {
    method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } })).status === 200);

  const purge = async () => {
    const ids = "(SELECT id FROM hr_employees WHERE name LIKE 'PTO %')";
    for (const t of ["pto_adjustments", "staff_time_off", "hr_timecards", "pto_ledger", "rethink_provider_day"]) {
      await pool.query(`DELETE FROM ${t} WHERE employee_id IN ${ids}`).catch(() => {});
    }
    await pool.query("DELETE FROM hr_employees WHERE name LIKE 'PTO %'").catch(() => {});
  };
  await purge();

  const mk = async (name, hire) => (await pool.query(
    `INSERT INTO hr_employees (name, email, role_title, hr_hire_date, status)
     VALUES ($1, $2, 'BCBA', $3, 'active') RETURNING id`,
    [name, name.replace(/\W/g, "") + "@example.invalid", hire])).rows[0].id;

  // Worked hours land in rethink_provider_day, one row per day, which is the
  // single source. Writing them directly is the honest fixture: it is exactly
  // the shape the Rethink sync produces.
  const workDay = async (empId, day, billable, nonbillable, unclassified) => {
    await pool.query(
      `INSERT INTO rethink_provider_day
         (rethink_staff_id, day, month, employee_id, billable_hours, nonbillable_hours, unclassified_hours, computed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now()::text)
       ON CONFLICT (rethink_staff_id, day) DO UPDATE SET
         billable_hours = EXCLUDED.billable_hours, nonbillable_hours = EXCLUDED.nonbillable_hours,
         unclassified_hours = EXCLUDED.unclassified_hours`,
      [`pto-${empId}`, day, day.slice(0, 7), empId, billable, nonbillable, unclassified || 0]);
  };

  // The policy defaults, set explicitly so the suite does not depend on
  // whatever a previous run left in app_settings.
  await owner("/api/pto/settings", { method: "PUT", body: { rate: 0.038, annual_cap: 0, weekly_hours: 40 } });

  // ==================================================================
  section("WHEN ACCRUAL STARTS — the later of 1 March 2026 and hire + 90 days");
  // The owner's three worked examples, literally.
  const early = await mk("PTO Early Hire", "2025-11-01");   // 90 days done before the policy
  const feb = await mk("PTO Feb Hire", "2026-02-01");       // waiting period ends after it
  const apr = await mk("PTO Apr Hire", "2026-04-01");       // entirely after it
  const elig = async (id) => (await owner("/api/pto/ledger/" + id)).data.eligibility;

  check("HIRED 1 NOV 2025 — accrual begins the day the policy did, 1 March 2026",
    (await elig(early)).start === "2026-03-01", await elig(early));
  check("and it says why", /policy began/.test((await elig(early)).reason), await elig(early));
  check("HIRED 1 FEB 2026 — the waiting period ends after the policy, so it governs",
    (await elig(feb)).start === "2026-05-02", await elig(feb));
  check("HIRED 1 APR 2026 — 90 days from hire",
    (await elig(apr)).start === "2026-06-30", await elig(apr));
  check("and that one says the waiting period is why", /waiting period/.test((await elig(apr)).reason));

  // ==================================================================
  section("NO RETROACTIVE ACCRUAL for hours worked before eligibility");
  // The February hire works hard through their waiting period, and in
  // February 2026 before the policy existed at all.
  for (const d of ["2026-02-10", "2026-02-20", "2026-03-10", "2026-04-15"]) await workDay(feb, d, 8, 2);
  // And one day AFTER they become eligible on 2 May.
  await workDay(feb, "2026-05-10", 8, 2);
  const febBal = (await owner(`/api/pto/roster?to=${AS_OF}`)).data.staff.filter((s) => s.employee_id === feb)[0];
  check("ONLY THE ELIGIBLE DAY COUNTS — the four worked before eligibility earn nothing",
    near(febBal.hours_worked, 10), { worked: febBal.hours_worked, expected: 10 });
  check("so the accrual is 10 x 0.038", near(febBal.accrued, 0.38), febBal.accrued);
  check("the period starts at eligibility, not at hire",
    febBal.period.from === "2026-05-02", febBal.period);

  const aprBal = (await owner(`/api/pto/roster?to=2026-05-01`)).data.staff.filter((s) => s.employee_id === apr)[0];
  check("SOMEBODY STILL INSIDE THEIR WAITING PERIOD IS NOT AN ERROR, just not yet accruing",
    aprBal.not_yet_eligible === true && aprBal.accrued === 0 && !aprBal.error, aprBal);
  check("and the screen is told when they will start",
    /accrual begins 2026-06-30/.test(aprBal.hours_basis_detail || ""), aprBal.hours_basis_detail);

  // A report run "from January" must not grant what the policy withholds.
  const narrowed = (await owner(`/api/pto/roster?from=2026-01-01&to=${AS_OF}`)).data
    .staff.filter((s) => s.employee_id === feb)[0];
  check("ASKING FOR AN EARLIER WINDOW CANNOT MOVE ACCRUAL EARLIER",
    narrowed.period.from === "2026-05-02", narrowed.period);

  // ==================================================================
  section("THE ARITHMETIC — the owner's own examples");
  const a40 = await mk("PTO Forty", "2025-01-01");
  await workDay(a40, "2026-06-01", 40, 0);
  const a100 = await mk("PTO Hundred", "2025-01-01");
  await workDay(a100, "2026-06-01", 60, 40);
  const a1000 = await mk("PTO Thousand", "2025-01-01");
  // Spread so no single day is absurd; the total is what matters.
  for (let i = 0; i < 100; i++) {
    const d = new Date(Date.UTC(2026, 5, 1) + i * 86400000).toISOString().slice(0, 10);
    await workDay(a1000, d, 7, 3);
  }
  const bal = async (id) => (await owner(`/api/pto/roster?to=${AS_OF}`)).data.staff.filter((s) => s.employee_id === id)[0];
  check("40 eligible worked hours x 0.038 = 1.52", near((await bal(a40)).accrued, 1.52), (await bal(a40)).accrued);
  check("100 x 0.038 = 3.80", near((await bal(a100)).accrued, 3.80), (await bal(a100)).accrued);
  check("1,000 x 0.038 = 38.00", near((await bal(a1000)).accrued, 38.00, 0.05), (await bal(a1000)).accrued);

  const split = await bal(a100);
  check("BILLABLE AND NON-BILLABLE ARE COMBINED BEFORE THE RATE",
    near(split.hours_worked, 100) && near(split.hours_billable, 60) && near(split.hours_nonbillable, 40), split);

  // The spec's own worked example: 30 billable + 10 non-billable = 1.52, and
  // NOT 1.14 + 0.38 rounded apart, which is how per-appointment accrual drifts.
  const mixed = await mk("PTO Mixed", "2025-01-01");
  await workDay(mixed, "2026-06-01", 30, 10);
  check("30 billable + 10 non-billable = 40 h = 1.52, rounded once on the total",
    near((await bal(mixed)).accrued, 1.52), (await bal(mixed)).accrued);

  // ==================================================================
  section("WHAT MUST NOT COUNT");
  const uncl = await mk("PTO Unclassified", "2025-01-01");
  await workDay(uncl, "2026-06-01", 20, 5, 15);
  const u = await bal(uncl);
  check("UNCLASSIFIED HOURS ARE NOT ACCRUED ON — 25 eligible, not 40",
    near(u.hours_worked, 25) && near(u.accrued, 0.95), { worked: u.hours_worked, accrued: u.accrued });
  check("but they are reported rather than silently dropped",
    near(u.hours_unclassified, 15), u.hours_unclassified);

  // The defect this replaced: a person with no synced days used to accrue a
  // whole assumed year.
  const quiet = await mk("PTO No Data", "2025-01-01");
  const q = await bal(quiet);
  check("SOMEBODY WITH NOTHING SYNCED ACCRUES NOTHING — no assumed standard week",
    q.accrued === 0 && q.hours_worked === 0, { accrued: q.accrued, worked: q.hours_worked });
  check("AND NOTHING SYNCED IS NOT REPORTED AS ZERO HOURS WORKED",
    q.unsynced_months > 0 && /not been synced/.test(q.hours_basis_detail || ""), q.hours_basis_detail);
  check("the balance is flagged as still able to move", q.estimated === true, q.estimated);
  check("the basis is always Rethink now, never timecards or an assumption",
    (await bal(a40)).hours_basis === "rethink", (await bal(a40)).hours_basis);

  // Timecards must be ignored entirely: this is the double-counting guard.
  await pool.query(
    `INSERT INTO hr_timecards (employee_id, source, pay_period_start, pay_period_end, raw_json, status, created_at)
     VALUES ($1, 'homebase', '2026-06-01', '2026-06-15', $2, 'approved', now()::text)`,
    [a40, JSON.stringify([{ hours: 80 }])]);
  const afterCard = await bal(a40);
  check("AN APPROVED TIMECARD DOES NOT ADD TO ACCRUAL — one source, so no hour counts twice",
    near(afterCard.hours_worked, 40) && near(afterCard.accrued, 1.52),
    { worked: afterCard.hours_worked, accrued: afterCard.accrued });

  // ==================================================================
  section("THE LEDGER");
  const led = await owner("/api/pto/ledger/" + a100);
  check("a ledger that has never been built says so rather than reading as zero",
    led.data.built === false && led.data.balance === null, led.data);

  const rebuilt = await owner("/api/pto/rebuild", { method: "POST", body: { employee_id: a100, to: AS_OF, apply: true } });
  check("the owner can rebuild one person", rebuilt.status === 200, rebuilt.data);
  const led2 = (await owner("/api/pto/ledger/" + a100)).data;
  check("which writes rows", led2.built === true && led2.rows.length >= 1, led2.rows && led2.rows.length);
  const accrualRow = (led2.rows || []).filter((r) => r.kind === "accrual")[0] || {};
  check("EVERY COLUMN NEEDED TO AUDIT A BALANCE IS ON THE ROW",
    accrualRow.eligible_hours != null && accrualRow.accrual_rate != null &&
    accrualRow.pto_earned != null && accrualRow.balance_after != null &&
    !!accrualRow.source && !!accrualRow.reason, accrualRow);
  check("including which table the hours came from",
    accrualRow.source === "rethink_provider_day", accrualRow.source);
  check("and the running balance matches the roster",
    near(Number(led2.balance), (await bal(a100)).balance), { ledger: led2.balance, roster: (await bal(a100)).balance });

  // THE ANTI-DOUBLE-COUNTING PROOF. Rebuilding is a replacement, not an
  // addition, so running it repeatedly cannot inflate anybody.
  const before = (await owner("/api/pto/ledger/" + a100)).data;
  await owner("/api/pto/rebuild", { method: "POST", body: { employee_id: a100, to: AS_OF, apply: true } });
  await owner("/api/pto/rebuild", { method: "POST", body: { employee_id: a100, to: AS_OF, apply: true } });
  const after = (await owner("/api/pto/ledger/" + a100)).data;
  check("REBUILDING THREE TIMES GIVES THE SAME ROW COUNT — it replaces, never appends",
    after.rows.length === before.rows.length, { before: before.rows.length, after: after.rows.length });
  check("AND THE SAME BALANCE — the same worked time can never be counted twice",
    near(Number(after.balance), Number(before.balance)), { before: before.balance, after: after.balance });

  // ==================================================================
  section("Usage and adjustments land in the same trail");
  await pool.query(
    `INSERT INTO staff_time_off (employee_id, kind, status, start_date, end_date, all_day)
     VALUES ($1, 'pto', 'approved', '2026-07-06', '2026-07-06', true)`, [a1000]).catch(() => {});
  await owner("/api/pto/adjustment", { method: "POST", body: {
    employee_id: a1000, hours: 5, reason: "Opening balance carried from the spreadsheet",
    effective_date: "2026-06-01" } });
  await owner("/api/pto/rebuild", { method: "POST", body: { employee_id: a1000, to: AS_OF, apply: true } });
  const full = (await owner("/api/pto/ledger/" + a1000)).data;
  const kinds = new Set((full.rows || []).map((r) => r.kind));
  check("accrual, usage and adjustment are all on the one trail",
    kinds.has("accrual") && kinds.has("usage") && kinds.has("adjustment"), [...kinds]);
  check("the adjustment carries the reason it was given",
    (full.rows || []).some((r) => r.kind === "adjustment" && /spreadsheet/.test(r.reason || "")));
  check("and the final balance is earned - used + adjustments",
    near(Number(full.balance), (await bal(a1000)).balance), { ledger: full.balance, roster: (await bal(a1000)).balance });
  check("rows are in date order so the running balance reads correctly",
    (full.rows || []).every((r, i, xs) => i === 0 || String(xs[i - 1].transaction_date) <= String(r.transaction_date)));

  // ==================================================================
  section("Defaults, and who may rebuild");
  // THE DEFAULT HAS TO BE RIGHT ON ITS OWN. Every assertion above ran with the
  // rate set explicitly, which is precisely how the original defect hid: the
  // stored setting masked a default of half the policy rate. So the settings
  // are CLEARED here and the defaults are read with nothing backing them --
  // which is the state a fresh install, or an install nobody configured, is
  // actually in.
  await pool.query("DELETE FROM app_settings WHERE key IN ('pto_accrual_rate','pto_annual_cap')").catch(() => {});
  const bare = (await owner(`/api/pto/roster?to=${AS_OF}`)).data;
  check("WITH NOTHING STORED, THE DEFAULT RATE IS THE POLICY RATE 0.038",
    sameRate(bare.default_rate, 0.038), bare.default_rate);
  check("NOT the Nevada statutory minimum, which was accruing at half",
    !sameRate(bare.default_rate, 0.01923), bare.default_rate);
  check("WITH NOTHING STORED, ACCRUAL IS UNCAPPED — the written formula has no ceiling",
    bare.default_annual_cap === 0, bare.default_annual_cap);
  check("and an unconfigured install still computes at the policy rate",
    near(bare.staff.filter((x) => x.employee_id === a40)[0].accrued, 1.52),
    bare.staff.filter((x) => x.employee_id === a40)[0].accrued);
  check("the Nevada figure is still reported, as the floor this clears",
    sameRate(bare.statutory_rate, 0.01923), bare.statutory_rate);
  check("a 2,080-hour year earns about 79 hours, which no cap is cutting in half",
    near(bare.staff.filter((x) => x.employee_id === a1000)[0].accrued, 38.0, 0.05));

  check("A BCBA CANNOT REBUILD EVERYONE'S BALANCES",
    (await staff("/api/pto/rebuild", { method: "POST", body: {} })).status === 403);
  check("nor read somebody's ledger", (await staff("/api/pto/ledger/" + a100)).status === 403);

  // ==================================================================
  section("Cancelled, scheduled-but-not-worked, and PTO itself");
  // Scenarios 6, 7 and 9 of the validation list.
  //
  // 6 and 7 hold STRUCTURALLY rather than by a filter: accrual reads
  // rethink_provider_day, which is a record of delivered service time.
  // sched_sessions -- where cancellations, no-shows and merely-scheduled
  // blocks live -- is never consulted. The assertion is that writing those
  // rows changes nothing, which is a stronger claim than "the filter works",
  // because there is no filter to get wrong.
  const sessEmp = await mk("PTO Sessions", "2025-01-01");
  await workDay(sessEmp, "2026-06-01", 10, 0);
  const beforeSessions = (await bal(sessEmp)).accrued;
  const client0 = (await pool.query("SELECT id FROM clients ORDER BY id LIMIT 1")).rows[0];
  if (client0) {
    for (const [st, d] of [["cancelled", "2026-06-02"], ["no_show", "2026-06-03"],
                           ["scheduled", "2026-06-04"], ["staff_call_out", "2026-06-05"]]) {
      await pool.query(
        `INSERT INTO sched_sessions (client_id, staff_id, session_date, start_time, end_time, status, created_at)
         VALUES ($1, $2, $3, '09:00', '17:00', $4, now()::text)`,
        [client0.id, sessEmp, d, st]).catch(() => {});
    }
  }
  const afterSessions = await bal(sessEmp);
  check("A CANCELLED APPOINTMENT DOES NOT ACCRUE",
    near(afterSessions.accrued, beforeSessions), { before: beforeSessions, after: afterSessions.accrued });
  check("NOR A NO-SHOW, A STAFF CALL-OUT, OR A MERELY SCHEDULED BLOCK",
    near(afterSessions.hours_worked, 10), afterSessions.hours_worked);
  check("eight scheduled hours a day for four days changed nothing, because the schedule is not the source",
    near(afterSessions.accrued, 0.38), afterSessions.accrued);

  // Scenario 9: PTO taken is deducted, and is NOT itself worked time.
  const userEmp = await mk("PTO Taker", "2025-01-01");
  await workDay(userEmp, "2026-06-01", 40, 0);
  await pool.query(
    `INSERT INTO staff_time_off (employee_id, kind, status, start_date, end_date, all_day)
     VALUES ($1, 'pto', 'approved', '2026-06-15', '2026-06-15', true)`, [userEmp]).catch(() => {});
  const taker = await bal(userEmp);
  check("PTO USED IS DEDUCTED from the balance", taker.taken > 0 && taker.balance < taker.accrued,
    { accrued: taker.accrued, taken: taker.taken, balance: taker.balance });
  check("BUT THE DAY OFF IS NOT COUNTED AS WORKED TIME — still 40 eligible hours",
    near(taker.hours_worked, 40) && near(taker.accrued, 1.52),
    { worked: taker.hours_worked, accrued: taker.accrued });
  check("so the balance is earned minus used",
    near(taker.balance, taker.accrued - taker.taken), taker);

  // Scenario 10: a wrong existing balance is REPLACED, not built on.
  section("A wrong existing balance is replaced, not stacked on");
  await pool.query(
    `INSERT INTO pto_ledger (employee_id, kind, transaction_date, pto_earned, balance_after, source, reason, rebuilt_at)
     VALUES ($1, 'accrual', '2026-01-01', 999, 999, 'legacy', 'a wrong historical figure', now()::text)`,
    [userEmp]).catch(() => {});
  const wrongBefore = (await owner("/api/pto/ledger/" + userEmp)).data;
  check("a wrong balance is sitting there", near(Number(wrongBefore.balance), 999), wrongBefore.balance);
  const preview = await owner("/api/pto/rebuild", { method: "POST", body: { employee_id: userEmp, to: AS_OF } });
  check("REBUILD PREVIEWS BY DEFAULT — nothing destructive without asking",
    preview.data.dry_run === true, preview.data.dry_run);
  check("and the preview shows what the balance would become",
    near(preview.data.employees[0].ledger_balance, taker.balance), preview.data.employees[0].ledger_balance);
  check("naming the change it would make", near(preview.data.employees[0].delta, taker.balance - 999, 0.05),
    preview.data.employees[0].delta);
  check("THE PREVIEW CHANGED NOTHING — the wrong figure is still there",
    near(Number((await owner("/api/pto/ledger/" + userEmp)).data.balance), 999));
  const applied = await owner("/api/pto/rebuild", { method: "POST", body: { employee_id: userEmp, to: AS_OF, apply: true } });
  check("applying it replaces the wrong figure rather than adding to it",
    applied.data.dry_run === false &&
    near(Number((await owner("/api/pto/ledger/" + userEmp)).data.balance), taker.balance),
    (await owner("/api/pto/ledger/" + userEmp)).data.balance);

  section("Reversibility");
  const batches = (await owner("/api/pto/batches")).data.batches || [];
  check("the run that replaced it was recorded as a batch", batches.length >= 1, batches.length);
  const batch = batches[0].batch_id;
  const restored = await owner("/api/pto/restore", { method: "POST", body: { batch_id: batch } });
  check("a batch can be restored", restored.status === 200, restored.data);
  check("WHICH PUTS THE PRIOR LEDGER BACK — the recalculation is reversible",
    near(Number((await owner("/api/pto/ledger/" + userEmp)).data.balance), 999),
    (await owner("/api/pto/ledger/" + userEmp)).data.balance);
  check("a BCBA cannot restore", (await staff("/api/pto/restore", { method: "POST", body: { batch_id: batch } })).status === 403);
  // Put it back to correct so later assertions are not reading a deliberate wrong.
  await owner("/api/pto/rebuild", { method: "POST", body: { employee_id: userEmp, to: AS_OF, apply: true } });

  section("The source key makes a duplicate accrual impossible at the table");
  const dupEmp = await mk("PTO Dup", "2025-01-01");
  await workDay(dupEmp, "2026-06-01", 10, 0);
  await owner("/api/pto/rebuild", { method: "POST", body: { employee_id: dupEmp, to: AS_OF, apply: true } });
  const key = (await pool.query(
    "SELECT source_key FROM pto_ledger WHERE employee_id = $1 AND kind = 'accrual' LIMIT 1", [dupEmp])).rows[0];
  check("an accrual row carries a source key", !!key && !!key.source_key, key);
  let refused = false;
  try {
    await pool.query(
      `INSERT INTO pto_ledger (employee_id, kind, transaction_date, pto_earned, balance_after, source, source_key, reason, rebuilt_at)
       VALUES ($1, 'accrual', '2026-06-30', 0.38, 0.38, 'rethink_provider_day', $2, 'a second copy of June', now()::text)`,
      [dupEmp, key.source_key]);
  } catch (e) { refused = /unique|duplicate/i.test(e.message); }
  check("AND THE DATABASE ITSELF REFUSES A SECOND ROW FOR THE SAME PERIOD", refused,
    "a duplicate accrual row was accepted");

  // ==================================================================
  section("A month with no work is not a month with no data");
  // Per person, Rethink returning nothing is ambiguous: the month may never
  // have been fetched, or it may have been fetched and the person simply has
  // no days in it -- on leave, no clients yet, a month of admin. Those were
  // reported identically, so after a backfill every remaining warning was a
  // false one. The practice-wide answer settles it.
  //
  // These months must belong to this suite alone, or another suite's rows
  // would make an unfetched month look covered.
  for (const m of ["2026-03", "2026-04", "2026-05"]) {
    await pool.query("DELETE FROM rethink_provider_day WHERE month = $1", [m]).catch(() => {});
  }
  const quietEmp = await mk("PTO Quiet Month", "2025-11-01");   // accrues from 2026-03-01
  const peer = await mk("PTO Busy Peer", "2025-11-01");
  // The peer is what makes March and April "fetched": the practice has data.
  await workDay(peer, "2026-03-10", 6, 0);
  await workDay(peer, "2026-04-10", 6, 0);
  // The subject worked in March only. April is covered but empty for her.
  // NOBODY has May, so May is genuinely unfetched.
  await workDay(quietEmp, "2026-03-10", 10, 0);

  const rosterTo = async (to, name) => {
    const r = await owner("/api/pto/roster?to=" + to);
    return (r.data.staff || []).find((x) => x.name === name);
  };

  const toApr = await rosterTo("2026-04-30", "PTO Quiet Month");
  check("APRIL IS FETCHED AND SHE HAS NO DAYS IN IT — that is no hours worked, not a gap",
    toApr && toApr.unsynced_months === 0, toApr && toApr.unsynced_months);
  check("and it is counted as a month with no work", toApr && toApr.no_work_months === 1,
    toApr && toApr.no_work_months);
  check("so the balance is NOT provisional", toApr && toApr.estimated === false,
    toApr && toApr.estimated);
  check("she accrued on March's ten hours and nothing else",
    toApr && near(toApr.accrued, 10 * 0.038, 0.005), toApr && toApr.accrued);

  const toMay = await rosterTo("2026-05-31", "PTO Quiet Month");
  check("MAY WAS NEVER FETCHED BY ANYBODY — that one still warns",
    toMay && toMay.unsynced_months === 1, toMay && toMay.unsynced_months);
  check("April is still a no-work month, not folded into the warning",
    toMay && toMay.no_work_months === 1, toMay && toMay.no_work_months);
  check("and a genuinely unknown month DOES make the balance provisional",
    toMay && toMay.estimated === true, toMay && toMay.estimated);
  check("an unfetched month accrues nothing, exactly as before",
    toMay && near(toMay.accrued, 10 * 0.038, 0.005), toMay && toMay.accrued);

  // The distinction must survive into the ledger, or the audit view inherits
  // the same ambiguity it was built to remove.
  const quietPeriods = (await owner("/api/pto/ledger/" + quietEmp + "?to=2026-04-30")).data;
  check("the working shows April as synced rather than missing",
    !!quietPeriods, "no ledger payload");

  // The peer is the control: she is the reason April counts as fetched, so
  // she must not have picked up a no-work month of her own in March or April.
  const peerRow = await rosterTo("2026-04-30", "PTO Busy Peer");
  check("the peer, who worked in both months, has neither flag",
    peerRow && peerRow.unsynced_months === 0 && peerRow.no_work_months === 0,
    peerRow && [peerRow.unsynced_months, peerRow.no_work_months]);

  // ==================================================================
  section("It still does not invent a second time-off system");
  const src = require("fs").readFileSync("pto.js", "utf8");
  const tables = (src.match(/CREATE TABLE IF NOT EXISTS [a-z_]+/g) || []).map((t) => t.replace(/.*EXISTS /, ""));
  check("the tables it owns are adjustments, the ledger and its snapshots, and nothing else",
    tables.length === 3 && tables.includes("pto_adjustments") && tables.includes("pto_ledger")
    && tables.includes("pto_ledger_snapshots"), tables);
  check("leave taken still comes from staff_time_off", /FROM staff_time_off/.test(src));
  check("and accrual reads no worked-hours table of its own",
    !/FROM hr_timecards/.test(src), "pto.js still queries hr_timecards");

  await purge();
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
