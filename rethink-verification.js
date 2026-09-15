// ===== UNVERIFIED APPOINTMENT INFRACTIONS =====================================
//
// A weekly, automatic pull from Rethink that answers one question per person:
// "which sessions you already delivered are still not staff-verified?"
//
// Two runs, because the two roles are held to the same rule at different hours:
//
//   RBTs   -- Friday 06:00 America/Los_Angeles
//   BCBAs  -- Friday 19:30 America/Los_Angeles
//
// Each run scans appointments dated STRICTLY BEFORE the Friday it runs on, so
// the deadline is unambiguous: everything up to and including Thursday should
// have been verified by the time the run fires. A session delivered on the
// Friday itself is never an infraction on that same Friday -- it is caught the
// following week if it is still sitting there. That rule is the same for both
// cohorts deliberately: an RBT and a BCBA who each leave Thursday's session
// unverified have committed the same infraction, and a quarterly review that
// applied two different cutoffs would not survive being questioned.
//
// WHAT AN INFRACTION IS. One unverified appointment = one infraction, recorded
// once, against the person, on the day the deadline was missed. It is never
// deleted and never re-counted: a session flagged this Friday and still
// unverified next Friday is the SAME infraction seen twice (times_flagged goes
// up, the infraction count does not). When it is finally verified, the row is
// marked resolved -- the infraction stands, because it was late, but the record
// shows they caught up and when.
//
// WHY PER-APPOINTMENT. A quarterly review can roll per-session rows up into
// "weeks flagged" or "people flagged"; it cannot go the other way. The atomic
// fact is stored, the summaries are derived.
//
// NO SCREEN. This module deliberately adds nothing to the CRM UI -- no nav
// entry, no page, no widget. It pulls, it records, it emails a summary. The
// quarterly numbers come out through quarterSummary() / employeeHistory(), and
// through read-only JSON under /api/rethink-verification/* for anyone who
// wants to pull them without waiting for a screen to be built.
//
// PHI. Appointment rows carry PHI. Nothing here logs, stores or emails a client
// name, client id or session note. What is kept is the staff member, the date,
// the appointment's own status/verification values and its duration -- the
// facts needed to say "this session of yours is unverified" and nothing more.

"use strict";

const client = require("./rethink-client");

module.exports = function initRethinkVerification(ctx) {
  const {
    dbGet, dbAll, dbRun, nowISO, json,
    sendEmail = async () => ({ delivered: "skipped" }),
    getAppSetting = async (_k, fallback = null) => fallback,
  } = ctx;

  // Who is an RBT is NOT decided here. It is asked of the Fidelity module,
  // which already owns that rule -- the same "active RBT" test the fidelity
  // dashboard and the supervision tracker both read off the job title. A second
  // copy of it would eventually disagree with the first, and then one screen
  // would call somebody an RBT while their infractions were filed under BCBA.
  // Required, not defaulted: see cohortOf().
  const isRbt = ctx.isRbt || null;

  // What "verified" means is likewise not re-decided here: it is the filter an
  // admin confirmed on the Rethink panel, read through the module that owns it.
  // If the wiring is missing we refuse to run rather than guess -- calling a
  // verified session an infraction is the one failure this module must not have.
  const getRethinkConfig = ctx.getRethinkConfig || null;
  const verificationVerdict = ctx.verificationVerdict || null;

  const DWH_APPOINTMENTS = "Appointments";

  // How far back each run looks. Ninety days by default: long enough that a
  // session left unverified for two months is still being counted every week
  // (and still shows on the report as an open item), short enough that the pull
  // stays cheap. An infraction is only ever RECORDED once, so a wide window
  // cannot inflate anybody's count -- it only keeps old ones visible.
  const LOOKBACK_DAYS = Math.max(1, Number(process.env.RETHINK_VERIFICATION_LOOKBACK_DAYS) || 90);

  // The schedule. Overridable by environment so the hour can move without a
  // code change, but the defaults are the policy as written.
  const WEEKDAY = (process.env.RETHINK_VERIFICATION_WEEKDAY || "Fri").slice(0, 3);
  const SCHEDULES = [
    { cohort: "rbt", label: "RBT", at: process.env.RETHINK_VERIFICATION_RBT_AT || "06:00" },
    { cohort: "bcba", label: "BCBA", at: process.env.RETHINK_VERIFICATION_BCBA_AT || "19:30" },
  ];

  // A run that should have fired at 06:00 and did not -- the server was
  // restarting, the box was down for the morning -- fires whenever the process
  // comes back, as long as it is still the same Friday.
  //
  // There is deliberately no "too late to bother" cutoff inside the day. The
  // window this report asks about is "sessions dated before today", and that is
  // exactly as true at 20:00 as it was at 06:00 -- nothing about it goes stale
  // during the day. Skipping the run would instead drop a whole week of
  // infractions off everybody's quarterly record because a box was rebooting,
  // and a late email is a far smaller problem than a missing week. The run row
  // records the hour it actually fired, so a late one is visible as late.

  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const round2 = (n) => Math.round(n * 100) / 100;
  const nowMs = () => { const t = Date.parse(nowISO()); return Number.isFinite(t) ? t : Date.now(); };
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  // ======================= TIME ==============================
  // Everything about this module is expressed in Las Vegas wall-clock time,
  // because "Friday at 6am" means 6am to the people it is about. Derived from
  // Intl rather than a fixed offset so the switch in and out of daylight saving
  // needs no attention: 06:00 Pacific stays 06:00 Pacific in March.
  const TZ = process.env.RETHINK_VERIFICATION_TZ || "America/Los_Angeles";

  function pacificParts(ms) {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, weekday: "short",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const p = {};
    for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
    let hour = Number(p.hour);
    if (!Number.isFinite(hour) || hour === 24) hour = 0;   // hour-cycle quirk guard
    return {
      date: `${p.year}-${p.month}-${p.day}`,
      weekday: String(p.weekday || "").slice(0, 3),
      minutes: hour * 60 + Number(p.minute || 0),
    };
  }

  // Plain calendar arithmetic on a YYYY-MM-DD string. Done in UTC on purpose:
  // the string already IS the Pacific date, so re-introducing a zone here would
  // be the bug, not the fix.
  function addDays(dateStr, delta) {
    const [y, m, d] = String(dateStr).split("-").map(Number);
    const t = Date.UTC(y, m - 1, d) + delta * 86400000;
    return new Date(t).toISOString().slice(0, 10);
  }

  function hhmmToMinutes(at) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(at || "").trim());
    if (!m) return null;
    const h = Number(m[1]), min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  // The quarter an infraction belongs to. Keyed on the day the DEADLINE WAS
  // MISSED, not the day the session happened: a 30 September session that was
  // still unverified on the 3 October run is an October failure to verify, and
  // filing it in Q3 would credit the wrong review period. The appointment date
  // is stored alongside it, so a review that wants to cut it the other way can.
  function quarterOf(dateStr) {
    const [y, m] = String(dateStr).split("-").map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(m)) return null;
    return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
  }

  function quarterWindow(quarter) {
    const m = /^(\d{4})-Q([1-4])$/.exec(String(quarter || "").trim());
    if (!m) return null;
    const y = Number(m[1]), q = Number(m[2]);
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    const lastDay = new Date(Date.UTC(y, endMonth, 0)).getUTCDate();
    return {
      quarter: `${y}-Q${q}`,
      from: `${y}-${String(startMonth).padStart(2, "0")}-01`,
      to: `${y}-${String(endMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
    };
  }

  // ======================= SCHEMA ============================
  async function initTables() {
    // One row per fired run. The UNIQUE run_key is the whole restart-safety
    // story: two processes, or one process redeployed at 06:00 on a Friday,
    // cannot both send the RBT email.
    await dbRun(`CREATE TABLE IF NOT EXISTS rethink_verification_runs (
      id SERIAL PRIMARY KEY,
      run_key TEXT UNIQUE,                 -- 'rbt|2026-09-18'; released on failure so it retries
      cohort TEXT NOT NULL,                -- rbt|bcba
      run_date TEXT NOT NULL,              -- the Pacific date the run belongs to
      scheduled_at TEXT,                   -- '06:00' | '19:30'
      window_from TEXT,                    -- earliest appointment date scanned
      window_to TEXT,                      -- latest scanned: the day BEFORE run_date
      started_at TEXT,
      finished_at TEXT,
      status TEXT DEFAULT 'running',       -- running|ok|failed
      appointments_scanned INTEGER DEFAULT 0,
      unverified_found INTEGER DEFAULT 0,
      new_infractions INTEGER DEFAULT 0,
      repeat_infractions INTEGER DEFAULT 0,
      resolved_since_last INTEGER DEFAULT 0,
      staff_flagged INTEGER DEFAULT 0,
      emailed_to TEXT,
      email_status TEXT,
      error TEXT,
      warnings TEXT,
      triggered_by TEXT
    )`);

    // One row per unverified appointment, ever. appointment_key is what makes a
    // repeat run idempotent: the second sighting updates this row, it does not
    // create a second infraction.
    await dbRun(`CREATE TABLE IF NOT EXISTS rethink_verification_infractions (
      id SERIAL PRIMARY KEY,
      appointment_key TEXT UNIQUE NOT NULL,
      cohort TEXT NOT NULL,
      employee_id INTEGER,                 -- NULL when the provider is unmatched
      rethink_staff_id TEXT,
      staff_name_hint TEXT,
      appointment_date TEXT NOT NULL,
      appointment_status TEXT,
      staff_verification TEXT,
      duration_hours NUMERIC DEFAULT 0,
      quarter TEXT NOT NULL,               -- from first_flagged_date: when the deadline was missed
      first_flagged_run_id INTEGER,
      first_flagged_date TEXT NOT NULL,
      first_flagged_at TEXT,
      last_seen_run_id INTEGER,
      last_seen_at TEXT,
      times_flagged INTEGER DEFAULT 1,
      resolved_run_id INTEGER,
      resolved_at TEXT,                    -- set when a later run finds it verified
      resolved_after_days INTEGER
    )`);

    await dbRun("CREATE INDEX IF NOT EXISTS rvi_employee_quarter ON rethink_verification_infractions (employee_id, quarter)")
      .catch(() => {});
    await dbRun("CREATE INDEX IF NOT EXISTS rvi_flagged_date ON rethink_verification_infractions (first_flagged_date)")
      .catch(() => {});
    await dbRun("CREATE INDEX IF NOT EXISTS rvi_open ON rethink_verification_infractions (resolved_at)")
      .catch(() => {});
  }

  // ======================= IDENTITY ==========================
  // Rethink's appointment id field is not in any fixture in this repo, so the
  // plausible keys are probed and a deterministic composite is used when none
  // of them is present. The composite must be stable across runs or the same
  // session would be counted twice, so it is built only from fields that do not
  // change once a session has been delivered. No client identifier is used --
  // this key is stored, and a stored key is a stored value.
  const APPOINTMENT_ID_KEYS = ["appointmentId", "appointmentID", "apptId", "id", "scheduleId", "appointmentGuid"];
  function appointmentKey(row) {
    for (const k of APPOINTMENT_ID_KEYS) {
      const v = row ? row[k] : null;
      if (v != null && String(v).trim() !== "") return `id:${String(v).trim().slice(0, 120)}`;
    }
    const staffId = String((row && row.staffId) == null ? "" : row.staffId).trim();
    const date = String((row && row.appointmentDate) || "").slice(0, 10);
    const start = String((row && (row.startTime || row.appointmentStartTime || row.scheduledStartTime)) || "").slice(0, 20);
    const dur = String((row && (row.actualDurationHours ?? row.durationHours)) ?? "");
    return `composite:${staffId}|${date}|${start}|${dur}`;
  }

  // Same probe the supervision sync uses, kept identical so a provider is never
  // named one way on the tracker and another way on this report.
  const STAFF_NAME_KEYS = ["staffName", "staffFullName", "providerName", "therapistName", "employeeName", "staff", "provider"];
  function nameHint(row) {
    for (const k of STAFF_NAME_KEYS) {
      const v = row ? row[k] : null;
      if (typeof v === "string" && v.trim()) return v.trim().slice(0, 120);
      if (v && typeof v === "object") {
        const n = v.name || v.fullName || [v.firstName, v.lastName].filter(Boolean).join(" ");
        if (typeof n === "string" && n.trim()) return n.trim().slice(0, 120);
      }
    }
    const first = row && (row.staffFirstName || row.providerFirstName);
    const last = row && (row.staffLastName || row.providerLastName);
    const joined = [first, last].filter((x) => typeof x === "string" && x.trim()).join(" ").trim();
    return joined ? joined.slice(0, 120) : null;
  }

  // Which report a person belongs on -- and, just as importantly, who is on
  // NEITHER. A billing coordinator or a scheduler who once appears on an
  // appointment row must not start collecting infractions that turn up at their
  // review, so this is a positive test on both sides: a person has to read as
  // an RBT or as a BCBA to be on a report at all.
  //
  // The RBT test is asked of Fidelity and the BCBA title is supervision.js's
  // own, in supervision.js's own order: the student/trainee test runs FIRST, so
  // a student analyst working towards certification is an RBT here exactly as
  // they are on the supervision tracker, whatever else their title says.
  const BCBA_TITLE = /\bBCBA\b|\bBCaBA\b|board[ -]?certified behavior analyst|clinical director/i;
  function cohortOf(emp) {
    if (!emp) return null;
    if (String(emp.status || "active") === "terminated") return null;
    // The one hand-set override the CRM already has: somebody explicitly taken
    // off the supervision tracker is not being held to an RBT's deadline.
    const offTracker = emp.supervision_required === false || emp.supervision_required === "f";
    if (!offTracker && isRbt && isRbt(emp)) return "rbt";
    if (BCBA_TITLE.test(String(emp.role_title || ""))) return "bcba";
    return null;
  }

  async function staffMap() {
    const emps = await dbAll(
      `SELECT id, name, email, role_title, status, rethink_id, supervision_required
         FROM hr_employees WHERE COALESCE(status,'active') <> 'terminated'`
    ).catch(() => []);
    const byRethinkId = new Map();
    for (const e of emps) {
      if (e.rethink_id != null && String(e.rethink_id).trim() !== "") {
        byRethinkId.set(String(e.rethink_id).trim(), e);
      }
    }
    return { byRethinkId, employees: emps };
  }

  // ======================= THE RUN ===========================
  // Claim first, work second. The claim is a row; if the INSERT loses the race
  // there is nothing to do, because somebody else is already doing it.
  async function claimRun(cohort, runDate, scheduledAt, triggeredBy) {
    const row = await dbGet(
      `INSERT INTO rethink_verification_runs
         (run_key, cohort, run_date, scheduled_at, started_at, status, triggered_by)
       VALUES (?, ?, ?, ?, ?, 'running', ?)
       ON CONFLICT (run_key) DO NOTHING RETURNING id`,
      [`${cohort}|${runDate}`, cohort, runDate, scheduledAt, nowISO(), triggeredBy]
    ).catch(() => null);
    return row && row.id ? row.id : null;
  }

  // A failed run keeps its record -- somebody will ask why no email arrived on
  // the 18th -- but gives up its claim on the canonical key, so the next tick
  // that same Friday tries again instead of the week being silently lost.
  async function failRun(runId, cohort, runDate, message, warnings) {
    await dbRun(
      `UPDATE rethink_verification_runs
          SET run_key = ?, status = 'failed', finished_at = ?, error = ?, warnings = ?
        WHERE id = ?`,
      [`${cohort}|${runDate}|failed|${runId}`, nowISO(),
       String(client.redact(message || "")).slice(0, 500), JSON.stringify(warnings || []), runId]
    ).catch(() => {});
  }

  async function runCohort(cohort, opts = {}) {
    const triggeredBy = opts.triggeredBy || "scheduled";
    const runDate = opts.runDate || pacificParts(nowMs()).date;
    const scheduledAt = opts.scheduledAt
      || (SCHEDULES.find((s) => s.cohort === cohort) || {}).at
      || null;
    const warnings = [];

    if (cohort !== "rbt" && cohort !== "bcba") {
      return { ok: false, error: `Unknown cohort "${cohort}".` };
    }
    if (!client.configured()) {
      return { ok: false, skipped: "not_configured", cohort, run_date: runDate,
        error: "Rethink credentials are not configured on the server." };
    }
    // Refusing rather than guessing. Without the confirmed filter this module
    // cannot tell a verified session from an unverified one, and the failure
    // mode of guessing is an infraction on somebody's review for work they did
    // correctly.
    if (!getRethinkConfig || !verificationVerdict || !isRbt) {
      return { ok: false, skipped: "not_wired", cohort, run_date: runDate,
        error: "The Rethink verification filter, or the rule for who is an RBT, " +
               "is not wired into this module. It will not guess either one." };
    }
    const cfg = await getRethinkConfig();
    if (!cfg || !cfg.filter_confirmed) {
      return { ok: false, skipped: "filter_unconfirmed", cohort, run_date: runDate,
        error: "The Rethink completed/verified filter has not been confirmed yet, so " +
               "nothing can be called unverified without guessing. Confirm it on the " +
               "Rethink panel and this report starts the following Friday." };
    }
    if (!cfg.require_staff_verification) {
      return { ok: false, skipped: "verification_off", cohort, run_date: runDate,
        error: "Staff verification is switched off in the Rethink filter, so there is " +
               "no such thing as an unverified session to report." };
    }

    const runId = await claimRun(cohort, runDate, scheduledAt, triggeredBy);
    if (!runId) {
      return { ok: true, skipped: "already_ran", cohort, run_date: runDate };
    }

    // The cutoff. Strictly before the run date, for both cohorts: see the note
    // at the top of this file.
    const windowTo = addDays(runDate, -1);
    const windowFrom = addDays(runDate, -LOOKBACK_DAYS);

    client.log("verification_run_start", {
      kind: "unverified_appointments", cohort, run_date: runDate,
      from: windowFrom, to: windowTo, triggered_by: triggeredBy,
    });

    let fetched;
    try {
      fetched = await client.dwhGetAllPages(DWH_APPOINTMENTS, {
        From: windowFrom,
        To: windowTo,
        FilterByAppointmentDate: true,
        IncludeDeleted: false,
        IncludeCanceled: false,
      }, { nowMs: nowMs(), pageSize: 500 });
    } catch (e) {
      client.log("verification_run_failed", {
        kind: "unverified_appointments", cohort, run_date: runDate,
        status: e && e.status, endpoint: e && e.endpoint, stage: e && e.stage, error: e && e.message,
      });
      await failRun(runId, cohort, runDate, (e && e.message) || "Rethink could not be reached.", warnings);
      return { ok: false, cohort, run_date: runDate, run_id: runId,
        error: (e && e.safe) || client.redact((e && e.message) || "Rethink could not be reached."),
        detail_in_server_logs: true };
    }

    if (fetched.truncated) {
      warnings.push(`Stopped at the page limit for ${windowFrom}–${windowTo}; the window may be incomplete.`);
    }

    const rows = fetched.rows || [];
    const { byRethinkId } = await staffMap();

    // ---- sort this cohort's appointments into verified / not ---------------
    const unverified = [];          // rows that are this cohort's and still unverified
    const verifiedKeys = [];        // keys that ARE verified now, so an open infraction can close
    let scanned = 0, noStaffId = 0, unmatched = 0, offCohort = 0;
    const unmatchedIds = new Set();

    for (const row of rows) {
      // One unreadable row must not cost the whole week's report.
      try {
        const apptDate = String(row.appointmentDate || "").slice(0, 10);
        // Belt and braces: the From/To window should already have done this.
        if (!apptDate || apptDate >= runDate) continue;

        const staffId = String(row.staffId == null ? "" : row.staffId).trim();
        if (!staffId) { noStaffId++; continue; }

        const emp = byRethinkId.get(staffId) || null;
        if (!emp) { unmatched++; unmatchedIds.add(staffId); continue; }
        if (cohortOf(emp) !== cohort) { offCohort++; continue; }

        scanned++;
        const verdict = verificationVerdict(row, cfg);
        const key = appointmentKey(row);

        if (verdict && verdict.verifiedOk) { verifiedKeys.push(key); continue; }

        unverified.push({
          key, emp, staffId,
          name_hint: nameHint(row),
          appointment_date: apptDate,
          appointment_status: row.appointmentStatus == null ? null : String(row.appointmentStatus).slice(0, 80),
          staff_verification: row.staffVerification == null ? null : String(row.staffVerification).slice(0, 80),
          hours: round2(num(row.actualDurationHours)),
        });
      } catch (e) {
        warnings.push(`A row could not be read: ${client.redact(e.message)}`);
      }
    }

    if (unmatched) {
      warnings.push(`${unmatched} appointment(s) belong to ${unmatchedIds.size} Rethink provider(s) with no CRM ` +
        `employee record, so they are on nobody's report. Link them under Rethink -> Staff Match.`);
    }
    if (noStaffId) warnings.push(`${noStaffId} appointment(s) had no staffId and were skipped.`);

    // ---- record the infractions -------------------------------------------
    // ON CONFLICT is what makes this safe to re-run: the same appointment seen
    // a second time updates the sighting, it does not become a second
    // infraction. times_flagged is the count of Fridays it has survived.
    let newCount = 0, repeatCount = 0;
    const at = nowISO();
    for (const u of unverified) {
      const q = quarterOf(runDate);
      const inserted = await dbGet(
        `INSERT INTO rethink_verification_infractions
           (appointment_key, cohort, employee_id, rethink_staff_id, staff_name_hint,
            appointment_date, appointment_status, staff_verification, duration_hours,
            quarter, first_flagged_run_id, first_flagged_date, first_flagged_at,
            last_seen_run_id, last_seen_at, times_flagged)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT (appointment_key) DO UPDATE SET
           last_seen_run_id = EXCLUDED.last_seen_run_id,
           last_seen_at = EXCLUDED.last_seen_at,
           appointment_status = EXCLUDED.appointment_status,
           staff_verification = EXCLUDED.staff_verification,
           times_flagged = rethink_verification_infractions.times_flagged + 1,
           -- A session that was fixed and then un-verified again re-opens on
           -- the same infraction rather than becoming a new one.
           resolved_at = NULL, resolved_run_id = NULL, resolved_after_days = NULL
         RETURNING id, times_flagged`,
        [u.key, cohort, u.emp.id, u.staffId, u.name_hint || u.emp.name || null,
         u.appointment_date, u.appointment_status, u.staff_verification, u.hours,
         q, runId, runDate, at, runId, at]
      ).catch((e) => { warnings.push(`Could not record an infraction: ${client.redact(e.message)}`); return null; });

      if (!inserted) continue;
      if (Number(inserted.times_flagged) <= 1) newCount++; else repeatCount++;
    }

    // ---- close the ones they caught up on ----------------------------------
    // The infraction stands; this only records that the paperwork landed, and
    // how many days it took. A review that wants "still open today" has it, and
    // so does one that wants "fixed, but late".
    let resolved = 0;
    for (const key of verifiedKeys) {
      const row = await dbGet(
        `UPDATE rethink_verification_infractions
            SET resolved_at = ?, resolved_run_id = ?,
                resolved_after_days = GREATEST(0, (?::date - first_flagged_date::date))
          WHERE appointment_key = ? AND resolved_at IS NULL
          RETURNING id`,
        [at, runId, runDate, key]
      ).catch(() => null);
      if (row && row.id) resolved++;
    }

    const flaggedStaff = new Set(unverified.map((u) => u.emp.id));

    await dbRun(
      `UPDATE rethink_verification_runs
          SET status = 'ok', finished_at = ?, window_from = ?, window_to = ?,
              appointments_scanned = ?, unverified_found = ?, new_infractions = ?,
              repeat_infractions = ?, resolved_since_last = ?, staff_flagged = ?, warnings = ?
        WHERE id = ?`,
      [nowISO(), windowFrom, windowTo, scanned, unverified.length, newCount,
       repeatCount, resolved, flaggedStaff.size, JSON.stringify(warnings), runId]
    ).catch(() => {});

    client.log("verification_run_done", {
      kind: "unverified_appointments", cohort, run_date: runDate,
      scanned, unverified: unverified.length, new: newCount, repeat: repeatCount,
      resolved, staff_flagged: flaggedStaff.size,
    });

    const summary = {
      ok: true, cohort, run_id: runId, run_date: runDate, scheduled_at: scheduledAt,
      window_from: windowFrom, window_to: windowTo,
      appointments_scanned: scanned,
      unverified_found: unverified.length,
      new_infractions: newCount,
      repeat_infractions: repeatCount,
      resolved_since_last: resolved,
      staff_flagged: flaggedStaff.size,
      warnings,
    };

    // ---- the email ----------------------------------------------------------
    // The infractions are already recorded by this point, on purpose: a report
    // that could not be delivered must not also lose the week's data.
    if (opts.email !== false) {
      const mail = await emailSummary(cohort, runId, runDate, summary, unverified);
      summary.emailed_to = mail.to;
      summary.email_status = mail.status;
      if (mail.status === "no_recipient") {
        // Loud rather than silent. "Nobody has told the CRM where to send this"
        // looks exactly like "there was nothing to report" from the outside,
        // and somebody would find out a quarter later.
        const note = "The report was recorded but NOT emailed: no recipient is set. Set " +
          "RETHINK_VERIFICATION_REPORT_TO, or a Clinical Director / owner notification address.";
        warnings.push(note);
        client.log("verification_no_recipient", { kind: "unverified_appointments", cohort, run_date: runDate });
        console.error(`Unverified appointment report (${cohort} ${runDate}): ${note}`);
      }
      await dbRun(
        `UPDATE rethink_verification_runs SET emailed_to = ?, email_status = ?, warnings = ? WHERE id = ?`,
        [mail.to || null, mail.status || null, JSON.stringify(warnings), runId]
      ).catch(() => {});
    }

    return summary;
  }

  // ======================= THE EMAIL =========================
  // Where it goes: an address set for this report, else the Clinical Director,
  // else the owner notification address, else the owner's own login. Nothing is
  // hard-coded, and a fresh install still reaches somebody.
  async function recipients() {
    const clean = (v) => String(v == null ? "" : v).trim();
    const explicit = clean(process.env.RETHINK_VERIFICATION_REPORT_TO)
      || clean(await getAppSetting("rethink_verification_report_to", ""));
    if (explicit) {
      return explicit.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    }
    const cd = clean(await getAppSetting("clinical_director_email", ""));
    if (cd) return [cd];
    const owner = clean(await getAppSetting("owner_notification_email", ""));
    if (owner) return [owner];
    // Last resort: the owner's own login. The generic admin@ address is sorted
    // to the BACK rather than excluded outright, which is the difference
    // between "prefer a named owner" and "send nowhere". Some installs -- this
    // one included -- have the owner signed in as admin@, and a compliance
    // report that quietly goes to nobody is the failure worth avoiding here.
    const rows = await dbAll(
      `SELECT email, role FROM users WHERE role IN ('owner','super_admin')
        ORDER BY CASE WHEN email = 'admin@spectrumsquadlv.com' THEN 1 ELSE 0 END,
                 CASE role WHEN 'owner' THEN 0 ELSE 1 END, id`
    ).catch(() => []);
    return rows.length ? [String(rows[0].email)] : [];
  }

  async function emailSummary(cohort, runId, runDate, summary, unverified) {
    const to = await recipients();
    if (!to.length) return { to: null, status: "no_recipient" };

    const label = (SCHEDULES.find((s) => s.cohort === cohort) || {}).label || cohort.toUpperCase();

    // Per person, because that is the unit the quarterly review works in.
    const byPerson = new Map();
    for (const u of unverified) {
      const cur = byPerson.get(u.emp.id) || { name: u.emp.name || u.name_hint || `Staff ${u.staffId}`, rows: [] };
      cur.rows.push(u);
      byPerson.set(u.emp.id, cur);
    }
    const people = [...byPerson.values()].sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name));

    const quarter = quarterOf(runDate);
    // The running quarterly total, so the email is not just this week -- it is
    // the number that is going to appear in the review.
    const qtd = await quarterSummary(quarter, { cohort }).catch(() => null);
    const qtdByEmployee = new Map();
    if (qtd && Array.isArray(qtd.people)) {
      for (const p of qtd.people) qtdByEmployee.set(p.employee_id, p);
    }

    const cell = "padding:7px 10px;border-bottom:1px solid #e9e9f2;font-size:13px;";
    const head = "padding:7px 10px;border-bottom:2px solid #1b2a6b;font-size:12px;text-transform:uppercase;letter-spacing:.04em;text-align:left;color:#1b2a6b;";

    const body = people.length
      ? `<table style="border-collapse:collapse;width:100%;margin:14px 0;">
           <tr>
             <th style="${head}">Staff member</th>
             <th style="${head}">Unverified sessions</th>
             <th style="${head}">Oldest</th>
             <th style="${head}">Hours</th>
             <th style="${head}">${esc(quarter)} infractions to date</th>
           </tr>
           ${people.map((p) => {
             const oldest = p.rows.map((r) => r.appointment_date).sort()[0];
             const hours = round2(p.rows.reduce((s, r) => s + num(r.hours), 0));
             const q = qtdByEmployee.get(p.rows[0].emp.id);
             return `<tr>
               <td style="${cell}"><strong>${esc(p.name)}</strong></td>
               <td style="${cell}">${p.rows.length}</td>
               <td style="${cell}">${esc(oldest)}</td>
               <td style="${cell}">${hours}</td>
               <td style="${cell}">${q ? q.infractions : p.rows.length}</td>
             </tr>`;
           }).join("")}
         </table>
         <p style="font-size:13px;color:#444;">Each unverified session above is recorded once as an
            infraction against that person, dated ${esc(runDate)}. A session already counted in an
            earlier week is not counted again.</p>`
      : `<p style="font-size:15px;"><strong>Nothing outstanding.</strong> Every ${esc(label)} session
           dated ${esc(summary.window_from)} to ${esc(summary.window_to)} is staff-verified.</p>`;

    const warnBlock = (summary.warnings || []).length
      ? `<p style="font-size:12.5px;color:#8a6d1f;background:#fdf6e3;padding:10px 12px;border-radius:6px;">
           ${summary.warnings.map(esc).join("<br>")}</p>`
      : "";

    const html = `
      <p style="font-size:15px;">${esc(label)} unverified-appointment check for Friday ${esc(runDate)}.</p>
      <p style="font-size:13px;color:#555;">Sessions dated ${esc(summary.window_from)} through
        ${esc(summary.window_to)} that are still not staff-verified. Sessions delivered today are not
        included &mdash; they are checked next Friday.</p>
      ${body}
      <p style="font-size:13px;color:#555;">
        ${summary.unverified_found} unverified session(s) across ${summary.staff_flagged} ${esc(label)}(s).
        ${summary.new_infractions} newly recorded, ${summary.repeat_infractions} still open from an
        earlier week, ${summary.resolved_since_last} verified since the last check.
      </p>
      ${warnBlock}
      <p style="font-size:12px;color:#9ca3af;">Unverified Appointments (${esc(label)}) &mdash; Spectrum Squad CRM</p>`;

    const subject = people.length
      ? `${label} unverified appointments — ${summary.unverified_found} session(s), ${summary.staff_flagged} staff (${runDate})`
      : `${label} unverified appointments — all clear (${runDate})`;

    let status = "sent";
    for (const addr of to) {
      const r = await sendEmail({
        to: addr, subject, html,
        type: "rethink_unverified_appointments",
        refType: "rethink_verification_run", refId: runId,
      }).catch((e) => ({ delivered: "failed", errorMsg: e.message }));
      if (r && r.delivered && r.delivered !== "sent") status = String(r.delivered);
    }
    return { to: to.join(", "), status };
  }

  // ======================= THE TICK ==========================
  // Called on a short interval by server.js. Cheap: on six days out of seven it
  // reads the clock and returns. It does not hold a timer for Friday, because a
  // timer does not survive a redeploy and this must.
  async function tick(triggeredBy = "scheduled") {
    const now = pacificParts(nowMs());
    const fired = [];
    if (now.weekday !== WEEKDAY) return { fired, checked_at: now };

    for (const s of SCHEDULES) {
      const due = hhmmToMinutes(s.at);
      if (due == null) continue;
      if (now.minutes < due) continue;

      const already = await dbGet(
        "SELECT id FROM rethink_verification_runs WHERE run_key = ?",
        [`${s.cohort}|${now.date}`]
      ).catch(() => null);
      if (already && already.id) continue;

      const out = await runCohort(s.cohort, {
        triggeredBy, runDate: now.date, scheduledAt: s.at,
      }).catch((e) => ({ ok: false, cohort: s.cohort, error: e.message }));
      fired.push(out);
    }
    return { fired, checked_at: now };
  }

  // ======================= THE NUMBERS =======================
  // What a quarterly review pulls. One row per person: how many infractions,
  // how many are still open, how bad the worst one got.
  async function quarterSummary(quarter, opts = {}) {
    const w = quarterWindow(quarter);
    if (!w) return { ok: false, error: `Not a quarter: "${quarter}". Use e.g. 2026-Q3.` };

    const params = [w.from, w.to];
    let cohortClause = "";
    if (opts.cohort === "rbt" || opts.cohort === "bcba") {
      cohortClause = " AND i.cohort = ?";
      params.push(opts.cohort);
    }

    const rows = await dbAll(
      `SELECT i.employee_id, i.cohort,
              COALESCE(e.name, MAX(i.staff_name_hint)) AS name,
              e.role_title,
              COUNT(*) AS infractions,
              COUNT(*) FILTER (WHERE i.resolved_at IS NULL) AS still_open,
              COALESCE(SUM(i.duration_hours), 0) AS hours,
              MIN(i.appointment_date) AS oldest_session,
              MAX(i.first_flagged_date) AS last_flagged,
              MAX(i.times_flagged) AS most_weeks_outstanding,
              MAX(i.resolved_after_days) AS slowest_fix_days,
              COUNT(DISTINCT i.first_flagged_date) AS weeks_flagged
         FROM rethink_verification_infractions i
         LEFT JOIN hr_employees e ON e.id = i.employee_id
        WHERE i.first_flagged_date >= ? AND i.first_flagged_date <= ?${cohortClause}
        GROUP BY i.employee_id, i.cohort, e.name, e.role_title
        ORDER BY COUNT(*) DESC, COALESCE(e.name, MAX(i.staff_name_hint))`,
      params
    ).catch(() => []);

    const people = rows.map((r) => ({
      employee_id: r.employee_id,
      name: r.name || (r.employee_id ? `Employee ${r.employee_id}` : "Unmatched provider"),
      role_title: r.role_title || null,
      cohort: r.cohort,
      infractions: Number(r.infractions) || 0,
      still_open: Number(r.still_open) || 0,
      hours: round2(num(r.hours)),
      oldest_session: r.oldest_session,
      last_flagged: r.last_flagged,
      weeks_flagged: Number(r.weeks_flagged) || 0,
      most_weeks_outstanding: Number(r.most_weeks_outstanding) || 0,
      slowest_fix_days: r.slowest_fix_days == null ? null : Number(r.slowest_fix_days),
    }));

    return {
      ok: true,
      quarter: w.quarter, from: w.from, to: w.to,
      cohort: opts.cohort || "all",
      people,
      totals: {
        staff_with_infractions: people.length,
        infractions: people.reduce((s, p) => s + p.infractions, 0),
        still_open: people.reduce((s, p) => s + p.still_open, 0),
      },
    };
  }

  // One person, every infraction, for the review conversation itself.
  async function employeeHistory(employeeId, opts = {}) {
    const id = Number(employeeId);
    if (!Number.isFinite(id)) return { ok: false, error: "An employee id is required." };

    const params = [id];
    let range = "";
    if (opts.quarter) {
      const w = quarterWindow(opts.quarter);
      if (!w) return { ok: false, error: `Not a quarter: "${opts.quarter}". Use e.g. 2026-Q3.` };
      range = " AND first_flagged_date >= ? AND first_flagged_date <= ?";
      params.push(w.from, w.to);
    } else if (opts.from && opts.to) {
      range = " AND first_flagged_date >= ? AND first_flagged_date <= ?";
      params.push(opts.from, opts.to);
    }

    const rows = await dbAll(
      `SELECT appointment_date, appointment_status, staff_verification, duration_hours,
              cohort, quarter, first_flagged_date, times_flagged, resolved_at, resolved_after_days
         FROM rethink_verification_infractions
        WHERE employee_id = ?${range}
        ORDER BY first_flagged_date DESC, appointment_date DESC`,
      params
    ).catch(() => []);

    const emp = await dbGet("SELECT id, name, role_title FROM hr_employees WHERE id = ?", [id]).catch(() => null);

    // Grouped by quarter as well as listed, because "how many this quarter" is
    // the question the review actually asks.
    const byQuarter = {};
    for (const r of rows) {
      const q = r.quarter || quarterOf(r.first_flagged_date) || "unknown";
      byQuarter[q] = byQuarter[q] || { quarter: q, infractions: 0, still_open: 0 };
      byQuarter[q].infractions++;
      if (!r.resolved_at) byQuarter[q].still_open++;
    }

    return {
      ok: true,
      employee_id: id,
      name: (emp && emp.name) || null,
      role_title: (emp && emp.role_title) || null,
      total_infractions: rows.length,
      still_open: rows.filter((r) => !r.resolved_at).length,
      by_quarter: Object.values(byQuarter).sort((a, b) => b.quarter.localeCompare(a.quarter)),
      infractions: rows.map((r) => ({
        appointment_date: r.appointment_date,
        appointment_status: r.appointment_status,
        staff_verification: r.staff_verification,
        hours: round2(num(r.duration_hours)),
        cohort: r.cohort,
        quarter: r.quarter,
        flagged_on: r.first_flagged_date,
        weeks_outstanding: Number(r.times_flagged) || 1,
        resolved_at: r.resolved_at || null,
        resolved_after_days: r.resolved_after_days == null ? null : Number(r.resolved_after_days),
      })),
    };
  }

  async function recentRuns(limit = 20) {
    const n = Math.min(100, Math.max(1, Number(limit) || 20));
    const rows = await dbAll(
      `SELECT id, cohort, run_date, scheduled_at, window_from, window_to, status,
              appointments_scanned, unverified_found, new_infractions, repeat_infractions,
              resolved_since_last, staff_flagged, emailed_to, email_status, error, warnings,
              triggered_by, started_at, finished_at
         FROM rethink_verification_runs ORDER BY id DESC LIMIT ${n}`
    ).catch(() => []);
    return rows.map((r) => ({
      ...r,
      warnings: (() => { try { return JSON.parse(r.warnings || "[]"); } catch (e) { return []; } })(),
    }));
  }

  // ======================= API ===============================
  // Read-only JSON, admin-tier, and deliberately NOT on any screen. This module
  // adds nothing to the CRM's navigation; these routes exist so the quarterly
  // numbers can be pulled by whoever needs them without a page being built.
  // The one write is a manual re-run, kept owner-only because it sends email.
  const VIEW_ROLES = ["owner", "super_admin", "admin", "hr_admin", "clinical"];
  const MANAGE_ROLES = ["owner", "super_admin"];
  const roleOf = (u) => (u && (u.role || u.role_key || "")) || "";

  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/rethink-verification")) return false;
    if (!user || !VIEW_ROLES.includes(roleOf(user))) {
      json(res, 403, { error: "Not allowed." });
      return true;
    }

    if (method === "GET" && pathname === "/api/rethink-verification/quarter") {
      const q = String((query && query.quarter) || "").trim() || quarterOf(pacificParts(nowMs()).date);
      const cohort = String((query && query.cohort) || "").trim();
      json(res, 200, await quarterSummary(q, { cohort: cohort === "rbt" || cohort === "bcba" ? cohort : null }));
      return true;
    }

    if (method === "GET" && pathname === "/api/rethink-verification/employee") {
      const id = (query && (query.employee_id || query.id)) || "";
      json(res, 200, await employeeHistory(id, {
        quarter: (query && query.quarter) || null,
        from: (query && query.from) || null,
        to: (query && query.to) || null,
      }));
      return true;
    }

    if (method === "GET" && pathname === "/api/rethink-verification/runs") {
      json(res, 200, { ok: true, runs: await recentRuns((query && query.limit) || 20) });
      return true;
    }

    if (method === "GET" && pathname === "/api/rethink-verification/status") {
      const now = pacificParts(nowMs());
      json(res, 200, {
        ok: true,
        timezone: TZ,
        now_local: now,
        weekday: WEEKDAY,
        lookback_days: LOOKBACK_DAYS,
        schedule: SCHEDULES.map((s) => ({ cohort: s.cohort, label: s.label, at: s.at })),
        recipients: await recipients(),
        rethink_configured: client.configured(),
        recent: await recentRuns(5),
      });
      return true;
    }

    // Re-run a cohort by hand. Owner-only: it sends the email.
    if (method === "POST" && pathname === "/api/rethink-verification/run") {
      if (!MANAGE_ROLES.includes(roleOf(user))) { json(res, 403, { error: "Not allowed." }); return true; }
      const cohort = String((query && query.cohort) || "").trim();
      if (cohort !== "rbt" && cohort !== "bcba") {
        json(res, 400, { error: 'Pass cohort=rbt or cohort=bcba.' });
        return true;
      }
      const out = await runCohort(cohort, {
        triggeredBy: `manual:${(user && user.email) || "unknown"}`,
        email: String((query && query.email) || "") !== "false",
      });
      json(res, out.ok ? 200 : 400, out);
      return true;
    }

    return false;
  }

  return {
    initTables,
    handleApi,
    tick,
    runCohort,
    quarterSummary,
    employeeHistory,
    recentRuns,
    _internal: {
      pacificParts, addDays, hhmmToMinutes, quarterOf, quarterWindow,
      cohortOf, appointmentKey, nameHint, recipients,
      SCHEDULES, WEEKDAY, LOOKBACK_DAYS, TZ,
    },
  };
};
