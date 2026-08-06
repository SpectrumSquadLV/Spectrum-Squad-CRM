// hr.js -- Spectrum Squad CRM: HR & Recruiting module (backend)
// Self-contained add-on required by server.js, mirroring the screener.js
// pattern: it owns its own tables, its own /api/hr/* routes, and a public
// careers page, and is wired into server.js with a handful of additive lines.
// It NEVER modifies the existing CRM's tables or behavior.
//
// Design goals:
//   * Functional persistence, backend logic, permissions, audit logging.
//   * Owner-first access control with a role matrix that already supports the
//     future HR roles (hr_admin, hiring_manager, interviewer, employee).
//   * A schema that already contains the future HR / timecard-verification
//     tables so nothing needs restructuring when those phases are built.
//   * Graceful degradation with no external keys (AI screening + email fall
//     back to safe no-ops / simulated mode).
"use strict";

const fs = require("fs");
const path = require("path");

module.exports = function initHr(ctx) {
  const {
    dbGet,
    dbAll,
    dbRun,
    sendEmail,
    nowISO,
    crypto,
    APP_BASE_URL,
    readBody,
    json,
    sendFile,
  } = ctx;

  // ---- file storage (Railway volume at /app/data) ----
  const DATA_DIR = path.join(__dirname, "data");
  const RESUME_DIR = path.join(DATA_DIR, "hr-resumes");
  if (!fs.existsSync(RESUME_DIR)) fs.mkdirSync(RESUME_DIR, { recursive: true });

  // ============================ CONSTANTS ============================

  // The 15-stage applicant pipeline (order matters for the board).
  const PIPELINE_STAGES = [
    { key: "new_applicant", label: "New Applicant", group: "intake" },
    { key: "ai_screening", label: "AI Screening", group: "intake" },
    { key: "needs_human_review", label: "Needs Human Review", group: "intake" },
    { key: "contacted", label: "Contacted", group: "outreach" },
    { key: "responded", label: "Responded", group: "outreach" },
    { key: "phone_screen", label: "Phone Screen", group: "interview" },
    { key: "interview_scheduled", label: "Interview Scheduled", group: "interview" },
    { key: "interviewed", label: "Interviewed", group: "interview" },
    { key: "credentials_references", label: "Credentials & References", group: "decision" },
    { key: "offer_approval", label: "Offer Approval", group: "decision" },
    { key: "offer_sent", label: "Offer Sent", group: "decision" },
    { key: "hired", label: "Hired", group: "closed" },
    { key: "not_selected", label: "Not Selected", group: "closed" },
    { key: "withdrawn", label: "Withdrawn", group: "closed" },
    { key: "talent_pool", label: "Talent Pool", group: "closed" },
  ];
  const STAGE_KEYS = PIPELINE_STAGES.map((s) => s.key);

  const APPLICATION_SOURCES = [
    { key: "indeed", label: "Indeed" },
    { key: "linkedin", label: "LinkedIn" },
    { key: "facebook", label: "Facebook" },
    { key: "bcba_groups", label: "BCBA Groups" },
    { key: "referral", label: "Employee Referral" },
    { key: "university", label: "University" },
    { key: "website", label: "Spectrum Squad Website" },
    { key: "other", label: "Other" },
  ];
  const SOURCE_KEYS = APPLICATION_SOURCES.map((s) => s.key);

  const MATCH_CATEGORIES = [
    { key: "priority_review", label: "Priority Review", rank: 5 },
    { key: "qualified", label: "Qualified", rank: 4 },
    { key: "possibly_qualified", label: "Possibly Qualified", rank: 3 },
    { key: "insufficient_information", label: "Insufficient Information", rank: 2 },
    { key: "does_not_meet", label: "Does Not Meet Stated Minimum Requirements", rank: 1 },
  ];

  // ---- role matrix -------------------------------------------------
  // Spec: "Only the owner/admin should initially have access to this section",
  // and sensitive fields (compensation, ratings, private notes, offers,
  // payroll, timecards, sensitive notes) are owner-only until more accounts
  // are configured. These three lists are the single place to widen access.
  const HR_MANAGE_ROLES = ["owner", "admin", "super_admin", "hr_admin"];
  const HR_ACCESS_ROLES = HR_MANAGE_ROLES.concat(["hiring_manager", "interviewer"]);
  const HR_SENSITIVE_ROLES = ["owner", "super_admin"]; // owner-only per spec (super_admin included as top-tier)

  function hrCanAccess(user) {
    return !!user && HR_ACCESS_ROLES.includes(user.role);
  }
  function hrCanManage(user) {
    return !!user && HR_MANAGE_ROLES.includes(user.role);
  }
  function hrCanSeeSensitive(user) {
    return !!user && HR_SENSITIVE_ROLES.includes(user.role);
  }

  // ============================ SCHEMA ============================
  async function initTables() {
    // ---- recruiting core ----
    await dbRun(`CREATE TABLE IF NOT EXISTS hr_positions (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      role_type TEXT DEFAULT 'other',            -- bcba | rbt | other
      employment_types TEXT DEFAULT '[]',        -- JSON: full_time|part_time|contract
      location_type TEXT DEFAULT 'onsite',       -- hybrid|onsite|remote
      locations TEXT,
      description TEXT,
      highlights TEXT,
      openings_count INTEGER DEFAULT 1,
      status TEXT DEFAULT 'open',                 -- open|paused|closed
      priority TEXT DEFAULT 'normal',            -- urgent|high|normal
      comp_min NUMERIC, comp_max NUMERIC,
      comp_unit TEXT DEFAULT 'year',             -- year|hour
      comp_notes TEXT,
      min_qualifications TEXT DEFAULT '[]',
      preferred_qualifications TEXT DEFAULT '[]',
      screening_questions TEXT DEFAULT '[]',
      hiring_managers TEXT DEFAULT '[]',
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS hr_position_sources (
      id SERIAL PRIMARY KEY,
      position_id INTEGER NOT NULL,
      source TEXT NOT NULL,
      label TEXT,
      token TEXT UNIQUE NOT NULL,
      clicks INTEGER DEFAULT 0,
      applications INTEGER DEFAULT 0,
      created_by TEXT,
      created_at TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS hr_applicants (
      id SERIAL PRIMARY KEY,
      position_id INTEGER,
      full_name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      city TEXT,
      state TEXT,
      source TEXT DEFAULT 'other',
      source_id INTEGER,
      applied_at TEXT,
      stage TEXT DEFAULT 'new_applicant',
      match_category TEXT,
      priority_flag BOOLEAN DEFAULT FALSE,
      cover_letter TEXT,
      screening_answers TEXT DEFAULT '{}',
      credentials TEXT DEFAULT '{}',
      availability TEXT DEFAULT '{}',
      preferred_schedule TEXT,
      comp_expectation TEXT,
      earliest_start TEXT,
      work_setting TEXT,
      assigned_manager TEXT,
      last_contacted_at TEXT,
      last_response_at TEXT,
      next_followup_at TEXT,
      interview_at TEXT,
      offer_status TEXT,
      final_decision TEXT,
      disposition_reason TEXT,
      consent_email BOOLEAN DEFAULT FALSE,
      consent_sms BOOLEAN DEFAULT FALSE,
      do_not_contact BOOLEAN DEFAULT FALSE,
      ai_summary TEXT,
      confirmed_quals TEXT DEFAULT '[]',
      missing_quals TEXT DEFAULT '[]',
      automation_paused BOOLEAN DEFAULT FALSE,
      created_at TEXT,
      updated_at TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS hr_applicant_documents (
      id SERIAL PRIMARY KEY,
      applicant_id INTEGER NOT NULL,
      kind TEXT DEFAULT 'resume',
      filename TEXT,
      mime_type TEXT,
      stored_name TEXT,
      size INTEGER,
      uploaded_by TEXT,
      uploaded_at TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS hr_applicant_stage_history (
      id SERIAL PRIMARY KEY,
      applicant_id INTEGER NOT NULL,
      from_stage TEXT,
      to_stage TEXT,
      changed_by TEXT,
      note TEXT,
      changed_at TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS hr_applicant_notes (
      id SERIAL PRIMARY KEY,
      applicant_id INTEGER NOT NULL,
      author TEXT,
      note_type TEXT DEFAULT 'note',   -- note|interview|rating
      body TEXT,
      rating INTEGER,
      is_private BOOLEAN DEFAULT TRUE,  -- private notes are owner-only per spec
      created_at TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS hr_applicant_messages (
      id SERIAL PRIMARY KEY,
      applicant_id INTEGER NOT NULL,
      direction TEXT NOT NULL,          -- inbound|outbound
      channel TEXT DEFAULT 'email',     -- email|sms|note
      from_addr TEXT,
      to_addr TEXT,
      subject TEXT,
      body TEXT,
      status TEXT,                      -- queued|sent|failed|received
      error TEXT,
      ai_generated BOOLEAN DEFAULT FALSE,
      sent_by TEXT,
      created_at TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS hr_screenings (
      id SERIAL PRIMARY KEY,
      applicant_id INTEGER NOT NULL,
      model TEXT,
      summary TEXT,
      confirmed_quals TEXT DEFAULT '[]',
      unconfirmed_quals TEXT DEFAULT '[]',
      missing_info TEXT DEFAULT '[]',
      strengths TEXT DEFAULT '[]',
      concerns TEXT DEFAULT '[]',
      suggested_questions TEXT DEFAULT '[]',
      recommended_action TEXT,
      match_category TEXT,
      raw_json TEXT,
      created_by TEXT,
      created_at TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS hr_followups (
      id SERIAL PRIMARY KEY,
      applicant_id INTEGER NOT NULL,
      sequence TEXT,
      step TEXT,
      scheduled_at TEXT,
      sent_at TEXT,
      status TEXT DEFAULT 'pending',   -- pending|sent|canceled|failed
      created_at TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS hr_interviews (
      id SERIAL PRIMARY KEY,
      applicant_id INTEGER NOT NULL,
      scheduled_at TEXT,
      duration_min INTEGER DEFAULT 30,
      mode TEXT DEFAULT 'virtual',     -- virtual|in_person
      location_or_link TEXT,
      interviewer TEXT,
      status TEXT DEFAULT 'scheduled', -- scheduled|completed|canceled|no_show|rescheduled
      calendar_event_id TEXT,
      created_at TEXT,
      updated_at TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS hr_notifications (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      applicant_id INTEGER,
      position_id INTEGER,
      title TEXT,
      body TEXT,
      severity TEXT DEFAULT 'info',    -- info|warning|urgent
      target_role TEXT DEFAULT 'owner',
      read BOOLEAN DEFAULT FALSE,
      created_at TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS hr_audit_log (
      id SERIAL PRIMARY KEY,
      actor TEXT,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id INTEGER,
      detail TEXT,
      created_at TEXT
    )`);

    // ---- future HR system (created now so no restructuring later; unused
    //      by the recruiting UI yet) ----
    await dbRun(`CREATE TABLE IF NOT EXISTS hr_employees (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      applicant_id INTEGER,
      name TEXT NOT NULL,
      email TEXT,
      role_title TEXT,
      employment_type TEXT,
      hire_date TEXT,
      status TEXT DEFAULT 'active',    -- active|onboarding|leave|terminated
      created_at TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS hr_employee_credentials (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      credential_type TEXT,            -- bcba|rbt|lba|cpr|bls|background_check
      credential_number TEXT,
      issued_date TEXT,
      expiration_date TEXT,
      status TEXT DEFAULT 'active',
      document_id INTEGER,
      created_at TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS hr_documents (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER,
      kind TEXT,
      filename TEXT,
      stored_name TEXT,
      mime_type TEXT,
      created_at TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS hr_timecards (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER,
      source TEXT DEFAULT 'manual',    -- homebase|manual|import
      pay_period_start TEXT,
      pay_period_end TEXT,
      raw_json TEXT,
      status TEXT DEFAULT 'imported',  -- imported|flagged|verified|approved
      created_at TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS hr_timecard_flags (
      id SERIAL PRIMARY KEY,
      timecard_id INTEGER NOT NULL,
      flag_type TEXT,                  -- missing_clock_in|missing_clock_out|missing_break|unusual
      detail TEXT,
      status TEXT DEFAULT 'open',      -- open|explained|corrected|approved
      employee_explanation TEXT,
      supervisor TEXT,
      resolved_at TEXT,
      created_at TEXT
    )`);

    // Helpful indexes (idempotent).
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_hr_applicants_stage ON hr_applicants(stage)`);
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_hr_applicants_position ON hr_applicants(position_id)`);
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_hr_applicants_email ON hr_applicants(email)`);
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_hr_applicants_phone ON hr_applicants(phone)`);

    console.log("HR & Recruiting schema ready.");
  }

  // ============================ SEED ============================
  const BCBA_SCREENING_QUESTIONS = [
    { id: "bcba_certified", label: "Are you currently certified as a BCBA?", type: "yesno" },
    { id: "nevada_lba", label: "Do you currently hold a Nevada LBA?", type: "yesno" },
    { id: "willing_lba", label: "If not, are you eligible and willing to obtain a Nevada LBA?", type: "yesno" },
    { id: "settings_comfort", label: "Are you comfortable working across clinic, home and school settings?", type: "yesno" },
    { id: "schedule_type", label: "What type of schedule are you seeking?", type: "text" },
    { id: "earliest_start", label: "What is your earliest available start date?", type: "text" },
    { id: "comp_range", label: "What compensation range are you seeking?", type: "text", sensitive: true },
    { id: "years_experience", label: "How many years of BCBA experience do you have?", type: "text" },
    { id: "supervised_rbts", label: "Have you supervised RBTs?", type: "yesno" },
    { id: "treatment_assessments", label: "Do you have experience writing treatment plans and completing assessments?", type: "yesno" },
  ];

  const RBT_SCREENING_QUESTIONS = [
    { id: "rbt_active", label: "Is your RBT credential currently active?", type: "yesno" },
    { id: "availability", label: "What days and hours are you available?", type: "text" },
    { id: "transportation", label: "Do you have reliable transportation?", type: "yesno" },
    { id: "service_areas", label: "Which areas of the Las Vegas Valley can you serve?", type: "text" },
    { id: "setting_pref", label: "Are you seeking clinic, home or school-based work?", type: "text" },
    { id: "earliest_start", label: "What is your earliest available start date?", type: "text" },
    { id: "comp_range", label: "What compensation range are you seeking?", type: "text", sensitive: true },
  ];

  const BCBA_MIN_QUALS = [
    "Active BCBA certification",
    "Nevada LBA, or eligibility and willingness to obtain Nevada licensure",
  ];
  const BCBA_PREFERRED_QUALS = [
    "Experience supervising RBTs",
    "Experience writing treatment plans",
    "Experience completing assessments",
    "Experience with Medicaid",
    "Experience with insurance-funded ABA",
    "Clinic, in-home, and school-based experience",
    "Willingness to travel between service locations",
  ];
  const RBT_MIN_QUALS = ["Active RBT credential", "Reliable transportation"];
  const RBT_PREFERRED_QUALS = [
    "CPR / BLS certification",
    "Cleared background check",
    "Medicaid enrollment",
    "ABA experience",
    "Experience working with children",
  ];

  async function seed() {
    const now = nowISO();

    await dbRun(
      `INSERT INTO hr_positions
        (slug, title, role_type, employment_types, location_type, locations, description,
         highlights, openings_count, status, priority, comp_unit,
         min_qualifications, preferred_qualifications, screening_questions, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (slug) DO NOTHING`,
      [
        "bcba-hybrid",
        "Board Certified Behavior Analyst — Hybrid",
        "bcba",
        JSON.stringify(["full_time", "part_time", "contract"]),
        "hybrid",
        "Las Vegas & Henderson, NV",
        "Spectrum Squad is hiring a Board Certified Behavior Analyst (BCBA) for a hybrid role supporting clinic, home, and school-based ABA services across the Las Vegas and Henderson area. You'll supervise RBTs, write treatment plans, complete assessments, and help families make meaningful progress.",
        "Flexible hybrid schedule • Supportive clinical team • Competitive compensation • Growing practice",
        1,
        "open",
        "urgent",
        "year",
        JSON.stringify(BCBA_MIN_QUALS),
        JSON.stringify(BCBA_PREFERRED_QUALS),
        JSON.stringify(BCBA_SCREENING_QUESTIONS),
        "system",
        now,
        now,
      ]
    );

    await dbRun(
      `INSERT INTO hr_positions
        (slug, title, role_type, employment_types, location_type, locations, description,
         highlights, openings_count, status, priority, comp_unit,
         min_qualifications, preferred_qualifications, screening_questions, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (slug) DO NOTHING`,
      [
        "rbt",
        "Registered Behavior Technician",
        "rbt",
        JSON.stringify(["full_time", "part_time"]),
        "onsite",
        "Las Vegas Valley, NV",
        "Spectrum Squad is hiring Registered Behavior Technicians (RBTs) to deliver 1:1 ABA therapy in clinic, home, and school settings across the Las Vegas Valley. Make a direct impact on children's lives with the support of an experienced BCBA team.",
        "Paid training support • Flexible hours • Meaningful work • Career growth toward BCBA",
        3,
        "open",
        "high",
        "hour",
        JSON.stringify(RBT_MIN_QUALS),
        JSON.stringify(RBT_PREFERRED_QUALS),
        JSON.stringify(RBT_SCREENING_QUESTIONS),
        "system",
        now,
        now,
      ]
    );

    // Seed a default "website" source link for each position if none exists.
    const positions = await dbAll("SELECT id, slug FROM hr_positions");
    for (const p of positions) {
      const existing = await dbGet(
        "SELECT id FROM hr_position_sources WHERE position_id = ? AND source = ?",
        [p.id, "website"]
      );
      if (!existing) {
        await dbRun(
          `INSERT INTO hr_position_sources (position_id, source, label, token, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [p.id, "website", "Spectrum Squad Website", newToken(), "system", now]
        );
      }
    }

    console.log("HR & Recruiting seed complete (BCBA + RBT).");
  }

  // ============================ HELPERS ============================
  function newToken() {
    return crypto.randomBytes(9).toString("hex");
  }

  function parseJson(str, fallback) {
    if (str == null) return fallback;
    if (typeof str === "object") return str;
    try {
      return JSON.parse(str);
    } catch (e) {
      return fallback;
    }
  }

  function slugify(str) {
    return String(str || "position")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "position";
  }

  async function uniqueSlug(base) {
    let slug = slugify(base);
    let n = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const clash = await dbGet("SELECT id FROM hr_positions WHERE slug = ?", [slug]);
      if (!clash) return slug;
      n += 1;
      slug = `${slugify(base)}-${n}`;
    }
  }

  async function audit(actor, action, entityType, entityId, detail) {
    await dbRun(
      `INSERT INTO hr_audit_log (actor, action, entity_type, entity_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [actor || "system", action, entityType || null, entityId || null, detail || null, nowISO()]
    ).catch((e) => console.error("hr audit failed:", e.message));
  }

  async function notify({ type, applicantId = null, positionId = null, title, body, severity = "info", targetRole = "owner" }) {
    await dbRun(
      `INSERT INTO hr_notifications (type, applicant_id, position_id, title, body, severity, target_role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [type, applicantId, positionId, title, body, severity, targetRole, nowISO()]
    ).catch((e) => console.error("hr notify failed:", e.message));
  }

  async function ownerEmail() {
    const row = await dbGet("SELECT email FROM users WHERE role = 'owner' ORDER BY id LIMIT 1");
    if (row && row.email) return row.email;
    const admin = await dbGet("SELECT email FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
    return (admin && admin.email) || process.env.AUTH_ALERT_ADMIN_EMAIL || process.env.EMAIL_FROM || null;
  }

  // ---- rules-based match evaluation (works with no AI key) ----
  // AI screening later ENRICHES this; the deterministic rules guarantee the
  // "Priority Review + owner alert" requirement is functional immediately.
  function truthy(v) {
    if (v == null) return false;
    const s = String(v).trim().toLowerCase();
    return ["yes", "y", "true", "1", "active"].includes(s);
  }

  function evaluateMatch(position, applicant) {
    const answers = parseJson(applicant.screening_answers, {}) || {};
    const creds = parseJson(applicant.credentials, {}) || {};
    const roleType = position ? position.role_type : "other";

    if (roleType === "bcba") {
      const certified = truthy(answers.bcba_certified) || truthy(creds.bcba_certified);
      const lbaOk = truthy(answers.nevada_lba) || truthy(answers.willing_lba) || truthy(creds.nevada_lba);
      if (!certified) {
        // No certification stated -> can't confirm the stated minimum.
        return { match_category: hasEnoughInfo(answers) ? "does_not_meet" : "insufficient_information", priority_flag: false };
      }
      if (certified && lbaOk) {
        return { match_category: "priority_review", priority_flag: true };
      }
      // Certified but LBA status unknown -> still strong, human review.
      return { match_category: "qualified", priority_flag: false };
    }

    if (roleType === "rbt") {
      const rbtActive = truthy(answers.rbt_active) || truthy(creds.rbt_active);
      const transport = truthy(answers.transportation);
      if (rbtActive && transport) return { match_category: "qualified", priority_flag: false };
      if (rbtActive) return { match_category: "possibly_qualified", priority_flag: false };
      return { match_category: hasEnoughInfo(answers) ? "does_not_meet" : "insufficient_information", priority_flag: false };
    }

    return { match_category: "insufficient_information", priority_flag: false };
  }

  function hasEnoughInfo(answers) {
    return Object.values(answers || {}).filter((v) => String(v || "").trim()).length >= 3;
  }

  // ---- shaping for the API (strip sensitive fields when not permitted) ----
  function shapePosition(p, canSensitive) {
    const out = {
      id: p.id,
      slug: p.slug,
      title: p.title,
      role_type: p.role_type,
      employment_types: parseJson(p.employment_types, []),
      location_type: p.location_type,
      locations: p.locations,
      description: p.description,
      highlights: p.highlights,
      openings_count: p.openings_count,
      status: p.status,
      priority: p.priority,
      comp_unit: p.comp_unit,
      min_qualifications: parseJson(p.min_qualifications, []),
      preferred_qualifications: parseJson(p.preferred_qualifications, []),
      screening_questions: parseJson(p.screening_questions, []),
      hiring_managers: parseJson(p.hiring_managers, []),
      created_at: p.created_at,
      updated_at: p.updated_at,
    };
    if (canSensitive) {
      out.comp_min = p.comp_min;
      out.comp_max = p.comp_max;
      out.comp_notes = p.comp_notes;
    }
    return out;
  }

  function shapeApplicantListItem(a, canSensitive) {
    const out = {
      id: a.id,
      position_id: a.position_id,
      position_title: a.position_title || null,
      full_name: a.full_name,
      email: a.email,
      phone: a.phone,
      city: a.city,
      state: a.state,
      source: a.source,
      applied_at: a.applied_at,
      stage: a.stage,
      match_category: a.match_category,
      priority_flag: a.priority_flag,
      assigned_manager: a.assigned_manager,
      last_contacted_at: a.last_contacted_at,
      next_followup_at: a.next_followup_at,
      interview_at: a.interview_at,
      do_not_contact: a.do_not_contact,
      automation_paused: a.automation_paused,
      created_at: a.created_at,
    };
    if (canSensitive) out.comp_expectation = a.comp_expectation;
    return out;
  }

  // ============================ INTAKE ============================
  // Creates an applicant with dedup detection. Shared by manual entry, the
  // careers page, referrals, CSV import and (later) inbound email.
  async function createApplicant(input, actor) {
    const now = nowISO();
    const email = (input.email || "").trim().toLowerCase() || null;
    const phone = (input.phone || "").replace(/[^0-9]/g, "") || null;

    // Duplicate detection by email or phone.
    let duplicateOf = null;
    if (email || phone) {
      const dup = await dbGet(
        `SELECT id, full_name FROM hr_applicants
         WHERE (email IS NOT NULL AND email = ?) OR (phone IS NOT NULL AND phone = ?)
         ORDER BY id LIMIT 1`,
        [email, phone]
      );
      if (dup) duplicateOf = dup;
    }

    let position = null;
    if (input.position_id) {
      position = await dbGet("SELECT * FROM hr_positions WHERE id = ?", [input.position_id]);
    }

    const applicantForMatch = {
      screening_answers: JSON.stringify(input.screening_answers || {}),
      credentials: JSON.stringify(input.credentials || {}),
    };
    const match = evaluateMatch(position, applicantForMatch);

    const row = await dbRun(
      `INSERT INTO hr_applicants
        (position_id, full_name, email, phone, city, state, source, source_id, applied_at,
         stage, match_category, priority_flag, cover_letter, screening_answers, credentials,
         availability, preferred_schedule, comp_expectation, earliest_start, work_setting,
         consent_email, consent_sms, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
      [
        input.position_id || null,
        (input.full_name || "").trim() || "Unknown Applicant",
        email,
        phone,
        input.city || null,
        input.state || null,
        SOURCE_KEYS.includes(input.source) ? input.source : "other",
        input.source_id || null,
        now,
        "new_applicant",
        match.match_category,
        match.priority_flag,
        input.cover_letter || null,
        JSON.stringify(input.screening_answers || {}),
        JSON.stringify(input.credentials || {}),
        JSON.stringify(input.availability || {}),
        input.preferred_schedule || null,
        input.comp_expectation || null,
        input.earliest_start || null,
        input.work_setting || null,
        input.consent_email === true || input.consent_email === "true",
        input.consent_sms === true || input.consent_sms === "true",
        now,
        now,
      ]
    );
    const applicantId = row.rows && row.rows[0] ? row.rows[0].id : null;

    await dbRun(
      `INSERT INTO hr_applicant_stage_history (applicant_id, from_stage, to_stage, changed_by, note, changed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [applicantId, null, "new_applicant", actor || "applicant", "Application received", now]
    );

    if (input.source_id) {
      await dbRun("UPDATE hr_position_sources SET applications = applications + 1 WHERE id = ?", [input.source_id]);
    }

    await audit(actor || "applicant", "applicant_created", "applicant", applicantId,
      `name=${input.full_name || ""} source=${input.source || "other"} match=${match.match_category}${duplicateOf ? ` possible_dup_of=${duplicateOf.id}` : ""}`);

    // Priority BCBA -> immediate owner alert (in-app + email).
    if (match.priority_flag && position && position.role_type === "bcba") {
      await notify({
        type: "priority_bcba",
        applicantId,
        positionId: position.id,
        title: "Priority BCBA candidate",
        body: `${input.full_name || "A candidate"} appears to meet the minimum BCBA requirements. Review and respond quickly.`,
        severity: "urgent",
      });
      const to = await ownerEmail();
      if (to) {
        sendEmail({
          to,
          subject: `⭐ Priority BCBA applicant: ${input.full_name || "New candidate"}`,
          html: `<p>A new BCBA applicant appears to meet the minimum requirements and has been marked <strong>Priority Review</strong>.</p>
                 <ul>
                   <li><strong>Name:</strong> ${escapeHtml(input.full_name || "")}</li>
                   <li><strong>Email:</strong> ${escapeHtml(email || "")}</li>
                   <li><strong>Phone:</strong> ${escapeHtml(input.phone || "")}</li>
                   <li><strong>Source:</strong> ${escapeHtml(input.source || "other")}</li>
                 </ul>
                 <p><a href="${APP_BASE_URL}/#/hr/candidate/${applicantId}">Open candidate in the CRM</a></p>`,
          type: "hr_priority_bcba",
        }).catch((e) => console.error("priority BCBA email failed:", e.message));
      }
    } else if (position && position.role_type === "bcba") {
      await notify({
        type: "new_bcba",
        applicantId,
        positionId: position.id,
        title: "New BCBA applicant",
        body: `${input.full_name || "A candidate"} applied for the BCBA position.`,
        severity: "info",
      });
    }

    // Kick off the warm, automated follow-up sequence (consent-gated, and only
    // when the module's follow-up helpers are present — always, here).
    await enrollFollowupSequence(
      {
        id: applicantId,
        email,
        full_name: input.full_name,
        do_not_contact: false,
        consent_email: input.consent_email === true || input.consent_email === "true",
        priority_flag: match.priority_flag,
        position_id: input.position_id || null,
        screening_answers: JSON.stringify(input.screening_answers || {}),
      },
      position
    ).catch((e) => console.error("enrollFollowupSequence failed:", e.message));

    return { id: applicantId, match, duplicateOf };
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ============================ API ROUTER ============================
  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/hr/")) return false;

    try {
      // -------- PUBLIC ROUTES (no auth) --------
      if (pathname === "/api/hr/public/positions" && method === "GET") {
        const rows = await dbAll(
          "SELECT * FROM hr_positions WHERE status = 'open' ORDER BY priority = 'urgent' DESC, created_at DESC"
        );
        return json(res, 200, rows.map((p) => shapePosition(p, false)));
      }

      const pubPosMatch = pathname.match(/^\/api\/hr\/public\/positions\/([a-z0-9-]+)$/);
      if (pubPosMatch && method === "GET") {
        const p = await dbGet("SELECT * FROM hr_positions WHERE slug = ? AND status = 'open'", [pubPosMatch[1]]);
        if (!p) return json(res, 404, { error: "Position not found" });
        return json(res, 200, shapePosition(p, false));
      }

      const linkMatch = pathname.match(/^\/api\/hr\/apply-link\/([a-zA-Z0-9]+)$/);
      if (linkMatch && method === "GET") {
        const src = await dbGet("SELECT * FROM hr_position_sources WHERE token = ?", [linkMatch[1]]);
        if (!src) return json(res, 404, { error: "Link not found" });
        await dbRun("UPDATE hr_position_sources SET clicks = clicks + 1 WHERE id = ?", [src.id]);
        const p = await dbGet("SELECT * FROM hr_positions WHERE id = ?", [src.position_id]);
        if (!p || p.status !== "open") return json(res, 404, { error: "This position is no longer open" });
        return json(res, 200, { position: shapePosition(p, false), source: src.source, source_id: src.id });
      }

      if (pathname === "/api/hr/apply" && method === "POST") {
        const body = await readBody(req);
        if (!body.full_name || !(body.email || body.phone)) {
          return json(res, 400, { error: "Name and an email or phone number are required." });
        }
        // Resolve position via slug or source token.
        if (!body.position_id && body.slug) {
          const p = await dbGet("SELECT id FROM hr_positions WHERE slug = ?", [body.slug]);
          if (p) body.position_id = p.id;
        }
        if (body.source_token) {
          const src = await dbGet("SELECT * FROM hr_position_sources WHERE token = ?", [body.source_token]);
          if (src) {
            body.source = src.source;
            body.source_id = src.id;
            if (!body.position_id) body.position_id = src.position_id;
          }
        }
        const result = await createApplicant(body, "applicant");

        // Optional resume (base64) submitted with the application.
        if (body.resume && body.resume.content_base64) {
          await saveApplicantDocument(result.id, "resume", body.resume, "applicant").catch((e) =>
            console.error("resume save failed:", e.message)
          );
        }
        return json(res, 201, { ok: true, id: result.id, match: result.match });
      }

      // -------- AUTHENTICATED ROUTES --------
      if (!hrCanAccess(user)) {
        return json(res, user ? 403 : 401, { error: user ? "Not permitted" : "Not authenticated" });
      }
      const canSensitive = hrCanSeeSensitive(user);
      const canManage = hrCanManage(user);
      const actor = user.email || user.name || "user";

      // meta: config + current-user capabilities
      if (pathname === "/api/hr/meta" && method === "GET") {
        return json(res, 200, {
          stages: PIPELINE_STAGES,
          sources: APPLICATION_SOURCES,
          match_categories: MATCH_CATEGORIES,
          caps: { canManage, canSensitive },
          role: user.role,
        });
      }

      // ---- positions ----
      if (pathname === "/api/hr/positions" && method === "GET") {
        const rows = await dbAll("SELECT * FROM hr_positions ORDER BY priority = 'urgent' DESC, status, created_at DESC");
        const withCounts = [];
        for (const p of rows) {
          const shaped = shapePosition(p, canSensitive);
          const c = await dbGet(
            "SELECT COUNT(*) AS n FROM hr_applicants WHERE position_id = ? AND stage NOT IN ('not_selected','withdrawn')",
            [p.id]
          );
          shaped.active_applicants = Number(c.n);
          const sources = await dbAll("SELECT * FROM hr_position_sources WHERE position_id = ? ORDER BY id", [p.id]);
          shaped.sources = sources.map((s) => ({ ...s, url: `${APP_BASE_URL}/apply/${s.token}` }));
          withCounts.push(shaped);
        }
        return json(res, 200, withCounts);
      }

      if (pathname === "/api/hr/positions" && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        if (!b.title) return json(res, 400, { error: "Title is required" });
        const slug = await uniqueSlug(b.slug || b.title);
        const now = nowISO();
        const row = await dbRun(
          `INSERT INTO hr_positions
            (slug, title, role_type, employment_types, location_type, locations, description, highlights,
             openings_count, status, priority, comp_min, comp_max, comp_unit, comp_notes,
             min_qualifications, preferred_qualifications, screening_questions, hiring_managers,
             created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING id`,
          [
            slug, b.title, b.role_type || "other", JSON.stringify(b.employment_types || []),
            b.location_type || "onsite", b.locations || null, b.description || null, b.highlights || null,
            Number(b.openings_count) || 1, "open", b.priority || "normal",
            numOrNull(b.comp_min), numOrNull(b.comp_max), b.comp_unit || "year", b.comp_notes || null,
            JSON.stringify(b.min_qualifications || []), JSON.stringify(b.preferred_qualifications || []),
            JSON.stringify(b.screening_questions || []), JSON.stringify(b.hiring_managers || []),
            actor, now, now,
          ]
        );
        const id = row.rows[0].id;
        await audit(actor, "position_created", "position", id, `title=${b.title}`);
        return json(res, 201, { ok: true, id, slug });
      }

      const posIdMatch = pathname.match(/^\/api\/hr\/positions\/(\d+)$/);
      if (posIdMatch && method === "GET") {
        const p = await dbGet("SELECT * FROM hr_positions WHERE id = ?", [posIdMatch[1]]);
        if (!p) return json(res, 404, { error: "Position not found" });
        const shaped = shapePosition(p, canSensitive);
        const sources = await dbAll("SELECT * FROM hr_position_sources WHERE position_id = ? ORDER BY id", [p.id]);
        shaped.sources = sources.map((s) => ({ ...s, url: `${APP_BASE_URL}/apply/${s.token}` }));
        return json(res, 200, shaped);
      }

      if (posIdMatch && method === "PUT") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const p = await dbGet("SELECT * FROM hr_positions WHERE id = ?", [posIdMatch[1]]);
        if (!p) return json(res, 404, { error: "Position not found" });
        const b = await readBody(req);
        await dbRun(
          `UPDATE hr_positions SET
             title = ?, role_type = ?, employment_types = ?, location_type = ?, locations = ?,
             description = ?, highlights = ?, openings_count = ?, priority = ?,
             comp_min = ?, comp_max = ?, comp_unit = ?, comp_notes = ?,
             min_qualifications = ?, preferred_qualifications = ?, screening_questions = ?, hiring_managers = ?,
             updated_at = ?
           WHERE id = ?`,
          [
            b.title != null ? b.title : p.title,
            b.role_type != null ? b.role_type : p.role_type,
            JSON.stringify(b.employment_types != null ? b.employment_types : parseJson(p.employment_types, [])),
            b.location_type != null ? b.location_type : p.location_type,
            b.locations != null ? b.locations : p.locations,
            b.description != null ? b.description : p.description,
            b.highlights != null ? b.highlights : p.highlights,
            b.openings_count != null ? Number(b.openings_count) : p.openings_count,
            b.priority != null ? b.priority : p.priority,
            b.comp_min !== undefined ? numOrNull(b.comp_min) : p.comp_min,
            b.comp_max !== undefined ? numOrNull(b.comp_max) : p.comp_max,
            b.comp_unit != null ? b.comp_unit : p.comp_unit,
            b.comp_notes !== undefined ? b.comp_notes : p.comp_notes,
            JSON.stringify(b.min_qualifications != null ? b.min_qualifications : parseJson(p.min_qualifications, [])),
            JSON.stringify(b.preferred_qualifications != null ? b.preferred_qualifications : parseJson(p.preferred_qualifications, [])),
            JSON.stringify(b.screening_questions != null ? b.screening_questions : parseJson(p.screening_questions, [])),
            JSON.stringify(b.hiring_managers != null ? b.hiring_managers : parseJson(p.hiring_managers, [])),
            nowISO(),
            p.id,
          ]
        );
        await audit(actor, "position_updated", "position", p.id, `title=${b.title || p.title}`);
        return json(res, 200, { ok: true });
      }

      const posDupMatch = pathname.match(/^\/api\/hr\/positions\/(\d+)\/duplicate$/);
      if (posDupMatch && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const p = await dbGet("SELECT * FROM hr_positions WHERE id = ?", [posDupMatch[1]]);
        if (!p) return json(res, 404, { error: "Position not found" });
        const slug = await uniqueSlug(p.slug + "-copy");
        const now = nowISO();
        const row = await dbRun(
          `INSERT INTO hr_positions
            (slug, title, role_type, employment_types, location_type, locations, description, highlights,
             openings_count, status, priority, comp_min, comp_max, comp_unit, comp_notes,
             min_qualifications, preferred_qualifications, screening_questions, hiring_managers,
             created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING id`,
          [
            slug, p.title + " (Copy)", p.role_type, p.employment_types, p.location_type, p.locations,
            p.description, p.highlights, p.openings_count, p.priority, p.comp_min, p.comp_max, p.comp_unit,
            p.comp_notes, p.min_qualifications, p.preferred_qualifications, p.screening_questions,
            p.hiring_managers, actor, now, now,
          ]
        );
        const id = row.rows[0].id;
        await audit(actor, "position_duplicated", "position", id, `from=${p.id}`);
        return json(res, 201, { ok: true, id, slug });
      }

      const posStatusMatch = pathname.match(/^\/api\/hr\/positions\/(\d+)\/status$/);
      if (posStatusMatch && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        if (!["open", "paused", "closed"].includes(b.status)) {
          return json(res, 400, { error: "status must be open, paused, or closed" });
        }
        await dbRun("UPDATE hr_positions SET status = ?, updated_at = ? WHERE id = ?", [b.status, nowISO(), posStatusMatch[1]]);
        await audit(actor, "position_status_changed", "position", Number(posStatusMatch[1]), `status=${b.status}`);
        return json(res, 200, { ok: true });
      }

      const posSourceMatch = pathname.match(/^\/api\/hr\/positions\/(\d+)\/sources$/);
      if (posSourceMatch && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        if (!SOURCE_KEYS.includes(b.source)) return json(res, 400, { error: "Unknown source" });
        const token = newToken();
        const row = await dbRun(
          `INSERT INTO hr_position_sources (position_id, source, label, token, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
          [posSourceMatch[1], b.source, b.label || null, token, actor, nowISO()]
        );
        await audit(actor, "source_link_created", "position", Number(posSourceMatch[1]), `source=${b.source}`);
        return json(res, 201, { ok: true, id: row.rows[0].id, token, url: `${APP_BASE_URL}/apply/${token}` });
      }

      // ---- applicants ----
      if (pathname === "/api/hr/applicants" && method === "GET") {
        const filters = [];
        const params = [];
        if (query.position_id) { filters.push("a.position_id = ?"); params.push(query.position_id); }
        if (query.stage && STAGE_KEYS.includes(query.stage)) { filters.push("a.stage = ?"); params.push(query.stage); }
        if (query.source && SOURCE_KEYS.includes(query.source)) { filters.push("a.source = ?"); params.push(query.source); }
        if (query.match) { filters.push("a.match_category = ?"); params.push(query.match); }
        if (query.q) {
          filters.push("(LOWER(a.full_name) LIKE ? OR LOWER(a.email) LIKE ?)");
          const like = "%" + String(query.q).toLowerCase() + "%";
          params.push(like, like);
        }
        const where = filters.length ? "WHERE " + filters.join(" AND ") : "";
        const rows = await dbAll(
          `SELECT a.*, p.title AS position_title
             FROM hr_applicants a LEFT JOIN hr_positions p ON p.id = a.position_id
             ${where}
             ORDER BY a.priority_flag DESC, a.applied_at DESC`,
          params
        );
        return json(res, 200, rows.map((a) => shapeApplicantListItem(a, canSensitive)));
      }

      if (pathname === "/api/hr/applicants" && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        if (!b.full_name) return json(res, 400, { error: "Name is required" });
        b.source = b.source || "other";
        const result = await createApplicant(b, actor);
        return json(res, 201, { ok: true, id: result.id, match: result.match, duplicateOf: result.duplicateOf || null });
      }

      const appIdMatch = pathname.match(/^\/api\/hr\/applicants\/(\d+)$/);
      if (appIdMatch && method === "GET") {
        const a = await dbGet(
          `SELECT a.*, p.title AS position_title, p.role_type AS position_role_type
             FROM hr_applicants a LEFT JOIN hr_positions p ON p.id = a.position_id WHERE a.id = ?`,
          [appIdMatch[1]]
        );
        if (!a) return json(res, 404, { error: "Applicant not found" });

        const profile = {
          id: a.id,
          position_id: a.position_id,
          position_title: a.position_title,
          position_role_type: a.position_role_type,
          full_name: a.full_name,
          email: a.email,
          phone: a.phone,
          city: a.city,
          state: a.state,
          source: a.source,
          applied_at: a.applied_at,
          stage: a.stage,
          match_category: a.match_category,
          priority_flag: a.priority_flag,
          cover_letter: a.cover_letter,
          screening_answers: parseJson(a.screening_answers, {}),
          credentials: parseJson(a.credentials, {}),
          availability: parseJson(a.availability, {}),
          preferred_schedule: a.preferred_schedule,
          earliest_start: a.earliest_start,
          work_setting: a.work_setting,
          assigned_manager: a.assigned_manager,
          last_contacted_at: a.last_contacted_at,
          last_response_at: a.last_response_at,
          next_followup_at: a.next_followup_at,
          interview_at: a.interview_at,
          final_decision: a.final_decision,
          disposition_reason: a.disposition_reason,
          consent_email: a.consent_email,
          consent_sms: a.consent_sms,
          do_not_contact: a.do_not_contact,
          automation_paused: a.automation_paused,
          ai_summary: a.ai_summary,
          confirmed_quals: parseJson(a.confirmed_quals, []),
          missing_quals: parseJson(a.missing_quals, []),
        };

        profile.documents = await dbAll(
          "SELECT id, kind, filename, mime_type, size, uploaded_at FROM hr_applicant_documents WHERE applicant_id = ? ORDER BY id DESC",
          [a.id]
        );
        profile.stage_history = await dbAll(
          "SELECT from_stage, to_stage, changed_by, note, changed_at FROM hr_applicant_stage_history WHERE applicant_id = ? ORDER BY id",
          [a.id]
        );
        profile.messages = await dbAll(
          "SELECT id, direction, channel, subject, body, status, ai_generated, created_at FROM hr_applicant_messages WHERE applicant_id = ? ORDER BY id",
          [a.id]
        );
        profile.screenings = await dbAll(
          "SELECT * FROM hr_screenings WHERE applicant_id = ? ORDER BY id DESC",
          [a.id]
        );
        profile.followups = await dbAll(
          "SELECT id, sequence, step, scheduled_at, sent_at, status FROM hr_followups WHERE applicant_id = ? ORDER BY id",
          [a.id]
        );

        // Sensitive fields: comp expectation, private notes, ratings, offers.
        if (canSensitive) {
          profile.comp_expectation = a.comp_expectation;
          profile.offer_status = a.offer_status;
          profile.notes = await dbAll(
            "SELECT id, author, note_type, body, rating, is_private, created_at FROM hr_applicant_notes WHERE applicant_id = ? ORDER BY id DESC",
            [a.id]
          );
        } else {
          // Non-sensitive roles see only non-private, non-rating notes.
          profile.notes = await dbAll(
            "SELECT id, author, note_type, body, created_at FROM hr_applicant_notes WHERE applicant_id = ? AND is_private = FALSE AND note_type <> 'rating' ORDER BY id DESC",
            [a.id]
          );
          profile.sensitive_hidden = true;
        }

        return json(res, 200, profile);
      }

      if (appIdMatch && method === "PUT") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const a = await dbGet("SELECT * FROM hr_applicants WHERE id = ?", [appIdMatch[1]]);
        if (!a) return json(res, 404, { error: "Applicant not found" });
        const b = await readBody(req);
        const editable = {
          full_name: b.full_name, email: b.email, phone: b.phone, city: b.city, state: b.state,
          assigned_manager: b.assigned_manager, preferred_schedule: b.preferred_schedule,
          earliest_start: b.earliest_start, work_setting: b.work_setting,
          next_followup_at: b.next_followup_at, do_not_contact: b.do_not_contact,
          automation_paused: b.automation_paused,
        };
        if (canSensitive && b.comp_expectation !== undefined) editable.comp_expectation = b.comp_expectation;
        const sets = [];
        const params = [];
        for (const [k, v] of Object.entries(editable)) {
          if (v !== undefined) { sets.push(`${k} = ?`); params.push(v); }
        }
        if (sets.length) {
          sets.push("updated_at = ?"); params.push(nowISO());
          params.push(a.id);
          await dbRun(`UPDATE hr_applicants SET ${sets.join(", ")} WHERE id = ?`, params);
          await audit(actor, "applicant_updated", "applicant", a.id, Object.keys(editable).filter((k) => editable[k] !== undefined).join(","));
        }
        return json(res, 200, { ok: true });
      }

      const appStageMatch = pathname.match(/^\/api\/hr\/applicants\/(\d+)\/stage$/);
      if (appStageMatch && method === "POST") {
        const a = await dbGet("SELECT * FROM hr_applicants WHERE id = ?", [appStageMatch[1]]);
        if (!a) return json(res, 404, { error: "Applicant not found" });
        const b = await readBody(req);
        if (!STAGE_KEYS.includes(b.stage)) return json(res, 400, { error: "Unknown stage" });
        const now = nowISO();
        await dbRun("UPDATE hr_applicants SET stage = ?, updated_at = ? WHERE id = ?", [b.stage, now, a.id]);
        await dbRun(
          `INSERT INTO hr_applicant_stage_history (applicant_id, from_stage, to_stage, changed_by, note, changed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [a.id, a.stage, b.stage, actor, b.note || null, now]
        );
        await audit(actor, "stage_changed", "applicant", a.id, `${a.stage} -> ${b.stage}`);
        return json(res, 200, { ok: true });
      }

      const appNoteMatch = pathname.match(/^\/api\/hr\/applicants\/(\d+)\/notes$/);
      if (appNoteMatch && method === "POST") {
        const a = await dbGet("SELECT id FROM hr_applicants WHERE id = ?", [appNoteMatch[1]]);
        if (!a) return json(res, 404, { error: "Applicant not found" });
        const b = await readBody(req);
        if (!b.body && b.rating == null) return json(res, 400, { error: "Note body or rating required" });
        // Ratings and private notes require sensitive access.
        const noteType = b.note_type === "interview" || b.note_type === "rating" ? b.note_type : "note";
        const isPrivate = b.is_private !== false;
        if ((noteType === "rating" || isPrivate) && !canSensitive) {
          return json(res, 403, { error: "Only the owner can add private notes or ratings right now." });
        }
        await dbRun(
          `INSERT INTO hr_applicant_notes (applicant_id, author, note_type, body, rating, is_private, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [a.id, actor, noteType, b.body || null, b.rating != null ? Number(b.rating) : null, isPrivate, nowISO()]
        );
        await audit(actor, "note_added", "applicant", Number(appNoteMatch[1]), `type=${noteType}`);
        return json(res, 201, { ok: true });
      }

      const appDispMatch = pathname.match(/^\/api\/hr\/applicants\/(\d+)\/disposition$/);
      if (appDispMatch && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const a = await dbGet("SELECT * FROM hr_applicants WHERE id = ?", [appDispMatch[1]]);
        if (!a) return json(res, 404, { error: "Applicant not found" });
        const b = await readBody(req);
        const stage = ["not_selected", "withdrawn", "talent_pool"].includes(b.stage) ? b.stage : "not_selected";
        const now = nowISO();
        await dbRun(
          "UPDATE hr_applicants SET stage = ?, disposition_reason = ?, final_decision = ?, updated_at = ? WHERE id = ?",
          [stage, b.reason || null, stage, now, a.id]
        );
        await dbRun(
          `INSERT INTO hr_applicant_stage_history (applicant_id, from_stage, to_stage, changed_by, note, changed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [a.id, a.stage, stage, actor, b.reason || null, now]
        );
        await cancelPendingFollowups(a.id);
        await audit(actor, "applicant_dispositioned", "applicant", a.id, `${stage}: ${b.reason || ""}`);
        return json(res, 200, { ok: true });
      }

      // ---- follow-up automation controls ----
      const appPauseMatch = pathname.match(/^\/api\/hr\/applicants\/(\d+)\/pause-automation$/);
      if (appPauseMatch && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        const paused = b.paused !== false;
        await dbRun("UPDATE hr_applicants SET automation_paused = ?, updated_at = ? WHERE id = ?", [paused, nowISO(), appPauseMatch[1]]);
        if (paused) await cancelPendingFollowups(Number(appPauseMatch[1]));
        await audit(actor, paused ? "automation_paused" : "automation_resumed", "applicant", Number(appPauseMatch[1]), "");
        return json(res, 200, { ok: true, paused });
      }

      const appRespMatch = pathname.match(/^\/api\/hr\/applicants\/(\d+)\/log-response$/);
      if (appRespMatch && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const a = await dbGet("SELECT * FROM hr_applicants WHERE id = ?", [appRespMatch[1]]);
        if (!a) return json(res, 404, { error: "Applicant not found" });
        const b = await readBody(req);
        const now = nowISO();
        await dbRun("UPDATE hr_applicants SET last_response_at = ?, automation_paused = TRUE, updated_at = ? WHERE id = ?", [now, now, a.id]);
        await cancelPendingFollowups(a.id);
        await dbRun(
          `INSERT INTO hr_applicant_messages (applicant_id, direction, channel, from_addr, subject, body, status, sent_by, created_at)
           VALUES (?, 'inbound', 'email', ?, ?, ?, 'received', ?, ?)`,
          [a.id, a.email, "Candidate response", b.body || `(response logged by ${actor})`, actor, now]
        );
        if (["new_applicant", "ai_screening", "needs_human_review", "contacted"].includes(a.stage)) {
          await moveStageInternal(a, "responded", actor, "Candidate responded");
        }
        await audit(actor, "response_logged", "applicant", a.id, "");
        return json(res, 200, { ok: true });
      }

      const appSendMatch = pathname.match(/^\/api\/hr\/applicants\/(\d+)\/send-message$/);
      if (appSendMatch && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const a = await dbGet("SELECT * FROM hr_applicants WHERE id = ?", [appSendMatch[1]]);
        if (!a) return json(res, 404, { error: "Applicant not found" });
        if (!a.email) return json(res, 400, { error: "Applicant has no email address" });
        const b = await readBody(req);
        if (!b.subject || !b.body) return json(res, 400, { error: "Subject and body are required" });
        // A human taking over pauses automation so sequences don't collide.
        await dbRun("UPDATE hr_applicants SET automation_paused = TRUE, updated_at = ? WHERE id = ?", [nowISO(), a.id]);
        await cancelPendingFollowups(a.id);
        const html = /<[a-z][\s\S]*>/i.test(b.body)
          ? b.body
          : b.body.split("\n").map((l) => `<p>${escapeHtml(l)}</p>`).join("");
        const result = await sendApplicantEmail(a, b.subject, html, { sentBy: actor });
        await audit(actor, "manual_message_sent", "applicant", a.id, `delivered=${result.delivered || result.skipped}`);
        return json(res, result.delivered === "failed" ? 502 : 200, {
          ok: result.delivered !== "failed" && !result.skipped,
          delivered: result.delivered,
          skipped: result.skipped,
        });
      }

      // ---- resume upload / download ----
      const appResumeUpMatch = pathname.match(/^\/api\/hr\/applicants\/(\d+)\/resume$/);
      if (appResumeUpMatch && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const a = await dbGet("SELECT id FROM hr_applicants WHERE id = ?", [appResumeUpMatch[1]]);
        if (!a) return json(res, 404, { error: "Applicant not found" });
        const b = await readBody(req);
        if (!b.content_base64) return json(res, 400, { error: "content_base64 is required" });
        try {
          const doc = await saveApplicantDocument(a.id, b.kind || "resume", b, actor);
          await audit(actor, "resume_uploaded", "applicant", a.id, `file=${b.filename || ""}`);
          return json(res, 201, { ok: true, document: doc });
        } catch (e) {
          return json(res, 400, { error: "Invalid file: " + e.message });
        }
      }

      const docDownMatch = pathname.match(/^\/api\/hr\/documents\/(\d+)$/);
      if (docDownMatch && method === "GET") {
        const doc = await dbGet("SELECT * FROM hr_applicant_documents WHERE id = ?", [docDownMatch[1]]);
        if (!doc) return json(res, 404, { error: "Not found" });
        const full = path.join(RESUME_DIR, doc.stored_name);
        if (!fs.existsSync(full)) return json(res, 404, { error: "File missing" });
        const buffer = fs.readFileSync(full);
        return sendFile(res, 200, buffer, doc.mime_type, doc.filename);
      }

      // ---- AI screening (scaffold; enriched in a later phase) ----
      const appScreenMatch = pathname.match(/^\/api\/hr\/applicants\/(\d+)\/screen$/);
      if (appScreenMatch && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const a = await dbGet(
          `SELECT a.*, p.role_type AS position_role_type FROM hr_applicants a
             LEFT JOIN hr_positions p ON p.id = a.position_id WHERE a.id = ?`,
          [appScreenMatch[1]]
        );
        if (!a) return json(res, 404, { error: "Applicant not found" });
        const result = await runScreening(a, actor);
        return json(res, result.ok ? 200 : 202, result);
      }

      // ---- dashboards ----
      if (pathname === "/api/hr/dashboard" && method === "GET") {
        return json(res, 200, await recruitingDashboard());
      }
      if (pathname === "/api/hr/command-center" && method === "GET") {
        return json(res, 200, await bcbaCommandCenter());
      }

      // ---- notifications ----
      if (pathname === "/api/hr/notifications" && method === "GET") {
        const rows = await dbAll("SELECT * FROM hr_notifications ORDER BY id DESC LIMIT 100");
        return json(res, 200, rows);
      }
      const notifReadMatch = pathname.match(/^\/api\/hr\/notifications\/(\d+)\/read$/);
      if (notifReadMatch && method === "POST") {
        await dbRun("UPDATE hr_notifications SET read = TRUE WHERE id = ?", [notifReadMatch[1]]);
        return json(res, 200, { ok: true });
      }

      // ---- run the follow-up processor on demand (also runs on an interval) ----
      if (pathname === "/api/hr/admin/run-followups" && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const r = await processFollowups();
        await audit(actor, "followups_run", null, null, `due=${r.due} sent=${r.sent} canceled=${r.canceled}`);
        return json(res, 200, r);
      }

      // ---- audit log ----
      if (pathname === "/api/hr/audit" && method === "GET") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const rows = await dbAll("SELECT * FROM hr_audit_log ORDER BY id DESC LIMIT 200");
        return json(res, 200, rows);
      }

      return json(res, 404, { error: "Unknown HR endpoint" });
    } catch (err) {
      console.error("HR module error:", err);
      return json(res, 500, { error: "HR server error", detail: err.message });
    }
  }

  function numOrNull(v) {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  }

  // ---- document persistence ----
  async function saveApplicantDocument(applicantId, kind, file, actor) {
    const rawExt = path.extname(file.filename || "").toLowerCase();
    const ext = /^\.(pdf|docx|doc)$/.test(rawExt) ? rawExt : guessExt(file.mime_type);
    const storedName = `${crypto.randomBytes(10).toString("hex")}${ext}`;
    const buffer = Buffer.from(file.content_base64, "base64");
    fs.writeFileSync(path.join(RESUME_DIR, storedName), buffer);
    const row = await dbRun(
      `INSERT INTO hr_applicant_documents (applicant_id, kind, filename, mime_type, stored_name, size, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [applicantId, kind || "resume", file.filename || "resume" + ext, file.mime_type || "application/octet-stream", storedName, buffer.length, actor || "system", nowISO()]
    );
    return { id: row.rows[0].id, filename: file.filename, kind: kind || "resume" };
  }

  function guessExt(mime) {
    const map = {
      "application/pdf": ".pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
      "application/msword": ".doc",
    };
    return map[mime] || ".pdf";
  }

  // ---- AI screening --------------------------------------------------
  // Uses the Anthropic Messages API (raw HTTPS via built-in fetch, matching
  // this app's zero-dependency style) as the reasoning layer. Claude produces
  // a STRUCTURED assessment to organize and prioritize candidates -- it never
  // makes the final hiring decision. The key lives server-side only.
  //
  // Fairness is enforced two ways: (1) protected characteristics and
  // name/address/graduation-year are stripped from the payload before it is
  // ever sent, and (2) the system prompt forbids using or inferring them.
  const HR_AI_MODEL = process.env.HR_AI_MODEL || "claude-opus-5";

  const ASSESSMENT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string", description: "2-4 sentence neutral summary of the applicant's fit for this role." },
      confirmed_qualifications: { type: "array", items: { type: "string" } },
      unconfirmed_qualifications: { type: "array", items: { type: "string" } },
      missing_information: { type: "array", items: { type: "string" } },
      strengths: { type: "array", items: { type: "string" } },
      concerns: { type: "array", items: { type: "string" }, description: "Concerns that warrant human review. Never based on protected characteristics." },
      suggested_screening_questions: { type: "array", items: { type: "string" } },
      recommended_next_action: { type: "string" },
      match_category: {
        type: "string",
        enum: ["priority_review", "qualified", "possibly_qualified", "insufficient_information", "does_not_meet"],
      },
    },
    required: [
      "summary", "confirmed_qualifications", "unconfirmed_qualifications", "missing_information",
      "strengths", "concerns", "suggested_screening_questions", "recommended_next_action", "match_category",
    ],
  };

  const AI_SYSTEM_PROMPT = `You are Spectrum Squad's recruiting screening assistant for an ABA therapy provider. You help the hiring team organize and prioritize applicants. You DO NOT make hiring decisions — a human always decides.

Assess the applicant only against the job's stated minimum and preferred qualifications and the information provided. Base every judgment strictly on job-relevant qualifications, experience, credentials, and availability.

Strict fairness rules:
- Never use or infer race, ethnicity, religion, age, sex, gender identity, sexual orientation, pregnancy, disability, medical history, national origin, family status, photographs, or any other protected characteristic.
- Never score an applicant up or down based on their name, address, graduation year, or a photograph.
- When information is missing or ambiguous, flag it as missing/unconfirmed rather than assuming.
- Concerns must be job-related only.

Match categories:
- priority_review: appears to meet all stated minimum requirements and is a strong, time-sensitive fit.
- qualified: appears to meet the stated minimum requirements.
- possibly_qualified: partially meets requirements or shows promise but key items are unconfirmed.
- insufficient_information: too little information to assess against the minimums.
- does_not_meet: clearly does not meet one or more stated minimum requirements.`;

  async function callClaudeAssessment(userContent) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: HR_AI_MODEL,
        max_tokens: 4096,
        system: AI_SYSTEM_PROMPT,
        output_config: {
          effort: "medium",
          format: { type: "json_schema", schema: ASSESSMENT_SCHEMA },
        },
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    if (data.stop_reason === "refusal") {
      throw new Error("The AI declined to assess this application.");
    }
    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock) throw new Error("No assessment returned by the AI.");
    let parsed;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch (e) {
      throw new Error("AI returned an unparseable assessment.");
    }
    return { parsed, model: data.model || HR_AI_MODEL };
  }

  // Builds the fairness-safe content payload: role requirements + the
  // applicant's job-relevant answers, plus the resume PDF as a native document
  // block when available. Deliberately omits name, address, city/state.
  async function buildScreeningContent(position, applicant) {
    const answers = parseJson(applicant.screening_answers, {}) || {};
    const creds = parseJson(applicant.credentials, {}) || {};
    const lines = [];
    lines.push("Assess this applicant for the following position.");
    lines.push("");
    lines.push(`POSITION: ${position ? position.title : "Unknown"} (${position ? position.role_type : "n/a"})`);
    if (position) {
      lines.push("MINIMUM QUALIFICATIONS:");
      (parseJson(position.min_qualifications, []) || []).forEach((q) => lines.push(`  - ${q}`));
      lines.push("PREFERRED QUALIFICATIONS:");
      (parseJson(position.preferred_qualifications, []) || []).forEach((q) => lines.push(`  - ${q}`));
    }
    lines.push("");
    lines.push("APPLICANT SCREENING ANSWERS:");
    Object.entries(answers).forEach(([k, v]) => lines.push(`  - ${k}: ${v}`));
    if (Object.keys(creds).length) {
      lines.push("CREDENTIAL INFO:");
      Object.entries(creds).forEach(([k, v]) => lines.push(`  - ${k}: ${v}`));
    }
    if (applicant.preferred_schedule) lines.push(`PREFERRED SCHEDULE: ${applicant.preferred_schedule}`);
    if (applicant.earliest_start) lines.push(`EARLIEST START: ${applicant.earliest_start}`);
    if (applicant.work_setting) lines.push(`PREFERRED WORK SETTING: ${applicant.work_setting}`);
    if (applicant.cover_letter) {
      lines.push("");
      lines.push("COVER LETTER:");
      lines.push(applicant.cover_letter);
    }

    const content = [];
    // Attach a PDF resume as a native document block (Claude reads PDFs).
    const doc = await dbGet(
      "SELECT * FROM hr_applicant_documents WHERE applicant_id = ? AND kind = 'resume' ORDER BY id DESC LIMIT 1",
      [applicant.id]
    );
    if (doc && /pdf$/i.test(doc.mime_type || "") ) {
      const full = path.join(RESUME_DIR, doc.stored_name);
      if (fs.existsSync(full)) {
        const b64 = fs.readFileSync(full).toString("base64");
        content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } });
      } else {
        lines.push("(Resume file is missing on disk.)");
      }
    } else if (doc) {
      lines.push(`(A ${doc.mime_type || "non-PDF"} resume was uploaded but only its metadata is available to this assessment.)`);
    } else {
      lines.push("(No resume uploaded.)");
    }
    content.push({ type: "text", text: lines.join("\n") });
    return content;
  }

  async function runScreening(applicant, actor) {
    const position = applicant.position_id
      ? await dbGet("SELECT * FROM hr_positions WHERE id = ?", [applicant.position_id])
      : null;

    // No key configured: fall back to the deterministic rules engine so the
    // pipeline still works, and say so clearly.
    if (!process.env.ANTHROPIC_API_KEY) {
      const match = evaluateMatch(position, applicant);
      await dbRun("UPDATE hr_applicants SET match_category = ?, priority_flag = ?, updated_at = ? WHERE id = ?", [
        match.match_category, match.priority_flag, nowISO(), applicant.id,
      ]);
      await audit(actor, "ai_screening_run", "applicant", applicant.id, `match=${match.match_category} (rules-based, no AI key)`);
      return {
        ok: false,
        pending: true,
        match,
        message: "Recorded a rules-based assessment. Add ANTHROPIC_API_KEY (in Railway) to enable full Claude AI screening.",
      };
    }

    let result;
    try {
      const content = await buildScreeningContent(position, applicant);
      result = await callClaudeAssessment(content);
    } catch (e) {
      await audit(actor, "ai_screening_failed", "applicant", applicant.id, e.message);
      return { ok: false, error: e.message, message: "AI screening failed: " + e.message };
    }

    const a = result.parsed;
    const priority = a.match_category === "priority_review";

    await dbRun(
      `INSERT INTO hr_screenings
        (applicant_id, model, summary, confirmed_quals, unconfirmed_quals, missing_info, strengths,
         concerns, suggested_questions, recommended_action, match_category, raw_json, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        applicant.id, result.model, a.summary || "",
        JSON.stringify(a.confirmed_qualifications || []),
        JSON.stringify(a.unconfirmed_qualifications || []),
        JSON.stringify(a.missing_information || []),
        JSON.stringify(a.strengths || []),
        JSON.stringify(a.concerns || []),
        JSON.stringify(a.suggested_screening_questions || []),
        a.recommended_next_action || "",
        a.match_category || "insufficient_information",
        JSON.stringify(a),
        actor, nowISO(),
      ]
    );

    await dbRun(
      `UPDATE hr_applicants SET ai_summary = ?, confirmed_quals = ?, missing_quals = ?, match_category = ?, priority_flag = ?, updated_at = ? WHERE id = ?`,
      [
        a.summary || "",
        JSON.stringify(a.confirmed_qualifications || []),
        JSON.stringify(a.missing_information || []),
        a.match_category || "insufficient_information",
        priority,
        nowISO(),
        applicant.id,
      ]
    );

    await audit(actor, "ai_screening_run", "applicant", applicant.id, `match=${a.match_category} model=${result.model}`);

    // Priority BCBA -> alert the owner, same as the intake rules path.
    if (priority && position && position.role_type === "bcba") {
      await notify({
        type: "priority_bcba",
        applicantId: applicant.id,
        positionId: position.id,
        title: "Priority BCBA candidate (AI-screened)",
        body: `${applicant.full_name} was assessed as Priority Review by AI screening. ${a.summary || ""}`,
        severity: "urgent",
      });
      const to = await ownerEmail();
      if (to) {
        sendEmail({
          to,
          subject: `⭐ Priority BCBA (AI-screened): ${applicant.full_name}`,
          html: `<p>AI screening marked this BCBA applicant <strong>Priority Review</strong>.</p>
                 <p>${escapeHtml(a.summary || "")}</p>
                 <p><a href="${APP_BASE_URL}/#/hr/candidate/${applicant.id}">Open candidate in the CRM</a></p>`,
          type: "hr_priority_bcba",
        }).catch((e) => console.error("priority BCBA email failed:", e.message));
      }
    }

    return { ok: true, match_category: a.match_category, message: "AI screening complete." };
  }

  // ============================ FOLLOW-UP AUTOMATION ============================
  // Warm, personal, sequenced outreach. The assistant always identifies itself
  // honestly. Automation stops the moment a candidate responds, a human takes
  // over, or the candidate opts out. Every message is recorded with its
  // delivery status, and steps are one-per-row so nothing is sent twice.
  function futureISO(ms) {
    return new Date(Date.now() + ms).toISOString();
  }
  const HR_HOUR = 3600 * 1000;

  function firstNameOf(fullName) {
    return String(fullName || "there").trim().split(/\s+/)[0] || "there";
  }

  function missingQuestions(position, screeningAnswers) {
    if (!position) return [];
    const qs = parseJson(position.screening_questions, []) || [];
    const answers = parseJson(screeningAnswers, {}) || {};
    return qs.filter((q) => !String(answers[q.id] || "").trim()).map((q) => q.label);
  }

  // Returns { subject, html } for a given step. Tone is warm and conversational.
  function followupMessage(step, sequence, applicant, position) {
    const name = firstNameOf(applicant.full_name);
    const title = (position && position.title) || "the role";
    const isPriority = sequence === "priority_bcba";
    const missing = missingQuestions(position, applicant.screening_answers);
    const missingBlock = missing.length
      ? `<p>When you have a moment, could you share:</p><ul>${missing.slice(0, 2).map((q) => `<li>${escapeHtml(q)}</li>`).join("")}</ul>`
      : "";
    const signoff = `<p>Just hit reply and it comes straight to our team.</p><p>Warmly,<br/>The Spectrum Squad Team</p>`;
    const intro = `<p>Quick intro: I'm Spectrum Squad's recruiting assistant. I help our team coordinate applications, answer basic questions, and schedule interviews — and a real person on our team is reviewing your application too.</p>`;

    switch (step) {
      case "acknowledgment":
        return {
          subject: `Thanks for applying to Spectrum Squad, ${name}! 🎉`,
          html:
            `<p>Hi ${escapeHtml(name)},</p>` +
            `<p>Thank you so much for applying for our <strong>${escapeHtml(title)}</strong> role — we're genuinely excited you're interested in joining Spectrum Squad!</p>` +
            intro +
            (isPriority
              ? `<p>Your background looks like a great match, so we'd love to move quickly. ${missing.length ? "A couple of quick questions will help us fast-track you:" : "Someone from our team will reach out very soon to find a time to talk."}</p>`
              : "") +
            missingBlock +
            (!isPriority && !missing.length ? `<p>Your application looks complete — our team will be in touch soon.</p>` : "") +
            signoff,
        };
      case "followup_1":
        return {
          subject: isPriority ? `Still excited to connect, ${name}!` : `Following up on your Spectrum Squad application`,
          html:
            `<p>Hi ${escapeHtml(name)},</p>` +
            `<p>${isPriority ? "We're really enthusiastic about your application" : "Just floating this back to the top of your inbox"} for the <strong>${escapeHtml(title)}</strong> role.</p>` +
            (missing.length ? missingBlock : `<p>Is there a day or time that works well for a quick call this week?</p>`) +
            signoff,
        };
      case "followup_2":
        return {
          subject: `Checking in — Spectrum Squad`,
          html:
            `<p>Hi ${escapeHtml(name)},</p>` +
            `<p>I wanted to gently check in — we'd still love to connect about the <strong>${escapeHtml(title)}</strong> role. No pressure at all; even a one-line reply helps us know where you're at.</p>` +
            missingBlock +
            signoff,
        };
      case "followup_3":
        return {
          subject: `One last note from Spectrum Squad`,
          html:
            `<p>Hi ${escapeHtml(name)},</p>` +
            `<p>This is my last check-in for now on the <strong>${escapeHtml(title)}</strong> role. If the timing isn't right, no worries at all — we'll keep your information on file and reach out if something opens up that fits.</p>` +
            `<p>If you'd still like to move forward, just reply and we'll pick right back up!</p>` +
            `<p>Warmly,<br/>The Spectrum Squad Team</p>`,
        };
      default:
        return { subject: `A note from Spectrum Squad`, html: `<p>Hi ${escapeHtml(name)},</p>${signoff}` };
    }
  }

  // Sends an email to a candidate, records it, and updates last_contacted_at.
  // Honors do-not-contact. Returns the sendEmail result (or a skip marker).
  async function sendApplicantEmail(applicant, subject, html, opts = {}) {
    if (!applicant.email) return { skipped: "no_email" };
    if (applicant.do_not_contact) return { skipped: "do_not_contact" };
    let result;
    try {
      result = await sendEmail({ to: applicant.email, subject, html, clientId: null, type: "recruiting" });
    } catch (e) {
      result = { delivered: "failed", errorMsg: e.message };
    }
    await dbRun(
      `INSERT INTO hr_applicant_messages
        (applicant_id, direction, channel, from_addr, to_addr, subject, body, status, error, ai_generated, sent_by, created_at)
       VALUES (?, 'outbound', 'email', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        applicant.id,
        process.env.EMAIL_FROM || "careers@spectrumsquadlv.com",
        applicant.email,
        subject,
        html,
        result.delivered || "unknown",
        result.errorMsg || null,
        opts.aiGenerated ? true : false,
        opts.sentBy || "assistant",
        nowISO(),
      ]
    );
    await dbRun("UPDATE hr_applicants SET last_contacted_at = ?, updated_at = ? WHERE id = ?", [nowISO(), nowISO(), applicant.id]);
    return result;
  }

  async function cancelPendingFollowups(applicantId) {
    await dbRun("UPDATE hr_followups SET status = 'canceled' WHERE applicant_id = ? AND status = 'pending'", [applicantId]);
    await dbRun("UPDATE hr_applicants SET next_followup_at = NULL WHERE id = ?", [applicantId]);
  }

  // Records a stage transition (used by automation and disposition).
  async function moveStageInternal(applicant, toStage, actor, note) {
    const now = nowISO();
    await dbRun("UPDATE hr_applicants SET stage = ?, updated_at = ? WHERE id = ?", [toStage, now, applicant.id]);
    await dbRun(
      `INSERT INTO hr_applicant_stage_history (applicant_id, from_stage, to_stage, changed_by, note, changed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [applicant.id, applicant.stage, toStage, actor, note || null, now]
    );
  }

  // Enroll a newly-created applicant: send the warm acknowledgment now and
  // schedule the follow-up steps. Only runs with email consent and an address.
  async function enrollFollowupSequence(applicant, position) {
    if (!applicant.email || applicant.do_not_contact) return;
    if (!(applicant.consent_email === true || applicant.consent_email === "true")) return;

    const isPriority = !!applicant.priority_flag && position && position.role_type === "bcba";
    const sequence = isPriority ? "priority_bcba" : "default";

    const ack = followupMessage("acknowledgment", sequence, applicant, position);
    await sendApplicantEmail(applicant, ack.subject, ack.html, { step: "acknowledgment", sentBy: "assistant" });

    const steps = isPriority
      ? [["followup_1", 24 * HR_HOUR]]
      : [["followup_1", 24 * HR_HOUR], ["followup_2", 72 * HR_HOUR], ["followup_3", 168 * HR_HOUR]];
    for (const [step, ms] of steps) {
      await dbRun(
        `INSERT INTO hr_followups (applicant_id, sequence, step, scheduled_at, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
        [applicant.id, sequence, step, futureISO(ms), nowISO()]
      );
    }
    await dbRun("UPDATE hr_applicants SET next_followup_at = ? WHERE id = ?", [futureISO(steps[0][1]), applicant.id]);
    await audit("assistant", "sequence_enrolled", "applicant", applicant.id, `sequence=${sequence}`);
  }

  // Background processor: sends any follow-ups that are due, honoring all stop
  // conditions, and disposition after the final step. Safe to call on an
  // interval or manually.
  async function processFollowups(limit = 100) {
    const now = nowISO();
    const due = await dbAll(
      "SELECT * FROM hr_followups WHERE status = 'pending' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT ?",
      [now, limit]
    );
    let sent = 0;
    let canceled = 0;
    for (const f of due) {
      const applicant = await dbGet("SELECT * FROM hr_applicants WHERE id = ?", [f.applicant_id]);
      if (!applicant) {
        await dbRun("UPDATE hr_followups SET status = 'canceled' WHERE id = ?", [f.id]);
        canceled++;
        continue;
      }
      // Stop conditions: opted out, paused, already responded, or closed.
      const stopped =
        applicant.do_not_contact ||
        applicant.automation_paused ||
        applicant.last_response_at ||
        ["hired", "not_selected", "withdrawn", "talent_pool"].includes(applicant.stage);
      if (stopped) {
        await cancelPendingFollowups(applicant.id);
        canceled++;
        continue;
      }
      const position = applicant.position_id ? await dbGet("SELECT * FROM hr_positions WHERE id = ?", [applicant.position_id]) : null;
      const msg = followupMessage(f.step, f.sequence, applicant, position);
      const res = await sendApplicantEmail(applicant, msg.subject, msg.html, { step: f.step, sentBy: "assistant" });
      await dbRun("UPDATE hr_followups SET status = ?, sent_at = ? WHERE id = ?", [res && res.skipped ? "canceled" : "sent", nowISO(), f.id]);
      await audit("assistant", "followup_sent", "applicant", applicant.id, `step=${f.step} delivered=${(res && res.delivered) || res.skipped || "n/a"}`);
      sent++;

      const remaining = await dbGet("SELECT COUNT(*) AS n FROM hr_followups WHERE applicant_id = ? AND status = 'pending'", [applicant.id]);
      if (Number(remaining.n) === 0) {
        // Final step just went out: disposition based on consent.
        if (applicant.consent_email) {
          await moveStageInternal(applicant, "talent_pool", "assistant", "Automated sequence complete — moved to Talent Pool");
        } else {
          await dbRun("UPDATE hr_applicants SET disposition_reason = ? WHERE id = ?", ["Sequence complete (no consent for future contact)", applicant.id]);
        }
        await dbRun("UPDATE hr_applicants SET next_followup_at = NULL WHERE id = ?", [applicant.id]);
      } else {
        const next = await dbGet("SELECT MIN(scheduled_at) AS s FROM hr_followups WHERE applicant_id = ? AND status = 'pending'", [applicant.id]);
        await dbRun("UPDATE hr_applicants SET next_followup_at = ? WHERE id = ?", [next.s, applicant.id]);
      }
    }
    return { due: due.length, sent, canceled };
  }

  // ============================ DASHBOARDS ============================
  async function recruitingDashboard() {
    const positions = await dbAll("SELECT id, title, status, openings_count, role_type FROM hr_positions");
    const activePositions = positions.filter((p) => p.status === "open");
    const openings = activePositions.reduce((sum, p) => sum + (Number(p.openings_count) || 0), 0);

    const stageCounts = await dbAll("SELECT stage, COUNT(*) AS n FROM hr_applicants GROUP BY stage");
    const stageMap = {};
    stageCounts.forEach((r) => (stageMap[r.stage] = Number(r.n)));

    const bySource = await dbAll("SELECT source, COUNT(*) AS n FROM hr_applicants GROUP BY source ORDER BY n DESC");
    const byPosition = await dbAll(
      `SELECT p.title, COUNT(a.id) AS n FROM hr_positions p
       LEFT JOIN hr_applicants a ON a.position_id = p.id GROUP BY p.id, p.title ORDER BY n DESC`
    );

    const newApplicants = stageMap.new_applicant || 0;
    const unreviewed = (stageMap.new_applicant || 0) + (stageMap.ai_screening || 0) + (stageMap.needs_human_review || 0);
    const interviewsScheduled = stageMap.interview_scheduled || 0;
    const interviewsCompleted = stageMap.interviewed || 0;
    const offersPending = (stageMap.offer_approval || 0) + (stageMap.offer_sent || 0);
    const hires = stageMap.hired || 0;

    const needFollowup = (await dbGet(
      "SELECT COUNT(*) AS n FROM hr_applicants WHERE next_followup_at IS NOT NULL AND next_followup_at <= ? AND stage NOT IN ('hired','not_selected','withdrawn')",
      [nowISO()]
    )).n;

    const automationFailures = (await dbGet(
      "SELECT COUNT(*) AS n FROM hr_applicant_messages WHERE status = 'failed'"
    )).n;

    return {
      active_positions: activePositions.length,
      total_openings: openings,
      new_applicants: newApplicants,
      unreviewed_applicants: unreviewed,
      need_followup: Number(needFollowup),
      interviews_scheduled: interviewsScheduled,
      interviews_completed: interviewsCompleted,
      offers_pending: offersPending,
      hires,
      applicants_by_source: bySource.map((r) => ({ source: r.source, count: Number(r.n) })),
      applicants_by_position: byPosition.map((r) => ({ title: r.title, count: Number(r.n) })),
      automation_failures: Number(automationFailures),
      stage_counts: stageMap,
    };
  }

  async function bcbaCommandCenter() {
    const pos = await dbGet("SELECT id FROM hr_positions WHERE role_type = 'bcba' ORDER BY id LIMIT 1");
    const positionId = pos ? pos.id : -1;

    const all = await dbAll("SELECT * FROM hr_applicants WHERE position_id = ?", [positionId]);
    const active = all.filter((a) => !["not_selected", "withdrawn"].includes(a.stage));

    const now = Date.now();
    const oneBizDayMs = 24 * 60 * 60 * 1000;

    const awaitingResponse = active.filter((a) =>
      ["contacted", "phone_screen"].includes(a.stage) && !a.last_response_at
    );
    const stalled = active.filter((a) => a.last_contacted_at && !a.last_response_at &&
      now - new Date(a.last_contacted_at).getTime() > 3 * oneBizDayMs);

    // Qualified/priority candidates waiting > 1 business day since applying with no contact.
    const waitingTooLong = active.filter((a) =>
      (a.priority_flag || a.match_category === "qualified") &&
      !a.last_contacted_at &&
      a.applied_at &&
      now - new Date(a.applied_at).getTime() > oneBizDayMs
    );

    const daysInStage = active
      .map((a) => {
        const hist = a.updated_at || a.applied_at || a.created_at;
        const days = hist ? Math.floor((now - new Date(hist).getTime()) / oneBizDayMs) : 0;
        return { id: a.id, name: a.full_name, stage: a.stage, days, match: a.match_category, priority: a.priority_flag };
      })
      .sort((x, y) => y.days - x.days);

    const tasks = [];
    waitingTooLong.forEach((a) =>
      tasks.push({ applicant_id: a.id, name: a.full_name, action: "Call / respond — qualified BCBA waiting > 1 business day", severity: "urgent" })
    );
    active.filter((a) => a.priority_flag && a.stage === "new_applicant").forEach((a) =>
      tasks.push({ applicant_id: a.id, name: a.full_name, action: "Review priority BCBA application", severity: "urgent" })
    );

    return {
      total: all.length,
      new: active.filter((a) => a.stage === "new_applicant").length,
      priority: active.filter((a) => a.priority_flag).length,
      qualified: active.filter((a) => a.match_category === "qualified").length,
      awaiting_response: awaitingResponse.length,
      stalled: stalled.length,
      interviews_scheduled: active.filter((a) => a.stage === "interview_scheduled").length,
      interviews_completed: active.filter((a) => a.stage === "interviewed").length,
      offers_pending: active.filter((a) => ["offer_approval", "offer_sent"].includes(a.stage)).length,
      waiting_too_long: waitingTooLong.map((a) => ({ id: a.id, name: a.full_name, match: a.match_category })),
      days_in_stage: daysInStage,
      owner_tasks: tasks,
    };
  }

  // ============================ CAREERS PAGE ============================
  // Public, mobile-friendly careers site served at /careers, /careers/:slug,
  // and /apply/:token (source-tracked link). Self-contained HTML.
  async function servePage(req, res, pathname) {
    if (pathname === "/careers" || pathname === "/careers/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(careersHtml());
      return true;
    }
    if (pathname.startsWith("/careers/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(careersHtml());
      return true;
    }
    if (pathname.startsWith("/apply/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(careersHtml());
      return true;
    }
    return false;
  }

  function careersHtml() {
    // Single-page careers app: lists open roles, shows a role + application
    // form, and posts to /api/hr/apply. Uses the Spectrum Squad brand palette.
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Careers — Spectrum Squad</title>
<style>
  :root{--navy:#29225c;--navy-dark:#1c1740;--navy-light:#edecf8;--gold:#e0a430;--teal:#5fa8a0;--bg:#f7f8fb;--surface:#fff;--border:#e5e7eb;--text:#201a4d;--muted:#6b6a86;--radius:14px;}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.5}
  header{background:linear-gradient(135deg,var(--navy),var(--navy-dark));color:#fff;padding:40px 20px;text-align:center}
  header .mark{font-size:34px}
  header h1{margin:8px 0 4px;font-size:26px}
  header p{margin:0;opacity:.85}
  .wrap{max-width:760px;margin:0 auto;padding:20px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin:16px 0;box-shadow:0 1px 3px rgba(41,34,92,.08)}
  .role-title{font-size:19px;font-weight:700;margin:0 0 4px;color:var(--navy)}
  .badge{display:inline-block;background:var(--navy-light);color:var(--navy);border-radius:20px;padding:3px 12px;font-size:12.5px;font-weight:600;margin:0 6px 6px 0}
  .badge.urgent{background:#fdecc8;color:var(--gold)}
  .muted{color:var(--muted);font-size:14px}
  button,.btn{background:var(--navy);color:#fff;border:none;border-radius:10px;padding:12px 20px;font-size:15px;font-weight:600;cursor:pointer}
  button:hover{background:var(--navy-dark)}
  .btn-ghost{background:#fff;color:var(--navy);border:1px solid var(--navy)}
  label{display:block;font-size:13.5px;font-weight:600;margin:14px 0 5px}
  input,textarea,select{width:100%;padding:11px 12px;border:1px solid var(--border);border-radius:10px;font-size:15px;font-family:inherit}
  textarea{min-height:90px;resize:vertical}
  .q{margin:10px 0}
  .check{display:flex;gap:8px;align-items:flex-start;margin:12px 0;font-size:13.5px;font-weight:500}
  .check input{width:auto;margin-top:3px}
  .err{color:#b91c1c;font-size:13.5px;margin-top:8px}
  .ok{text-align:center;padding:30px}
  .ok .big{font-size:44px}
  footer{text-align:center;color:var(--muted);font-size:12.5px;padding:30px 20px}
  .hidden{display:none}
  .req{color:#b91c1c}
</style></head>
<body>
<header>
  <div class="mark">🧩</div>
  <h1>Join the Spectrum Squad</h1>
  <p>Help children thrive through compassionate, evidence-based ABA care.</p>
</header>
<div class="wrap" id="app"><p class="muted">Loading open positions…</p></div>
<footer>
  Spectrum Squad · Las Vegas & Henderson, NV<br/>
  We are an equal-opportunity employer. Your information is used only for recruiting and is never sold.
</footer>
<script>
(function(){
  var app=document.getElementById("app");
  var path=location.pathname;
  var sourceToken=null, slug=null;
  if(path.indexOf("/apply/")===0){ sourceToken=path.split("/apply/")[1]; }
  else if(path.indexOf("/careers/")===0){ slug=decodeURIComponent(path.split("/careers/")[1]||""); }

  function esc(s){var d=document.createElement("div");d.textContent=s==null?"":String(s);return d.innerHTML;}
  function api(p,opts){opts=opts||{};return fetch(p,{method:opts.method||"GET",headers:opts.body?{"Content-Type":"application/json"}:undefined,body:opts.body?JSON.stringify(opts.body):undefined}).then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.error||"Request failed");return d;});});}

  function start(){
    if(sourceToken){
      api("/api/hr/apply-link/"+encodeURIComponent(sourceToken)).then(function(d){renderForm(d.position,d.source,d.source_id);}).catch(function(){listPositions();});
    } else if(slug){
      api("/api/hr/public/positions/"+encodeURIComponent(slug)).then(function(p){renderForm(p,"website",null);}).catch(function(){listPositions();});
    } else { listPositions(); }
  }

  function listPositions(){
    api("/api/hr/public/positions").then(function(list){
      if(!list.length){app.innerHTML='<div class="card"><p class="muted">There are no open positions right now. Check back soon!</p></div>';return;}
      app.innerHTML=list.map(function(p){
        return '<div class="card"><div class="role-title">'+esc(p.title)+'</div>'+
          '<div>'+(p.priority==="urgent"?'<span class="badge urgent">Urgent hire</span>':'')+
          '<span class="badge">'+esc(p.location_type)+'</span>'+
          (p.locations?'<span class="badge">'+esc(p.locations)+'</span>':'')+'</div>'+
          '<p class="muted">'+esc((p.description||"").slice(0,180))+'…</p>'+
          '<button data-slug="'+esc(p.slug)+'">View & Apply</button></div>';
      }).join("");
      Array.prototype.forEach.call(app.querySelectorAll("button[data-slug]"),function(b){
        b.addEventListener("click",function(){ history.pushState({},"","/careers/"+b.getAttribute("data-slug")); slug=b.getAttribute("data-slug"); sourceToken=null; start(); });
      });
    }).catch(function(e){app.innerHTML='<div class="card err">Could not load positions: '+esc(e.message)+'</div>';});
  }

  function renderForm(p,source,sourceId){
    var quals=(p.min_qualifications||[]).map(function(q){return "<li>"+esc(q)+"</li>";}).join("");
    var pref=(p.preferred_qualifications||[]).map(function(q){return "<li>"+esc(q)+"</li>";}).join("");
    var questions=(p.screening_questions||[]).map(function(q){
      var input;
      if(q.type==="yesno"){input='<select name="q_'+esc(q.id)+'"><option value="">Select…</option><option>Yes</option><option>No</option></select>';}
      else{input='<input name="q_'+esc(q.id)+'" type="text"/>';}
      return '<div class="q"><label>'+esc(q.label)+'</label>'+input+'</div>';
    }).join("");
    app.innerHTML=
      '<div class="card"><div class="role-title">'+esc(p.title)+'</div>'+
      '<div>'+(p.priority==="urgent"?'<span class="badge urgent">Urgent hire</span>':'')+'<span class="badge">'+esc(p.location_type)+'</span>'+(p.locations?'<span class="badge">'+esc(p.locations)+'</span>':'')+'</div>'+
      '<p>'+esc(p.description||"")+'</p>'+
      (p.highlights?'<p class="muted"><strong>Highlights:</strong> '+esc(p.highlights)+'</p>':'')+
      (quals?'<p><strong>Minimum qualifications</strong></p><ul>'+quals+'</ul>':'')+
      (pref?'<p><strong>Preferred</strong></p><ul>'+pref+'</ul>':'')+
      '</div>'+
      '<div class="card"><h3 style="margin-top:0">Apply now</h3><form id="f">'+
      '<label>Full name <span class="req">*</span></label><input name="full_name" required/>'+
      '<label>Email <span class="req">*</span></label><input name="email" type="email" required/>'+
      '<label>Phone</label><input name="phone" type="tel"/>'+
      '<label>City</label><input name="city"/>'+
      '<label>State</label><input name="state" value="NV"/>'+
      questions+
      '<label>Earliest start date</label><input name="earliest_start"/>'+
      '<label>Cover letter / anything you\\'d like us to know</label><textarea name="cover_letter"></textarea>'+
      '<label>Resume (PDF or DOCX)</label><input type="file" id="resume" accept=".pdf,.docx,.doc"/>'+
      '<div class="check"><input type="checkbox" id="consent_email" checked/><label for="consent_email" style="margin:0;font-weight:500">I consent to receive job-related email communication about my application.</label></div>'+
      '<div class="check"><input type="checkbox" id="consent_sms"/><label for="consent_sms" style="margin:0;font-weight:500">Optional: I consent to receive text messages about my application.</label></div>'+
      '<p class="muted" style="font-size:12px">Privacy: your information is used only to evaluate your application and is never sold. We consider all applicants without regard to any protected characteristic.</p>'+
      '<div id="ferr" class="err"></div>'+
      '<button type="submit" id="submit">Submit application</button> <button type="button" class="btn-ghost" id="back">Back</button>'+
      '</form></div>';

    document.getElementById("back").addEventListener("click",function(){history.pushState({},"","/careers");slug=null;sourceToken=null;start();});
    document.getElementById("f").addEventListener("submit",function(ev){
      ev.preventDefault();
      var f=ev.target, err=document.getElementById("ferr"); err.textContent="";
      var btn=document.getElementById("submit"); btn.disabled=true; btn.textContent="Submitting…";
      var answers={};
      (p.screening_questions||[]).forEach(function(q){ var el=f["q_"+q.id]; if(el&&el.value) answers[q.id]=el.value; });
      var payload={
        full_name:f.full_name.value, email:f.email.value, phone:f.phone.value,
        city:f.city.value, state:f.state.value, earliest_start:f.earliest_start.value,
        cover_letter:f.cover_letter.value, screening_answers:answers,
        consent_email:document.getElementById("consent_email").checked,
        consent_sms:document.getElementById("consent_sms").checked,
        slug:p.slug, source:source, source_token:sourceToken
      };
      var fileEl=document.getElementById("resume");
      function send(){
        api("/api/hr/apply",{method:"POST",body:payload}).then(function(){
          app.innerHTML='<div class="card ok"><div class="big">✅</div><h2>Application received!</h2><p class="muted">Thank you for applying to Spectrum Squad. Our recruiting team will be in touch soon.</p></div>';
          window.scrollTo(0,0);
        }).catch(function(e){ err.textContent=e.message; btn.disabled=false; btn.textContent="Submit application"; });
      }
      if(fileEl.files&&fileEl.files[0]){
        var file=fileEl.files[0];
        if(file.size>8*1024*1024){err.textContent="Resume must be under 8MB.";btn.disabled=false;btn.textContent="Submit application";return;}
        var reader=new FileReader();
        reader.onload=function(){ payload.resume={filename:file.name,mime_type:file.type,content_base64:String(reader.result).split(",")[1]}; send(); };
        reader.onerror=function(){ err.textContent="Could not read resume file."; btn.disabled=false; btn.textContent="Submit application"; };
        reader.readAsDataURL(file);
      } else { send(); }
    });
  }

  window.addEventListener("popstate",function(){ location.reload(); });
  start();
})();
</script>
</body></html>`;
  }

  // ============================ EXPORTS ============================
  return {
    initTables,
    seed,
    handleApi,
    servePage,
    processFollowups,
    // exposed for tests / future phases
    _internal: {
      evaluateMatch, PIPELINE_STAGES, APPLICATION_SOURCES, MATCH_CATEGORIES,
      hrCanAccess, hrCanManage, hrCanSeeSensitive, runScreening, buildScreeningContent, ASSESSMENT_SCHEMA,
      followupMessage, enrollFollowupSequence, processFollowups, missingQuestions,
    },
  };
};
