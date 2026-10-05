// pto.js -- PTO accrual and balances.
//
// Accrues per hour worked, which is the Nevada statutory pattern: NRS 608.0197
// requires employers of 50 or more to provide at least 0.01923 hours of paid
// leave per hour worked (40 hours over a 2,080-hour year). That is the default
// rate here; it is a setting, and each person can carry their own.
//
// WHAT THIS DOES NOT DO: it does not invent a second time-off system.
// staff_time_off already records approved leave and is what the scheduler
// reads. This adds only the half that was missing -- how much has been earned
// -- and takes what has been used from that existing table.
//
// THE SALARIED PROBLEM, STATED PLAINLY.
//
// "Per hour worked" needs hours, and salaried staff largely do not clock them.
// So each person's hours come from one of two bases, and WHICH ONE IS ALWAYS
// REPORTED next to the number:
//
//   timecards  -- approved timecard hours in the period. Real, measured.
//   standard   -- their standard weekly hours spread across the period. An
//                 assumption, and labelled as one.
//
// The two are never silently mixed for one person: a month with any approved
// timecard uses timecards for that month, or it uses the standard. A balance
// that is half-measured and half-assumed, presented as one figure, is the kind
// of number somebody takes to a payroll dispute.
//
// Nothing here writes to payroll. It is a record of what has been earned and
// taken, for a human to act on.
"use strict";

// Nevada's statutory minimum. Kept as the floor this policy must clear, and
// reported alongside the real rate so the comparison is visible -- it is no
// longer the default, because Spectrum Squad's own policy is more generous.
const NV_STATUTORY_RATE = 0.01923;
// Nevada permits limiting accrual to 40 hours per benefit year.
const NV_ANNUAL_CAP = 40;

// ---------------------------------------------------------------------------
// SPECTRUM SQUAD PTO POLICY, effective 1 March 2026.
// ---------------------------------------------------------------------------
// 0.038 hours earned per hour actually worked. Roughly twice the Nevada
// statutory minimum, which is why the statutory figure above is no longer the
// default: anybody still on it was accruing at half the rate they were owed.
const POLICY_RATE = 0.038;

// The policy does not exist before this date, so no hour worked before it can
// earn anything -- not even for somebody whose 90 days were long finished.
const POLICY_START = "2026-03-01";

// Ninety days of employment before accrual begins. The spec's formula has no
// ceiling in it -- `balance = worked x 0.038 - used` -- so the default cap is
// OFF. Nevada's 40-hour cap would silently discard about half of a full-time
// year at this rate (2,080 h x 0.038 = 79 h), and discarding half of what the
// written policy promises is not a default anybody should get by accident.
// The cap machinery stays; only the default changes.
const WAITING_DAYS = 90;
const POLICY_ANNUAL_CAP = 0;

module.exports = function initPto(ctx) {
  const { dbGet, dbAll, dbRun, nowISO, readBody, json, getAppSetting, setAppSetting } = ctx;
  // The ONE source of worked hours. Passed in rather than required directly so
  // this module keeps no opinion about how Rethink is configured, and so a
  // server without the integration degrades to "nothing synced" instead of
  // falling back to a number it made up.
  const rethinkHoursBetween = ctx.rethinkHoursBetween || null;
  const rethinkCoversRange = ctx.rethinkCoversRange || null;

  const today = () => new Date().toISOString().slice(0, 10);
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const round2 = (n) => Math.round(num(n) * 100) / 100;
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
  const canManage = (u) => !!u && ["owner", "super_admin", "admin", "hr_admin"].includes(u.role);

  async function initTables() {
    await dbRun("ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS pto_accrual_rate NUMERIC").catch(() => {});
    await dbRun("ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS standard_weekly_hours NUMERIC").catch(() => {});
    await dbRun("ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS pto_enrolled BOOLEAN NOT NULL DEFAULT false").catch(() => {});
    await dbRun("ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS pto_annual_cap NUMERIC").catch(() => {});

    // Manual entries: an opening balance carried in from a spreadsheet, a
    // correction, a payout. Kept separate from accrual and usage so a balance
    // can always be explained as earned - taken +/- adjustments, rather than
    // being a number somebody edited.
    await dbRun(`CREATE TABLE IF NOT EXISTS pto_adjustments (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      hours NUMERIC NOT NULL,
      reason TEXT,
      effective_date TEXT,
      created_by TEXT,
      created_at TEXT
    )`).catch((e) => console.error("[pto] pto_adjustments initTables:", e.message));

    // THE AUDITABLE LEDGER.
    //
    // One row per transaction, so "why does Ada have 11.4 hours" is answered
    // by reading rows rather than by re-running a calculation and hoping it
    // agrees with whatever produced the number on the screen last time.
    //
    // IT IS A DERIVED PROJECTION, NOT A SOURCE. Every row is rebuilt from the
    // authoritative tables -- Rethink days for accrual, staff_time_off for
    // usage, pto_adjustments for corrections -- and a rebuild DELETES this
    // employee's rows before writing new ones.
    //
    // That is the whole anti-double-counting design, and it is worth being
    // explicit about why it is stronger than de-duplicating on insert:
    // rebuilding is IDEMPOTENT. Run it once or run it fifty times and the
    // ledger is identical, because nothing is ever added to what is already
    // there. There is no "have I already accrued March?" question to get
    // wrong, because March is recomputed from March's hours every time.
    await dbRun(`CREATE TABLE IF NOT EXISTS pto_ledger (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      kind TEXT NOT NULL,                  -- accrual | usage | adjustment
      period_start TEXT,                   -- accrual: the month; usage: the leave
      period_end TEXT,
      transaction_date TEXT NOT NULL,
      eligible_hours NUMERIC,              -- billable + non-billable, combined before the rate
      billable_hours NUMERIC,
      nonbillable_hours NUMERIC,
      unclassified_hours NUMERIC,          -- reported, NOT accrued on
      accrual_rate NUMERIC,
      pto_earned NUMERIC DEFAULT 0,
      pto_used NUMERIC DEFAULT 0,
      adjustment NUMERIC DEFAULT 0,
      forfeited_to_cap NUMERIC DEFAULT 0,
      balance_after NUMERIC,               -- running balance, in transaction order
      source TEXT,                         -- which table this row was derived from
      reason TEXT,
      rebuilt_at TEXT NOT NULL
    )`).catch((e) => console.error("[pto] pto_ledger initTables:", e.message));
    await dbRun("CREATE INDEX IF NOT EXISTS idx_pto_ledger_emp ON pto_ledger(employee_id, transaction_date, id)").catch(() => {});
    // THE SECOND LOCK ON DOUBLE COUNTING. Rebuilding is already idempotent
    // because it replaces rather than appends -- but that is a property of one
    // function, and a future insert path written by somebody in a hurry would
    // not inherit it. This makes it a property of the TABLE: one accrual row
    // per employee per period, refused by the database itself.
    await dbRun("ALTER TABLE pto_ledger ADD COLUMN IF NOT EXISTS source_key TEXT").catch(() => {});
    await dbRun("CREATE UNIQUE INDEX IF NOT EXISTS idx_pto_ledger_source ON pto_ledger(source_key) WHERE source_key IS NOT NULL")
      .catch((e) => console.error("[pto] ledger source_key index:", e.message));

    // REVERSIBILITY. Every rebuild snapshots what it is about to replace,
    // before replacing it, so a recalculation that turns out to be wrong can
    // be put back. Balances are computed, so "the old balance" is otherwise
    // unrecoverable the moment the calculation changes.
    await dbRun(`CREATE TABLE IF NOT EXISTS pto_ledger_snapshots (
      id SERIAL PRIMARY KEY,
      batch_id TEXT NOT NULL,
      employee_id INTEGER NOT NULL,
      taken_at TEXT NOT NULL,
      taken_by TEXT,
      note TEXT,
      -- The whole of that person's prior position, as JSON: the ledger rows
      -- that existed and the balance they produced. Restoring is writing it
      -- back, not recomputing it.
      prior_rows TEXT,
      prior_balance NUMERIC
    )`).catch((e) => console.error("[pto] pto_ledger_snapshots initTables:", e.message));
    await dbRun("CREATE INDEX IF NOT EXISTS idx_pto_snap_batch ON pto_ledger_snapshots(batch_id)").catch(() => {});
  }

  async function companyRate() {
    const raw = getAppSetting ? await getAppSetting("pto_accrual_rate", "") : "";
    const r = Number(raw);
    return Number.isFinite(r) && r > 0 ? r : POLICY_RATE;
  }
  // The most anyone accrues in one benefit year. Nevada permits an employer to
  // limit accrual to 40 hours per benefit year, and that is the default.
  //
  // 0 means uncapped, and is distinguished from "unset": somebody who
  // deliberately turns the cap off should not silently get 40 back.
  async function companyAnnualCap() {
    const raw = getAppSetting ? await getAppSetting("pto_annual_cap", "") : "";
    if (String(raw).trim() === "") return POLICY_ANNUAL_CAP;
    const c = Number(raw);
    return Number.isFinite(c) && c >= 0 ? c : POLICY_ANNUAL_CAP;
  }

  async function companyWeeklyHours() {
    const raw = getAppSetting ? await getAppSetting("pto_standard_weekly_hours", "") : "";
    const h = Number(raw);
    return Number.isFinite(h) && h > 0 ? h : 40;
  }

  // The benefit years between hire and now, as [start, end] pairs. A benefit
  // year runs from the hire anniversary, because that is when accrual started;
  // using the calendar year instead would hand a January hire a full year's cap
  // for one month of work.
  function benefitYears(hire, end) {
    const out = [];
    let s = hire;
    while (s <= end) {
      const d = new Date(s + "T00:00:00Z");
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      const nextStart = d.toISOString().slice(0, 10);
      const yearEnd = nextStart <= end
        ? new Date(d.getTime() - 86400000).toISOString().slice(0, 10)
        : end;
      out.push([s, yearEnd]);
      s = nextStart;
      if (out.length > 60) break; // a guard, not a policy
    }
    return out;
  }

  const addDays = (iso, n) => {
    const d = new Date(String(iso).slice(0, 10) + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  // WHEN THIS PERSON STARTS EARNING.
  //
  //   the later of:  1 March 2026          (the policy did not exist before it)
  //                  hire date + 90 days   (the waiting period)
  //
  // Returning the two inputs alongside the answer is the point: "why does Ada
  // have nothing for April?" is answerable from this object without anybody
  // re-deriving it by hand, and a balance screen that cannot answer that
  // question generates a payroll conversation instead.
  function accrualStart(hireDate) {
    const hire = String(hireDate || "").slice(0, 10);
    if (!isDate(hire)) {
      return { start: null, hire: null, waiting_ends: null, reason: "no hire date on file" };
    }
    // Day 91 is the first earning day: the waiting period is 90 days of
    // employment COMPLETED, so the ninetieth day is still inside it.
    const waitingEnds = addDays(hire, WAITING_DAYS);
    const start = waitingEnds > POLICY_START ? waitingEnds : POLICY_START;
    return {
      start,
      hire,
      waiting_ends: waitingEnds,
      reason: start === POLICY_START
        ? `the policy began ${POLICY_START} and the 90-day waiting period was already complete`
        : `the 90-day waiting period ended ${waitingEnds}`,
    };
  }

  // Calendar months spanning [from, to], as inclusive [start, end] pairs.
  function monthsBetween(from, to) {
    const out = [];
    let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
    const guard = 600; // 50 years; a guard, not a policy
    while (out.length < guard) {
      const ms = `${y}-${String(m).padStart(2, "0")}-01`;
      if (ms > to) break;
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      out.push([ms, `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`]);
      m++; if (m > 12) { m = 1; y++; }
    }
    return out;
  }

  // Which year of accrual a date falls in, counted from the accrual start.
  function yearIndex(start, day) {
    const s = new Date(start + "T00:00:00Z");
    const d = new Date(day + "T00:00:00Z");
    let i = 0;
    const anniv = new Date(s.getTime());
    while (true) {
      anniv.setUTCFullYear(anniv.getUTCFullYear() + 1);
      if (d < anniv) return i;
      i++;
      if (i > 60) return i;
    }
  }

  const daysBetween = (a, b) =>
    Math.max(0, Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000) + 1);

  // ELIGIBLE WORKED HOURS IN A WINDOW.
  //
  // ONE SOURCE, DELIBERATELY: rethink_provider_day, which holds one row per
  // (provider, day) with billable and non-billable hours already separated.
  //
  // That single choice is what makes double counting impossible rather than
  // merely unlikely. The table has a UNIQUE constraint on (staff, day), the
  // rows are keyed by calendar day, and a date range sums each day exactly
  // once. There is no second stream to reconcile against, so the same hour
  // cannot arrive twice by two routes.
  //
  // WHAT THIS REPLACED, and why it was wrong:
  //
  //   * approved timecards -- measured, but a different measurement. Clocked
  //     time and delivered service time overlap for a clinician, and summing
  //     them counts the same hour twice. Timecards are no longer consulted
  //     for accrual at all.
  //
  //   * "standard weekly hours x weeks" when no timecard existed. This was
  //     the serious one: it ACCRUED PTO ON HOURS NOBODY WORKED. A person on
  //     leave for a month, or not yet started, or simply not clocking,
  //     accumulated leave for time they did not work. The policy says accrual
  //     is on hours ACTUALLY worked, so an assumption cannot stand in for a
  //     measurement, and this function will now return null rather than
  //     invent a number.
  //
  // UNCLASSIFIED HOURS ARE EXCLUDED but reported. Rethink sometimes returns
  // time the billable classifier could not bucket; it is neither billable nor
  // non-billable, and the policy names those two. Counting it would over-pay
  // on a guess. It is surfaced so that a gap can be seen and fixed at source
  // rather than quietly rounded away.
  //
  // NOTHING SYNCED IS NOT ZERO HOURS. billableHoursBetween returns null when
  // no day in the range has been synced, and that distinction is carried all
  // the way to the screen: a month that has not come back from Rethink must
  // never read as a month somebody did no work.
  async function eligibleHours(empId, from, to) {
    if (!rethinkHoursBetween) {
      return { hours: null, billable: null, nonbillable: null, unclassified: 0,
               synced: false, detail: "The Rethink integration is not available to this server." };
    }
    const got = await rethinkHoursBetween(empId, from, to).catch(() => null);
    if (!got) {
      // NO ROWS FOR THIS PERSON HAS TWO CAUSES, AND THEY ARE OPPOSITES.
      //
      // Either the month was never fetched -- hours unknown -- or it was
      // fetched and Rethink has no days for this person in it, which means
      // they worked none. Before the backfill nearly every case was the
      // first; after it, nearly every case is the second, and reporting them
      // identically turned the warning into noise on exactly the screens
      // where it mattered.
      //
      // The practice-wide answer settles it. A month that came back for
      // anybody came back.
      const covered = rethinkCoversRange
        ? await rethinkCoversRange(from, to).catch(() => false)
        : false;
      if (covered) {
        // A measurement of zero, not an absence of one. It accrues nothing --
        // identical arithmetic to the unsynced branch -- but it is a KNOWN
        // nothing, so it does not make the balance provisional and does not
        // raise a warning somebody cannot act on.
        return { hours: 0, billable: 0, nonbillable: 0, unclassified: 0,
                 synced: true, no_days: true,
                 detail: "Rethink has this period and lists no days for this person — no hours worked." };
      }
      return { hours: null, billable: null, nonbillable: null, unclassified: 0,
               synced: false, detail: "No days in this period have been synced from Rethink yet." };
    }
    const billable = num(got.billable);
    const nonbillable = num(got.nonbillable);
    const unclassified = num(got.unclassified);
    return {
      // Combined BEFORE the rate is applied, and NOT ROUNDED HERE. Rounding an
      // intermediate is how a ledger stops reconciling with itself: twelve
      // monthly figures each rounded to the cent do not add up to the year
      // rounded once. Full precision travels all the way to the display edge.
      hours: billable + nonbillable,
      billable,
      nonbillable,
      unclassified,
      synced: true,
      unverified_appointments: Number(got.unverified_appointments) || 0,
      detail: unclassified > 0
        ? `${round2(unclassified)} h Rethink reported but could not classify are excluded`
        : "Billable and non-billable hours from Rethink",
    };
  }

  // PTO taken, from the table that already records it.
  //
  // An all-day entry has no hours on it, so a day is counted as the person's
  // standard day (their week / 5). That is an assumption and is reported as
  // one; a part-day entry with real times is measured from those times.
  async function hoursTaken(empId, from, to, weeklyHours) {
    const rows = await dbAll(
      `SELECT * FROM staff_time_off
        WHERE employee_id = ? AND COALESCE(kind,'pto') = 'pto'
          AND COALESCE(status,'approved') = 'approved'
          AND end_date >= ? AND start_date <= ?`,
      [empId, from, to]
    ).catch(() => []);

    const dayHours = num(weeklyHours) / 5;
    let hours = 0;
    let assumedDays = 0;
    for (const r of rows) {
      // Only the part of the leave that falls inside the window.
      const s = r.start_date > from ? r.start_date : from;
      const e = r.end_date < to ? r.end_date : to;
      if (s > e) continue;

      if (r.all_day === false && r.start_time && r.end_time) {
        const mins = (t) => {
          const [h, m] = String(t).split(":").map(Number);
          return (h || 0) * 60 + (m || 0);
        };
        hours += Math.max(0, (mins(r.end_time) - mins(r.start_time)) / 60);
      } else {
        const days = daysBetween(s, e);
        hours += days * dayHours;
        assumedDays += days;
      }
    }
    return { hours: round2(hours), assumed_days: assumedDays, entries: rows.length };
  }

  // One person's position. `from` defaults to their hire date, because that is
  // when accrual starts.
  async function balanceFor(emp, { from, to } = {}) {
    const rate = emp.pto_accrual_rate == null ? await companyRate() : num(emp.pto_accrual_rate);
    const weekly = emp.standard_weekly_hours == null ? await companyWeeklyHours() : num(emp.standard_weekly_hours);
    const hire = String(emp.hire_date || "").slice(0, 10);
    const elig = accrualStart(hire);
    // A caller-supplied `from` narrows the view; it can never move accrual
    // earlier than the person is eligible. Otherwise a report run "from
    // January" would quietly grant retroactive accrual the policy forbids.
    const start = elig.start && isDate(from) && from > elig.start ? from : elig.start;
    const end = isDate(to) ? to : today();

    if (!start) {
      return {
        employee_id: emp.id, name: emp.name, enrolled: emp.pto_enrolled === true,
        rate, weekly_hours: weekly, eligibility: elig,
        error: "No hire date on file, so the 90-day waiting period cannot be worked out.",
        accrued: null, taken: null, adjustments: null, balance: null,
      };
    }
    if (end < start) {
      // Not an error: a new hire inside their waiting period is in a perfectly
      // normal state, and saying so is more useful than a red message.
      return {
        employee_id: emp.id, name: emp.name, role_title: emp.role_title || "",
        enrolled: emp.pto_enrolled === true,
        rate, weekly_hours: weekly, eligibility: elig,
        period: { from: start, to: end },
        hours_worked: 0, hours_basis: "rethink",
        hours_basis_detail: `Not yet accruing — accrual begins ${start} (${elig.reason}).`,
        accrued: 0, annual_cap: emp.pto_annual_cap == null ? await companyAnnualCap() : num(emp.pto_annual_cap),
        periods: [], taken: 0, adjustments: 0, balance: 0,
        not_yet_eligible: true, estimated: false, error: null,
      };
    }

    const cap = emp.pto_annual_cap == null ? await companyAnnualCap() : num(emp.pto_annual_cap);

    // ACCRUAL IS COMPUTED PER CALENDAR MONTH, not per benefit year and not
    // over the whole span at once.
    //
    // Per month because that is the grain Rethink syncs at and the grain a
    // person reads a payslip at: "March, 142 hours, 5.40 earned" is a line
    // somebody can check against their own diary. A single figure for three
    // years is not auditable by anybody.
    //
    // The rate is applied to the MONTH'S COMBINED TOTAL, once -- never per
    // appointment, which is where rounding error creeps in a cent at a time.
    const months = monthsBetween(start, end);
    const periods = [];
    let accrued = 0;
    let forfeited = 0;
    let workedTotal = 0;
    let billableTotal = 0;
    let nonbillableTotal = 0;
    let unclassifiedTotal = 0;
    let unsyncedMonths = 0;
    // Months Rethink has, in which this person has no days. Counted apart
    // from unsynced ones because they are the opposite fact: measured, not
    // missing.
    let noWorkMonths = 0;
    // The cap, where one is set, is a per-benefit-year ceiling, so accrual has
    // to be tallied per year even though it is earned per month.
    const yearTally = new Map();

    for (const [ms, me] of months) {
      // Never earlier than the accrual start and never later than today: a
      // month straddling the eligibility date accrues only on its eligible
      // part, which is what "no retroactive accrual for the first 90 days"
      // means in practice.
      const ps = ms < start ? start : ms;
      const pe = me > end ? end : me;
      if (ps > pe) continue;

      const w = await eligibleHours(emp.id, ps, pe);
      if (!w.synced) {
        unsyncedMonths++;
        periods.push({ from: ps, to: pe, synced: false, hours: null, earned: null, detail: w.detail });
        continue;
      }
      if (w.no_days) noWorkMonths++;
      workedTotal += w.hours;
      billableTotal += w.billable;
      nonbillableTotal += w.nonbillable;
      unclassifiedTotal += w.unclassified;

      const raw = w.hours * rate;
      let allowed = raw;
      if (cap > 0) {
        // Which benefit year this month falls in, counted from the accrual
        // start rather than from hire: a cap measured from a date somebody was
        // not yet earning on would expire before they had used it.
        const yi = yearIndex(start, ps);
        const soFar = yearTally.get(yi) || 0;
        allowed = Math.max(0, Math.min(raw, cap - soFar));
        yearTally.set(yi, soFar + allowed);
      }
      accrued += allowed;
      forfeited += raw - allowed;
      periods.push({
        from: ps, to: pe, synced: true,
        // Rounded for reading; the running totals above stay at full
        // precision, so a column of these may differ from the total by a cent
        // and the total is the one that is right.
        hours: round2(w.hours), billable: round2(w.billable), nonbillable: round2(w.nonbillable),
        unclassified: round2(w.unclassified),
        no_days: w.no_days === true,
        rate, earned: round2(allowed),
        earned_exact: allowed,
        forfeited_to_cap: round2(raw - allowed),
        detail: w.detail,
        // The idempotency key. One accrual row can exist per employee per
        // period, enforced by a UNIQUE index -- so even an insert path that
        // forgot to clear first cannot write March twice.
        source_key: `rethink:${emp.id}:${ps}:${pe}`,
      });
    }
    accrued = round2(accrued);
    forfeited = round2(forfeited);

    const worked = {
      hours: round2(workedTotal),
      basis: "rethink",
      detail: unsyncedMonths
        ? `${unsyncedMonths} month${unsyncedMonths === 1 ? " has" : "s have"} not been synced from Rethink and are not counted`
        : "Billable and non-billable hours from Rethink",
    };

    const taken = await hoursTaken(emp.id, start, end, weekly);
    const adjRows = await dbAll(
      "SELECT hours, reason, effective_date FROM pto_adjustments WHERE employee_id = ?", [emp.id]
    ).catch(() => []);
    const adjustments = round2(adjRows.reduce((s, a) => s + num(a.hours), 0));
    return {
      employee_id: emp.id,
      name: emp.name,
      role_title: emp.role_title || "",
      enrolled: emp.pto_enrolled === true,
      period: { from: start, to: end },
      rate,
      weekly_hours: weekly,
      eligibility: elig,
      hours_worked: worked.hours,
      hours_billable: round2(billableTotal),
      hours_nonbillable: round2(nonbillableTotal),
      // Reported, never accrued on. See eligibleHours().
      hours_unclassified: round2(unclassifiedTotal),
      hours_basis: worked.basis,          // always "rethink" now
      hours_basis_detail: worked.detail,
      // Month by month, so a balance can be read back rather than taken on
      // trust. This is the audit trail the screen renders.
      periods,
      unsynced_months: unsyncedMonths,
      // Months with nothing to accrue on because nothing was worked. Not a
      // warning -- shown so a short balance can be explained rather than
      // merely noticed.
      no_work_months: noWorkMonths,
      accrued,
      annual_cap: cap,
      // Hours the cap prevented accruing. Shown rather than dropped: somebody
      // will ask why a full year of work produced 40 hours and not 52.
      forfeited_to_cap: forfeited,
      taken: taken.hours,
      taken_assumed_days: taken.assumed_days,
      taken_entries: taken.entries,
      adjustments,
      adjustment_notes: adjRows,
      balance: round2(accrued - taken.hours + adjustments),
      // What makes a balance provisional now is a month Rethink has not sent
      // yet, or a leave entry with no times on it. Neither is invented hours
      // -- that source is gone -- but both mean the number can still move.
      estimated: unsyncedMonths > 0 || taken.assumed_days > 0,
      error: null,
    };
  }

  // REBUILD ONE PERSON'S LEDGER FROM SOURCE.
  //
  // Deletes their rows and regenerates them. That is deliberate and it is the
  // reconciliation the policy asks for: the existing balances may already be
  // wrong, so the corrected figure must REPLACE them rather than being added
  // on top of them. Adding would compound the error it is meant to fix.
  //
  // Idempotent by construction -- see the table comment. Running this twice
  // changes nothing the second time.
  async function rebuildLedger(emp, { to, dryRun, batchId, actor, note } = {}) {
    const bal = await balanceFor(emp, { to });
    const now = nowISO();

    // What is there now, kept before anything replaces it. Taken even on a dry
    // run's behalf? No -- a dry run writes nothing at all, including this.
    const prior = await dbAll("SELECT * FROM pto_ledger WHERE employee_id = ? ORDER BY transaction_date, id", [emp.id]).catch(() => []);
    const priorBalance = prior.length ? num(prior[prior.length - 1].balance_after) : null;

    if (!dryRun) {
      await dbRun(
        `INSERT INTO pto_ledger_snapshots (batch_id, employee_id, taken_at, taken_by, note, prior_rows, prior_balance)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [batchId || ("manual-" + now), emp.id, now, actor || null, note || null,
         JSON.stringify(prior), priorBalance]
      ).catch((e) => console.error("[pto] snapshot:", e.message));
      await dbRun("DELETE FROM pto_ledger WHERE employee_id = ?", [emp.id]);
    }
    if (bal.error) return { ...bal, ledger_rows: 0, prior_balance: priorBalance, dry_run: !!dryRun };

    // Accrual, usage and adjustments interleaved in date order, so the running
    // balance column is the balance as it actually stood on that date.
    const rows = [];
    for (const p of bal.periods || []) {
      if (!p.synced) continue;
      rows.push({
        kind: "accrual", period_start: p.from, period_end: p.to, transaction_date: p.to,
        eligible_hours: p.hours, billable_hours: p.billable, nonbillable_hours: p.nonbillable,
        unclassified_hours: p.unclassified, accrual_rate: p.rate,
        pto_earned: p.earned, pto_used: 0, adjustment: 0,
        forfeited_to_cap: p.forfeited_to_cap || 0,
        source: "rethink_provider_day",
        source_key: p.source_key,
        reason: `${p.hours} eligible h x ${p.rate}` + (p.unclassified ? ` (${p.unclassified} h unclassified, excluded)` : ""),
      });
    }
    const leave = await dbAll(
      `SELECT * FROM staff_time_off
        WHERE employee_id = ? AND COALESCE(kind,'pto') = 'pto'
          AND COALESCE(status,'approved') = 'approved' AND end_date >= ?`,
      [emp.id, bal.period.from]).catch(() => []);
    const weekly = emp.standard_weekly_hours == null ? await companyWeeklyHours() : num(emp.standard_weekly_hours);
    for (const r of leave) {
      const s2 = r.start_date > bal.period.from ? r.start_date : bal.period.from;
      const e2 = r.end_date < bal.period.to ? r.end_date : bal.period.to;
      if (s2 > e2) continue;
      let hrs, assumed = false;
      if (r.all_day === false && r.start_time && r.end_time) {
        const mins = (t) => { const [h, m] = String(t).split(":").map(Number); return (h || 0) * 60 + (m || 0); };
        hrs = Math.max(0, (mins(r.end_time) - mins(r.start_time)) / 60);
      } else {
        hrs = daysBetween(s2, e2) * (num(weekly) / 5);
        assumed = true;
      }
      rows.push({
        kind: "usage", period_start: s2, period_end: e2, transaction_date: s2,
        eligible_hours: null, accrual_rate: null,
        pto_earned: 0, pto_used: round2(hrs), adjustment: 0, forfeited_to_cap: 0,
        source: "staff_time_off",
        reason: assumed ? `${daysBetween(s2, e2)} day(s) at the assumed ${round2(num(weekly) / 5)} h standard day` : "Part-day leave, measured from its times",
      });
    }
    const adjs = await dbAll(
      "SELECT hours, reason, effective_date, created_by FROM pto_adjustments WHERE employee_id = ? ORDER BY id", [emp.id]
    ).catch(() => []);
    for (const a of adjs) {
      rows.push({
        kind: "adjustment", period_start: null, period_end: null,
        transaction_date: a.effective_date || today(),
        eligible_hours: null, accrual_rate: null,
        pto_earned: 0, pto_used: 0, adjustment: num(a.hours), forfeited_to_cap: 0,
        source: "pto_adjustments",
        reason: (a.reason || "Manual adjustment") + (a.created_by ? ` — ${a.created_by}` : ""),
      });
    }

    rows.sort((x, y) => String(x.transaction_date).localeCompare(String(y.transaction_date))
      || (x.kind === "accrual" ? -1 : 1));

    let running = 0;
    if (dryRun) {
      // PROPOSED, NOT APPLIED. The policy asks to see the recalculation before
      // any destructive historical update runs, so this path computes the
      // whole thing and writes nothing -- not a ledger row, not a snapshot.
      const preview = rows.map((r) => {
        running = round2(running + num(r.pto_earned) - num(r.pto_used) + num(r.adjustment));
        return { ...r, balance_after: running };
      });
      return {
        ...bal, dry_run: true, ledger_rows: preview.length, ledger_balance: running,
        prior_balance: priorBalance,
        // The number that will actually change, which is the only one anybody
        // reads before approving a run like this.
        delta: priorBalance == null ? null : round2(running - priorBalance),
        proposed_rows: preview,
      };
    }
    for (const r of rows) {
      running = round2(running + num(r.pto_earned) - num(r.pto_used) + num(r.adjustment));
      await dbRun(
        `INSERT INTO pto_ledger
           (employee_id, kind, period_start, period_end, transaction_date,
            eligible_hours, billable_hours, nonbillable_hours, unclassified_hours,
            accrual_rate, pto_earned, pto_used, adjustment, forfeited_to_cap,
            balance_after, source, source_key, reason, rebuilt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [emp.id, r.kind, r.period_start, r.period_end, r.transaction_date,
         r.eligible_hours, r.billable_hours == null ? null : r.billable_hours,
         r.nonbillable_hours == null ? null : r.nonbillable_hours,
         r.unclassified_hours == null ? null : r.unclassified_hours,
         r.accrual_rate, r.pto_earned, r.pto_used, r.adjustment, r.forfeited_to_cap,
         running, r.source, r.source_key || null, r.reason, now]
      ).catch((e) => console.error("[pto] ledger row:", e.message));
    }
    return { ...bal, ledger_rows: rows.length, ledger_balance: running,
             prior_balance: priorBalance,
             delta: priorBalance == null ? null : round2(running - priorBalance),
             dry_run: false };
  }

  // Every employee, reconciled. Returns what changed so a run can be read
  // rather than trusted.
  async function rebuildAll({ to, dryRun, actor, note } = {}) {
    const batchId = (dryRun ? "preview-" : "batch-") + nowISO();
    const emps = await dbAll(
      `SELECT id, name, email, role_title,
              COALESCE(NULLIF(hr_hire_date, ''), NULLIF(hire_date, '')) AS hire_date,
              pto_accrual_rate, standard_weekly_hours, pto_annual_cap, pto_enrolled
         FROM hr_employees
        WHERE COALESCE(status,'active') <> 'terminated'
        ORDER BY name`).catch(() => []);
    const out = [];
    for (const e of emps) {
      const r = await rebuildLedger(e, { to, dryRun, batchId, actor, note });
      out.push({
        employee_id: e.id, name: e.name,
        hire_date: e.hire_date,
        eligibility_date: r.eligibility && r.eligibility.waiting_ends,
        accrual_start: r.eligibility && r.eligibility.start,
        hours: r.hours_worked,
        billable: r.hours_billable, nonbillable: r.hours_nonbillable,
        accrued: r.accrued, taken: r.taken,
        adjustments: r.adjustments, balance: r.balance,
        // What this run would change, per person. On a preview it is the whole
        // point; on a real run it is the receipt.
        prior_balance: r.prior_balance == null ? null : Number(r.prior_balance),
        delta: r.delta,
        ledger_rows: r.ledger_rows || 0,
        unsynced_months: r.unsynced_months || 0,
        no_work_months: r.no_work_months || 0,
        not_yet_eligible: r.not_yet_eligible === true,
        error: r.error || null,
      });
    }
    return {
      batch_id: batchId, dry_run: !!dryRun,
      rebuilt_at: nowISO(), as_of: isDate(to) ? to : today(),
      employees: out,
      // Scale of the change, so a run can be sanity-checked at a glance before
      // anybody goes looking at individuals.
      summary: {
        employees: out.length,
        changed: out.filter((e) => e.delta != null && Math.abs(e.delta) >= 0.01).length,
        increased: out.filter((e) => e.delta != null && e.delta > 0).length,
        decreased: out.filter((e) => e.delta != null && e.delta < 0).length,
        not_yet_eligible: out.filter((e) => e.not_yet_eligible).length,
        with_unsynced_months: out.filter((e) => e.unsynced_months > 0).length,
      },
    };
  }

  async function roster({ from, to } = {}) {
    const emps = await dbAll(
      `SELECT id, name, email, role_title,
              COALESCE(NULLIF(hr_hire_date, ''), NULLIF(hire_date, '')) AS hire_date,
              pto_accrual_rate, standard_weekly_hours, pto_annual_cap, pto_enrolled
         FROM hr_employees
        WHERE COALESCE(status,'active') <> 'terminated'
        ORDER BY name`
    ).catch(() => []);
    const staff = [];
    for (const e of emps) staff.push(await balanceFor(e, { from, to }));
    return {
      as_of: isDate(to) ? to : today(),
      default_rate: await companyRate(),
      default_weekly_hours: await companyWeeklyHours(),
      default_annual_cap: await companyAnnualCap(),
      statutory_rate: NV_STATUTORY_RATE,
      statutory_cap: NV_ANNUAL_CAP,
      staff,
    };
  }

  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/pto")) return false;
    if (!user) { json(res, 401, { error: "Please sign in." }); return true; }
    if (!canManage(user)) { json(res, 403, { error: "Not permitted" }); return true; }

    try {
      if (pathname === "/api/pto/roster" && method === "GET") {
        json(res, 200, await roster({ from: query && query.from, to: query && query.to }));
        return true;
      }

      // One person's ledger, in order, with the running balance.
      const ledgerMatch = pathname.match(/^\/api\/pto\/ledger\/(\d+)$/);
      if (ledgerMatch && method === "GET") {
        const id = Number(ledgerMatch[1]);
        const emp = await dbGet(
          `SELECT id, name, email, role_title,
                  COALESCE(NULLIF(hr_hire_date, ''), NULLIF(hire_date, '')) AS hire_date,
                  pto_accrual_rate, standard_weekly_hours, pto_annual_cap, pto_enrolled
             FROM hr_employees WHERE id = ?`, [id]);
        if (!emp) { json(res, 404, { error: "No such employee." }); return true; }
        const rows = await dbAll(
          "SELECT * FROM pto_ledger WHERE employee_id = ? ORDER BY transaction_date, id", [id]).catch(() => []);
        json(res, 200, {
          employee: { id: emp.id, name: emp.name, role_title: emp.role_title, hire_date: emp.hire_date },
          eligibility: accrualStart(emp.hire_date),
          policy: { rate: POLICY_RATE, start: POLICY_START, waiting_days: WAITING_DAYS },
          rows,
          // Absent rather than zero: a ledger that has never been built is not
          // a person with no PTO, and the screen must not read it as one.
          built: rows.length > 0,
          balance: rows.length ? num(rows[rows.length - 1].balance_after) : null,
        });
        return true;
      }

      // THE HISTORICAL RECONCILIATION. Rebuilds from source; never adds to
      // what is there. Restricted to owner/super_admin: it rewrites every
      // balance in the practice.
      if (pathname === "/api/pto/rebuild" && method === "POST") {
        if (!["owner", "super_admin"].includes(user.role)) {
          json(res, 403, { error: "Only executive leadership can rebuild the PTO ledger." }); return true;
        }
        const b = await readBody(req).catch(() => ({}));
        // PREVIEW UNLESS TOLD OTHERWISE. The policy says the recalculation
        // must be shown before any destructive historical update runs, so the
        // destructive path needs saying out loud: apply:true. A caller who
        // forgets gets the proposal, not the execution.
        const dryRun = b.apply !== true;
        const id = Number(b && b.employee_id);
        if (id) {
          const emp = await dbGet(
            `SELECT id, name, email, role_title,
                    COALESCE(NULLIF(hr_hire_date, ''), NULLIF(hire_date, '')) AS hire_date,
                    pto_accrual_rate, standard_weekly_hours, pto_annual_cap, pto_enrolled
               FROM hr_employees WHERE id = ?`, [id]);
          if (!emp) { json(res, 404, { error: "No such employee." }); return true; }
          const one = await rebuildLedger(emp, {
            to: b && b.to, dryRun, batchId: (dryRun ? "preview-" : "batch-") + nowISO(),
            actor: user.email, note: b && b.note });
          json(res, 200, { dry_run: dryRun, rebuilt_at: nowISO(), employees: [one] });
          return true;
        }
        json(res, 200, await rebuildAll({ to: b && b.to, dryRun, actor: user.email, note: b && b.note }));
        return true;
      }

      // PUTTING A RECALCULATION BACK. Reversibility is a requirement, and a
      // balance is computed, so the only way back is the snapshot taken before
      // the run that replaced it.
      if (pathname === "/api/pto/restore" && method === "POST") {
        if (!["owner", "super_admin"].includes(user.role)) {
          json(res, 403, { error: "Only executive leadership can restore a PTO ledger." }); return true;
        }
        const b = await readBody(req);
        const batch = String((b && b.batch_id) || "").trim();
        if (!batch) { json(res, 400, { error: "Which batch? Name the one to put back." }); return true; }
        const snaps = await dbAll("SELECT * FROM pto_ledger_snapshots WHERE batch_id = ?", [batch]).catch(() => []);
        if (!snaps.length) { json(res, 404, { error: "No snapshot with that batch id." }); return true; }
        let restored = 0;
        for (const snap of snaps) {
          let rows = [];
          try { rows = JSON.parse(snap.prior_rows || "[]"); } catch (e) { rows = []; }
          await dbRun("DELETE FROM pto_ledger WHERE employee_id = ?", [snap.employee_id]);
          for (const r of rows) {
            await dbRun(
              `INSERT INTO pto_ledger
                 (employee_id, kind, period_start, period_end, transaction_date,
                  eligible_hours, billable_hours, nonbillable_hours, unclassified_hours,
                  accrual_rate, pto_earned, pto_used, adjustment, forfeited_to_cap,
                  balance_after, source, source_key, reason, rebuilt_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [snap.employee_id, r.kind, r.period_start, r.period_end, r.transaction_date,
               r.eligible_hours, r.billable_hours, r.nonbillable_hours, r.unclassified_hours,
               r.accrual_rate, r.pto_earned, r.pto_used, r.adjustment, r.forfeited_to_cap,
               r.balance_after, r.source, r.source_key || null, r.reason, nowISO()]
            ).catch((e) => console.error("[pto] restore row:", e.message));
          }
          restored++;
        }
        json(res, 200, { ok: true, batch_id: batch, employees_restored: restored });
        return true;
      }

      // Which runs have happened, so one can be named for a restore.
      if (pathname === "/api/pto/batches" && method === "GET") {
        const rows = await dbAll(
          `SELECT batch_id, MIN(taken_at) AS taken_at, MAX(taken_by) AS taken_by,
                  MAX(note) AS note, COUNT(*) AS employees
             FROM pto_ledger_snapshots GROUP BY batch_id ORDER BY MIN(taken_at) DESC LIMIT 50`
        ).catch(() => []);
        json(res, 200, { batches: rows });
        return true;
      }

      if (pathname === "/api/pto/settings" && method === "PUT") {
        const b = await readBody(req);
        if (b && b.rate !== undefined) {
          const r = Number(b.rate);
          if (!Number.isFinite(r) || r < 0) { json(res, 400, { error: "The accrual rate must be a number of hours per hour worked." }); return true; }
          if (setAppSetting) await setAppSetting("pto_accrual_rate", String(r));
        }
        if (b && b.annual_cap !== undefined) {
          const c = Number(b.annual_cap);
          // 0 is meaningful -- it means uncapped -- so it is allowed through.
          if (!Number.isFinite(c) || c < 0 || c > 2080) { json(res, 400, { error: "The annual cap must be a number of hours (0 for no cap)." }); return true; }
          if (setAppSetting) await setAppSetting("pto_annual_cap", String(c));
        }
        if (b && b.weekly_hours !== undefined) {
          const h = Number(b.weekly_hours);
          if (!Number.isFinite(h) || h <= 0 || h > 168) { json(res, 400, { error: "Standard weekly hours must be between 0 and 168." }); return true; }
          if (setAppSetting) await setAppSetting("pto_standard_weekly_hours", String(h));
        }
        json(res, 200, { ok: true, rate: await companyRate(), weekly_hours: await companyWeeklyHours(), annual_cap: await companyAnnualCap() });
        return true;
      }

      const empMatch = pathname.match(/^\/api\/pto\/employee\/(\d+)$/);
      if (empMatch && method === "PUT") {
        const b = await readBody(req);
        const id = empMatch[1];
        if (b && b.pto_enrolled !== undefined) {
          await dbRun("UPDATE hr_employees SET pto_enrolled = ? WHERE id = ?", [b.pto_enrolled === true, id]);
        }
        for (const [field, col, max] of [["rate", "pto_accrual_rate", 1], ["weekly_hours", "standard_weekly_hours", 168], ["annual_cap", "pto_annual_cap", 2080]]) {
          if (b && b[field] !== undefined) {
            const raw = b[field];
            if (raw === null || String(raw).trim() === "") {
              await dbRun(`UPDATE hr_employees SET ${col} = NULL WHERE id = ?`, [id]);
            } else {
              const v = Number(raw);
              if (!Number.isFinite(v) || v < 0 || v > max) { json(res, 400, { error: `That ${field.replace("_", " ")} is not a usable number.` }); return true; }
              await dbRun(`UPDATE hr_employees SET ${col} = ? WHERE id = ?`, [v, id]);
            }
          }
        }
        json(res, 200, { ok: true });
        return true;
      }

      // An opening balance, a correction, a payout.
      if (pathname === "/api/pto/adjustment" && method === "POST") {
        const b = await readBody(req);
        const empId = Number(b && b.employee_id);
        const hours = Number(b && b.hours);
        if (!empId || !Number.isFinite(hours) || hours === 0) {
          json(res, 400, { error: "An adjustment needs an employee and a non-zero number of hours." });
          return true;
        }
        const reason = String((b && b.reason) || "").trim().slice(0, 300);
        if (!reason) { json(res, 400, { error: "Please say why — an unexplained adjustment to somebody's leave balance is not auditable." }); return true; }
        await dbRun(
          `INSERT INTO pto_adjustments (employee_id, hours, reason, effective_date, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [empId, hours, reason, isDate(b && b.effective_date) ? b.effective_date : today(), user.email || "staff", nowISO()]
        );
        json(res, 200, { ok: true });
        return true;
      }

      json(res, 404, { error: "Unknown PTO route" });
      return true;
    } catch (e) {
      console.error("[pto] route failed:", e.message);
      json(res, 500, { error: e.message });
      return true;
    }
  }

  return { initTables, handleApi, roster, balanceFor, hoursTaken, benefitYears,
           eligibleHours, accrualStart, rebuildLedger, rebuildAll, monthsBetween,
           NV_STATUTORY_RATE, NV_ANNUAL_CAP, POLICY_RATE, POLICY_START, WAITING_DAYS };
};
module.exports.NV_STATUTORY_RATE = NV_STATUTORY_RATE;
module.exports.NV_ANNUAL_CAP = NV_ANNUAL_CAP;
module.exports.POLICY_RATE = POLICY_RATE;
module.exports.POLICY_START = POLICY_START;
module.exports.WAITING_DAYS = WAITING_DAYS;
