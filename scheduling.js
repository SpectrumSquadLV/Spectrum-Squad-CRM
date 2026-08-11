// scheduling.js -- Spectrum Squad Scheduling Center (backend).
//
// This replaces the old Therapy Schedule, which was not a calendar: it stored
// a weekly pattern (day_of_week + HH:MM) against a `therapists` table of five
// seeded demo rows that had nothing to do with the real staff directory. There
// was no date, no status, no location, no service, no authorization link and
// nothing a session note could ever attach to.
//
// The schedule is meant to become the source of truth for the whole clinical
// -> documentation -> billing chain, so it is built on dated session instances
// keyed to the records that actually exist:
//
//     clients.id        the family
//     hr_employees.id   the staff member (NOT therapists.id)
//
// Design decisions worth stating up front:
//
//   * A recurring schedule is a SERIES plus concrete dated sessions. Sessions
//     are materialised, not computed on the fly, because each one carries its
//     own status, note state and billing state -- a computed occurrence has
//     nowhere to record that Tuesday was a no-show.
//
//   * Editing supports this-session / this-and-future / entire-series. Past
//     sessions are never rewritten by a series edit. A session that already
//     happened is a clinical and billing record; changing the calendar must
//     not silently change history.
//
//   * Conflict checks explain themselves in words. "Sierra is already with
//     Liam R. from 3:00 to 5:00 PM" is actionable; "Scheduling Error" is not.
//     Blocking conflicts stop the save; warnings are overridable by an
//     authorised user and the override is recorded.
//
//   * Everything that changes a session writes to sched_audit with the before
//     and after value.
//
// Additive: new sched_* tables plus availability tables. The old
// schedule_sessions table is left in place and read once, to seed real dated
// sessions from whatever weekly pattern was already set up.

"use strict";

module.exports = function initScheduling(ctx) {
  const {
    dbGet, dbAll, dbRun, nowISO, readBody, json,
    canAccessClients, moduleGranted,
  } = ctx;

  const clean = (v) => (v == null ? "" : String(v).trim());
  const num = (v) => (v == null || v === "" ? null : Number(v));

  // ======================= ROLES =============================
  const ADMIN_ROLES = ["owner", "super_admin", "admin"];
  // Who may create and move sessions for anyone.
  const SCHEDULER_ROLES = ["owner", "super_admin", "admin", "scheduling", "clinical", "hr_admin"];
  // Who may see the whole clinic rather than only their own sessions.
  const FULL_VIEW_ROLES = ["owner", "super_admin", "admin", "scheduling", "clinical", "hr_admin", "billing", "intake"];

  const isAdmin = (u) => !!u && ADMIN_ROLES.includes(u.role);
  // Note: per-user module_access is NOT re-checked here. server.js already
  // blocks /api/sched/* for anyone whose "schedule" module is switched off,
  // and moduleGranted() answers "explicitly granted", not "allowed by role" --
  // using it here would lock out every user who has no override set at all.
  const canSchedule = (u) => !!u && (SCHEDULER_ROLES.includes(u.role) || moduleGranted(u, "schedule"));
  const canViewAll = (u) => !!u && (FULL_VIEW_ROLES.includes(u.role) || moduleGranted(u, "schedule"));

  // A technician sees their own sessions and nobody else's. Their staff record
  // is matched by email, which is the only link between a login and an
  // hr_employees row today.
  async function ownEmployeeId(user) {
    if (!user || !user.email) return null;
    const row = await dbGet("SELECT id FROM hr_employees WHERE LOWER(email) = LOWER(?)", [user.email]);
    return row ? row.id : null;
  }

  // ======================= CONSTANTS =========================
  const SESSION_STATUSES = [
    "scheduled", "checked_in", "in_progress", "completed",
    "cancelled", "no_show", "staff_call_out", "needs_coverage",
  ];
  const STATUS_LABEL = {
    scheduled: "Scheduled",
    checked_in: "Checked in",
    in_progress: "In progress",
    completed: "Completed",
    cancelled: "Cancelled",
    no_show: "Client no show",
    staff_call_out: "Staff call out",
    needs_coverage: "Needs coverage",
  };
  // Statuses where the session did not happen, so no note and no billing.
  const NON_OCCURRING = ["cancelled", "no_show", "staff_call_out", "needs_coverage"];

  const NOTE_STATUSES = ["not_required", "required", "draft", "completed", "verified"];
  const CANCELLED_BY = ["client_family", "staff", "spectrum_squad", "other"];
  const LOCATION_KINDS = ["clinic", "home", "school", "community", "telehealth"];

  const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  // ======================= SCHEMA ============================
  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS sched_locations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'clinic',
      address TEXT,
      color TEXT DEFAULT '#4f46e5',
      active BOOLEAN DEFAULT TRUE,
      sort_order INTEGER,
      created_at TEXT
    )`);

    // A recurrence definition. Sessions point back at it so an edit can reach
    // "this and future" without guessing which rows belong together.
    await dbRun(`CREATE TABLE IF NOT EXISTS sched_series (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL,
      staff_id INTEGER,
      supervisor_id INTEGER,
      location_id INTEGER,
      service_code TEXT,
      service_label TEXT,
      days_of_week TEXT NOT NULL,        -- JSON array of 0..6
      start_time TEXT NOT NULL,          -- 'HH:MM'
      end_time TEXT NOT NULL,
      starts_on TEXT NOT NULL,           -- 'YYYY-MM-DD'
      ends_on TEXT,                      -- null = open ended (materialised in windows)
      authorization_id INTEGER,
      notes TEXT,
      status TEXT DEFAULT 'active',      -- active | ended
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS sched_sessions (
      id SERIAL PRIMARY KEY,
      series_id INTEGER,
      client_id INTEGER NOT NULL,
      staff_id INTEGER,                  -- hr_employees.id; null = unassigned / needs coverage
      supervisor_id INTEGER,             -- supervising BCBA, hr_employees.id
      location_id INTEGER,
      service_code TEXT,                 -- CPT
      service_label TEXT,
      session_date TEXT NOT NULL,        -- 'YYYY-MM-DD'
      start_time TEXT NOT NULL,          -- 'HH:MM'
      end_time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      note_status TEXT NOT NULL DEFAULT 'not_required',
      billing_status TEXT NOT NULL DEFAULT 'not_ready',
      billing_hold_reason TEXT,
      authorization_id INTEGER,
      checked_in_at TEXT,
      completed_at TEXT,
      cancelled_at TEXT,
      cancelled_by TEXT,                 -- client_family | staff | spectrum_squad | other
      cancellation_reason TEXT,
      cancellation_notes TEXT,
      previous_staff_id INTEGER,         -- set on reassignment, for the coverage trail
      admin_notes TEXT,
      override_reason TEXT,              -- why a warning was accepted
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    )`);
    await dbRun(`CREATE INDEX IF NOT EXISTS sched_sessions_date_idx ON sched_sessions (session_date)`).catch(() => {});
    await dbRun(`CREATE INDEX IF NOT EXISTS sched_sessions_staff_idx ON sched_sessions (staff_id, session_date)`).catch(() => {});
    await dbRun(`CREATE INDEX IF NOT EXISTS sched_sessions_client_idx ON sched_sessions (client_id, session_date)`).catch(() => {});

    // Before/after on every change. Clinical and billing records must never
    // silently change because someone dragged a calendar block.
    await dbRun(`CREATE TABLE IF NOT EXISTS sched_audit (
      id SERIAL PRIMARY KEY,
      session_id INTEGER,
      series_id INTEGER,
      action TEXT NOT NULL,
      field TEXT,
      old_value TEXT,
      new_value TEXT,
      reason TEXT,
      actor TEXT,
      created_at TEXT
    )`);
    await dbRun(`CREATE INDEX IF NOT EXISTS sched_audit_session_idx ON sched_audit (session_id)`).catch(() => {});

    // Hour-precise availability. The existing hr_availability JSON is only
    // morning/afternoon/evening booleans, which cannot answer "is Maya free at
    // 3:30". That blob is read once to seed these rows and then left alone.
    await dbRun(`CREATE TABLE IF NOT EXISTS staff_availability (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      day_of_week INTEGER NOT NULL,      -- 0=Sun .. 6=Sat
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      note TEXT,
      source TEXT DEFAULT 'manual',      -- manual | seeded_from_form
      created_at TEXT,
      updated_at TEXT
    )`);
    await dbRun(`CREATE INDEX IF NOT EXISTS staff_availability_emp_idx ON staff_availability (employee_id)`).catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS staff_time_off (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      all_day BOOLEAN DEFAULT TRUE,
      start_time TEXT,
      end_time TEXT,
      kind TEXT DEFAULT 'pto',           -- pto | sick | unpaid | other
      status TEXT DEFAULT 'approved',    -- requested | approved | denied
      notes TEXT,
      created_by TEXT,
      created_at TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS client_availability (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL,
      day_of_week INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      location_pref TEXT,
      note TEXT,
      source TEXT DEFAULT 'manual',      -- manual | seeded_from_request
      created_at TEXT,
      updated_at TEXT
    )`);
    await dbRun(`CREATE INDEX IF NOT EXISTS client_availability_client_idx ON client_availability (client_id)`).catch(() => {});

    // Set once the legacy weekly patterns have been converted, so the
    // migration cannot run twice and double-book the calendar.
    await dbRun(`CREATE TABLE IF NOT EXISTS sched_meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    )`);

    await seedLocations();
    console.log("Scheduling Center schema ready.");
  }

  async function seedLocations() {
    const row = await dbGet("SELECT COUNT(*) AS n FROM sched_locations");
    if (Number(row.n) > 0) return;
    const seeds = [
      ["Clinic", "clinic", "#4f46e5", 1],
      ["Client Home", "home", "#0891b2", 2],
      ["School", "school", "#059669", 3],
      ["Community", "community", "#d97706", 4],
      ["Telehealth", "telehealth", "#7c3aed", 5],
    ];
    for (const [name, kind, color, order] of seeds) {
      await dbRun(
        "INSERT INTO sched_locations (name, kind, color, active, sort_order, created_at) VALUES (?, ?, ?, TRUE, ?, ?)",
        [name, kind, color, order, nowISO()]
      );
    }
  }

  // ======================= TIME HELPERS ======================
  const toMin = (hhmm) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ""));
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const fromMin = (mins) =>
    `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  const fmtTime = (hhmm) => {
    const t = toMin(hhmm);
    if (t == null) return String(hhmm || "");
    const h = Math.floor(t / 60), m = t % 60;
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return m ? `${h12}:${String(m).padStart(2, "0")} ${ampm}` : `${h12}:00 ${ampm}`;
  };
  const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;
  const dateOnly = (d) => String(d || "").slice(0, 10);
  const dowOf = (dateStr) => new Date(dateOnly(dateStr) + "T00:00:00Z").getUTCDay();
  const addDays = (dateStr, n) => {
    const d = new Date(dateOnly(dateStr) + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const hoursBetween = (start, end) => {
    const a = toMin(start), b = toMin(end);
    return a == null || b == null ? 0 : Math.max(0, (b - a) / 60);
  };
  const today = () => nowISO().slice(0, 10);

  function shortClientName(fullName) {
    const parts = clean(fullName).split(/\s+/).filter(Boolean);
    if (!parts.length) return "Client";
    if (parts.length === 1) return parts[0];
    return `${parts[0]} ${parts[parts.length - 1][0]}.`;
  }

  // ======================= CONFLICT ENGINE ===================
  // Returns { blocking, warnings, notices }. Every entry is a sentence a human
  // can act on.
  //   blocking  the save is refused outright
  //   warnings  the save needs an explicit "yes, do it anyway" plus a reason
  //   notices   worth saying, never worth interrupting for
  // The split matters: most staff have no availability on file yet, so
  // treating "nothing to check against" as a warning would put a confirmation
  // dialog in front of literally every session anyone books.
  async function checkConflicts({ id, client_id, staff_id, session_date, start_time, end_time, location_id }) {
    const blocking = [];
    const warnings = [];
    const notices = [];

    const s = toMin(start_time), e = toMin(end_time);
    if (s == null || e == null) {
      blocking.push({ code: "bad_time", message: "The start and end times need to be real times." });
      return { blocking, warnings, notices };
    }
    if (e <= s) {
      blocking.push({ code: "backwards", message: "The session ends before it starts. Check the end time." });
      return { blocking, warnings, notices };
    }
    if (e - s < 15) {
      warnings.push({ code: "very_short", message: `This session is only ${e - s} minutes long. Is that right?` });
    }
    if (e - s > 12 * 60) {
      warnings.push({ code: "very_long", message: `This session is ${((e - s) / 60).toFixed(1)} hours long. Is that right?` });
    }

    const date = dateOnly(session_date);
    const excludeId = id ? Number(id) : 0;

    // --- staff double-booking ---
    if (staff_id) {
      const rows = await dbAll(
        `SELECT ss.*, c.child_name FROM sched_sessions ss
           LEFT JOIN clients c ON c.id = ss.client_id
          WHERE ss.staff_id = ? AND ss.session_date = ? AND ss.id <> ?
            AND ss.status NOT IN ('cancelled','no_show','staff_call_out')`,
        [staff_id, date, excludeId]
      );
      const staff = await dbGet("SELECT name FROM hr_employees WHERE id = ?", [staff_id]);
      const staffFirst = clean(staff && staff.name).split(/\s+/)[0] || "This staff member";
      for (const r of rows) {
        if (overlaps(s, e, toMin(r.start_time), toMin(r.end_time))) {
          blocking.push({
            code: "staff_double_booked",
            message: `${staffFirst} is already scheduled with ${shortClientName(r.child_name)} from ${fmtTime(r.start_time)} to ${fmtTime(r.end_time)}.`,
            session_id: r.id,
          });
        }
      }

      // --- time off ---
      const off = await dbAll(
        `SELECT * FROM staff_time_off
          WHERE employee_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ?`,
        [staff_id, date, date]
      );
      for (const o of off) {
        const clash = o.all_day !== false || overlaps(s, e, toMin(o.start_time) || 0, toMin(o.end_time) || 1440);
        if (clash) {
          blocking.push({
            code: "time_off",
            message: `${staffFirst} has approved ${o.kind === "pto" ? "PTO" : o.kind} on ${date}${o.all_day === false ? ` from ${fmtTime(o.start_time)} to ${fmtTime(o.end_time)}` : ""}.`,
          });
        }
      }

      // --- declared availability ---
      const avail = await dbAll(
        "SELECT * FROM staff_availability WHERE employee_id = ? AND day_of_week = ?",
        [staff_id, dowOf(date)]
      );
      if (avail.length) {
        const covered = avail.some((a) => toMin(a.start_time) <= s && toMin(a.end_time) >= e);
        if (!covered) {
          const windows = avail.map((a) => `${fmtTime(a.start_time)}–${fmtTime(a.end_time)}`).join(", ");
          warnings.push({
            code: "outside_availability",
            message: `${staffFirst} is only available ${DAY_NAMES[dowOf(date)]} ${windows}. This session falls outside that.`,
          });
        }
      } else {
        notices.push({
          code: "no_availability_on_file",
          message: `No availability is on file for ${staffFirst} yet, so this session couldn't be checked against it.`,
        });
      }
    } else {
      notices.push({ code: "unassigned", message: "No staff member is assigned yet, so this will be saved as needing coverage." });
    }

    // --- client double-booking ---
    if (client_id) {
      const rows = await dbAll(
        `SELECT ss.*, e.name AS staff_name FROM sched_sessions ss
           LEFT JOIN hr_employees e ON e.id = ss.staff_id
          WHERE ss.client_id = ? AND ss.session_date = ? AND ss.id <> ?
            AND ss.status NOT IN ('cancelled','no_show','staff_call_out')`,
        [client_id, date, excludeId]
      );
      const client = await dbGet("SELECT child_name FROM clients WHERE id = ?", [client_id]);
      const who = shortClientName(client && client.child_name);
      for (const r of rows) {
        if (overlaps(s, e, toMin(r.start_time), toMin(r.end_time))) {
          blocking.push({
            code: "client_double_booked",
            message: `${who} is already scheduled with ${clean(r.staff_name) || "another staff member"} from ${fmtTime(r.start_time)} to ${fmtTime(r.end_time)}.`,
            session_id: r.id,
          });
        }
      }

      // --- client availability ---
      const cav = await dbAll(
        "SELECT * FROM client_availability WHERE client_id = ? AND day_of_week = ?",
        [client_id, dowOf(date)]
      );
      if (cav.length) {
        const covered = cav.some((a) => toMin(a.start_time) <= s && toMin(a.end_time) >= e);
        if (!covered) {
          const windows = cav.map((a) => `${fmtTime(a.start_time)}–${fmtTime(a.end_time)}`).join(", ");
          warnings.push({
            code: "outside_client_availability",
            message: `${who} is available ${DAY_NAMES[dowOf(date)]} ${windows}. This session falls outside that.`,
          });
        }
      }

      // --- authorization window ---
      // Authorizations are still three columns on the client until the Rethink
      // import lands, so this checks the dates it can actually see and says so
      // rather than implying a units check it cannot yet perform.
      const auth = await dbGet(
        "SELECT authorization_status, auth_start_date, auth_expiration_date FROM clients WHERE id = ?",
        [client_id]
      );
      if (auth && clean(auth.authorization_status) !== "Not Required") {
        if (auth.auth_expiration_date && dateOnly(auth.auth_expiration_date) < date) {
          blocking.push({
            code: "auth_expired",
            message: `${who}'s authorization expired on ${dateOnly(auth.auth_expiration_date)}. This session is after that date.`,
          });
        } else if (auth.auth_start_date && dateOnly(auth.auth_start_date) > date) {
          blocking.push({
            code: "auth_not_started",
            message: `${who}'s authorization does not start until ${dateOnly(auth.auth_start_date)}.`,
          });
        } else if (!auth.auth_expiration_date) {
          notices.push({
            code: "no_auth_dates",
            message: `No authorization dates are on file for ${who}, so the authorization couldn't be checked.`,
          });
        }
      }
    }

    // --- travel feasibility ---
    // Back-to-back sessions at different locations with no gap. Not blocking:
    // two clinic rooms are a different problem from a cross-town drive, and the
    // system does not know the difference yet.
    if (staff_id && location_id) {
      const adjacent = await dbAll(
        `SELECT ss.*, l.name AS location_name FROM sched_sessions ss
           LEFT JOIN sched_locations l ON l.id = ss.location_id
          WHERE ss.staff_id = ? AND ss.session_date = ? AND ss.id <> ?
            AND ss.location_id IS NOT NULL AND ss.location_id <> ?
            AND ss.status NOT IN ('cancelled','no_show','staff_call_out')`,
        [staff_id, date, excludeId, location_id]
      );
      const here = await dbGet("SELECT name FROM sched_locations WHERE id = ?", [location_id]);
      for (const r of adjacent) {
        const gapBefore = s - toMin(r.end_time);
        const gapAfter = toMin(r.start_time) - e;
        const gap = gapBefore >= 0 ? gapBefore : (gapAfter >= 0 ? gapAfter : null);
        if (gap != null && gap < 30) {
          warnings.push({
            code: "travel",
            message: `Only ${gap} minute${gap === 1 ? "" : "s"} between this session at ${clean(here && here.name)} and their session at ${clean(r.location_name)}.`,
          });
        }
      }
    }

    return { blocking, warnings, notices };
  }

  // ======================= AUDIT =============================
  async function audit(sessionId, seriesId, action, field, oldValue, newValue, reason, actor) {
    await dbRun(
      `INSERT INTO sched_audit (session_id, series_id, action, field, old_value, new_value, reason, actor, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [sessionId || null, seriesId || null, action, field || null,
       oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue),
       reason || null, actor || null, nowISO()]
    );
  }

  // ======================= SESSION SHAPING ===================
  const SESSION_SELECT = `
    SELECT ss.*,
           c.child_name,
           c.transportation_services,
           e.name AS staff_name,
           sup.name AS supervisor_name,
           l.name AS location_name, l.kind AS location_kind, l.color AS location_color
      FROM sched_sessions ss
      LEFT JOIN clients c ON c.id = ss.client_id
      LEFT JOIN hr_employees e ON e.id = ss.staff_id
      LEFT JOIN hr_employees sup ON sup.id = ss.supervisor_id
      LEFT JOIN sched_locations l ON l.id = ss.location_id`;

  function shape(r) {
    return {
      ...r,
      client_display: shortClientName(r.child_name),
      staff_display: clean(r.staff_name) || "Unassigned",
      hours: hoursBetween(r.start_time, r.end_time),
      start_label: fmtTime(r.start_time),
      end_label: fmtTime(r.end_time),
      status_label: STATUS_LABEL[r.status] || r.status,
      occurred: !NON_OCCURRING.includes(r.status),
    };
  }

  // A session that has ended and actually happened needs a note. This is the
  // hook the documentation module will grow out of; for now it flips the note
  // state so the Day board and the missing-note count are real.
  async function sweepEndedSessions() {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    // Anything before today, plus today's sessions whose end time has passed.
    const rows = await dbAll(
      `SELECT * FROM sched_sessions
        WHERE status IN ('scheduled','checked_in','in_progress')
          AND (session_date < ? OR (session_date = ? AND end_time <= ?))`,
      [date, date, fromMin(Math.max(0, nowMin))]
    );
    let touched = 0;
    for (const r of rows) {
      await dbRun(
        `UPDATE sched_sessions SET status = 'completed', completed_at = COALESCE(completed_at, ?),
           note_status = CASE WHEN note_status = 'not_required' THEN 'required' ELSE note_status END,
           updated_at = ? WHERE id = ?`,
        [nowISO(), nowISO(), r.id]
      );
      await audit(r.id, r.series_id, "auto_complete", "status", r.status, "completed",
        "Session end time passed", "system");
      touched++;
    }
    return { completed: touched };
  }

  // ======================= SERIES ============================
  // Materialise dated sessions for a series across a window. Called on create
  // and again by the rolling window sweep, so an open-ended weekly schedule
  // keeps producing sessions without anyone re-entering it.
  const MATERIALISE_WEEKS = 16;

  async function materialiseSeries(series, { from, to, actor }) {
    const days = JSON.parse(series.days_of_week || "[]").map(Number);
    const start = from > series.starts_on ? from : series.starts_on;
    const hardEnd = series.ends_on && series.ends_on < to ? series.ends_on : to;
    const created = [];
    if (!days.length || start > hardEnd) return created;

    for (let d = start; d <= hardEnd; d = addDays(d, 1)) {
      if (!days.includes(dowOf(d))) continue;
      const existing = await dbGet(
        "SELECT id FROM sched_sessions WHERE series_id = ? AND session_date = ?",
        [series.id, d]
      );
      if (existing) continue;
      const row = await dbGet(
        `INSERT INTO sched_sessions
           (series_id, client_id, staff_id, supervisor_id, location_id, service_code, service_label,
            session_date, start_time, end_time, status, note_status, billing_status,
            authorization_id, admin_notes, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        [series.id, series.client_id, series.staff_id, series.supervisor_id, series.location_id,
         series.service_code, series.service_label, d, series.start_time, series.end_time,
         series.staff_id ? "scheduled" : "needs_coverage", "not_required", "not_ready",
         series.authorization_id, series.notes, actor, nowISO(), nowISO()]
      );
      created.push(row.id);
    }
    return created;
  }

  async function extendOpenSeries(actor = "system") {
    const to = addDays(today(), MATERIALISE_WEEKS * 7);
    const rows = await dbAll(
      "SELECT * FROM sched_series WHERE status = 'active' AND (ends_on IS NULL OR ends_on >= ?)",
      [today()]
    );
    let n = 0;
    for (const s of rows) n += (await materialiseSeries(s, { from: today(), to, actor })).length;
    return { created: n };
  }

  // ======================= LEGACY MIGRATION ==================
  // The old weekly pattern is read once and turned into real dated sessions so
  // nothing anyone set up is thrown away. Staff are matched from the legacy
  // `therapists` rows to real hr_employees rows by name; a therapist with no
  // matching staff record produces an unassigned session that shows up as
  // needing coverage rather than being silently dropped.
  async function migrateLegacySchedule(actor) {
    const done = await dbGet("SELECT value FROM sched_meta WHERE key = 'legacy_migrated'");
    if (done && done.value) return { already: true, at: done.value };

    let legacy = [];
    try {
      legacy = await dbAll(
        `SELECT ss.*, t.name AS therapist_name FROM schedule_sessions ss
           LEFT JOIN therapists t ON t.id = ss.therapist_id`
      );
    } catch (e) {
      legacy = [];
    }

    const result = { series: 0, sessions: 0, unmatched_staff: [], skipped: [] };
    const from = today();
    const to = addDays(from, MATERIALISE_WEEKS * 7);
    const clinic = await dbGet("SELECT id FROM sched_locations WHERE kind = 'clinic' ORDER BY id LIMIT 1");

    for (const row of legacy) {
      const client = await dbGet("SELECT id, child_name FROM clients WHERE id = ?", [row.client_id]);
      if (!client) { result.skipped.push({ reason: "client no longer exists", client_id: row.client_id }); continue; }

      let staffId = null;
      if (clean(row.therapist_name)) {
        const match = await dbGet("SELECT id FROM hr_employees WHERE LOWER(name) = LOWER(?)", [row.therapist_name]);
        if (match) staffId = match.id;
        else if (!result.unmatched_staff.includes(row.therapist_name)) result.unmatched_staff.push(row.therapist_name);
      }

      const series = await dbGet(
        `INSERT INTO sched_series
           (client_id, staff_id, location_id, service_label, days_of_week, start_time, end_time,
            starts_on, status, notes, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?, 'active', ?, ?, ?, ?) RETURNING *`,
        [client.id, staffId, clinic ? clinic.id : null, row.session_type || "ABA Therapy",
         JSON.stringify([Number(row.day_of_week)]), row.start_time, row.end_time, from,
         "Converted from the previous weekly schedule.", actor, nowISO(), nowISO()]
      );
      result.series++;
      result.sessions += (await materialiseSeries(series, { from, to, actor })).length;
    }

    await dbRun(
      `INSERT INTO sched_meta (key, value, updated_at) VALUES ('legacy_migrated', ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [nowISO(), nowISO()]
    );
    return result;
  }

  // Seed hour-precise availability from the coarse morning/afternoon/evening
  // form answers already on file. These are a starting point to be corrected,
  // not a claim of precision -- the source only has three buckets.
  const BLOCK_WINDOWS = { morning: ["08:00", "12:00"], afternoon: ["12:00", "17:00"], evening: ["17:00", "20:00"] };

  async function seedStaffAvailability(actor) {
    const emps = await dbAll("SELECT id, name, hr_availability FROM hr_employees WHERE hr_availability IS NOT NULL");
    let seeded = 0;
    for (const e of emps) {
      const existing = await dbGet("SELECT COUNT(*) AS n FROM staff_availability WHERE employee_id = ?", [e.id]);
      if (Number(existing.n) > 0) continue;
      let av = null;
      try { av = JSON.parse(e.hr_availability); } catch (err) { av = null; }
      if (!av) continue;
      for (const [dayName, blocks] of Object.entries(av)) {
        const dow = DAY_NAMES.indexOf(dayName);
        if (dow < 0 || !blocks) continue;
        // Merge adjacent blocks into one window rather than three fragments.
        const on = Object.keys(BLOCK_WINDOWS).filter((b) => blocks[b]);
        if (!on.length) continue;
        const starts = on.map((b) => toMin(BLOCK_WINDOWS[b][0]));
        const ends = on.map((b) => toMin(BLOCK_WINDOWS[b][1]));
        await dbRun(
          `INSERT INTO staff_availability (employee_id, day_of_week, start_time, end_time, source, note, created_at, updated_at)
           VALUES (?,?,?,?, 'seeded_from_form', ?, ?, ?)`,
          [e.id, dow, fromMin(Math.min(...starts)), fromMin(Math.max(...ends)),
           "Estimated from the morning/afternoon/evening answers on their availability form — please confirm.",
           nowISO(), nowISO()]
        );
        seeded++;
      }
    }
    return { seeded };
  }

  // ======================= DAY BOARD =========================
  async function dayBoard(date) {
    const rows = (await dbAll(`${SESSION_SELECT} WHERE ss.session_date = ? ORDER BY ss.start_time, c.child_name`, [date])).map(shape);
    const nowMin = (() => {
      const n = new Date();
      return n.toISOString().slice(0, 10) === date ? n.getUTCHours() * 60 + n.getUTCMinutes() : null;
    })();

    const inProgress = rows.filter((r) => ["checked_in", "in_progress"].includes(r.status));
    const upNext = rows
      .filter((r) => r.status === "scheduled" && (nowMin == null || toMin(r.start_time) >= nowMin))
      .slice(0, 6);

    return {
      date,
      sessions: rows,
      metrics: {
        sessions_today: rows.length,
        clients_today: new Set(rows.filter((r) => r.occurred).map((r) => r.client_id)).size,
        staff_today: new Set(rows.filter((r) => r.occurred && r.staff_id).map((r) => r.staff_id)).size,
        in_progress: inProgress.length,
        completed: rows.filter((r) => r.status === "completed").length,
        cancellations: rows.filter((r) => r.status === "cancelled").length,
        no_shows: rows.filter((r) => r.status === "no_show").length,
        call_outs: rows.filter((r) => r.status === "staff_call_out").length,
        needs_coverage: rows.filter((r) => r.status === "needs_coverage" || !r.staff_id).length,
        notes_missing: rows.filter((r) => r.status === "completed" && ["required", "draft"].includes(r.note_status)).length,
        billing_ready: rows.filter((r) => r.billing_status === "ready").length,
      },
      in_progress: inProgress,
      up_next: upNext,
    };
  }

  // ======================= API ===============================
  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/sched/")) return false;
    if (!user) { json(res, 401, { error: "Please sign in." }); return true; }

    try {
      const actor = user.email || `user:${user.id}`;
      const mineOnly = !canViewAll(user);
      const myEmployeeId = mineOnly ? await ownEmployeeId(user) : null;
      if (mineOnly && !myEmployeeId) {
        // No staff record to scope to, and no permission to see everyone.
        json(res, 403, { error: "Your account isn't linked to a staff record, so there's no schedule to show. Ask an admin to add your work email to your staff card." });
        return true;
      }

      // ---------------- reference data ----------------
      if (pathname === "/api/sched/bootstrap" && method === "GET") {
        const locations = await dbAll("SELECT * FROM sched_locations WHERE active IS NOT FALSE ORDER BY sort_order NULLS LAST, name");
        const staff = canViewAll(user)
          ? await dbAll("SELECT id, name, email, role_title, (hr_photo IS NOT NULL) AS has_photo FROM hr_employees WHERE status IN ('active','onboarding') ORDER BY name")
          : await dbAll("SELECT id, name, email, role_title, (hr_photo IS NOT NULL) AS has_photo FROM hr_employees WHERE id = ?", [myEmployeeId]);
        const clients = canAccessClients(user)
          ? await dbAll("SELECT id, child_name, auth_start_date, auth_expiration_date, authorization_status, transportation_services FROM clients ORDER BY child_name")
          : [];
        json(res, 200, {
          locations, staff,
          clients: clients.map((c) => ({ ...c, display: shortClientName(c.child_name) })),
          statuses: SESSION_STATUSES.map((s) => ({ key: s, label: STATUS_LABEL[s] })),
          note_statuses: NOTE_STATUSES,
          cancelled_by: CANCELLED_BY,
          location_kinds: LOCATION_KINDS,
          me: {
            employee_id: myEmployeeId || (await ownEmployeeId(user)),
            can_schedule: canSchedule(user),
            can_view_all: canViewAll(user),
            is_admin: isAdmin(user),
          },
        });
        return true;
      }

      // ---------------- sessions ----------------
      if (pathname === "/api/sched/sessions" && method === "GET") {
        const from = dateOnly(query.from) || today();
        const to = dateOnly(query.to) || addDays(from, 6);
        const where = ["ss.session_date BETWEEN ? AND ?"];
        const params = [from, to];
        if (mineOnly) { where.push("ss.staff_id = ?"); params.push(myEmployeeId); }
        else if (query.staff_id) { where.push("ss.staff_id = ?"); params.push(Number(query.staff_id)); }
        if (query.client_id) { where.push("ss.client_id = ?"); params.push(Number(query.client_id)); }
        if (query.location_id) { where.push("ss.location_id = ?"); params.push(Number(query.location_id)); }
        if (query.status) {
          const list = String(query.status).split(",").map(clean).filter(Boolean);
          if (list.length) { where.push(`ss.status IN (${list.map(() => "?").join(",")})`); params.push(...list); }
        }
        if (query.needs_note === "1") where.push("ss.status = 'completed' AND ss.note_status IN ('required','draft')");
        const rows = await dbAll(
          `${SESSION_SELECT} WHERE ${where.join(" AND ")} ORDER BY ss.session_date, ss.start_time`, params
        );
        json(res, 200, { sessions: rows.map(shape), from, to, scoped_to_me: mineOnly });
        return true;
      }

      if (pathname === "/api/sched/day-board" && method === "GET") {
        if (mineOnly) { json(res, 403, { error: "Not permitted" }); return true; }
        json(res, 200, await dayBoard(dateOnly(query.date) || today()));
        return true;
      }

      if (pathname === "/api/sched/check-conflicts" && method === "POST") {
        if (!canSchedule(user)) { json(res, 403, { error: "Not permitted to schedule" }); return true; }
        const b = await readBody(req);
        json(res, 200, await checkConflicts({
          id: b.id, client_id: num(b.client_id), staff_id: num(b.staff_id),
          session_date: b.session_date, start_time: b.start_time, end_time: b.end_time,
          location_id: num(b.location_id),
        }));
        return true;
      }

      if (pathname === "/api/sched/sessions" && method === "POST") {
        if (!canSchedule(user)) { json(res, 403, { error: "Not permitted to schedule" }); return true; }
        const b = await readBody(req);
        const clientId = num(b.client_id);
        if (!clientId) { json(res, 400, { error: "Choose a client." }); return true; }
        if (!clean(b.session_date) && !clean(b.starts_on)) { json(res, 400, { error: "Choose a date." }); return true; }
        if (!clean(b.start_time) || !clean(b.end_time)) { json(res, 400, { error: "Choose a start and end time." }); return true; }

        const recurring = !!(b.recurring && Array.isArray(b.days_of_week) && b.days_of_week.length);
        const firstDate = dateOnly(recurring ? b.starts_on || b.session_date : b.session_date);

        // Preflight the first occurrence so the user sees the problem before
        // a whole series lands on the calendar.
        const conflicts = await checkConflicts({
          client_id: clientId, staff_id: num(b.staff_id), session_date: firstDate,
          start_time: b.start_time, end_time: b.end_time, location_id: num(b.location_id),
        });
        if (conflicts.blocking.length) { json(res, 409, { error: "conflict", ...conflicts }); return true; }
        if (conflicts.warnings.length && !b.accept_warnings) {
          json(res, 409, { error: "warnings", ...conflicts });
          return true;
        }

        if (recurring) {
          const series = await dbGet(
            `INSERT INTO sched_series
               (client_id, staff_id, supervisor_id, location_id, service_code, service_label,
                days_of_week, start_time, end_time, starts_on, ends_on, authorization_id, notes,
                status, created_by, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'active', ?, ?, ?) RETURNING *`,
            [clientId, num(b.staff_id), num(b.supervisor_id), num(b.location_id),
             clean(b.service_code) || null, clean(b.service_label) || null,
             JSON.stringify(b.days_of_week.map(Number)), b.start_time, b.end_time,
             firstDate, dateOnly(b.ends_on) || null, num(b.authorization_id),
             clean(b.admin_notes) || null, actor, nowISO(), nowISO()]
          );
          const horizon = dateOnly(b.ends_on) || addDays(today(), MATERIALISE_WEEKS * 7);
          const ids = await materialiseSeries(series, { from: firstDate, to: horizon, actor });
          await audit(null, series.id, "series_created", null, null,
            `${b.days_of_week.length} day(s)/week ${b.start_time}–${b.end_time} from ${firstDate}`,
            conflicts.warnings.length ? clean(b.override_reason) || "Warnings accepted" : null, actor);
          json(res, 201, { ok: true, series_id: series.id, created: ids.length, warnings: conflicts.warnings });
          return true;
        }

        const row = await dbGet(
          `INSERT INTO sched_sessions
             (client_id, staff_id, supervisor_id, location_id, service_code, service_label,
              session_date, start_time, end_time, status, note_status, billing_status,
              authorization_id, admin_notes, override_reason, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?, 'not_required', 'not_ready', ?,?,?,?,?,?) RETURNING *`,
          [clientId, num(b.staff_id), num(b.supervisor_id), num(b.location_id),
           clean(b.service_code) || null, clean(b.service_label) || null,
           firstDate, b.start_time, b.end_time, num(b.staff_id) ? "scheduled" : "needs_coverage",
           num(b.authorization_id), clean(b.admin_notes) || null,
           conflicts.warnings.length ? clean(b.override_reason) || "Warnings accepted" : null,
           actor, nowISO(), nowISO()]
        );
        await audit(row.id, null, "created", null, null,
          `${firstDate} ${b.start_time}–${b.end_time}`,
          conflicts.warnings.length ? clean(b.override_reason) || "Warnings accepted" : null, actor);
        json(res, 201, { ok: true, session: shape(await dbGet(`${SESSION_SELECT} WHERE ss.id = ?`, [row.id])), warnings: conflicts.warnings });
        return true;
      }

      const sessionMatch = pathname.match(/^\/api\/sched\/sessions\/(\d+)$/);
      if (sessionMatch && method === "GET") {
        const row = await dbGet(`${SESSION_SELECT} WHERE ss.id = ?`, [Number(sessionMatch[1])]);
        if (!row) { json(res, 404, { error: "That session no longer exists." }); return true; }
        if (mineOnly && row.staff_id !== myEmployeeId) { json(res, 403, { error: "Not permitted" }); return true; }
        const history = await dbAll("SELECT * FROM sched_audit WHERE session_id = ? ORDER BY id DESC", [row.id]);
        json(res, 200, { session: shape(row), history: canViewAll(user) ? history : [] });
        return true;
      }

      if (sessionMatch && method === "PATCH") {
        const id = Number(sessionMatch[1]);
        const before = await dbGet("SELECT * FROM sched_sessions WHERE id = ?", [id]);
        if (!before) { json(res, 404, { error: "That session no longer exists." }); return true; }
        const b = await readBody(req);

        // A technician may only move their own session forward through the
        // states they are responsible for. They cannot move a session in time,
        // reassign it, or touch anyone else's.
        const statusOnly = !canSchedule(user);
        if (statusOnly) {
          if (before.staff_id !== myEmployeeId) { json(res, 403, { error: "Not permitted" }); return true; }
          const allowed = ["checked_in", "in_progress", "completed"];
          if (!allowed.includes(clean(b.status))) { json(res, 403, { error: "You can check in, start, or complete your own session." }); return true; }
        }

        const scope = ["this", "future", "series"].includes(clean(b.scope)) ? clean(b.scope) : "this";
        const fields = ["staff_id", "supervisor_id", "location_id", "service_code", "service_label",
                        "session_date", "start_time", "end_time", "admin_notes", "authorization_id"];
        const changing = fields.filter((f) => f in b);

        if (!statusOnly && (changing.includes("session_date") || changing.includes("start_time") ||
            changing.includes("end_time") || changing.includes("staff_id"))) {
          const conflicts = await checkConflicts({
            id,
            client_id: before.client_id,
            staff_id: "staff_id" in b ? num(b.staff_id) : before.staff_id,
            session_date: "session_date" in b ? dateOnly(b.session_date) : before.session_date,
            start_time: "start_time" in b ? b.start_time : before.start_time,
            end_time: "end_time" in b ? b.end_time : before.end_time,
            location_id: "location_id" in b ? num(b.location_id) : before.location_id,
          });
          if (conflicts.blocking.length) { json(res, 409, { error: "conflict", ...conflicts }); return true; }
          if (conflicts.warnings.length && !b.accept_warnings) { json(res, 409, { error: "warnings", ...conflicts }); return true; }
        }

        // Built as pairs so the series pass below can drop one assignment
        // without the SET list and the parameter list drifting apart.
        const pairs = [];
        for (const f of changing) {
          let v = b[f];
          if (["staff_id", "supervisor_id", "location_id", "authorization_id"].includes(f)) v = num(v);
          else if (f === "session_date") v = dateOnly(v);
          else v = clean(v) || null;
          pairs.push({ sql: `${f} = ?`, param: v, field: f });
        }
        if ("status" in b) {
          const st = clean(b.status);
          if (!SESSION_STATUSES.includes(st)) { json(res, 400, { error: "Unknown session status." }); return true; }
          pairs.push({ sql: "status = ?", param: st, field: "status" });
          if (st === "checked_in") pairs.push({ sql: "checked_in_at = ?", param: nowISO(), field: "checked_in_at" });
          if (st === "completed") {
            pairs.push({ sql: "completed_at = ?", param: nowISO(), field: "completed_at" });
            // A completed session needs documentation. This is the handoff
            // point to the documentation module. No parameter: the CASE keeps
            // an already-drafted note from being reset to "required".
            pairs.push({ sql: "note_status = CASE WHEN note_status = 'not_required' THEN 'required' ELSE note_status END", field: "note_status_auto" });
          }
        }
        if ("note_status" in b) {
          const ns = clean(b.note_status);
          if (!NOTE_STATUSES.includes(ns)) { json(res, 400, { error: "Unknown note status." }); return true; }
          pairs.push({ sql: "note_status = ?", param: ns, field: "note_status" });
        }
        if (!pairs.length) { json(res, 400, { error: "Nothing to update." }); return true; }

        // Reassignment keeps the trail of who it was taken from.
        if ("staff_id" in b && num(b.staff_id) !== before.staff_id) {
          pairs.push({ sql: "previous_staff_id = ?", param: before.staff_id, field: "previous_staff_id" });
        }
        if (b.accept_warnings && clean(b.override_reason)) {
          pairs.push({ sql: "override_reason = ?", param: clean(b.override_reason), field: "override_reason" });
        }
        pairs.push({ sql: "updated_at = ?", param: nowISO(), field: "updated_at" });

        // Which rows the edit reaches. Past sessions are never rewritten:
        // they are clinical and billing records, not calendar decoration.
        let targetIds = [id];
        if (scope !== "this" && before.series_id) {
          // "series" reaches every upcoming occurrence; "future" reaches this
          // one onward. Both stop at sessions that are still scheduled -- a
          // completed, cancelled or no-show session is history.
          const rows = await dbAll(
            `SELECT id FROM sched_sessions
              WHERE series_id = ? AND session_date >= ? AND status IN ('scheduled','needs_coverage')`,
            [before.series_id, scope === "series" ? today() : before.session_date]
          );
          targetIds = [...new Set([id, ...rows.map((r) => r.id)])];
        }

        for (const tid of targetIds) {
          // A date change only makes sense for the one session being dragged.
          // Applying it across a series would collapse every occurrence onto a
          // single day, which is why the other rows get the same edit minus
          // session_date.
          const applicable = tid === id ? pairs : pairs.filter((p) => p.field !== "session_date");
          if (!applicable.length) continue;
          const sql = applicable.map((p) => p.sql).join(", ");
          const args = applicable.filter((p) => "param" in p).map((p) => p.param);
          await dbRun(`UPDATE sched_sessions SET ${sql} WHERE id = ?`, [...args, tid]);
        }

        for (const f of [...changing, ...("status" in b ? ["status"] : []), ...("note_status" in b ? ["note_status"] : [])]) {
          const oldV = before[f];
          const newV = f in b ? b[f] : null;
          if (String(oldV || "") !== String(newV || "")) {
            await audit(id, before.series_id, scope === "this" ? "updated" : `updated_${scope}`, f, oldV, newV, clean(b.reason) || clean(b.override_reason) || null, actor);
          }
        }

        json(res, 200, {
          ok: true,
          session: shape(await dbGet(`${SESSION_SELECT} WHERE ss.id = ?`, [id])),
          affected: targetIds.length,
        });
        return true;
      }

      // Cancellation is its own route because it demands who and why. A
      // cancelled session is never billable and never becomes one.
      const cancelMatch = pathname.match(/^\/api\/sched\/sessions\/(\d+)\/cancel$/);
      if (cancelMatch && method === "POST") {
        if (!canSchedule(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        const id = Number(cancelMatch[1]);
        const before = await dbGet("SELECT * FROM sched_sessions WHERE id = ?", [id]);
        if (!before) { json(res, 404, { error: "That session no longer exists." }); return true; }
        const b = await readBody(req);
        const by = clean(b.cancelled_by);
        if (!CANCELLED_BY.includes(by)) { json(res, 400, { error: "Say who cancelled: the family, the staff member, Spectrum Squad, or other." }); return true; }
        if (!clean(b.reason)) { json(res, 400, { error: "A cancellation reason is required." }); return true; }

        // A staff call-out leaves the session needing coverage rather than
        // cancelling the client's service outright.
        const asCallOut = !!b.staff_call_out;
        const newStatus = asCallOut ? "needs_coverage" : (b.no_show ? "no_show" : "cancelled");

        await dbRun(
          `UPDATE sched_sessions SET status = ?, cancelled_at = ?, cancelled_by = ?, cancellation_reason = ?,
             cancellation_notes = ?, billing_status = 'not_ready',
             billing_hold_reason = 'Session did not occur', updated_at = ?,
             previous_staff_id = CASE WHEN ? THEN staff_id ELSE previous_staff_id END,
             staff_id = CASE WHEN ? THEN NULL ELSE staff_id END
           WHERE id = ?`,
          [newStatus, nowISO(), by, clean(b.reason), clean(b.notes) || null, nowISO(), asCallOut, asCallOut, id]
        );
        await audit(id, before.series_id, asCallOut ? "call_out" : "cancelled", "status", before.status, newStatus, `${by}: ${clean(b.reason)}`, actor);
        json(res, 200, { ok: true, session: shape(await dbGet(`${SESSION_SELECT} WHERE ss.id = ?`, [id])) });
        return true;
      }

      if (sessionMatch && method === "DELETE") {
        if (!canSchedule(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        const id = Number(sessionMatch[1]);
        const before = await dbGet("SELECT * FROM sched_sessions WHERE id = ?", [id]);
        if (!before) { json(res, 404, { error: "That session no longer exists." }); return true; }
        // A session that happened is a record. Cancel it, do not erase it.
        if (["completed", "checked_in", "in_progress"].includes(before.status)) {
          json(res, 409, { error: "This session already happened, so it can't be deleted. Cancel it with a reason instead, so the record stays intact." });
          return true;
        }
        await dbRun("DELETE FROM sched_sessions WHERE id = ?", [id]);
        await audit(id, before.series_id, "deleted", null,
          `${before.session_date} ${before.start_time}–${before.end_time}`, null, clean(query.reason) || null, actor);
        json(res, 200, { ok: true });
        return true;
      }

      // ---------------- availability ----------------
      const staffAvailMatch = pathname.match(/^\/api\/sched\/availability\/staff\/(\d+)$/);
      if (staffAvailMatch && method === "GET") {
        const empId = Number(staffAvailMatch[1]);
        if (mineOnly && empId !== myEmployeeId) { json(res, 403, { error: "Not permitted" }); return true; }
        const windows = await dbAll("SELECT * FROM staff_availability WHERE employee_id = ? ORDER BY day_of_week, start_time", [empId]);
        const timeOff = await dbAll("SELECT * FROM staff_time_off WHERE employee_id = ? AND end_date >= ? ORDER BY start_date", [empId, today()]);
        json(res, 200, { windows, time_off: timeOff, day_names: DAY_NAMES });
        return true;
      }
      if (staffAvailMatch && method === "POST") {
        if (!canSchedule(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        const empId = Number(staffAvailMatch[1]);
        const b = await readBody(req);
        if (!Array.isArray(b.windows)) { json(res, 400, { error: "Send a windows array." }); return true; }
        for (const w of b.windows) {
          if (toMin(w.start_time) == null || toMin(w.end_time) == null || toMin(w.end_time) <= toMin(w.start_time)) {
            json(res, 400, { error: `${DAY_NAMES[Number(w.day_of_week)] || "That day"}'s window needs a start time before its end time.` });
            return true;
          }
        }
        await dbRun("DELETE FROM staff_availability WHERE employee_id = ?", [empId]);
        for (const w of b.windows) {
          await dbRun(
            `INSERT INTO staff_availability (employee_id, day_of_week, start_time, end_time, note, source, created_at, updated_at)
             VALUES (?,?,?,?,?, 'manual', ?, ?)`,
            [empId, Number(w.day_of_week), w.start_time, w.end_time, clean(w.note) || null, nowISO(), nowISO()]
          );
        }
        await audit(null, null, "staff_availability_set", "employee_id", null, String(empId), null, actor);
        json(res, 200, { ok: true, count: b.windows.length });
        return true;
      }

      const clientAvailMatch = pathname.match(/^\/api\/sched\/availability\/client\/(\d+)$/);
      if (clientAvailMatch && (method === "GET" || method === "POST")) {
        if (!canAccessClients(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        const clientId = Number(clientAvailMatch[1]);
        if (method === "GET") {
          json(res, 200, {
            windows: await dbAll("SELECT * FROM client_availability WHERE client_id = ? ORDER BY day_of_week, start_time", [clientId]),
            day_names: DAY_NAMES,
          });
          return true;
        }
        if (!canSchedule(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        const b = await readBody(req);
        if (!Array.isArray(b.windows)) { json(res, 400, { error: "Send a windows array." }); return true; }
        for (const w of b.windows) {
          if (toMin(w.start_time) == null || toMin(w.end_time) == null || toMin(w.end_time) <= toMin(w.start_time)) {
            json(res, 400, { error: `${DAY_NAMES[Number(w.day_of_week)] || "That day"}'s window needs a start time before its end time.` });
            return true;
          }
        }
        await dbRun("DELETE FROM client_availability WHERE client_id = ?", [clientId]);
        for (const w of b.windows) {
          await dbRun(
            `INSERT INTO client_availability (client_id, day_of_week, start_time, end_time, location_pref, note, source, created_at, updated_at)
             VALUES (?,?,?,?,?,?, 'manual', ?, ?)`,
            [clientId, Number(w.day_of_week), w.start_time, w.end_time,
             clean(w.location_pref) || null, clean(w.note) || null, nowISO(), nowISO()]
          );
        }
        await audit(null, null, "client_availability_set", "client_id", null, String(clientId), null, actor);
        json(res, 200, { ok: true, count: b.windows.length });
        return true;
      }

      // Time off, so the conflict engine has something to check against.
      if (pathname === "/api/sched/time-off" && method === "POST") {
        if (!canSchedule(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        const b = await readBody(req);
        if (!num(b.employee_id) || !dateOnly(b.start_date) || !dateOnly(b.end_date)) {
          json(res, 400, { error: "Choose the staff member and the dates." }); return true;
        }
        if (dateOnly(b.end_date) < dateOnly(b.start_date)) { json(res, 400, { error: "The end date is before the start date." }); return true; }
        const row = await dbGet(
          `INSERT INTO staff_time_off (employee_id, start_date, end_date, all_day, start_time, end_time, kind, status, notes, created_by, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
          [num(b.employee_id), dateOnly(b.start_date), dateOnly(b.end_date), b.all_day !== false,
           clean(b.start_time) || null, clean(b.end_time) || null, clean(b.kind) || "pto",
           clean(b.status) || "approved", clean(b.notes) || null, actor, nowISO()]
        );
        // Say plainly what this collides with rather than letting it surprise
        // someone on the day.
        const clashes = await dbAll(
          `SELECT ss.*, c.child_name FROM sched_sessions ss LEFT JOIN clients c ON c.id = ss.client_id
            WHERE ss.staff_id = ? AND ss.session_date BETWEEN ? AND ? AND ss.status IN ('scheduled','needs_coverage')`,
          [num(b.employee_id), dateOnly(b.start_date), dateOnly(b.end_date)]
        );
        json(res, 201, {
          ok: true, time_off: row,
          conflicts: clashes.map((c) => ({
            id: c.id,
            message: `${c.session_date} ${fmtTime(c.start_time)}–${fmtTime(c.end_time)} with ${shortClientName(c.child_name)} still needs covering.`,
          })),
        });
        return true;
      }

      const timeOffMatch = pathname.match(/^\/api\/sched\/time-off\/(\d+)$/);
      if (timeOffMatch && method === "DELETE") {
        if (!canSchedule(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        await dbRun("DELETE FROM staff_time_off WHERE id = ?", [Number(timeOffMatch[1])]);
        json(res, 200, { ok: true });
        return true;
      }

      // ---------------- client schedule summary ----------------
      // Powers the SCHEDULE section on the client card.
      const clientSummaryMatch = pathname.match(/^\/api\/sched\/client\/(\d+)\/summary$/);
      if (clientSummaryMatch && method === "GET") {
        if (!canAccessClients(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        const clientId = Number(clientSummaryMatch[1]);
        const weekStart = dateOnly(query.week_start) || addDays(today(), -dowOf(today()));
        const weekEnd = addDays(weekStart, 6);
        const sessions = (await dbAll(
          `${SESSION_SELECT} WHERE ss.client_id = ? AND ss.session_date BETWEEN ? AND ? ORDER BY ss.session_date, ss.start_time`,
          [clientId, weekStart, weekEnd]
        )).map(shape);
        const scheduled = sessions.filter((s) => s.occurred).reduce((n, s) => n + s.hours, 0);

        // Authorized hours come from the financial form until the Rethink
        // authorization import lands. Reported as null, not zero, when unknown,
        // so the UI can say "not on file" instead of implying nothing is
        // authorised.
        const fs = await dbGet("SELECT authorized_hours_per_week FROM client_financial_forms WHERE client_id = ? ORDER BY id DESC LIMIT 1", [clientId]).catch(() => null);
        const authorized = fs && fs.authorized_hours_per_week != null ? Number(fs.authorized_hours_per_week) : null;
        const client = await dbGet("SELECT child_name, auth_start_date, auth_expiration_date, authorization_status FROM clients WHERE id = ?", [clientId]);

        json(res, 200, {
          client_id: clientId,
          week_start: weekStart,
          week_end: weekEnd,
          sessions,
          today: sessions.filter((s) => s.session_date === today()),
          authorized_hours: authorized,
          scheduled_hours: Math.round(scheduled * 100) / 100,
          unscheduled_hours: authorized == null ? null : Math.round((authorized - scheduled) * 100) / 100,
          authorization: client ? {
            status: client.authorization_status,
            start: client.auth_start_date, expiration: client.auth_expiration_date,
          } : null,
          availability: await dbAll("SELECT * FROM client_availability WHERE client_id = ? ORDER BY day_of_week, start_time", [clientId]),
        });
        return true;
      }

      // ---------------- staff schedule summary ----------------
      const staffSummaryMatch = pathname.match(/^\/api\/sched\/staff\/(\d+)\/summary$/);
      if (staffSummaryMatch && method === "GET") {
        const empId = Number(staffSummaryMatch[1]);
        if (mineOnly && empId !== myEmployeeId) { json(res, 403, { error: "Not permitted" }); return true; }
        const weekStart = dateOnly(query.week_start) || addDays(today(), -dowOf(today()));
        const weekEnd = addDays(weekStart, 6);
        const sessions = (await dbAll(
          `${SESSION_SELECT} WHERE ss.staff_id = ? AND ss.session_date BETWEEN ? AND ? ORDER BY ss.session_date, ss.start_time`,
          [empId, weekStart, weekEnd]
        )).map(shape);
        const scheduled = sessions.filter((s) => s.occurred).reduce((n, s) => n + s.hours, 0);
        const windows = await dbAll("SELECT * FROM staff_availability WHERE employee_id = ? ORDER BY day_of_week, start_time", [empId]);
        const declared = windows.reduce((n, w) => n + hoursBetween(w.start_time, w.end_time), 0);

        json(res, 200, {
          employee_id: empId,
          week_start: weekStart, week_end: weekEnd,
          sessions,
          today: sessions.filter((s) => s.session_date === today()),
          scheduled_hours: Math.round(scheduled * 100) / 100,
          declared_hours: Math.round(declared * 100) / 100,
          open_capacity_hours: Math.round(Math.max(0, declared - scheduled) * 100) / 100,
          availability: windows,
          time_off: await dbAll("SELECT * FROM staff_time_off WHERE employee_id = ? AND end_date >= ? ORDER BY start_date", [empId, today()]),
          notes_missing: sessions.filter((s) => s.status === "completed" && ["required", "draft"].includes(s.note_status)).length,
        });
        return true;
      }

      // ---------------- admin: migration + sweeps ----------------
      if (pathname === "/api/sched/migrate-legacy" && method === "POST") {
        if (!isAdmin(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        const migrated = await migrateLegacySchedule(actor);
        const availability = await seedStaffAvailability(actor);
        json(res, 200, { ...migrated, availability });
        return true;
      }

      if (pathname === "/api/sched/sweep" && method === "POST") {
        if (!isAdmin(user)) { json(res, 403, { error: "Not permitted" }); return true; }
        json(res, 200, { ...(await sweepEndedSessions()), ...(await extendOpenSeries(actor)) });
        return true;
      }

      json(res, 404, { error: "Not found" });
      return true;
    } catch (err) {
      console.error("scheduling.js error on", method, pathname, err);
      json(res, 500, { error: err.message || "Something went wrong." });
      return true;
    }
  }

  return {
    initTables,
    handleApi,
    sweepEndedSessions,
    extendOpenSeries,
    migrateLegacySchedule,
    seedStaffAvailability,
    _lib: { checkConflicts, toMin, fromMin, fmtTime, shortClientName, dowOf, addDays, SESSION_STATUSES, STATUS_LABEL },
  };
};
