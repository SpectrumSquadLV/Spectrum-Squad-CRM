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
  // Billable hours per week, from Rethink's own billable/non-billable
  // classification. A DIFFERENT source from the supervision denominator on
  // purpose: an hour can be genuinely delivered, count towards supervision and
  // payroll, and still not be billable. Merging the two rules would move a
  // compliance percentage every time the billable definition changed.
  const billableWeeksForMonth = ctx.rethinkBillableWeeksForMonth || (async () => []);

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
    // The requirement is WEEKLY now. The monthly column is kept rather than
    // dropped -- it is what every previously sent notice was measured against,
    // and deleting it would rewrite the past. Nothing reads it for a new
    // figure, and no weekly value is derived from it: monthly / 4.33 is a
    // guess, and a guessed requirement is one somebody gets judged against.
    await dbRun("ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS weekly_billable_target NUMERIC")
      .catch((e) => console.error("weekly_billable_target column:", e.message));
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

    const emps = await dbAll(
      `SELECT id, name, email, role_title, weekly_billable_target, monthly_billable_target
         FROM hr_employees
        WHERE COALESCE(status, 'active') <> 'terminated'
        ORDER BY name`
    ).catch(() => []);

    // Provisional still comes from the month row: it is a statement about
    // whether the Rethink FILTER has been confirmed, which applies to every
    // figure derived from that sync, billable or not.
    const hours = await dbAll(
      "SELECT employee_id, provisional FROM rethink_provider_month WHERE month = ? AND employee_id IS NOT NULL",
      [period]
    ).catch(() => []);
    const byEmp = new Map();
    for (const h of hours) {
      const cur = byEmp.get(h.employee_id) || { provisional: false };
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

    const rows = [];
    for (const e of emps) {
      const target = e.weekly_billable_target == null || e.weekly_billable_target === ""
        ? null : num(e.weekly_billable_target);
      const h = byEmp.get(e.id) || null;

      // Every week that OVERLAPS the month. A partial first or last week
      // expects the FULL weekly figure -- it is not pro-rated.
      const weeksRaw = target == null ? [] : await billableWeeksForMonth(e.id, period).catch(() => []);
      const weeks = weeksRaw.map((w) => ({
        week_start: w.week_start,
        week_end: w.week_end,
        billable_hours: w.billable == null ? null : round1(w.billable),
        nonbillable_hours: w.nonbillable == null ? null : round1(w.nonbillable),
        unclassified_hours: w.unclassified == null ? null : round1(w.unclassified),
        appointments: w.billable_appointments || 0,
        // A week with nothing synced is not a week of zero hours, and is never
        // scored as a miss.
        met: w.billable == null ? null : round1(w.billable) >= target,
      }));
      const scored = weeks.filter((w) => w.met !== null);
      const weeksMet = scored.filter((w) => w.met === true).length;
      const actual = scored.length ? round1(scored.reduce((a, w) => a + w.billable_hours, 0)) : null;
      const unclassified = scored.reduce((a, w) => a + (w.unclassified_hours || 0), 0);

      let trustworthy = true;
      let note = null;
      if (!syncOk) { trustworthy = false; note = `The Rethink sync for ${monthLabel(period)} has not completed successfully, so hours for this month are not final.`; }
      else if (!h) { trustworthy = false; note = "No Rethink appointments were matched to this person for this month."; }
      else if (h.provisional) { trustworthy = false; note = "These hours are still provisional — the Rethink verification filter has not been confirmed."; }
      else if (target != null && !scored.length) { trustworthy = false; note = "No billable session hours were synced for this person in this month."; }

      rows.push({
        employee_id: e.id,
        name: e.name,
        email: e.email || null,
        role_title: e.role_title || "",
        weekly_target_hours: target,
        weeks,
        weeks_scored: scored.length,
        weeks_met: weeksMet,
        actual_hours: actual,
        // Hours Rethink did not label either way. Reported rather than folded
        // in: an unlabelled hour counted as billable would inflate the figure
        // somebody is judged on.
        unclassified_hours: round1(unclassified),
        met: scored.length ? weeksMet === scored.length : null,
        trustworthy,
        note,
        has_requirement: target != null,
        // Carried so a staff record still showing only the retired monthly
        // figure can be spotted, rather than silently reading as "no
        // requirement set".
        legacy_monthly_target: e.monthly_billable_target == null ? null : num(e.monthly_billable_target),
      });
    }

    return { period, period_label: monthLabel(period), sync_ok: syncOk, staff: rows };
  }

  function dayLabel(iso) {
    const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return String(iso || "");
    const names = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return (names[+m[2]] || m[2]) + " " + (+m[3]);
  }

  function emailHtml(row, period) {
    const label = monthLabel(period);
    const target = row.weekly_target_hours;
    const allMet = row.met === true;

    const weekRows = (row.weeks || []).map((w) => {
      if (w.met === null) {
        return `<tr><td style="padding:5px 14px 5px 0;color:#5b6472;">${esc(dayLabel(w.week_start))} – ${esc(dayLabel(w.week_end))}</td>
          <td style="padding:5px 14px 5px 0;color:#6b7280;">no hours synced</td>
          <td style="padding:5px 0;color:#6b7280;">—</td></tr>`;
      }
      const diff = Math.round((w.billable_hours - target) * 10) / 10;
      return `<tr><td style="padding:5px 14px 5px 0;color:#5b6472;">${esc(dayLabel(w.week_start))} – ${esc(dayLabel(w.week_end))}</td>
        <td style="padding:5px 14px 5px 0;font-weight:700;">${w.billable_hours} hrs</td>
        <td style="padding:5px 0;font-weight:700;color:${w.met ? "#166534" : "#b45309"};">
          ${w.met ? `+${Math.abs(diff)} over` : `${Math.abs(diff)} under`}</td></tr>`;
    }).join("");

    return `
      <p>Hi ${esc((row.name || "").split(/\s+/)[0] || "there")},</p>
      <p>Here is your billable summary for <strong>${esc(label)}</strong>.</p>
      <p style="font-size:15px;">Your requirement is <strong>${target} billable hours a week</strong>.
      You met it in <strong>${row.weeks_met} of ${row.weeks_scored}</strong> week${row.weeks_scored === 1 ? "" : "s"}.</p>
      <table style="border-collapse:collapse;font-size:14.5px;margin:14px 0;">
        <tr><th align="left" style="padding:0 14px 6px 0;font-size:12px;color:#6b7280;text-transform:uppercase;">Week</th>
            <th align="left" style="padding:0 14px 6px 0;font-size:12px;color:#6b7280;text-transform:uppercase;">Billable</th>
            <th align="left" style="padding:0 0 6px;font-size:12px;color:#6b7280;text-transform:uppercase;">vs ${target} hrs</th></tr>
        ${weekRows}
      </table>
      <p>${allMet
        ? "Thank you — you met your weekly requirement every week this month."
        : "Some weeks were under the requirement. If that does not look right, or something affected your availability, please reply and let us know."}</p>
      <p style="font-size:12.5px;color:#6b7280;margin-top:18px;">
        Each week runs Monday to Sunday and expects the full ${target} hours — a week is not reduced because the month started or ended partway through it.
        Only appointments Rethink classifies as <strong>billable</strong> count towards this${row.unclassified_hours ? `; ${row.unclassified_hours} hour(s) this month were not labelled either way and were left out rather than assumed billable` : ""}.
        This is not a payroll figure and it is not the same as your supervision hours — a session can be delivered and verified, count towards supervision, and not be billable.
        If you think a session is missing, tell us and we will check it.
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
          // The weekly figure, because that is what this month was measured
          // against. Rows written before the requirement became weekly keep
          // the monthly number they were measured against -- rewriting them
          // would misreport what somebody was actually told at the time.
          [row.employee_id, period, row.weekly_target_hours, row.actual_hours, row.email, nowISO()]
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
        // Writes the WEEKLY requirement. The monthly column is left exactly as
        // it is: it is what earlier notices were measured against, and no
        // weekly value is derived from it -- monthly / 4.33 is a guess, and a
        // guessed requirement is one somebody gets judged against.
        await dbRun("UPDATE hr_employees SET weekly_billable_target = ? WHERE id = ?", [target, targetMatch[1]]);
        json(res, 200, { ok: true, weekly_target_hours: target });
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
