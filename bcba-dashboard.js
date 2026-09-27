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
    // Billable hours for a week, from Rethink's own billable classification.
    // Separate from verifiedHoursForMonths above, which is the supervision and
    // payroll figure and must not move when the billable rule changes.
    billableForWeek,
    // Whether the hours sync has ever run, and whether its last word was a
    // failure. Read only to EXPLAIN a missing figure -- see billableFor().
    hoursSyncState,
    // Every week that overlaps the month, from the SAME computation the
    // billable requirements report reads. The month figure on this card is not
    // a second sum of the same days.
    billableWeeksForMonth,
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
      // The REAUTHORIZATION plan deadline, which is a different thing from
      // clients.treatment_plan_due_date and has to be stored separately.
      //
      // treatment_plan_due_date is DERIVED: the CRM computes it as the
      // in-clinic assessment date + 14 days, recomputes it whenever that
      // assessment date is edited, and CLEARS IT if the assessment date is
      // removed. It is the deadline for a new client's first plan.
      //
      // The practice's sheet tracks something else entirely -- the plan due
      // before the current authorization expires, about a month ahead of it.
      // For a child who has been in therapy a year those are years apart.
      // Writing the sheet's date into the derived field would conflate two
      // deadlines AND be silently overwritten the next time somebody edited an
      // assessment date.
      "reauth_plan_due_date TEXT",
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
              reauth_plan_due_date,
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

  // Which plan deadline applies to this client, and where it came from.
  //
  // The reauthorization deadline wins when there is one. Otherwise the derived
  // assessment+14 date is used -- but ONLY IF IT FALLS INSIDE THE CURRENT
  // AUTHORIZATION PERIOD. For a client who has been in therapy a year, that
  // field still holds a date from their intake, and reporting it would show an
  // entire caseload as hundreds of days overdue on the first day this ships.
  // A deadline that predates the authorization it belongs to is a finished
  // cycle, not an outstanding task; it is reported as such rather than dropped.
  function planDue(c) {
    const reauth = String(c.reauth_plan_due_date || "").slice(0, 10);
    if (reauth) return { date: reauth, source: "reauthorization" };
    const derived = String(c.treatment_plan_due_date || "").slice(0, 10);
    if (!derived) return { date: null, source: null };
    const authStart = String(c.auth_start_date || "").slice(0, 10);
    if (authStart && derived < authStart) {
      return { date: null, source: "stale", stale_date: derived };
    }
    return { date: derived, source: "assessment" };
  }

  function decorate(c) {
    const authDays = daysUntil(c.auth_expiration_date);
    const plan = planDue(c);
    const tpDays = daysUntil(plan.date);
    return {
      id: c.id,
      child_name: c.child_name,
      stage: c.stage,
      waitlisted: !!c.waitlisted,
      insurance_provider: c.insurance_provider || null,
      auth_start_date: c.auth_start_date || null,
      auth_expiration_date: c.auth_expiration_date || null,
      treatment_plan_due_date: plan.date,
      // Said out loud so the page can explain a blank rather than just show one.
      plan_due_source: plan.source,
      plan_due_stale: plan.stale_date || null,
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

  // ---- caseload health ----------------------------------------------------
  // ONE health verdict per client, derived from the row that was already
  // decorated above plus the tasks that were already fetched. It runs in
  // memory: no query is added, and nothing here is a second calculation of a
  // deadline. auth_days and tp_days come from urgency()/tpUrgency(), which the
  // summary cards and the caseload table already agree on -- so a client
  // cannot be red on one panel and fine on the next.
  //
  // WHAT IT DELIBERATELY DOES NOT JUDGE: whether programming exists. There is
  // no programming status in this CRM to read -- the Rethink endpoint probe
  // established the API exposes none -- and a red dot for "missing
  // programming" derived from the absence of a supervision note would be an
  // accusation built on a guess. A missing PLAN DATE is judged, because that
  // is a field somebody was supposed to fill in.
  //
  // Every verdict carries its reasons in words. The colour is the summary; the
  // sentence is the thing a BCBA can act on, and it is what the table's hover
  // and the priority feed both read.
  const HEALTH_RANK = { action: 0, attention: 1, ok: 2 };

  // `sort` orders reasons WITHIN a level and nothing else: how many days over,
  // or how many days until. It deliberately does NOT encode the level too.
  //
  // It used to, with offsets like -1000 for an expired authorization, and the
  // effect was that the level comparator below never decided anything -- the
  // numbers happened to agree with it in every case. Two rules where one is
  // silently unused is a rule nobody is testing, and the day somebody added a
  // reason with the wrong offset it would have ordered an overdue plan behind
  // a missing analyst with no test saying so. The level decides the level; the
  // number breaks ties inside it, and the two now genuinely overlap.

  function healthFor(c, tasksByClient) {
    const reasons = [];
    const mine = tasksByClient.get(c.id) || [];

    // --- action required ---
    if (c.auth_days !== null && c.auth_days < 0) {
      reasons.push({ key: "auth_expired", level: "action", text: `Authorization expired ${Math.abs(c.auth_days)} days ago.`, section: "auth", sort: c.auth_days });
    } else if (c.auth_days !== null && c.auth_days <= 7) {
      reasons.push({ key: "auth_urgent", level: "action", text: c.auth_days === 0 ? "Authorization expires today." : `Authorization expires in ${c.auth_days} days.`, section: "auth", sort: c.auth_days });
    }
    if (c.tp_days !== null && c.tp_days < 0) {
      reasons.push({ key: "plan_overdue", level: "action", text: `Treatment plan overdue ${Math.abs(c.tp_days)} days.`, section: "plan", sort: c.tp_days });
    }
    for (const t of mine) {
      if (t.bucket === "overdue") {
        reasons.push({ key: "task_overdue", level: "action", text: `Task overdue: ${t.title}.`, section: null, sort: (t.days || 0), task_id: t.id });
      }
    }

    // --- attention ---
    if (c.auth_days !== null && c.auth_days > 7 && c.auth_days <= 30) {
      reasons.push({ key: "auth_soon", level: "attention", text: `Authorization expires in ${c.auth_days} days.`, section: "auth", sort: c.auth_days });
    }
    if (c.tp_days !== null && c.tp_days >= 0 && c.tp_days <= 30) {
      reasons.push({ key: "plan_soon", level: "attention", text: c.tp_days === 0 ? "Treatment plan due today." : `Treatment plan due in ${c.tp_days} days.`, section: "plan", sort: c.tp_days });
    }
    // A plan deadline nobody recorded is not the same as a caseload that is up
    // to date, and the difference is invisible on a card that counts what is
    // due. planDue() has already worked out that a date from a finished
    // authorization cycle does not count.
    if (c.tp_days === null) {
      reasons.push({ key: "plan_missing", level: "attention", text: c.plan_due_source === "stale"
        ? "No treatment plan deadline for this authorization period — the only date on record predates it."
        : "No treatment plan deadline recorded.", section: "plan", sort: 900 });
    }
    if (!c.student_analyst) {
      reasons.push({ key: "no_analyst", level: "attention", text: "No Student Analyst assigned.", section: null, sort: 1000 });
    }
    for (const t of mine) {
      if (t.bucket === "today") {
        reasons.push({ key: "task_today", level: "attention", text: `Task due today: ${t.title}.`, section: null, sort: 0, task_id: t.id });
      }
    }

    // Level first here too, for the same reason the feed does it: reasons[0]
    // is what the client's line says, and an attention reason must never
    // speak for a client who has an action one.
    reasons.sort((a, b) => (HEALTH_RANK[a.level] - HEALTH_RANK[b.level]) || (a.sort - b.sort));
    const level = reasons.some((r) => r.level === "action") ? "action"
                : reasons.length ? "attention" : "ok";
    return { key: level, reasons };
  }

  const HEALTH_LABEL = { action: "Action required", attention: "Needs attention", ok: "On track" };

  // ---- the priority feed --------------------------------------------------
  // The same reasons, flattened and ranked across the whole caseload. Built
  // from healthFor() rather than from its own rules, so the dot beside a
  // client on the table and the item at the top of the page can never
  // disagree about why they are red.
  //
  // One line per client, not one per reason: a client with an expired
  // authorization AND an overdue plan is one person to deal with, and three
  // rows about the same child pushes somebody else's emergency off the screen.
  // Their other reasons ride along so the line can say "and 2 more".
  function prioritiesFrom(decorated, tasksByClient, limit) {
    const items = [];
    for (const c of decorated) {
      const h = c.health;
      if (!h || h.key === "ok" || !h.reasons.length) continue;
      const top = h.reasons[0];
      items.push({
        client_id: c.id,
        client_name: c.child_name,
        level: top.level,
        reason_key: top.key,
        title: top.text,
        section: top.section || null,
        also: h.reasons.length - 1,
        other_reasons: h.reasons.slice(1).map((r) => r.text),
        sort: top.sort,
      });
    }
    // Overdue tasks that are not about a client still belong here: they are
    // this BCBA's own work and nothing else on the page carries them.
    for (const t of (tasksByClient.get(null) || [])) {
      if (t.bucket !== "overdue") continue;
      items.push({
        client_id: null, client_name: null, level: "action", reason_key: "task_overdue",
        title: `Task overdue: ${t.title}`, section: null, also: 0, other_reasons: [],
        task_id: t.id, sort: (t.days || 0),
      });
    }
    items.sort((a, b) => (HEALTH_RANK[a.level] - HEALTH_RANK[b.level]) || (a.sort - b.sort)
      || String(a.client_name || "").localeCompare(String(b.client_name || "")));
    return items.slice(0, limit || 8);
  }

  // ---- clinical wins ------------------------------------------------------
  // Milestones a clinician RECORDED on one of this BCBA's clients. Read from
  // client_milestones, which is the record Client Programming writes; nothing
  // is inferred and nothing is derived from Rethink, which exposes no mastery
  // data to derive it from.
  //
  // Internal only. The parent-facing side of a milestone is the celebration
  // email, and this panel neither sends nor re-sends one -- it reports what
  // was already recorded.
  async function winsFor(clientIds) {
    const empty = { week_count: 0, rows: [], available: true };
    if (!clientIds.length) return empty;
    const since = daysAgo(30), weekAgo = daysAgo(7);
    const ph = clientIds.map(() => "?").join(",");
    const rows = await dbAll(
      `SELECT m.id, m.client_id, m.event_type, m.achieved_at, m.parent_friendly_name,
              m.clinical_program_name, m.clinical_target_name, c.child_name
         FROM client_milestones m
         JOIN clients c ON c.id = m.client_id
        WHERE m.client_id IN (${ph}) AND m.achieved_at >= ?
        ORDER BY m.achieved_at DESC, m.id DESC
        LIMIT 12`,
      [...clientIds, since]
    ).catch(() => null);
    // A query that could not run is NOT "no wins". The panel says which.
    if (!rows) return { week_count: 0, rows: [], available: false };
    return {
      available: true,
      week_count: rows.filter((r) => String(r.achieved_at || "") >= weekAgo).length,
      rows: rows.map((r) => ({
        id: r.id, client_id: r.client_id, client_name: r.child_name,
        event_type: r.event_type, achieved_at: r.achieved_at,
        // The clinical name is what a clinician recorded and what this screen
        // shows. The parent-friendly wording exists for the family's email and
        // is not what a BCBA is looking for here.
        program: r.clinical_program_name || r.clinical_target_name || r.parent_friendly_name || null,
      })),
    };
  }

  // ---- recent clinical activity -------------------------------------------
  // Three things that are actually written down against a client, each read
  // from the table that owns it. Nothing is invented, and a source that cannot
  // be read contributes nothing rather than a placeholder.
  async function activityFor(clientIds, bcba) {
    if (!clientIds.length) return [];
    const ph = clientIds.map(() => "?").join(",");
    const since = daysAgo(30);
    const out = [];

    const ms = await dbAll(
      `SELECT m.id, m.client_id, m.event_type, m.recorded_by, m.recorded_at, m.parent_notified_at,
              m.clinical_program_name, m.clinical_target_name, c.child_name
         FROM client_milestones m JOIN clients c ON c.id = m.client_id
        WHERE m.client_id IN (${ph}) AND COALESCE(m.recorded_at, m.achieved_at) >= ?
        ORDER BY COALESCE(m.recorded_at, m.achieved_at) DESC LIMIT 10`,
      [...clientIds, since]).catch(() => []);
    for (const r of ms) {
      out.push({
        kind: r.event_type === "mastery" ? "mastery" : "milestone",
        at: r.recorded_at, client_id: r.client_id, client_name: r.child_name,
        who: r.recorded_by || null,
        what: r.event_type === "mastery" ? "Skill mastered" : "Treatment milestone reached",
        detail: r.clinical_program_name || r.clinical_target_name || null,
        // Said plainly, because "was the family told" is the question somebody
        // asks about a milestone and guessing it is worse than not showing it.
        note: r.parent_notified_at ? "Family notified" : null,
      });
    }

    const notes = await dbAll(
      `SELECT n.id, n.client_id, n.session_date, n.bcba_name, n.created_at, c.child_name
         FROM client_supervision_notes n JOIN clients c ON c.id = n.client_id
        WHERE n.client_id IN (${ph}) AND COALESCE(n.created_at, n.session_date) >= ?
        ORDER BY COALESCE(n.created_at, n.session_date) DESC LIMIT 10`,
      [...clientIds, since]).catch(() => []);
    for (const r of notes) {
      out.push({
        kind: "programming", at: r.created_at || r.session_date, client_id: r.client_id,
        client_name: r.child_name, who: r.bcba_name || null,
        what: "Programming supervision note", detail: null, note: null,
      });
    }

    const done = await dbAll(
      `SELECT t.id, t.title, t.client_id, t.updated_at, t.assigned_name, c.child_name
         FROM staff_tasks t LEFT JOIN clients c ON c.id = t.client_id
        WHERE t.status = 'done' AND t.client_id IN (${ph}) AND t.updated_at >= ?
        ORDER BY t.updated_at DESC LIMIT 10`,
      [...clientIds, since]).catch(() => []);
    for (const r of done) {
      out.push({
        kind: "task", at: r.updated_at, client_id: r.client_id, client_name: r.child_name,
        who: r.assigned_name || null, what: "Task completed", detail: r.title, note: null,
      });
    }

    out.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    return out.slice(0, 12);
  }

  function daysAgo(n) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
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

    // ---- health, priorities, wins, activity -----------------------------
    // Tasks are fetched ONCE and shared: the task panel, every client's health
    // verdict and the priority feed all read the same list, so a task cannot
    // be overdue in one place and not in another, and the page does not ask
    // for them three times.
    const tasks = await tasksFor(user, bcba);
    const tasksByClient = new Map();
    for (const t of tasks) {
      const k = t.client_id || null;
      if (!tasksByClient.has(k)) tasksByClient.set(k, []);
      tasksByClient.get(k).push(t);
    }
    for (const c of openClients) c.health = healthFor(c, tasksByClient);
    const healthTally = {
      ok: openClients.filter((c) => c.health.key === "ok").length,
      attention: openClients.filter((c) => c.health.key === "attention").length,
      action: openClients.filter((c) => c.health.key === "action").length,
    };
    const clientIds = openClients.map((c) => c.id);

    return {
      bcba,
      can_pick: canPick(user),
      is_bcba_role: isBcbaRole(user),
      today: today(),
      clients: openClients,
      all_client_count: clients.length,
      priorities: prioritiesFrom(openClients, tasksByClient, 8),
      wins: await winsFor(clientIds),
      activity: await activityFor(clientIds, bcba),
      summary: {
        health: healthTally,
        clients: { total: openClients.length, in_therapy: inTherapy, assessment, on_hold: onHold },
        authorizations: { ...authBands, attention: authBands.expired + authBands.d7 + authBands.d30 + authBands.d60 },
        treatment_plans: { ...tpBands, attention: tpBands.expired + tpBands.d7 + tpBands.d30 + tpBands.d60 },
        // Made visible rather than left as a silent zero: a caseload with no
        // plan deadlines recorded and one that is completely up to date look
        // identical on a card that only counts what is due.
        plans: { no_date: openClients.filter((c) => c.tp_days === null).length },
        analysts: {
          count: analysts.length,
          clients_with: withAnalyst,
          clients_without: openClients.length - withAnalyst,
        },
        billable: await billableFor(bcba),
      },
      analysts,
      tasks,
      supervision: await supervisionFor(bcba),
    };
  }

  // ---- billable -----------------------------------------------------------
  // Straight from the existing system: the target lives on hr_employees and the
  // actual is Rethink verified hours. Nothing is computed a second way here.
  // THIS WEEK's billable hours against a WEEKLY requirement.
  //
  // Two things changed here and they are separate. The requirement is weekly
  // rather than monthly; and the hours counted are BILLABLE hours, not the
  // verified-hours figure that supervision and payroll read. That second one
  // matters most: verified hours include sessions that were genuinely
  // delivered but are not billable, so this panel was counting non-billable
  // time towards a billable requirement.
  //
  // The supervision figure is untouched. An hour can be delivered, verified,
  // count towards supervision, and not be billable -- the two rules are
  // deliberately not merged.
  async function billableFor(bcba) {
    const emp = await employeeFor(bcba);
    if (!emp) return { available: false, reason: "no_staff_record", note: "No staff record matched this BCBA, so the weekly target could not be read." };
    if (emp.weekly_billable_target == null || emp.weekly_billable_target === "") {
      return {
        available: false, employee_id: emp.id, reason: "no_target",
        note: emp.monthly_billable_target != null && emp.monthly_billable_target !== ""
          ? `No weekly billable requirement is set for this BCBA. Their old monthly figure was ${round1(num(emp.monthly_billable_target))} hours — set a weekly one to replace it.`
          : "No weekly billable requirement is set for this BCBA.",
      };
    }
    const required = round1(num(emp.weekly_billable_target));

    // NOT LINKED is a different problem from NOT SYNCED, and it is the one
    // somebody can fix in a minute. The schedule panel next door has always
    // said this; the billable panel said "not available yet from Rethink",
    // which sends a BCBA to look at an integration that is working.
    if (!emp.rethink_id || !String(emp.rethink_id).trim()) {
      return {
        available: false, required, employee_id: emp.id, reason: "not_linked",
        note: "This BCBA is not linked to a Rethink provider yet, so their hours cannot be read. An owner can link them on the Rethink page.",
      };
    }

    const wk = typeof billableForWeek === "function"
      ? await billableForWeek(emp.id, today()).catch(() => null)
      : null;

    // Nothing on file for the week at all. Say WHY rather than blaming
    // Rethink: the sync may never have run, or its last attempt may have
    // failed, and those are somebody's job to fix.
    if (!wk) {
      const sync = typeof hoursSyncState === "function"
        ? await hoursSyncState().catch(() => null)
        : null;
      let note = "No sessions for this week have come across from Rethink yet.";
      let reason = "nothing_synced";
      if (sync && sync.configured === false) {
        note = "The Rethink integration is not configured on the server, so billable hours cannot be read.";
        reason = "not_configured";
      } else if (sync && !sync.ever) {
        note = "Rethink hours have not synced yet, so this week's billable hours are not in.";
        reason = "never_synced";
      } else if (sync && sync.last_error) {
        note = "The last Rethink hours sync failed, so this week's billable hours are not in. It is retried automatically.";
        reason = "sync_failed";
      }
      // Said plainly rather than shown as zero. "0 of 25 hours" reads as a
      // performance problem; the truth is that the figure is not in yet.
      return { available: false, required, employee_id: emp.id, reason, note };
    }

    const seen = Number(wk.appointments_seen) || 0;
    const counted = Number(wk.appointments_counted) || 0;
    const unverified = Number(wk.unverified_appointments) || 0;

    // SESSIONS ARE THERE AND NONE OF THEM COUNTED. This is the case that wore
    // the "not available yet from Rethink" label for months and is not an
    // integration problem at all -- it is paperwork, usually the clinician's
    // own. Still not shown as 0%, because 0% is a performance statement and
    // this is not one; but the sentence now names what is actually holding the
    // figure back, and who can clear it.
    if (seen > 0 && wk.counted_any === false) {
      const sess = (n) => `${n} session${n === 1 ? "" : "s"}`;
      return {
        available: false, required, employee_id: emp.id, reason: "none_counted",
        week_start: wk.week_start, week_end: wk.week_end,
        appointments_seen: seen, unverified_appointments: unverified,
        note: unverified >= seen
          ? `Rethink has ${sess(seen)} for this week, but ${seen === 1 ? "it is" : "none of them are"} staff-verified yet, so no billable hours can be counted. Verifying ${seen === 1 ? "it" : "them"} in Rethink brings this figure in.`
          : `Rethink has ${sess(seen)} for this week and none of them count yet — ${unverified} ${unverified === 1 ? "is" : "are"} awaiting staff verification and the rest are not marked completed.`,
      };
    }

    const completed = round1(wk.billable);
    return {
      available: true, employee_id: emp.id,
      week_start: wk.week_start, week_end: wk.week_end,
      required, completed,
      // The month so far, beside the week. Same weekly requirement, so the
      // month's target is the weeks that have actually been measured -- not
      // required x 4.33, which would invent a figure for weeks nobody has
      // reached yet and report everybody as behind on the 3rd.
      month: await billableMonthFor(emp.id, required),
      remaining: Math.max(0, round1(required - completed)),
      percent: required > 0 ? Math.round((completed / required) * 100) : null,
      // Reported, never folded in: an hour Rethink did not label is not
      // quietly counted as billable.
      unclassified: round1(wk.unclassified),
      nonbillable: round1(wk.nonbillable),
      // Sessions Rethink has that this figure does NOT include yet, so a
      // number that looks low can be read correctly. A BCBA looking at 12 of
      // 25 deserves to know whether the other 13 hours are missing or just
      // unverified.
      appointments_seen: seen,
      appointments_counted: counted,
      unverified_appointments: unverified,
    };
  }

  // MONTH TO DATE, built from the weeks the requirements report already
  // computes. Only weeks that actually counted something contribute, for the
  // same reason a week waiting on verification is never scored as a miss: a
  // zero from unverified paperwork is not a zero from a quiet week.
  async function billableMonthFor(employeeId, weeklyRequired) {
    if (typeof billableWeeksForMonth !== "function") return null;
    const weeks = await billableWeeksForMonth(employeeId, today().slice(0, 7)).catch(() => []);
    const scored = (weeks || []).filter((w) => w.billable != null && w.counted_any !== false);
    if (!scored.length) return null;
    const completed = round1(scored.reduce((a, w) => a + num(w.billable), 0));
    const required = round1(weeklyRequired * scored.length);
    return {
      weeks_counted: scored.length,
      completed, required,
      remaining: Math.max(0, round1(required - completed)),
      percent: required > 0 ? Math.round((completed / required) * 100) : null,
    };
  }

  async function employeeFor(bcba) {
    const email = lower(bcba.email), name = lower(bcba.name);
    if (email) {
      const byEmail = await dbGet(
        "SELECT id, name, email, weekly_billable_target, monthly_billable_target, rethink_id FROM hr_employees WHERE LOWER(TRIM(email)) = ? LIMIT 1",
        [email]).catch(() => null);
      if (byEmail) return byEmail;
    }
    if (name) {
      const rows = await dbAll(
        "SELECT id, name, email, weekly_billable_target, monthly_billable_target, rethink_id FROM hr_employees WHERE LOWER(TRIM(name)) = ?",
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
  // One fetch-and-shape for a DATE RANGE, shared by the day view and the month
  // grid. Written once on purpose: two readers of the same Rethink schedule
  // that shaped rows differently would eventually disagree about what is on a
  // BCBA's calendar, and the calendar is the thing they plan their week from.
  async function scheduleRange(bcba, from, to, fallbackDay) {
    const emp = await employeeFor(bcba);
    if (!emp) return { available: false, reason: "No staff record matched this BCBA." };
    if (!emp.rethink_id) return { available: false, reason: "This BCBA is not linked to a Rethink provider yet." };
    if (typeof fetchAppointments !== "function") {
      return { available: false, reason: "The Rethink integration is not available." };
    }
    let fetched;
    try {
      fetched = await fetchAppointments(from, to);
    } catch (e) {
      return { available: false, reason: e && e.message ? e.message : "Rethink could not be reached." };
    }
    if (!fetched || !fetched.ok) {
      return { available: false, reason: (fetched && fetched.error) || "Rethink returned no schedule." };
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
        date: String(r.appointmentDate || "").slice(0, 10) || fallbackDay,
        client_id: c ? c.id : null,
        client_name: c ? c.child_name : null,
        rethink_client_id: rid || null,
        location: r.location || r.appointmentLocation || r.serviceLocation || null,
        service: r.cptCode || r.serviceCode || r.appointmentType || r.serviceName || null,
        status: r.appointmentStatus || null,
        duration_hours: r.actualDurationHours == null ? null : num(r.actualDurationHours),
      };
    }).sort((a, b) => (String(a.date || "").localeCompare(String(b.date || ""))
      || String(a.start || "").localeCompare(String(b.start || ""))));

    return { available: true, rows, source: "Rethink", staff_id: staffId };
  }

  // The single day, unchanged in shape: the day view and its callers still get
  // { date, available, rows, ... } exactly as before.
  async function scheduleFor(bcba, date) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) ? date : today();
    const out = await scheduleRange(bcba, day, day, day);
    return { date: day, ...out };
  }

  // A whole month, grouped by day, for the calendar grid. One Rethink call for
  // the month rather than thirty-one: a grid that fetched per cell would hammer
  // an API whose rate limits we have not been told.
  async function scheduleMonthFor(bcba, month) {
    const m = /^\d{4}-\d{2}$/.test(String(month || "")) ? month : today().slice(0, 7);
    const [y, mo] = m.split("-").map(Number);
    const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const from = `${m}-01`;
    const to = `${m}-${String(lastDay).padStart(2, "0")}`;

    const out = await scheduleRange(bcba, from, to, from);
    if (!out.available) return { month: m, from, to, available: false, reason: out.reason };

    // Every day of the month is present, including the empty ones. A calendar
    // that omitted quiet days would silently renumber itself.
    const byDay = new Map();
    for (let d = 1; d <= lastDay; d++) {
      const iso = `${m}-${String(d).padStart(2, "0")}`;
      byDay.set(iso, { date: iso, count: 0, hours: 0, rows: [] });
    }
    for (const r of out.rows) {
      const cell = byDay.get(String(r.date || "").slice(0, 10));
      // An appointment Rethink dated outside the window it was asked for is
      // reported in the total rather than dropped into the wrong cell.
      if (!cell) continue;
      cell.count += 1;
      cell.hours += num(r.duration_hours) || 0;
      cell.rows.push(r);
    }

    const days = [...byDay.values()].map((c) => ({ ...c, hours: Math.round(c.hours * 100) / 100 }));
    return {
      month: m, from, to, available: true, source: "Rethink", staff_id: out.staff_id,
      days,
      total_appointments: out.rows.length,
      total_hours: Math.round(days.reduce((a, c) => a + c.hours, 0) * 100) / 100,
    };
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
              auth_start_date, auth_expiration_date, treatment_plan_due_date,
              reauth_plan_due_date
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
        // The sheet's plan date is the REAUTHORIZATION deadline, so it goes in
        // its own column. Writing it to treatment_plan_due_date would put a
        // reauth deadline in a field the CRM derives from the assessment date
        // and recomputes behind you.
        ["reauth_plan_due_date", row.treatment_plan_due, "Treatment Plan Due"],
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
    // ---- one person, one row -------------------------------------------
    //
    // assigned_bcba_name and the two beside it are FREE TEXT, typed by whoever
    // filed the client. So the same person arrives as "Marissa" on some records
    // and "Marissa Gaut" on others, and every screen that groups by that string
    // shows her twice with her caseload split between the halves. That is what
    // was reported, and no amount of care on future records fixes the ones
    // already typed.
    //
    // These two endpoints find those pairs and let a person merge them. The
    // rule for what counts as the same person is deliberately narrow, and the
    // narrowness matters more than the coverage: merging two people who merely
    // share a first name would move one clinician's caseload onto another's
    // name, which is far worse than leaving a duplicate on screen.
    const MERGEABLE_FIELDS = {
      assigned_bcba_name: { label: "BCBA", email_col: "assigned_bcba_email" },
      assigned_student_analyst_name: { label: "Student Analyst", email_col: "assigned_student_analyst_email" },
      squad_leader_name: { label: "Squad Leader", email_col: "squad_leader_email" },
    };

    const normName = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

    // "marissa" is a word-prefix of "marissa gaut". "mari" is not a prefix of
    // "marissa": comparing on whole words rather than characters is what keeps
    // "Chris" away from "Christina".
    function isWordPrefix(short, long) {
      const a = normName(short).split(" "), b = normName(long).split(" ");
      if (!a[0] || a.length >= b.length) return false;
      return a.every((w, i) => w === b[i]);
    }

    async function nameDuplicates() {
      const out = [];
      for (const [col, meta] of Object.entries(MERGEABLE_FIELDS)) {
        let rows;
        try {
          rows = await dbAll(
            `SELECT TRIM(${col}) AS name, COUNT(*) AS clients
               FROM clients
              WHERE ${col} IS NOT NULL AND TRIM(${col}) <> ''
                AND stage NOT IN ('discharged','not_moving_forward')
              GROUP BY TRIM(${col}) ORDER BY TRIM(${col})`);
        } catch (e) { continue; }   // the column may not exist on an old database
        const names = rows.map((r) => ({ name: r.name, clients: Number(r.clients) || 0 }));

        for (const shortOne of names) {
          const longer = names.filter((n) => isWordPrefix(shortOne.name, n.name));
          const sameNormalised = names.filter((n) => n.name !== shortOne.name && normName(n.name) === normName(shortOne.name));

          // Differs only by case or spacing: not a judgement call at all.
          sameNormalised.forEach((n) => {
            if (shortOne.name < n.name) {
              out.push({ field: col, label: meta.label, from: n.name, to: shortOne.name,
                from_clients: n.clients, to_clients: shortOne.clients,
                reason: "The same name, differing only in spacing or capitalisation.", confident: true });
            }
          });

          if (longer.length === 1) {
            out.push({ field: col, label: meta.label, from: shortOne.name, to: longer[0].name,
              from_clients: shortOne.clients, to_clients: longer[0].clients,
              reason: `"${shortOne.name}" is how somebody typed "${longer[0].name}" on other records.`,
              confident: true });
          } else if (longer.length > 1) {
            // REFUSED, not guessed. A first name matching two full names is
            // exactly the case where merging picks the wrong clinician.
            out.push({ field: col, label: meta.label, from: shortOne.name, to: null,
              from_clients: shortOne.clients, candidates: longer.map((n) => n.name),
              reason: `"${shortOne.name}" could be any of ${longer.length} people. Somebody has to say which.`,
              confident: false });
          }
        }

        // ---- SHARING A FIRST NAME ------------------------------------------
        // The two rules above only fire on a name that is a WORD PREFIX of
        // another, or one that differs only in spacing. Between them they miss
        // the shapes people actually type:
        //
        //   "Marissa Gaut"  vs  "Marissa Gauthier"     (surname typed short)
        //   "Marissa Gaut"  vs  "Marissa A Gaut"       (middle initial)
        //   "Marissa Gaut"  vs  "Marissa G"            (surname initialled)
        //   "Marissa Gaut"  vs  "Marisa Gaut"          (a slip)
        //
        // Each of those puts one clinician on the caseload board twice with
        // their clients split, and the panel reported "nothing looks
        // duplicated" -- which is worse than saying nothing, because it tells
        // somebody looking straight at two of the same person that there is no
        // problem to fix.
        //
        // Sharing a first name is NOT evidence they are the same person: two
        // Marissas is entirely ordinary in a practice this size. So this NEVER
        // proposes a merge. It raises the group for a person to look at, and
        // the merge underneath it is theirs to choose.
        const byFirst = new Map();
        for (const n of names) {
          const first = normName(n.name).split(" ")[0];
          if (!first) continue;
          if (!byFirst.has(first)) byFirst.set(first, []);
          byFirst.get(first).push(n);
        }
        for (const group of byFirst.values()) {
          if (group.length < 2) continue;
          // Anything the confident rules already offered to merge is not
          // raised a second time as a question.
          const named = new Set(group.map((g) => g.name));
          const already = out.some((o) => o.field === col && named.has(o.from)
            && (o.to === null || named.has(o.to)));
          if (already) continue;
          out.push({
            field: col, label: meta.label, from: null, to: null,
            group: group.map((g) => ({ name: g.name, clients: g.clients })),
            candidates: group.map((g) => g.name),
            reason: `${group.length} people share the first name "${group[0].name.split(/\s+/)[0]}". `
              + "If these are one person spelled two ways, merge them; if they are two people, leave them.",
            confident: false,
          });
        }
      }
      return out;
    }

    // Every name on file in each column, with its count. THE PANEL MUST NEVER
    // BE A DEAD END: whatever the rules above do or do not spot, an admin can
    // see exactly what is stored -- two entries that look identical on screen
    // are two different strings, and this is where that becomes visible -- and
    // merge any of them by hand.
    async function nameRosters() {
      const out = [];
      for (const [col, meta] of Object.entries(MERGEABLE_FIELDS)) {
        try {
          const rows = await dbAll(
            `SELECT TRIM(${col}) AS name,
                    COUNT(*) AS clients,
                    MIN(NULLIF(LOWER(TRIM(COALESCE(${meta.email_col}, ''))), '')) AS email
               FROM clients
              WHERE ${col} IS NOT NULL AND TRIM(${col}) <> ''
                AND stage NOT IN ('discharged','not_moving_forward')
              GROUP BY TRIM(${col}) ORDER BY TRIM(${col})`);
          out.push({
            field: col, label: meta.label,
            names: rows.map((r) => ({ name: r.name, clients: Number(r.clients) || 0, email: r.email || null })),
          });
        } catch (e) { continue; }
      }
      return out;
    }

    if (pathname === "/api/caseload/name-duplicates" && method === "GET") {
      if (!canPick(user)) { json(res, 403, { error: "Not permitted" }); return true; }
      json(res, 200, { duplicates: await nameDuplicates(), rosters: await nameRosters() });
      return true;
    }

    if (pathname === "/api/caseload/merge-name" && method === "POST") {
      if (!canPick(user)) { json(res, 403, { error: "Only an owner or admin can merge staff names." }); return true; }
      const body = await readBody(req);
      const field = String(body.field || "");
      const meta = MERGEABLE_FIELDS[field];
      // An allowlist, never the posted string: this value goes into a column
      // position in the UPDATE below.
      if (!meta) { json(res, 400, { error: "That is not a field that can be merged." }); return true; }
      const from = clean(body.from), to = clean(body.to);
      if (!from || !to) { json(res, 400, { error: "Both names are needed." }); return true; }
      if (from === to) { json(res, 400, { error: "Those are already the same name." }); return true; }

      const before = await dbGet(
        `SELECT COUNT(*) AS n FROM clients WHERE TRIM(${field}) = ?`, [from]);
      if (!Number(before && before.n)) {
        json(res, 404, { error: `No client is filed under "${from}".` });
        return true;
      }
      await dbRun(`UPDATE clients SET ${field} = ? WHERE TRIM(${field}) = ?`, [to, from]);

      // Carry the email across too, but ONLY when the target name has exactly
      // one on file. Matching elsewhere prefers email over name, so a merged
      // record with the old name's blank email would still be treated as a
      // different person -- and guessing between two addresses would file a
      // caseload under the wrong mailbox.
      let email_applied = null;
      try {
        const emails = await dbAll(
          `SELECT DISTINCT LOWER(TRIM(${meta.email_col})) AS email
             FROM clients
            WHERE TRIM(${field}) = ? AND ${meta.email_col} IS NOT NULL AND TRIM(${meta.email_col}) <> ''`,
          [to]);
        if (emails.length === 1) {
          await dbRun(
            `UPDATE clients SET ${meta.email_col} = ?
              WHERE TRIM(${field}) = ? AND (${meta.email_col} IS NULL OR TRIM(${meta.email_col}) = '')`,
            [emails[0].email, to]);
          email_applied = emails[0].email;
        }
      } catch (e) { /* the email column may not exist for this field */ }

      const after = await dbGet(`SELECT COUNT(*) AS n FROM clients WHERE TRIM(${field}) = ?`, [to]);
      json(res, 200, {
        ok: true, field, from, to,
        moved: Number(before.n) || 0,
        now_on: Number(after && after.n) || 0,
        email_applied,
      });
      return true;
    }

    if (pathname === "/api/caseload/bcbas" && method === "GET") {
      if (!canPick(user)) { json(res, 403, { error: "Not permitted" }); return true; }
      // GROUPED BY NAME ALONE. It used to group by name AND email, so a BCBA
      // with an address on some of her clients and none on the others came back
      // as two entries with the same name and her caseload split between them.
      // The email is reported as whichever one is on file; a person is one row.
      const rows = await dbAll(
        `SELECT TRIM(assigned_bcba_name) AS name,
                MIN(NULLIF(LOWER(TRIM(COALESCE(assigned_bcba_email,''))), '')) AS email,
                COUNT(*) AS clients
           FROM clients
          WHERE assigned_bcba_name IS NOT NULL AND TRIM(assigned_bcba_name) <> ''
            AND stage NOT IN ('discharged','not_moving_forward')
          GROUP BY TRIM(assigned_bcba_name)
          ORDER BY TRIM(assigned_bcba_name)`).catch(() => []);
      json(res, 200, { bcbas: rows.map((r) => ({ name: r.name, email: r.email || null, clients: Number(r.clients) || 0 })) });
      return true;
    }

    if (pathname === "/api/caseload/schedule" && method === "GET") {
      const bcba = await resolveBcba(user, query.bcba);
      // ?month=YYYY-MM for the calendar grid, ?date=YYYY-MM-DD for one day.
      // The day form is the original and stays the default, so nothing that
      // already calls this endpoint changes behaviour.
      if (query.month) {
        json(res, 200, await scheduleMonthFor(bcba, query.month));
        return true;
      }
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
    _internal: { urgency, tpUrgency, daysUntil, planDue, matchClients, matchStaff, buildMigrationPlan, isBcbaRole, canPick,
      scheduleFor, scheduleMonthFor },
  };
};
