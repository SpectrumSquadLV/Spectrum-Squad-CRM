// PTO accrual and balances.
//
// Accrues per hour worked — the Nevada statutory pattern (NRS 608.0197:
// 0.01923 h per hour worked, 40 hours over a 2,080-hour year).
//
// The hard part is not the arithmetic. It is that "per hour worked" needs
// hours, and salaried staff largely do not clock them. So a balance is either
// MEASURED from approved timecards or ESTIMATED from an assumed standard week,
// and the two must never be silently blended into one confident-looking figure.
// A balance that is half-counted and half-guessed, presented as a number, is
// what turns into a payroll dispute. Most of this suite is about that line.
//
// It also checks the thing that would be worse than any wrong number: that this
// did not create a second time-off system. staff_time_off already records leave
// and the scheduler reads it; this reads the same rows.
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
const ago = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
const near = (a, b, tol = 0.05) => a != null && Math.abs(a - b) <= tol;

(async () => {
  const owner = client();
  check("owner signs in", (await owner("/api/auth/login", {
    method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" },
  })).status === 200);

  const purge = async () => {
    const ids = "(SELECT id FROM hr_employees WHERE name LIKE 'PTO %')";
    for (const t of ["pto_adjustments", "staff_time_off", "hr_timecards"]) {
      await pool.query(`DELETE FROM ${t} WHERE employee_id IN ${ids}`).catch(() => {});
    }
    await pool.query("DELETE FROM hr_employees WHERE name LIKE 'PTO %'").catch(() => {});
  };
  await purge();

  const mk = async (name, extra = {}) => (await pool.query(
    `INSERT INTO hr_employees (name, email, role_title, hr_hire_date, standard_weekly_hours, pto_accrual_rate, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'active') RETURNING id`,
    [name, name.replace(/\W/g, "") + "@example.invalid", extra.role || "BCBA",
     extra.hire || ago(365), extra.weekly == null ? null : extra.weekly,
     extra.rate == null ? null : extra.rate]
  )).rows[0].id;

  // Set the defaults this suite reasons about, so it does not depend on
  // whatever a previous run left behind.
  await owner("/api/pto/settings", { method: "PUT", body: { rate: 0.01923, weekly_hours: 40, annual_cap: 40 } });

  section("The default is the Nevada statutory rate");
  let roster = (await owner("/api/pto/roster")).data;
  check("the roster loads", !!roster && Array.isArray(roster.staff), roster);
  check("the statutory rate is stated", roster.statutory_rate === 0.01923, roster.statutory_rate);
  check("and is the default in use", roster.default_rate === 0.01923, roster.default_rate);

  section("Accrual is capped per benefit year");
  // Quiana's instruction: cap PTO at 40. Implemented as 40 hours per BENEFIT
  // YEAR, counted from the hire anniversary -- not as a cap on the balance.
  // Capping the whole span instead would stop somebody accruing anything at
  // all after their first year, which is a different and much worse policy.
  const threeYears = await mk("PTO ThreeYears", { hire: ago(1095), weekly: 40 });
  let r3 = (await owner("/api/pto/roster")).data;
  let three = (r3.staff || []).find((x) => x.employee_id === threeYears) || {};
  check("the cap is reported on the row", three.annual_cap === 40, three.annual_cap);
  check("three benefit years are counted", three.benefit_years === 3, three.benefit_years);
  check("three years accrue about three caps, not one",
    near(three.accrued, 120, 2), { accrued: three.accrued, benefit_years: three.benefit_years });
  check("and the hours the cap held back are shown, not dropped",
    three.forfeited_to_cap > 0, three.forfeited_to_cap);

  section("Under the cap, nothing is held back");
  const halfYear = await mk("PTO HalfYear", { hire: ago(120), weekly: 20 });
  r3 = (await owner("/api/pto/roster")).data;
  const half = (r3.staff || []).find((x) => x.employee_id === halfYear) || {};
  // ~17 weeks x 20 h = ~343 h x 0.01923 = ~6.6 h, well under 40.
  check("a part year under the cap accrues in full", near(half.accrued, (120 / 7) * 20 * 0.01923, 0.6), half.accrued);
  check("and forfeits nothing", half.forfeited_to_cap === 0, half.forfeited_to_cap);

  section("The cap can be turned off, and 0 means off rather than unset");
  await owner("/api/pto/settings", { method: "PUT", body: { annual_cap: 0 } });
  r3 = (await owner("/api/pto/roster")).data;
  three = (r3.staff || []).find((x) => x.employee_id === threeYears) || {};
  check("uncapped accrues the full amount", three.accrued > 120, three.accrued);
  check("and nothing is reported as forfeited", three.forfeited_to_cap === 0, three.forfeited_to_cap);
  await owner("/api/pto/settings", { method: "PUT", body: { annual_cap: 40 } });

  section("A person can carry their own cap");
  await owner(`/api/pto/employee/${threeYears}`, { method: "PUT", body: { annual_cap: 80 } });
  r3 = (await owner("/api/pto/roster")).data;
  three = (r3.staff || []).find((x) => x.employee_id === threeYears) || {};
  check("their own cap is used", three.annual_cap === 80, three.annual_cap);
  await owner(`/api/pto/employee/${threeYears}`, { method: "PUT", body: { annual_cap: "" } });

  section("A salaried person with no timecards is ESTIMATED, and says so");
  // This is the case Quiana actually has: salaried staff who do not clock in.
  const salaried = await mk("PTO Salaried", { hire: ago(364), weekly: 40 });
  roster = (await owner("/api/pto/roster")).data;
  const find = (id) => (roster.staff || []).find((r) => r.employee_id === id) || {};
  let s = find(salaried);
  check("the basis is the assumed standard week", s.hours_basis === "standard", s.hours_basis);
  check("and the row says why in words",
    /no approved timecards/i.test(s.hours_basis_detail || ""), s.hours_basis_detail);
  check("the balance is flagged as an estimate", s.estimated === true, s.estimated);
  // 364 days ≈ 52 weeks × 40 h = 2080 h; × 0.01923 ≈ 40 h — the statutory year.
  check("a full year at 40 h/week accrues about the statutory 40 hours",
    near(s.accrued, 40, 1.5), { worked: s.hours_worked, accrued: s.accrued });

  section("Someone with approved timecards is MEASURED from them");
  const hourly = await mk("PTO Hourly", { hire: ago(60), weekly: 40, role: "RBT" });
  const addCard = async (empId, from, to, hours) => pool.query(
    `INSERT INTO hr_timecards (employee_id, source, pay_period_start, pay_period_end, raw_json, status, created_at)
     VALUES ($1, 'manual', $2, $3, $4, 'approved', now()::text)`,
    [empId, from, to, JSON.stringify({ entries: [{ hours }] })]
  );
  await addCard(hourly, ago(50), ago(36), 70);
  await addCard(hourly, ago(35), ago(21), 62.5);
  roster = (await owner("/api/pto/roster")).data;
  s = find(hourly);
  check("the basis is timecards", s.hours_basis === "timecards", s.hours_basis);
  check("it counts them", near(s.hours_worked, 132.5), s.hours_worked);
  check("and says how many it used", /2 approved timecards/i.test(s.hours_basis_detail || ""), s.hours_basis_detail);
  check("accrual follows the measured hours", near(s.accrued, 132.5 * 0.01923, 0.02), s.accrued);
  check("and is NOT flagged as an estimate", s.estimated === false, s.estimated);

  section("Measured and assumed are never blended for one person");
  // The whole point. Someone with timecards uses timecards; the standard week
  // is not quietly added on top for the weeks they did not submit one.
  check("timecard hours are not topped up with an assumed week",
    near(s.hours_worked, 132.5),
    { got: s.hours_worked, would_be_if_blended: "much larger" });

  section("Leave taken comes from the existing time-off records");
  const taker = await mk("PTO Taker", { hire: ago(364), weekly: 40 });
  await pool.query(
    `INSERT INTO staff_time_off (employee_id, start_date, end_date, all_day, kind, status, created_at)
     VALUES ($1, $2, $3, TRUE, 'pto', 'approved', now()::text)`,
    [taker, ago(30), ago(28)]  // three days
  );
  roster = (await owner("/api/pto/roster")).data;
  s = find(taker);
  check("three all-day PTO days count as three standard days", near(s.taken, 24), s.taken);
  check("and the assumption is reported, not hidden", s.taken_assumed_days === 3, s.taken_assumed_days);
  check("the balance is accrued minus taken",
    near(s.balance, s.accrued - s.taken + (s.adjustments || 0), 0.02),
    { accrued: s.accrued, taken: s.taken, balance: s.balance });

  section("Only approved PTO counts against the balance");
  const mixed = await mk("PTO Mixed", { hire: ago(364), weekly: 40 });
  await pool.query(
    `INSERT INTO staff_time_off (employee_id, start_date, end_date, all_day, kind, status, created_at)
     VALUES ($1, $2, $2, TRUE, 'pto', 'requested', now()::text)`, [mixed, ago(20)]);
  await pool.query(
    `INSERT INTO staff_time_off (employee_id, start_date, end_date, all_day, kind, status, created_at)
     VALUES ($1, $2, $2, TRUE, 'sick', 'approved', now()::text)`, [mixed, ago(19)]);
  await pool.query(
    `INSERT INTO staff_time_off (employee_id, start_date, end_date, all_day, kind, status, created_at)
     VALUES ($1, $2, $2, TRUE, 'unpaid', 'approved', now()::text)`, [mixed, ago(18)]);
  roster = (await owner("/api/pto/roster")).data;
  check("a requested-but-not-approved day does not count", near(find(mixed).taken, 0), find(mixed).taken);

  section("A part-day is measured from its actual times");
  const partial = await mk("PTO Partial", { hire: ago(364), weekly: 40 });
  await pool.query(
    `INSERT INTO staff_time_off (employee_id, start_date, end_date, all_day, start_time, end_time, kind, status, created_at)
     VALUES ($1, $2, $2, FALSE, '09:00', '13:00', 'pto', 'approved', now()::text)`, [partial, ago(10)]);
  roster = (await owner("/api/pto/roster")).data;
  check("four hours off counts as four hours", near(find(partial).taken, 4), find(partial).taken);
  check("and nothing was assumed for it", find(partial).taken_assumed_days === 0, find(partial).taken_assumed_days);

  section("A person can carry their own rate and week");
  const custom = await mk("PTO Custom", { hire: ago(364), weekly: 20, rate: 0.04 });
  roster = (await owner("/api/pto/roster")).data;
  s = find(custom);
  check("their own rate is used", s.rate === 0.04, s.rate);
  check("their own week is used", s.weekly_hours === 20, s.weekly_hours);
  // 52 weeks x 20 h x 0.04 = 41.6 h, which the 40 h cap clips. That the cap
  // binds here is the point: a per-person rate does not escape the cap.
  check("and the accrual reflects both, then meets the cap", near(s.accrued, 40, 0.1), s.accrued);
  check("with the clipped hours reported", near(s.forfeited_to_cap, 1.6, 0.2), s.forfeited_to_cap);

  section("No hire date means no invented start");
  const nohire = (await pool.query(
    `INSERT INTO hr_employees (name, email, status) VALUES ('PTO NoHire', 'ptonohire@example.invalid', 'active') RETURNING id`
  )).rows[0].id;
  roster = (await owner("/api/pto/roster")).data;
  s = find(nohire);
  check("it says so rather than accruing from nowhere",
    /no hire date/i.test(s.error || ""), s.error);
  check("and no balance is produced", s.balance === null, s.balance);

  section("Adjustments are possible, and must be explained");
  check("an adjustment needs a reason",
    (await owner("/api/pto/adjustment", { method: "POST", body: { employee_id: taker, hours: 40 } })).status === 400);
  check("with one, it is accepted",
    (await owner("/api/pto/adjustment", {
      method: "POST", body: { employee_id: taker, hours: 40, reason: "Opening balance carried in from the spreadsheet" },
    })).status === 200);
  roster = (await owner("/api/pto/roster")).data;
  check("and it moves the balance", near(find(taker).adjustments, 40), find(taker).adjustments);
  check("a zero-hour adjustment is refused",
    (await owner("/api/pto/adjustment", { method: "POST", body: { employee_id: taker, hours: 0, reason: "x" } })).status === 400);

  section("Settings are validated rather than trusted");
  check("a negative rate is refused",
    (await owner("/api/pto/settings", { method: "PUT", body: { rate: -1 } })).status === 400);
  check("a 200-hour week is refused",
    (await owner("/api/pto/settings", { method: "PUT", body: { weekly_hours: 200 } })).status === 400);
  check("nonsense is refused",
    (await owner("/api/pto/settings", { method: "PUT", body: { rate: "lots" } })).status === 400);
  check("a negative cap is refused",
    (await owner("/api/pto/settings", { method: "PUT", body: { annual_cap: -1 } })).status === 400);
  check("but zero is allowed, because it means uncapped",
    (await owner("/api/pto/settings", { method: "PUT", body: { annual_cap: 0 } })).status === 200);
  await owner("/api/pto/settings", { method: "PUT", body: { annual_cap: 40 } });

  section("It did not build a second time-off system");
  // The rule from the original brief: do not duplicate what exists. Leave
  // taken must still live in staff_time_off, which the scheduler owns.
  const fs = require("fs");
  const src = fs.readFileSync(require("path").join(__dirname, "pto.js"), "utf8");
  check("it reads the existing time-off table", /FROM staff_time_off/.test(src));
  check("and creates no table of its own for leave",
    !/CREATE TABLE[^;]*time_off/i.test(src));
  check("the only table it adds is for adjustments",
    (src.match(/CREATE TABLE IF NOT EXISTS (\w+)/g) || []).join(",") === "CREATE TABLE IF NOT EXISTS pto_adjustments",
    (src.match(/CREATE TABLE IF NOT EXISTS (\w+)/g) || []));

  section("Not everyone may see leave balances");
  const clinical = client();
  await clinical("/api/auth/login", { method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } });
  check("a clinical user cannot read the roster", (await clinical("/api/pto/roster")).status === 403);
  check("nor post an adjustment",
    (await clinical("/api/pto/adjustment", { method: "POST", body: { employee_id: taker, hours: 8, reason: "x" } })).status === 403);

  await purge();
  await pool.end();
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
