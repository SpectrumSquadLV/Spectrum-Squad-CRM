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
  const crypto = ctx.crypto || require("crypto");
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
  // Free text typed by a human, going into an HTML email. A review summary
  // with a "<" in it would otherwise arrive with a chunk missing.
  const h = (v) => clean(v).replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
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

    // ---- THE CURRICULUM IS VERSIONED, AND THAT IS NOT A NICETY ----------
    //
    // The brief requires that the version of the curriculum each employee
    // completed be preserved. Until now the enrolment recorded a
    // program_version that NOTHING READ: every screen rebuilt the curriculum
    // from the current rows, so the moment anybody edited a week, the record
    // of what people had already finished changed under them. Harmless while
    // nothing could edit a curriculum -- and curriculum management, below, is
    // exactly the thing that makes it live.
    //
    // So a module and an item each hold the range of programme versions they
    // belong to: version_from, and version_to which is NULL while current.
    // Editing a programme somebody is enrolled on does not change a row; it
    // closes the old one and opens a new one at the next version. Somebody
    // enrolled at version 1 keeps reading version 1 for ever, including the
    // week that was rewritten after they finished it.
    for (const t of ["academy_modules", "academy_items"]) {
      await dbRun(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS version_from INTEGER NOT NULL DEFAULT 1`).catch(() => {});
      await dbRun(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS version_to INTEGER`).catch(() => {});
    }
    // Anything archived before versioning existed is closed off at the
    // current version rather than left looking live at version 1.
    await dbRun(
      `UPDATE academy_modules m SET version_to = p.version
         FROM academy_programs p
        WHERE p.id = m.program_id AND m.archived = TRUE AND m.version_to IS NULL`).catch(() => {});
    await dbRun(
      `UPDATE academy_items i SET version_to = p.version
         FROM academy_modules m JOIN academy_programs p ON p.id = m.program_id
        WHERE m.id = i.module_id AND i.archived = TRUE AND i.version_to IS NULL`).catch(() => {});

    // ---- THE TRAINING LIBRARY -------------------------------------------
    //
    // What somebody reads or watches for a week, hanging off the module or
    // off one item. Deliberately NOT versioned itself: a resource belongs to
    // a module row or an item row, and those are already version-scoped, so
    // a fork copies the attachments across with everything else and an old
    // enrolment keeps the links it was given.
    //
    // A DOCUMENT IS A POINTER, NOT A COPY. The CRM already has a policy and
    // SOP library with its own versions, amendments and acknowledgments;
    // pasting an SOP's text into a training week would create a second copy
    // that stops matching the first the day it is amended. So a document
    // resource holds a policy_id and the library stays the one source.
    //
    // A VIDEO IS AN EMBEDDED LINK. The CRM's upload path is base64 inside a
    // JSON body capped at 15MB, and a ten-minute training video is several
    // times that, so hosting them here would fail at the worst moment. Loom,
    // YouTube and Vimeo already solve it.
    await dbRun(`CREATE TABLE IF NOT EXISTS academy_resources (
      id SERIAL PRIMARY KEY,
      module_id INTEGER,
      item_id INTEGER,
      kind TEXT NOT NULL DEFAULT 'link',
      title TEXT NOT NULL,
      url TEXT,
      policy_id INTEGER,
      body TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at TEXT
    )`).catch((e) => console.error("academy_resources:", e.message));
    await dbRun("CREATE INDEX IF NOT EXISTS academy_res_module ON academy_resources (module_id)").catch(() => {});
    await dbRun("CREATE INDEX IF NOT EXISTS academy_res_item ON academy_resources (item_id)").catch(() => {});

    // ---- TRAINING HOURS, KEPT AWAY FROM BILLABLE ------------------------
    //
    // The brief: track training hours separately from clinical billable
    // hours. Separately is the whole requirement, so these live in their own
    // table that nothing in billing, the timecard or the Rethink sync reads
    // or writes. A training hour cannot become a billable hour by accident
    // because there is no path between them -- not a flag on a shared row
    // that one wrong query would pick up.
    await dbRun(`CREATE TABLE IF NOT EXISTS academy_hours (
      id SERIAL PRIMARY KEY,
      enrollment_id INTEGER NOT NULL,
      item_id INTEGER,
      on_date TEXT NOT NULL,
      hours NUMERIC NOT NULL,
      activity TEXT,
      note TEXT,
      logged_by TEXT,
      created_at TEXT
    )`).catch((e) => console.error("academy_hours:", e.message));
    await dbRun("CREATE INDEX IF NOT EXISTS academy_hours_enr ON academy_hours (enrollment_id)").catch(() => {});

    // ---- THE ANONYMOUS FEEDBACK SURVEY ----------------------------------
    //
    // ANONYMITY HERE IS STRUCTURAL, NOT A PROMISE. A response row carries no
    // employee id, no enrolment id and no name -- there is no column to join
    // on, so no future query and no new screen can un-anonymise it, and
    // neither can I. The alternative, a flag saying "treat this as
    // anonymous", is a promise one careless JOIN later breaks.
    //
    // Whether somebody HAS responded is tracked separately, because
    // leadership needs a response rate and needs to stop asking people who
    // have already answered. That table holds an enrolment id and a date and
    // nothing about the answers, so the two cannot be rejoined.
    await dbRun(`CREATE TABLE IF NOT EXISTS academy_survey_responses (
      id SERIAL PRIMARY KEY,
      program_id INTEGER NOT NULL,
      program_version INTEGER,
      prepared INTEGER,
      mentor_time INTEGER,
      set_up_to_do_job INTEGER,
      missing TEXT,
      change_what TEXT,
      submitted_at TEXT NOT NULL
    )`).catch((e) => console.error("academy_survey_responses:", e.message));
    await dbRun(`CREATE TABLE IF NOT EXISTS academy_survey_done (
      id SERIAL PRIMARY KEY,
      enrollment_id INTEGER NOT NULL,
      submitted_at TEXT NOT NULL
    )`).catch((e) => console.error("academy_survey_done:", e.message));
    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS academy_survey_once
                 ON academy_survey_done (enrollment_id)`).catch(() => {});

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

    // ---- ASKING FOR HELP, AND SAYING YOU WERE NEVER TAUGHT ---------------
    //
    // Two tables rather than one, because they are different acts with
    // different audiences. A QUESTION is "how do I do this" and goes to your
    // mentor. A GAP is "nobody ever showed me this", which is a statement
    // about the PROGRAMME, not about the person -- it goes to leadership as
    // well, and the trend across people is the point of recording it.
    //
    // Collapsing them would lose that: a hundred questions is a chatty new
    // starter, and a hundred gaps on the same topic is a week of the
    // curriculum that does not work.
    await dbRun(`CREATE TABLE IF NOT EXISTS academy_questions (
      id SERIAL PRIMARY KEY,
      enrollment_id INTEGER NOT NULL,
      employee_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      body TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      answer TEXT,
      answered_by TEXT,
      answered_at TEXT,
      created_at TEXT
    )`).catch((e) => console.error("academy_questions:", e.message));

    await dbRun(`CREATE TABLE IF NOT EXISTS academy_gaps (
      id SERIAL PRIMARY KEY,
      enrollment_id INTEGER NOT NULL,
      employee_id INTEGER NOT NULL,
      topic TEXT NOT NULL,
      description TEXT,
      urgency TEXT NOT NULL DEFAULT 'soon',
      needs_help_now BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'submitted',
      assigned_to TEXT,
      resolution TEXT,
      resolved_by TEXT,
      resolved_at TEXT,
      created_at TEXT
    )`).catch((e) => console.error("academy_gaps:", e.message));

    // ---- CHECK-INS --------------------------------------------------------
    //
    // Scheduled on enrolment at days 7, 14, 21 and 30 rather than created
    // when somebody remembers. A check-in that exists only once a manager
    // thinks of it is the one that does not happen in a busy week, which is
    // exactly the week it was for.
    //
    // BOTH SIDES HAVE TO SIGN. The employee answers, the supervisor answers,
    // and the row is complete only when both have. A check-in where only the
    // manager wrote something is a manager's note, and where only the
    // employee wrote something is a diary entry; neither is a conversation.
    await dbRun(`CREATE TABLE IF NOT EXISTS academy_checkins (
      id SERIAL PRIMARY KEY,
      enrollment_id INTEGER NOT NULL,
      day INTEGER NOT NULL,
      due_date TEXT NOT NULL,
      learned TEXT,
      comfortable_with TEXT,
      still_unclear TEXT,
      training_needed TEXT,
      barriers TEXT,
      employee_done_at TEXT,
      mentor_feedback TEXT,
      supervisor_by TEXT,
      supervisor_done_at TEXT,
      created_at TEXT
    )`).catch((e) => console.error("academy_checkins:", e.message));
    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS academy_checkin_one
                 ON academy_checkins (enrollment_id, day)`).catch(() => {});

    // ---- THE THIRTY-DAY REVIEW -------------------------------------------
    //
    // One review per enrolment, holding a rating for each of the ten domains
    // the brief names. Separate from the weekly competencies on purpose: a
    // competency is "can you do this task", and a domain is "are you
    // operating independently in this area of the job". Somebody can pass
    // every weekly competency and still not be ready, which is precisely the
    // judgement this exists to record.
    //
    // THE RATINGS ARE NOT A SCORE. There is no total, no percentage and no
    // pass mark, because the brief forbids approving on arithmetic -- and
    // the first thing a number invites is approving on the number.
    await dbRun(`CREATE TABLE IF NOT EXISTS academy_reviews (
      id SERIAL PRIMARY KEY,
      enrollment_id INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'draft',
      summary TEXT,
      started_by TEXT,
      approved_by TEXT,
      approved_at TEXT,
      employee_ack_at TEXT,
      created_at TEXT, updated_at TEXT
    )`).catch((e) => console.error("academy_reviews:", e.message));
    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS academy_review_one
                 ON academy_reviews (enrollment_id)`).catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS academy_review_ratings (
      id SERIAL PRIMARY KEY,
      review_id INTEGER NOT NULL,
      domain TEXT NOT NULL,
      rating TEXT,
      note TEXT,
      rated_by TEXT,
      rated_at TEXT
    )`).catch((e) => console.error("academy_review_ratings:", e.message));
    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS academy_rating_one
                 ON academy_review_ratings (review_id, domain)`).catch(() => {});

    // A DEVELOPMENT PLAN IS NOT A NOTE. Every row carries a deadline and a
    // reassessment date, because "needs more support" with no date attached
    // is how somebody is still needing more support in March.
    await dbRun(`CREATE TABLE IF NOT EXISTS academy_dev_plans (
      id SERIAL PRIMARY KEY,
      review_id INTEGER NOT NULL,
      enrollment_id INTEGER NOT NULL,
      domain TEXT NOT NULL,
      action TEXT NOT NULL,
      due_date TEXT NOT NULL,
      reassess_on TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',
      closed_by TEXT,
      closed_at TEXT,
      outcome TEXT,
      created_by TEXT,
      created_at TEXT
    )`).catch((e) => console.error("academy_dev_plans:", e.message));

    await seedBcbaProgram();
    await backfillCheckins();
  }

  // The ten domains, in the brief's order.
  const DOMAINS = [
    ["systems", "Company systems proficiency"],
    ["documentation", "Clinical documentation"],
    ["authorizations", "Authorization management"],
    ["compliance", "Clinical compliance"],
    ["supervision", "RBT supervision"],
    ["caseload", "Caseload management"],
    ["communication", "Communication"],
    ["professionalism", "Professionalism"],
    ["leadership", "Leadership"],
    ["policy", "Policy adherence"],
  ];
  const DOMAIN_KEYS = DOMAINS.map((d) => d[0]);
  // Three ratings, and the middle one is not a soft fail -- it is the one
  // that produces a development plan with dates on it.
  const RATINGS = ["independent", "needs_support", "not_demonstrated"];
  const RATING_LABELS = {
    independent: "Independent",
    needs_support: "Requires Additional Support",
    not_demonstrated: "Not Yet Demonstrated",
  };
  const REVIEW_STATES = ["draft", "approved", "development_plan"];
  // APPROVED WITH A DEVELOPMENT PLAN IS STILL APPROVED. Somebody can be
  // doing the job while still developing in one area, and the state records
  // which of the two it was -- so every "is this review closed" question has
  // to ask about both, or re-rating would quietly reopen a signed decision.
  const isClosed = (state) => state === "approved" || state === "development_plan";

  async function reviewFor(enrollmentId) {
    const r = await dbGet("SELECT * FROM academy_reviews WHERE enrollment_id = ?", [enrollmentId]).catch(() => null);
    if (!r) return null;
    const rows = await dbAll("SELECT * FROM academy_review_ratings WHERE review_id = ?", [r.id]).catch(() => []);
    const byDomain = new Map(rows.map((x) => [x.domain, x]));
    const ratings = DOMAINS.map(([key, label]) => {
      const x = byDomain.get(key);
      return {
        domain: key, label,
        rating: (x && x.rating) || null,
        rating_label: x && x.rating ? RATING_LABELS[x.rating] : null,
        note: (x && x.note) || null,
        rated_by: (x && x.rated_by) || null,
      };
    });
    const plans = await dbAll(
      "SELECT * FROM academy_dev_plans WHERE review_id = ? ORDER BY due_date", [r.id]).catch(() => []);
    const unrated = ratings.filter((x) => !x.rating).map((x) => x.label);
    const gaps = ratings.filter((x) => x.rating && x.rating !== "independent");
    return {
      ...r, ratings, plans,
      unrated,
      // What stands between this review and an approval, said as a list
      // rather than as a true/false, so the screen can show the reason.
      gaps: gaps.map((g) => ({ domain: g.domain, label: g.label, rating: g.rating })),
      complete: unrated.length === 0,
      closed: isClosed(r.state),
      open_plans: plans.filter((p) => p.state === "open").length,
    };
  }


  // ANYBODY ALREADY ENROLLED GETS THEIR CHECK-INS TOO.
  //
  // The spine shipped before this table existed, so every enrolment created
  // by it has none -- and a feature that only works for people who join
  // after it was built is the kind of gap nobody notices until somebody asks
  // where their day 7 went. Runs on boot, inserts nothing where rows already
  // exist, and is therefore safe to run every time.
  async function backfillCheckins() {
    const rows = await dbAll(
      `SELECT a.id, a.start_date FROM academy_enrollments a
        WHERE a.state <> 'withdrawn'
          AND NOT EXISTS (SELECT 1 FROM academy_checkins c WHERE c.enrollment_id = a.id)`
    ).catch(() => []);
    for (const r of rows) await scheduleCheckins(r);
    if (rows.length) console.log(`[academy] scheduled check-ins for ${rows.length} existing enrolment(s)`);
  }

  const CHECKIN_DAYS = [7, 14, 21, 30];
  const GAP_STATUSES = ["submitted", "under_review", "training_scheduled", "resolved"];
  const GAP_LABELS = {
    submitted: "Submitted", under_review: "Under Review",
    training_scheduled: "Training Scheduled", resolved: "Resolved",
  };
  const URGENCIES = ["blocking", "soon", "whenever"];

  // Created with the enrolment, so the dates exist before anybody needs them.
  async function scheduleCheckins(enrollment) {
    for (const day of CHECKIN_DAYS) {
      await dbRun(
        `INSERT INTO academy_checkins (enrollment_id, day, due_date, created_at)
         VALUES (?,?,?,?) ON CONFLICT (enrollment_id, day) DO NOTHING`,
        [enrollment.id, day, addDays(enrollment.start_date, day), nowISO()]
      ).catch(() => {});
    }
  }

  async function checkinsFor(enrollmentId) {
    const rows = await dbAll(
      "SELECT * FROM academy_checkins WHERE enrollment_id = ? ORDER BY day", [enrollmentId]).catch(() => []);
    return rows.map((r) => ({
      ...r,
      // Complete means BOTH. Anything else is partly done, and saying so is
      // the only way the dashboard can show what is actually outstanding.
      state: r.employee_done_at && r.supervisor_done_at ? "complete"
        : r.employee_done_at ? "awaiting_supervisor"
        : r.supervisor_done_at ? "awaiting_employee"
        : (r.due_date <= today() ? "due" : "scheduled"),
    }));
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
  async function enrol(employee, { programKey = "bcba-30day", actor = null, startDate = null, mentorId = null } = {}) {
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
    // A MENTOR CAN BE NAMED AT THE START. Nobody cannot mentor themselves,
    // same rule as the later reassignment -- it would make every one of
    // their own competencies self-signed.
    const mentor = mentorId && Number(mentorId) !== Number(employee.id) ? Number(mentorId) : null;
    const row = await dbGet(
      `INSERT INTO academy_enrollments
         (employee_id, program_id, program_version, start_date, due_date, mentor_id, state, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?, 'active', ?,?,?) RETURNING *`,
      [employee.id, prog.id, prog.version, start, addDays(start, prog.duration_days), mentor,
       actor || "system", nowISO(), nowISO()]
    ).catch(() => null);
    if (!row) return { ok: false, error: "The onboarding record could not be created." };

    await audit(row.id, null, "enrolled", null, "active", actor || "system", `${prog.name}, starting ${start}`);
    await scheduleCheckins(row);

    const mentorName = mentor
      ? ((await dbGet("SELECT name FROM hr_employees WHERE id = ?", [mentor]).catch(() => null) || {}).name || null)
      : null;
    const to = await leadershipEmails();
    if (to.length) {
      await sendEmail({
        to: to.join(","),
        subject: `Onboarding started — ${employee.name}`,
        html: `<p><strong>${employee.name}</strong> has been enrolled in the ${prog.name}.</p>
               <p>Start date: ${start}. Due: ${addDays(start, prog.duration_days)}.</p>
               ${mentorName
                  ? `<p>Mentor: ${mentorName}.</p>`
                  : "<p>No mentor is assigned yet — assign one from the Academy screen in the BCBA Hub.</p>"}`,
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
  // The curriculum AS OF A VERSION. Pass no version and you get the current
  // one, which is what the editing screens want; pass an enrolment's version
  // and you get the curriculum that person actually signed up to.
  async function itemsFor(programId, version = null) {
    if (version == null) {
      const p = await dbGet("SELECT version FROM academy_programs WHERE id = ?", [programId]).catch(() => null);
      version = p ? Number(p.version) : 1;
    }
    const v = Number(version) || 1;
    return await dbAll(
      `SELECT i.*, m.week, m.title AS module_title, m.position AS module_position
         FROM academy_items i JOIN academy_modules m ON m.id = i.module_id
        WHERE m.program_id = ?
          AND m.version_from <= ? AND (m.version_to IS NULL OR m.version_to > ?)
          AND i.version_from <= ? AND (i.version_to IS NULL OR i.version_to > ?)
        ORDER BY m.week, m.position, i.position, i.id`,
      [programId, v, v, v, v]
    ).catch(() => []);
  }

  const RESOURCE_KINDS = ["document", "video", "link", "note"];
  const SURVEY_SCALES = ["prepared", "mentor_time", "set_up_to_do_job"];
  const SURVEY_QUESTIONS = [
    ["prepared", "How prepared did you feel to do the job at the end of onboarding?"],
    ["mentor_time", "Did you get enough time with your mentor?"],
    ["set_up_to_do_job", "Did the programme set you up to carry a caseload?"],
    ["missing", "What was missing from the training?"],
    ["change_what", "What would you change about it?"],
  ];
  // NOBODY SEES A SINGLE RESPONSE. With one answer in, "the anonymous
  // feedback" and "what the person who just finished thinks" are the same
  // sentence, and everybody knows it. Three is the smallest number that is
  // not a name.
  const SURVEY_MIN = 3;
  // Order is an identifier too: comments served newest-first line up with
  // the marker table's submission order, which is the one join this design
  // exists to prevent.
  const median = (nums) => {
    const v = nums.slice().sort((a, b) => a - b);
    if (!v.length) return null;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
  };

  // A name with a comma in it, or a note somebody pasted a quote into, must
  // not shift every later column by one.
  const csvCell = (v) => {
    const t = String(v == null ? "" : v);
    return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  const shuffle = (a) => {
    const out = a.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  // Only http and https. A resource's url goes into an href, and
  // "javascript:..." in that position is a script somebody else wrote
  // running on the reader's session.
  const safeUrl = (v) => {
    const u = clean(v);
    if (!u) return null;
    return /^https?:\/\/[^\s]+$/i.test(u) ? u : false;
  };

  async function resourcesFor(moduleIds, itemIds) {
    const mods = (moduleIds || []).map(Number).filter(Boolean);
    const items = (itemIds || []).map(Number).filter(Boolean);
    if (!mods.length && !items.length) return [];
    const parts = [], vals = [];
    if (mods.length) { parts.push(`module_id IN (${mods.map(() => "?").join(",")})`); vals.push(...mods); }
    if (items.length) { parts.push(`item_id IN (${items.map(() => "?").join(",")})`); vals.push(...items); }
    const rows = await dbAll(
      `SELECT r.*, p.title AS policy_title, p.slug AS policy_slug
         FROM academy_resources r
         LEFT JOIN crm_policies p ON p.id = r.policy_id
        WHERE ${parts.join(" OR ")}
        ORDER BY r.position, r.id`, vals).catch(() => []);
    return rows.map((r) => ({
      ...r,
      // A document resource reads its title from the policy library when it
      // has one, so renaming an SOP does not leave a stale name in a week.
      title: r.policy_id && r.policy_title ? r.policy_title : r.title,
      href: r.policy_id ? `/policies#p-${r.policy_slug || r.policy_id}` : r.url,
    }));
  }

  // Copying attachments when a module or item forks. Without this a forked
  // week keeps its checklist and silently loses everything to read.
  async function copyResources({ fromModule, toModule, fromItem, toItem, actor }) {
    const where = fromModule ? "module_id = ? AND item_id IS NULL" : "item_id = ?";
    const arg = fromModule || fromItem;
    const rows = await dbAll(`SELECT * FROM academy_resources WHERE ${where}`, [arg]).catch(() => []);
    for (const r of rows) {
      await dbRun(
        `INSERT INTO academy_resources (module_id, item_id, kind, title, url, policy_id, body, position, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [toModule || null, toItem || null, r.kind, r.title, r.url, r.policy_id, r.body, r.position,
         actor || r.created_by, nowISO()]);
    }
    return rows.length;
  }

  async function modulesFor(programId, version = null) {
    if (version == null) {
      const p = await dbGet("SELECT version FROM academy_programs WHERE id = ?", [programId]).catch(() => null);
      version = p ? Number(p.version) : 1;
    }
    const v = Number(version) || 1;
    return await dbAll(
      `SELECT * FROM academy_modules
        WHERE program_id = ? AND version_from <= ? AND (version_to IS NULL OR version_to > ?)
        ORDER BY week, position`, [programId, v, v]).catch(() => []);
  }

  async function progressFor(enrollment) {
    // THE ENROLMENT'S OWN VERSION, not the latest. This is the line that
    // makes "preserve the version each employee completed" true.
    const items = await itemsFor(enrollment.program_id, enrollment.program_version);
    const rows = await dbAll("SELECT * FROM academy_progress WHERE enrollment_id = ?", [enrollment.id]).catch(() => []);
    const byItem = new Map(rows.map((r) => [Number(r.item_id), r]));
    // What to read and watch, beside the thing to do. A checklist item with
    // no material attached is an instruction to go and find out somehow,
    // which is the gap the whole academy exists to close.
    const resources = await resourcesFor(
      [...new Set(items.map((i) => Number(i.module_id)))],
      items.map((i) => Number(i.id)));
    const resByItem = new Map();
    const resByModule = new Map();
    for (const r of resources) {
      if (r.item_id) {
        if (!resByItem.has(Number(r.item_id))) resByItem.set(Number(r.item_id), []);
        resByItem.get(Number(r.item_id)).push(r);
      } else if (r.module_id) {
        if (!resByModule.has(Number(r.module_id))) resByModule.set(Number(r.module_id), []);
        resByModule.get(Number(r.module_id)).push(r);
      }
    }
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
        resources: resByItem.get(Number(i.id)) || [],
      };
    });
    const required = merged.filter((m) => m.required);
    const done = required.filter((m) => m.status === "completed").length;
    const weeks = [];
    for (let w = 1; w <= 8; w++) {
      const inWeek = merged.filter((m) => Number(m.week) === w);
      if (!inWeek.length) continue;
      const req = inWeek.filter((m) => m.required);
      const modIds = [...new Set(inWeek.map((m) => Number(m.module_id)))];
      weeks.push({
        week: w,
        title: (inWeek[0] && inWeek[0].module_title) || `Week ${w}`,
        resources: modIds.flatMap((id) => resByModule.get(id) || []),
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
        const rv = await reviewFor(r.id);
        out.push({
          ...r, percent: pr.percent, completed: pr.completed, total: pr.total,
          awaiting_review: pr.awaiting_review, needs_training: pr.needs_training,
          day: pr.day, current_week: Math.min(Math.ceil(pr.day / 7), r.weeks || 4),
          review_state: rv ? rv.state : null,
          open_plans: rv ? rv.open_plans : 0,
          // THE ONE NUMBER THE ROSTER IS FOR: somebody at day 30 with no
          // review started is the person about to be forgotten about.
          review_due: pr.day >= 30 && r.state === "active" && !(rv && rv.closed),
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
      if (b.mentor_id !== undefined && b.mentor_id !== null && !num(b.mentor_id)) {
        json(res, 400, { error: "That is not an employee." }); return true;
      }
      if (b.mentor_id && Number(num(b.mentor_id)) === Number(id)) {
        json(res, 400, { error: "Somebody cannot be their own mentor." }); return true;
      }
      const r = await enrol(emp, {
        programKey: clean(b.program_key) || "bcba-30day", actor,
        startDate: b.start_date, mentorId: num(b.mentor_id),
      });
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

    // ---- ASK MY MENTOR ---------------------------------------------------
    //
    // The point of this, in the brief's own words, is that somebody can ask
    // without interrupting another BCBA mid-session. So it is a written
    // queue, not a notification that demands an answer now.
    if (pathname === "/api/academy/questions" && method === "POST") {
      if (!me) { json(res, 403, { error: "No employee record is linked to this account." }); return true; }
      const enr = await dbGet(
        "SELECT * FROM academy_enrollments WHERE employee_id = ? ORDER BY id DESC LIMIT 1", [me.id]).catch(() => null);
      if (!enr) { json(res, 404, { error: "You are not enrolled in an onboarding programme." }); return true; }
      const b = await readBody(req).catch(() => ({}));
      if (!clean(b.subject)) { json(res, 400, { error: "Give the question a subject." }); return true; }
      const row = await dbGet(
        `INSERT INTO academy_questions (enrollment_id, employee_id, subject, body, status, created_at)
         VALUES (?,?,?,?, 'open', ?) RETURNING *`,
        [enr.id, me.id, clean(b.subject).slice(0, 200), clean(b.body) || null, nowISO()]).catch(() => null);
      if (!row) { json(res, 500, { error: "The question could not be saved." }); return true; }

      // To the mentor. NOT to leadership: a question is not an escalation,
      // and copying a director into "how do I find the schedule" is how
      // people stop asking.
      const mentor = enr.mentor_id
        ? await dbGet("SELECT name, email FROM hr_employees WHERE id = ?", [enr.mentor_id]).catch(() => null) : null;
      if (mentor && mentor.email) {
        await sendEmail({
          to: mentor.email,
          subject: `Question from ${me.name}`,
          html: `<p><strong>${me.name}</strong> has asked you something.</p>
                 <p><strong>${clean(b.subject)}</strong></p>
                 ${clean(b.body) ? `<p>${clean(b.body)}</p>` : ""}
                 <p>Answer it on the Onboarding Academy screen in the BCBA Hub.</p>`,
          type: "academy_question", refType: "academy_question", refId: row.id,
        }).catch(() => {});
      }
      json(res, 200, { ok: true, question: row, mentor_notified: !!(mentor && mentor.email) });
      return true;
    }

    if (pathname === "/api/academy/questions" && method === "GET") {
      const enrId = num(query && query.enrollment_id);
      let rows = [];
      if (enrId) {
        const enr = await dbGet("SELECT * FROM academy_enrollments WHERE id = ?", [enrId]).catch(() => null);
        if (!enr) { json(res, 404, { error: "No such onboarding record." }); return true; }
        const mentorHere = !!(me && enr.mentor_id && Number(enr.mentor_id) === Number(me.id));
        const isSubject = !!(me && Number(enr.employee_id) === Number(me.id));
        if (!(lead || mentorHere || isSubject)) { json(res, 403, { error: "Not permitted" }); return true; }
        rows = await dbAll("SELECT * FROM academy_questions WHERE enrollment_id = ? ORDER BY id DESC", [enrId]).catch(() => []);
      } else {
        // LEADERSHIP NEED NOT BE AN EMPLOYEE RECORD. The owner signs in as a
        // user and may have no row in hr_employees at all, and requiring one
        // here locked the people this screen is mostly for out of it.
        if (!me && !lead) { json(res, 403, { error: "Not permitted" }); return true; }
        rows = lead
          ? await dbAll(
              `SELECT q.*, e.name AS asked_by FROM academy_questions q
                 JOIN hr_employees e ON e.id = q.employee_id
                ORDER BY (q.status = 'open') DESC, q.id DESC LIMIT 200`).catch(() => [])
          // Mine, plus anything addressed to me as a mentor.
          : await dbAll(
              `SELECT q.*, e.name AS asked_by FROM academy_questions q
                 JOIN hr_employees e ON e.id = q.employee_id
                 JOIN academy_enrollments a ON a.id = q.enrollment_id
                WHERE q.employee_id = ? OR a.mentor_id = ?
                ORDER BY (q.status = 'open') DESC, q.id DESC LIMIT 200`,
              [me.id, me.id]).catch(() => []);
      }
      json(res, 200, { questions: rows });
      return true;
    }

    const ansMatch = pathname.match(/^\/api\/academy\/questions\/(\d+)$/);
    if (ansMatch && method === "POST") {
      const qid = Number(ansMatch[1]);
      const q = await dbGet("SELECT * FROM academy_questions WHERE id = ?", [qid]).catch(() => null);
      if (!q) { json(res, 404, { error: "No such question." }); return true; }
      const enr = await dbGet("SELECT * FROM academy_enrollments WHERE id = ?", [q.enrollment_id]).catch(() => null);
      const mentorHere = !!(me && enr && enr.mentor_id && Number(enr.mentor_id) === Number(me.id));
      // ANSWERING YOUR OWN QUESTION IS NOT AN ANSWER. It would close the
      // thread and tell leadership the mentor responded.
      if (me && Number(q.employee_id) === Number(me.id)) {
        json(res, 403, { error: "You cannot answer your own question." }); return true;
      }
      if (!(lead || mentorHere)) { json(res, 403, { error: "Only the mentor or clinical leadership can answer." }); return true; }
      const b = await readBody(req).catch(() => ({}));
      if (!clean(b.answer)) { json(res, 400, { error: "Write an answer." }); return true; }
      await dbRun(
        "UPDATE academy_questions SET answer = ?, answered_by = ?, answered_at = ?, status = 'answered' WHERE id = ?",
        [clean(b.answer), actor, nowISO(), qid]);
      const asker = await dbGet("SELECT name, email FROM hr_employees WHERE id = ?", [q.employee_id]).catch(() => null);
      if (asker && asker.email) {
        await sendEmail({
          to: asker.email,
          subject: `Answered: ${q.subject}`,
          html: `<p>${actor} has answered your question.</p>
                 <p><strong>${q.subject}</strong></p><p>${clean(b.answer)}</p>`,
          type: "academy_question_answered", refType: "academy_question", refId: qid,
        }).catch(() => {});
      }
      json(res, 200, { ok: true });
      return true;
    }

    // ---- I WASN'T TRAINED ON THIS ---------------------------------------
    //
    // Deliberately easy to file and hard to lose. It goes to the mentor AND
    // to clinical leadership, because the second audience is the point: one
    // person saying it is a gap in their training, and four people saying it
    // about the same topic is a gap in the programme.
    if (pathname === "/api/academy/gaps" && method === "POST") {
      if (!me) { json(res, 403, { error: "No employee record is linked to this account." }); return true; }
      const enr = await dbGet(
        "SELECT * FROM academy_enrollments WHERE employee_id = ? ORDER BY id DESC LIMIT 1", [me.id]).catch(() => null);
      if (!enr) { json(res, 404, { error: "You are not enrolled in an onboarding programme." }); return true; }
      const b = await readBody(req).catch(() => ({}));
      if (!clean(b.topic)) { json(res, 400, { error: "What was the topic or procedure?" }); return true; }
      const urgency = URGENCIES.includes(clean(b.urgency)) ? clean(b.urgency) : "soon";
      const row = await dbGet(
        `INSERT INTO academy_gaps (enrollment_id, employee_id, topic, description, urgency, needs_help_now, status, created_at)
         VALUES (?,?,?,?,?,?, 'submitted', ?) RETURNING *`,
        [enr.id, me.id, clean(b.topic).slice(0, 200), clean(b.description) || null,
         urgency, b.needs_help_now === true, nowISO()]).catch(() => null);
      if (!row) { json(res, 500, { error: "That could not be saved." }); return true; }

      const mentor = enr.mentor_id
        ? await dbGet("SELECT email FROM hr_employees WHERE id = ?", [enr.mentor_id]).catch(() => null) : null;
      const to = [...new Set([(mentor || {}).email, ...(await leadershipEmails())].filter(Boolean))];
      if (to.length) {
        await sendEmail({
          to: to.join(","),
          subject: (b.needs_help_now === true ? "[NEEDS HELP NOW] " : "") + `Training gap — ${me.name}`,
          html: `<p><strong>${me.name}</strong> has reported that they were not trained on something.</p>
                 <p><strong>${clean(b.topic)}</strong></p>
                 ${clean(b.description) ? `<p>${clean(b.description)}</p>` : ""}
                 <p>Urgency: ${urgency}${b.needs_help_now === true ? " — they need help immediately." : ""}</p>`,
          type: "academy_gap", refType: "academy_gap", refId: row.id,
        }).catch(() => {});
      }
      json(res, 200, { ok: true, gap: row });
      return true;
    }

    if (pathname === "/api/academy/gaps" && method === "GET") {
      // Same as the questions route above: leadership is a designation on a
      // user, not necessarily a staff record, and the owner has no
      // hr_employees row at all.
      if (!me && !lead) { json(res, 403, { error: "Not permitted" }); return true; }
      const rows = lead
        ? await dbAll(
            `SELECT g.*, e.name AS raised_by FROM academy_gaps g
               JOIN hr_employees e ON e.id = g.employee_id
              ORDER BY (g.status <> 'resolved') DESC, g.id DESC LIMIT 300`).catch(() => [])
        : await dbAll(
            `SELECT g.*, e.name AS raised_by FROM academy_gaps g
               JOIN hr_employees e ON e.id = g.employee_id
               JOIN academy_enrollments a ON a.id = g.enrollment_id
              WHERE g.employee_id = ? OR a.mentor_id = ?
              ORDER BY (g.status <> 'resolved') DESC, g.id DESC LIMIT 300`,
            [me.id, me.id]).catch(() => []);
      // The trend, which is what makes this worth collecting. Only for the
      // people who can act on the programme.
      let trend = null;
      if (lead) {
        trend = await dbAll(
          `SELECT LOWER(TRIM(topic)) AS topic, COUNT(*) AS n
             FROM academy_gaps GROUP BY LOWER(TRIM(topic))
            HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 20`).catch(() => []);
      }
      json(res, 200, { gaps: rows, trend, statuses: GAP_LABELS, can_manage: lead });
      return true;
    }

    const gapMatch = pathname.match(/^\/api\/academy\/gaps\/(\d+)$/);
    if (gapMatch && method === "PATCH") {
      const gid = Number(gapMatch[1]);
      const g = await dbGet("SELECT * FROM academy_gaps WHERE id = ?", [gid]).catch(() => null);
      if (!g) { json(res, 404, { error: "No such report." }); return true; }
      const enr = await dbGet("SELECT * FROM academy_enrollments WHERE id = ?", [g.enrollment_id]).catch(() => null);
      const mentorHere = !!(me && enr && enr.mentor_id && Number(enr.mentor_id) === Number(me.id));
      if (!(lead || mentorHere)) { json(res, 403, { error: "Only the mentor or clinical leadership can work on this." }); return true; }
      const b = await readBody(req).catch(() => ({}));
      const want = clean(b.status);
      if (!GAP_STATUSES.includes(want)) { json(res, 400, { error: "Unknown status." }); return true; }
      // Closing it has to say what was done, or the record says a gap was
      // resolved and nothing about how.
      if (want === "resolved" && !clean(b.resolution)) {
        json(res, 400, { error: "Say what was done about it." }); return true;
      }
      await dbRun(
        `UPDATE academy_gaps SET status = ?, resolution = COALESCE(?, resolution),
           resolved_by = ?, resolved_at = ?, assigned_to = COALESCE(?, assigned_to) WHERE id = ?`,
        [want, clean(b.resolution) || null, want === "resolved" ? actor : null,
         want === "resolved" ? nowISO() : null, clean(b.assigned_to) || null, gid]);

      const emp = await dbGet("SELECT name, email FROM hr_employees WHERE id = ?", [g.employee_id]).catch(() => null);
      if (emp && emp.email) {
        await sendEmail({
          to: emp.email,
          subject: `Your training gap report is now ${GAP_LABELS[want]}`,
          html: `<p><strong>${g.topic}</strong></p>
                 <p>Status: ${GAP_LABELS[want]}.</p>
                 ${clean(b.resolution) ? `<p>${clean(b.resolution)}</p>` : ""}`,
          type: "academy_gap_updated", refType: "academy_gap", refId: gid,
        }).catch(() => {});
      }
      json(res, 200, { ok: true });
      return true;
    }

    // ---- WEEKLY CHECK-INS -------------------------------------------------
    const ciList = pathname.match(/^\/api\/academy\/enrollments\/(\d+)\/checkins$/);
    if (ciList && method === "GET") {
      const enrId = Number(ciList[1]);
      const enr = await dbGet("SELECT * FROM academy_enrollments WHERE id = ?", [enrId]).catch(() => null);
      if (!enr) { json(res, 404, { error: "No such onboarding record." }); return true; }
      const mentorHere = !!(me && enr.mentor_id && Number(enr.mentor_id) === Number(me.id));
      const isSubject = !!(me && Number(enr.employee_id) === Number(me.id));
      if (!(lead || mentorHere || isSubject)) { json(res, 403, { error: "Not permitted" }); return true; }
      json(res, 200, { checkins: await checkinsFor(enrId) });
      return true;
    }

    const ciOne = pathname.match(/^\/api\/academy\/enrollments\/(\d+)\/checkins\/(\d+)$/);
    if (ciOne && method === "POST") {
      const enrId = Number(ciOne[1]);
      const day = Number(ciOne[2]);
      const enr = await dbGet("SELECT * FROM academy_enrollments WHERE id = ?", [enrId]).catch(() => null);
      if (!enr) { json(res, 404, { error: "No such onboarding record." }); return true; }
      const row = await dbGet(
        "SELECT * FROM academy_checkins WHERE enrollment_id = ? AND day = ?", [enrId, day]).catch(() => null);
      if (!row) { json(res, 404, { error: "No such check-in." }); return true; }
      const b = await readBody(req).catch(() => ({}));
      const mentorHere = !!(me && enr.mentor_id && Number(enr.mentor_id) === Number(me.id));
      const isSubject = !!(me && Number(enr.employee_id) === Number(me.id));

      // TWO HALVES, AND EACH SIDE WRITES ONLY ITS OWN. The employee answers
      // the five questions about their own experience; the supervisor writes
      // the feedback. Letting either write the other's half would turn a
      // conversation into one person's account of it.
      if (isSubject) {
        const answers = ["learned", "comfortable_with", "still_unclear", "training_needed", "barriers"];
        if (!answers.some((k) => clean(b[k]))) {
          json(res, 400, { error: "Answer at least one of the questions." }); return true;
        }
        await dbRun(
          `UPDATE academy_checkins SET learned = ?, comfortable_with = ?, still_unclear = ?,
             training_needed = ?, barriers = ?, employee_done_at = ? WHERE id = ?`,
          [clean(b.learned) || null, clean(b.comfortable_with) || null, clean(b.still_unclear) || null,
           clean(b.training_needed) || null, clean(b.barriers) || null, nowISO(), row.id]);
        await audit(enrId, null, "checkin_employee", null, "day " + day, actor, null);
        const to = [...new Set([
          enr.mentor_id ? (await dbGet("SELECT email FROM hr_employees WHERE id = ?", [enr.mentor_id]).catch(() => null) || {}).email : null,
          ...(await leadershipEmails()),
        ].filter(Boolean))];
        if (to.length) {
          await sendEmail({
            to: to.join(","),
            subject: `Day ${day} check-in ready — ${me.name}`,
            html: `<p><strong>${me.name}</strong> has completed their day ${day} check-in.</p>
                   <p>It needs your half before it counts as done.</p>`,
            type: "academy_checkin_employee", refType: "academy_enrollment", refId: enrId,
          }).catch(() => {});
        }
      } else if (lead || mentorHere) {
        if (!clean(b.mentor_feedback)) { json(res, 400, { error: "Write your feedback." }); return true; }
        await dbRun(
          "UPDATE academy_checkins SET mentor_feedback = ?, supervisor_by = ?, supervisor_done_at = ? WHERE id = ?",
          [clean(b.mentor_feedback), actor, nowISO(), row.id]);
        await audit(enrId, null, "checkin_supervisor", null, "day " + day, actor, null);
        const emp = await dbGet("SELECT name, email FROM hr_employees WHERE id = ?", [enr.employee_id]).catch(() => null);
        if (emp && emp.email) {
          await sendEmail({
            to: emp.email,
            subject: `Your day ${day} check-in has feedback`,
            html: `<p>${actor} has added their feedback to your day ${day} check-in.</p>
                   <p>${clean(b.mentor_feedback)}</p>`,
            type: "academy_checkin_supervisor", refType: "academy_enrollment", refId: enrId,
          }).catch(() => {});
        }
      } else {
        json(res, 403, { error: "Not permitted" }); return true;
      }
      json(res, 200, { ok: true, checkins: await checkinsFor(enrId) });
      return true;
    }

    // ---- THE THIRTY-DAY REVIEW -------------------------------------------
    const revGet = pathname.match(/^\/api\/academy\/enrollments\/(\d+)\/review$/);
    if (revGet && method === "GET") {
      const enrId = Number(revGet[1]);
      const enr = await dbGet("SELECT * FROM academy_enrollments WHERE id = ?", [enrId]).catch(() => null);
      if (!enr) { json(res, 404, { error: "No such onboarding record." }); return true; }
      const mentorHere = !!(me && enr.mentor_id && Number(enr.mentor_id) === Number(me.id));
      const isSubject = !!(me && Number(enr.employee_id) === Number(me.id));
      if (!(lead || mentorHere || isSubject)) { json(res, 403, { error: "Not permitted" }); return true; }
      let review = await reviewFor(enrId);
      // A DRAFT REVIEW IS NOT THE SUBJECT'S TO READ YET.
      //
      // Ratings in progress are the supervisor's working notes. "Not Yet
      // Demonstrated" appearing on somebody's own screen before anybody has
      // spoken to them is how a developmental review becomes the worst
      // conversation of their month, and it would also stop supervisors
      // writing anything honest down. Once it is approved they see all of
      // it -- every rating, every note, every plan -- which is the point at
      // which it is a decision rather than a draft.
      if (review && isSubject && !review.closed) {
        review = { state: review.state, draft_in_progress: true, closed: false,
                   ratings: [], plans: [], unrated: [], gaps: [], complete: review.complete, open_plans: 0 };
      }
      json(res, 200, {
        review,
        domains: DOMAINS.map(([key, label]) => ({ key, label })),
        rating_labels: RATING_LABELS,
        progress: await progressFor(enr),
        checkins: await checkinsFor(enrId),
        // WHO MAY APPROVE, decided here and not in the browser. The subject
        // is excluded even when they are clinical leadership, which is the
        // case this flag exists for.
        can_rate: (lead || mentorHere) && !isSubject,
        can_approve: lead && !isSubject,
        is_subject: isSubject,
      });
      return true;
    }

    if (revGet && method === "POST") {
      // Starting the review, and rating a domain, are the same call: the
      // review is created on first rating rather than by a separate "begin"
      // button nobody would understand the purpose of.
      const enrId = Number(revGet[1]);
      const enr = await dbGet("SELECT * FROM academy_enrollments WHERE id = ?", [enrId]).catch(() => null);
      if (!enr) { json(res, 404, { error: "No such onboarding record." }); return true; }
      const mentorHere = !!(me && enr.mentor_id && Number(enr.mentor_id) === Number(me.id));
      const isSubject = !!(me && Number(enr.employee_id) === Number(me.id));
      // RATING YOURSELF IS NOT A REVIEW. Checked before the permission below
      // so that a clinical lead going through the academy cannot rate their
      // own ten domains on the strength of being a clinical lead.
      if (isSubject) { json(res, 403, { error: "You cannot rate your own review." }); return true; }
      if (!(lead || mentorHere)) { json(res, 403, { error: "Only the mentor or clinical leadership can rate this." }); return true; }

      const b = await readBody(req).catch(() => ({}));
      const domain = clean(b.domain);
      const rating = clean(b.rating);
      if (!DOMAIN_KEYS.includes(domain)) { json(res, 400, { error: "Unknown domain." }); return true; }
      if (!RATINGS.includes(rating)) { json(res, 400, { error: "Rate it Independent, Requires Additional Support, or Not Yet Demonstrated." }); return true; }
      // A rating that is not "independent" has to say why, or the
      // development plan it produces is written from nothing.
      if (rating !== "independent" && !clean(b.note)) {
        json(res, 400, { error: "Say what is missing, so the development plan has something to act on." });
        return true;
      }

      let review = await dbGet("SELECT * FROM academy_reviews WHERE enrollment_id = ?", [enrId]).catch(() => null);
      if (!review) {
        review = await dbGet(
          `INSERT INTO academy_reviews (enrollment_id, state, started_by, created_at, updated_at)
           VALUES (?, 'draft', ?, ?, ?) RETURNING *`, [enrId, actor, nowISO(), nowISO()]).catch(() => null);
      }
      if (!review) { json(res, 500, { error: "The review could not be started." }); return true; }
      // AN APPROVED REVIEW IS CLOSED. Re-rating a domain afterwards would
      // change the basis of a decision already communicated to somebody.
      if (isClosed(review.state)) {
        json(res, 400, { error: "This review has been approved. Reopen it before changing a rating." }); return true;
      }

      await dbRun(
        `INSERT INTO academy_review_ratings (review_id, domain, rating, note, rated_by, rated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT (review_id, domain) DO UPDATE SET
           rating = EXCLUDED.rating, note = EXCLUDED.note,
           rated_by = EXCLUDED.rated_by, rated_at = EXCLUDED.rated_at`,
        [review.id, domain, rating, clean(b.note) || null, actor, nowISO()]);
      await audit(enrId, null, "review_rating", null, domain + ":" + rating, actor, clean(b.note) || null);
      json(res, 200, { ok: true, review: await reviewFor(enrId) });
      return true;
    }

    const revApprove = pathname.match(/^\/api\/academy\/enrollments\/(\d+)\/review\/approve$/);
    if (revApprove && method === "POST") {
      const enrId = Number(revApprove[1]);
      const enr = await dbGet("SELECT * FROM academy_enrollments WHERE id = ?", [enrId]).catch(() => null);
      if (!enr) { json(res, 404, { error: "No such onboarding record." }); return true; }
      const isSubject = !!(me && Number(enr.employee_id) === Number(me.id));
      if (isSubject) { json(res, 403, { error: "You cannot approve your own onboarding." }); return true; }
      // THE MENTOR RATES; CLINICAL LEADERSHIP APPROVES. The brief is explicit
      // that the Clinical Director or Assistant signs the completion, and a
      // mentor who could do it would make the distinction decorative.
      if (!lead) { json(res, 403, { error: "Only the Clinical Director or an Assistant can approve a completion." }); return true; }

      const review = await reviewFor(enrId);
      if (!review) { json(res, 400, { error: "No review has been started." }); return true; }
      if (isClosed(review.state)) { json(res, 400, { error: "This onboarding is already approved." }); return true; }

      // ---- THE GATE --------------------------------------------------
      //
      // The brief forbids approving on elapsed time or on a completed
      // checklist, and both are easy mistakes to make because both are
      // available and look like evidence. So neither is consulted here.
      // What IS required:
      const b = await readBody(req).catch(() => ({}));

      //   1. Every domain rated. An unrated domain is not a pass, it is an
      //      unasked question.
      if (!review.complete) {
        json(res, 400, {
          error: `Rate every domain first. Still unrated: ${review.unrated.join(", ")}.`,
          unrated: review.unrated,
        });
        return true;
      }

      //   2. Nothing is still waiting on a supervisor. An employee who asked
      //      for a competency to be reviewed, and never got an answer, has an
      //      open question -- and approving over it signs off on a
      //      demonstration nobody actually watched.
      const pr = await progressFor(enr);
      if (pr && pr.awaiting_review > 0) {
        json(res, 400, {
          error: `${pr.awaiting_review} competency review request(s) are still unanswered. Sign those off or send them back first.`,
          awaiting_review: pr.awaiting_review,
        });
        return true;
      }

      //   3. Every domain that is not "independent" has a development plan
      //      with a deadline and a reassessment date. The brief asks for a
      //      plan where more training is needed, and a plan with no date is
      //      how somebody is still "needing support" in March.
      if (review.gaps.length) {
        const covered = new Set(review.plans.map((p) => p.domain));
        const missing = review.gaps.filter((g) => !covered.has(g.domain));
        if (missing.length) {
          json(res, 400, {
            error: `These are not yet independent and have no development plan: ${missing.map((m) => m.label).join(", ")}.`,
            needs_plan: missing,
          });
          return true;
        }
      }

      //   4. A written summary. An approval with no words is a button press,
      //      and this one ends somebody's probationary training.
      if (!clean(b.summary)) {
        json(res, 400, { error: "Write a short summary of the review before approving." }); return true;
      }

      const state = review.gaps.length ? "development_plan" : "approved";
      await dbRun(
        `UPDATE academy_reviews SET state = ?, summary = ?, approved_by = ?, approved_at = ?, updated_at = ?
          WHERE id = ?`,
        [state, clean(b.summary), actor, nowISO(), nowISO(), review.id]);
      await dbRun(
        "UPDATE academy_enrollments SET state = 'completed', completed_at = ?, approved_by = ?, updated_at = ? WHERE id = ?",
        [nowISO(), actor, nowISO(), enrId]);
      await audit(enrId, null, "onboarding_approved", "active", "completed", actor,
                  review.gaps.length ? `with a development plan on ${review.gaps.length} domain(s)` : null);

      const emp = await dbGet("SELECT name, email FROM hr_employees WHERE id = ?", [enr.employee_id]).catch(() => null);
      if (emp && emp.email) {
        await sendEmail({
          to: emp.email,
          subject: "Your onboarding has been approved",
          html: `<p>Your 30-day onboarding has been approved by ${h(actor)}.</p>
                 <p>${h(b.summary)}</p>
                 ${review.gaps.length
                    ? `<p>There is a development plan on ${review.gaps.length} area(s), with dates. You can see it on the Academy screen.</p>`
                    : ""}`,
          type: "academy_approved", refType: "academy_enrollment", refId: enrId,
        }).catch(() => {});
      }
      try {
        onCompletion("academy_approved", {
          subject: emp ? emp.name : "A new BCBA",
          detail: review.gaps.length
            ? `Approved with a development plan on ${review.gaps.length} area(s)`
            : "Approved, independent in every area",
          link: "/#/bcba-hub",
          employeeId: enr.employee_id,
          dedupeKey: "academy_approved:" + enrId,
        });
      } catch (e) { /* recording a completion must never fail an approval */ }
      json(res, 200, { ok: true, state, review: await reviewFor(enrId) });
      return true;
    }

    // ---- DEVELOPMENT PLANS -----------------------------------------------
    const planAdd = pathname.match(/^\/api\/academy\/enrollments\/(\d+)\/review\/plans$/);
    if (planAdd && method === "POST") {
      const enrId = Number(planAdd[1]);
      const enr = await dbGet("SELECT * FROM academy_enrollments WHERE id = ?", [enrId]).catch(() => null);
      if (!enr) { json(res, 404, { error: "No such onboarding record." }); return true; }
      const isSubject = !!(me && Number(enr.employee_id) === Number(me.id));
      const mentorHere = !!(me && enr.mentor_id && Number(enr.mentor_id) === Number(me.id));
      if (isSubject) { json(res, 403, { error: "You cannot write your own development plan." }); return true; }
      if (!(lead || mentorHere)) { json(res, 403, { error: "Not permitted" }); return true; }
      const review = await dbGet("SELECT * FROM academy_reviews WHERE enrollment_id = ?", [enrId]).catch(() => null);
      if (!review) { json(res, 400, { error: "Start the review first." }); return true; }
      // DELIBERATELY STILL OPEN AFTER APPROVAL, unlike the ratings. A rating
      // is the record of a judgement already made and communicated, so it
      // freezes; a development plan is the forward-looking half, and a
      // reassessment that goes badly needs somewhere to put the next step
      // without reopening the decision behind it.

      const b = await readBody(req).catch(() => ({}));
      if (!DOMAIN_KEYS.includes(clean(b.domain))) { json(res, 400, { error: "Unknown domain." }); return true; }
      if (!clean(b.action)) { json(res, 400, { error: "What should happen?" }); return true; }
      // BOTH DATES, ALWAYS. A plan with a deadline and no reassessment is a
      // task; a plan with neither is a wish.
      if (!isDate(b.due_date)) { json(res, 400, { error: "Give it a deadline." }); return true; }
      if (!isDate(b.reassess_on)) { json(res, 400, { error: "Give it a date to be reassessed on." }); return true; }
      if (clean(b.reassess_on) < clean(b.due_date)) {
        json(res, 400, { error: "Reassessment cannot be before the deadline." }); return true;
      }

      const row = await dbGet(
        `INSERT INTO academy_dev_plans (review_id, enrollment_id, domain, action, due_date, reassess_on,
           state, created_by, created_at)
         VALUES (?,?,?,?,?,?, 'open', ?, ?) RETURNING *`,
        [review.id, enrId, clean(b.domain), clean(b.action), clean(b.due_date), clean(b.reassess_on),
         actor, nowISO()]).catch(() => null);
      if (!row) { json(res, 500, { error: "The plan could not be saved." }); return true; }
      await audit(enrId, null, "dev_plan", null, clean(b.domain), actor, clean(b.action));
      json(res, 200, { ok: true, review: await reviewFor(enrId) });
      return true;
    }

    const planOne = pathname.match(/^\/api\/academy\/plans\/(\d+)$/);
    if (planOne && method === "PATCH") {
      const pid = Number(planOne[1]);
      const plan = await dbGet("SELECT * FROM academy_dev_plans WHERE id = ?", [pid]).catch(() => null);
      if (!plan) { json(res, 404, { error: "No such plan." }); return true; }
      const enr = await dbGet("SELECT * FROM academy_enrollments WHERE id = ?", [plan.enrollment_id]).catch(() => null);
      const isSubject = !!(me && enr && Number(enr.employee_id) === Number(me.id));
      const mentorHere = !!(me && enr && enr.mentor_id && Number(enr.mentor_id) === Number(me.id));
      if (isSubject) { json(res, 403, { error: "You cannot close your own development plan." }); return true; }
      if (!(lead || mentorHere)) { json(res, 403, { error: "Not permitted" }); return true; }
      const b = await readBody(req).catch(() => ({}));
      if (!clean(b.outcome)) { json(res, 400, { error: "Say what the reassessment found." }); return true; }
      await dbRun(
        "UPDATE academy_dev_plans SET state = 'closed', outcome = ?, closed_by = ?, closed_at = ? WHERE id = ?",
        [clean(b.outcome), actor, nowISO(), pid]);
      await audit(plan.enrollment_id, null, "dev_plan_closed", "open", "closed", actor, clean(b.outcome));
      json(res, 200, { ok: true });
      return true;
    }

    // ---- REPORTS ---------------------------------------------------------
    //
    // What leadership needs to run the programme rather than admire it: who
    // is behind, how long it actually takes, which competencies get sent
    // back, which topics people keep saying they were never taught, and how
    // much time the training is costing.
    //
    // TRAINING HOURS APPEAR HERE AND NOWHERE NEAR A PAY FIGURE. They are
    // read from academy_hours, which no billing or timecard code touches.
    if (pathname === "/api/academy/reports" && method === "GET") {
      if (!lead) { json(res, 403, { error: "Only clinical leadership can read the reports." }); return true; }
      const progKey = clean(query && query.program) || "bcba-30day";
      const prog = await dbGet("SELECT * FROM academy_programs WHERE key = ?", [progKey]).catch(() => null);
      if (!prog) { json(res, 404, { error: "No such programme." }); return true; }

      const enrs = await dbAll(
        `SELECT a.*, e.name, e.role_title, m.name AS mentor_name
           FROM academy_enrollments a
           JOIN hr_employees e ON e.id = a.employee_id
           LEFT JOIN hr_employees m ON m.id = a.mentor_id
          WHERE a.program_id = ? ORDER BY a.start_date DESC`, [prog.id]).catch(() => []);

      const people = [];
      const completedDays = [];
      for (const a of enrs) {
        const pr = await progressFor(a);
        const rv = await reviewFor(a.id);
        const h = await dbGet("SELECT COALESCE(SUM(hours),0)::float AS t FROM academy_hours WHERE enrollment_id = ?",
                              [a.id]).catch(() => null);
        if (a.state === "completed" && a.completed_at) {
          const d = Math.round((new Date(a.completed_at) - new Date(a.start_date)) / 86400000);
          if (d >= 0) completedDays.push(d);
        }
        people.push({
          enrollment_id: a.id, name: a.name, role_title: a.role_title, mentor_name: a.mentor_name || null,
          state: a.state, start_date: a.start_date, due_date: a.due_date, completed_at: a.completed_at,
          curriculum_version: Number(a.program_version),
          percent: pr.percent, day: pr.day,
          awaiting_review: pr.awaiting_review, needs_training: pr.needs_training,
          // OVERDUE IS THE ONE FIGURE THIS REPORT IS FOR: somebody past
          // their date with nobody having noticed.
          overdue: a.state === "active" && !!a.due_date && a.due_date < today(),
          review_state: rv ? rv.state : null,
          open_plans: rv ? rv.open_plans : 0,
          training_hours: h ? Math.round(Number(h.t) * 10) / 10 : 0,
        });
      }

      // Competencies: how often one is sent back before it is signed off.
      // A competency nobody ever fails is not being assessed.
      const comp = await dbGet(
        `SELECT
           COUNT(*) FILTER (WHERE p.status = 'completed')::int AS signed_off,
           COUNT(*) FILTER (WHERE p.status = 'needs_training')::int AS sent_back,
           COUNT(*) FILTER (WHERE p.status = 'awaiting_review')::int AS waiting
         FROM academy_progress p
         JOIN academy_items i ON i.id = p.item_id
         JOIN academy_enrollments a ON a.id = p.enrollment_id
        WHERE a.program_id = ? AND i.kind = 'competency'`, [prog.id]).catch(() => null);

      // The topics people say they were never taught. Recurring ones are a
      // gap in the programme rather than in a person, which is the reason
      // gaps are a table and not a flag.
      const gaps = await dbAll(
        `SELECT LOWER(TRIM(g.topic)) AS topic, COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE g.status <> 'resolved')::int AS open
           FROM academy_gaps g JOIN academy_enrollments a ON a.id = g.enrollment_id
          WHERE a.program_id = ?
          GROUP BY LOWER(TRIM(g.topic)) ORDER BY n DESC, topic LIMIT 25`, [prog.id]).catch(() => []);

      const plans = await dbAll(
        `SELECT d.*, e.name FROM academy_dev_plans d
           JOIN academy_enrollments a ON a.id = d.enrollment_id
           JOIN hr_employees e ON e.id = a.employee_id
          WHERE a.program_id = ? AND d.state = 'open' ORDER BY d.due_date`, [prog.id]).catch(() => []);

      const hoursTotal = people.reduce((t, p) => t + Number(p.training_hours || 0), 0);
      json(res, 200, {
        program: { id: prog.id, key: prog.key, name: prog.name, version: Number(prog.version),
                   weeks: Number(prog.weeks), duration_days: Number(prog.duration_days) },
        counts: {
          total: enrs.length,
          active: enrs.filter((a) => a.state === "active").length,
          completed: enrs.filter((a) => a.state === "completed").length,
          paused: enrs.filter((a) => a.state === "paused").length,
          overdue: people.filter((p) => p.overdue).length,
          review_due: people.filter((p) => p.state === "active" && p.day >= Number(prog.duration_days)
                                            && p.review_state !== "approved" && p.review_state !== "development_plan").length,
        },
        // A MEDIAN, over FINISHED onboardings only.
        //
        // A median because with four completions and one person who took
        // ninety days a mean describes a programme nobody experienced. And
        // finished-only because counting people still going reports a figure
        // that falls as the programme gets slower, which is backwards.
        median_days_to_complete: median(completedDays),
        completed_counted: completedDays.length,
        competencies: comp || { signed_off: 0, sent_back: 0, waiting: 0 },
        training_hours: {
          total: Math.round(hoursTotal * 10) / 10,
          per_person: people.length ? Math.round((hoursTotal / people.length) * 10) / 10 : 0,
          note: "Training hours. Not billable, not sent to payroll, not part of any Rethink figure.",
        },
        recurring_gaps: gaps,
        open_plans: plans.map((d) => ({
          id: d.id, name: d.name, domain: d.domain, action: d.action,
          due_date: d.due_date, reassess_on: d.reassess_on,
          overdue: d.due_date < today(),
        })),
        people,
      });
      return true;
    }

    if (pathname === "/api/academy/reports.csv" && method === "GET") {
      if (!lead) { json(res, 403, { error: "Only clinical leadership can export the reports." }); return true; }
      const progKey = clean(query && query.program) || "bcba-30day";
      const prog = await dbGet("SELECT * FROM academy_programs WHERE key = ?", [progKey]).catch(() => null);
      if (!prog) { json(res, 404, { error: "No such programme." }); return true; }
      const enrs = await dbAll(
        `SELECT a.*, e.name, e.role_title, m.name AS mentor_name
           FROM academy_enrollments a
           JOIN hr_employees e ON e.id = a.employee_id
           LEFT JOIN hr_employees m ON m.id = a.mentor_id
          WHERE a.program_id = ? ORDER BY e.name`, [prog.id]).catch(() => []);
      const head = ["Name", "Role", "Mentor", "State", "Start", "Due", "Completed",
                    "Curriculum version", "Percent", "Day", "Awaiting review", "Needs training",
                    "Overdue", "Review", "Open plans", "Training hours"];
      const lines = [head.join(",")];
      for (const a of enrs) {
        const pr = await progressFor(a);
        const rv = await reviewFor(a.id);
        const h = await dbGet("SELECT COALESCE(SUM(hours),0)::float AS t FROM academy_hours WHERE enrollment_id = ?",
                              [a.id]).catch(() => null);
        lines.push([
          a.name, a.role_title || "", a.mentor_name || "", a.state, a.start_date, a.due_date || "",
          a.completed_at || "", a.program_version, pr.percent, pr.day, pr.awaiting_review, pr.needs_training,
          a.state === "active" && a.due_date && a.due_date < today() ? "yes" : "",
          rv ? rv.state : "", rv ? rv.open_plans : 0,
          h ? Math.round(Number(h.t) * 10) / 10 : 0,
        ].map(csvCell).join(","));
      }
      const body = lines.join("\r\n") + "\r\n";
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="academy-${prog.key}-${today()}.csv"`,
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
      return true;
    }

    // ---- THE ANONYMOUS SURVEY --------------------------------------------
    if (pathname === "/api/academy/survey" && method === "GET") {
      const mine = me ? await dbGet(
        `SELECT a.* FROM academy_enrollments a WHERE a.employee_id = ? ORDER BY a.id DESC LIMIT 1`,
        [me.id]).catch(() => null) : null;
      const done = mine ? await dbGet("SELECT * FROM academy_survey_done WHERE enrollment_id = ?",
                                      [mine.id]).catch(() => null) : null;
      json(res, 200, {
        questions: SURVEY_QUESTIONS.map(([key, text]) => ({ key, text, scale: SURVEY_SCALES.includes(key) })),
        can_submit: !!mine && !done,
        already: !!done,
        // SAID PLAINLY, BECAUSE THE ONE THING THAT MUST NOT HAPPEN IS
        // SOMEBODY TRUSTING THIS MORE THAN IT DESERVES. The answers carry no
        // identifier. What free text gives away is not something the CRM can
        // take back, so the form says so rather than implying otherwise.
        promise: "Your answers are stored with no link to your name, your account or your onboarding record — "
               + "not hidden, absent. Nobody can look up who said what, including the person who built this. "
               + "What you write in your own words could still identify you, so write it the way you would say it "
               + "in a room where you did not mind being recognised.",
        threshold: SURVEY_MIN,
      });
      return true;
    }

    if (pathname === "/api/academy/survey" && method === "POST") {
      if (!me) { json(res, 403, { error: "This login is not linked to a staff record." }); return true; }
      const enr = await dbGet(
        "SELECT * FROM academy_enrollments WHERE employee_id = ? ORDER BY id DESC LIMIT 1",
        [me.id]).catch(() => null);
      if (!enr) { json(res, 400, { error: "You are not enrolled in an onboarding programme." }); return true; }
      const done = await dbGet("SELECT * FROM academy_survey_done WHERE enrollment_id = ?", [enr.id]).catch(() => null);
      if (done) { json(res, 400, { error: "You have already given feedback on this programme." }); return true; }

      const b = await readBody(req).catch(() => ({}));
      const scales = {};
      for (const k of SURVEY_SCALES) {
        const v = Number(b[k]);
        if (!Number.isInteger(v) || v < 1 || v > 5) {
          json(res, 400, { error: "Answer each of the three ratings, 1 to 5." }); return true;
        }
        scales[k] = v;
      }

      // TWO WRITES THAT MUST NOT BE JOINABLE, and the order matters: the
      // marker goes first, so a crash between them loses a response rather
      // than letting somebody submit twice. Losing one anonymous answer is
      // the cheaper failure.
      const marker = await dbGet(
        `INSERT INTO academy_survey_done (enrollment_id, submitted_at) VALUES (?, ?)
         ON CONFLICT (enrollment_id) DO NOTHING RETURNING id`, [enr.id, nowISO()]).catch(() => null);
      if (!marker) { json(res, 400, { error: "You have already given feedback on this programme." }); return true; }

      await dbRun(
        `INSERT INTO academy_survey_responses
           (program_id, program_version, prepared, mentor_time, set_up_to_do_job, missing, change_what, submitted_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [enr.program_id, enr.program_version, scales.prepared, scales.mentor_time, scales.set_up_to_do_job,
         clean(b.missing) || null, clean(b.change_what) || null,
         // DATE ONLY, not a timestamp. A response filed at 14:52:07 and a
         // marker written at 14:52:07 are the same person to anybody with
         // both tables, which would undo the whole design.
         today()]);
      json(res, 200, { ok: true });
      return true;
    }

    if (pathname === "/api/academy/survey/results" && method === "GET") {
      if (!lead) { json(res, 403, { error: "Only clinical leadership can read the feedback." }); return true; }
      const progKey = clean(query && query.program) || "bcba-30day";
      const prog = await dbGet("SELECT * FROM academy_programs WHERE key = ?", [progKey]).catch(() => null);
      if (!prog) { json(res, 404, { error: "No such programme." }); return true; }
      const rows = await dbAll(
        "SELECT * FROM academy_survey_responses WHERE program_id = ? ORDER BY submitted_at DESC",
        [prog.id]).catch(() => []);
      const asked = await dbGet(
        `SELECT COUNT(*)::int AS n FROM academy_enrollments WHERE program_id = ? AND state = 'completed'`,
        [prog.id]).catch(() => null);

      if (rows.length < SURVEY_MIN) {
        // The count is safe to show; the answers are not. Saying how many
        // more are needed is the difference between a withheld report and a
        // broken one.
        json(res, 200, {
          responses: rows.length, withheld: true, threshold: SURVEY_MIN,
          completed_onboardings: asked ? Number(asked.n) : 0,
          reason: `Feedback stays sealed until ${SURVEY_MIN} people have answered. With fewer than that, `
                + "everybody can work out whose answers they are reading.",
        });
        return true;
      }
      const avg = (k) => {
        const v = rows.map((r) => Number(r[k])).filter((n) => n >= 1);
        return v.length ? Math.round((v.reduce((a, x) => a + x, 0) / v.length) * 10) / 10 : null;
      };
      json(res, 200, {
        responses: rows.length,
        withheld: false,
        completed_onboardings: asked ? Number(asked.n) : 0,
        averages: { prepared: avg("prepared"), mentor_time: avg("mentor_time"),
                    set_up_to_do_job: avg("set_up_to_do_job") },
        // Free text in submission order would pair with the marker table's
        // order. Shuffled, and dates only, so reading order says nothing.
        comments: shuffle(rows.flatMap((r) => [
          r.missing ? { q: "What was missing", text: r.missing } : null,
          r.change_what ? { q: "What to change", text: r.change_what } : null,
        ]).filter(Boolean)),
      });
      return true;
    }

    // ---- the curriculum, for anybody who can see the hub -----------------
    if (pathname === "/api/academy/curriculum" && method === "GET") {
      const prog = await dbGet("SELECT * FROM academy_programs WHERE key = ?",
                               [clean(query && query.program) || "bcba-30day"]).catch(() => null);
      if (!prog) { json(res, 404, { error: "No such programme." }); return true; }
      // AT A VERSION. Somebody enrolled on version 1 reading the curriculum
      // page must see version 1, or the page and their own checklist would
      // disagree about what the programme contains.
      let ver = null;
      if (query && query.version) ver = Number(query.version) || null;
      if (ver == null && me) {
        const mine = await dbGet(
          "SELECT program_version FROM academy_enrollments WHERE employee_id = ? AND program_id = ?",
          [me.id, prog.id]).catch(() => null);
        if (mine) ver = Number(mine.program_version);
      }
      const mods = await modulesFor(prog.id, ver);
      const items = await itemsFor(prog.id, ver);
      // WITH THEIR MATERIAL. Without this the curriculum page and the
      // editing screen both show a week's checklist and none of the things
      // attached to it, which looks exactly like nothing was attached.
      const resources = await resourcesFor(mods.map((m) => m.id), items.map((i) => i.id));
      const forItem = (id) => resources.filter((r) => Number(r.item_id) === Number(id));
      const forModule = (id) => resources.filter((r) => !r.item_id && Number(r.module_id) === Number(id));
      json(res, 200, {
        program: prog,
        version: ver == null ? Number(prog.version) : ver,
        modules: mods.map((m) => ({
          ...m,
          resources: forModule(m.id),
          items: items.filter((i) => Number(i.module_id) === Number(m.id))
                      .map((i) => ({ ...i, resources: forItem(i.id) })),
        })),
      });
      return true;
    }

    // =====================================================================
    // CURRICULUM MANAGEMENT
    //
    // The brief's last requirement: the framework has to serve RBT
    // onboarding and Squad Leader development later without disturbing the
    // BCBA Hub. That is why a programme is rows rather than code -- and why
    // leadership can create a second programme here rather than waiting for
    // somebody to write one.
    //
    // THE RULE THAT MAKES VERSIONING REAL: editing a programme nobody is
    // enrolled on edits the rows. Editing one somebody IS enrolled on forks
    // it to the next version, leaving every existing enrolment reading
    // exactly what it read yesterday. Nobody's finished week is rewritten
    // under them, which is the brief's requirement, and the cost is one
    // extra row per edit.
    // =====================================================================
    async function programInUse(programId) {
      const r = await dbGet("SELECT COUNT(*)::int AS n FROM academy_enrollments WHERE program_id = ?",
                            [programId]).catch(() => null);
      return !!(r && Number(r.n) > 0);
    }

    // Returns the version to write new rows at, bumping the programme when
    // it is in use. Called once per edit.
    async function versionForEdit(prog) {
      if (!(await programInUse(prog.id))) return { version: Number(prog.version), forked: false };
      const next = Number(prog.version) + 1;
      await dbRun("UPDATE academy_programs SET version = ?, updated_at = ? WHERE id = ?",
                  [next, nowISO(), prog.id]);
      return { version: next, forked: true };
    }

    const progOf = async (moduleId) => await dbGet(
      `SELECT p.* FROM academy_programs p JOIN academy_modules m ON m.program_id = p.id WHERE m.id = ?`,
      [moduleId]).catch(() => null);

    // RUN THE AUTO-ENROLMENT NOW. The sweep runs on boot and on a schedule,
    // which is right for the ordinary case and no use at all when somebody
    // has just fixed a missing hire date and wants that BCBA's thirty days
    // to start today. Leadership only, and it enrols nobody the scheduled
    // sweep would not have enrolled anyway.
    if (pathname === "/api/academy/sweep" && method === "POST") {
      if (!lead) { json(res, 403, { error: "Only clinical leadership can run the enrolment sweep." }); return true; }
      const enrolled = await autoEnrolSweep(actor);
      json(res, 200, { ok: true, enrolled, count: enrolled.length });
      return true;
    }

    if (pathname === "/api/academy/programs" && method === "GET") {
      if (!lead) { json(res, 403, { error: "Only clinical leadership can manage the curriculum." }); return true; }
      const rows = await dbAll("SELECT * FROM academy_programs ORDER BY active DESC, name").catch(() => []);
      const out = [];
      for (const r of rows) {
        const c = await dbGet(
          "SELECT COUNT(*)::int AS n FROM academy_enrollments WHERE program_id = ?", [r.id]).catch(() => null);
        const mods = await modulesFor(r.id);
        const items = await itemsFor(r.id);
        out.push({ ...r, enrolled: c ? Number(c.n) : 0, modules: mods.length, items: items.length });
      }
      json(res, 200, { programs: out });
      return true;
    }

    if (pathname === "/api/academy/programs" && method === "POST") {
      if (!lead) { json(res, 403, { error: "Only clinical leadership can create a programme." }); return true; }
      const b = await readBody(req).catch(() => ({}));
      const name = clean(b.name);
      if (!name) { json(res, 400, { error: "Give the programme a name." }); return true; }
      const key = clean(b.key) || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (!key) { json(res, 400, { error: "That name does not make a usable key." }); return true; }
      const exists = await dbGet("SELECT id FROM academy_programs WHERE key = ?", [key]).catch(() => null);
      if (exists) { json(res, 400, { error: "A programme with that key already exists." }); return true; }
      const weeks = Math.max(1, Math.min(52, num(b.weeks) || 4));
      const days = Math.max(1, Math.min(730, num(b.duration_days) || weeks * 7));
      // ROLE TARGET IS WHAT AUTO-ENROLS, and it is opt-in. The sweep takes
      // programmes that are active AND carry a role_target, so a new
      // programme is usable immediately -- leadership can enrol a pilot
      // cohort by hand -- while nobody is swept onto a half-written
      // curriculum because it was saved.
      //
      // `active` is NOT that switch: it means the programme exists at all,
      // and enrolling anybody onto an inactive one is refused. Defaulting it
      // to false, as the first version of this did, made a new programme
      // impossible to enrol onto and looked like the programme had not saved.
      const row = await dbGet(
        `INSERT INTO academy_programs (key, name, role_target, weeks, duration_days, weekly_hours_target,
           version, active, created_at, updated_at)
         VALUES (?,?,?,?,?,?, 1, ?, ?, ?) RETURNING *`,
        [key, name, clean(b.role_target) || null, weeks, days, num(b.weekly_hours_target) || 5,
         b.active !== false, nowISO(), nowISO()]).catch(() => null);
      if (!row) { json(res, 500, { error: "The programme could not be created." }); return true; }
      json(res, 200, { ok: true, program: row });
      return true;
    }

    const progOne = pathname.match(/^\/api\/academy\/programs\/(\d+)$/);
    if (progOne && method === "PATCH") {
      if (!lead) { json(res, 403, { error: "Only clinical leadership can change a programme." }); return true; }
      const prog = await dbGet("SELECT * FROM academy_programs WHERE id = ?", [Number(progOne[1])]).catch(() => null);
      if (!prog) { json(res, 404, { error: "No such programme." }); return true; }
      const b = await readBody(req).catch(() => ({}));
      const sets = [], vals = [];
      if (b.name !== undefined) {
        if (!clean(b.name)) { json(res, 400, { error: "A programme needs a name." }); return true; }
        sets.push("name = ?"); vals.push(clean(b.name));
      }
      if (b.role_target !== undefined) { sets.push("role_target = ?"); vals.push(clean(b.role_target) || null); }
      if (b.weeks !== undefined) { sets.push("weeks = ?"); vals.push(Math.max(1, Math.min(52, num(b.weeks) || 4))); }
      if (b.duration_days !== undefined) {
        sets.push("duration_days = ?"); vals.push(Math.max(1, Math.min(730, num(b.duration_days) || 30)));
      }
      if (b.weekly_hours_target !== undefined) {
        sets.push("weekly_hours_target = ?"); vals.push(num(b.weekly_hours_target) || 0);
      }
      if (b.active !== undefined) { sets.push("active = ?"); vals.push(b.active === true); }
      if (!sets.length) { json(res, 400, { error: "Nothing to change." }); return true; }
      sets.push("updated_at = ?"); vals.push(nowISO());
      vals.push(prog.id);
      await dbRun(`UPDATE academy_programs SET ${sets.join(", ")} WHERE id = ?`, vals);
      json(res, 200, { ok: true, program: await dbGet("SELECT * FROM academy_programs WHERE id = ?", [prog.id]) });
      return true;
    }

    const progMods = pathname.match(/^\/api\/academy\/programs\/(\d+)\/modules$/);
    if (progMods && method === "POST") {
      if (!lead) { json(res, 403, { error: "Only clinical leadership can change the curriculum." }); return true; }
      const prog = await dbGet("SELECT * FROM academy_programs WHERE id = ?", [Number(progMods[1])]).catch(() => null);
      if (!prog) { json(res, 404, { error: "No such programme." }); return true; }
      const b = await readBody(req).catch(() => ({}));
      if (!clean(b.title)) { json(res, 400, { error: "Give the week a title." }); return true; }
      const week = num(b.week);
      if (!week || week < 1 || week > Number(prog.weeks)) {
        json(res, 400, { error: `Week must be between 1 and ${prog.weeks}.` }); return true;
      }
      // ADDING is not editing: nothing existing changes, so an addition does
      // not fork the programme. It appears for new enrolments only, because
      // existing ones stay on their own version.
      const { version } = await versionForEdit(prog);
      const row = await dbGet(
        `INSERT INTO academy_modules (program_id, week, position, title, focus, body, video_url,
           archived, version_from, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?, FALSE, ?, ?, ?) RETURNING *`,
        [prog.id, week, num(b.position) || 0, clean(b.title), clean(b.focus) || null,
         clean(b.body) || null, clean(b.video_url) || null, version, nowISO(), nowISO()]).catch(() => null);
      if (!row) { json(res, 500, { error: "The week could not be added." }); return true; }
      json(res, 200, { ok: true, module: row, version });
      return true;
    }

    const modOne = pathname.match(/^\/api\/academy\/modules\/(\d+)$/);
    if (modOne && (method === "PATCH" || method === "DELETE")) {
      if (!lead) { json(res, 403, { error: "Only clinical leadership can change the curriculum." }); return true; }
      const mod = await dbGet("SELECT * FROM academy_modules WHERE id = ?", [Number(modOne[1])]).catch(() => null);
      if (!mod) { json(res, 404, { error: "No such week." }); return true; }
      if (mod.version_to !== null && mod.version_to !== undefined) {
        json(res, 400, { error: "That week belongs to an older version of the curriculum and cannot be edited." });
        return true;
      }
      const prog = await progOf(mod.id);
      if (!prog) { json(res, 404, { error: "No such programme." }); return true; }
      const b = method === "PATCH" ? await readBody(req).catch(() => ({})) : {};
      const { version, forked } = await versionForEdit(prog);

      if (!forked) {
        // Nobody is on this programme: edit the rows and keep the version.
        if (method === "DELETE") {
          await dbRun("UPDATE academy_modules SET archived = TRUE, version_to = ? WHERE id = ?", [version + 1, mod.id]);
          await dbRun("UPDATE academy_items SET archived = TRUE, version_to = ? WHERE module_id = ? AND version_to IS NULL",
                      [version + 1, mod.id]);
          // version+1 on an unused programme is only a bookkeeping marker:
          // nothing reads a version above the programme's own.
          await dbRun("UPDATE academy_programs SET version = ?, updated_at = ? WHERE id = ?",
                      [version + 1, nowISO(), prog.id]);
          json(res, 200, { ok: true, removed: true, version: version + 1 });
          return true;
        }
        const sets = [], vals = [];
        for (const [k, f] of [["title", clean], ["focus", clean], ["body", clean], ["video_url", clean]]) {
          if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(f(b[k]) || null); }
        }
        if (b.week !== undefined) {
          const w = num(b.week);
          if (!w || w < 1 || w > Number(prog.weeks)) { json(res, 400, { error: `Week must be between 1 and ${prog.weeks}.` }); return true; }
          sets.push("week = ?"); vals.push(w);
        }
        if (b.position !== undefined) { sets.push("position = ?"); vals.push(num(b.position) || 0); }
        if (!sets.length) { json(res, 400, { error: "Nothing to change." }); return true; }
        if (sets.some((x) => x.startsWith("title")) && !clean(b.title)) {
          json(res, 400, { error: "A week needs a title." }); return true;
        }
        sets.push("updated_at = ?"); vals.push(nowISO());
        vals.push(mod.id);
        await dbRun(`UPDATE academy_modules SET ${sets.join(", ")} WHERE id = ?`, vals);
        json(res, 200, { ok: true, module: await dbGet("SELECT * FROM academy_modules WHERE id = ?", [mod.id]), version });
        return true;
      }

      // FORKED. Close the old week at the new version and, unless it is
      // being removed, open a replacement -- carrying its live items across,
      // because a new module row with no items is a week that silently
      // emptied itself.
      await dbRun("UPDATE academy_modules SET version_to = ? WHERE id = ?", [version, mod.id]);
      await dbRun("UPDATE academy_items SET version_to = ? WHERE module_id = ? AND version_to IS NULL",
                  [version, mod.id]);
      if (method === "DELETE") {
        json(res, 200, { ok: true, removed: true, forked: true, version });
        return true;
      }
      if (b.title !== undefined && !clean(b.title)) {
        json(res, 400, { error: "A week needs a title." }); return true;
      }
      let week = mod.week;
      if (b.week !== undefined) {
        const w = num(b.week);
        if (!w || w < 1 || w > Number(prog.weeks)) { json(res, 400, { error: `Week must be between 1 and ${prog.weeks}.` }); return true; }
        week = w;
      }
      const fresh = await dbGet(
        `INSERT INTO academy_modules (program_id, week, position, title, focus, body, video_url,
           archived, version_from, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?, FALSE, ?, ?, ?) RETURNING *`,
        [prog.id, week, b.position !== undefined ? (num(b.position) || 0) : mod.position,
         b.title !== undefined ? clean(b.title) : mod.title,
         b.focus !== undefined ? (clean(b.focus) || null) : mod.focus,
         b.body !== undefined ? (clean(b.body) || null) : mod.body,
         b.video_url !== undefined ? (clean(b.video_url) || null) : mod.video_url,
         version, nowISO(), nowISO()]).catch(() => null);
      if (!fresh) { json(res, 500, { error: "The week could not be updated." }); return true; }
      const carry = await dbAll("SELECT * FROM academy_items WHERE module_id = ? AND version_to = ?",
                                [mod.id, version]).catch(() => []);
      for (const it of carry) {
        const copy = await dbGet(
          `INSERT INTO academy_items (module_id, kind, title, detail, required, position, archived, version_from, created_at)
           VALUES (?,?,?,?,?,?, FALSE, ?, ?) RETURNING id`,
          [fresh.id, it.kind, it.title, it.detail, it.required, it.position, version, nowISO()]).catch(() => null);
        // AND THE ITEM'S OWN ATTACHMENTS. A forked week that kept its
        // checklist but lost everything to read would look complete and be
        // useless.
        if (copy) await copyResources({ fromItem: it.id, toItem: copy.id, actor });
      }
      const movedRes = await copyResources({ fromModule: mod.id, toModule: fresh.id, actor });
      json(res, 200, { ok: true, module: fresh, forked: true, version,
                       carried: carry.length, resources_carried: movedRes });
      return true;
    }

    const modItems = pathname.match(/^\/api\/academy\/modules\/(\d+)\/items$/);
    if (modItems && method === "POST") {
      if (!lead) { json(res, 403, { error: "Only clinical leadership can change the curriculum." }); return true; }
      const mod = await dbGet("SELECT * FROM academy_modules WHERE id = ?", [Number(modItems[1])]).catch(() => null);
      if (!mod) { json(res, 404, { error: "No such week." }); return true; }
      if (mod.version_to !== null && mod.version_to !== undefined) {
        json(res, 400, { error: "That week belongs to an older version of the curriculum." }); return true;
      }
      const prog = await progOf(mod.id);
      const b = await readBody(req).catch(() => ({}));
      if (!clean(b.title)) { json(res, 400, { error: "Give the item a title." }); return true; }
      const kind = clean(b.kind) || "reading";
      if (!ITEM_KINDS.includes(kind)) {
        json(res, 400, { error: "An item is a reading, a checklist item, a competency, or a quiz." }); return true;
      }
      const { version } = await versionForEdit(prog);
      const row = await dbGet(
        `INSERT INTO academy_items (module_id, kind, title, detail, required, position, archived, version_from, created_at)
         VALUES (?,?,?,?,?,?, FALSE, ?, ?) RETURNING *`,
        [mod.id, kind, clean(b.title), clean(b.detail) || null,
         b.required !== false, num(b.position) || 0, version, nowISO()]).catch(() => null);
      if (!row) { json(res, 500, { error: "The item could not be added." }); return true; }
      json(res, 200, { ok: true, item: row, version });
      return true;
    }

    const itemEdit = pathname.match(/^\/api\/academy\/items\/(\d+)$/);
    if (itemEdit && (method === "PATCH" || method === "DELETE")) {
      if (!lead) { json(res, 403, { error: "Only clinical leadership can change the curriculum." }); return true; }
      const item = await dbGet("SELECT * FROM academy_items WHERE id = ?", [Number(itemEdit[1])]).catch(() => null);
      if (!item) { json(res, 404, { error: "No such item." }); return true; }
      if (item.version_to !== null && item.version_to !== undefined) {
        json(res, 400, { error: "That item belongs to an older version of the curriculum." }); return true;
      }
      const prog = await progOf(item.module_id);
      if (!prog) { json(res, 404, { error: "No such programme." }); return true; }
      const b = method === "PATCH" ? await readBody(req).catch(() => ({})) : {};
      if (method === "PATCH" && b.kind !== undefined && !ITEM_KINDS.includes(clean(b.kind))) {
        json(res, 400, { error: "An item is a reading, a checklist item, a competency, or a quiz." }); return true;
      }
      if (method === "PATCH" && b.title !== undefined && !clean(b.title)) {
        json(res, 400, { error: "An item needs a title." }); return true;
      }
      const { version, forked } = await versionForEdit(prog);

      if (!forked) {
        if (method === "DELETE") {
          await dbRun("UPDATE academy_items SET archived = TRUE, version_to = ? WHERE id = ?", [version + 1, item.id]);
          await dbRun("UPDATE academy_programs SET version = ?, updated_at = ? WHERE id = ?",
                      [version + 1, nowISO(), prog.id]);
          json(res, 200, { ok: true, removed: true, version: version + 1 });
          return true;
        }
        const sets = [], vals = [];
        for (const [k, f] of [["title", clean], ["detail", clean], ["kind", clean]]) {
          if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(f(b[k]) || null); }
        }
        if (b.required !== undefined) { sets.push("required = ?"); vals.push(b.required !== false); }
        if (b.position !== undefined) { sets.push("position = ?"); vals.push(num(b.position) || 0); }
        if (!sets.length) { json(res, 400, { error: "Nothing to change." }); return true; }
        vals.push(item.id);
        await dbRun(`UPDATE academy_items SET ${sets.join(", ")} WHERE id = ?`, vals);
        json(res, 200, { ok: true, item: await dbGet("SELECT * FROM academy_items WHERE id = ?", [item.id]), version });
        return true;
      }

      await dbRun("UPDATE academy_items SET version_to = ? WHERE id = ?", [version, item.id]);
      if (method === "DELETE") {
        json(res, 200, { ok: true, removed: true, forked: true, version });
        return true;
      }
      const fresh = await dbGet(
        `INSERT INTO academy_items (module_id, kind, title, detail, required, position, archived, version_from, created_at)
         VALUES (?,?,?,?,?,?, FALSE, ?, ?) RETURNING *`,
        [item.module_id,
         b.kind !== undefined ? clean(b.kind) : item.kind,
         b.title !== undefined ? clean(b.title) : item.title,
         b.detail !== undefined ? (clean(b.detail) || null) : item.detail,
         b.required !== undefined ? (b.required !== false) : item.required,
         b.position !== undefined ? (num(b.position) || 0) : item.position,
         version, nowISO()]).catch(() => null);
      if (!fresh) { json(res, 500, { error: "The item could not be updated." }); return true; }
      const resCarried = await copyResources({ fromItem: item.id, toItem: fresh.id, actor });
      json(res, 200, { ok: true, item: fresh, forked: true, version, resources_carried: resCarried });
      return true;
    }

    // ---- THE TRAINING LIBRARY, as leadership manages it ------------------
    if (pathname === "/api/academy/resources" && method === "POST") {
      if (!lead) { json(res, 403, { error: "Only clinical leadership can add training material." }); return true; }
      const b = await readBody(req).catch(() => ({}));
      const kind = clean(b.kind) || "link";
      if (!RESOURCE_KINDS.includes(kind)) {
        json(res, 400, { error: "A resource is a document, a video, a link, or a note." }); return true;
      }
      const modId = num(b.module_id), itemId = num(b.item_id);
      if (!modId && !itemId) { json(res, 400, { error: "Attach it to a week or to an item." }); return true; }
      if (modId && itemId) { json(res, 400, { error: "Attach it to a week or to an item, not both." }); return true; }
      // It has to attach to something that is still part of the CURRENT
      // curriculum, or it would appear for nobody.
      if (modId) {
        const m = await dbGet("SELECT * FROM academy_modules WHERE id = ?", [modId]).catch(() => null);
        if (!m) { json(res, 404, { error: "No such week." }); return true; }
        if (m.version_to !== null && m.version_to !== undefined) {
          json(res, 400, { error: "That week belongs to an older version of the curriculum." }); return true;
        }
      }
      if (itemId) {
        const it = await dbGet("SELECT * FROM academy_items WHERE id = ?", [itemId]).catch(() => null);
        if (!it) { json(res, 404, { error: "No such item." }); return true; }
        if (it.version_to !== null && it.version_to !== undefined) {
          json(res, 400, { error: "That item belongs to an older version of the curriculum." }); return true;
        }
      }

      let policyId = null, url = null, body = null, title = clean(b.title);
      if (kind === "document") {
        // A DOCUMENT POINTS AT THE POLICY LIBRARY. Letting it hold pasted
        // text instead would create a second copy of an SOP that stops
        // matching the first the day somebody amends it.
        policyId = num(b.policy_id);
        if (!policyId) { json(res, 400, { error: "Choose a policy or SOP from the library." }); return true; }
        const pol = await dbGet("SELECT id, title FROM crm_policies WHERE id = ?", [policyId]).catch(() => null);
        if (!pol) { json(res, 404, { error: "That policy is not in the library." }); return true; }
        if (!title) title = pol.title;
      } else if (kind === "note") {
        body = clean(b.body);
        if (!body) { json(res, 400, { error: "Write the note." }); return true; }
        if (!title) { json(res, 400, { error: "Give the note a title." }); return true; }
      } else {
        url = safeUrl(b.url);
        if (url === null) { json(res, 400, { error: "Give it a link." }); return true; }
        if (url === false) { json(res, 400, { error: "That is not a web address. It must start with http:// or https://." }); return true; }
        if (!title) { json(res, 400, { error: "Give it a title." }); return true; }
      }

      const row = await dbGet(
        `INSERT INTO academy_resources (module_id, item_id, kind, title, url, policy_id, body, position, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING *`,
        [modId || null, itemId || null, kind, title, url, policyId, body,
         num(b.position) || 0, actor, nowISO()]).catch(() => null);
      if (!row) { json(res, 500, { error: "The resource could not be saved." }); return true; }
      json(res, 200, { ok: true, resource: row });
      return true;
    }

    const resOne = pathname.match(/^\/api\/academy\/resources\/(\d+)$/);
    if (resOne && method === "DELETE") {
      if (!lead) { json(res, 403, { error: "Only clinical leadership can remove training material." }); return true; }
      const id = Number(resOne[1]);
      const row = await dbGet("SELECT * FROM academy_resources WHERE id = ?", [id]).catch(() => null);
      if (!row) { json(res, 404, { error: "No such resource." }); return true; }
      // Removing an attachment never touches the policy it points at.
      await dbRun("DELETE FROM academy_resources WHERE id = ?", [id]);
      json(res, 200, { ok: true });
      return true;
    }

    // ---- TRAINING HOURS --------------------------------------------------
    //
    // Separate from billable by construction: its own table, read by nothing
    // in billing or the timecard. Logged by the employee about their own
    // training, or by a supervisor about theirs.
    const hoursMatch = pathname.match(/^\/api\/academy\/enrollments\/(\d+)\/hours$/);
    if (hoursMatch && (method === "GET" || method === "POST")) {
      const enrId = Number(hoursMatch[1]);
      const enr = await dbGet("SELECT * FROM academy_enrollments WHERE id = ?", [enrId]).catch(() => null);
      if (!enr) { json(res, 404, { error: "No such onboarding record." }); return true; }
      const isSubject = !!(me && Number(enr.employee_id) === Number(me.id));
      const mentorHere = !!(me && enr.mentor_id && Number(enr.mentor_id) === Number(me.id));
      if (!(isSubject || mentorHere || lead)) { json(res, 403, { error: "Not permitted" }); return true; }

      if (method === "GET") {
        const rows = await dbAll(
          "SELECT * FROM academy_hours WHERE enrollment_id = ? ORDER BY on_date DESC, id DESC", [enrId]).catch(() => []);
        const total = rows.reduce((a, r) => a + Number(r.hours || 0), 0);
        const prog = await dbGet("SELECT weekly_hours_target, weeks FROM academy_programs WHERE id = ?",
                                 [enr.program_id]).catch(() => null);
        json(res, 200, {
          hours: rows,
          total: Math.round(total * 100) / 100,
          target: prog ? Number(prog.weekly_hours_target || 0) * Number(prog.weeks || 0) : null,
          // Said out loud on the endpoint, because the one way this feature
          // fails is somebody assuming these hours went somewhere else too.
          note: "Training hours only. These are not billable hours and are not sent to payroll or Rethink.",
        });
        return true;
      }

      // THE SUBJECT MAY LOG THEIR OWN TRAINING TIME. This is not a
      // self-assessment of competence -- it is "I spent two hours on this" --
      // and the person who knows that is the person who spent it.
      const b = await readBody(req).catch(() => ({}));
      if (!isDate(b.on_date)) { json(res, 400, { error: "Which day was it?" }); return true; }
      if (clean(b.on_date) > today()) { json(res, 400, { error: "That day has not happened yet." }); return true; }
      const hrs = Number(b.hours);
      if (!(hrs > 0)) { json(res, 400, { error: "How many hours?" }); return true; }
      // A DAY HAS A CEILING. A fat-fingered 80 in a training log that feeds a
      // report is a number somebody will later have to explain.
      if (hrs > 16) { json(res, 400, { error: "That is more than 16 hours in a day. Check the number." }); return true; }
      if (!clean(b.activity)) { json(res, 400, { error: "What was the training?" }); return true; }
      const itemId = num(b.item_id);
      if (itemId) {
        const it = await dbGet("SELECT id FROM academy_items WHERE id = ?", [itemId]).catch(() => null);
        if (!it) { json(res, 404, { error: "No such item." }); return true; }
      }
      const row = await dbGet(
        `INSERT INTO academy_hours (enrollment_id, item_id, on_date, hours, activity, note, logged_by, created_at)
         VALUES (?,?,?,?,?,?,?,?) RETURNING *`,
        [enrId, itemId || null, clean(b.on_date), Math.round(hrs * 100) / 100,
         clean(b.activity), clean(b.note) || null, actor, nowISO()]).catch(() => null);
      if (!row) { json(res, 500, { error: "The hours could not be saved." }); return true; }
      json(res, 200, { ok: true, entry: row });
      return true;
    }

    const hourOne = pathname.match(/^\/api\/academy\/hours\/(\d+)$/);
    if (hourOne && method === "DELETE") {
      const id = Number(hourOne[1]);
      const row = await dbGet("SELECT * FROM academy_hours WHERE id = ?", [id]).catch(() => null);
      if (!row) { json(res, 404, { error: "No such entry." }); return true; }
      const enr = await dbGet("SELECT * FROM academy_enrollments WHERE id = ?", [row.enrollment_id]).catch(() => null);
      const isSubject = !!(me && enr && Number(enr.employee_id) === Number(me.id));
      // Somebody can delete their own mistake; leadership can delete
      // anybody's. A mentor cannot quietly remove somebody's record of the
      // time they put in.
      if (!(isSubject || lead)) { json(res, 403, { error: "Not permitted" }); return true; }
      await dbRun("DELETE FROM academy_hours WHERE id = ?", [id]);
      json(res, 200, { ok: true });
      return true;
    }

    // MOVING SOMEBODY TO THE CURRENT CURRICULUM, deliberately, one person at
    // a time. Forking leaves active enrolments where they are, which is
    // right for a rewritten week and wrong for a corrected typo -- so the
    // move exists, it is explicit, and it is audited. It is never automatic.
    const verMove = pathname.match(/^\/api\/academy\/enrollments\/(\d+)\/curriculum-version$/);
    if (verMove && method === "POST") {
      if (!lead) { json(res, 403, { error: "Only clinical leadership can move somebody's curriculum version." }); return true; }
      const enrId = Number(verMove[1]);
      const enr = await dbGet("SELECT * FROM academy_enrollments WHERE id = ?", [enrId]).catch(() => null);
      if (!enr) { json(res, 404, { error: "No such onboarding record." }); return true; }
      const prog = await dbGet("SELECT * FROM academy_programs WHERE id = ?", [enr.program_id]).catch(() => null);
      if (!prog) { json(res, 404, { error: "No such programme." }); return true; }
      if (Number(enr.program_version) === Number(prog.version)) {
        json(res, 400, { error: "They are already on the current version." }); return true;
      }
      // A COMPLETED ONBOARDING IS A RECORD, NOT A WORK ITEM. Moving one to a
      // newer curriculum would restate what somebody was signed off against,
      // which is the one thing the brief says to preserve.
      if (enr.state === "completed") {
        json(res, 400, { error: "This onboarding is complete. Its curriculum version is part of the record." });
        return true;
      }
      await dbRun("UPDATE academy_enrollments SET program_version = ?, updated_at = ? WHERE id = ?",
                  [Number(prog.version), nowISO(), enrId]);
      await audit(enrId, null, "curriculum_version", String(enr.program_version), String(prog.version), actor,
                  clean((await readBody(req).catch(() => ({}))).note) || null);
      json(res, 200, { ok: true, version: Number(prog.version) });
      return true;
    }

    return false;
  }

  return {
    initTables, handleApi, enrol, autoEnrolSweep, scheduleCheckins, checkinsFor, backfillCheckins,
    reviewFor, leadership, leadershipEmails, isClinicalLead,
    employeeFor, progressFor, itemsFor, modulesFor, resourcesFor, seedBcbaProgram,
    _internal: { STATUSES, STATUS_LABELS, EMPLOYEE_SETTABLE, ITEM_KINDS, ENROLMENT_STATES, BCBA_WEEKS,
                 addDays, CHECKIN_DAYS, GAP_STATUSES, GAP_LABELS, URGENCIES,
                 DOMAINS, DOMAIN_KEYS, RATINGS, RATING_LABELS, REVIEW_STATES, isClosed,
                 RESOURCE_KINDS, safeUrl },
  };
};
