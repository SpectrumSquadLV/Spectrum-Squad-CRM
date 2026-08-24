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

// Nevada's statutory minimum, and the default. 0.01923 h per hour worked is
// 40 hours over a 2,080-hour year.
const NV_STATUTORY_RATE = 0.01923;

module.exports = function initPto(ctx) {
  const { dbGet, dbAll, dbRun, nowISO, readBody, json, getAppSetting, setAppSetting } = ctx;

  const today = () => new Date().toISOString().slice(0, 10);
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const round2 = (n) => Math.round(num(n) * 100) / 100;
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
  const canManage = (u) => !!u && ["owner", "super_admin", "admin", "hr_admin"].includes(u.role);

  async function initTables() {
    await dbRun("ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS pto_accrual_rate NUMERIC").catch(() => {});
    await dbRun("ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS standard_weekly_hours NUMERIC").catch(() => {});
    await dbRun("ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS pto_enrolled BOOLEAN NOT NULL DEFAULT false").catch(() => {});

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
  }

  async function companyRate() {
    const raw = getAppSetting ? await getAppSetting("pto_accrual_rate", "") : "";
    const r = Number(raw);
    return Number.isFinite(r) && r > 0 ? r : NV_STATUTORY_RATE;
  }
  async function companyWeeklyHours() {
    const raw = getAppSetting ? await getAppSetting("pto_standard_weekly_hours", "") : "";
    const h = Number(raw);
    return Number.isFinite(h) && h > 0 ? h : 40;
  }

  const daysBetween = (a, b) =>
    Math.max(0, Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000) + 1);

  // Hours worked in a window, and where the figure came from.
  //
  // Timecards win where they exist, because they are measured. Where a person
  // has none -- the salaried case -- their standard weekly hours are spread
  // across the window instead, and the basis says so.
  async function hoursWorked(empId, from, to, weeklyHours) {
    const cards = await dbAll(
      `SELECT raw_json FROM hr_timecards
        WHERE employee_id = ? AND COALESCE(status,'') IN ('verified','approved')
          AND pay_period_start >= ? AND pay_period_end <= ?`,
      [empId, from, to]
    ).catch(() => []);

    let measured = 0;
    let cardCount = 0;
    for (const c of cards) {
      let entries = [];
      try {
        const parsed = JSON.parse(c.raw_json || "{}");
        entries = Array.isArray(parsed) ? parsed : (parsed.entries || []);
      } catch (e) { entries = []; }
      const sum = entries.reduce((s, e) => s + num(e && e.hours), 0);
      if (sum > 0) { measured += sum; cardCount++; }
    }

    if (cardCount > 0) {
      return { hours: round2(measured), basis: "timecards", detail: `${cardCount} approved timecard${cardCount === 1 ? "" : "s"}` };
    }

    const weeks = daysBetween(from, to) / 7;
    return {
      hours: round2(weeks * num(weeklyHours)),
      basis: "standard",
      detail: `${weeklyHours} h/week assumed — no approved timecards in this period`,
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
    const start = isDate(from) ? from : (isDate(hire) ? hire : null);
    const end = isDate(to) ? to : today();

    if (!start) {
      return {
        employee_id: emp.id, name: emp.name, enrolled: emp.pto_enrolled === true,
        rate, weekly_hours: weekly,
        error: "No hire date on file, so accrual has no start date.",
        accrued: null, taken: null, adjustments: null, balance: null,
      };
    }
    if (end < start) {
      return {
        employee_id: emp.id, name: emp.name, enrolled: emp.pto_enrolled === true,
        rate, weekly_hours: weekly,
        error: "The period ends before this person was hired.",
        accrued: null, taken: null, adjustments: null, balance: null,
      };
    }

    const worked = await hoursWorked(emp.id, start, end, weekly);
    const taken = await hoursTaken(emp.id, start, end, weekly);
    const adjRows = await dbAll(
      "SELECT hours, reason, effective_date FROM pto_adjustments WHERE employee_id = ?", [emp.id]
    ).catch(() => []);
    const adjustments = round2(adjRows.reduce((s, a) => s + num(a.hours), 0));

    const accrued = round2(worked.hours * rate);
    return {
      employee_id: emp.id,
      name: emp.name,
      role_title: emp.role_title || "",
      enrolled: emp.pto_enrolled === true,
      period: { from: start, to: end },
      rate,
      weekly_hours: weekly,
      hours_worked: worked.hours,
      hours_basis: worked.basis,          // "timecards" | "standard"
      hours_basis_detail: worked.detail,
      accrued,
      taken: taken.hours,
      taken_assumed_days: taken.assumed_days,
      taken_entries: taken.entries,
      adjustments,
      adjustment_notes: adjRows,
      balance: round2(accrued - taken.hours + adjustments),
      // An estimate is not a measurement, and a balance built on assumed hours
      // should not be quoted at somebody as though it were counted.
      estimated: worked.basis === "standard" || taken.assumed_days > 0,
      error: null,
    };
  }

  async function roster({ from, to } = {}) {
    const emps = await dbAll(
      `SELECT id, name, email, role_title,
              COALESCE(NULLIF(hr_hire_date, ''), NULLIF(hire_date, '')) AS hire_date,
              pto_accrual_rate, standard_weekly_hours, pto_enrolled
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
      statutory_rate: NV_STATUTORY_RATE,
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

      if (pathname === "/api/pto/settings" && method === "PUT") {
        const b = await readBody(req);
        if (b && b.rate !== undefined) {
          const r = Number(b.rate);
          if (!Number.isFinite(r) || r < 0) { json(res, 400, { error: "The accrual rate must be a number of hours per hour worked." }); return true; }
          if (setAppSetting) await setAppSetting("pto_accrual_rate", String(r));
        }
        if (b && b.weekly_hours !== undefined) {
          const h = Number(b.weekly_hours);
          if (!Number.isFinite(h) || h <= 0 || h > 168) { json(res, 400, { error: "Standard weekly hours must be between 0 and 168." }); return true; }
          if (setAppSetting) await setAppSetting("pto_standard_weekly_hours", String(h));
        }
        json(res, 200, { ok: true, rate: await companyRate(), weekly_hours: await companyWeeklyHours() });
        return true;
      }

      const empMatch = pathname.match(/^\/api\/pto\/employee\/(\d+)$/);
      if (empMatch && method === "PUT") {
        const b = await readBody(req);
        const id = empMatch[1];
        if (b && b.pto_enrolled !== undefined) {
          await dbRun("UPDATE hr_employees SET pto_enrolled = ? WHERE id = ?", [b.pto_enrolled === true, id]);
        }
        for (const [field, col, max] of [["rate", "pto_accrual_rate", 1], ["weekly_hours", "standard_weekly_hours", 168]]) {
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

  return { initTables, handleApi, roster, balanceFor, hoursWorked, hoursTaken, NV_STATUTORY_RATE };
};
module.exports.NV_STATUTORY_RATE = NV_STATUTORY_RATE;
