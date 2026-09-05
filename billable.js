// billable.js -- monthly billable-hour requirements for clinical staff.
//
// Each BCBA carries a different monthly requirement, so this is a number per
// person rather than a company-wide setting. Once a month each of them gets an
// email saying what their requirement is and what they actually delivered.
//
// Where the actual comes from, and what it honestly is:
//
//   rethink_provider_month.verified_hours -- the sum of actualDurationHours for
//   appointments that passed the Rethink verification filter. That is DELIVERED
//   AND VERIFIED SESSION HOURS. It is not what a payer has paid, and it is not
//   a scheduled figure: a session with no recorded actual duration is left out
//   rather than back-filled from its scheduled length, which would inflate it.
//
// That distinction is carried into the email wording. Telling a clinician "you
// billed 82 hours" when the number is verified session hours would be a
// different claim, and it is their pay and their standing being discussed.
//
// Two things this deliberately will not do:
//
//   * It will not email a figure it cannot stand behind. If the month's hours
//     are still provisional -- the Rethink filter not yet confirmed -- or the
//     sync for that month never succeeded, no email goes out and the roster
//     says why. A wrong number in a performance email is worse than a late one.
//   * It will not invent a requirement. Someone with no target set is not
//     emailed at all; they appear on the roster as "no requirement set".
"use strict";

module.exports = function initBillable(ctx) {
  const { dbGet, dbAll, dbRun, sendEmail, nowISO, readBody, json } = ctx;

  const today = () => new Date().toISOString().slice(0, 10);
  const thisMonth = () => today().slice(0, 7);
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const round1 = (n) => Math.round(num(n) * 10) / 10;
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // The month before this one, as YYYY-MM. The email reports a FINISHED month:
  // a requirement judged on a half-finished month tells everyone they are
  // behind, every time.
  function previousMonth(fromMonth) {
    const [y, m] = String(fromMonth || thisMonth()).split("-").map(Number);
    const d = new Date(Date.UTC(y, (m || 1) - 1, 1));
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
  }

  function monthLabel(month) {
    const [y, m] = String(month || "").split("-").map(Number);
    if (!y || !m) return String(month || "");
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  }

  const canManage = (u) => !!u && ["owner", "super_admin", "admin", "hr_admin"].includes(u.role);

  async function initTables() {
    // The requirement lives on the employee, because it is a property of the
    // person's role and contract rather than of any one month.
    await dbRun("ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS monthly_billable_target NUMERIC")
      .catch((e) => console.error("[billable] target column:", e.message));

    // One row per person per month once their email has gone out, so a re-run
    // -- a retry, a redeploy, a second scheduled tick -- cannot send twice.
    await dbRun(`CREATE TABLE IF NOT EXISTS billable_notices (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      period TEXT NOT NULL,
      target_hours NUMERIC,
      actual_hours NUMERIC,
      sent_to TEXT,
      sent_at TEXT,
      UNIQUE (employee_id, period)
    )`).catch((e) => console.error("[billable] billable_notices initTables:", e.message));
  }

  // What everyone's month looked like. One row per employee who has a
  // requirement, plus the reason where a figure cannot be trusted.
  async function monthlySummary(month) {
    const period = /^\d{4}-\d{2}$/.test(month || "") ? month : previousMonth();

    // ONLY THE PEOPLE WHO HAVE A REQUIREMENT, which is what the line above has
    // always claimed and the query did not do: it took every employee on the
    // roster, so RBTs, schedulers and office staff appeared on a billable
    // report with nothing to be measured against. Reported as "the billable
    // requirement is only for BCBAs, everyone else doesn't have one".
    //
    // THE TEST IS THE TARGET ITSELF, not the job title. A person with a monthly
    // billable target has a requirement; a person without one does not, whatever
    // their title says. Reading it off role_title would be guessing at free text
    // -- and would put a "BCaBA" or a "Clinical Supervisor" on or off the report
    // depending on how somebody typed their job.
    const emps = await dbAll(
      `SELECT id, name, email, role_title, monthly_billable_target
         FROM hr_employees
        WHERE COALESCE(status, 'active') <> 'terminated'
          AND monthly_billable_target IS NOT NULL
          AND monthly_billable_target > 0
        ORDER BY name`
    ).catch(() => []);

    const hours = await dbAll(
      "SELECT employee_id, verified_hours, appointment_count, provisional FROM rethink_provider_month WHERE month = ? AND employee_id IS NOT NULL",
      [period]
    ).catch(() => []);
    const byEmp = new Map();
    for (const h of hours) {
      // A person can hold more than one Rethink staff id; their month is the
      // sum, not whichever row happened to be read last.
      const cur = byEmp.get(h.employee_id) || { hours: 0, appointments: 0, provisional: false };
      cur.hours += num(h.verified_hours);
      cur.appointments += num(h.appointment_count);
      if (h.provisional === true || h.provisional === "t") cur.provisional = true;
      byEmp.set(h.employee_id, cur);
    }

    // Did the sync for this month actually succeed? Without this, a month that
    // never synced is indistinguishable from a month where nobody worked.
    const lastSync = await dbGet(
      `SELECT status, finished_at FROM rethink_sync_log
        WHERE kind = 'supervision_hours' AND month = ?
        ORDER BY id DESC LIMIT 1`, [period]
    ).catch(() => null);
    const syncOk = !!(lastSync && lastSync.status === "success");

    const rows = emps.map((e) => {
      const target = e.monthly_billable_target == null ? null : num(e.monthly_billable_target);
      const h = byEmp.get(e.id) || null;
      const actual = h ? round1(h.hours) : null;

      let trustworthy = true;
      let note = null;
      if (!syncOk) { trustworthy = false; note = `The Rethink sync for ${monthLabel(period)} has not completed successfully, so hours for this month are not final.`; }
      else if (!h) { trustworthy = false; note = "No Rethink appointments were matched to this person for this month."; }
      else if (h.provisional) { trustworthy = false; note = "These hours are still provisional — the Rethink verification filter has not been confirmed."; }

      // Taken from the ROUNDED actual, not the raw one, so the three numbers
      // in the email add up. 71.25 delivered against 100 shows as "71.3
      // delivered, 28.7 under" -- a variance of 28.75 beside 71.3 would look
      // like an arithmetic error to the person reading it about themselves.
      const variance = (target != null && actual != null) ? round1(actual - target) : null;
      return {
        employee_id: e.id,
        name: e.name,
        email: e.email || null,
        role_title: e.role_title || "",
        target_hours: target,
        actual_hours: actual,
        appointments: h ? h.appointments : null,
        variance,
        met: (target != null && actual != null) ? actual >= target : null,
        trustworthy,
        note,
        has_requirement: target != null,
      };
    });

    return { period, period_label: monthLabel(period), sync_ok: syncOk, staff: rows };
  }

  function emailHtml(row, period) {
    const label = monthLabel(period);
    const met = row.met === true;
    const shortBy = row.variance == null ? null : Math.abs(row.variance);
    return `
      <p>Hi ${esc((row.name || "").split(/\s+/)[0] || "there")},</p>
      <p>Here is your billable summary for <strong>${esc(label)}</strong>.</p>
      <table style="border-collapse:collapse;font-size:15px;margin:14px 0;">
        <tr><td style="padding:6px 14px 6px 0;color:#5b6472;">Your monthly requirement</td>
            <td style="padding:6px 0;font-weight:700;">${row.target_hours} hours</td></tr>
        <tr><td style="padding:6px 14px 6px 0;color:#5b6472;">Verified session hours delivered</td>
            <td style="padding:6px 0;font-weight:700;">${row.actual_hours} hours</td></tr>
        <tr><td style="padding:6px 14px 6px 0;color:#5b6472;">Difference</td>
            <td style="padding:6px 0;font-weight:700;color:${met ? "#166534" : "#b45309"};">
              ${met ? `+${shortBy} hours over` : `${shortBy} hours under`}</td></tr>
      </table>
      <p>${met
        ? "Thank you — you met your requirement for the month."
        : "You were under your requirement for the month. If that does not look right, or something affected your availability, please reply and let us know."}</p>
      <p style="font-size:12.5px;color:#6b7280;margin-top:18px;">
        "Verified session hours" are appointments recorded as delivered and verified in Rethink${row.appointments != null ? ` (${row.appointments} appointment${row.appointments === 1 ? "" : "s"} this month)` : ""}.
        They are not a payroll or claims figure. If you think a session is missing, tell us and we will check it.
      </p>`;
  }

  // Send each person with a requirement their month. Returns what it did and,
  // just as importantly, what it declined to do and why.
  async function runMonthlyBillable({ month, force = false, actor = "schedule" } = {}) {
    const period = /^\d{4}-\d{2}$/.test(month || "") ? month : previousMonth();
    const summary = await monthlySummary(period);

    const result = { period, period_label: summary.period_label, sent: 0, skipped: [], errors: [] };

    for (const row of summary.staff) {
      if (!row.has_requirement) { result.skipped.push({ name: row.name, why: "no requirement set" }); continue; }
      if (!row.email) { result.skipped.push({ name: row.name, why: "no email address on file" }); continue; }
      if (!row.trustworthy) { result.skipped.push({ name: row.name, why: row.note }); continue; }

      const already = await dbGet(
        "SELECT id FROM billable_notices WHERE employee_id = ? AND period = ?", [row.employee_id, period]
      ).catch(() => null);
      if (already && !force) { result.skipped.push({ name: row.name, why: "already sent for this month" }); continue; }

      try {
        await sendEmail({
          to: row.email,
          subject: `Your billable summary for ${summary.period_label}`,
          html: emailHtml(row, period),
          type: "billable_monthly",
        });
        await dbRun(
          `INSERT INTO billable_notices (employee_id, period, target_hours, actual_hours, sent_to, sent_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (employee_id, period) DO UPDATE
             SET target_hours = EXCLUDED.target_hours, actual_hours = EXCLUDED.actual_hours,
                 sent_to = EXCLUDED.sent_to, sent_at = EXCLUDED.sent_at`,
          [row.employee_id, period, row.target_hours, row.actual_hours, row.email, nowISO()]
        );
        result.sent++;
      } catch (e) {
        result.errors.push({ name: row.name, error: e.message });
      }
    }

    console.log(`[billable] ${period} run by ${actor}: sent=${result.sent} skipped=${result.skipped.length} errors=${result.errors.length}`);
    return result;
  }

  // Monthly, shortly after a month ends. Checked hourly rather than with a
  // month-long timer: a redeploy resets an interval, and a restart on the 2nd
  // would otherwise skip the month entirely. The notices table is what actually
  // prevents a second send, not the timing.
  async function tick() {
    const day = Number(today().slice(8, 10));
    if (day > 5) return { skipped: "not the start of the month" };
    return runMonthlyBillable({ actor: "schedule" });
  }

  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/billable")) return false;
    if (!user) { json(res, 401, { error: "Please sign in." }); return true; }
    if (!canManage(user)) { json(res, 403, { error: "Not permitted" }); return true; }

    try {
      if (pathname === "/api/billable/summary" && method === "GET") {
        json(res, 200, await monthlySummary(query && query.month));
        return true;
      }

      // Set or clear one person's requirement.
      const targetMatch = pathname.match(/^\/api\/billable\/target\/(\d+)$/);
      if (targetMatch && method === "PUT") {
        const b = await readBody(req);
        const raw = b && b.target_hours;
        let target = null;
        if (raw !== null && raw !== undefined && String(raw).trim() !== "") {
          target = Number(raw);
          if (!Number.isFinite(target) || target < 0) {
            json(res, 400, { error: "The requirement must be a number of hours, or blank to remove it." });
            return true;
          }
        }
        await dbRun("UPDATE hr_employees SET monthly_billable_target = ? WHERE id = ?", [target, targetMatch[1]]);
        json(res, 200, { ok: true, target_hours: target });
        return true;
      }

      if (pathname === "/api/billable/run" && method === "POST") {
        const b = await readBody(req).catch(() => ({}));
        json(res, 200, await runMonthlyBillable({
          month: b && b.month,
          force: !!(b && b.force),
          actor: user.email || "staff",
        }));
        return true;
      }

      if (pathname === "/api/billable/notices" && method === "GET") {
        json(res, 200, {
          notices: await dbAll("SELECT * FROM billable_notices ORDER BY id DESC LIMIT 60").catch(() => []),
        });
        return true;
      }

      json(res, 404, { error: "Unknown billable route" });
      return true;
    } catch (e) {
      console.error("[billable] route failed:", e.message);
      json(res, 500, { error: e.message });
      return true;
    }
  }

  return { initTables, handleApi, monthlySummary, runMonthlyBillable, tick, previousMonth, monthLabel };
};
