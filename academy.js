// academy.js -- the Onboarding Academy. Thirty days of structured training a
// new clinician works through while already carrying a caseload.
//
// WHY THE CURRICULUM IS DATA AND NOT CODE.
//
// The brief asks for a four-week BCBA programme and, in its last line, for
// the same framework to serve RBT and Squad Leader onboarding later without
// disturbing the BCBA Hub. Those two sentences decide the whole shape of this
// file. A programme written as four hardcoded weeks is cheap today and a
// rewrite the first time somebody wants a second one; a programme stored as
// rows costs a seed function and nothing after that. So: programmes hold
// weeks, weeks hold modules, modules hold items, and the BCBA curriculum is
// simply the first row in that table.
//
// WHAT AN EMPLOYEE CANNOT DO TO THEIR OWN RECORD.
//
// Opening a document is not evidence of competence, and the brief says so
// outright. Items are therefore of two kinds and they behave differently:
//
//   * a READING or a CHECKLIST item the employee completes themselves, and
//     their acknowledgement is the record
//   * a COMPETENCY item the employee can only mark as ready for review. The
//     completion is written by the supervisor who verified it, and the
//     employee has no route to that status at all -- not a hidden button, not
//     an API they are refused, simply no path through the code
//
// That distinction is the reason this module exists rather than a checklist
// table with a done flag.
//
// WHAT IT DOES NOT TOUCH. Hours. Training time is planning information -- five
// suggested hours a week -- and the practice's worked hours come from Rethink,
// which knows nothing about training. Writing training time into anything that
// feeds PTO or billing would corrupt both, so it is recorded here and nowhere
// else, and it is never added to a figure that pays somebody.
"use strict";

module.exports = function initAcademy(ctx) {
  const { dbGet, dbAll, dbRun, nowISO, readBody, json } = ctx;
  const getAppSetting = ctx.getAppSetting || (async () => "");
  const sendEmail = ctx.sendEmail || (async () => ({}));
  const onCompletion = ctx.onCompletion || (() => {});

  // ---- vocabulary ---------------------------------------------------------
  const ITEM_KINDS = ["reading", "checklist", "competency", "quiz"];
  // The five statuses the brief names, in the order progress moves through
  // them. "Needs Additional Training" is not a failure state that ends
  // anything -- it sends an item back to the employee with a reason.
  const STATUSES = ["not_started", "in_progress", "awaiting_review", "completed", "needs_training"];
  const STATUS_LABELS = {
    not_started: "Not Started",
    in_progress: "In Progress",
    awaiting_review: "Awaiting Supervisor Review",
    completed: "Completed",
    needs_training: "Needs Additional Training",
  };
  // Statuses an EMPLOYEE may put an item into. Note what is missing.
  const EMPLOYEE_SETTABLE = ["in_progress", "awaiting_review", "completed"];
  const ENROLMENT_STATES = ["active", "paused", "completed", "withdrawn"];

  const clean = (v) => String(v == null ? "" : v).trim();
  const num = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(clean(v));
  const today = () => new Date().toISOString().slice(0, 10);
  const addDays = (d, n) => {
    const t = new Date(d + "T00:00:00Z");
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  };

  // ---- who is who ---------------------------------------------------------
  //
  // CLINICAL LEADERSHIP IS A DESIGNATION ON A PERSON, not an address in a
  // settings box. The CRM already had one of those -- clinical_director_email
  // -- and it answers "is this the Clinical Director" by comparing strings,
  // which stops being true the moment somebody changes their email. Approvals
  // outlive email addresses, so they are hung on the employee record.
  //
  // The old setting is still honoured as a FALLBACK so an install that has
  // never set a designation behaves as it did yesterday, and so this module
  // and bip.js cannot disagree about who the director is on day one.
  async function leadership() {
    const rows = await dbAll(
      `SELECT id, name, email, academy_leadership
         FROM hr_employees
        WHERE academy_leadership IN ('clinical_director','assistant_clinical_director')
          AND COALESCE(status,'active') <> 'terminated'
        ORDER BY name`
    ).catch(() => []);
    const out = {
      clinical_director: rows.find((r) => r.academy_leadership === "clinical_director") || null,
      assistants: rows.filter((r) => r.academy_leadership === "assistant_clinical_director"),
      from_setting: null,
    };
    if (!out.clinical_director) {
      const email = clean(await getAppSetting("clinical_director_email", ""));
      if (email) out.from_setting = email;
    }
    return out;
  }

  async function leadershipEmails() {
    const l = await leadership();
    const to = [];
    if (l.clinical_director && l.clinical_director.email) to.push(l.clinical_director.email);
    else if (l.from_setting) to.push(l.from_setting);
    for (const a of l.assistants) if (a.email) to.push(a.email);
    return [...new Set(to)];
  }

  // Who may approve a competency, or a whole onboarding. Owner and super_admin
  // are included because somebody has to be able to act when the director is
  // away, and an onboarding that cannot be signed off is an employee stuck.
  async function isClinicalLead(user) {
    if (!user) return false;
    if (["owner", "super_admin"].includes(user.role)) return true;
    const l = await leadership();
    const mine = clean(user.email).toLowerCase();
    if (l.clinical_director && clean(l.clinical_director.email).toLowerCase() === mine) return true;
    if (l.assistants.some((a) => clean(a.email).toLowerCase() === mine)) return true;
    if (l.from_setting && clean(l.from_setting).toLowerCase() === mine) return true;
    return false;
  }

  // The employee record behind a login. Email is the join the rest of the CRM
  // already uses.
  async function employeeFor(user) {
    if (!user || !user.email) return null;
    return await dbGet(
      `SELECT id, name, email, role_title, academy_leadership,
              COALESCE(NULLIF(hr_hire_date,''), NULLIF(hire_date,'')) AS hire_date,
              COALESCE(status,'active') AS status
         FROM hr_employees WHERE LOWER(email) = ? ORDER BY id LIMIT 1`,
      [clean(user.email).toLowerCase()]
    ).catch(() => null);
  }

  // ---- schema -------------------------------------------------------------
  async function initTables() {
    await dbRun("ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS academy_leadership TEXT").catch(() => {});

    // A PROGRAMME is the reusable unit: "BCBA 30-Day Onboarding" today, "RBT
    // Onboarding" later, with no change to anything below it.
    await dbRun(`CREATE TABLE IF NOT EXISTS academy_programs (
      id SERIAL PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      role_target TEXT,                  -- which role_title this is for, e.g. BCBA
      weeks INTEGER NOT NULL DEFAULT 4,
      duration_days INTEGER NOT NULL DEFAULT 30,
      weekly_hours_target NUMERIC DEFAULT 5,
      version INTEGER NOT NULL DEFAULT 1,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TEXT, updated_at TEXT
    )`).catch((e) => console.error("academy_programs:", e.message));

    await dbRun(`CREATE TABLE IF NOT EXISTS academy_modules (
      id SERIAL PRIMARY KEY,
      program_id INTEGER NOT NULL,
      week INTEGER NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      focus TEXT,
      body TEXT,
      video_url TEXT,                    -- EMBEDDED, not hosted. See the note on uploads.
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TEXT, updated_at TEXT
    )`).catch((e) => console.error("academy_modules:", e.message));

    await dbRun(`CREATE TABLE IF NOT EXISTS academy_items (
      id SERIAL PRIMARY KEY,
      module_id INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'reading',
      title TEXT NOT NULL,
      detail TEXT,
      required BOOLEAN NOT NULL DEFAULT TRUE,
      position INTEGER NOT NULL DEFAULT 0,
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TEXT
    )`).catch((e) => console.error("academy_items:", e.message));

    // ONE ENROLMENT PER PERSON PER PROGRAMME, enforced at the table rather
    // than checked in code: the auto-assignment runs on a schedule and on
    // employee creation, and "do not overwrite onboarding records for
    // existing employees" has to survive both of them racing.
    await dbRun(`CREATE TABLE IF NOT EXISTS academy_enrollments (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      program_id INTEGER NOT NULL,
      program_version INTEGER NOT NULL DEFAULT 1,
      start_date TEXT NOT NULL,
      due_date TEXT,
      mentor_id INTEGER,
      state TEXT NOT NULL DEFAULT 'active',
      paused_at TEXT,
      completed_at TEXT,
      approved_by TEXT,
      created_by TEXT,
      created_at TEXT, updated_at TEXT
    )`).catch((e) => console.error("academy_enrollments:", e.message));
    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS academy_enrol_one
                 ON academy_enrollments (employee_id, program_id)`).catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS academy_progress (
      id SERIAL PRIMARY KEY,
      enrollment_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'not_started',
      employee_note TEXT,
      acknowledged_at TEXT,
      verified_by TEXT,
      verified_at TEXT,
      reviewer_note TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("academy_progress:", e.message));
    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS academy_progress_one
                 ON academy_progress (enrollment_id, item_id)`).catch(() => {});

    // THE AUDIT TRAIL. Every status change, who made it and when. A
    // competency approval that cannot be traced to a person is not an
    // approval, and the brief asks for exactly this.
    await dbRun(`CREATE TABLE IF NOT EXISTS academy_audit (
      id SERIAL PRIMARY KEY,
      enrollment_id INTEGER,
      item_id INTEGER,
      action TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      actor TEXT,
      note TEXT,
      created_at TEXT
    )`).catch((e) => console.error("academy_audit:", e.message));

    await seedBcbaProgram();
  }

  async function audit(enrollmentId, itemId, action, from, to, actor, note) {
    await dbRun(
      `INSERT INTO academy_audit (enrollment_id, item_id, action, from_status, to_status, actor, note, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [enrollmentId || null, itemId || null, action, from || null, to || null, actor || null, note || null, nowISO()]
    ).catch(() => {});
  }

  // ---- the BCBA curriculum, as seed data ----------------------------------
  //
  // Seeded ONCE and never re-seeded. Leadership edits the curriculum through
  // the CRM afterwards, and a boot that quietly restored the original wording
  // would undo their work every deploy.
  const BCBA_WEEKS = [
    {
      week: 1,
      title: "Welcome to the Squad",
      focus: "Company culture, systems and expectations",
      topics: [
        "Spectrum Squad mission, values and organisational structure",
        "BCBA job responsibilities and performance expectations",
        "Introduction to clinical leadership and your assigned mentor",
        "Employee handbook and clinical policies",
        "Communication expectations and professional boundaries",
        "ClassDojo communication procedures",
        "Rethink account navigation",
        "Homebase and CRM navigation",
        "Caseload assignments and client introductions",
        "Clinic operations and safety procedures",
        "Scheduling procedures and attendance expectations",
      ],
      competency: "Navigate the required company systems, locate essential policies, identify the right points of contact, and describe your assigned caseload responsibilities.",
    },
    {
      week: 2,
      title: "Clinical Systems & Compliance",
      focus: "Documentation, authorisations and clinical accuracy",
      topics: [
        "Rethink clinical documentation",
        "Session note completion and verification",
        "Same-day documentation expectations",
        "Authorization management",
        "Approved units and service limitations",
        "Treatment plan requirements",
        "Assessment procedures",
        "Clinical documentation compliance",
        "Insurance-specific requirements",
        "Billing codes and documentation accuracy",
        "Parent training documentation",
        "Internal audits and corrective action procedures",
      ],
      competency: "Complete a mock documentation review, demonstrating accurate session verification, authorization tracking and clinical documentation.",
    },
    {
      week: 3,
      title: "BCBA Leadership & Squad Management",
      focus: "Supervision, communication and team leadership",
      topics: [
        "BCBA leadership expectations",
        "RBT supervision procedures",
        "Giving constructive feedback",
        "Professional communication",
        "Parent and caregiver communication",
        "Caseload management",
        "Scheduling and coordination",
        "Addressing employee concerns",
        "Clinical problem-solving",
        "Supporting RBT professional development",
        "Managing interruptions and protecting clinical focus",
        "Clinical escalation procedures",
        "Collaboration with clinical leadership",
      ],
      competency: "Demonstrate supervision, feedback delivery, communication and clinical leadership through observation or role-play.",
    },
    {
      week: 4,
      title: "Independent Practice & Competency",
      focus: "Demonstrating readiness and accountability",
      topics: [
        "Independent caseload management",
        "Clinical documentation review",
        "Authorization monitoring",
        "RBT supervision",
        "Caregiver collaboration",
        "Clinical decision-making",
        "Company policy compliance",
        "Clinical workflow efficiency",
        "Identifying areas for continued development",
      ],
      competency: "Complete the final onboarding assessment and demonstrate the ability to independently fulfil BCBA responsibilities to Spectrum Squad expectations.",
    },
  ];

  async function seedBcbaProgram() {
    const existing = await dbGet("SELECT id FROM academy_programs WHERE key = ?", ["bcba-30day"]).catch(() => null);
    if (existing) return existing.id;
    const prog = await dbGet(
      `INSERT INTO academy_programs (key, name, role_target, weeks, duration_days, weekly_hours_target, version, active, created_at, updated_at)
       VALUES ('bcba-30day','BCBA 30-Day Onboarding Academy','BCBA',4,30,5,1,TRUE,?,?) RETURNING id`,
      [nowISO(), nowISO()]
    ).catch(() => null);
    if (!prog) return null;

    for (const w of BCBA_WEEKS) {
      const mod = await dbGet(
        `INSERT INTO academy_modules (program_id, week, position, title, focus, body, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?) RETURNING id`,
        [prog.id, w.week, 0, w.title, w.focus,
         "Work through each topic below with your mentor. Tick each one as you cover it.", nowISO(), nowISO()]
      ).catch(() => null);
      if (!mod) continue;
      let pos = 0;
      for (const t of w.topics) {
        await dbRun(
          `INSERT INTO academy_items (module_id, kind, title, required, position, created_at)
           VALUES (?,'checklist',?,TRUE,?,?)`,
          [mod.id, t, pos++, nowISO()]
        ).catch(() => {});
      }
      // The competency is the LAST item and the only one the employee cannot
      // complete for themselves.
      await dbRun(
        `INSERT INTO academy_items (module_id, kind, title, detail, required, position, created_at)
         VALUES (?,'competency',?,?,TRUE,?,?)`,
        [mod.id, `Week ${w.week} competency`, w.competency, pos++, nowISO()]
      ).catch(() => {});
    }
    return prog.id;
  }

  // ---- enrolment ----------------------------------------------------------
  //
  // Created on the employee's FIRST DAY, not the day the record was typed in.
  // A BCBA added to the CRM three weeks before they start should not be a week
  // behind on their first morning.
  async function enrol(employee, { programKey = "bcba-30day", actor = null, startDate = null } = {}) {
    if (!employee || !employee.id) return { ok: false, error: "No such employee." };
    const prog = await dbGet("SELECT * FROM academy_programs WHERE key = ? AND active = TRUE", [programKey]).catch(() => null);
    if (!prog) return { ok: false, error: "That programme does not exist." };

    const existing = await dbGet(
      "SELECT * FROM academy_enrollments WHERE employee_id = ? AND program_id = ?", [employee.id, prog.id]
    ).catch(() => null);
    // NOT AN ERROR AND NOT AN OVERWRITE. The brief is explicit that existing
    // records must survive, and this path runs automatically.
    if (existing) return { ok: true, already: true, enrollment: existing };

    const start = isDate(startDate) ? startDate
      : (isDate(employee.hire_date) ? employee.hire_date : today());
    const row = await dbGet(
      `INSERT INTO academy_enrollments
         (employee_id, program_id, program_version, start_date, due_date, state, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?, 'active', ?,?,?) RETURNING *`,
      [employee.id, prog.id, prog.version, start, addDays(start, prog.duration_days), actor || "system", nowISO(), nowISO()]
    ).catch(() => null);
    if (!row) return { ok: false, error: "The onboarding record could not be created." };

    await audit(row.id, null, "enrolled", null, "active", actor || "system", `${prog.name}, starting ${start}`);

    const to = await leadershipEmails();
    if (to.length) {
      await sendEmail({
        to: to.join(","),
        subject: `Onboarding started — ${employee.name}`,
        html: `<p><strong>${employee.name}</strong> has been enrolled in the ${prog.name}.</p>
               <p>Start date: ${start}. Due: ${addDays(start, prog.duration_days)}.</p>
               <p>No mentor is assigned yet — assign one from the Academy screen in the BCBA Hub.</p>`,
        type: "academy_enrolled", refType: "academy_enrollment", refId: row.id,
      }).catch(() => {});
    }
    return { ok: true, enrollment: row, program: prog };
  }

  // The automatic sweep. Runs on boot and on a schedule rather than hooking
  // employee creation, because a hire date is routinely filled in AFTER the
  // record is first saved and a one-shot hook would miss every one of those.
  async function autoEnrolSweep(actor = "auto") {
    const progs = await dbAll("SELECT * FROM academy_programs WHERE active = TRUE AND role_target IS NOT NULL").catch(() => []);
    const out = [];
    for (const prog of progs) {
      const people = await dbAll(
        `SELECT e.id, e.name, e.email, e.role_title,
                COALESCE(NULLIF(e.hr_hire_date,''), NULLIF(e.hire_date,'')) AS hire_date
           FROM hr_employees e
          WHERE COALESCE(e.status,'active') = 'active'
            AND e.role_title ILIKE ?
            AND COALESCE(NULLIF(e.hr_hire_date,''), NULLIF(e.hire_date,'')) IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM academy_enrollments a
                             WHERE a.employee_id = e.id AND a.program_id = ?)`,
        ["%" + prog.role_target + "%", prog.id]
      ).catch(() => []);
      for (const p of people) {
        // Only people who have actually started. Enrolling a future hire
        // would start their clock before their first day.
        if (!isDate(p.hire_date) || p.hire_date > today()) continue;
        // And only RECENT starts, so switching this on does not enrol every
        // BCBA who has been here three years.
        if (addDays(p.hire_date, prog.duration_days * 3) < today()) continue;
        const r = await enrol(p, { programKey: prog.key, actor });
        if (r.ok && !r.already) out.push({ employee_id: p.id, name: p.name });
      }
    }
    return out;
  }

  // ---- progress -----------------------------------------------------------
  async function itemsFor(programId) {
    return await dbAll(
      `SELECT i.*, m.week, m.title AS module_title, m.position AS module_position
         FROM academy_items i JOIN academy_modules m ON m.id = i.module_id
        WHERE m.program_id = ? AND i.archived = FALSE AND m.archived = FALSE
        ORDER BY m.week, m.position, i.position, i.id`,
      [programId]
    ).catch(() => []);
  }

  async function progressFor(enrollment) {
    const items = await itemsFor(enrollment.program_id);
    const rows = await dbAll("SELECT * FROM academy_progress WHERE enrollment_id = ?", [enrollment.id]).catch(() => []);
    const byItem = new Map(rows.map((r) => [Number(r.item_id), r]));
    const merged = items.map((i) => {
      const p = byItem.get(Number(i.id));
      return {
        item_id: i.id, module_id: i.module_id, week: i.week, module_title: i.module_title,
        kind: i.kind, title: i.title, detail: i.detail, required: i.required !== false,
        status: (p && p.status) || "not_started",
        status_label: STATUS_LABELS[(p && p.status) || "not_started"],
        acknowledged_at: (p && p.acknowledged_at) || null,
        verified_by: (p && p.verified_by) || null,
        verified_at: (p && p.verified_at) || null,
        reviewer_note: (p && p.reviewer_note) || null,
      };
    });
    const required = merged.filter((m) => m.required);
    const done = required.filter((m) => m.status === "completed").length;
    const weeks = [];
    for (let w = 1; w <= 8; w++) {
      const inWeek = merged.filter((m) => Number(m.week) === w);
      if (!inWeek.length) continue;
      const req = inWeek.filter((m) => m.required);
      weeks.push({
        week: w,
        title: (inWeek[0] && inWeek[0].module_title) || `Week ${w}`,
        total: req.length,
        completed: req.filter((m) => m.status === "completed").length,
        awaiting_review: inWeek.filter((m) => m.status === "awaiting_review").length,
        needs_training: inWeek.filter((m) => m.status === "needs_training").length,
      });
    }
    return {
      items: merged,
      weeks,
      total: required.length,
      completed: done,
      // Rounded for reading only. The gate on final approval reads the counts.
      percent: required.length ? Math.round((done / required.length) * 100) : 0,
      awaiting_review: merged.filter((m) => m.status === "awaiting_review").length,
      needs_training: merged.filter((m) => m.status === "needs_training").length,
      // A DAY NUMBER, not a week number: somebody on day 9 is in week 2 even
      // if they have not opened it.
      day: Math.max(1, Math.round((new Date(today()) - new Date(enrollment.start_date)) / 86400000) + 1),
    };
  }

  // =====================================================================
  // THE API
  //
  // Permission is decided HERE, on the server, for every route. The screen
  // hides what somebody cannot do, but hiding is decoration: the brief says
  // enforce on the backend and not only in the interface, and every route
  // below answers the question itself.
  // =====================================================================
  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/academy")) return false;
    if (!user) { json(res, 401, { error: "Please sign in." }); return true; }

    const me = await employeeFor(user);
    const lead = await isClinicalLead(user);
    const owner = ["owner", "super_admin"].includes(user.role);
    const actor = (user && (user.name || user.email)) || "unknown";

    // ---- who clinical leadership is ------------------------------------
    if (pathname === "/api/academy/leadership" && method === "GET") {
      const l = await leadership();
      json(res, 200, {
        clinical_director: l.clinical_director,
        assistants: l.assistants,
        // Shown so somebody can see the CRM is still falling back to the old
        // setting, rather than wondering why nobody is named.
        from_setting: l.from_setting,
        can_assign: owner,
      });
      return true;
    }

    const leadMatch = pathname.match(/^\/api\/academy\/leadership\/(\d+)$/);
    if (leadMatch && method === "PUT") {
      // NAMING CLINICAL LEADERSHIP IS AN OWNER ACT. It hands somebody the
      // power to sign off competencies and approve an onboarding, which is
      // not a thing a clinical lead should be able to grant themselves.
      if (!owner) { json(res, 403, { error: "Only the owner can name clinical leadership." }); return true; }
      const id = Number(leadMatch[1]);
      const b = await readBody(req).catch(() => ({}));
      const role = clean(b.leadership);
      if (!["clinical_director", "assistant_clinical_director", ""].includes(role)) {
        json(res, 400, { error: "That is not a leadership designation." }); return true;
      }
      const emp = await dbGet("SELECT id, name FROM hr_employees WHERE id = ?", [id]).catch(() => null);
      if (!emp) { json(res, 404, { error: "No such employee." }); return true; }
      // ONE CLINICAL DIRECTOR. Two would make "the Clinical Director
      // approved it" ambiguous in the audit trail, which is the one place it
      // must not be.
      if (role === "clinical_director") {
        await dbRun("UPDATE hr_employees SET academy_leadership = NULL WHERE academy_leadership = 'clinical_director' AND id <> ?", [id]).catch(() => {});
      }
      await dbRun("UPDATE hr_employees SET academy_leadership = ? WHERE id = ?", [role || null, id]);
      await audit(null, null, "leadership_set", null, role || "none", actor, emp.name);
      json(res, 200, { ok: true, leadership: await leadership() });
      return true;
    }

    // ---- the employee's own academy -------------------------------------
    if (pathname === "/api/academy/me" && method === "GET") {
      if (!me) { json(res, 200, { enrolled: false, reason: "no_employee_record" }); return true; }
      const enr = await dbGet(
        `SELECT a.*, p.name AS program_name, p.weeks, p.weekly_hours_target
           FROM academy_enrollments a JOIN academy_programs p ON p.id = a.program_id
          WHERE a.employee_id = ? ORDER BY a.id DESC LIMIT 1`, [me.id]).catch(() => null);
      if (!enr) { json(res, 200, { enrolled: false, reason: "not_enrolled" }); return true; }
      const mentor = enr.mentor_id
        ? await dbGet("SELECT id, name, email, role_title FROM hr_employees WHERE id = ?", [enr.mentor_id]).catch(() => null)
        : null;
      json(res, 200, {
        enrolled: true, enrollment: enr, mentor,
        leadership: await leadership(),
        progress: await progressFor(enr),
      });
      return true;
    }

    // Moving one item along. The employee's own route.
    const itemMatch = pathname.match(/^\/api\/academy\/items\/(\d+)$/);
    if (itemMatch && method === "POST") {
      if (!me) { json(res, 403, { error: "No employee record is linked to this account." }); return true; }
      const itemId = Number(itemMatch[1]);
      const b = await readBody(req).catch(() => ({}));
      const want = clean(b.status);

      const enr = await dbGet(
        "SELECT * FROM academy_enrollments WHERE employee_id = ? ORDER BY id DESC LIMIT 1", [me.id]).catch(() => null);
      if (!enr) { json(res, 404, { error: "You are not enrolled in an onboarding programme." }); return true; }
      if (enr.state === "paused") { json(res, 400, { error: "Your onboarding is paused. Speak to clinical leadership." }); return true; }

      // The item must belong to the programme this person is enrolled in.
      // Without this check an item id from another programme would write a
      // progress row that nothing ever reads and that inflates nothing --
      // but it would appear in the audit trail as work they did.
      const item = await dbGet(
        `SELECT i.*, m.program_id FROM academy_items i JOIN academy_modules m ON m.id = i.module_id
          WHERE i.id = ?`, [itemId]).catch(() => null);
      if (!item || Number(item.program_id) !== Number(enr.program_id)) {
        json(res, 404, { error: "That item is not part of your programme." }); return true;
      }

      if (!EMPLOYEE_SETTABLE.includes(want)) {
        json(res, 400, { error: "That is not a status you can set." }); return true;
      }

      // THE RULE THE WHOLE MODULE EXISTS FOR.
      //
      // A competency is demonstrated to somebody, and the person it was
      // demonstrated to records it. An employee may say they are READY --
      // that is awaiting_review -- and there is no path from here to
      // completed for them. Not a hidden button: no code.
      if (item.kind === "competency" && want === "completed") {
        json(res, 400, {
          error: "A competency is signed off by your supervisor, not completed by you. Mark it ready for review instead.",
        });
        return true;
      }

      const before = await dbGet(
        "SELECT * FROM academy_progress WHERE enrollment_id = ? AND item_id = ?", [enr.id, itemId]).catch(() => null);
      // A SUPERVISOR'S DECISION IS NOT UNDONE BY THE PERSON IT WAS ABOUT.
      if (before && before.status === "completed" && before.verified_by) {
        json(res, 400, { error: "That has already been signed off by your supervisor." }); return true;
      }

      await dbRun(
        `INSERT INTO academy_progress (enrollment_id, item_id, status, employee_note, acknowledged_at, updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT (enrollment_id, item_id) DO UPDATE SET
           status = EXCLUDED.status, employee_note = EXCLUDED.employee_note,
           acknowledged_at = EXCLUDED.acknowledged_at, updated_at = EXCLUDED.updated_at`,
        [enr.id, itemId, want, clean(b.note) || null,
         want === "completed" || want === "awaiting_review" ? nowISO() : null, nowISO()]
      );
      await audit(enr.id, itemId, "employee_status", before ? before.status : "not_started", want, actor, clean(b.note) || null);

      if (want === "awaiting_review") {
        const to = enr.mentor_id
          ? (await dbGet("SELECT email FROM hr_employees WHERE id = ?", [enr.mentor_id]).catch(() => null) || {}).email
          : null;
        const recipients = [...new Set([to, ...(await leadershipEmails())].filter(Boolean))];
        if (recipients.length) {
          await sendEmail({
            to: recipients.join(","),
            subject: `Competency ready for review — ${me.name}`,
            html: `<p><strong>${me.name}</strong> has marked a competency ready for review.</p>
                   <p>${item.title}</p>
                   <p>Review it on the Onboarding Academy screen in the BCBA Hub.</p>`,
            type: "academy_review_due", refType: "academy_enrollment", refId: enr.id,
          }).catch(() => {});
        }
      }
      json(res, 200, { ok: true, progress: await progressFor(enr) });
      return true;
    }

    // ---- the supervisor's side ------------------------------------------
    const revMatch = pathname.match(/^\/api\/academy\/enrollments\/(\d+)\/items\/(\d+)$/);
    if (revMatch && method === "POST") {
      const enrId = Number(revMatch[1]);
      const itemId = Number(revMatch[2]);
      const enr = await dbGet("SELECT * FROM academy_enrollments WHERE id = ?", [enrId]).catch(() => null);
      if (!enr) { json(res, 404, { error: "No such onboarding record." }); return true; }

      // A MENTOR MAY VERIFY THEIR OWN MENTEE; clinical leadership may verify
      // anybody. Nobody else, and notably not the employee: even if their own
      // employee id happened to be the mentor id, the check below is about
      // who is ASKING, and the employee is asking about themselves.
      const mentorHere = !!(me && enr.mentor_id && Number(enr.mentor_id) === Number(me.id));
      const isSubject = !!(me && Number(enr.employee_id) === Number(me.id));
      if (isSubject || !(lead || mentorHere)) {
        json(res, 403, { error: "Only the assigned mentor or clinical leadership can review this." }); return true;
      }

      const b = await readBody(req).catch(() => ({}));
      const want = clean(b.status);
      if (!["completed", "needs_training", "in_progress"].includes(want)) {
        json(res, 400, { error: "A review records completed, needs additional training, or sends it back in progress." });
        return true;
      }
      const item = await dbGet(
        `SELECT i.*, m.program_id FROM academy_items i JOIN academy_modules m ON m.id = i.module_id WHERE i.id = ?`,
        [itemId]).catch(() => null);
      if (!item || Number(item.program_id) !== Number(enr.program_id)) {
        json(res, 404, { error: "That item is not part of this programme." }); return true;
      }
      // Sending something back has to say why. "Needs additional training"
      // with no reason is a dead end for the person receiving it.
      if (want === "needs_training" && !clean(b.note)) {
        json(res, 400, { error: "Say what additional training is needed." }); return true;
      }

      const before = await dbGet(
        "SELECT * FROM academy_progress WHERE enrollment_id = ? AND item_id = ?", [enrId, itemId]).catch(() => null);
      await dbRun(
        `INSERT INTO academy_progress (enrollment_id, item_id, status, verified_by, verified_at, reviewer_note, updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT (enrollment_id, item_id) DO UPDATE SET
           status = EXCLUDED.status, verified_by = EXCLUDED.verified_by,
           verified_at = EXCLUDED.verified_at, reviewer_note = EXCLUDED.reviewer_note,
           updated_at = EXCLUDED.updated_at`,
        [enrId, itemId, want, want === "completed" ? actor : null,
         want === "completed" ? nowISO() : null, clean(b.note) || null, nowISO()]
      );
      await audit(enrId, itemId, "review", before ? before.status : "not_started", want, actor, clean(b.note) || null);

      const emp = await dbGet("SELECT name, email FROM hr_employees WHERE id = ?", [enr.employee_id]).catch(() => null);
      if (emp && emp.email) {
        await sendEmail({
          to: emp.email,
          subject: want === "completed" ? "A competency has been signed off" : "More training on one item",
          html: `<p>${item.title}</p>
                 <p>${want === "completed" ? "Signed off by " + actor + "." : "Marked as needing more training."}</p>
                 ${clean(b.note) ? `<p>${clean(b.note)}</p>` : ""}`,
          type: "academy_reviewed", refType: "academy_enrollment", refId: enrId,
        }).catch(() => {});
      }
      json(res, 200, { ok: true, progress: await progressFor(enr) });
      return true;
    }

    // ---- leadership dashboard -------------------------------------------
    if (pathname === "/api/academy/enrollments" && method === "GET") {
      // A mentor sees their own mentees; leadership sees everyone. Anybody
      // else sees nothing, rather than an empty list that looks like a bug.
      if (!lead && !me) { json(res, 403, { error: "Not permitted" }); return true; }
      const rows = await dbAll(
        `SELECT a.*, e.name, e.email, e.role_title, p.name AS program_name,
                m.name AS mentor_name
           FROM academy_enrollments a
           JOIN hr_employees e ON e.id = a.employee_id
           JOIN academy_programs p ON p.id = a.program_id
           LEFT JOIN hr_employees m ON m.id = a.mentor_id
          ORDER BY (a.state = 'active') DESC, a.start_date DESC`
      ).catch(() => []);
      const visible = lead ? rows : rows.filter((r) => Number(r.mentor_id) === Number(me.id));
      const out = [];
      for (const r of visible) {
        const pr = await progressFor(r);
        out.push({
          ...r, percent: pr.percent, completed: pr.completed, total: pr.total,
          awaiting_review: pr.awaiting_review, needs_training: pr.needs_training,
          day: pr.day, current_week: Math.min(Math.ceil(pr.day / 7), r.weeks || 4),
        });
      }
      json(res, 200, { enrollments: out, can_manage: lead, is_owner: owner });
      return true;
    }

    const oneMatch = pathname.match(/^\/api\/academy\/enrollments\/(\d+)$/);
    if (oneMatch && method === "GET") {
      const enr = await dbGet(
        `SELECT a.*, e.name, e.email, e.role_title, p.name AS program_name, p.weeks
           FROM academy_enrollments a
           JOIN hr_employees e ON e.id = a.employee_id
           JOIN academy_programs p ON p.id = a.program_id
          WHERE a.id = ?`, [Number(oneMatch[1])]).catch(() => null);
      if (!enr) { json(res, 404, { error: "No such onboarding record." }); return true; }
      const mentorHere = !!(me && enr.mentor_id && Number(enr.mentor_id) === Number(me.id));
      const isSubject = !!(me && Number(enr.employee_id) === Number(me.id));
      if (!(lead || mentorHere || isSubject)) { json(res, 403, { error: "Not permitted" }); return true; }
      const audits = await dbAll(
        "SELECT * FROM academy_audit WHERE enrollment_id = ? ORDER BY id DESC LIMIT 200", [enr.id]).catch(() => []);
      json(res, 200, { enrollment: enr, progress: await progressFor(enr), audit: audits, can_manage: lead });
      return true;
    }

    if (pathname === "/api/academy/enrollments" && method === "POST") {
      if (!lead) { json(res, 403, { error: "Only clinical leadership can start an onboarding." }); return true; }
      const b = await readBody(req).catch(() => ({}));
      const id = num(b.employee_id);
      if (!id) { json(res, 400, { error: "Choose an employee." }); return true; }
      const emp = await dbGet(
        `SELECT id, name, email, role_title,
                COALESCE(NULLIF(hr_hire_date,''), NULLIF(hire_date,'')) AS hire_date
           FROM hr_employees WHERE id = ?`, [id]).catch(() => null);
      if (!emp) { json(res, 404, { error: "No such employee." }); return true; }
      const r = await enrol(emp, { programKey: clean(b.program_key) || "bcba-30day", actor, startDate: b.start_date });
      json(res, r.ok ? 200 : 400, r);
      return true;
    }

    if (oneMatch && method === "PATCH") {
      if (!lead) { json(res, 403, { error: "Only clinical leadership can change an onboarding." }); return true; }
      const enrId = Number(oneMatch[1]);
      const enr = await dbGet("SELECT * FROM academy_enrollments WHERE id = ?", [enrId]).catch(() => null);
      if (!enr) { json(res, 404, { error: "No such onboarding record." }); return true; }
      const b = await readBody(req).catch(() => ({}));
      const sets = [], vals = [];

      if (b.mentor_id !== undefined) {
        const mid = b.mentor_id === null ? null : num(b.mentor_id);
        if (b.mentor_id !== null && !mid) { json(res, 400, { error: "That is not an employee." }); return true; }
        // A PERSON CANNOT MENTOR THEMSELVES. It would make every one of their
        // own competencies self-signed, which is the thing the split between
        // employee and reviewer exists to prevent.
        if (mid && Number(mid) === Number(enr.employee_id)) {
          json(res, 400, { error: "Somebody cannot be their own mentor." }); return true;
        }
        sets.push("mentor_id = ?"); vals.push(mid);
      }
      if (b.state !== undefined) {
        if (!ENROLMENT_STATES.includes(clean(b.state))) { json(res, 400, { error: "Unknown state." }); return true; }
        sets.push("state = ?"); vals.push(clean(b.state));
        sets.push("paused_at = ?"); vals.push(clean(b.state) === "paused" ? nowISO() : null);
      }
      if (b.due_date !== undefined) {
        if (!isDate(b.due_date)) { json(res, 400, { error: "That is not a date." }); return true; }
        sets.push("due_date = ?"); vals.push(clean(b.due_date));
      }
      if (b.start_date !== undefined) {
        if (!isDate(b.start_date)) { json(res, 400, { error: "That is not a date." }); return true; }
        sets.push("start_date = ?"); vals.push(clean(b.start_date));
      }
      if (!sets.length) { json(res, 400, { error: "Nothing to change." }); return true; }
      sets.push("updated_at = ?"); vals.push(nowISO());
      vals.push(enrId);
      await dbRun(`UPDATE academy_enrollments SET ${sets.join(", ")} WHERE id = ?`, vals);
      await audit(enrId, null, "enrollment_changed", enr.state, clean(b.state) || enr.state, actor,
                  Object.keys(b).join(", "));

      if (b.mentor_id) {
        const mentor = await dbGet("SELECT name, email FROM hr_employees WHERE id = ?", [num(b.mentor_id)]).catch(() => null);
        const emp = await dbGet("SELECT name FROM hr_employees WHERE id = ?", [enr.employee_id]).catch(() => null);
        if (mentor && mentor.email) {
          await sendEmail({
            to: mentor.email,
            subject: `You are mentoring ${emp ? emp.name : "a new BCBA"}`,
            html: `<p>You have been assigned as onboarding mentor for <strong>${emp ? emp.name : "a new BCBA"}</strong>.</p>
                   <p>Their Academy progress and questions are on the Onboarding Academy screen in the BCBA Hub.</p>`,
            type: "academy_mentor_assigned", refType: "academy_enrollment", refId: enrId,
          }).catch(() => {});
        }
      }
      json(res, 200, { ok: true });
      return true;
    }

    // ---- the curriculum, for anybody who can see the hub -----------------
    if (pathname === "/api/academy/curriculum" && method === "GET") {
      const prog = await dbGet("SELECT * FROM academy_programs WHERE key = ?",
                               [clean(query && query.program) || "bcba-30day"]).catch(() => null);
      if (!prog) { json(res, 404, { error: "No such programme." }); return true; }
      const mods = await dbAll(
        "SELECT * FROM academy_modules WHERE program_id = ? AND archived = FALSE ORDER BY week, position",
        [prog.id]).catch(() => []);
      const items = await itemsFor(prog.id);
      json(res, 200, {
        program: prog,
        modules: mods.map((m) => ({ ...m, items: items.filter((i) => Number(i.module_id) === Number(m.id)) })),
      });
      return true;
    }

    return false;
  }

  return {
    initTables, handleApi, enrol, autoEnrolSweep, leadership, leadershipEmails, isClinicalLead,
    employeeFor, progressFor, itemsFor, seedBcbaProgram,
    _internal: { STATUSES, STATUS_LABELS, EMPLOYEE_SETTABLE, ITEM_KINDS, ENROLMENT_STATES, BCBA_WEEKS, addDays },
  };
};
