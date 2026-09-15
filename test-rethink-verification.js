// Unverified-appointment infractions -- logic tests.
//
// This module decides that a real person committed an infraction that will be
// read out at their quarterly review, so the decisions are tested directly
// rather than left to be discovered in a review meeting. What is covered:
//
//   * the cutoff -- Thursday counts, the Friday it runs on does not
//   * one infraction per session, recorded ONCE no matter how many Fridays
//     the session survives unverified
//   * a session that is later verified is marked resolved, not erased
//   * RBTs and BCBAs land on their own report, and nobody lands on both
//   * an unmatched Rethink provider is reported as unmatched, never guessed
//   * the run refuses to fire at all while the verified filter is unconfirmed
//   * the Friday clock: the right cohort at the right Pacific hour, across a
//     daylight-saving change, with a restart unable to send a second email
//
// Run: node test-rethink-verification.js   (no database, no network, no browser)

"use strict";

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + String(detail).slice(0, 300) : "")); }
};

// ---- stub the transport so no network call is ever attempted --------------
const clientPath = require.resolve("./rethink-client");
const realClient = require("./rethink-client");
const stub = {
  configured: () => true,
  redact: realClient.redact,
  log: () => {},                       // silenced so the suite output stays readable
  snippet: realClient.snippet,
  safeMessage: realClient.safeMessage,
  RethinkError: realClient.RethinkError,
  dwhGetAllPages: async () => ({ rows: [], pages: 1, truncated: false }),
  dwhGet: async () => ({}),
};
require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: stub };

const initVerification = require("./rethink-verification");

// ---- in-memory database --------------------------------------------------
// Only the statements this module actually issues are understood. Anything
// else is pushed onto state.unknown, so an unexpected write shows up in the
// assertions instead of passing silently.
//
// The quarterly aggregate is emulated in JS rather than executed: what that
// costs is coverage of the SQL text, what it buys is that the rollup rule
// itself -- one row per person, still_open, weeks flagged -- is asserted.
function makeDb(seed) {
  const state = {
    runs: [], infractions: [], emails: [], unknown: [],
    employees: seed.employees || [],
    users: seed.users || [],
    settings: seed.settings || {},
    nextRunId: 1, nextInfractionId: 1,
  };
  const has = (sql, s) => sql.replace(/\s+/g, " ").includes(s);

  const run = async (sql, params = []) => {
    const q = sql.replace(/\s+/g, " ").trim();
    if (/^CREATE (TABLE|INDEX)/i.test(q)) return { rowCount: 0 };

    if (has(q, "UPDATE rethink_verification_runs SET run_key = ?, status = 'failed'")) {
      const r = state.runs.find((x) => x.id === params[4]);
      if (r) { r.run_key = params[0]; r.status = "failed"; r.error = params[2]; }
      return { rowCount: r ? 1 : 0 };
    }
    if (has(q, "UPDATE rethink_verification_runs SET status = 'ok'")) {
      const r = state.runs.find((x) => x.id === params[11]);
      if (r) Object.assign(r, {
        status: "ok", finished_at: params[0], window_from: params[1], window_to: params[2],
        appointments_scanned: params[3], unverified_found: params[4], new_infractions: params[5],
        repeat_infractions: params[6], resolved_since_last: params[7], staff_flagged: params[8],
      });
      return { rowCount: r ? 1 : 0 };
    }
    if (has(q, "UPDATE rethink_verification_runs SET emailed_to = ?")) {
      const r = state.runs.find((x) => x.id === params[2]);
      if (r) { r.emailed_to = params[0]; r.email_status = params[1]; }
      return { rowCount: r ? 1 : 0 };
    }
    state.unknown.push(q);
    return { rowCount: 0 };
  };

  const get = async (sql, params = []) => {
    const q = sql.replace(/\s+/g, " ").trim();

    if (has(q, "INSERT INTO rethink_verification_runs")) {
      const key = params[0];
      if (state.runs.some((r) => r.run_key === key)) return undefined;   // ON CONFLICT DO NOTHING
      const row = {
        id: state.nextRunId++, run_key: key, cohort: params[1], run_date: params[2],
        scheduled_at: params[3], started_at: params[4], status: "running", triggered_by: params[5],
      };
      state.runs.push(row);
      return { id: row.id };
    }

    if (has(q, "SELECT id FROM rethink_verification_runs WHERE run_key = ?")) {
      const r = state.runs.find((x) => x.run_key === params[0]);
      return r ? { id: r.id } : undefined;
    }

    if (has(q, "INSERT INTO rethink_verification_infractions")) {
      const [key, cohort, employee_id, rethink_staff_id, staff_name_hint,
             appointment_date, appointment_status, staff_verification, duration_hours,
             quarter, first_run, first_date, first_at, last_run, last_at] = params;
      const existing = state.infractions.find((i) => i.appointment_key === key);
      if (existing) {                                        // ON CONFLICT DO UPDATE
        existing.times_flagged += 1;
        existing.last_seen_run_id = last_run;
        existing.last_seen_at = last_at;
        existing.appointment_status = appointment_status;
        existing.staff_verification = staff_verification;
        existing.resolved_at = null; existing.resolved_run_id = null; existing.resolved_after_days = null;
        return { id: existing.id, times_flagged: existing.times_flagged };
      }
      const row = {
        id: state.nextInfractionId++, appointment_key: key, cohort, employee_id,
        rethink_staff_id, staff_name_hint, appointment_date, appointment_status,
        staff_verification, duration_hours, quarter,
        first_flagged_run_id: first_run, first_flagged_date: first_date, first_flagged_at: first_at,
        last_seen_run_id: last_run, last_seen_at: last_at, times_flagged: 1,
        resolved_at: null, resolved_run_id: null, resolved_after_days: null,
      };
      state.infractions.push(row);
      return { id: row.id, times_flagged: 1 };
    }

    if (has(q, "UPDATE rethink_verification_infractions SET resolved_at = ?")) {
      const [at, runId, runDate, key] = params;
      const row = state.infractions.find((i) => i.appointment_key === key && !i.resolved_at);
      if (!row) return undefined;
      row.resolved_at = at; row.resolved_run_id = runId;
      row.resolved_after_days = Math.max(0,
        Math.round((Date.parse(runDate + "T00:00:00Z") - Date.parse(row.first_flagged_date + "T00:00:00Z")) / 86400000));
      return { id: row.id };
    }

    if (has(q, "SELECT id, name, role_title FROM hr_employees WHERE id = ?")) {
      return state.employees.find((e) => e.id === Number(params[0]));
    }

    state.unknown.push(q);
    return undefined;
  };

  const all = async (sql, params = []) => {
    const q = sql.replace(/\s+/g, " ").trim();

    if (has(q, "FROM hr_employees WHERE COALESCE(status,'active')")) {
      return state.employees.filter((e) => (e.status || "active") !== "terminated");
    }
    if (has(q, "SELECT email, role FROM users WHERE role IN")) {
      return state.users
        .filter((u) => ["owner", "super_admin"].includes(u.role))
        .sort((a, b) =>
          (a.email === "admin@spectrumsquadlv.com" ? 1 : 0) - (b.email === "admin@spectrumsquadlv.com" ? 1 : 0)
          || (a.role === "owner" ? 0 : 1) - (b.role === "owner" ? 0 : 1));
    }
    if (has(q, "FROM rethink_verification_infractions i")) {
      const [from, to, cohort] = params;
      const rows = state.infractions.filter((i) =>
        i.first_flagged_date >= from && i.first_flagged_date <= to && (!cohort || i.cohort === cohort));
      const groups = new Map();
      for (const i of rows) {
        const k = `${i.employee_id}|${i.cohort}`;
        const emp = state.employees.find((e) => e.id === i.employee_id);
        const g = groups.get(k) || {
          employee_id: i.employee_id, cohort: i.cohort,
          name: (emp && emp.name) || i.staff_name_hint, role_title: emp && emp.role_title,
          infractions: 0, still_open: 0, hours: 0,
          oldest_session: i.appointment_date, last_flagged: i.first_flagged_date,
          most_weeks_outstanding: 0, slowest_fix_days: null, _dates: new Set(),
        };
        g.infractions++;
        if (!i.resolved_at) g.still_open++;
        g.hours += Number(i.duration_hours) || 0;
        if (i.appointment_date < g.oldest_session) g.oldest_session = i.appointment_date;
        if (i.first_flagged_date > g.last_flagged) g.last_flagged = i.first_flagged_date;
        g.most_weeks_outstanding = Math.max(g.most_weeks_outstanding, i.times_flagged);
        if (i.resolved_after_days != null) {
          g.slowest_fix_days = Math.max(g.slowest_fix_days == null ? 0 : g.slowest_fix_days, i.resolved_after_days);
        }
        g._dates.add(i.first_flagged_date);
        groups.set(k, g);
      }
      return [...groups.values()]
        .map((g) => ({ ...g, weeks_flagged: g._dates.size }))
        .sort((a, b) => b.infractions - a.infractions || String(a.name).localeCompare(String(b.name)));
    }
    if (has(q, "FROM rethink_verification_infractions WHERE employee_id = ?")) {
      const id = Number(params[0]);
      let rows = state.infractions.filter((i) => i.employee_id === id);
      if (params.length >= 3) rows = rows.filter((i) => i.first_flagged_date >= params[1] && i.first_flagged_date <= params[2]);
      return rows.slice().sort((a, b) => String(b.first_flagged_date).localeCompare(String(a.first_flagged_date)));
    }
    if (has(q, "FROM rethink_verification_runs ORDER BY id DESC")) {
      return state.runs.slice().reverse();
    }

    state.unknown.push(q);
    return [];
  };

  return { state, ctx: {
    dbGet: get, dbAll: all, dbRun: run,
    nowISO: () => seed.now,
    json: () => {},
    sendEmail: async (m) => { state.emails.push(m); return { delivered: "sent" }; },
    getAppSetting: async (k, fb = null) => (k in state.settings ? state.settings[k] : fb),
    isRbt: seed.isRbt,
    getRethinkConfig: async () => seed.config,
    verificationVerdict: seed.verdict,
  } };
}

// Fidelity's "is this person an active RBT" rule, reproduced here only so the
// suite does not need a database to construct fidelity.js. A check at the
// bottom asserts server.js hands the module the real one rather than a copy.
const RBT_TITLE = /\bRBT\b|registered behavior technician|behavior tech|\bBT\b|student|in[- ]training|trainee/i;
const isRbt = (emp) => {
  if (!emp) return false;
  if (String(emp.status || "active") === "terminated") return false;
  return RBT_TITLE.test(String(emp.role_title || ""));
};

// The filter as an admin would have confirmed it on the Rethink panel.
const CONFIRMED = {
  filter_confirmed: true, require_staff_verification: true,
  completed_statuses: ["Completed"], verified_values: ["true", "Verified"],
};
const norm = (v) => (v === true ? "true" : v === false ? "false" : String(v == null ? "" : v).trim().toLowerCase());
const verdict = (row, cfg) => ({
  statusOk: cfg.completed_statuses.map(norm).includes(norm(row.appointmentStatus)),
  verifiedOk: cfg.verified_values.map(norm).includes(norm(row.staffVerification)),
});

const EMPLOYEES = [
  { id: 1, name: "Rosa RBT", role_title: "RBT", rethink_id: "S100", status: "active" },
  { id: 2, name: "Bella BCBA", role_title: "BCBA", rethink_id: "S200", status: "active" },
  { id: 3, name: "Tina Trainee", role_title: "Student Analyst", rethink_id: "S300", status: "active" },
  { id: 4, name: "Olive Office", role_title: "Billing Coordinator", rethink_id: "S400", status: "active" },
];

const seedOpts = (now, extra = {}) => ({
  now, employees: JSON.parse(JSON.stringify(EMPLOYEES)),
  users: [{ email: "owner@spectrumsquadlv.com", role: "owner" }],
  settings: {}, config: CONFIRMED, verdict, isRbt, ...extra,
});

// A Friday, in Pacific terms, at 06:30 local (13:30 UTC during PDT).
const FRIDAY_0630_PT = "2026-09-18T13:30:00.000Z";
const FRIDAY_2000_PT = "2026-09-19T03:00:00.000Z";   // Friday 20:00 PT
process.env.RETHINK_VERIFICATION_REPORT_TO = "";     // exercise the fallback chain

(async () => {
  console.log("\n--- the Pacific clock ---");
  {
    const { ctx } = makeDb(seedOpts(FRIDAY_0630_PT));
    const v = initVerification(ctx);
    const p = v._internal.pacificParts(Date.parse(FRIDAY_0630_PT));
    check("13:30 UTC in September reads as Friday 06:30 Pacific",
      p.weekday === "Fri" && p.date === "2026-09-18" && p.minutes === 6 * 60 + 30, JSON.stringify(p));

    // Standard time, so the same wall clock is a different UTC hour. A fixed
    // offset would put this run an hour out for four months of the year.
    const winter = v._internal.pacificParts(Date.parse("2026-12-18T14:00:00.000Z"));
    check("06:00 Pacific in December is still 06:00 Pacific (daylight saving)",
      winter.weekday === "Fri" && winter.minutes === 6 * 60, JSON.stringify(winter));

    check("the day before a Friday is that Thursday", v._internal.addDays("2026-09-18", -1) === "2026-09-17");
    check("the window start crosses a month boundary correctly",
      v._internal.addDays("2026-09-18", -90) === "2026-06-20", v._internal.addDays("2026-09-18", -90));
    check("19:30 parses to minutes", v._internal.hhmmToMinutes("19:30") === 19 * 60 + 30);
    check("a malformed time is rejected rather than defaulted", v._internal.hhmmToMinutes("25:00") === null);
  }

  console.log("\n--- who lands on which report ---");
  {
    const { ctx } = makeDb(seedOpts(FRIDAY_0630_PT));
    const v = initVerification(ctx);
    const co = v._internal.cohortOf;
    check("an RBT is on the RBT report", co(EMPLOYEES[0]) === "rbt");
    check("a BCBA is on the BCBA report", co(EMPLOYEES[1]) === "bcba");
    check("a student analyst is an RBT, not a BCBA", co(EMPLOYEES[2]) === "rbt");
    check("a terminated employee is on neither report",
      co({ ...EMPLOYEES[0], status: "terminated" }) === null);
    check("a non-clinical employee is on neither report", co(EMPLOYEES[3]) === null);
    check("someone taken off the supervision tracker by hand is not held to the RBT deadline",
      co({ ...EMPLOYEES[0], supervision_required: false }) === null);
    check("nobody is on both reports",
      EMPLOYEES.every((e) => ["rbt", "bcba", null].includes(co(e))));
  }

  console.log("\n--- quarters ---");
  {
    const { ctx } = makeDb(seedOpts(FRIDAY_0630_PT));
    const v = initVerification(ctx);
    check("September is Q3", v._internal.quarterOf("2026-09-18") === "2026-Q3");
    check("October is Q4", v._internal.quarterOf("2026-10-02") === "2026-Q4");
    const w = v._internal.quarterWindow("2026-Q3");
    check("Q3 runs July to September", w && w.from === "2026-07-01" && w.to === "2026-09-30", JSON.stringify(w));
    const q1 = v._internal.quarterWindow("2026-Q1");
    check("Q1 ends on the last day of March", q1 && q1.to === "2026-03-31", JSON.stringify(q1));
    check("a non-quarter is refused, not guessed", v._internal.quarterWindow("2026-Q7") === null);
  }

  console.log("\n--- the RBT run: the cutoff ---");
  {
    const { state, ctx } = makeDb(seedOpts(FRIDAY_0630_PT));
    stub.dwhGetAllPages = async () => ({ rows: [
      // Thursday, unverified -- an infraction
      { appointmentId: "A1", staffId: "S100", appointmentStatus: "Completed", staffVerification: false, actualDurationHours: 2, appointmentDate: "2026-09-17" },
      // Monday, unverified -- an infraction
      { appointmentId: "A2", staffId: "S100", appointmentStatus: "Completed", staffVerification: null, actualDurationHours: 3, appointmentDate: "2026-09-14" },
      // Thursday, verified -- not an infraction
      { appointmentId: "A3", staffId: "S100", appointmentStatus: "Completed", staffVerification: true, actualDurationHours: 4, appointmentDate: "2026-09-17" },
      // TODAY, unverified -- deliberately NOT an infraction on today's run
      { appointmentId: "A4", staffId: "S100", appointmentStatus: "Completed", staffVerification: false, actualDurationHours: 5, appointmentDate: "2026-09-18" },
      // a BCBA's unverified session -- belongs on the 19:30 report, not this one
      { appointmentId: "A5", staffId: "S200", appointmentStatus: "Completed", staffVerification: false, actualDurationHours: 1, appointmentDate: "2026-09-16" },
      // a provider Rethink knows and the CRM does not
      { appointmentId: "A6", staffId: "S999", appointmentStatus: "Completed", staffVerification: false, actualDurationHours: 1, appointmentDate: "2026-09-16" },
      // a non-clinical employee -- on neither report
      { appointmentId: "A7", staffId: "S400", appointmentStatus: "Completed", staffVerification: false, actualDurationHours: 1, appointmentDate: "2026-09-16" },
    ], pages: 1, truncated: false });

    const v = initVerification(ctx);
    const out = await v.runCohort("rbt", { runDate: "2026-09-18", triggeredBy: "test" });

    check("the run reports as ok", out.ok === true, JSON.stringify(out));
    check("the window ends on the day BEFORE the run", out.window_to === "2026-09-17", out.window_to);
    check("two unverified RBT sessions are found", out.unverified_found === 2, out.unverified_found);
    check("a session delivered on the run day is NOT an infraction",
      !state.infractions.some((i) => i.appointment_date === "2026-09-18"));
    check("a verified session is not an infraction",
      !state.infractions.some((i) => i.appointment_key === "id:A3"));
    check("the BCBA's unverified session is not on the RBT report",
      !state.infractions.some((i) => i.rethink_staff_id === "S200"));
    check("a non-clinical employee collects no infractions",
      !state.infractions.some((i) => i.rethink_staff_id === "S400"));
    check("an unmatched Rethink provider is never guessed onto a person",
      !state.infractions.some((i) => i.employee_id == null));
    check("the unmatched provider is reported as a warning, not silently dropped",
      out.warnings.some((w) => /no CRM employee record/.test(w)), JSON.stringify(out.warnings));
    check("both infractions are filed against the RBT",
      state.infractions.every((i) => i.employee_id === 1 && i.cohort === "rbt"));
    check("the infraction is filed in the quarter the deadline was missed",
      state.infractions.every((i) => i.quarter === "2026-Q3"));
    check("one staff member is flagged", out.staff_flagged === 1, out.staff_flagged);
    check("nothing unexpected was written to the database", state.unknown.length === 0, state.unknown[0]);

    // ---- the email --------------------------------------------------------
    check("one summary email went out", state.emails.length === 1, state.emails.length);
    const mail = state.emails[0] || {};
    check("it went to the owner when no explicit recipient is set",
      mail.to === "owner@spectrumsquadlv.com", mail.to);
    check("the subject names the cohort and the count",
      /RBT unverified appointments/.test(mail.subject || "") && /2 session/.test(mail.subject || ""), mail.subject);
    check("the email names the person and their session count",
      /Rosa RBT/.test(mail.html || "") && />2</.test(mail.html || ""));
    check("the email carries no client identifier",
      !/clientId|clientName|patient/i.test(mail.html || ""));
  }

  console.log("\n--- where the report is addressed ---");
  {
    const { ctx } = makeDb(seedOpts(FRIDAY_0630_PT, {
      settings: { rethink_verification_report_to: "compliance@spectrumsquadlv.com, hr@spectrumsquadlv.com",
                  clinical_director_email: "cd@spectrumsquadlv.com" },
    }));
    const to = await initVerification(ctx)._internal.recipients();
    check("an address set for this report wins over every fallback",
      to.join(",") === "compliance@spectrumsquadlv.com,hr@spectrumsquadlv.com", to.join(","));
  }
  {
    const { ctx } = makeDb(seedOpts(FRIDAY_0630_PT, {
      settings: { clinical_director_email: "cd@spectrumsquadlv.com" },
    }));
    const to = await initVerification(ctx)._internal.recipients();
    check("otherwise the Clinical Director gets it", to.join(",") === "cd@spectrumsquadlv.com", to.join(","));
  }
  {
    // The install this is being built for signs the owner in as admin@. A
    // fallback that skipped that address would send the report nowhere.
    const { ctx } = makeDb(seedOpts(FRIDAY_0630_PT, {
      users: [{ email: "admin@spectrumsquadlv.com", role: "owner" }],
    }));
    const to = await initVerification(ctx)._internal.recipients();
    check("an owner signed in as admin@ still receives the report",
      to.join(",") === "admin@spectrumsquadlv.com", to.join(","));
  }
  {
    const { ctx } = makeDb(seedOpts(FRIDAY_0630_PT, {
      users: [{ email: "admin@spectrumsquadlv.com", role: "owner" },
              { email: "quiana@spectrumsquadlv.com", role: "owner" }],
    }));
    const to = await initVerification(ctx)._internal.recipients();
    check("a named owner is preferred over the generic admin address",
      to.join(",") === "quiana@spectrumsquadlv.com", to.join(","));
  }

  console.log("\n--- a report with nowhere to go says so ---");
  {
    // "Nobody configured a recipient" and "there was nothing to report" look
    // identical from the outside, and the difference matters a quarter later.
    const { state, ctx } = makeDb(seedOpts(FRIDAY_0630_PT, { users: [] }));
    stub.dwhGetAllPages = async () => ({ rows: [
      { appointmentId: "N1", staffId: "S100", appointmentStatus: "Completed", staffVerification: false, actualDurationHours: 2, appointmentDate: "2026-09-17" },
    ], pages: 1, truncated: false });
    const v = initVerification(ctx);
    const out = await v.runCohort("rbt", { runDate: "2026-09-18", triggeredBy: "test" });
    check("the infraction is still recorded when there is no recipient", state.infractions.length === 1);
    check("the run says the report was not delivered", out.email_status === "no_recipient", out.email_status);
    check("the missing recipient is raised as a warning, not swallowed",
      out.warnings.some((w) => /no recipient is set/i.test(w)), JSON.stringify(out.warnings));
  }

  console.log("\n--- a repeat run does not double-count ---");
  {
    const { state, ctx } = makeDb(seedOpts(FRIDAY_0630_PT));
    const rows = [
      { appointmentId: "A1", staffId: "S100", appointmentStatus: "Completed", staffVerification: false, actualDurationHours: 2, appointmentDate: "2026-09-17" },
    ];
    stub.dwhGetAllPages = async () => ({ rows, pages: 1, truncated: false });
    const v = initVerification(ctx);

    await v.runCohort("rbt", { runDate: "2026-09-18", triggeredBy: "test" });
    // A second Friday, same session still unverified.
    const second = await v.runCohort("rbt", { runDate: "2026-09-25", triggeredBy: "test" });

    check("the same unverified session is still ONE infraction", state.infractions.length === 1, state.infractions.length);
    check("the second sighting is counted as a repeat, not a new infraction",
      second.new_infractions === 0 && second.repeat_infractions === 1, JSON.stringify(second));
    check("the infraction records how many weeks it has been outstanding",
      state.infractions[0].times_flagged === 2, state.infractions[0].times_flagged);
    check("it stays filed in the quarter it was FIRST missed",
      state.infractions[0].quarter === "2026-Q3" && state.infractions[0].first_flagged_date === "2026-09-18");

    // Now they verify it. The infraction stands; the record shows they caught up.
    rows[0].staffVerification = true;
    const third = await v.runCohort("rbt", { runDate: "2026-10-02", triggeredBy: "test" });
    check("verifying it later resolves the infraction rather than erasing it",
      state.infractions.length === 1 && !!state.infractions[0].resolved_at, JSON.stringify(state.infractions[0]));
    check("the run reports it as resolved since the last check", third.resolved_since_last === 1, third.resolved_since_last);
    check("how long they took to fix it is recorded",
      state.infractions[0].resolved_after_days === 14, state.infractions[0].resolved_after_days);
    check("no new infraction is created by the run that closed it", third.new_infractions === 0);
  }

  console.log("\n--- the BCBA run ---");
  {
    const { state, ctx } = makeDb(seedOpts(FRIDAY_2000_PT));
    stub.dwhGetAllPages = async () => ({ rows: [
      { appointmentId: "B1", staffId: "S200", appointmentStatus: "Completed", staffVerification: false, actualDurationHours: 1.5, appointmentDate: "2026-09-16" },
      { appointmentId: "B2", staffId: "S200", appointmentStatus: "Completed", staffVerification: false, actualDurationHours: 2, appointmentDate: "2026-09-18" },
      { appointmentId: "B3", staffId: "S100", appointmentStatus: "Completed", staffVerification: false, actualDurationHours: 2, appointmentDate: "2026-09-16" },
    ], pages: 1, truncated: false });

    const v = initVerification(ctx);
    const out = await v.runCohort("bcba", { runDate: "2026-09-18", triggeredBy: "test" });

    check("only the BCBA's sessions are on the BCBA report",
      state.infractions.every((i) => i.cohort === "bcba" && i.employee_id === 2));
    check("the 19:30 run still excludes that same Friday's sessions",
      out.unverified_found === 1 && !state.infractions.some((i) => i.appointment_date === "2026-09-18"),
      out.unverified_found);
    check("the BCBA email is labelled BCBA",
      /BCBA unverified appointments/.test((state.emails[0] || {}).subject || ""), (state.emails[0] || {}).subject);
  }

  console.log("\n--- the report refuses to guess ---");
  {
    const { state, ctx } = makeDb(seedOpts(FRIDAY_0630_PT, {
      config: { ...CONFIRMED, filter_confirmed: false },
    }));
    const v = initVerification(ctx);
    const out = await v.runCohort("rbt", { runDate: "2026-09-18", triggeredBy: "test" });
    check("an unconfirmed verified-filter stops the run", out.ok === false && out.skipped === "filter_unconfirmed", JSON.stringify(out));
    check("no infraction is recorded while the filter is unconfirmed", state.infractions.length === 0);
    check("no email is sent while the filter is unconfirmed", state.emails.length === 0);
  }
  {
    const { state, ctx } = makeDb(seedOpts(FRIDAY_0630_PT, {
      config: { ...CONFIRMED, require_staff_verification: false },
    }));
    const v = initVerification(ctx);
    const out = await v.runCohort("rbt", { runDate: "2026-09-18", triggeredBy: "test" });
    check("with staff verification switched off there is nothing to report",
      out.ok === false && out.skipped === "verification_off");
    check("nothing is recorded when verification is switched off", state.infractions.length === 0);
  }
  {
    // The wiring is what guarantees one definition of "verified". Losing it
    // must make the report go quiet, not invent a second definition.
    const { state, ctx } = makeDb(seedOpts(FRIDAY_0630_PT));
    delete ctx.verificationVerdict;
    const v = initVerification(ctx);
    const out = await v.runCohort("rbt", { runDate: "2026-09-18", triggeredBy: "test" });
    check("a lost verified-filter wiring stops the run rather than guessing",
      out.ok === false && out.skipped === "not_wired", JSON.stringify(out));
    check("nothing is recorded when the wiring is lost", state.infractions.length === 0);
  }
  {
    const { state, ctx } = makeDb(seedOpts(FRIDAY_0630_PT));
    delete ctx.isRbt;
    const v = initVerification(ctx);
    const out = await v.runCohort("rbt", { runDate: "2026-09-18", triggeredBy: "test" });
    check("a lost who-is-an-RBT wiring stops the run rather than guessing",
      out.ok === false && out.skipped === "not_wired", JSON.stringify(out));
    check("nothing is recorded when the RBT rule is lost", state.infractions.length === 0);
  }

  console.log("\n--- an API failure loses nothing ---");
  {
    const { state, ctx } = makeDb(seedOpts(FRIDAY_0630_PT));
    stub.dwhGetAllPages = async () => { const e = new Error("upstream exploded"); e.status = 503; e.safe = "Rethink is unavailable."; throw e; };
    const v = initVerification(ctx);
    const out = await v.runCohort("rbt", { runDate: "2026-09-18", triggeredBy: "test" });

    check("a failed pull reports as failed", out.ok === false, JSON.stringify(out));
    check("the browser never sees the upstream message", !/exploded/.test(JSON.stringify(out)), JSON.stringify(out));
    check("the failure is recorded as a run", state.runs.length === 1 && state.runs[0].status === "failed");
    check("a failed run gives up its claim so the same Friday can retry",
      state.runs[0].run_key !== "rbt|2026-09-18", state.runs[0].run_key);
    check("no email is sent for a failed run", state.emails.length === 0);
    check("no infraction is invented from a failed pull", state.infractions.length === 0);
  }

  console.log("\n--- the Friday tick ---");
  {
    const mk = (nowIso) => {
      const d = makeDb(seedOpts(nowIso));
      stub.dwhGetAllPages = async () => ({ rows: [], pages: 1, truncated: false });
      return { state: d.state, v: initVerification(d.ctx) };
    };

    const thu = mk("2026-09-17T13:30:00.000Z");                 // Thursday 06:30 PT
    check("nothing fires on a Thursday", (await thu.v.tick("test")).fired.length === 0);

    const early = mk("2026-09-18T12:30:00.000Z");               // Friday 05:30 PT
    check("nothing fires at 05:30 on the Friday", (await early.v.tick("test")).fired.length === 0);

    const six = mk(FRIDAY_0630_PT);                              // Friday 06:30 PT
    const firedSix = (await six.v.tick("test")).fired;
    check("the RBT report fires at 06:00 Pacific",
      firedSix.length === 1 && firedSix[0].cohort === "rbt", JSON.stringify(firedSix.map((f) => f.cohort)));
    check("the BCBA report has NOT fired at 06:30", !firedSix.some((f) => f.cohort === "bcba"));
    // A redeploy five minutes later must not send a second email.
    const again = await six.v.tick("test");
    check("a restart inside the window does not re-run the RBT report", again.fired.length === 0, JSON.stringify(again.fired));
    check("only one RBT email exists for that Friday", six.state.emails.length === 1, six.state.emails.length);

    const evening = mk(FRIDAY_2000_PT);                          // Friday 20:00 PT
    const firedEve = (await evening.v.tick("test")).fired.map((f) => f.cohort).sort();
    check("by 20:00 both reports have fired for the day",
      firedEve.join(",") === "bcba,rbt", firedEve.join(","));

    // A box that was down all Friday morning and came back at 23:00 still owes
    // the week its report. The window it asks about -- sessions dated before
    // today -- is exactly as true at 23:00 as at 06:00, so a late run is right
    // and a skipped week is not.
    const late = mk("2026-09-19T06:00:00.000Z");                 // Friday 23:00 PT
    const firedLate = (await late.v.tick("test")).fired.map((f) => f.cohort).sort();
    check("a server that boots late on the Friday still files both reports",
      firedLate.join(",") === "bcba,rbt", firedLate.join(","));

    // Saturday is a new day: the missed Friday is not fired against a cutoff
    // that has moved on.
    const sat = mk("2026-09-19T13:30:00.000Z");                  // Saturday 06:30 PT
    check("a missed Friday is not fired on the Saturday", (await sat.v.tick("test")).fired.length === 0);
  }

  console.log("\n--- the quarterly numbers ---");
  {
    const { state, ctx } = makeDb(seedOpts(FRIDAY_0630_PT));
    const rows = [
      { appointmentId: "Q1", staffId: "S100", appointmentStatus: "Completed", staffVerification: false, actualDurationHours: 2, appointmentDate: "2026-09-16" },
      { appointmentId: "Q2", staffId: "S100", appointmentStatus: "Completed", staffVerification: false, actualDurationHours: 3, appointmentDate: "2026-09-17" },
      { appointmentId: "Q3", staffId: "S300", appointmentStatus: "Completed", staffVerification: false, actualDurationHours: 1, appointmentDate: "2026-09-17" },
    ];
    stub.dwhGetAllPages = async () => ({ rows, pages: 1, truncated: false });
    const v = initVerification(ctx);
    await v.runCohort("rbt", { runDate: "2026-09-18", triggeredBy: "test" });
    rows.splice(2, 1);                                  // the trainee fixes hers
    rows[0].staffVerification = true;                   // Rosa fixes one of hers
    await v.runCohort("rbt", { runDate: "2026-09-25", triggeredBy: "test" });

    const q = await v.quarterSummary("2026-Q3");
    check("the quarter summary reports one row per person", q.people.length === 2, JSON.stringify(q.people));
    const rosa = q.people.find((p) => p.employee_id === 1);
    check("every infraction in the quarter is counted, fixed or not", rosa && rosa.infractions === 2, rosa && rosa.infractions);
    check("the ones still outstanding are counted separately", rosa && rosa.still_open === 1, rosa && rosa.still_open);
    check("the quarter total is the sum across people", q.totals.infractions === 3, q.totals.infractions);
    check("the person with the most infractions sorts first", q.people[0].employee_id === 1, JSON.stringify(q.people.map((p) => p.employee_id)));
    check("a quarter can be pulled for one cohort",
      (await v.quarterSummary("2026-Q3", { cohort: "bcba" })).people.length === 0);
    check("a bad quarter string is refused", (await v.quarterSummary("nonsense")).ok === false);

    const hist = await v.employeeHistory(1, { quarter: "2026-Q3" });
    check("one person's history lists every infraction", hist.total_infractions === 2, hist.total_infractions);
    check("their history is grouped by quarter for the review",
      hist.by_quarter.length === 1 && hist.by_quarter[0].quarter === "2026-Q3" && hist.by_quarter[0].infractions === 2,
      JSON.stringify(hist.by_quarter));
    check("the history says which sessions are still open", hist.still_open === 1, hist.still_open);
    check("the history carries no client identifier",
      !JSON.stringify(hist).match(/clientId|clientName/i));
    check("a missing employee id is refused", (await v.employeeHistory("nope")).ok === false);
    check("the quarterly read wrote nothing to the database", state.unknown.length === 0, state.unknown[0]);
  }

  console.log("\n--- the appointment key is stable ---");
  {
    const { ctx } = makeDb(seedOpts(FRIDAY_0630_PT));
    const v = initVerification(ctx);
    const key = v._internal.appointmentKey;
    check("a Rethink appointment id is used when present",
      key({ appointmentId: "A1", staffId: "S1" }) === "id:A1");
    const row = { staffId: "S1", appointmentDate: "2026-09-17", startTime: "09:00", actualDurationHours: 2 };
    check("without an id the composite is deterministic", key(row) === key({ ...row }));
    check("two different sessions do not collide",
      key(row) !== key({ ...row, startTime: "11:00" }));
    check("the composite carries no client identifier",
      !/client/i.test(key({ ...row, clientId: "C9", clientName: "A Child" })));
  }

  console.log("\n--- the wiring in server.js ---");
  {
    const src = require("fs").readFileSync(require("path").join(__dirname, "server.js"), "utf8");
    check("server.js constructs the module",
      /require\("\.\/rethink-verification"\)/.test(src));
    check("who is an RBT comes from Fidelity's rule, not a second copy",
      /rethink-verification[\s\S]{0,900}isRbt: \(emp\) => fidelity\.isRbt\(emp\)/.test(src));
    check("what counts as verified comes from the Rethink module",
      /rethink-verification[\s\S]{0,900}verificationVerdict: \(row, cfg\) => rethink\.verificationVerdict\(row, cfg\)/.test(src));
    check("the tables are created on boot", /rethinkVerification\.initTables\(\)/.test(src));
    check("the Friday clock is ticked on an interval", /rethinkVerification\.tick\("scheduled"\)/.test(src));
    check("the tick also runs on boot so a Friday deploy catches up", /rethinkVerification\.tick\("boot"\)/.test(src));
    check("its routes are claimed BEFORE the broader /api/rethink handler",
      src.indexOf('pathname.startsWith("/api/rethink-verification")') < src.indexOf('pathname.startsWith("/api/rethink")'));
    check("the Friday report is addressed to the practice owner out of the box",
      /rethink_verification_report_to: "qblake@spectrumsquadlv\.com"/.test(src));
    check("that address is SEEDED into app_settings, so a stored value still wins",
      /DEFAULT_SETTINGS[\s\S]{0,4000}rethink_verification_report_to/.test(src));
    check("the module adds nothing to the CRM navigation",
      !/rethink-verification/.test(require("fs").readFileSync(require("path").join(__dirname, "index.html"), "utf8")));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
