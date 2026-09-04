// bcba-dashboard.js -- the BCBA's landing screen, and the one-time assignment
// migration that makes it useful.
//
// WHAT THIS OWNS AND WHAT IT DOES NOT
//
// It owns /api/caseload/*. It owns exactly two new columns on `clients`
// (student analyst, squad leader) and nothing else. Everything the dashboard
// shows is READ FROM THE SYSTEM THAT ALREADY OWNS IT:
//
//   clients                 assigned BCBA, authorization dates, treatment plan
//                           due date, stage, waitlist, payer
//   staff_tasks             the BCBA's tasks
//   auth_alerts             the existing authorization alert queue
//   hr_employees            the monthly billable target
//   rethink_provider_month  verified hours delivered
//   supervision_logs        supervision completed and signed off
//   Rethink /api/Appointments  the schedule
//
// There is no caseload table, no dashboard cache and no second copy of an
// assignment. That is deliberate and it is the requirement: a dashboard that
// keeps its own copy of who a client's BCBA is will disagree with the client
// card within a week, and the disagreement is invisible until somebody acts on
// the wrong one.
//
// WHY THE SCHEDULE IS READ-ONLY
//
// Rethink is the source of truth for scheduling and this only ever reads it.
// Nothing here writes an appointment, stores one, or lets a BCBA edit one. A
// schedule the CRM could edit would be a second schedule, and the first time
// the two disagreed a therapist would be sent to the wrong place.
"use strict";

module.exports = function initBcbaDashboard(ctx) {
  const {
    dbGet, dbAll, dbRun, nowISO, readBody, json,
    canAccessClients, fetchAppointments, verifiedHoursForMonths, supervisionMonth,
  } = ctx;

  // ---- who may see what ---------------------------------------------------
  // The dashboard shows one BCBA's caseload. A BCBA sees their own and is never
  // asked to pick themselves. An owner or admin may look at somebody else's,
  // because covering an absence otherwise means asking that person.
  const PICKER_ROLES = ["owner", "super_admin", "admin"];
  const canPick = (u) => !!u && PICKER_ROLES.includes(u.role);
  // `clinical` is the CRM's BCBA role -- ROLE_CATALOG labels it "Clinical
  // (BCBA)". This dashboard replaces the generic one for that role.
  const isBcbaRole = (u) => !!u && u.role === "clinical";

  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const lower = (s) => clean(s).toLowerCase();
  const today = () => new Date().toISOString().slice(0, 10);
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const round1 = (n) => Math.round(num(n) * 10) / 10;

  // Whole days between two ISO dates, from UTC midnight to UTC midnight, so a
  // deadline does not move by one when the clock crosses a timezone boundary.
  function daysUntil(iso, from) {
    const a = String(iso || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a)) return null;
    const b = String(from || today()).slice(0, 10);
    const ms = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))
             - Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
    return Math.round(ms / 86400000);
  }

  // The urgency bands the request specified, in one place because the summary
  // cards, the authorization table and the caseload table must agree. Two
  // implementations of the same thresholds drift and then a client is urgent on
  // one panel and fine on the next.
  function urgency(days) {
    if (days === null) return { key: "unknown", label: "No date", tone: "grey" };
    if (days < 0) return { key: "expired", label: `Expired ${Math.abs(days)}d ago`, tone: "darkred" };
    if (days === 0) return { key: "today", label: "Expires today", tone: "red" };
    if (days <= 7) return { key: "urgent", label: `Urgent — ${days} day${days === 1 ? "" : "s"}`, tone: "red" };
    if (days <= 30) return { key: "soon", label: `Due Soon — ${days} days`, tone: "orange" };
    if (days <= 60) return { key: "upcoming", label: `Upcoming — ${days} days`, tone: "yellow" };
    return { key: "ok", label: `${days} days`, tone: "none" };
  }
  // Treatment plans use the same thresholds but say "Overdue" rather than
  // "Expired": a plan that is late is late, an authorization that is past its
  // end date has actually stopped covering the child.
  function tpUrgency(days) {
    const u = urgency(days);
    if (u.key === "expired") return { ...u, label: `Overdue ${Math.abs(days)}d` };
    if (u.key === "today") return { ...u, label: "Due today" };
    return u;
  }

  async function initTables() {
    // Additive, and shaped exactly like the assigned-BCBA columns that already
    // exist on this table -- name plus email, resolved against hr_employees at
    // migration time. Not a join table: the CRM stores assignments as free-text
    // name/email on the client everywhere else, and a second convention here
    // would mean every consumer has to know which one a given field uses.
    for (const col of [
      "assigned_student_analyst_name TEXT",
      "assigned_student_analyst_email TEXT",
      "squad_leader_name TEXT",
      "squad_leader_email TEXT",
    ]) {
      await dbRun(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS ${col}`)
        .catch((e) => console.error("[caseload] column:", col, e.message));
    }

    // The review list from the one-time migration. It holds ONLY rows a person
    // still has to decide, plus what was applied, so the migration can be
    // re-opened and finished later. It is not a copy of the assignments: the
    // assignments live on `clients`.
    await dbRun(`CREATE TABLE IF NOT EXISTS bcba_migration_review (
      id SERIAL PRIMARY KEY,
      batch TEXT NOT NULL,
      sheet_client TEXT NOT NULL,
      client_id INTEGER,
      crm_client TEXT,
      sheet_bcba TEXT,
      crm_bcba TEXT,
      sheet_analyst TEXT,
      sheet_squad_leader TEXT,
      issue TEXT NOT NULL,
      detail TEXT,
      action TEXT NOT NULL DEFAULT 'needs_review',
      resolved_at TEXT,
      resolved_by TEXT,
      created_at TEXT NOT NULL
    )`).catch((e) => console.error("[caseload] review table:", e.message));
  }

  // ---- resolving the BCBA whose dashboard this is -------------------------
  // Never a dropdown for the BCBA themselves: their own account IS the answer.
  async function resolveBcba(user, wanted) {
    const self = { name: clean(user.name), email: lower(user.email), is_self: true };
    if (!wanted || !canPick(user)) return self;
    const w = lower(wanted);
    if (!w || w === lower(user.email)) return self;
    // Only a name/email that actually appears as an assigned BCBA, so the
    // picker cannot be used to enumerate staff who are not BCBAs.
    const row = await dbGet(
      `SELECT TRIM(assigned_bcba_name) AS name, LOWER(TRIM(assigned_bcba_email)) AS email
         FROM clients
        WHERE LOWER(TRIM(assigned_bcba_email)) = ? OR LOWER(TRIM(assigned_bcba_name)) = ?
        LIMIT 1`, [w, w]
    ).catch(() => null);
    if (!row) return self;
    return { name: row.name || wanted, email: row.email || "", is_self: false };
  }

  // Every client assigned to this BCBA. Matches on email when there is one and
  // on name otherwise, which is how userAssignedToClient() in server.js already
  // decides the same question -- one rule, not two.
  async function clientsFor(bcba) {
    const email = lower(bcba.email), name = lower(bcba.name);
    if (!email && !name) return [];
    return await dbAll(
      `SELECT id, child_name, stage, waitlisted, insurance_provider,
              auth_start_date, auth_expiration_date, treatment_plan_due_date,
              assigned_bcba_name, assigned_bcba_email,
              assigned_student_analyst_name, assigned_student_analyst_email,
              squad_leader_name, rethink_client_id
         FROM clients
        WHERE (? <> '' AND LOWER(TRIM(assigned_bcba_email)) = ?)
           OR (? <> '' AND LOWER(TRIM(assigned_bcba_name)) = ?)
        ORDER BY child_name`,
      [email, email, name, name]
    ).catch(() => []);
  }

  const OPEN_STAGES = ["active", "first_day_scheduled", "assessment_scheduling", "authorization",
                       "insurance_verification", "clinical_screener", "new_submission"];

  function decorate(c) {
    const authDays = daysUntil(c.auth_expiration_date);
    const tpDays = daysUntil(c.treatment_plan_due_date);
    return {
      id: c.id,
      child_name: c.child_name,
      stage: c.stage,
      waitlisted: !!c.waitlisted,
      insurance_provider: c.insurance_provider || null,
      auth_start_date: c.auth_start_date || null,
      auth_expiration_date: c.auth_expiration_date || null,
      treatment_plan_due_date: c.treatment_plan_due_date || null,
      auth_days: authDays,
      auth_urgency: urgency(authDays),
      tp_days: tpDays,
      tp_urgency: tpUrgency(tpDays),
      student_analyst: clean(c.assigned_student_analyst_name) || null,
      student_analyst_email: lower(c.assigned_student_analyst_email) || null,
      squad_leader: clean(c.squad_leader_name) || null,
      rethink_client_id: c.rethink_client_id || null,
    };
  }

  // ---- the payload --------------------------------------------------------
  async function buildDashboard(user, wantedBcba) {
    const bcba = await resolveBcba(user, wantedBcba);
    const rows = await clientsFor(bcba);
    const clients = rows.map(decorate);

    // Discharged and closed clients are not a caseload. They stay on the record
    // and stay reachable from the pipeline; they are simply not today's work.
    const openClients = clients.filter((c) => OPEN_STAGES.includes(c.stage));

    const inTherapy = openClients.filter((c) => c.stage === "active" && !c.waitlisted).length;
    const assessment = openClients.filter((c) => c.stage === "assessment_scheduling").length;
    const onHold = openClients.filter((c) => c.waitlisted).length;

    const band = (list, pick) => ({
      expired: list.filter((c) => pick(c) !== null && pick(c) < 0).length,
      d7: list.filter((c) => pick(c) !== null && pick(c) >= 0 && pick(c) <= 7).length,
      d30: list.filter((c) => pick(c) !== null && pick(c) > 7 && pick(c) <= 30).length,
      d60: list.filter((c) => pick(c) !== null && pick(c) > 30 && pick(c) <= 60).length,
    });
    const authBands = band(openClients, (c) => c.auth_days);
    const tpBands = band(openClients, (c) => c.tp_days);

    // Student Analysts, counted from the client records rather than from a
    // roster. BCBA -> Client -> Student Analyst: this is one caseload seen
    // through a second relationship, never a second caseload.
    const analystMap = new Map();
    let withAnalyst = 0;
    for (const c of openClients) {
      if (!c.student_analyst) continue;
      withAnalyst++;
      const key = lower(c.student_analyst);
      const cur = analystMap.get(key) || { name: c.student_analyst, email: c.student_analyst_email, clients: [] };
      cur.clients.push({ id: c.id, child_name: c.child_name });
      analystMap.set(key, cur);
    }
    const analysts = [...analystMap.values()].sort((a, b) => a.name.localeCompare(b.name));

    return {
      bcba,
      can_pick: canPick(user),
      is_bcba_role: isBcbaRole(user),
      today: today(),
      clients: openClients,
      all_client_count: clients.length,
      summary: {
        clients: { total: openClients.length, in_therapy: inTherapy, assessment, on_hold: onHold },
        authorizations: { ...authBands, attention: authBands.expired + authBands.d7 + authBands.d30 + authBands.d60 },
        treatment_plans: { ...tpBands, attention: tpBands.expired + tpBands.d7 + tpBands.d30 + tpBands.d60 },
        analysts: {
          count: analysts.length,
          clients_with: withAnalyst,
          clients_without: openClients.length - withAnalyst,
        },
        billable: await billableFor(bcba),
      },
      analysts,
      tasks: await tasksFor(user, bcba),
      supervision: await supervisionFor(bcba),
    };
  }

  // ---- billable -----------------------------------------------------------
  // Straight from the existing system: the target lives on hr_employees and the
  // actual is Rethink verified hours. Nothing is computed a second way here.
  async function billableFor(bcba) {
    const month = today().slice(0, 7);
    const emp = await employeeFor(bcba);
    if (!emp) return { month, available: false, note: "No staff record matched this BCBA, so the monthly target could not be read." };
    if (emp.monthly_billable_target == null || emp.monthly_billable_target === "") {
      return { month, available: false, employee_id: emp.id, note: "No monthly billable requirement is set for this BCBA." };
    }
    const required = num(emp.monthly_billable_target);
    let completed = null;
    if (typeof verifiedHoursForMonths === "function") {
      const map = await verifiedHoursForMonths(emp.id, [month]).catch(() => ({}));
      if (Object.prototype.hasOwnProperty.call(map || {}, month)) completed = num(map[month]);
    }
    if (completed === null) {
      // Said plainly rather than shown as zero. "0 of 90 hours" reads as a
      // performance problem; the truth is that the figure is not in yet.
      return {
        month, available: false, required, employee_id: emp.id,
        note: "Verified hours for this month are not available yet from Rethink.",
      };
    }
    const remaining = Math.max(0, round1(required - completed));
    return {
      month, available: true, employee_id: emp.id,
      required: round1(required), completed: round1(completed), remaining,
      percent: required > 0 ? Math.round((completed / required) * 100) : null,
    };
  }

  async function employeeFor(bcba) {
    const email = lower(bcba.email), name = lower(bcba.name);
    if (email) {
      const byEmail = await dbGet(
        "SELECT id, name, email, monthly_billable_target, rethink_id FROM hr_employees WHERE LOWER(TRIM(email)) = ? LIMIT 1",
        [email]).catch(() => null);
      if (byEmail) return byEmail;
    }
    if (name) {
      const rows = await dbAll(
        "SELECT id, name, email, monthly_billable_target, rethink_id FROM hr_employees WHERE LOWER(TRIM(name)) = ?",
        [name]).catch(() => []);
      // Two employees with the same name is not something to resolve by
      // picking one -- the wrong billable target on a performance panel is a
      // conversation nobody should have to have.
      if (rows.length === 1) return rows[0];
    }
    return null;
  }

  // ---- tasks --------------------------------------------------------------
  async function tasksFor(user, bcba) {
    const email = lower(bcba.email), name = lower(bcba.name);
    const rows = await dbAll(
      `SELECT t.id, t.title, t.description, t.due_date, t.status, t.client_id,
              c.child_name
         FROM staff_tasks t
         LEFT JOIN clients c ON c.id = t.client_id
        WHERE t.status <> 'done'
          AND ((? <> 0 AND t.assigned_user_id = ?)
               OR (? <> '' AND LOWER(TRIM(t.assigned_name)) = ?)
               OR (? <> '' AND LOWER(TRIM(t.assigned_name)) = ?))
        ORDER BY (t.due_date IS NULL), t.due_date, t.id
        LIMIT 100`,
      [bcba.is_self && user.id ? 1 : 0, bcba.is_self && user.id ? user.id : -1,
       name, name, email, email]
    ).catch(() => []);
    return rows.map((t) => {
      const d = daysUntil(t.due_date);
      return {
        id: t.id, title: t.title, description: t.description || null,
        due_date: t.due_date || null, days: d,
        client_id: t.client_id || null, client_name: t.child_name || null,
        bucket: d === null ? "later" : d < 0 ? "overdue" : d === 0 ? "today" : d <= 7 ? "week" : "later",
      };
    });
  }

  // ---- supervision --------------------------------------------------------
  // There is no stored "this RBT is supervised by that BCBA" link in the CRM,
  // and inventing one here would create a second source of truth for a
  // relationship HR owns. So this reports what IS recorded, and the panel says
  // on screen how the list was derived rather than implying a roster exists:
  //
  //   * anyone whose supervision month this BCBA signed off in the last six
  //     months, and
  //   * the RBT assigned to one of this BCBA's clients.
  //
  // THE FIGURES ARE NOT RECOMPUTED HERE. They come from the RBT Supervision
  // tracker's own monthSummary(), because the denominator has a precedence rule
  // -- Rethink verified hours, else the uploaded payroll figure, and only a
  // positive Rethink value takes over -- that must not exist in two places. A
  // second implementation would drift and then two screens would disagree about
  // whether somebody is compliant.
  async function supervisionFor(bcba) {
    const month = today().slice(0, 7);
    const name = lower(bcba.name);
    const empty = (why) => ({ month, rows: [], derived: why });
    if (!name) return empty("no BCBA name");
    if (typeof supervisionMonth !== "function") return empty("the supervision tracker is not available");

    // Who this BCBA is responsible for, by the two recorded relationships.
    const signed = await dbAll(
      `SELECT DISTINCT employee_id FROM hr_supervision_logs
        WHERE LOWER(TRIM(COALESCE(signed_by,''))) = ? AND month >= ?`,
      [name, monthsAgo(6)]).catch(() => []);
    const assigned = await dbAll(
      `SELECT DISTINCT LOWER(TRIM(assigned_rbt_name)) AS rbt FROM clients
        WHERE assigned_rbt_name IS NOT NULL AND TRIM(assigned_rbt_name) <> ''
          AND ((? <> '' AND LOWER(TRIM(assigned_bcba_email)) = ?) OR LOWER(TRIM(assigned_bcba_name)) = ?)`,
      [lower(bcba.email), lower(bcba.email), name]).catch(() => []);

    const ids = new Set(signed.map((r) => r.employee_id).filter(Boolean));
    const names = new Set(assigned.map((r) => r.rbt).filter(Boolean));
    if (!ids.size && !names.size) return empty("nothing recorded yet");

    let summary;
    try { summary = await supervisionMonth(month); }
    catch (e) { return empty("the supervision tracker could not be read"); }

    const mine = (summary.employees || []).filter(
      (e) => ids.has(e.employee_id) || names.has(lower(e.name)));

    return {
      month,
      min_pct: summary.min_pct,
      derived: "signed off by this BCBA in the last six months, or the assigned RBT on one of their clients",
      rows: mine.map((e) => ({
        employee_id: e.employee_id,
        name: e.name,
        role_title: e.role_title || null,
        worked_hours: e.hours_worked,
        supervision_hours: e.sup_hours,
        percent: e.pct,
        hours_source: e.hours_source,
        signed_off: !!e.signed_off,
        // The three things worth acting on, named rather than left to a colour:
        // no worked hours means the figure cannot be judged at all.
        status: !e.hours_worked ? "no_hours"
              : e.pct == null ? "no_supervision"
              : !e.meets ? "below"
              : "ok",
      })),
    };
  }

  function monthsAgo(n) {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - n);
    return d.toISOString().slice(0, 7);
  }

  // ---- the schedule, read from Rethink ------------------------------------
  // Read-only, uncached and never written back. If Rethink is unreachable the
  // panel says so; it does not fall back to anything, because the only other
  // schedule available would be the spreadsheet's notes, and those are
  // historical.
  async function scheduleFor(bcba, date) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) ? date : today();
    const emp = await employeeFor(bcba);
    if (!emp) return { date: day, available: false, reason: "No staff record matched this BCBA." };
    if (!emp.rethink_id) return { date: day, available: false, reason: "This BCBA is not linked to a Rethink provider yet." };
    if (typeof fetchAppointments !== "function") {
      return { date: day, available: false, reason: "The Rethink integration is not available." };
    }
    let fetched;
    try {
      fetched = await fetchAppointments(day, day);
    } catch (e) {
      return { date: day, available: false, reason: e && e.message ? e.message : "Rethink could not be reached." };
    }
    if (!fetched || !fetched.ok) {
      return { date: day, available: false, reason: (fetched && fetched.error) || "Rethink returned no schedule." };
    }

    const staffId = String(emp.rethink_id);
    const mine = (fetched.rows || []).filter((r) => String(r.staffId == null ? "" : r.staffId) === staffId);

    // Rethink client ids are matched to CRM records so a BCBA sees a child's
    // name. One that is not linked shows as unlinked rather than as a number
    // dressed up as a name.
    const ids = [...new Set(mine.map((r) => String(r.clientId == null ? "" : r.clientId)).filter(Boolean))];
    const nameById = new Map();
    if (ids.length) {
      const linked = await dbAll(
        `SELECT id, child_name, rethink_client_id FROM clients
          WHERE rethink_client_id IN (${ids.map(() => "?").join(",")})`, ids).catch(() => []);
      linked.forEach((c) => nameById.set(String(c.rethink_client_id), c));
    }

    const rows = mine.map((r) => {
      const rid = String(r.clientId == null ? "" : r.clientId);
      const c = nameById.get(rid) || null;
      return {
        // Only fields Rethink actually returns are surfaced. A blank here means
        // Rethink did not send it, not that nothing is scheduled.
        start: r.startTime || r.appointmentStartTime || null,
        end: r.endTime || r.appointmentEndTime || null,
        date: String(r.appointmentDate || "").slice(0, 10) || day,
        client_id: c ? c.id : null,
        client_name: c ? c.child_name : null,
        rethink_client_id: rid || null,
        location: r.location || r.appointmentLocation || r.serviceLocation || null,
        service: r.cptCode || r.serviceCode || r.appointmentType || r.serviceName || null,
        status: r.appointmentStatus || null,
        duration_hours: r.actualDurationHours == null ? null : num(r.actualDurationHours),
      };
    }).sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")));

    return { date: day, available: true, rows, source: "Rethink", staff_id: staffId };
  }

  // =========================================================================
  // ONE-TIME MIGRATION
  // =========================================================================
  // Conservative on purpose. Every decision it will not make confidently
  // becomes a review row instead of a write, because a wrong BCBA assignment is
  // invisible: the dashboard looks right, the caseload looks right, and the
  // person who should have seen an expiring authorization simply never does.

  const normName = (s) => lower(s).replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

  // Matches a sheet name against CRM clients. Exact normalised name only, plus
  // a first+last check for records that carry a middle name. Anything looser
  // put "Amir Mohamed" and "Amir Fentress" in reach of each other, and those
  // are two different children with two different BCBAs.
  function matchClients(sheetName, clients) {
    const want = normName(sheetName);
    if (!want) return [];
    const exact = clients.filter((c) => normName(c.child_name) === want);
    if (exact.length) return exact;
    const parts = want.split(" ").filter(Boolean);
    if (parts.length < 2) return [];
    const first = parts[0], last = parts[parts.length - 1];
    return clients.filter((c) => {
      const p = normName(c.child_name).split(" ").filter(Boolean);
      return p.length >= 2 && p[0] === first && p[p.length - 1] === last;
    });
  }

  // Staff are matched on a full name, or on a unique first name. The sheet
  // writes people as "Dora" and "Stephanie" -- first names only -- so refusing
  // those outright would leave every row for a human to do by hand, which is
  // the thing this exists to avoid. A first name that matches two employees is
  // still refused.
  function matchStaff(sheetName, employees) {
    const want = normName(sheetName);
    if (!want) return [];
    const exact = employees.filter((e) => normName(e.name) === want);
    if (exact.length) return exact;
    if (want.includes(" ")) return [];
    return employees.filter((e) => normName(e.name).split(" ")[0] === want);
  }

  async function buildMigrationPlan(text) {
    const { parseAssignmentSheet } = require("./bcba-migration-parser");
    const parsed = parseAssignmentSheet(text);
    if (!parsed.ok) return { ok: false, error: parsed.reason };

    const clients = await dbAll(
      `SELECT id, child_name, stage, assigned_bcba_name, assigned_bcba_email,
              assigned_student_analyst_name, squad_leader_name,
              auth_start_date, auth_expiration_date, treatment_plan_due_date
         FROM clients`).catch(() => []);
    // Staff are looked for in BOTH places a person can exist in this CRM. The
    // HR record is preferred because it is the fuller one and carries the
    // Rethink link and the billable target, but somebody can hold a CRM login
    // without an HR record -- and refusing to match them would put every one of
    // their clients on the review list for no reason a person could act on.
    // Matched by email first, so the same person in both is one person here.
    const employees = await dbAll(
      `SELECT id, name, email FROM hr_employees WHERE COALESCE(status,'active') <> 'terminated'`).catch(() => []);
    const logins = await dbAll("SELECT id, name, email FROM users").catch(() => []);
    const seen = new Set(employees.map((e) => lower(e.email)).filter(Boolean));
    const seenNames = new Set(employees.map((e) => normName(e.name)));
    for (const u of logins) {
      if (lower(u.email) && seen.has(lower(u.email))) continue;
      if (seenNames.has(normName(u.name))) continue;
      employees.push({ id: null, name: u.name, email: u.email, from_login: true });
    }

    // Squad leader per client, from the sheet's second table, keyed by name.
    const squadByClient = new Map();
    for (const s of parsed.squads || []) {
      for (const cn of s.clients) squadByClient.set(normName(cn), s.squad_leader);
    }

    const plan = [];     // rows that will be written
    const review = [];   // rows a person must decide
    const unchanged = [];

    for (const row of parsed.rows) {
      const base = {
        sheet_client: row.client_name,
        sheet_bcba: row.bcba || "",
        sheet_analyst: row.student_analyst || "",
        sheet_squad_leader: squadByClient.get(normName(row.client_name)) || "",
        section: row.section || "",
      };

      // Problems the sheet itself has are carried through, so a person sees
      // them next to the row rather than discovering them afterwards.
      for (const issue of row.sheet_issues || []) {
        review.push({ ...base, issue: "Sheet problem", detail: issue, client_id: null, crm_client: null, crm_bcba: null });
      }

      const matches = matchClients(row.client_name, clients);
      if (!matches.length) {
        review.push({ ...base, issue: "Client not found", detail: "No CRM client matches this name.", client_id: null, crm_client: null, crm_bcba: null });
        continue;
      }
      if (matches.length > 1) {
        review.push({
          ...base, issue: "Multiple client matches", client_id: null, crm_client: matches.map((m) => m.child_name).join(" / "),
          crm_bcba: null, detail: `${matches.length} CRM clients match this name; nothing was changed.`,
        });
        continue;
      }
      const client = matches[0];
      const writes = {};
      const notes = [];

      // ---- BCBA ----
      if (base.sheet_bcba) {
        const staff = matchStaff(base.sheet_bcba, employees);
        const currentName = clean(client.assigned_bcba_name);
        if (!staff.length) {
          review.push({ ...base, issue: "BCBA not found", client_id: client.id, crm_client: client.child_name,
            crm_bcba: currentName || null, detail: `No staff record matches "${base.sheet_bcba}".` });
        } else if (staff.length > 1) {
          review.push({ ...base, issue: "BCBA not found", client_id: client.id, crm_client: client.child_name,
            crm_bcba: currentName || null, detail: `"${base.sheet_bcba}" matches ${staff.length} staff records.` });
        } else if (!currentName) {
          writes.assigned_bcba_name = staff[0].name;
          writes.assigned_bcba_email = staff[0].email || null;
          notes.push(`BCBA set to ${staff[0].name}`);
        } else if (normName(currentName) === normName(staff[0].name)) {
          notes.push("BCBA already correct");
        } else {
          // The CRM may hold the newer answer. Never overwritten silently.
          review.push({ ...base, issue: "Existing assignment differs", client_id: client.id, crm_client: client.child_name,
            crm_bcba: currentName, detail: `CRM says "${currentName}", sheet says "${staff[0].name}".` });
        }
      }

      // ---- Student Analyst ----
      if (base.sheet_analyst) {
        const staff = matchStaff(base.sheet_analyst, employees);
        const current = clean(client.assigned_student_analyst_name);
        if (!staff.length || staff.length > 1) {
          // Never invents a person. This is the "Needs Student Analyst Match"
          // list the request asked for, with the sheet's own value shown.
          review.push({ ...base, issue: "Needs Student Analyst Match", client_id: client.id, crm_client: client.child_name,
            crm_bcba: clean(client.assigned_bcba_name) || null,
            detail: staff.length ? `"${base.sheet_analyst}" matches ${staff.length} staff records.`
                                 : `No staff record matches "${base.sheet_analyst}".` });
        } else if (!current) {
          writes.assigned_student_analyst_name = staff[0].name;
          writes.assigned_student_analyst_email = staff[0].email || null;
          notes.push(`Student Analyst set to ${staff[0].name}`);
        } else if (normName(current) === normName(staff[0].name)) {
          notes.push("Student Analyst already correct");
        } else {
          review.push({ ...base, issue: "Existing assignment differs", client_id: client.id, crm_client: client.child_name,
            crm_bcba: clean(client.assigned_bcba_name) || null,
            detail: `Student Analyst: CRM says "${current}", sheet says "${staff[0].name}".` });
        }
      }

      // ---- Squad leader ----
      if (base.sheet_squad_leader) {
        const staff = matchStaff(base.sheet_squad_leader, employees);
        const current = clean(client.squad_leader_name);
        if (!staff.length || staff.length > 1) {
          review.push({ ...base, issue: "Squad Leader not found", client_id: client.id, crm_client: client.child_name,
            crm_bcba: clean(client.assigned_bcba_name) || null,
            detail: staff.length ? `"${base.sheet_squad_leader}" matches ${staff.length} staff records.`
                                 : `No staff record matches "${base.sheet_squad_leader}".` });
        } else if (!current) {
          writes.squad_leader_name = staff[0].name;
          writes.squad_leader_email = staff[0].email || null;
          notes.push(`Squad Leader set to ${staff[0].name}`);
        } else if (normName(current) !== normName(staff[0].name)) {
          review.push({ ...base, issue: "Existing assignment differs", client_id: client.id, crm_client: client.child_name,
            crm_bcba: clean(client.assigned_bcba_name) || null,
            detail: `Squad Leader: CRM says "${current}", sheet says "${staff[0].name}".` });
        }
      }

      // ---- dates: blanks only ----
      // The answer to "fill blanks, flag differences". Billing may have entered
      // a renewal since the sheet was last touched, and that is the newer fact.
      const dateFields = [
        ["auth_start_date", row.auth_start, "Auth Start"],
        ["auth_expiration_date", row.auth_end, "Auth End"],
        ["treatment_plan_due_date", row.treatment_plan_due, "Treatment Plan Due"],
      ];
      for (const [col, val, label] of dateFields) {
        if (!val) continue;
        const cur = String(client[col] || "").slice(0, 10);
        if (!cur) { writes[col] = val; notes.push(`${label} set to ${val}`); }
        else if (cur !== val) {
          review.push({ ...base, issue: "Existing date differs", client_id: client.id, crm_client: client.child_name,
            crm_bcba: clean(client.assigned_bcba_name) || null,
            detail: `${label}: CRM has ${cur}, sheet has ${val}.` });
        }
      }

      if (Object.keys(writes).length) {
        plan.push({ client_id: client.id, crm_client: client.child_name, sheet_client: row.client_name, writes, notes });
      } else if (notes.length) {
        unchanged.push({ client_id: client.id, crm_client: client.child_name, notes });
      }
    }

    return {
      ok: true,
      warnings: parsed.warnings,
      summary: {
        clients_reviewed: parsed.rows.length,
        will_update: plan.length,
        already_correct: unchanged.length,
        needs_review: review.length,
      },
      plan, review, unchanged,
    };
  }

  async function applyMigration(planRows, user) {
    const batch = `mig-${nowISO()}`;
    let bcbaUpdated = 0, analystUpdated = 0, squadUpdated = 0, dateUpdated = 0, clientsChanged = 0;
    for (const row of planRows || []) {
      const writes = row.writes || {};
      const cols = Object.keys(writes);
      if (!cols.length || !row.client_id) continue;
      await dbRun(
        `UPDATE clients SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
        [...cols.map((c) => writes[c]), row.client_id]
      );
      clientsChanged++;
      if (writes.assigned_bcba_name) bcbaUpdated++;
      if (writes.assigned_student_analyst_name) analystUpdated++;
      if (writes.squad_leader_name) squadUpdated++;
      if (writes.auth_start_date || writes.auth_expiration_date || writes.treatment_plan_due_date) dateUpdated++;
    }
    return { batch, clientsChanged, bcbaUpdated, analystUpdated, squadUpdated, dateUpdated };
  }

  async function saveReview(rows, batch) {
    await dbRun("DELETE FROM bcba_migration_review WHERE action = 'needs_review'").catch(() => {});
    for (const r of rows || []) {
      await dbRun(
        `INSERT INTO bcba_migration_review
           (batch, sheet_client, client_id, crm_client, sheet_bcba, crm_bcba, sheet_analyst,
            sheet_squad_leader, issue, detail, action, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'needs_review',?)`,
        [batch, r.sheet_client, r.client_id || null, r.crm_client || null, r.sheet_bcba || null,
         r.crm_bcba || null, r.sheet_analyst || null, r.sheet_squad_leader || null,
         r.issue, r.detail || null, nowISO()]
      ).catch((e) => console.error("[caseload] review insert:", e.message));
    }
  }

  // =========================================================================
  // ROUTES
  // =========================================================================
  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/caseload")) return false;
    if (!user) { json(res, 401, { error: "Not signed in" }); return true; }
    // The same gate the client pipeline uses. The dashboard is a view of client
    // records, so it is behind client access rather than behind a new rule.
    if (!canAccessClients(user)) { json(res, 403, { error: "Not permitted" }); return true; }

    if (pathname === "/api/caseload/dashboard" && method === "GET") {
      json(res, 200, await buildDashboard(user, query.bcba));
      return true;
    }

    // The picker's options, and only ever people who are actually assigned as a
    // BCBA on a client. Not a staff directory.
    if (pathname === "/api/caseload/bcbas" && method === "GET") {
      if (!canPick(user)) { json(res, 403, { error: "Not permitted" }); return true; }
      const rows = await dbAll(
        `SELECT TRIM(assigned_bcba_name) AS name,
                LOWER(TRIM(COALESCE(assigned_bcba_email,''))) AS email,
                COUNT(*) AS clients
           FROM clients
          WHERE assigned_bcba_name IS NOT NULL AND TRIM(assigned_bcba_name) <> ''
            AND stage NOT IN ('discharged','not_moving_forward')
          GROUP BY TRIM(assigned_bcba_name), LOWER(TRIM(COALESCE(assigned_bcba_email,'')))
          ORDER BY TRIM(assigned_bcba_name)`).catch(() => []);
      json(res, 200, { bcbas: rows.map((r) => ({ name: r.name, email: r.email || null, clients: Number(r.clients) || 0 })) });
      return true;
    }

    if (pathname === "/api/caseload/schedule" && method === "GET") {
      const bcba = await resolveBcba(user, query.bcba);
      json(res, 200, await scheduleFor(bcba, query.date));
      return true;
    }

    // ---- migration: admin only ----
    if (pathname.startsWith("/api/caseload/migration")) {
      if (!canPick(user)) { json(res, 403, { error: "Only an owner or admin can run the assignment migration." }); return true; }

      if (pathname === "/api/caseload/migration/preview" && method === "POST") {
        const body = await readBody(req);
        const plan = await buildMigrationPlan(String(body.text || ""));
        if (!plan.ok) { json(res, 400, { error: plan.error }); return true; }
        json(res, 200, plan);
        return true;
      }

      if (pathname === "/api/caseload/migration/apply" && method === "POST") {
        const body = await readBody(req);
        // Re-planned from the sheet text on the server rather than trusting a
        // plan posted back by the browser: otherwise the apply step would write
        // whatever it was handed, and the review rules would be advisory.
        const plan = await buildMigrationPlan(String(body.text || ""));
        if (!plan.ok) { json(res, 400, { error: plan.error }); return true; }
        const result = await applyMigration(plan.plan, user);
        await saveReview(plan.review, result.batch);
        json(res, 200, {
          ok: true,
          summary: {
            clients_reviewed: plan.summary.clients_reviewed,
            bcba_assignments_updated: result.bcbaUpdated,
            student_analyst_assignments_updated: result.analystUpdated,
            squad_leader_assignments_updated: result.squadUpdated,
            date_fields_filled: result.dateUpdated,
            clients_changed: result.clientsChanged,
            already_correct: plan.summary.already_correct,
            needs_review: plan.review.length,
          },
          review: plan.review,
        });
        return true;
      }

      if (pathname === "/api/caseload/migration/review" && method === "GET") {
        const rows = await dbAll(
          "SELECT * FROM bcba_migration_review WHERE action = 'needs_review' ORDER BY issue, sheet_client").catch(() => []);
        json(res, 200, { rows });
        return true;
      }

      if (pathname === "/api/caseload/migration/review" && method === "DELETE") {
        await dbRun("DELETE FROM bcba_migration_review").catch(() => {});
        json(res, 200, { ok: true });
        return true;
      }
    }

    return false;
  }

  return {
    initTables, handleApi,
    _internal: { urgency, tpUrgency, daysUntil, matchClients, matchStaff, buildMigrationPlan, isBcbaRole, canPick },
  };
};
