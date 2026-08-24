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
// The one place this CRM talks to Claude. These two screening calls used to
// carry their own copy of the same fetch; ai-client.js is that call, once.
const { callClaude } = require("./ai-client");

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


  // The new-hire employment packet is sent through SignNow, which lives in
  // server.js. If an older server.js is running without it, degrade to a
  // recorded no-op rather than crashing offer acceptance.
  const sendNewHirePacket = ctx.sendNewHirePacket || (async () => ({
    ok: false, status: "blocked", error: "The new-hire packet sender is not available on this server build.",
  }));
  const getNewHirePacket = ctx.getNewHirePacket || (async () => ({
    packet: null, configured: false, signnow_connected: false, template_set: false,
  }));
  // Starting the document portal and sending the welcome email are part of
  // accepting an offer, but they live in onboarding.js.
  const startOnboarding = ctx.startOnboarding || (async () => null);
  const onCompletion = ctx.onCompletion || (() => {});

  // The welcome-and-documents email, chosen by role, carrying that role's
  // credentialing link and the hire's own portal link.
  async function sendWelcomeDocumentsEmail(employee, record) {
    if (!employee || !employee.email || !record) return { ok: false, reason: "no email or no onboarding record" };
    const kind = record.role_kind === "bcba" ? "bcba"
      : record.role_kind === "cota" ? "cota"
      : "rbt";
    const key = kind === "bcba" ? "hr_welcome_docs_bcba"
      : kind === "cota" ? "hr_welcome_docs_cota"
      : "hr_welcome_docs_rbt";
    const credLink = (await ctx.getAppSetting?.(`credentialing_link_${kind}`, "")) || "";
    const t = await renderHrEmail(key, {
      first_name: firstNameOf(employee.name),
      credentialing_form_link: credLink,
      upload_portal_link: ctx.onboardingPortalUrl ? ctx.onboardingPortalUrl(record.portal_token) : "",
    });
    if (!t) return { ok: false, reason: "template missing" };
    await sendEmail({ to: employee.email, subject: t.subject, html: t.html, type: "hr_onboarding" });
    return { ok: true, template: key };
  }

  // ---- file storage (Railway volume at /app/data) ----
  const DATA_DIR = path.join(__dirname, "data");
  const RESUME_DIR = path.join(DATA_DIR, "hr-resumes");
  if (!fs.existsSync(RESUME_DIR)) fs.mkdirSync(RESUME_DIR, { recursive: true });
  const HR_DOC_DIR = path.join(DATA_DIR, "hr-docs");
  if (!fs.existsSync(HR_DOC_DIR)) fs.mkdirSync(HR_DOC_DIR, { recursive: true });

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

  // HR module spec: staff lifecycle stages + the six-document tracker.
  const HR_STAGES = ["Applicant", "Interviewing", "Offer Sent", "Offer Accepted", "Onboarding", "Active", "Inactive"];
  const HR_DOC_KEYS = [
    { key: "headshot", label: "Headshot (shoulders up)", file: true },
    { key: "social", label: "Social Security card", file: false },        // status only
    { key: "id", label: "Copy of ID", file: false },                      // status only
    { key: "rbt_state", label: "State RBT license", file: true, expires: true },
    { key: "rbt_national", label: "National RBT license", file: true, expires: true },
    { key: "background_check", label: "Background check", file: true },
  ];
  const HR_DOC_STATUSES = ["Not Requested", "Requested", "Received", "Verified", "Expired"];

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


  // A per-user grant from the Access editor unlocks this module's ordinary
  // access tier even when the role list wouldn't. Manage/sensitive tiers stay
  // role-gated.
  const granted = (u, k) => !!(ctx.moduleGranted && ctx.moduleGranted(u, k));
  function hrCanAccess(user) {
    return !!user && (HR_ACCESS_ROLES.includes(user.role) || granted(user, "hr"));
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

    await dbRun(`CREATE TABLE IF NOT EXISTS hr_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS hr_offers (
      id SERIAL PRIMARY KEY,
      applicant_id INTEGER NOT NULL,
      position_id INTEGER,
      job_title TEXT,
      employment_type TEXT,
      comp_amount NUMERIC,
      comp_unit TEXT DEFAULT 'year',
      comp_notes TEXT,
      start_date TEXT,
      supervisor TEXT,
      location TEXT,
      highlights TEXT DEFAULT '[]',
      custom_message TEXT,
      expires_at TEXT,
      status TEXT DEFAULT 'draft',   -- draft|approved|sent|accepted|declined|expired
      token TEXT UNIQUE,
      signed_name TEXT,
      signed_at TEXT,
      decline_reason TEXT,
      created_by TEXT,
      approved_by TEXT,
      sent_at TEXT,
      created_at TEXT,
      updated_at TEXT
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
    // Expanded employment application (Phase 6a). All additive.
    for (const col of [
      "preferred_name TEXT", "address TEXT", "desired_pay TEXT",
      "certifications TEXT", "education TEXT", "employment_history TEXT",
      "sms_consent_at TEXT", "sms_consent_version TEXT",
    ]) {
      await dbRun(`ALTER TABLE hr_applicants ADD COLUMN IF NOT EXISTS ${col}`).catch((e) => console.error("hr_applicants alter:", e.message));
    }

    // ---- interview scheduling ----
    await dbRun(`CREATE TABLE IF NOT EXISTS hr_interview_slots (
      id SERIAL PRIMARY KEY,
      position_id INTEGER,
      start_at TEXT NOT NULL,
      duration_min INTEGER DEFAULT 30,
      mode TEXT DEFAULT 'virtual',        -- virtual|in_person
      location_or_link TEXT,
      interviewer TEXT,
      status TEXT DEFAULT 'open',          -- open|booked|canceled
      applicant_id INTEGER,
      created_by TEXT,
      created_at TEXT
    )`);
    await dbRun(`CREATE TABLE IF NOT EXISTS hr_schedule_links (
      token TEXT PRIMARY KEY,
      applicant_id INTEGER NOT NULL,
      created_at TEXT
    )`);
    await dbRun(`CREATE TABLE IF NOT EXISTS hr_timecard_links (
      token TEXT PRIMARY KEY,
      timecard_id INTEGER NOT NULL,
      created_at TEXT
    )`);
    // hr_timecards stores the raw import + parsed entries.
    await dbRun(`ALTER TABLE hr_timecards ADD COLUMN IF NOT EXISTS entries TEXT`).catch(() => {});
    await dbRun(`ALTER TABLE hr_timecards ADD COLUMN IF NOT EXISTS verification_requested_at TEXT`).catch(() => {});
    // Employee accept / edit responses to the emailed timecard (additive; no payroll writes).
    await dbRun(`ALTER TABLE hr_timecards ADD COLUMN IF NOT EXISTS accepted_at TEXT`).catch(() => {});
    await dbRun(`ALTER TABLE hr_timecards ADD COLUMN IF NOT EXISTS signed_name TEXT`).catch(() => {});
    await dbRun(`ALTER TABLE hr_timecards ADD COLUMN IF NOT EXISTS employee_note TEXT`).catch(() => {});
    await dbRun(`ALTER TABLE hr_timecards ADD COLUMN IF NOT EXISTS edited_entries TEXT`).catch(() => {});
    // Office-side corrections made from the bulk review screen, before send.
    await dbRun(`ALTER TABLE hr_timecards ADD COLUMN IF NOT EXISTS admin_edited_at TEXT`).catch(() => {});
    await dbRun(`ALTER TABLE hr_timecards ADD COLUMN IF NOT EXISTS admin_edited_by TEXT`).catch(() => {});
    // Staff directory fields (populated from the Rethink payroll sheet -- no pay).
    await dbRun(`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS phone TEXT`).catch(() => {});
    await dbRun(`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS address TEXT`).catch(() => {});
    await dbRun(`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS certifications TEXT`).catch(() => {});
    await dbRun(`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS rethink_id TEXT`).catch(() => {});
    // HR module spec: staff lifecycle + onboarding fields (all hr_-prefixed).
    await dbRun(`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS hr_stage TEXT`).catch(() => {});
    await dbRun(`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS hr_offer_accepted_date TEXT`).catch(() => {});
    await dbRun(`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS hr_hire_date TEXT`).catch(() => {});
    await dbRun(`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS hr_photo TEXT`).catch(() => {});
    await dbRun(`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS hr_availability TEXT`).catch(() => {});
    await dbRun(`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS hr_stipulations TEXT`).catch(() => {});
    await dbRun(`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS hr_milestones_sent TEXT`).catch(() => {}); // JSON: {30:ts,60:ts,90:ts}
    await dbRun(`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS hr_activity TEXT`).catch(() => {});       // JSON array of {at, text}
    // Schedule preferences shown on the staff card (owner/HR-entered).
    await dbRun(`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS hr_pref_hours TEXT`).catch(() => {});
    await dbRun(`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS hr_pref_location TEXT`).catch(() => {});
    await dbRun(`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS hr_pref_language TEXT`).catch(() => {});
    await dbRun(`ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS hr_pref_notes TEXT`).catch(() => {});
    // Document tracker: one row per (employee, doc_key). social/id store status only.
    await dbRun(`CREATE TABLE IF NOT EXISTS hr_doc_tracker (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      doc_key TEXT NOT NULL,        -- headshot|social|id|rbt_state|rbt_national|background_check
      status TEXT NOT NULL DEFAULT 'Not Requested', -- Not Requested|Requested|Received|Verified|Expired
      date_requested TEXT,
      date_received TEXT,
      expiration_date TEXT,
      notes TEXT,
      stored_name TEXT,            -- file on disk (never set for social/id)
      filename TEXT,
      mime_type TEXT,
      followup_task_made TEXT,     -- timestamp when the 3-day follow-up task was auto-created
      renewal_task_made TEXT,      -- timestamp when the 60-day renewal task was auto-created
      updated_at TEXT,
      UNIQUE (employee_id, doc_key)
    )`);
    // Tokenized staff availability form links (new-hire scheduling request).
    await dbRun(`CREATE TABLE IF NOT EXISTS hr_avail_links (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      created_at TEXT
    )`);
    // hr_interviews already exists; add scheduling/reminder columns idempotently.
    await dbRun(`ALTER TABLE hr_interviews ADD COLUMN IF NOT EXISTS slot_id INTEGER`).catch(() => {});
    await dbRun(`ALTER TABLE hr_interviews ADD COLUMN IF NOT EXISTS reminder_24_sent BOOLEAN DEFAULT FALSE`).catch(() => {});
    await dbRun(`ALTER TABLE hr_interviews ADD COLUMN IF NOT EXISTS reminder_2_sent BOOLEAN DEFAULT FALSE`).catch(() => {});

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

  const BCABA_SCREENING_QUESTIONS = [
    { id: "bcaba_certified", label: "Are you currently certified as a BCaBA?", type: "yesno" },
    { id: "supervision_ok", label: "Do you have a supervising BCBA, or are you open to supervision from our clinical team?", type: "yesno" },
    { id: "years_experience", label: "How many years of behavior-analytic experience do you have?", type: "text" },
    { id: "settings_comfort", label: "Are you comfortable working across clinic, home and school settings?", type: "yesno" },
    { id: "mentored_rbts", label: "Have you helped train or mentor RBTs?", type: "yesno" },
    { id: "schedule_type", label: "What type of schedule are you seeking?", type: "text" },
    { id: "earliest_start", label: "What is your earliest available start date?", type: "text" },
    { id: "comp_range", label: "What compensation range are you seeking?", type: "text", sensitive: true },
  ];
  const BCABA_MIN_QUALS = [
    "Active BCaBA certification",
    "Ongoing BCBA supervision, as required to practice",
  ];
  const BCABA_PREFERRED_QUALS = [
    "Experience mentoring RBTs",
    "Experience assisting with treatment plans",
    "Experience supporting assessments",
    "Experience with Medicaid and insurance-funded ABA",
    "Clinic, in-home, and school-based experience",
  ];

  const COTA_SCREENING_QUESTIONS = [
    { id: "cota_certified", label: "Are you currently certified by NBCOT as a COTA?", type: "yesno" },
    { id: "nevada_ota_license", label: "Do you currently hold a Nevada Occupational Therapy Assistant (OTA) license?", type: "yesno" },
    { id: "willing_ota_license", label: "If not, are you eligible and willing to obtain a Nevada OTA license?", type: "yesno" },
    { id: "pediatric_experience", label: "Do you have experience providing OT services to children?", type: "yesno" },
    { id: "supervision_ok", label: "Are you comfortable practicing under the supervision of a licensed OT, as required?", type: "yesno" },
    { id: "settings_comfort", label: "Are you comfortable working across clinic, home and school settings?", type: "yesno" },
    { id: "availability", label: "What days and hours are you available?", type: "text" },
    { id: "earliest_start", label: "What is your earliest available start date?", type: "text" },
    { id: "comp_range", label: "What compensation range are you seeking?", type: "text", sensitive: true },
  ];
  const COTA_MIN_QUALS = [
    "Active NBCOT certification as a COTA",
    "Nevada OTA license, or eligibility and willingness to obtain Nevada licensure",
    "Practice under the supervision of a licensed Occupational Therapist",
  ];
  const COTA_PREFERRED_QUALS = [
    "Pediatric occupational therapy experience",
    "Experience with sensory-integration approaches",
    "Experience collaborating with ABA / behavior-analytic teams",
    "CPR / BLS certification",
    "Clinic, in-home, and school-based experience",
    "Experience with insurance-funded and Medicaid OT services",
  ];

  const ADMIN_SCREENING_QUESTIONS = [
    { id: "admin_experience", label: "Tell us about your admin or front-office experience.", type: "text" },
    { id: "tools_comfort", label: "Are you comfortable learning new scheduling / CRM software?", type: "yesno" },
    { id: "healthcare_office", label: "Have you worked in a healthcare, therapy or clinic office before?", type: "yesno" },
    { id: "bilingual", label: "Do you speak any languages besides English? (A big plus, not required.)", type: "text" },
    { id: "availability", label: "What days and hours are you available?", type: "text" },
    { id: "earliest_start", label: "What is your earliest available start date?", type: "text" },
    { id: "comp_range", label: "What compensation range are you seeking?", type: "text", sensitive: true },
  ];
  const ADMIN_MIN_QUALS = [
    "High school diploma or equivalent",
    "Strong communication and organization skills",
  ];
  const ADMIN_PREFERRED_QUALS = [
    "Healthcare, therapy or ABA office experience",
    "Familiarity with EHR / CRM or scheduling software",
    "Insurance and authorization familiarity",
    "Bilingual (English / Spanish)",
    "A warm, welcoming phone and front-desk manner",
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

    await dbRun(
      `INSERT INTO hr_positions
        (slug, title, role_type, employment_types, location_type, locations, description,
         highlights, openings_count, status, priority, comp_unit,
         min_qualifications, preferred_qualifications, screening_questions, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (slug) DO NOTHING`,
      [
        "bcaba",
        "Board Certified Assistant Behavior Analyst",
        "other",
        JSON.stringify(["full_time", "part_time"]),
        "hybrid",
        "Las Vegas & Henderson, NV",
        "Spectrum Squad is growing our clinical team and hiring a Board Certified Assistant Behavior Analyst (BCaBA). You'll work hand-in-hand with our BCBAs to implement and fine-tune treatment programs, support assessments, and mentor RBTs across clinic, home, and school settings — with real supervision, real support, and a clear path toward your BCBA.",
        "Direct BCBA mentorship • Clear path toward BCBA • Flexible hybrid schedule • Collaborative, kind team",
        1,
        "open",
        "high",
        "hour",
        JSON.stringify(BCABA_MIN_QUALS),
        JSON.stringify(BCABA_PREFERRED_QUALS),
        JSON.stringify(BCABA_SCREENING_QUESTIONS),
        "system",
        now,
        now,
      ]
    );

    // COTA (Certified Occupational Therapy Assistant). role_type 'other' keeps
    // the existing role_type CHECK/allowed set intact; onboarding maps the
    // title to a dedicated "cota" role kind for the right document checklist.
    await dbRun(
      `INSERT INTO hr_positions
        (slug, title, role_type, employment_types, location_type, locations, description,
         highlights, openings_count, status, priority, comp_unit,
         min_qualifications, preferred_qualifications, screening_questions, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (slug) DO NOTHING`,
      [
        "cota",
        "Certified Occupational Therapy Assistant (COTA)",
        "other",
        JSON.stringify(["full_time", "part_time", "contract"]),
        "hybrid",
        "Las Vegas & Henderson, NV",
        "Spectrum Squad is hiring a Certified Occupational Therapy Assistant (COTA) to support pediatric occupational therapy across clinic, home, and school settings. Working under the supervision of a licensed Occupational Therapist, you'll help implement treatment plans, run engaging sensory and motor activities, and partner closely with our ABA team to help children thrive.",
        "Supportive OT + ABA team • Flexible hybrid schedule • Meaningful pediatric work • Competitive compensation",
        1,
        "open",
        "high",
        "hour",
        JSON.stringify(COTA_MIN_QUALS),
        JSON.stringify(COTA_PREFERRED_QUALS),
        JSON.stringify(COTA_SCREENING_QUESTIONS),
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
        "administrative-assistant",
        "Administrative Assistant",
        "other",
        JSON.stringify(["full_time", "part_time"]),
        "onsite",
        "Las Vegas, NV",
        "Spectrum Squad is looking for an Administrative Assistant to be the friendly heartbeat of our clinic. You'll greet families, keep schedules humming, help with intake paperwork and authorizations, and keep our care team organized. If you love people, details, and making a place run smoothly, you'll fit right in.",
        "Be the heartbeat of the clinic • Friendly, supportive team • Room to grow • Mostly Mon–Fri schedule",
        1,
        "open",
        "normal",
        "hour",
        JSON.stringify(ADMIN_MIN_QUALS),
        JSON.stringify(ADMIN_PREFERRED_QUALS),
        JSON.stringify(ADMIN_SCREENING_QUESTIONS),
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

    console.log("HR & Recruiting seed complete (BCBA + RBT + BCaBA + COTA).");
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

  async function notify({ type, applicantId = null, positionId = null, title, body, severity = "info", targetRole = "owner", emailOwner = false }) {
    await dbRun(
      `INSERT INTO hr_notifications (type, applicant_id, position_id, title, body, severity, target_role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [type, applicantId, positionId, title, body, severity, targetRole, nowISO()]
    ).catch((e) => console.error("hr notify failed:", e.message));
    if (emailOwner) {
      const to = await ownerEmail();
      if (to) {
        sendEmail({
          to,
          subject: `[Spectrum Squad HR] ${title}`,
          html: `<p>${escapeHtml(body || title)}</p>${applicantId ? `<p><a href="${APP_BASE_URL}/#/hr/candidate/${applicantId}">Open candidate in the CRM</a></p>` : ""}`,
          type: "hr_notification",
        }).catch((e) => console.error("notify email failed:", e.message));
      }
    }
  }

  async function getSetting(key, def) {
    const r = await dbGet("SELECT value FROM hr_settings WHERE key = ?", [key]);
    return r && r.value != null ? r.value : def;
  }
  async function setSetting(key, value) {
    await dbRun(
      "INSERT INTO hr_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at",
      [key, String(value), nowISO()]
    );
  }

  async function ownerEmail() {
    // A configurable recipient wins, so notifications never get stuck on a dead
    // mailbox (the seeded admin@ account hard-bounced).
    const configured = await getSetting("owner_notification_email", "");
    if (configured) return configured;
    // Prefer a real owner mailbox over the seeded admin@ account.
    const real = await dbGet("SELECT email FROM users WHERE role = 'owner' AND email <> 'admin@spectrumsquadlv.com' ORDER BY id LIMIT 1");
    if (real && real.email) return real.email;
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

    const smsConsent = input.consent_sms === true || input.consent_sms === "true";
    const row = await dbRun(
      `INSERT INTO hr_applicants
        (position_id, full_name, email, phone, city, state, source, source_id, applied_at,
         stage, match_category, priority_flag, cover_letter, screening_answers, credentials,
         availability, preferred_schedule, comp_expectation, earliest_start, work_setting,
         consent_email, consent_sms, preferred_name, address, desired_pay, certifications,
         education, employment_history, sms_consent_at, sms_consent_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        input.comp_expectation || input.desired_pay || null,
        input.earliest_start || null,
        input.work_setting || null,
        input.consent_email === true || input.consent_email === "true",
        smsConsent,
        input.preferred_name || null,
        input.address || null,
        input.desired_pay || null,
        input.certifications || null,
        input.education || null,
        input.employment_history || null,
        // Record WHEN consent was given and WHICH disclosure the applicant saw,
        // only when they actually opted in.
        smsConsent ? (input.sms_consent_at || now) : null,
        smsConsent ? (input.sms_consent_version || null) : null,
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

  // Texting is gone. Past texts on a candidate's timeline are NOT: the message
  // rows stay in hr_applicant_messages with channel='sms' and still render in
  // the thread, because a conversation that happened is part of that
  // candidate's record. Nothing new is ever written there.

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ============================ DOCUMENT TRACKER ============================
  // Create a task in the EXISTING staff-task system (server.js staff_tasks),
  // so all HR auto-tasks live in one place per the spec.
  async function hrMakeStaffTask(title, employeeId) {
    await dbRun(
      `INSERT INTO staff_tasks (title, description, assigned_user_id, assigned_name, client_id, due_date, status, created_by, created_at)
       VALUES (?, ?, NULL, NULL, NULL, ?, 'open', 'HR auto', ?)`,
      [title, employeeId ? `Staff #${employeeId}` : null, nowISO().slice(0, 10), nowISO()]
    ).catch((e) => console.error("hr staff task insert failed:", e.message));
  }

  // Render an editable email template (from the email_templates table) with
  // {{merge}} fields. Keeps HR onboarding emails owner-editable.
  async function renderHrEmail(templateKey, fields) {
    const row = await dbGet("SELECT subject_template, body_template FROM email_templates WHERE template_key = ?", [templateKey]);
    if (!row) return null;
    const sub = (s) => String(s || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, k) => (fields[k] == null ? "" : String(fields[k])));
    return { subject: sub(row.subject_template), html: sub(row.body_template) };
  }

  // Append a {at, text} entry to an employee's activity log (hr_activity JSON).
  async function logEmpActivity(employeeId, text) {
    const emp = await dbGet("SELECT hr_activity FROM hr_employees WHERE id = ?", [employeeId]);
    let arr = [];
    try { arr = JSON.parse(emp && emp.hr_activity ? emp.hr_activity : "[]"); } catch (e) { arr = []; }
    arr.unshift({ at: nowISO(), text });
    await dbRun("UPDATE hr_employees SET hr_activity = ? WHERE id = ?", [JSON.stringify(arr.slice(0, 200)), employeeId]);
  }

  // A candidate who accepts an offer becomes a staff record, because that is
  // where onboarding, documents and certifications live. Matches an existing
  // record first (by applicant id, then by email) so accepting an offer for
  // someone who already works here -- a rehire, or a record created by hand
  // ahead of time -- updates that person instead of creating a duplicate.
  async function ensureEmployeeForApplicant(applicant, offer) {
    if (!applicant) return null;
    let emp = await dbGet("SELECT * FROM hr_employees WHERE applicant_id = ?", [applicant.id]);
    if (!emp && applicant.email) {
      emp = await dbGet("SELECT * FROM hr_employees WHERE LOWER(email) = LOWER(?)", [applicant.email]);
    }
    const startDate = (offer && offer.start_date) || null;
    if (emp) {
      await dbRun(
        `UPDATE hr_employees SET applicant_id = COALESCE(applicant_id, ?), hr_stage = 'Offer Accepted',
           hr_offer_accepted_date = COALESCE(hr_offer_accepted_date, ?),
           hr_hire_date = COALESCE(hr_hire_date, ?),
           role_title = COALESCE(role_title, ?), email = COALESCE(email, ?)
         WHERE id = ?`,
        [applicant.id, nowISO().slice(0, 10), startDate, (offer && offer.job_title) || null, applicant.email || null, emp.id]
      );
      return await dbGet("SELECT * FROM hr_employees WHERE id = ?", [emp.id]);
    }
    const row = await dbRun(
      `INSERT INTO hr_employees (applicant_id, name, email, phone, role_title, employment_type,
         hire_date, hr_stage, hr_offer_accepted_date, hr_hire_date, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Offer Accepted', ?, ?, 'onboarding', ?) RETURNING id`,
      [applicant.id, applicant.full_name, applicant.email || null, applicant.phone || null,
       (offer && offer.job_title) || null, (offer && offer.employment_type) || null,
       startDate, nowISO().slice(0, 10), startDate, nowISO()]
    );
    const id = row.rows[0].id;
    await audit("system", "employee_created_from_offer", "employee", id, applicant.full_name).catch(() => {});
    return await dbGet("SELECT * FROM hr_employees WHERE id = ?", [id]);
  }

  async function getOrCreateAvailLink(employeeId) {
    const existing = await dbGet("SELECT token FROM hr_avail_links WHERE employee_id = ? ORDER BY id DESC LIMIT 1", [employeeId]);
    if (existing) return existing.token;
    const token = crypto.randomBytes(20).toString("hex");
    await dbRun("INSERT INTO hr_avail_links (employee_id, token, created_at) VALUES (?, ?, ?)", [employeeId, token, nowISO()]);
    return token;
  }

  // Return the 6 tracker rows for an employee, filling defaults for any missing.
  async function getDocTracker(employeeId) {
    const existing = await dbAll("SELECT * FROM hr_doc_tracker WHERE employee_id = ?", [employeeId]);
    const byKey = {};
    existing.forEach((r) => (byKey[r.doc_key] = r));
    return HR_DOC_KEYS.map((d) => {
      const r = byKey[d.key] || {};
      return {
        doc_key: d.key, label: d.label, file_allowed: d.file, expires: !!d.expires,
        status: r.status || "Not Requested",
        date_requested: r.date_requested || null,
        date_received: r.date_received || null,
        expiration_date: r.expiration_date || null,
        notes: r.notes || null,
        has_file: !!r.stored_name,
        doc_id: r.id || null,
      };
    });
  }

  async function upsertDocTracker(employeeId, docKey, patch, file) {
    const def = HR_DOC_KEYS.find((d) => d.key === docKey);
    if (!def) return { ok: false, error: "Unknown document type" };
    let stored = null, filename = null, mime = null;
    if (file && file.content_base64) {
      if (!def.file) return { ok: false, error: "This document is tracked by status only — no file is stored." };
      let buf;
      try { buf = Buffer.from(file.content_base64, "base64"); } catch (e) { return { ok: false, error: "Invalid file data" }; }
      if (buf.length > 15 * 1024 * 1024) return { ok: false, error: "File too large (15MB max)" };
      stored = `${employeeId}_${docKey}_${crypto.randomBytes(5).toString("hex")}`;
      fs.writeFileSync(path.join(HR_DOC_DIR, stored), buf);
      filename = file.filename || docKey;
      mime = file.mime_type || "application/octet-stream";
    }
    const row = await dbGet("SELECT * FROM hr_doc_tracker WHERE employee_id = ? AND doc_key = ?", [employeeId, docKey]);
    const fields = {
      status: patch.status != null ? patch.status : (row ? row.status : "Not Requested"),
      date_requested: patch.date_requested !== undefined ? patch.date_requested : (row ? row.date_requested : null),
      date_received: patch.date_received !== undefined ? patch.date_received : (row ? row.date_received : null),
      expiration_date: patch.expiration_date !== undefined ? patch.expiration_date : (row ? row.expiration_date : null),
      notes: patch.notes !== undefined ? patch.notes : (row ? row.notes : null),
    };
    if (stored) { /* new file overrides */ }
    if (row) {
      await dbRun(
        `UPDATE hr_doc_tracker SET status=?, date_requested=?, date_received=?, expiration_date=?, notes=?,
           ${stored ? "stored_name=?, filename=?, mime_type=?," : ""} updated_at=? WHERE id=?`,
        stored
          ? [fields.status, fields.date_requested, fields.date_received, fields.expiration_date, fields.notes, stored, filename, mime, nowISO(), row.id]
          : [fields.status, fields.date_requested, fields.date_received, fields.expiration_date, fields.notes, nowISO(), row.id]
      );
    } else {
      await dbRun(
        `INSERT INTO hr_doc_tracker (employee_id, doc_key, status, date_requested, date_received, expiration_date, notes, stored_name, filename, mime_type, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [employeeId, docKey, fields.status, fields.date_requested, fields.date_received, fields.expiration_date, fields.notes, stored, filename, mime, nowISO()]
      );
    }
    return { ok: true };
  }

  async function countDocsOutstanding() {
    // Outstanding = not yet Received/Verified across the six required docs for all active staff.
    const emps = await dbAll("SELECT id FROM hr_employees WHERE status IS NULL OR status <> 'terminated'");
    let n = 0;
    for (const e of emps) {
      const rows = await dbAll("SELECT doc_key, status FROM hr_doc_tracker WHERE employee_id = ?", [e.id]);
      const byKey = {}; rows.forEach((r) => (byKey[r.doc_key] = r.status));
      for (const d of HR_DOC_KEYS) {
        const st = byKey[d.key] || "Not Requested";
        if (st !== "Received" && st !== "Verified") n++;
      }
    }
    return n;
  }

  // Sweep: 3-day follow-up tasks for still-Requested docs; 60-day RBT renewal
  // tasks + auto-Expire. Uses the existing staff-task system.
  async function processHrDocFollowups() {
    const now = Date.now();
    const rows = await dbAll(
      `SELECT dt.*, e.name AS emp_name FROM hr_doc_tracker dt JOIN hr_employees e ON e.id = dt.employee_id`
    );
    let made = 0;
    for (const r of rows) {
      const def = HR_DOC_KEYS.find((d) => d.key === r.doc_key);
      const label = def ? def.label : r.doc_key;
      // 3-day follow-up on Requested
      if (r.status === "Requested" && r.date_requested && !r.followup_task_made) {
        if (now - new Date(r.date_requested).getTime() > 3 * 86400000) {
          await hrMakeStaffTask(`Follow up: ${r.emp_name} — ${label}`, r.employee_id);
          await dbRun("UPDATE hr_doc_tracker SET followup_task_made = ? WHERE id = ?", [nowISO(), r.id]);
          made++;
        }
      }
      // 60-day RBT license renewal + auto-expire
      if (def && def.expires && r.expiration_date) {
        const exp = new Date(r.expiration_date).getTime();
        const days = Math.floor((exp - now) / 86400000);
        if (days < 0 && r.status !== "Expired") {
          await dbRun("UPDATE hr_doc_tracker SET status = 'Expired' WHERE id = ?", [r.id]);
        } else if (days <= 60 && days >= 0 && !r.renewal_task_made) {
          await hrMakeStaffTask(`Renewal due: ${r.emp_name} — ${label}`, r.employee_id);
          await dbRun("UPDATE hr_doc_tracker SET renewal_task_made = ? WHERE id = ?", [nowISO(), r.id]);
          made++;
        }
      }
    }
    return made;
  }

  // 30/60/90-day onboarding milestone emails, keyed off hr_hire_date. Skips
  // anyone marked Inactive. Each milestone is sent at most once (tracked in
  // hr_milestones_sent JSON) and logged to the employee activity feed.
  async function processHrMilestones() {
    const now = Date.now();
    const rows = await dbAll(
      "SELECT id, name, email, hr_hire_date, hr_stage, status, hr_milestones_sent FROM hr_employees WHERE hr_hire_date IS NOT NULL AND hr_hire_date <> ''"
    );
    let sent = 0;
    for (const e of rows) {
      if ((e.status || "").toLowerCase() === "terminated") continue;
      if ((e.hr_stage || "") === "Inactive") continue;
      if (!e.email) continue;
      const hireMs = new Date(e.hr_hire_date).getTime();
      if (isNaN(hireMs)) continue;
      const daysSince = Math.floor((now - hireMs) / 86400000);
      let doneMap = {};
      try { doneMap = e.hr_milestones_sent ? JSON.parse(e.hr_milestones_sent) : {}; } catch (x) { doneMap = {}; }
      for (const m of [30, 60, 90]) {
        if (daysSince >= m && !doneMap[m]) {
          const t = await renderHrEmail(`hr_milestone_${m}`, { first_name: firstNameOf(e.name), milestone_days: String(m) });
          if (t) {
            await sendEmail({ to: e.email, subject: t.subject, html: t.html, type: "hr_milestone" }).catch((err) => console.error("milestone email:", err.message));
            doneMap[m] = nowISO();
            await dbRun("UPDATE hr_employees SET hr_milestones_sent = ? WHERE id = ?", [JSON.stringify(doneMap), e.id]);
            await logEmpActivity(e.id, `Sent ${m}-day milestone check-in email.`);
            sent++;
          }
        }
      }
    }
    return sent;
  }

  // Count milestone emails sent in the last 7 days (for the dashboard tile).
  async function milestonesThisWeek() {
    const rows = await dbAll("SELECT hr_milestones_sent FROM hr_employees WHERE hr_milestones_sent IS NOT NULL AND hr_milestones_sent <> ''");
    const cutoff = Date.now() - 7 * 86400000;
    let n = 0;
    for (const r of rows) {
      let m = {};
      try { m = JSON.parse(r.hr_milestones_sent); } catch (x) { continue; }
      for (const k of Object.keys(m)) { if (m[k] && new Date(m[k]).getTime() >= cutoff) n++; }
    }
    return n;
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

      // Inbound recruiting email (provider webhook). Secret-gated because it is
      // public. Point Resend Inbound / SendGrid Inbound Parse / Mailgun here
      // with the normalized payload { from, to, subject, text, html, attachments }.
      if (pathname === "/api/hr/inbound" && method === "POST") {
        const secret = process.env.HR_INBOUND_SECRET || process.env.WEBHOOK_SECRET;
        const provided = query.secret || req.headers["x-webhook-secret"];
        if (!secret || provided !== secret) return json(res, 401, { error: "Unauthorized" });
        const payload = await readBody(req);
        const r = await handleInbound(payload);
        return json(res, r.ok ? 200 : 400, r);
      }

      // Public self-service scheduling (tokenized; no session).
      if (pathname === "/api/hr/public/schedule" && method === "GET") {
        const link = await dbGet("SELECT * FROM hr_schedule_links WHERE token = ?", [query.token || ""]);
        if (!link) return json(res, 404, { error: "This scheduling link is invalid or expired." });
        const applicant = await dbGet("SELECT * FROM hr_applicants WHERE id = ?", [link.applicant_id]);
        if (!applicant) return json(res, 404, { error: "Not found" });
        const position = applicant.position_id ? await dbGet("SELECT title FROM hr_positions WHERE id = ?", [applicant.position_id]) : null;
        const current = await dbGet("SELECT * FROM hr_interviews WHERE applicant_id = ? AND status = 'scheduled' ORDER BY id DESC LIMIT 1", [applicant.id]);
        // Open, future slots matching the position (or unassigned). Only public-safe fields.
        const slots = await dbAll(
          `SELECT id, start_at, duration_min, mode FROM hr_interview_slots
             WHERE status = 'open' AND start_at > ? AND (position_id IS NULL OR position_id = ?)
             ORDER BY start_at LIMIT 60`,
          [nowISO(), applicant.position_id || -1]
        );
        return json(res, 200, {
          first_name: firstNameOf(applicant.full_name),
          position_title: position ? position.title : null,
          current: current
            ? { scheduled_at: current.scheduled_at, duration_min: current.duration_min, mode: current.mode, location_or_link: current.location_or_link }
            : null,
          slots,
        });
      }

      if (pathname === "/api/hr/public/book" && method === "POST") {
        const b = await readBody(req);
        if (!b.token || !b.slot_id) return json(res, 400, { error: "token and slot_id are required" });
        const r = await bookSlot(b.token, Number(b.slot_id));
        return json(res, r.ok ? 200 : 409, r);
      }

      if (pathname === "/api/hr/public/cancel" && method === "POST") {
        const b = await readBody(req);
        if (!b.token) return json(res, 400, { error: "token is required" });
        const r = await cancelByToken(b.token);
        return json(res, r.ok ? 200 : 400, r);
      }

      // Public timecard verification (employee view; tokenized).
      if (pathname === "/api/hr/public/timecard" && method === "GET") {
        const link = await dbGet("SELECT * FROM hr_timecard_links WHERE token = ?", [query.token || ""]);
        if (!link) return json(res, 404, { error: "This verification link is invalid or expired." });
        const tc = await dbGet("SELECT * FROM hr_timecards WHERE id = ?", [link.timecard_id]);
        if (!tc) return json(res, 404, { error: "Not found" });
        const emp = tc.employee_id ? await dbGet("SELECT name, role_title FROM hr_employees WHERE id = ?", [tc.employee_id]) : null;
        const flags = await dbAll("SELECT id, flag_type, detail, status, employee_explanation FROM hr_timecard_flags WHERE timecard_id = ? ORDER BY id", [link.timecard_id]);
        const entries = parseJson(tc.entries, []);
        const t = timecardTotals(entries);
        return json(res, 200, {
          employee_name: emp ? emp.name : "",
          role: emp ? emp.role_title || "" : "",
          pay_period: { start: tc.pay_period_start, end: tc.pay_period_end },
          entries,
          flags,
          total_hours: t.total_hours,
          has_split: t.has_split,
          billable_hours: t.billable_hours,
          non_billable_hours: t.non_billable_hours,
          unclassified_hours: t.unclassified_hours,
          status: tc.status,
          accepted_at: tc.accepted_at || null,
          signed_name: tc.signed_name || null,
        });
      }
      // Employee ACCEPTS their timecard as-is: records a typed signature, saves a
      // signed PDF to their employee card, and notifies the office. Never writes payroll.
      if (pathname === "/api/hr/public/timecard/accept" && method === "POST") {
        const b = await readBody(req);
        const link = await dbGet("SELECT * FROM hr_timecard_links WHERE token = ?", [b.token || ""]);
        if (!link) return json(res, 404, { error: "This link is invalid or expired." });
        const tc = await dbGet("SELECT * FROM hr_timecards WHERE id = ?", [link.timecard_id]);
        if (!tc) return json(res, 404, { error: "Not found" });
        const signed = (b.signed_name || "").trim();
        if (!signed) return json(res, 400, { error: "Please type your name to sign." });
        await dbRun(
          "UPDATE hr_timecards SET status = 'accepted', accepted_at = ?, signed_name = ? WHERE id = ?",
          [nowISO(), signed, tc.id]
        );
        let pdfDocId = null;
        try {
          pdfDocId = await saveTimecardPdf(tc, signed);
        } catch (e) {
          console.error("timecard PDF save failed:", e.message);
        }
        await notify({
          type: "timecard_accepted",
          title: "✅ Timecard accepted",
          body: `${await employeeName(tc.employee_id)} accepted and signed their timecard for ${tc.pay_period_start} → ${tc.pay_period_end} (signed: ${signed}).`,
          severity: "info",
          emailOwner: true,
        });
        await audit("employee", "timecard_accepted", "timecard", tc.id, `signed=${signed}${pdfDocId ? " pdf=" + pdfDocId : ""}`);
        return json(res, 200, { ok: true, pdf_saved: !!pdfDocId });
      }
      // Employee requests EDITS: stores their adjusted hours + note for supervisor
      // review. Never writes payroll or the imported entries.
      if (pathname === "/api/hr/public/timecard/edit" && method === "POST") {
        const b = await readBody(req);
        const link = await dbGet("SELECT * FROM hr_timecard_links WHERE token = ?", [b.token || ""]);
        if (!link) return json(res, 404, { error: "This link is invalid or expired." });
        const tc = await dbGet("SELECT * FROM hr_timecards WHERE id = ?", [link.timecard_id]);
        if (!tc) return json(res, 404, { error: "Not found" });
        const edited = Array.isArray(b.edited) ? b.edited : [];
        await dbRun(
          "UPDATE hr_timecards SET status = 'edit_requested', employee_note = ?, edited_entries = ? WHERE id = ?",
          [(b.note || "").trim(), JSON.stringify(edited), tc.id]
        );
        await notify({
          type: "timecard_edit_requested",
          title: "✏️ Timecard rejected — changes requested",
          body: `${await employeeName(tc.employee_id)} did NOT accept their timecard for ${tc.pay_period_start} → ${tc.pay_period_end} and requested changes${(b.note || "").trim() ? ` — "${(b.note || "").trim().slice(0, 200)}"` : ""}. Review in HR › Timecards.`,
          severity: "warning",
          emailOwner: true,
        });
        await audit("employee", "timecard_edit_requested", "timecard", tc.id, (b.note || "").slice(0, 120));
        return json(res, 200, { ok: true });
      }
      if (pathname === "/api/hr/public/timecard/explain" && method === "POST") {
        const b = await readBody(req);
        const link = await dbGet("SELECT * FROM hr_timecard_links WHERE token = ?", [b.token || ""]);
        if (!link) return json(res, 404, { error: "Invalid link" });
        const flag = await dbGet("SELECT * FROM hr_timecard_flags WHERE id = ? AND timecard_id = ?", [b.flag_id, link.timecard_id]);
        if (!flag) return json(res, 404, { error: "Flag not found" });
        await dbRun("UPDATE hr_timecard_flags SET employee_explanation = ?, status = 'explained' WHERE id = ?", [b.explanation || "", flag.id]);
        await audit("employee", "timecard_explained", "timecard", link.timecard_id, `flag=${flag.id}`);
        // Notify a supervisor/owner that a correction needs review.
        const explTc = await dbGet("SELECT employee_id FROM hr_timecards WHERE id = ?", [link.timecard_id]).catch(() => null);
        const explWho = explTc ? await employeeName(explTc.employee_id) : "An employee";
        await notify({ type: "timecard_correction", title: "Timecard correction submitted", body: `${explWho} explained a ${flag.flag_type.replace(/_/g, " ")} flag on their timecard and it needs supervisor review.`, severity: "info", emailOwner: true });
        return json(res, 200, { ok: true });
      }

      // Public interactive offer (candidate view; tokenized).
      if (pathname === "/api/hr/public/offer" && method === "GET") {
        const o = await dbGet("SELECT * FROM hr_offers WHERE token = ?", [query.token || ""]);
        if (!o || !["sent", "accepted", "declined"].includes(o.status)) return json(res, 404, { error: "This offer link is invalid or not yet available." });
        const applicant = await dbGet("SELECT * FROM hr_applicants WHERE id = ?", [o.applicant_id]);
        const position = o.position_id ? await dbGet("SELECT * FROM hr_positions WHERE id = ?", [o.position_id]) : null;
        return json(res, 200, shapeOfferPublic(o, applicant, position));
      }
      if (pathname === "/api/hr/public/offer/accept" && method === "POST") {
        const b = await readBody(req);
        const o = await dbGet("SELECT * FROM hr_offers WHERE token = ?", [b.token || ""]);
        if (!o) return json(res, 404, { error: "Invalid offer" });
        if (o.status === "accepted") return json(res, 200, { ok: true, already: true });
        if (o.status !== "sent") return json(res, 409, { error: "This offer can no longer be accepted." });
        if (offerIsExpired(o)) return json(res, 409, { error: "This offer has expired — please reach out to us." });
        if (!b.signed_name || !b.signed_name.trim()) return json(res, 400, { error: "Please type your name to sign." });
        const now = nowISO();
        await dbRun("UPDATE hr_offers SET status = 'accepted', signed_name = ?, signed_at = ?, updated_at = ? WHERE id = ?", [b.signed_name.trim(), now, now, o.id]);
        const applicant = await dbGet("SELECT * FROM hr_applicants WHERE id = ?", [o.applicant_id]);
        onCompletion("offer_accepted", {
          subject: applicant ? applicant.full_name : (b.signed_name || "").trim(),
          detail: o.job_title ? `for ${o.job_title}` : null,
          dedupeKey: `offer:${o.id}`,
          link: `${APP_BASE_URL}/#/hr`,
        });
        if (applicant) {
          await moveStageInternal(applicant, "hired", "candidate", "Accepted offer");
          await dbRun("UPDATE hr_applicants SET offer_status = 'accepted', final_decision = 'hired', automation_paused = TRUE, updated_at = ? WHERE id = ?", [now, applicant.id]);
          await cancelPendingFollowups(applicant.id);
          await notify({
            type: "offer_accepted",
            applicantId: applicant.id,
            positionId: applicant.position_id,
            title: "🎉 Offer accepted!",
            body: `${applicant.full_name} accepted the offer for ${o.job_title || "the role"}. Welcome to the team!`,
            severity: "urgent",
            emailOwner: true,
          });
        }
        // The candidate has said yes, so they are a hire. Make sure a staff
        // record exists for them (the Staff directory is where onboarding
        // lives) and send the new-hire employment packet through SignNow.
        //
        // This runs on the candidate's own click, so it must never be able to
        // fail their acceptance -- every step is caught and logged, and the
        // packet sender itself is keyed on employee id so a second acceptance,
        // or the staff-card path below, cannot send a duplicate.
        try {
          const employee = await ensureEmployeeForApplicant(applicant, o);
          if (employee) {
            // The document portal has to exist before the welcome email can
            // link to it, so it is created first.
            const record = await startOnboarding(employee, "offer accepted (candidate)").catch(() => null);
            if (record) {
              await sendWelcomeDocumentsEmail(employee, record)
                .then((r) => logEmpActivity(employee.id, r.ok
                  ? `Welcome + required documents email sent (${r.template}).`
                  : `Welcome + documents email NOT sent: ${r.reason}`))
                .catch((e) => console.error("welcome documents email failed:", e.message));
            }
            const packet = await sendNewHirePacket(employee, { actor: "offer accepted (candidate)" });
            await logEmpActivity(
              employee.id,
              packet.ok
                ? (packet.already ? "Offer accepted — new-hire packet had already been sent." : "Offer accepted — new-hire employment packet sent via SignNow.")
                : `Offer accepted — new-hire packet NOT sent: ${packet.error}`
            ).catch(() => {});
            if (!packet.ok) {
              await notify({
                type: "newhire_packet_failed",
                applicantId: applicant ? applicant.id : null,
                title: "⚠ New-hire packet did not send",
                body: `${employee.name} accepted their offer, but the employment packet could not be sent: ${packet.error}`,
                severity: "urgent",
                emailOwner: true,
              }).catch(() => {});
            }
          }
        } catch (e) {
          console.error("New-hire packet automation failed after offer acceptance:", e.message);
        }

        await audit("candidate", "offer_accepted", "applicant", o.applicant_id, `signed=${b.signed_name.trim()}`);
        return json(res, 200, { ok: true });
      }
      if (pathname === "/api/hr/public/offer/decline" && method === "POST") {
        const b = await readBody(req);
        const o = await dbGet("SELECT * FROM hr_offers WHERE token = ?", [b.token || ""]);
        if (!o) return json(res, 404, { error: "Invalid offer" });
        if (o.status !== "sent") return json(res, 409, { error: "This offer is no longer active." });
        await dbRun("UPDATE hr_offers SET status = 'declined', decline_reason = ?, updated_at = ? WHERE id = ?", [b.reason || null, nowISO(), o.id]);
        const applicant = await dbGet("SELECT * FROM hr_applicants WHERE id = ?", [o.applicant_id]);
        if (applicant) {
          await dbRun("UPDATE hr_applicants SET offer_status = 'declined', updated_at = ? WHERE id = ?", [nowISO(), applicant.id]);
          await notify({ type: "offer_declined", applicantId: applicant.id, positionId: applicant.position_id, title: "Offer declined", body: `${applicant.full_name} declined the offer${b.reason ? ": " + b.reason : "."}`, severity: "warning", emailOwner: true });
        }
        await audit("candidate", "offer_declined", "applicant", o.applicant_id, b.reason || "");
        return json(res, 200, { ok: true });
      }

      // -------- PUBLIC: new-hire availability form --------
      if (pathname === "/api/hr/public/staff-availability" && method === "GET") {
        const link = await dbGet("SELECT * FROM hr_avail_links WHERE token = ?", [query.token || ""]);
        if (!link) return json(res, 404, { error: "This link is invalid or has expired." });
        const emp = await dbGet("SELECT id, name, hr_availability, hr_stipulations FROM hr_employees WHERE id = ?", [link.employee_id]);
        if (!emp) return json(res, 404, { error: "Not found" });
        return json(res, 200, {
          name: emp.name,
          availability: parseJson(emp.hr_availability, null),
          stipulations: parseJson(emp.hr_stipulations, null),
        });
      }
      if (pathname === "/api/hr/public/staff-availability" && method === "POST") {
        const b = await readBody(req);
        const link = await dbGet("SELECT * FROM hr_avail_links WHERE token = ?", [b.token || ""]);
        if (!link) return json(res, 404, { error: "This link is invalid or has expired." });
        await dbRun("UPDATE hr_employees SET hr_availability = ?, hr_stipulations = ? WHERE id = ?", [
          JSON.stringify(b.availability || {}), JSON.stringify(b.stipulations || {}), link.employee_id,
        ]);
        // Mark any open "availability/scheduling" staff task for this employee complete.
        await dbRun(
          "UPDATE staff_tasks SET status = 'done', completed_at = ? WHERE status = 'open' AND (title ILIKE '%availability%' OR title ILIKE '%scheduling%') AND description = ?",
          [nowISO(), `Staff #${link.employee_id}`]
        ).catch(() => {});
        await logEmpActivity(link.employee_id, "Submitted availability / scheduling form.");
        await notify({ type: "staff_availability", title: "Availability submitted", body: "A new hire submitted their availability form.", severity: "info", emailOwner: false }).catch(() => {});
        return json(res, 200, { ok: true });
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
          // canDelete is owner-only: destructive timecard removal is restricted
          // to the owner account, even though managers can import/send them.
          caps: { canManage, canSensitive, canDelete: user.role === "owner" },
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
          preferred_name: a.preferred_name,
          email: a.email,
          phone: a.phone,
          address: a.address,
          city: a.city,
          state: a.state,
          source: a.source,
          applied_at: a.applied_at,
          stage: a.stage,
          match_category: a.match_category,
          priority_flag: a.priority_flag,
          // Expanded application fields (Phase 6a). desired_pay is compensation,
          // so it rides with the sensitive tier below alongside comp_expectation.
          certifications: a.certifications,
          education: a.education,
          employment_history: a.employment_history,
          // Kept as a record of a consent that was given, not as a capability:
          // nothing can send a text any more.
          sms_consent: a.consent_sms,
          sms_consent_at: a.sms_consent_at,
          sms_consent_version: a.sms_consent_version,
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

        // Sensitive fields: comp expectation, desired pay, private notes, ratings, offers.
        if (canSensitive) {
          profile.comp_expectation = a.comp_expectation;
          profile.desired_pay = a.desired_pay;
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
        if (b.stage === "offer_approval") {
          await notify({
            type: "offer_approval",
            applicantId: a.id,
            positionId: a.position_id,
            title: "Offer requires approval",
            body: `${a.full_name} has reached Offer Approval and needs your sign-off.`,
            severity: "urgent",
            emailOwner: true,
          });
        }
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
      if (pathname === "/api/hr/notifications/read-all" && method === "POST") {
        await dbRun("UPDATE hr_notifications SET read = TRUE WHERE read = FALSE", []);
        return json(res, 200, { ok: true });
      }

      // ---- settings + daily summary ----
      if (pathname === "/api/hr/settings" && method === "GET") {
        return json(res, 200, {
          daily_summary_enabled: (await getSetting("daily_summary_enabled", "true")) === "true",
          daily_summary_hour: parseInt(await getSetting("daily_summary_hour", "13"), 10),
        });
      }
      if (pathname === "/api/hr/settings" && method === "PUT") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        if (b.daily_summary_enabled !== undefined) await setSetting("daily_summary_enabled", b.daily_summary_enabled ? "true" : "false");
        if (b.daily_summary_hour !== undefined) {
          const h = Math.max(0, Math.min(23, parseInt(b.daily_summary_hour, 10) || 0));
          await setSetting("daily_summary_hour", h);
        }
        await audit(actor, "settings_updated", null, null, "daily_summary");
        return json(res, 200, { ok: true });
      }
      if (pathname === "/api/hr/admin/send-summary" && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const r = await processDailySummary(true);
        return json(res, 200, r);
      }

      // ---- interview scheduling (admin) ----
      if (pathname === "/api/hr/slots" && method === "GET") {
        const rows = await dbAll(
          `SELECT s.*, p.title AS position_title, a.full_name AS applicant_name
             FROM hr_interview_slots s
             LEFT JOIN hr_positions p ON p.id = s.position_id
             LEFT JOIN hr_applicants a ON a.id = s.applicant_id
             WHERE s.status <> 'canceled' AND s.start_at > ?
             ORDER BY s.start_at`,
          [nowISO()]
        );
        return json(res, 200, rows);
      }
      if (pathname === "/api/hr/slots" && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        if (!b.start_at) return json(res, 400, { error: "start_at is required" });
        const row = await dbRun(
          `INSERT INTO hr_interview_slots (position_id, start_at, duration_min, mode, location_or_link, interviewer, status, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?) RETURNING id`,
          [b.position_id || null, b.start_at, Number(b.duration_min) || 30, b.mode === "in_person" ? "in_person" : "virtual", b.location_or_link || null, b.interviewer || null, actor, nowISO()]
        );
        await audit(actor, "slot_created", "slot", row.rows[0].id, `at=${b.start_at}`);
        return json(res, 201, { ok: true, id: row.rows[0].id });
      }
      const slotCancelMatch = pathname.match(/^\/api\/hr\/slots\/(\d+)\/cancel$/);
      if (slotCancelMatch && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const slot = await dbGet("SELECT * FROM hr_interview_slots WHERE id = ?", [slotCancelMatch[1]]);
        if (!slot) return json(res, 404, { error: "Slot not found" });
        if (slot.status === "booked") return json(res, 409, { error: "Cancel the interview first; this slot is booked." });
        await dbRun("UPDATE hr_interview_slots SET status = 'canceled' WHERE id = ?", [slot.id]);
        await audit(actor, "slot_canceled", "slot", slot.id, "");
        return json(res, 200, { ok: true });
      }

      if (pathname === "/api/hr/interviews" && method === "GET") {
        const rows = await dbAll(
          `SELECT i.*, a.full_name AS applicant_name, p.title AS position_title
             FROM hr_interviews i
             LEFT JOIN hr_applicants a ON a.id = i.applicant_id
             LEFT JOIN hr_positions p ON p.id = a.position_id
             WHERE i.status IN ('scheduled','completed','no_show')
             ORDER BY i.scheduled_at DESC LIMIT 100`
        );
        return json(res, 200, rows);
      }
      const ivStatusMatch = pathname.match(/^\/api\/hr\/interviews\/(\d+)\/status$/);
      if (ivStatusMatch && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const iv = await dbGet("SELECT * FROM hr_interviews WHERE id = ?", [ivStatusMatch[1]]);
        if (!iv) return json(res, 404, { error: "Interview not found" });
        const b = await readBody(req);
        if (!["completed", "no_show", "canceled"].includes(b.status)) return json(res, 400, { error: "Invalid status" });
        await dbRun("UPDATE hr_interviews SET status = ?, updated_at = ? WHERE id = ?", [b.status, nowISO(), iv.id]);
        const applicant = await dbGet("SELECT * FROM hr_applicants WHERE id = ?", [iv.applicant_id]);
        if (applicant) {
          if (b.status === "completed") {
            await moveStageInternal(applicant, "interviewed", actor, "Interview completed");
          } else if (b.status === "canceled") {
            if (iv.slot_id) await dbRun("UPDATE hr_interview_slots SET status = 'open', applicant_id = NULL WHERE id = ?", [iv.slot_id]);
            await dbRun("UPDATE hr_applicants SET interview_at = NULL WHERE id = ?", [applicant.id]);
          } else if (b.status === "no_show") {
            await moveStageInternal(applicant, "responded", actor, "Interview no-show");
            await dbRun("UPDATE hr_applicants SET interview_at = NULL WHERE id = ?", [applicant.id]);
            // No-show follow-up: offer to reschedule.
            const token = await getOrCreateScheduleLink(applicant.id);
            await sendApplicantEmail(applicant,
              "Sorry we missed you — let's find another time",
              `<p>Hi ${escapeHtml(firstNameOf(applicant.full_name))},</p><p>We had you down for an interview but didn't connect — no worries, it happens! If you're still interested, you can grab a new time here: <a href="${APP_BASE_URL}/schedule/${token}">pick a time</a>.</p><p>Warmly,<br/>The Spectrum Squad Team</p>`,
              { sentBy: "assistant" }).catch(() => {});
            await notify({ type: "interview_no_show", applicantId: applicant.id, positionId: applicant.position_id, title: "Interview no-show", body: `${applicant.full_name} did not attend. A reschedule invite was sent.`, severity: "warning" });
          }
        }
        await audit(actor, "interview_status", "applicant", iv.applicant_id, b.status);
        return json(res, 200, { ok: true });
      }

      const schedLinkMatch = pathname.match(/^\/api\/hr\/applicants\/(\d+)\/schedule-link$/);
      if (schedLinkMatch && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const a = await dbGet("SELECT * FROM hr_applicants WHERE id = ?", [schedLinkMatch[1]]);
        if (!a) return json(res, 404, { error: "Applicant not found" });
        const token = await getOrCreateScheduleLink(a.id);
        const url = `${APP_BASE_URL}/schedule/${token}`;
        const b = await readBody(req);
        if (b.send && a.email) {
          await sendApplicantEmail(a,
            "Let's schedule your Spectrum Squad interview",
            `<p>Hi ${escapeHtml(firstNameOf(a.full_name))},</p><p>We'd love to talk! Please pick a time that works for you here: <a href="${url}">choose a time</a>.</p><p>Warmly,<br/>The Spectrum Squad Team</p>`,
            { sentBy: "assistant" });
          await audit(actor, "schedule_link_sent", "applicant", a.id, "");
        }
        return json(res, 200, { ok: true, url, sent: !!(b.send && a.email) });
      }

      // ---- recruiting inbox: needs-attention + recent messages ----
      if (pathname === "/api/hr/inbox" && method === "GET") {
        const needsAttention = await dbAll(
          `SELECT a.id, a.full_name, a.stage, a.last_response_at, a.automation_paused, p.title AS position_title
             FROM hr_applicants a LEFT JOIN hr_positions p ON p.id = a.position_id
             WHERE a.last_response_at IS NOT NULL AND a.stage NOT IN ('hired','not_selected','withdrawn')
             ORDER BY a.last_response_at DESC LIMIT 50`
        );
        const recent = await dbAll(
          `SELECT m.id, m.applicant_id, m.direction, m.subject, m.status, m.created_at, a.full_name
             FROM hr_applicant_messages m JOIN hr_applicants a ON a.id = m.applicant_id
             ORDER BY m.id DESC LIMIT 60`
        );
        return json(res, 200, { needs_attention: needsAttention, recent });
      }

      // ---- AI-drafted reply for a candidate (human approves & sends) ----
      const appDraftMatch = pathname.match(/^\/api\/hr\/applicants\/(\d+)\/draft-reply$/);
      if (appDraftMatch && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const a = await dbGet("SELECT * FROM hr_applicants WHERE id = ?", [appDraftMatch[1]]);
        if (!a) return json(res, 404, { error: "Applicant not found" });
        const draft = await draftReply(a);
        return json(res, 200, draft);
      }

      // ---- flexible intake: CSV / bulk import ----
      if (pathname === "/api/hr/import" && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        let candidates = Array.isArray(b.candidates) ? b.candidates : null;
        if (!candidates && b.csv) candidates = parseCsv(b.csv);
        if (!Array.isArray(candidates) || !candidates.length) {
          return json(res, 400, { error: "Provide a non-empty 'candidates' array or 'csv' text." });
        }
        let created = 0;
        let duplicates = 0;
        let skipped = 0;
        for (const c of candidates) {
          const name = c.full_name || c.name || c.email;
          if (!name && !c.email) { skipped++; continue; }
          const r = await createApplicant(
            {
              full_name: name, email: c.email, phone: c.phone, city: c.city, state: c.state,
              source: SOURCE_KEYS.includes(c.source) ? c.source : "other",
              position_id: c.position_id || b.position_id || null,
            },
            actor
          );
          created++;
          if (r.duplicateOf) duplicates++;
        }
        await audit(actor, "candidates_imported", null, null, `created=${created} dups=${duplicates} skipped=${skipped}`);
        return json(res, 201, { ok: true, created, duplicates, skipped });
      }

      // ---- run the follow-up processor on demand (also runs on an interval) ----
      if (pathname === "/api/hr/admin/run-followups" && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const r = await processFollowups();
        await audit(actor, "followups_run", null, null, `due=${r.due} sent=${r.sent} canceled=${r.canceled}`);
        return json(res, 200, r);
      }

      // ---- offers (owner-only; offers are sensitive) ----
      const offerListMatch = pathname.match(/^\/api\/hr\/applicants\/(\d+)\/offers$/);
      if (offerListMatch && method === "GET") {
        if (!canSensitive) return json(res, 403, { error: "Offers are visible to the owner only." });
        const rows = await dbAll("SELECT * FROM hr_offers WHERE applicant_id = ? ORDER BY id DESC", [offerListMatch[1]]);
        return json(res, 200, rows.map((o) => ({ ...o, highlights: parseJson(o.highlights, []), public_url: o.token ? `${APP_BASE_URL}/offer/${o.token}` : null, expired: offerIsExpired(o) })));
      }
      if (offerListMatch && method === "POST") {
        if (!canSensitive) return json(res, 403, { error: "Only the owner can create offers." });
        const a = await dbGet("SELECT * FROM hr_applicants WHERE id = ?", [offerListMatch[1]]);
        if (!a) return json(res, 404, { error: "Applicant not found" });
        const b = await readBody(req);
        const token = newToken();
        const now = nowISO();
        const row = await dbRun(
          `INSERT INTO hr_offers (applicant_id, position_id, job_title, employment_type, comp_amount, comp_unit, comp_notes,
             start_date, supervisor, location, highlights, custom_message, expires_at, status, token, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?) RETURNING id`,
          [a.id, a.position_id, b.job_title || null, b.employment_type || null, numOrNull(b.comp_amount), b.comp_unit || "year", b.comp_notes || null,
           b.start_date || null, b.supervisor || null, b.location || null, JSON.stringify(b.highlights || []), b.custom_message || null, b.expires_at || null, token, actor, now, now]
        );
        await audit(actor, "offer_created", "applicant", a.id, "");
        return json(res, 201, { ok: true, id: row.rows[0].id });
      }

      const offerIdMatch = pathname.match(/^\/api\/hr\/offers\/(\d+)$/);
      if (offerIdMatch && method === "GET") {
        if (!canSensitive) return json(res, 403, { error: "Not permitted" });
        const o = await dbGet("SELECT * FROM hr_offers WHERE id = ?", [offerIdMatch[1]]);
        if (!o) return json(res, 404, { error: "Not found" });
        return json(res, 200, { ...o, highlights: parseJson(o.highlights, []), public_url: `${APP_BASE_URL}/offer/${o.token}`, expired: offerIsExpired(o) });
      }
      if (offerIdMatch && method === "PUT") {
        if (!canSensitive) return json(res, 403, { error: "Not permitted" });
        const o = await dbGet("SELECT * FROM hr_offers WHERE id = ?", [offerIdMatch[1]]);
        if (!o) return json(res, 404, { error: "Not found" });
        if (["accepted", "declined"].includes(o.status)) return json(res, 409, { error: "This offer was already " + o.status + " and can't be changed." });
        const b = await readBody(req);
        await dbRun(
          `UPDATE hr_offers SET job_title = ?, employment_type = ?, comp_amount = ?, comp_unit = ?, comp_notes = ?,
             start_date = ?, supervisor = ?, location = ?, highlights = ?, custom_message = ?, expires_at = ?, updated_at = ? WHERE id = ?`,
          [
            b.job_title != null ? b.job_title : o.job_title,
            b.employment_type != null ? b.employment_type : o.employment_type,
            b.comp_amount !== undefined ? numOrNull(b.comp_amount) : o.comp_amount,
            b.comp_unit != null ? b.comp_unit : o.comp_unit,
            b.comp_notes !== undefined ? b.comp_notes : o.comp_notes,
            b.start_date !== undefined ? b.start_date : o.start_date,
            b.supervisor !== undefined ? b.supervisor : o.supervisor,
            b.location !== undefined ? b.location : o.location,
            JSON.stringify(b.highlights != null ? b.highlights : parseJson(o.highlights, [])),
            b.custom_message !== undefined ? b.custom_message : o.custom_message,
            b.expires_at !== undefined ? b.expires_at : o.expires_at,
            nowISO(), o.id,
          ]
        );
        await audit(actor, "offer_updated", "applicant", o.applicant_id, "");
        return json(res, 200, { ok: true });
      }

      const offerApproveMatch = pathname.match(/^\/api\/hr\/offers\/(\d+)\/approve$/);
      if (offerApproveMatch && method === "POST") {
        if (!canSensitive) return json(res, 403, { error: "Only the owner can approve offers." });
        const o = await dbGet("SELECT * FROM hr_offers WHERE id = ?", [offerApproveMatch[1]]);
        if (!o) return json(res, 404, { error: "Not found" });
        await dbRun("UPDATE hr_offers SET status = 'approved', approved_by = ?, updated_at = ? WHERE id = ?", [actor, nowISO(), o.id]);
        await audit(actor, "offer_approved", "applicant", o.applicant_id, "");
        return json(res, 200, { ok: true });
      }

      const offerSendMatch = pathname.match(/^\/api\/hr\/offers\/(\d+)\/send$/);
      if (offerSendMatch && method === "POST") {
        if (!canSensitive) return json(res, 403, { error: "Only the owner can send offers." });
        const o = await dbGet("SELECT * FROM hr_offers WHERE id = ?", [offerSendMatch[1]]);
        if (!o) return json(res, 404, { error: "Not found" });
        if (!["approved", "sent"].includes(o.status)) return json(res, 409, { error: "Approve the offer before sending it." });
        const a = await dbGet("SELECT * FROM hr_applicants WHERE id = ?", [o.applicant_id]);
        const now = nowISO();
        await dbRun("UPDATE hr_offers SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?", [now, now, o.id]);
        const url = `${APP_BASE_URL}/offer/${o.token}`;
        if (a) {
          await moveStageInternal(a, "offer_sent", actor, "Offer sent");
          await dbRun("UPDATE hr_applicants SET offer_status = 'sent', automation_paused = TRUE, updated_at = ? WHERE id = ?", [now, a.id]);
          await cancelPendingFollowups(a.id);
          if (a.email) {
            await sendApplicantEmail(a,
              `🎉 An offer from Spectrum Squad, ${firstNameOf(a.full_name)}!`,
              `<p>Hi ${escapeHtml(firstNameOf(a.full_name))},</p><p>We're thrilled to offer you a role on the Spectrum Squad team! We put together something special for you — <a href="${url}"><strong>open your offer here</strong></a> 🎁</p><p>We can't wait to hear from you!<br/>The Spectrum Squad Team</p>`,
              { sentBy: "assistant" });
          }
        }
        await audit(actor, "offer_sent", "applicant", o.applicant_id, "");
        return json(res, 200, { ok: true, url });
      }

      const offerWithdrawMatch = pathname.match(/^\/api\/hr\/offers\/(\d+)\/withdraw$/);
      if (offerWithdrawMatch && method === "POST") {
        if (!canSensitive) return json(res, 403, { error: "Only the owner can withdraw offers." });
        const o = await dbGet("SELECT * FROM hr_offers WHERE id = ?", [offerWithdrawMatch[1]]);
        if (!o) return json(res, 404, { error: "Not found" });
        if (["accepted", "declined"].includes(o.status)) return json(res, 409, { error: "This offer was already " + o.status + "." });
        await dbRun("UPDATE hr_offers SET status = 'draft', updated_at = ? WHERE id = ?", [nowISO(), o.id]);
        await dbRun("UPDATE hr_applicants SET offer_status = 'draft', updated_at = ? WHERE id = ?", [nowISO(), o.applicant_id]).catch(() => {});
        await audit(actor, "offer_withdrawn", "applicant", o.applicant_id, "");
        return json(res, 200, { ok: true });
      }

      // ---- employees (future HR) ----
      if (pathname === "/api/hr/employees" && method === "GET") {
        const rows = await dbAll("SELECT * FROM hr_employees ORDER BY name");
        for (const e of rows) {
          e.credentials = await dbAll("SELECT id, credential_type, credential_number, expiration_date, status FROM hr_employee_credentials WHERE employee_id = ? ORDER BY expiration_date", [e.id]);
        }
        return json(res, 200, rows);
      }
      if (pathname === "/api/hr/employees" && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        if (!b.name) return json(res, 400, { error: "Name is required" });
        // Optionally hydrate from a hired applicant.
        let email = b.email || null;
        if (b.applicant_id) {
          const a = await dbGet("SELECT full_name, email FROM hr_applicants WHERE id = ?", [b.applicant_id]);
          if (a && !email) email = a.email;
        }
        const row = await dbRun(
          `INSERT INTO hr_employees (user_id, applicant_id, name, email, role_title, employment_type, hire_date, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?) RETURNING id`,
          [b.user_id || null, b.applicant_id || null, b.name, email, b.role_title || null, b.employment_type || null, b.hire_date || null, nowISO()]
        );
        await audit(actor, "employee_created", "employee", row.rows[0].id, b.name);
        return json(res, 201, { ok: true, id: row.rows[0].id });
      }
      // Staff detail (with credentials + their timecards) for the Staff directory.
      const empDetailMatch = pathname.match(/^\/api\/hr\/employees\/(\d+)$/);
      if (empDetailMatch && method === "GET") {
        const emp = await dbGet("SELECT * FROM hr_employees WHERE id = ?", [empDetailMatch[1]]);
        if (!emp) return json(res, 404, { error: "Not found" });
        emp.credentials = await dbAll("SELECT id, credential_type, credential_number, expiration_date, status FROM hr_employee_credentials WHERE employee_id = ? ORDER BY expiration_date", [emp.id]);
        emp.timecards = await dbAll(
          `SELECT t.*, (SELECT COUNT(*) FROM hr_timecard_flags f WHERE f.timecard_id = t.id AND f.status IN ('open','explained')) AS open_flags
             FROM hr_timecards t WHERE t.employee_id = ? ORDER BY t.id DESC LIMIT 30`,
          [emp.id]
        );
        emp.documents = await getDocTracker(emp.id);
        return json(res, 200, emp);
      }
      if (empDetailMatch && method === "PATCH") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        const allowed = ["name", "email", "role_title", "employment_type", "hire_date", "phone", "address", "certifications", "status", "rethink_id",
          "hr_stage", "hr_hire_date", "hr_offer_accepted_date", "hr_availability", "hr_stipulations",
          "hr_pref_hours", "hr_pref_location", "hr_pref_language", "hr_pref_notes"];
        const fields = Object.keys(b).filter((k) => allowed.includes(k));
        if (!fields.length) return json(res, 400, { error: "Nothing to update" });
        await dbRun(`UPDATE hr_employees SET ${fields.map((f) => `${f} = ?`).join(", ")} WHERE id = ?`, [...fields.map((f) => b[f]), Number(empDetailMatch[1])]);
        await audit(actor, "employee_updated", "employee", Number(empDetailMatch[1]), fields.join(","));
        return json(res, 200, await dbGet("SELECT * FROM hr_employees WHERE id = ?", [empDetailMatch[1]]));
      }

      // Bulk edit staff: apply the same field(s) to many employees at once, or
      // bulk-delete. Body: { ids:[...], fields:{status, hr_stage, role_title,
      // employment_type}, delete:true }.
      if (pathname === "/api/hr/employees/bulk" && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        const ids = (Array.isArray(b.ids) ? b.ids : []).map((n) => Number(n)).filter((n) => n > 0);
        if (!ids.length) return json(res, 400, { error: "No staff selected." });
        const placeholders = ids.map(() => "?").join(",");
        if (b.delete) {
          await dbRun(`DELETE FROM hr_employees WHERE id IN (${placeholders})`, ids);
          await audit(actor, "employees_bulk_deleted", "employee", null, `ids=${ids.join(",")}`);
          return json(res, 200, { ok: true, deleted: ids.length });
        }
        const allowed = ["status", "hr_stage", "role_title", "employment_type", "hr_pref_location", "hr_pref_language"];
        const fields = Object.keys(b.fields || {}).filter((k) => allowed.includes(k) && b.fields[k] !== "" && b.fields[k] != null);
        if (!fields.length) return json(res, 400, { error: "Nothing to update." });
        const setClause = fields.map((f) => `${f} = ?`).join(", ");
        await dbRun(`UPDATE hr_employees SET ${setClause} WHERE id IN (${placeholders})`, [...fields.map((f) => b.fields[f]), ...ids]);
        await audit(actor, "employees_bulk_updated", "employee", null, `ids=${ids.join(",")} fields=${fields.join(",")}`);
        return json(res, 200, { ok: true, updated: ids.length });
      }

      // ---- Document tracker (six required docs; social/id are status-only) ----
      const docTrackMatch = pathname.match(/^\/api\/hr\/employees\/(\d+)\/doc-tracker$/);
      if (docTrackMatch && method === "GET") {
        return json(res, 200, await getDocTracker(Number(docTrackMatch[1])));
      }
      if (docTrackMatch && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const empId = Number(docTrackMatch[1]);
        const b = await readBody(req);
        if (!b.doc_key) return json(res, 400, { error: "doc_key is required" });
        // "Request" shortcut stamps date_requested + sets status Requested.
        if (b.action === "request") { b.status = "Requested"; b.date_requested = nowISO().slice(0, 10); }
        const file = b.content_base64 ? { content_base64: b.content_base64, filename: b.filename, mime_type: b.mime_type } : null;
        const r = await upsertDocTracker(empId, b.doc_key, b, file);
        if (!r.ok) return json(res, 400, r);
        // Uploading the headshot auto-populates the profile photo.
        if (b.doc_key === "headshot" && file) {
          const rowNow = await dbGet("SELECT stored_name, mime_type FROM hr_doc_tracker WHERE employee_id = ? AND doc_key = 'headshot'", [empId]);
          if (rowNow && rowNow.stored_name) await dbRun("UPDATE hr_employees SET hr_photo = ? WHERE id = ?", ["doc:" + rowNow.stored_name, empId]);
        }
        await audit(actor, "doc_tracker_updated", "employee", empId, b.doc_key + " -> " + (b.status || "updated"));
        return json(res, 200, { ok: true, documents: await getDocTracker(empId) });
      }
      // Download a stored tracker document (or the photo).
      const docFileMatch = pathname.match(/^\/api\/hr\/employees\/(\d+)\/doc-tracker\/([a-z_]+)\/file$/);
      if (docFileMatch && method === "GET") {
        const row = await dbGet("SELECT * FROM hr_doc_tracker WHERE employee_id = ? AND doc_key = ?", [Number(docFileMatch[1]), docFileMatch[2]]);
        if (!row || !row.stored_name) return json(res, 404, { error: "No file" });
        const full = path.join(HR_DOC_DIR, row.stored_name);
        if (!fs.existsSync(full)) return json(res, 404, { error: "File missing" });
        return sendFile(res, 200, fs.readFileSync(full), row.mime_type || "application/octet-stream", row.filename || row.doc_key);
      }
      const photoMatch = pathname.match(/^\/api\/hr\/employees\/(\d+)\/photo$/);
      if (photoMatch && method === "GET") {
        const emp = await dbGet("SELECT hr_photo FROM hr_employees WHERE id = ?", [Number(photoMatch[1])]);
        if (!emp || !emp.hr_photo) return json(res, 404, { error: "No photo" });
        const stored = emp.hr_photo.startsWith("doc:") ? emp.hr_photo.slice(4) : emp.hr_photo;
        const full = path.join(HR_DOC_DIR, stored);
        if (!fs.existsSync(full)) return json(res, 404, { error: "No photo" });
        return sendFile(res, 200, fs.readFileSync(full), "image/jpeg", "photo");
      }
      if (pathname === "/api/hr/documents-outstanding" && method === "GET") {
        return json(res, 200, { count: await countDocsOutstanding(), milestones_this_week: await milestonesThisWeek() });
      }

      // Offer Accepted trigger bundle: fire the selected onboarding actions.
      const offerAcceptedMatch = pathname.match(/^\/api\/hr\/employees\/(\d+)\/offer-accepted$/);
      if (offerAcceptedMatch && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const empId = Number(offerAcceptedMatch[1]);
        const emp = await dbGet("SELECT * FROM hr_employees WHERE id = ?", [empId]);
        if (!emp) return json(res, 404, { error: "Not found" });
        const b = await readBody(req);
        const a = b.actions || {};
        const first = firstNameOf(emp.name);
        const hireDate = b.hire_date || emp.hr_hire_date || null;
        const fired = [];

        await dbRun("UPDATE hr_employees SET hr_stage = 'Offer Accepted', hr_offer_accepted_date = ?, hr_hire_date = COALESCE(?, hr_hire_date) WHERE id = ?", [nowISO().slice(0, 10), hireDate, empId]);

        if (a.dojo && emp.email) {
          const t = await renderHrEmail("hr_welcome_dojo", { first_name: first, hire_date: hireDate || "your start date", class_dojo_link: b.class_dojo_link || "" });
          if (t) { await sendEmail({ to: emp.email, subject: t.subject, html: t.html, type: "hr_onboarding" }).catch((e) => console.error(e)); fired.push("Class Dojo welcome email"); }
        }
        if (a.rethink && emp.email) {
          const t = await renderHrEmail("hr_rethink_creds", { first_name: first, rethink_username: b.rethink_username || "(to be provided)" });
          if (t) { await sendEmail({ to: emp.email, subject: t.subject, html: t.html, type: "hr_onboarding" }).catch((e) => console.error(e)); fired.push("Rethink credentials email"); }
        }
        if (a.scheduling && emp.email) {
          const token = await getOrCreateAvailLink(empId);
          const link = `${APP_BASE_URL}/staff-availability/?token=${token}`;
          const t = await renderHrEmail("hr_scheduling_request", { first_name: first, scheduling_form_link: link });
          if (t) { await sendEmail({ to: emp.email, subject: t.subject, html: t.html, type: "hr_onboarding" }).catch((e) => console.error(e)); fired.push("Scheduling/availability email"); }
          await hrMakeStaffTask(`Availability form pending: ${emp.name}`, empId);
        }
        if (a.task_homebase) { await hrMakeStaffTask(`Add ${emp.name} to Homebase`, empId); fired.push("Task: Add to Homebase"); }
        if (a.task_rethink) { await hrMakeStaffTask(`Add ${emp.name} to Rethink`, empId); fired.push("Task: Add to Rethink"); }

        // New-hire employment packet via SignNow. Defaults to ON: this is the
        // automation the offer-acceptance trigger exists for. Sending is
        // deduplicated on the employee, so a candidate who already got their
        // packet when they clicked accept will not get a second one here.
        let packetResult = null;
        if (a.newhire_packet !== false) {
          packetResult = await sendNewHirePacket(
            { id: empId, name: emp.name, email: emp.email, role_title: emp.role_title },
            { actor: actor || "offer accepted (staff card)" }
          );
          if (packetResult.ok) {
            fired.push(packetResult.already
              ? "New-hire employment packet (already sent — not duplicated)"
              : "New-hire employment packet sent via SignNow");
          } else {
            // Surfaced rather than swallowed: a packet that silently did not
            // send is how a new hire shows up on day one with no paperwork.
            fired.push(`New-hire packet NOT sent — ${packetResult.error}`);
          }
        }

        await logEmpActivity(empId, "Offer Accepted — fired: " + (fired.length ? fired.join("; ") : "no actions selected") + (hireDate ? ` (start ${hireDate})` : ""));
        await audit(actor, "offer_accepted_bundle", "employee", empId, fired.join("; "));
        return json(res, 200, {
          ok: true, fired, packet: packetResult,
          employee: await dbGet("SELECT * FROM hr_employees WHERE id = ?", [empId]),
        });
      }

      // New-hire packet status for the staff card, plus a manual send/resend.
      const packetMatch = pathname.match(/^\/api\/hr\/employees\/(\d+)\/newhire-packet$/);
      if (packetMatch && method === "GET") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        return json(res, 200, await getNewHirePacket(Number(packetMatch[1])));
      }
      if (packetMatch && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const empId = Number(packetMatch[1]);
        const emp = await dbGet("SELECT * FROM hr_employees WHERE id = ?", [empId]);
        if (!emp) return json(res, 404, { error: "Not found" });
        const b = await readBody(req).catch(() => ({}));
        const result = await sendNewHirePacket(
          { id: empId, name: emp.name, email: emp.email, role_title: emp.role_title },
          { actor, force: !!(b && b.force) }
        );
        await logEmpActivity(empId, result.ok
          ? (result.already ? "New-hire packet: already sent (no duplicate created)." : "New-hire employment packet sent via SignNow.")
          : `New-hire packet failed to send: ${result.error}`).catch(() => {});
        await audit(actor, "newhire_packet_send", "employee", empId, result.ok ? result.status : result.error);
        return json(res, result.ok ? 200 : 400, result);
      }

      // Bulk import staff from the Rethink payroll sheet (NO pay). Upserts by
      // rethink_id, else email, else name. Expects b.rows = [{name, email, phone,
      // address, certifications, hire_date, role_title, rethink_id}, ...].
      if (pathname === "/api/hr/employees/import" && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        if (!Array.isArray(b.rows) || !b.rows.length) return json(res, 400, { error: "Provide a 'rows' array" });
        let created = 0, updated = 0;
        for (const r of b.rows) {
          const name = (r.name || "").trim();
          if (!name) continue;
          let existing = null;
          if (r.rethink_id) existing = await dbGet("SELECT id FROM hr_employees WHERE rethink_id = ?", [String(r.rethink_id)]);
          if (!existing && r.email) existing = await dbGet("SELECT id FROM hr_employees WHERE lower(email) = lower(?)", [r.email]);
          if (!existing) existing = await dbGet("SELECT id FROM hr_employees WHERE lower(name) = lower(?)", [name]);
          const vals = {
            name,
            email: r.email || null,
            phone: r.phone || null,
            address: r.address || null,
            certifications: r.certifications || null,
            hire_date: r.hire_date || null,
            role_title: r.role_title || null,
            rethink_id: r.rethink_id ? String(r.rethink_id) : null,
          };
          if (existing) {
            // Only overwrite columns we actually received (non-empty).
            const setCols = Object.keys(vals).filter((k) => vals[k] != null && vals[k] !== "");
            if (setCols.length) {
              await dbRun(`UPDATE hr_employees SET ${setCols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, [...setCols.map((c) => vals[c]), existing.id]);
            }
            updated++;
          } else {
            await dbRun(
              `INSERT INTO hr_employees (name, email, phone, address, certifications, hire_date, role_title, rethink_id, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
              [vals.name, vals.email, vals.phone, vals.address, vals.certifications, vals.hire_date, vals.role_title, vals.rethink_id, nowISO()]
            );
            created++;
          }
        }
        await audit(actor, "staff_imported", "employee", 0, `created=${created} updated=${updated}`);
        return json(res, 200, { ok: true, created, updated });
      }

      const empCredMatch = pathname.match(/^\/api\/hr\/employees\/(\d+)\/credentials$/);
      if (empCredMatch && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        if (!b.credential_type) return json(res, 400, { error: "credential_type is required" });
        await dbRun(
          `INSERT INTO hr_employee_credentials (employee_id, credential_type, credential_number, issued_date, expiration_date, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?)`,
          [empCredMatch[1], b.credential_type, b.credential_number || null, b.issued_date || null, b.expiration_date || null, nowISO()]
        );
        await audit(actor, "credential_added", "employee", Number(empCredMatch[1]), b.credential_type);
        return json(res, 201, { ok: true });
      }

      // ---- timecards (future HR: verification workflow, no payroll writes) ----
      if (pathname === "/api/hr/timecards" && method === "GET") {
        const rows = await dbAll(
          `SELECT t.*, e.name AS employee_name,
                  (SELECT COUNT(*) FROM hr_timecard_flags f WHERE f.timecard_id = t.id) AS flag_count,
                  (SELECT COUNT(*) FROM hr_timecard_flags f WHERE f.timecard_id = t.id AND f.status IN ('open','explained')) AS open_flags,
                  (SELECT d.id FROM hr_documents d WHERE d.employee_id = t.employee_id AND d.kind = 'timecard' ORDER BY d.id DESC LIMIT 1) AS pdf_doc_id
             FROM hr_timecards t LEFT JOIN hr_employees e ON e.id = t.employee_id
             ORDER BY t.id DESC LIMIT 100`
        );
        return json(res, 200, rows);
      }
      if (pathname === "/api/hr/timecards/import" && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        if (!Array.isArray(b.entries) || !b.entries.length) return json(res, 400, { error: "Provide an 'entries' array" });
        const r = await importTimecard(b, actor);
        return json(res, 201, { ok: true, ...r });
      }
      // Batch import (e.g. a Rethink payroll export): accepts { timecards: [{ employee_name,
      // entries, pay_period_start, pay_period_end, source }] }, matches each to an existing
      // employee by name, and creates one timecard per matched employee. Reports unmatched
      // names so nobody is silently skipped.
      if (pathname === "/api/hr/timecards/import-batch" && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        const list = Array.isArray(b.timecards) ? b.timecards : [];
        if (!list.length) return json(res, 400, { error: "Provide a 'timecards' array" });
        const employees = await dbAll("SELECT id, name FROM hr_employees");
        const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
        const byName = {};
        employees.forEach((e) => { byName[norm(e.name)] = e.id; });
        const created = [], unmatched = [];
        for (const tc of list) {
          const empId = byName[norm(tc.employee_name)];
          if (!empId) { unmatched.push(tc.employee_name); continue; }
          const r = await importTimecard({ ...tc, employee_id: empId, source: tc.source || "import" }, actor);
          created.push({ employee: tc.employee_name, timecard_id: r.id, flags: r.flags });
        }
        return json(res, 201, { ok: true, created_count: created.length, created, unmatched });
      }
      // Download a stored employee document (e.g. a signed timecard PDF).
      const empDocMatch = pathname.match(/^\/api\/hr\/employee-documents\/(\d+)$/);
      if (empDocMatch && method === "GET") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const doc = await dbGet("SELECT * FROM hr_documents WHERE id = ?", [empDocMatch[1]]);
        if (!doc) return json(res, 404, { error: "Not found" });
        const full = path.join(RESUME_DIR, doc.stored_name);
        if (!fs.existsSync(full)) return json(res, 404, { error: "File missing" });
        const buffer = fs.readFileSync(full);
        return sendFile(res, 200, buffer, doc.mime_type || "application/pdf", doc.filename || "timecard.pdf");
      }
      const tcIdMatch = pathname.match(/^\/api\/hr\/timecards\/(\d+)$/);
      if (tcIdMatch && method === "GET") {
        const tc = await dbGet("SELECT * FROM hr_timecards WHERE id = ?", [tcIdMatch[1]]);
        if (!tc) return json(res, 404, { error: "Not found" });
        const emp = tc.employee_id ? await dbGet("SELECT * FROM hr_employees WHERE id = ?", [tc.employee_id]) : null;
        const flags = await dbAll("SELECT * FROM hr_timecard_flags WHERE timecard_id = ? ORDER BY id", [tc.id]);
        // The signed PDF (saved on accept) so the office can open exactly what the
        // employee signed.
        const pdf = await dbGet("SELECT id FROM hr_documents WHERE employee_id = ? AND kind = 'timecard' ORDER BY id DESC LIMIT 1", [tc.employee_id]).catch(() => null);
        return json(res, 200, { ...tc, entries: parseJson(tc.entries, []), edited_entries: parseJson(tc.edited_entries, []), employee: emp, flags, pdf_doc_id: pdf ? pdf.id : null });
      }
      // Delete a timecard -- OWNER ONLY. Managers can import/send timecards, but
      // destructive removal is restricted to the owner account. Removes the
      // timecard plus its anomaly flags and verification links; any signed PDF
      // already filed on the employee (a legal record) is intentionally kept.
      if (tcIdMatch && method === "DELETE") {
        if (user.role !== "owner") return json(res, 403, { error: "Only the owner can delete timecards." });
        const id = Number(tcIdMatch[1]);
        const tc = await dbGet("SELECT * FROM hr_timecards WHERE id = ?", [id]);
        if (!tc) return json(res, 404, { error: "Not found" });
        await dbRun("DELETE FROM hr_timecard_flags WHERE timecard_id = ?", [id]).catch(() => {});
        await dbRun("DELETE FROM hr_timecard_links WHERE timecard_id = ?", [id]).catch(() => {});
        await dbRun("DELETE FROM hr_timecards WHERE id = ?", [id]);
        await audit(actor, "timecard_deleted", "timecard", id, `employee_id=${tc.employee_id || ""} period=${tc.pay_period_start || ""}->${tc.pay_period_end || ""} status=${tc.status || ""}`);
        return json(res, 200, { ok: true, deleted: id });
      }
      // Preview exactly what the employee will get, WITHOUT sending anything,
      // creating a link, or touching the timecard's status. Read-only.
      const tcPreviewMatch = pathname.match(/^\/api\/hr\/timecards\/(\d+)\/preview$/);
      if (tcPreviewMatch && method === "GET") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const tc = await dbGet("SELECT * FROM hr_timecards WHERE id = ?", [tcPreviewMatch[1]]);
        if (!tc) return json(res, 404, { error: "Not found" });
        const emp = tc.employee_id ? await dbGet("SELECT name, email, role_title FROM hr_employees WHERE id = ?", [tc.employee_id]) : null;
        const flags = await dbAll("SELECT * FROM hr_timecard_flags WHERE timecard_id = ? ORDER BY id", [tc.id]);
        const shaped = shapeTimecardPreview(tc, emp, flags);
        const period = `${tc.pay_period_start || ""} – ${tc.pay_period_end || ""}`;
        return json(res, 200, Object.assign(shaped, {
          // The real email, with the button pointing nowhere (nothing is
          // generated until you actually send).
          email_html: timecardEmailHtml(firstNameOf(emp ? emp.name : "there"), period, "#preview-only", timecardTotals(parseJson(tc.entries, []))),
        }));
      }

      // Preview a whole batch before anything goes out. Same read-only promise
      // as the single preview -- no links minted, no status touched, no email.
      // Takes { ids: [] } or { pay_period_end } (defaults to everything not yet
      // accepted for that period, i.e. exactly what send-all would have hit).
      if (pathname === "/api/hr/timecards/preview-batch" && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        const ids = (Array.isArray(b.ids) ? b.ids : []).map((n) => Number(n)).filter((n) => n > 0);
        let cards;
        if (ids.length) {
          cards = await dbAll(`SELECT * FROM hr_timecards WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, ids);
        } else if (b.pay_period_end) {
          cards = await dbAll("SELECT * FROM hr_timecards WHERE status != 'accepted' AND pay_period_end = ? ORDER BY id", [b.pay_period_end]);
        } else {
          return json(res, 400, { error: "Provide 'ids' or a 'pay_period_end'." });
        }
        const out = [];
        for (const tc of cards) {
          const emp = tc.employee_id ? await dbGet("SELECT name, email, role_title FROM hr_employees WHERE id = ?", [tc.employee_id]) : null;
          const flags = await dbAll("SELECT * FROM hr_timecard_flags WHERE timecard_id = ? ORDER BY id", [tc.id]);
          out.push(shapeTimecardPreview(tc, emp, flags));
        }
        const sum = (k) => round2(out.reduce((s, p) => s + (Number(p[k]) || 0), 0));
        return json(res, 200, {
          ok: true,
          count: out.length,
          sendable: out.filter((p) => p.has_email && p.status !== "accepted").length,
          billable_hours: sum("billable_hours"),
          non_billable_hours: sum("non_billable_hours"),
          unclassified_hours: sum("unclassified_hours"),
          total_hours: sum("total_hours"),
          timecards: out,
        });
      }

      // Correct hours (or a mis-labelled Billable/Non-Billable) BEFORE the
      // employee ever sees the timecard. Patch-by-index so the client can't
      // drop fields it didn't render. Refuses once a timecard is signed --
      // an accepted timecard is a record, not a draft. Never writes payroll.
      const tcEntriesMatch = pathname.match(/^\/api\/hr\/timecards\/(\d+)\/entries$/);
      if (tcEntriesMatch && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        const tc = await dbGet("SELECT * FROM hr_timecards WHERE id = ?", [tcEntriesMatch[1]]);
        if (!tc) return json(res, 404, { error: "Not found" });
        if (tc.status === "accepted") return json(res, 409, { error: "This timecard is already signed and can't be edited." });
        const updates = Array.isArray(b.updates) ? b.updates : [];
        if (!updates.length) return json(res, 400, { error: "Nothing to change." });
        const entries = parseJson(tc.entries, []);
        const changes = [];
        for (const u of updates) {
          const i = Number(u.i);
          if (!Number.isInteger(i) || i < 0 || i >= entries.length) continue;
          const e = entries[i];
          if (u.hours !== undefined && u.hours !== null && u.hours !== "") {
            const h = round2(u.hours);
            if (!(h >= 0) || h > 24) return json(res, 400, { error: `Hours must be between 0 and 24 (got "${u.hours}").` });
            if (h !== round2(e.hours)) { changes.push(`${e.date || "entry " + i}: ${round2(e.hours)}h → ${h}h`); e.hours = h; }
          }
          if (u.appt_type !== undefined) {
            const at = String(u.appt_type || "").trim();
            const cls = classifyBillable(at);
            if (at !== String(e.appt_type || "")) changes.push(`${e.date || "entry " + i}: ${e.appt_type || "unclassified"} → ${at || "unclassified"}`);
            e.appt_type = at;
            e.billable = cls;
          }
        }
        if (!changes.length) return json(res, 200, { ok: true, changed: 0, ...timecardTotals(entries) });
        await dbRun("UPDATE hr_timecards SET entries = ?, admin_edited_at = ?, admin_edited_by = ? WHERE id = ?",
          [JSON.stringify(entries), nowISO(), actor || "", tc.id]);
        // Re-run anomaly detection so a corrected shift stops nagging (and a
        // newly-broken one starts). Old open flags are replaced, resolved ones kept.
        await dbRun("DELETE FROM hr_timecard_flags WHERE timecard_id = ? AND status = 'open'", [tc.id]);
        const flags = detectTimecardAnomalies(entries);
        for (const f of flags) {
          await dbRun(`INSERT INTO hr_timecard_flags (timecard_id, flag_type, detail, status, created_at) VALUES (?, ?, ?, 'open', ?)`,
            [tc.id, f.flag_type, f.detail, nowISO()]);
        }
        await audit(actor, "timecard_entries_edited", "timecard", tc.id, changes.join("; ").slice(0, 400));
        const t = timecardTotals(entries);
        return json(res, 200, { ok: true, changed: changes.length, changes, entries, flag_count: flags.length, ...t });
      }

      // Bulk send to a chosen set, rather than all-or-nothing.
      if (pathname === "/api/hr/timecards/send" && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        const ids = (Array.isArray(b.ids) ? b.ids : []).map((n) => Number(n)).filter((n) => n > 0);
        if (!ids.length) return json(res, 400, { error: "Select at least one timecard." });
        let sent = 0;
        const skipped = [];
        for (const id of ids) {
          const tc = await dbGet("SELECT * FROM hr_timecards WHERE id = ?", [id]);
          if (!tc) continue;
          const r = await sendTimecardVerification(tc);
          if (r.sent) sent++;
          else skipped.push(await employeeName(tc.employee_id));
          await audit(actor, "timecard_verification_requested", "timecard", tc.id, "bulk");
        }
        return json(res, 200, { ok: true, sent, skipped });
      }

      const tcVerifyMatch = pathname.match(/^\/api\/hr\/timecards\/(\d+)\/request-verification$/);
      if (tcVerifyMatch && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const tc = await dbGet("SELECT * FROM hr_timecards WHERE id = ?", [tcVerifyMatch[1]]);
        if (!tc) return json(res, 404, { error: "Not found" });
        const r = await sendTimecardVerification(tc);
        await audit(actor, "timecard_verification_requested", "timecard", tc.id, "");
        return json(res, 200, { ok: true, url: r.url, sent: r.sent });
      }
      // Send (or resend) the review email to EVERY timecard that hasn't been
      // accepted yet and whose employee has an email on file. Reports how many
      // were sent and which were skipped (no email / already accepted).
      if (pathname === "/api/hr/timecards/send-all" && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        // Optional: limit to a pay period so you don't re-send old ones.
        let sql = "SELECT * FROM hr_timecards WHERE status != 'accepted'";
        const params = [];
        if (b.pay_period_end) { sql += " AND pay_period_end = ?"; params.push(b.pay_period_end); }
        const cards = await dbAll(sql + " ORDER BY id DESC", params);
        let sent = 0; const skipped = [];
        for (const tc of cards) {
          const r = await sendTimecardVerification(tc);
          if (r.sent) sent++;
          else skipped.push(await employeeName(tc.employee_id));
        }
        await audit(actor, "timecard_send_all", "timecard", null, `sent=${sent} skipped=${skipped.length}`);
        return json(res, 200, { ok: true, sent, skipped });
      }

      // Upload a Rethink bi-weekly payroll export (.xlsx as base64). Parses it,
      // creates one timecard per employee (matched by rethink_id, else name),
      // and returns a preview. Does NOT send emails — the frontend confirms
      // then calls /api/hr/timecards/send-all with the pay_period_end.
      if (pathname === "/api/hr/payroll/import" && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        if (!b.content_base64) return json(res, 400, { error: "No file provided." });
        let buffer;
        try {
          let s = String(b.content_base64);
          const comma = s.indexOf(","); if (s.startsWith("data:") && comma >= 0) s = s.slice(comma + 1);
          buffer = Buffer.from(s, "base64");
        } catch (e) { return json(res, 400, { error: "Could not read the uploaded file." }); }
        let parsed;
        try { parsed = buildPayrollTimecards(parseXlsx(buffer)); }
        catch (e) { return json(res, 400, { error: "Could not parse the export: " + e.message }); }
        if (!parsed.employees.length) return json(res, 400, { error: "No employees found in the export. Is this the Rethink payroll export?" });

        const preview = [];
        for (const emp of parsed.employees) {
          // Match: rethink_id first, then case-insensitive full name.
          let staff = null;
          if (emp.rethink_id) staff = await dbGet("SELECT id, name, email FROM hr_employees WHERE rethink_id = ?", [emp.rethink_id]);
          if (!staff && emp.name) staff = await dbGet("SELECT id, name, email FROM hr_employees WHERE LOWER(name) = LOWER(?)", [emp.name]);
          let timecardId = null;
          if (staff) {
            const r = await importTimecard({
              employee_id: staff.id,
              source: "rethink_payroll",
              pay_period_start: parsed.period_start,
              pay_period_end: parsed.period_end,
              entries: emp.entries,
              raw: { rethink_id: emp.rethink_id, total_hours: emp.total_hours, reg_hours: emp.reg_hours, ot_hours: emp.ot_hours },
            }, actor);
            timecardId = r.id;
          }
          preview.push({
            name: emp.name || (emp.rethink_id ? `#${emp.rethink_id}` : "Unknown"),
            rethink_id: emp.rethink_id,
            total_hours: emp.total_hours,
            billable_hours: emp.billable_hours,
            non_billable_hours: emp.non_billable_hours,
            unclassified_hours: emp.unclassified_hours,
            shifts: emp.entries.length,
            matched: !!staff,
            has_email: !!(staff && staff.email),
            timecard_id: timecardId,
          });
        }
        await audit(actor, "payroll_imported", "timecard", null, `period=${parsed.period_end} employees=${preview.length} matched=${preview.filter((p) => p.matched).length}`);
        return json(res, 200, {
          ok: true,
          pay_period_start: parsed.period_start,
          pay_period_end: parsed.period_end,
          total_employees: preview.length,
          matched: preview.filter((p) => p.matched).length,
          unmatched: preview.filter((p) => !p.matched).map((p) => p.name),
          no_email: preview.filter((p) => p.matched && !p.has_email).map((p) => p.name),
          // False = the export had no "Appt Type" column, so nothing can be
          // split. Say so loudly rather than showing everyone 0 billable hours.
          has_appt_type: !!parsed.has_appt_type,
          billable_hours: round2(preview.reduce((s, p) => s + (Number(p.billable_hours) || 0), 0)),
          non_billable_hours: round2(preview.reduce((s, p) => s + (Number(p.non_billable_hours) || 0), 0)),
          unclassified_hours: round2(preview.reduce((s, p) => s + (Number(p.unclassified_hours) || 0), 0)),
          timecard_ids: preview.filter((p) => p.timecard_id).map((p) => p.timecard_id),
          employees: preview,
        });
      }
      const flagResolveMatch = pathname.match(/^\/api\/hr\/timecard-flags\/(\d+)\/resolve$/);
      if (flagResolveMatch && method === "POST") {
        if (!canManage) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        const status = ["corrected", "approved"].includes(b.status) ? b.status : "approved";
        const flag = await dbGet("SELECT * FROM hr_timecard_flags WHERE id = ?", [flagResolveMatch[1]]);
        if (!flag) return json(res, 404, { error: "Flag not found" });
        // Human approval only — this NEVER writes to payroll or timecard hours.
        await dbRun("UPDATE hr_timecard_flags SET status = ?, supervisor = ?, resolved_at = ? WHERE id = ?", [status, actor, nowISO(), flag.id]);
        const openLeft = Number((await dbGet("SELECT COUNT(*) AS n FROM hr_timecard_flags WHERE timecard_id = ? AND status IN ('open','explained')", [flag.timecard_id])).n);
        if (openLeft === 0) await dbRun("UPDATE hr_timecards SET status = 'verified' WHERE id = ?", [flag.timecard_id]);
        await audit(actor, "timecard_flag_resolved", "timecard", flag.timecard_id, `flag=${flag.id} status=${status} (no payroll change)`);
        return json(res, 200, { ok: true, timecard_status: openLeft === 0 ? "verified" : "flagged" });
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
    // Tolerate "$24.00", "1,200", " 85000 " etc. so a stray symbol never
    // silently drops the value.
    if (typeof v === "string") v = v.replace(/[^0-9.\-]/g, "");
    if (v === "" || v === "-" || v === ".") return null;
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

  // Throws on any failure, as it always has -- callers catch and record a
  // rules-based assessment instead. The wording of each error is unchanged
  // because it is shown to whoever ran the screening.
  async function callClaudeAssessment(userContent) {
    const r = await callClaude({
      system: AI_SYSTEM_PROMPT,
      user: userContent,          // a string, or content blocks when a resume PDF is attached
      schema: ASSESSMENT_SCHEMA,
      effort: "medium",
      maxTokens: 4096,
      model: HR_AI_MODEL,
    });
    if (!r.ok) {
      if (r.reason === "refused") throw new Error("The AI declined to assess this application.");
      if (r.reason === "empty") throw new Error("No assessment returned by the AI.");
      if (r.reason === "unparseable") throw new Error("AI returned an unparseable assessment.");
      throw new Error(r.error || "The AI could not assess this application.");
    }
    return { parsed: r.parsed, model: r.model || HR_AI_MODEL };
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

    const missingText = (a.missing_information || []).join(" ").toLowerCase();
    if (/credential|certif|licens|rbt|bcba|lba|background/.test(missingText)) {
      await notify({
        type: "credential_missing",
        applicantId: applicant.id,
        positionId: applicant.position_id,
        title: "Credential info missing",
        body: `${applicant.full_name}: ${(a.missing_information || []).slice(0, 3).join("; ")}`,
        severity: "info",
      });
    }

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
    if (result.delivered === "failed") {
      await notify({
        type: "followup_failed",
        applicantId: applicant.id,
        title: "Recruiting email failed to send",
        body: `An email to ${applicant.full_name} (${applicant.email}) failed: ${result.errorMsg || "unknown error"}.`,
        severity: "warning",
        emailOwner: true,
      });
    }
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

  // ============================ RECRUITING INBOX ============================
  // A provider-agnostic inbound endpoint receives application emails and
  // replies (Resend Inbound, SendGrid Inbound Parse, Mailgun, etc. all map to
  // the normalized payload below). Replies are matched to existing candidates
  // and pause automation; unmatched senders become new candidate records.
  function stripTags(html) {
    return String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  function extractEmail(from) {
    const s = String(from || "").trim();
    const m = s.match(/<([^>]+)>/);
    return (m ? m[1] : s).toLowerCase().trim();
  }

  // Recognizes Indeed / LinkedIn application-notification emails. In these the
  // sender is the platform (e.g. noreply@indeed.com), so the candidate's real
  // name/email/phone must be parsed out of the body. Heuristic by necessity —
  // formats vary — so unparsed fields fall back gracefully and a human can fix.
  function parsePlatformApplication(payload) {
    const fromLower = (payload.from || "").toLowerCase();
    const subject = payload.subject || "";
    const bodyText = payload.text || stripTags(payload.html || "");
    let source = null;
    if (/indeed\.com/.test(fromLower) || /\bindeed\b/i.test(subject)) source = "indeed";
    else if (/linkedin\.com/.test(fromLower) || /\blinkedin\b/i.test(subject)) source = "linkedin";
    else if (payload.source === "indeed" || payload.source === "linkedin") source = payload.source;
    if (!source) return null;

    const full = subject + "\n" + bodyText;
    const emails = (full.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [])
      .filter((e) => !/indeed\.com|linkedin\.com|noreply|no-reply|donotreply/i.test(e));
    const email = emails[0] || null;
    const phoneM = full.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
    const phone = phoneM ? phoneM[0] : null;

    let name = null;
    // Constrain inner spacing to spaces/tabs so the name doesn't run across a
    // newline into the next label (e.g. "Taylor Morgan\nEmail:").
    let m = bodyText.match(/\b(?:name|applicant|candidate)[ \t]*[:\-][ \t]*([A-Za-z][A-Za-z'.\-]+(?:[ \t]+[A-Za-z][A-Za-z'.\-]+){0,3})/i);
    if (m) name = m[1].trim();
    if (!name) { m = subject.match(/^(.+?)\s+(?:has\s+)?applied\b/i); if (m) name = m[1].trim(); }
    if (!name) { m = subject.match(/application from\s+(.+?)(?:\s*[-–—:]|$)/i); if (m) name = m[1].trim(); }

    let title = null;
    m = subject.match(/(?:applied to|application for|new application(?:\s+received)?)\s*[:\-]?\s*(.+?)(?:\s*[-–—]\s*|$)/i);
    if (m) title = m[1].trim();
    if (!title) { m = bodyText.match(/\b(?:job title|position|applied to|job)\s*[:\-]\s*(.+)/i); if (m) title = m[1].trim(); }

    return { source, full_name: name, email, phone, job_title: title, cover_letter: bodyText.slice(0, 3000) };
  }

  async function matchPosition(text) {
    const t = (text || "").toLowerCase();
    if (!t.trim()) return null;
    const rows = await dbAll("SELECT id, title, role_type FROM hr_positions WHERE status <> 'closed'", []);
    for (const p of rows) {
      if (p.title && t.includes(p.title.toLowerCase())) return p;
    }
    if (/\bbcba\b|behavior analyst/.test(t)) { const b = rows.find((p) => p.role_type === "bcba"); if (b) return b; }
    if (/\brbt\b|behavior technician/.test(t)) { const r = rows.find((p) => p.role_type === "rbt"); if (r) return r; }
    return null;
  }

  async function handlePlatformApplication(platform, payload) {
    const email = (platform.email || "").toLowerCase().trim() || null;
    const phone = (platform.phone || "").replace(/[^0-9]/g, "") || null;
    const position = await matchPosition((platform.job_title || "") + " " + (payload.subject || ""));

    let applicant = null;
    if (email || phone) {
      applicant = await dbGet(
        "SELECT * FROM hr_applicants WHERE (email IS NOT NULL AND email = ?) OR (phone IS NOT NULL AND phone = ?) ORDER BY id LIMIT 1",
        [email, phone]
      );
    }
    let created = false;
    if (!applicant) {
      const result = await createApplicant(
        {
          full_name: platform.full_name || email || (platform.source === "linkedin" ? "LinkedIn Applicant" : "Indeed Applicant"),
          email,
          phone,
          source: platform.source,
          position_id: position ? position.id : null,
          cover_letter: platform.cover_letter,
        },
        platform.source
      );
      applicant = await dbGet("SELECT * FROM hr_applicants WHERE id = ?", [result.id]);
      created = true;
    }

    await dbRun(
      `INSERT INTO hr_applicant_messages (applicant_id, direction, channel, from_addr, to_addr, subject, body, status, created_at)
       VALUES (?, 'inbound', 'email', ?, ?, ?, ?, 'received', ?)`,
      [applicant.id, email || extractEmail(payload.from), payload.to || null, payload.subject || `${platform.source} application`, payload.html || `<p>${escapeHtml(platform.cover_letter || "")}</p>`, nowISO()]
    );
    for (const att of payload.attachments || []) {
      if (att && att.content_base64 && /\.(pdf|docx|doc)$/i.test(att.filename || "")) {
        await saveApplicantDocument(applicant.id, "resume", att, platform.source).catch((e) => console.error("platform resume save failed:", e.message));
      }
    }
    await audit(platform.source, created ? "applicant_created_platform" : "platform_reapplication", "applicant", applicant.id, `source=${platform.source} matched_position=${position ? position.title : "none"}`);
    return { ok: true, applicant_id: applicant.id, created, source: platform.source, matched_position: position ? position.title : null };
  }

  async function handleInbound(payload) {
    // Platform application notifications (Indeed/LinkedIn) are parsed specially
    // because the sender is the platform, not the candidate.
    const platform = parsePlatformApplication(payload);
    if (platform) return handlePlatformApplication(platform, payload);

    const fromEmail = extractEmail(payload.from);
    if (!fromEmail) return { ok: false, error: "No sender address" };
    const subject = payload.subject || "(no subject)";
    const bodyText = payload.text || stripTags(payload.html || "");
    const bodyStore = payload.html || (bodyText ? `<p>${escapeHtml(bodyText)}</p>` : "");
    const unsub = /\b(unsubscribe|stop contacting|do not contact|do-not-contact|remove me|opt out|opt-out)\b/i.test(bodyText);

    let applicant = await dbGet("SELECT * FROM hr_applicants WHERE email = ? ORDER BY id DESC LIMIT 1", [fromEmail]);
    let created = false;
    if (!applicant) {
      const fromName = (payload.from_name || "").trim() || (String(payload.from || "").split("<")[0].trim()) || fromEmail.split("@")[0];
      const result = await createApplicant(
        { full_name: fromName, email: fromEmail, source: "email", cover_letter: bodyText.slice(0, 4000) },
        "inbound"
      );
      applicant = await dbGet("SELECT * FROM hr_applicants WHERE id = ?", [result.id]);
      created = true;
    }

    await dbRun(
      `INSERT INTO hr_applicant_messages (applicant_id, direction, channel, from_addr, to_addr, subject, body, status, created_at)
       VALUES (?, 'inbound', 'email', ?, ?, ?, ?, 'received', ?)`,
      [applicant.id, fromEmail, payload.to || null, subject, bodyStore, nowISO()]
    );

    // Save resume attachments.
    for (const att of payload.attachments || []) {
      if (att && att.content_base64 && /\.(pdf|docx|doc)$/i.test(att.filename || "")) {
        await saveApplicantDocument(applicant.id, "resume", att, "inbound").catch((e) => console.error("inbound resume save failed:", e.message));
      }
    }

    if (!created) {
      // A reply from an existing candidate: pause automation, mark responded.
      await dbRun("UPDATE hr_applicants SET last_response_at = ?, automation_paused = TRUE, updated_at = ? WHERE id = ?", [nowISO(), nowISO(), applicant.id]);
      await cancelPendingFollowups(applicant.id);
      if (["new_applicant", "ai_screening", "needs_human_review", "contacted"].includes(applicant.stage)) {
        await moveStageInternal(applicant, "responded", "inbound", "Candidate replied by email");
      }
      await notify({
        type: "candidate_response",
        applicantId: applicant.id,
        positionId: applicant.position_id,
        title: "Candidate replied",
        body: `${applicant.full_name} replied: ${subject}`,
        severity: "info",
      });
      // Compensation questions should reach a human, not be auto-answered.
      if (/\b(salary|compensation|pay rate|hourly rate|how much (do|does|will)|what.s the pay|wage)\b/i.test(bodyText)) {
        await notify({
          type: "comp_question",
          applicantId: applicant.id,
          positionId: applicant.position_id,
          title: "Candidate asked about compensation",
          body: `${applicant.full_name} asked about compensation — a person should respond.`,
          severity: "warning",
          emailOwner: true,
        });
      }
    }

    if (unsub) {
      await dbRun("UPDATE hr_applicants SET do_not_contact = TRUE WHERE id = ?", [applicant.id]);
      await cancelPendingFollowups(applicant.id);
      await audit("inbound", "do_not_contact_set", "applicant", applicant.id, "unsubscribe request detected");
    }

    await audit("inbound", created ? "applicant_created_inbound" : "inbound_message", "applicant", applicant.id, subject);
    return { ok: true, applicant_id: applicant.id, created, unsubscribed: unsub };
  }

  // AI-drafted, human-approved reply. Escalates sensitive topics to a person
  // and never makes offers, negotiates comp, or sends rejections on its own.
  async function draftReply(applicant) {
    const name = firstNameOf(applicant.full_name);
    const position = applicant.position_id ? await dbGet("SELECT title FROM hr_positions WHERE id = ?", [applicant.position_id]) : null;
    const fallback = {
      ok: true,
      ai: false,
      subject: "Re: your application to Spectrum Squad",
      body: `Hi ${name},\n\nThanks so much for your note! I'm Spectrum Squad's recruiting assistant. A member of our team will follow up with you shortly. If you have any quick questions in the meantime, just reply here.\n\nWarmly,\nThe Spectrum Squad Team`,
      escalate: false,
    };
    if (!process.env.ANTHROPIC_API_KEY) return fallback;

    const msgs = await dbAll("SELECT direction, subject, body FROM hr_applicant_messages WHERE applicant_id = ? ORDER BY id DESC LIMIT 8", [applicant.id]);
    const convo = msgs.slice().reverse().map((m) => `${m.direction === "inbound" ? "Candidate" : "Us"}: ${stripTags(m.body).slice(0, 600)}`).join("\n");
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { subject: { type: "string" }, body: { type: "string" }, escalate: { type: "boolean" } },
      required: ["subject", "body", "escalate"],
    };
    const sys = `You are Spectrum Squad's recruiting assistant drafting a warm, concise, personal email reply to a candidate for the "${position ? position.title : "open"}" role. Always identify yourself honestly as the recruiting assistant.
Never: make employment promises, negotiate or state compensation, send an offer, send a rejection, or offer to contact references.
Set escalate=true (and keep the reply brief, saying a team member will personally follow up) if the message involves: compensation negotiation, disability accommodations, a complaint, discrimination concerns, legal threats, background checks, offer terms, or anything outside standard job/scheduling information.
Write body as plain text with line breaks (no HTML).`;
    // Never throws: a candidate reply is too important to lose to an API
    // wobble, so anything short of a clean answer falls back to the hand
    // written draft with a note saying why.
    try {
      const r = await callClaude({
        system: sys,
        user: `Candidate: ${name}\nConversation so far:\n${convo}\n\nDraft a reply to their latest message.`,
        schema,
        effort: "low",
        maxTokens: 1500,
        model: HR_AI_MODEL,
      });
      if (!r.ok) return { ...fallback, note: "AI draft unavailable: " + (r.error || r.reason) };
      const parsed = r.parsed || {};
      return { ok: true, ai: true, subject: parsed.subject, body: parsed.body, escalate: !!parsed.escalate };
    } catch (e) {
      return { ...fallback, note: "AI draft unavailable: " + e.message };
    }
  }

  // ---- flexible intake: CSV / bulk import ----
  function splitCsvLine(line) {
    const out = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
        } else cur += c;
      } else if (c === '"') q = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }
  function parseCsv(text) {
    const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return [];
    const headers = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
    return lines.slice(1).map((line) => {
      const cells = splitCsvLine(line);
      const obj = {};
      headers.forEach((h, i) => (obj[h] = (cells[i] || "").trim()));
      return obj;
    });
  }

  // ============================ INTERVIEW SCHEDULING ============================
  // Standards-based (no scraping, no unauthorized automation): the team posts
  // availability slots, the candidate self-books via a tokenized public page,
  // and confirmation emails carry universal Google/Outlook add-to-calendar
  // links plus reschedule/cancel. calendar_event_id + slot_id are stored so a
  // real Google/Microsoft Calendar API sync can be layered on later.
  function icsStamp(iso) {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    return (
      d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + "T" +
      p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + "Z"
    );
  }
  function calendarLinks(title, startISO, durationMin, details, location) {
    const endISO = new Date(new Date(startISO).getTime() + (durationMin || 30) * 60000).toISOString();
    const enc = encodeURIComponent;
    return {
      google: `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${enc(title)}&dates=${icsStamp(startISO)}/${icsStamp(endISO)}&details=${enc(details || "")}&location=${enc(location || "")}`,
      outlook: `https://outlook.live.com/calendar/0/deeplink/compose?subject=${enc(title)}&body=${enc(details || "")}&location=${enc(location || "")}&startdt=${enc(startISO)}&enddt=${enc(endISO)}`,
    };
  }

  async function getOrCreateScheduleLink(applicantId) {
    let row = await dbGet("SELECT token FROM hr_schedule_links WHERE applicant_id = ? ORDER BY created_at LIMIT 1", [applicantId]);
    if (row) return row.token;
    const token = newToken();
    await dbRun("INSERT INTO hr_schedule_links (token, applicant_id, created_at) VALUES (?, ?, ?)", [token, applicantId, nowISO()]);
    return token;
  }

  async function sendInterviewConfirmation(applicant, interview, token, kind) {
    const name = firstNameOf(applicant.full_name);
    const when = new Date(interview.scheduled_at).toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" });
    const isVirtual = interview.mode === "virtual";
    if (kind === "canceled") {
      return sendApplicantEmail(applicant,
        "Your Spectrum Squad interview was canceled",
        `<p>Hi ${escapeHtml(name)},</p><p>Your interview has been canceled. If you'd like to pick a new time, you can do that here: <a href="${APP_BASE_URL}/schedule/${token}">choose a time</a>.</p><p>Warmly,<br/>The Spectrum Squad Team</p>`,
        { sentBy: "assistant" });
    }
    const links = calendarLinks(
      "Interview with Spectrum Squad",
      interview.scheduled_at,
      interview.duration_min || 30,
      isVirtual ? `Virtual interview. ${interview.location_or_link ? "Join: " + interview.location_or_link : "A join link will be shared."}` : "In-person interview with Spectrum Squad.",
      isVirtual ? "" : interview.location_or_link || ""
    );
    const html =
      `<p>Hi ${escapeHtml(name)},</p>` +
      `<p>Your interview with Spectrum Squad is confirmed! 🎉</p>` +
      `<ul><li><strong>When:</strong> ${escapeHtml(when)}</li>` +
      `<li><strong>Format:</strong> ${isVirtual ? "Virtual" : "In person"}</li>` +
      (interview.location_or_link ? `<li><strong>${isVirtual ? "Join link" : "Location"}:</strong> ${escapeHtml(interview.location_or_link)}</li>` : "") +
      `</ul>` +
      `<p>Add it to your calendar: <a href="${links.google}">Google Calendar</a> · <a href="${links.outlook}">Outlook</a></p>` +
      `<p>Need to change it? <a href="${APP_BASE_URL}/schedule/${token}">Reschedule or cancel</a>.</p>` +
      `<p>We're looking forward to speaking with you!<br/>The Spectrum Squad Team</p>`;
    return sendApplicantEmail(applicant, "Your Spectrum Squad interview is confirmed 🎉", html, { sentBy: "assistant" });
  }

  async function alertInterviewer(interview, applicant) {
    const who = interview.interviewer;
    await notify({
      type: "interview_scheduled",
      applicantId: applicant.id,
      positionId: applicant.position_id,
      title: "Interview scheduled",
      body: `${applicant.full_name} booked ${new Date(interview.scheduled_at).toLocaleString()} (${interview.mode}).`,
      severity: "info",
    });
    if (who && /@/.test(who)) {
      sendEmail({
        to: who,
        subject: `Interview scheduled: ${applicant.full_name}`,
        html: `<p>${escapeHtml(applicant.full_name)} booked an interview.</p>
               <ul><li><strong>When:</strong> ${escapeHtml(new Date(interview.scheduled_at).toLocaleString())}</li>
               <li><strong>Format:</strong> ${escapeHtml(interview.mode)}</li></ul>
               <p><a href="${APP_BASE_URL}/#/hr/candidate/${applicant.id}">Open candidate in the CRM</a></p>`,
        type: "recruiting",
      }).catch((e) => console.error("interviewer alert failed:", e.message));
    }
  }

  // Public booking: candidate picks an open slot.
  async function bookSlot(token, slotId) {
    const link = await dbGet("SELECT * FROM hr_schedule_links WHERE token = ?", [token]);
    if (!link) return { ok: false, error: "Invalid scheduling link" };
    const applicant = await dbGet("SELECT * FROM hr_applicants WHERE id = ?", [link.applicant_id]);
    if (!applicant) return { ok: false, error: "Applicant not found" };
    const slot = await dbGet("SELECT * FROM hr_interview_slots WHERE id = ?", [slotId]);
    if (!slot || slot.status !== "open") return { ok: false, error: "That time is no longer available" };

    // Cancel any existing scheduled interview (reschedule case).
    const existing = await dbGet("SELECT * FROM hr_interviews WHERE applicant_id = ? AND status = 'scheduled' ORDER BY id DESC LIMIT 1", [applicant.id]);
    if (existing) {
      await dbRun("UPDATE hr_interviews SET status = 'rescheduled', updated_at = ? WHERE id = ?", [nowISO(), existing.id]);
      if (existing.slot_id) await dbRun("UPDATE hr_interview_slots SET status = 'open', applicant_id = NULL WHERE id = ?", [existing.slot_id]);
    }

    await dbRun("UPDATE hr_interview_slots SET status = 'booked', applicant_id = ? WHERE id = ?", [applicant.id, slot.id]);
    const row = await dbRun(
      `INSERT INTO hr_interviews (applicant_id, slot_id, scheduled_at, duration_min, mode, location_or_link, interviewer, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?) RETURNING id`,
      [applicant.id, slot.id, slot.start_at, slot.duration_min, slot.mode, slot.location_or_link, slot.interviewer, nowISO(), nowISO()]
    );
    const interview = await dbGet("SELECT * FROM hr_interviews WHERE id = ?", [row.rows[0].id]);

    // Advance stage, stop automation, record.
    await dbRun("UPDATE hr_applicants SET stage = 'interview_scheduled', interview_at = ?, automation_paused = TRUE, updated_at = ? WHERE id = ?", [slot.start_at, nowISO(), applicant.id]);
    await dbRun(
      `INSERT INTO hr_applicant_stage_history (applicant_id, from_stage, to_stage, changed_by, note, changed_at)
       VALUES (?, ?, 'interview_scheduled', 'candidate', 'Booked interview', ?)`,
      [applicant.id, applicant.stage, nowISO()]
    );
    await cancelPendingFollowups(applicant.id);

    await sendInterviewConfirmation(applicant, interview, token, "confirmed").catch((e) => console.error("confirmation failed:", e.message));
    await alertInterviewer(interview, applicant);
    await audit("candidate", "interview_booked", "applicant", applicant.id, `at=${slot.start_at}`);
    return { ok: true, interview_id: interview.id, scheduled_at: slot.start_at };
  }

  async function cancelByToken(token) {
    const link = await dbGet("SELECT * FROM hr_schedule_links WHERE token = ?", [token]);
    if (!link) return { ok: false, error: "Invalid scheduling link" };
    const applicant = await dbGet("SELECT * FROM hr_applicants WHERE id = ?", [link.applicant_id]);
    const interview = await dbGet("SELECT * FROM hr_interviews WHERE applicant_id = ? AND status = 'scheduled' ORDER BY id DESC LIMIT 1", [link.applicant_id]);
    if (!interview) return { ok: false, error: "No scheduled interview to cancel" };
    await dbRun("UPDATE hr_interviews SET status = 'canceled', updated_at = ? WHERE id = ?", [nowISO(), interview.id]);
    if (interview.slot_id) await dbRun("UPDATE hr_interview_slots SET status = 'open', applicant_id = NULL WHERE id = ?", [interview.slot_id]);
    if (applicant) {
      await dbRun("UPDATE hr_applicants SET stage = 'responded', interview_at = NULL, updated_at = ? WHERE id = ?", [nowISO(), applicant.id]);
      await sendInterviewConfirmation(applicant, interview, token, "canceled").catch(() => {});
      await notify({
        type: "interview_canceled",
        applicantId: applicant.id,
        positionId: applicant.position_id,
        title: "Interview canceled",
        body: `${applicant.full_name} canceled their interview.`,
        severity: "warning",
        emailOwner: true,
      });
    }
    await audit("candidate", "interview_canceled", "applicant", link.applicant_id, "");
    return { ok: true };
  }

  // Background: send 24h and 2h reminders for upcoming interviews.
  async function processReminders() {
    const now = Date.now();
    const nowIso = nowISO();
    let sent = 0;
    const upcoming = await dbAll("SELECT * FROM hr_interviews WHERE status = 'scheduled' AND scheduled_at > ?", [nowIso]);
    for (const iv of upcoming) {
      const start = new Date(iv.scheduled_at).getTime();
      const hoursOut = (start - now) / 3600000;
      const applicant = await dbGet("SELECT * FROM hr_applicants WHERE id = ?", [iv.applicant_id]);
      if (!applicant || applicant.do_not_contact) continue;
      const token = await getOrCreateScheduleLink(applicant.id);
      const when = new Date(iv.scheduled_at).toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" });
      const remind = async (label) => {
        await sendApplicantEmail(applicant,
          `Reminder: your Spectrum Squad interview is ${label}`,
          `<p>Hi ${escapeHtml(firstNameOf(applicant.full_name))},</p><p>Just a friendly reminder that your interview is ${label} — <strong>${escapeHtml(when)}</strong>${iv.location_or_link ? ` (${escapeHtml(iv.location_or_link)})` : ""}.</p><p>Need to change it? <a href="${APP_BASE_URL}/schedule/${token}">Reschedule or cancel</a>.</p><p>See you soon!<br/>The Spectrum Squad Team</p>`,
          { sentBy: "assistant" });
        sent++;
      };
      if (hoursOut <= 2 && !iv.reminder_2_sent) {
        await remind("in about 2 hours");
        await dbRun("UPDATE hr_interviews SET reminder_2_sent = TRUE, reminder_24_sent = TRUE WHERE id = ?", [iv.id]);
      } else if (hoursOut <= 24 && !iv.reminder_24_sent) {
        await remind("tomorrow");
        await dbRun("UPDATE hr_interviews SET reminder_24_sent = TRUE WHERE id = ?", [iv.id]);
      }
    }
    return { sent };
  }

  // ============================ DAILY SUMMARY ============================
  async function buildDailySummary() {
    const since = new Date(Date.now() - 24 * 3600000).toISOString();
    const n = async (sql, p) => Number((await dbGet(sql, p)).n);
    const newApplicants = await n("SELECT COUNT(*) AS n FROM hr_applicants WHERE applied_at >= ?", [since]);
    const priority = await n("SELECT COUNT(*) AS n FROM hr_applicants WHERE priority_flag = TRUE AND stage NOT IN ('hired','not_selected','withdrawn')", []);
    const responses = await n("SELECT COUNT(*) AS n FROM hr_applicants WHERE last_response_at >= ?", [since]);
    const interviewsScheduled = await n("SELECT COUNT(*) AS n FROM hr_interviews WHERE created_at >= ? AND status = 'scheduled'", [since]);
    const awaitingDecision = await n("SELECT COUNT(*) AS n FROM hr_applicants WHERE stage IN ('interviewed','credentials_references','offer_approval')", []);
    const followupsDue = await n("SELECT COUNT(*) AS n FROM hr_applicants WHERE next_followup_at IS NOT NULL AND next_followup_at <= ?", [nowISO()]);
    const bottlenecks = (await dbAll(
      "SELECT stage, COUNT(*) AS n FROM hr_applicants WHERE stage NOT IN ('hired','not_selected','withdrawn','talent_pool') GROUP BY stage ORDER BY n DESC LIMIT 5",
      []
    )).map((r) => ({ stage: r.stage, count: Number(r.n) }));
    const waiting = await dbAll(
      `SELECT id, full_name FROM hr_applicants
         WHERE (priority_flag = TRUE OR match_category = 'qualified') AND last_contacted_at IS NULL
           AND applied_at <= ? AND stage NOT IN ('hired','not_selected','withdrawn') LIMIT 20`,
      [since]
    );
    const actions = [];
    if (waiting.length) actions.push(`Respond to ${waiting.length} qualified candidate(s) waiting over a day: ${waiting.map((w) => w.full_name).join(", ")}.`);
    if (priority) actions.push(`Review ${priority} priority BCBA candidate(s).`);
    if (followupsDue) actions.push(`${followupsDue} follow-up(s) are due.`);
    if (awaitingDecision) actions.push(`${awaitingDecision} candidate(s) are awaiting a decision.`);
    if (!actions.length) actions.push("No urgent recruiting actions today — nice work!");
    return { newApplicants, priority, responses, interviewsScheduled, awaitingDecision, followupsDue, bottlenecks, waiting, actions };
  }

  function dailySummaryHtml(s) {
    const stat = (n, l) => `<td style="padding:8px 14px;text-align:center"><div style="font-size:22px;font-weight:700;color:#1b2a6b">${n}</div><div style="font-size:12px;color:#6b6a86">${l}</div></td>`;
    return (
      `<h2 style="color:#1b2a6b">Your daily recruiting summary</h2>` +
      `<table style="border-collapse:collapse;margin:10px 0"><tr>${stat(s.newApplicants, "New applicants")}${stat(s.priority, "Priority BCBA")}${stat(s.responses, "Responses")}${stat(s.interviewsScheduled, "Interviews set")}${stat(s.awaitingDecision, "Awaiting decision")}${stat(s.followupsDue, "Follow-ups due")}</tr></table>` +
      `<h3 style="color:#1b2a6b;margin-bottom:4px">Recommended actions</h3><ul>${s.actions.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>` +
      (s.bottlenecks.length ? `<h3 style="color:#1b2a6b;margin-bottom:4px">Pipeline</h3><ul>${s.bottlenecks.map((b) => `<li>${escapeHtml(b.stage)}: ${b.count}</li>`).join("")}</ul>` : "") +
      `<p><a href="${APP_BASE_URL}/#/hr/command-center">Open the BCBA Command Center</a></p>`
    );
  }

  async function sendDailySummary(to) {
    const s = await buildDailySummary();
    await sendEmail({ to, subject: "Spectrum Squad — Daily Recruiting Summary", html: dailySummaryHtml(s), type: "hr_daily_summary" });
    return s;
  }

  // Sweep: send the summary once per day at the configured UTC hour.
  async function processDailySummary(force) {
    const enabled = (await getSetting("daily_summary_enabled", "true")) === "true";
    if (!force && !enabled) return { skipped: "disabled" };
    const to = await ownerEmail();
    if (!to) return { skipped: "no_owner" };
    if (!force) {
      const hour = parseInt(await getSetting("daily_summary_hour", "13"), 10); // default 13:00 UTC (~6-8am US)
      const d = new Date();
      if (d.getUTCHours() !== hour) return { skipped: "not_hour" };
      const today = d.toISOString().slice(0, 10);
      if ((await getSetting("daily_summary_last_sent", "")) === today) return { skipped: "already_sent" };
      await setSetting("daily_summary_last_sent", today);
    }
    const s = await sendDailySummary(to);
    await audit("system", "daily_summary_sent", null, null, `to=${to}`);
    return { ok: true, sent: true, summary: s };
  }

  // Credential expiration alerts (future HR): notify once/day for employee
  // credentials expiring within 30 days.
  async function processCredentialAlerts(force) {
    if (!force) {
      const today = new Date().toISOString().slice(0, 10);
      if ((await getSetting("cred_alert_last", "")) === today) return { skipped: "already" };
      await setSetting("cred_alert_last", today);
    }
    const soon = new Date(Date.now() + 30 * 86400000).toISOString();
    const rows = await dbAll(
      `SELECT c.credential_type, c.expiration_date, e.name AS emp_name
         FROM hr_employee_credentials c JOIN hr_employees e ON e.id = c.employee_id
         WHERE c.expiration_date IS NOT NULL AND c.expiration_date <= ? AND c.status = 'active'`,
      [soon]
    );
    for (const c of rows) {
      await notify({
        type: "credential_expiring",
        title: "Employee credential expiring soon",
        body: `${c.emp_name}: ${c.credential_type} expires ${c.expiration_date}.`,
        severity: "warning",
        emailOwner: true,
      });
    }
    return { ok: true, alerted: rows.length };
  }

  // ============================ EMPLOYEES + TIMECARDS (future HR) ============================
  // Foundation for the HR expansion. The timecard-verification workflow detects
  // anomalies, asks the employee to explain, and routes to a supervisor for
  // approval. It NEVER changes payroll or timecards automatically — approval is
  // an audit action only.
  function dtms(x) {
    if (x == null || x === "") return null;
    const t = new Date(x).getTime();
    return isNaN(t) ? null : t;
  }

  // entries: [{ date, clock_in, clock_out, hours?, breaks?:[{start,end}], break_minutes? }]
  function detectTimecardAnomalies(entries) {
    const flags = [];
    for (const e of entries || []) {
      const label = e.date || "a shift";
      if (!e.clock_in) flags.push({ flag_type: "missing_clock_in", detail: `No clock-in recorded for ${label}.` });
      if (!e.clock_out) flags.push({ flag_type: "missing_clock_out", detail: `No clock-out recorded for ${label}.` });
      let hours = typeof e.hours === "number" ? e.hours : null;
      const inMs = dtms(e.clock_in);
      const outMs = dtms(e.clock_out);
      if (hours == null && inMs != null && outMs != null) hours = (outMs - inMs) / 3600000;
      const hasBreak = (Array.isArray(e.breaks) && e.breaks.length) || Number(e.break_minutes) > 0;
      if (hours != null) {
        if (hours < 0) flags.push({ flag_type: "unusual", detail: `${label}: clock-out is before clock-in.` });
        else {
          if (hours > 6 && !hasBreak) flags.push({ flag_type: "missing_break", detail: `${label}: ${hours.toFixed(1)}h shift with no break recorded.` });
          if (hours > 12) flags.push({ flag_type: "unusual", detail: `${label}: unusually long shift (${hours.toFixed(1)}h).` });
        }
      }
    }
    return flags;
  }

  // ---- Rethink payroll-export (.xlsx) parsing ------------------------------
  // Self-contained: a minimal ZIP reader (xlsx is a zip) + a regex-based
  // worksheet reader. No external dependency, so it can never break the boot.
  function unzipXlsx(buffer) {
    const zlib = require("zlib");
    let eocd = -1;
    for (let i = buffer.length - 22; i >= 0; i--) {
      if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("This file isn't a readable .xlsx (no ZIP directory found).");
    const cdCount = buffer.readUInt16LE(eocd + 10);
    const cdOffset = buffer.readUInt32LE(eocd + 16);
    const files = {};
    let p = cdOffset;
    for (let n = 0; n < cdCount; n++) {
      if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) break;
      const method = buffer.readUInt16LE(p + 10);
      const compSize = buffer.readUInt32LE(p + 20);
      const fnLen = buffer.readUInt16LE(p + 28);
      const extraLen = buffer.readUInt16LE(p + 30);
      const commentLen = buffer.readUInt16LE(p + 32);
      const localOffset = buffer.readUInt32LE(p + 42);
      const name = buffer.toString("utf8", p + 46, p + 46 + fnLen);
      const lhFnLen = buffer.readUInt16LE(localOffset + 26);
      const lhExtraLen = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lhFnLen + lhExtraLen;
      const comp = buffer.slice(dataStart, dataStart + compSize);
      try {
        if (method === 0) files[name] = comp;
        else if (method === 8) files[name] = zlib.inflateRawSync(comp);
      } catch (e) { /* skip unreadable entry */ }
      p += 46 + fnLen + extraLen + commentLen;
    }
    return files;
  }

  function xmlUnescape(s) {
    return String(s).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(parseInt(d, 10)));
  }
  function colToIndex(ref) {
    const m = ref.match(/^([A-Z]+)/);
    if (!m) return 0;
    let n = 0;
    for (const c of m[1]) n = n * 26 + (c.charCodeAt(0) - 64);
    return n - 1;
  }
  function parseSheetRows(xml, shared) {
    if (!xml) return [];
    const rows = [];
    const rre = /<row[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rre.exec(xml))) {
      const cells = [];
      const cre = /<c\s+r="([A-Z]+\d+)"([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm;
      while ((cm = cre.exec(rm[1]))) {
        const ci = colToIndex(cm[1]);
        const attrs = cm[2] || "", inner = cm[3] || "";
        const tMatch = attrs.match(/t="([^"]+)"/);
        const t = tMatch ? tMatch[1] : "";
        const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
        let val = "";
        if (t === "s" && vMatch) val = shared[parseInt(vMatch[1], 10)] || "";
        else if (t === "inlineStr") { const im = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/); val = im ? xmlUnescape(im[1]) : ""; }
        else if (vMatch) val = vMatch[1];
        cells[ci] = val;
      }
      rows.push(cells);
    }
    return rows;
  }
  function parseXlsx(buffer) {
    const files = unzipXlsx(buffer);
    const dec = (b) => (b ? b.toString("utf8") : "");
    const shared = [];
    const sharedXml = dec(files["xl/sharedStrings.xml"]);
    const sre = /<si>([\s\S]*?)<\/si>/g; let sm;
    while ((sm = sre.exec(sharedXml))) {
      let s = ""; const tre = /<t[^>]*>([\s\S]*?)<\/t>/g; let tm;
      while ((tm = tre.exec(sm[1]))) s += tm[1];
      shared.push(xmlUnescape(s));
    }
    const rels = dec(files["xl/_rels/workbook.xml.rels"]);
    const relMap = {};
    let rr; const relRe = /<Relationship\b([^>]*)\/>/g;
    while ((rr = relRe.exec(rels))) {
      const a = rr[1];
      const id = (a.match(/Id="([^"]+)"/) || [])[1];
      const target = (a.match(/Target="([^"]+)"/) || [])[1];
      if (id && target) relMap[id] = target;
    }
    const wb = dec(files["xl/workbook.xml"]);
    const sheets = {};
    let sh; const shRe = /<sheet\b([^>]*)\/>/g;
    while ((sh = shRe.exec(wb))) {
      const a = sh[1];
      const name = (a.match(/name="([^"]+)"/) || [])[1];
      const rid = (a.match(/r:id="([^"]+)"/) || [])[1];
      if (!name || !rid) continue;
      let target = relMap[rid] || "";
      if (target && !target.startsWith("xl/")) target = "xl/" + target.replace(/^\//, "");
      sheets[xmlUnescape(name)] = parseSheetRows(dec(files[target]), shared);
    }
    return sheets;
  }

  function excelSerialToDate(serial) {
    const n = parseFloat(serial);
    if (!isFinite(n) || n <= 0) return null;
    return new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000));
  }
  function fmtServiceDate(serial) {
    const d = excelSerialToDate(serial);
    if (!d) return String(serial || "");
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const mons = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${days[d.getUTCDay()]}, ${mons[d.getUTCMonth()]} ${d.getUTCDate()}`;
  }

  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  // "Billable" vs "Non-Billable" is the export's own word (see fin-ledger.js) --
  // paid hours and billable hours are not the same thing and must not be
  // silently merged. Returns true / false, or null when the export gave us
  // nothing to go on (blank column, or an appt type we don't recognise). Null
  // stays null: an unlabelled hour is never quietly counted as billable.
  function classifyBillable(apptType) {
    const s = String(apptType == null ? "" : apptType).trim();
    if (!s) return null;
    if (/non[-\s_]*billable/i.test(s)) return false;
    if (/billable/i.test(s)) return true;
    return null;
  }

  // The one place hours get bucketed. Everything that renders a timecard (PDF,
  // employee page, admin preview) goes through this so the numbers can't drift
  // between them. has_split is false for timecards imported before the Appt
  // Type column existed -- those still render as a single undivided table.
  function timecardTotals(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const billable = [], nonBillable = [], unclassified = [];
    list.forEach((e, i) => {
      const row = Object.assign({}, e, { _i: i });
      const cls = (e && (e.billable === true || e.billable === false)) ? e.billable : classifyBillable(e && e.appt_type);
      row.billable = cls;
      if (cls === true) billable.push(row);
      else if (cls === false) nonBillable.push(row);
      else unclassified.push(row);
    });
    const sum = (arr) => round2(arr.reduce((s, e) => s + (Number(e && e.hours) || 0), 0));
    return {
      billable, non_billable: nonBillable, unclassified,
      has_split: (billable.length + nonBillable.length) > 0,
      billable_hours: sum(billable),
      non_billable_hours: sum(nonBillable),
      unclassified_hours: sum(unclassified),
      total_hours: sum(list),
    };
  }

  // Everything an admin needs to eyeball one timecard before it's sent, with
  // the hours already split. Read-only -- builds nothing and sends nothing.
  function shapeTimecardPreview(tc, emp, flags) {
    const entries = parseJson(tc.entries, []);
    const t = timecardTotals(entries);
    return {
      id: tc.id,
      status: tc.status,
      employee_id: tc.employee_id,
      employee_name: emp ? emp.name : null,
      employee_email: emp ? emp.email : null,
      role_title: emp ? emp.role_title || "" : "",
      has_email: !!(emp && emp.email),
      already_sent_at: tc.verification_requested_at || null,
      admin_edited_at: tc.admin_edited_at || null,
      admin_edited_by: tc.admin_edited_by || null,
      pay_period_start: tc.pay_period_start,
      pay_period_end: tc.pay_period_end,
      entries,
      flags: flags || [],
      open_flags: (flags || []).filter((f) => f.status === "open" || f.status === "explained").length,
      shifts: entries.length,
      has_split: t.has_split,
      billable: t.billable,
      non_billable: t.non_billable,
      unclassified: t.unclassified,
      billable_hours: t.billable_hours,
      non_billable_hours: t.non_billable_hours,
      unclassified_hours: t.unclassified_hours,
      total_hours: t.total_hours,
      subject: "✨ Your timecard is ready to review — Spectrum Squad",
    };
  }

  // Turn a parsed workbook into per-employee timecard payloads. Reads the
  // "Summary" sheet for the employee roster + period, and "Time Sheet Entries"
  // for the per-shift detail. Pay/rate columns are intentionally ignored — the
  // employee is verifying HOURS, not wages.
  function buildPayrollTimecards(sheets) {
    const summary = sheets["Summary"] || [];
    const meta = summary[0] || [];
    // Row 0: ["Start Date:", "MM/DD/YYYY", "", "End Date:", "MM/DD/YYYY", ...]
    let periodStart = "", periodEnd = "";
    for (let i = 0; i < meta.length; i++) {
      if (/start date/i.test(String(meta[i]))) periodStart = meta[i + 1] || "";
      if (/end date/i.test(String(meta[i]))) periodEnd = meta[i + 1] || "";
    }
    // Header row is the first row whose first cell is "Id".
    let hIdx = summary.findIndex((r) => String((r || [])[0] || "").trim().toLowerCase() === "id");
    if (hIdx < 0) hIdx = 1;
    const header = summary[hIdx] || [];
    const col = (name) => header.findIndex((h) => String(h || "").trim().toLowerCase() === name.toLowerCase());
    const cId = col("Id"), cFirst = col("FirstName"), cLast = col("LastName"), cReg = col("RegHours"), cOt1 = col("OT1Hours"), cOt2 = col("OT2Hours"), cTotal = col("TotalPay");

    const employees = {};
    for (let i = hIdx + 1; i < summary.length; i++) {
      const r = summary[i] || [];
      const id = String(r[cId] || "").trim();
      if (!id) continue;
      const reg = parseFloat(r[cReg]) || 0;
      const ot1 = cOt1 >= 0 ? (parseFloat(r[cOt1]) || 0) : 0;
      const ot2 = cOt2 >= 0 ? (parseFloat(r[cOt2]) || 0) : 0;
      employees[id] = {
        rethink_id: id,
        first: r[cFirst] || "",
        last: r[cLast] || "",
        name: `${r[cFirst] || ""} ${r[cLast] || ""}`.trim(),
        reg_hours: reg,
        ot_hours: ot1 + ot2,
        total_hours: Math.round((reg + ot1 + ot2) * 100) / 100,
        entries: [],
      };
    }

    // Per-shift detail.
    const tse = sheets["Time Sheet Entries"] || [];
    let tHdr = tse.findIndex((r) => String((r || [])[1] || "").trim().toLowerCase() === "id");
    if (tHdr < 0) tHdr = 1;
    const th = tse[tHdr] || [];
    const tcol = (name) => th.findIndex((h) => String(h || "").trim().toLowerCase() === name.toLowerCase());
    const eId = tcol("Id"), eAlert = tcol("Alerts"), eStart = tcol("StartTime"), eEnd = tcol("EndTime"),
      eDate = tcol("DateOfService"), eActIn = tcol("ActualStartTime"), eActOut = tcol("ActualEndTime"),
      eDur = tcol("Duration"), eVer = tcol("StaffVerified"), eStatus = tcol("ApptStatus");
    // "Appt Type" carries the export's own Billable / Non-Billable wording. The
    // header is spelled with a space in the billing export and without one in
    // some payroll exports, so accept either. Same vocabulary as fin-ledger.js.
    let eType = tcol("Appt Type");
    if (eType < 0) eType = tcol("ApptType");
    if (eType < 0) eType = tcol("AppointmentType");
    for (let i = tHdr + 1; i < tse.length; i++) {
      const r = tse[i] || [];
      const id = String(r[eId] || "").trim();
      if (!id || !employees[id]) continue;
      const scheduled = (r[eStart] || r[eEnd]) ? `${r[eStart] || "?"} – ${r[eEnd] || "?"}` : "";
      const apptType = eType >= 0 ? String(r[eType] == null ? "" : r[eType]).trim() : "";
      employees[id].entries.push({
        date: fmtServiceDate(r[eDate]),
        scheduled,
        clock_in: r[eActIn] || "",
        clock_out: r[eActOut] || "",
        hours: Math.round((parseFloat(r[eDur]) || 0) * 100) / 100,
        verified: r[eVer] || "",
        alert: eAlert >= 0 ? (r[eAlert] || "") : "",
        appt_status: eStatus >= 0 ? (r[eStatus] || "") : "",
        appt_type: apptType,
        billable: classifyBillable(apptType),
      });
    }
    // Roll the billable split up to the employee so the import preview can show
    // it without re-reading every entry.
    for (const emp of Object.values(employees)) {
      const t = timecardTotals(emp.entries);
      emp.billable_hours = t.billable_hours;
      emp.non_billable_hours = t.non_billable_hours;
      emp.unclassified_hours = t.unclassified_hours;
      emp.has_split = t.has_split;
    }
    return { period_start: periodStart, period_end: periodEnd, has_appt_type: eType >= 0, employees: Object.values(employees) };
  }

  async function importTimecard(input, actor) {
    const entries = Array.isArray(input.entries) ? input.entries : [];
    const flags = detectTimecardAnomalies(entries);
    const status = flags.length ? "flagged" : "imported";
    const row = await dbRun(
      `INSERT INTO hr_timecards (employee_id, source, pay_period_start, pay_period_end, raw_json, entries, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        input.employee_id || null,
        input.source || "manual",
        input.pay_period_start || null,
        input.pay_period_end || null,
        JSON.stringify(input.raw || input),
        JSON.stringify(entries),
        status,
        nowISO(),
      ]
    );
    const timecardId = row.rows[0].id;
    for (const f of flags) {
      await dbRun(
        `INSERT INTO hr_timecard_flags (timecard_id, flag_type, detail, status, created_at) VALUES (?, ?, ?, 'open', ?)`,
        [timecardId, f.flag_type, f.detail, nowISO()]
      );
    }
    await audit(actor, "timecard_imported", "timecard", timecardId, `source=${input.source || "manual"} flags=${flags.length}`);
    return { id: timecardId, flags: flags.length, status };
  }

  async function getOrCreateTimecardLink(timecardId) {
    let row = await dbGet("SELECT token FROM hr_timecard_links WHERE timecard_id = ? LIMIT 1", [timecardId]);
    if (row) return row.token;
    const token = newToken();
    await dbRun("INSERT INTO hr_timecard_links (token, timecard_id, created_at) VALUES (?, ?, ?)", [token, timecardId, nowISO()]);
    return token;
  }

  async function employeeName(employeeId) {
    if (!employeeId) return "An employee";
    const e = await dbGet("SELECT name FROM hr_employees WHERE id = ?", [employeeId]);
    return e && e.name ? e.name : "An employee";
  }

  // A small billable / non-billable summary strip for the email. Renders
  // nothing when the timecard predates the Appt Type column, so old timecards
  // are never shown a misleading "0 billable".
  function timecardEmailTotals(t) {
    if (!t || !t.has_split) return "";
    const chip = (label, val, color, bg) =>
      `<td style="padding:0 4px;"><div style="background:${bg};border-radius:14px;padding:10px 6px;">` +
      `<div style="font-size:19px;font-weight:700;color:${color};line-height:1.1;">${val}</div>` +
      `<div style="font-size:10.5px;color:#6b6a86;text-transform:uppercase;letter-spacing:.4px;">${label}</div></div></td>`;
    return `<table role="presentation" style="width:100%;border-collapse:separate;margin:0 0 18px;"><tr>` +
      chip("Billable", t.billable_hours, "#1b2a6b", "#eef1fb") +
      chip("Non-billable", t.non_billable_hours, "#946213", "#fdf4e6") +
      (t.unclassified_hours ? chip("Not labeled", t.unclassified_hours, "#6b6a86", "#f4f1ea") : "") +
      chip("Total", t.total_hours, "#177a3c", "#e9f9ee") +
      `</tr></table>`;
  }

  // The cute timecard-review email (shared by single send + send-all).
  function timecardEmailHtml(firstName, period, url, totals) {
    return `
<div style="background:#f4f1ea;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:22px;overflow:hidden;border:1px solid #ece7db;box-shadow:0 10px 30px rgba(41,34,92,.12);">
    <div style="background:linear-gradient(135deg,#1b2a6b,#3f56b5);color:#fff;padding:26px;">
      <div style="font-size:22px;">✨</div>
      <h1 style="margin:6px 0 2px;font-size:21px;">Hi ${escapeHtml(firstName)} — your timecard's ready!</h1>
      <p style="margin:0;opacity:.9;font-size:14px;">Take a quick look at your hours, then tap Accept — or ask for an edit if something's off.</p>
      <div style="display:inline-block;margin-top:12px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.25);padding:5px 12px;border-radius:999px;font-size:12.5px;font-weight:600;">Pay period · ${escapeHtml(period)}</div>
    </div>
    <div style="padding:26px;text-align:center;">
      ${timecardEmailTotals(totals)}
      <p style="color:#2b2a35;font-size:15px;margin:0 0 20px;">It takes about 30 seconds. Your review helps us get payroll right.</p>
      <a href="${url}" style="display:inline-block;background:#22a565;color:#fff;text-decoration:none;border-radius:999px;padding:14px 28px;font-size:16px;font-weight:700;">Review my timecard →</a>
      <p style="color:#8a8797;font-size:12px;margin:22px 0 0;">Or paste this link into your browser:<br>${url}</p>
    </div>
  </div>
  <p style="text-align:center;color:#8a8797;font-size:11.5px;margin-top:14px;">Spectrum Squad · Reviewing never changes your pay automatically.</p>
</div>`;
  }

  // Creates/reuses the token, emails the employee (if they have an email), and
  // marks the timecard as verification-requested. Returns { url, sent, reason }.
  async function sendTimecardVerification(tc) {
    const token = await getOrCreateTimecardLink(tc.id);
    const url = `${APP_BASE_URL}/verify-timecard/${token}`;
    await dbRun("UPDATE hr_timecards SET verification_requested_at = ? WHERE id = ?", [nowISO(), tc.id]);
    const emp = tc.employee_id ? await dbGet("SELECT name, email FROM hr_employees WHERE id = ?", [tc.employee_id]) : null;
    if (!emp || !emp.email) return { url, sent: false, reason: "no_email" };
    const period = `${tc.pay_period_start || ""} – ${tc.pay_period_end || ""}`;
    await sendEmail({
      to: emp.email,
      subject: "✨ Your timecard is ready to review — Spectrum Squad",
      html: timecardEmailHtml(firstNameOf(emp.name), period, url, timecardTotals(parseJson(tc.entries, []))),
      type: "hr_timecard",
    }).catch((e) => console.error("timecard verify email failed:", e.message));
    return { url, sent: true };
  }

  // Formats an ISO datetime (or plain time) into a friendly "8:00 AM".
  function prettyTime(v) {
    if (!v) return "—";
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    let h = d.getHours(), m = d.getMinutes();
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${String(m).padStart(2, "0")} ${ap}`;
  }

  // Generates a signed timecard PDF and stores it on the employee's card
  // (hr_documents). Returns the new document id. pdfkit is required lazily so a
  // missing dependency can never crash the accept flow.
  async function saveTimecardPdf(tc, signedName) {
    const PDFDocument = require("pdfkit");
    const entries = parseJson(tc.entries, []);
    const emp = tc.employee_id ? await dbGet("SELECT name, role_title FROM hr_employees WHERE id = ?", [tc.employee_id]) : null;
    const empName = emp ? emp.name : "Employee";
    const t = timecardTotals(entries);
    const total = t.total_hours;
    const storedName = `${crypto.randomBytes(10).toString("hex")}.pdf`;
    const full = path.join(RESUME_DIR, storedName);

    await new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: "LETTER", margin: 50 });
        const stream = fs.createWriteStream(full);
        stream.on("finish", resolve);
        stream.on("error", reject);
        doc.pipe(stream);

        doc.fillColor("#1b2a6b").fontSize(20).text("Spectrum Squad — Timecard", { align: "left" });
        doc.moveDown(0.3);
        doc.fillColor("#201a4d").fontSize(13).text(empName + (emp && emp.role_title ? `  ·  ${emp.role_title}` : ""));
        doc.fillColor("#6b6a86").fontSize(11).text(`Pay period: ${tc.pay_period_start || "?"} to ${tc.pay_period_end || "?"}`);
        doc.moveDown(0.8);

        const x0 = 50, cols = [90, 150, 150, 60];
        const width = cols.reduce((a, b) => a + b, 0);
        const headers = ["Date", "Scheduled", "Clocked", "Hours"];
        let y = doc.y;
        const pageBreak = () => { if (y > 690) { doc.addPage(); y = 50; } };

        // One block = an optional section heading, the column headers, the rows,
        // and a subtotal. Billable and Non-Billable are never mixed in a block.
        const drawBlock = (title, rows, subtotalLabel) => {
          if (!rows.length) return;
          pageBreak();
          if (title) {
            doc.fillColor("#1b2a6b").fontSize(11).text(title, x0, y, { width });
            y += 16;
          }
          doc.fontSize(10).fillColor("#6b6a86");
          let cx = x0;
          headers.forEach((h, i) => { doc.text(h, cx, y, { width: cols[i] }); cx += cols[i]; });
          y += 16;
          doc.moveTo(x0, y - 4).lineTo(x0 + width, y - 4).strokeColor("#e5e7eb").stroke();
          doc.fillColor("#201a4d").fontSize(10);
          rows.forEach((e) => {
            pageBreak();
            const sched = e.scheduled || "—";
            const clocked = `${prettyTime(e.clock_in)} – ${prettyTime(e.clock_out)}`;
            const row = [String(e.date || "—"), sched, clocked, String(e.hours == null ? "—" : e.hours)];
            let rx = x0;
            row.forEach((val, i) => { doc.text(val, rx, y, { width: cols[i] }); rx += cols[i]; });
            y += 16;
          });
          if (subtotalLabel) {
            y += 4;
            doc.moveTo(x0, y).lineTo(x0 + width, y).strokeColor("#e5e7eb").stroke();
            y += 8;
            doc.fillColor("#3f56b5").fontSize(10.5).text(subtotalLabel, x0, y, { width });
            y += 20;
          }
        };

        if (t.has_split) {
          drawBlock("Billable hours", t.billable, `Billable subtotal: ${t.billable_hours}`);
          drawBlock("Non-billable hours", t.non_billable, `Non-billable subtotal: ${t.non_billable_hours}`);
          drawBlock("Unclassified hours", t.unclassified, `Unclassified subtotal: ${t.unclassified_hours}`);
        } else {
          drawBlock("", entries, null);
          y += 6;
          doc.moveTo(x0, y).lineTo(x0 + width, y).strokeColor("#e5e7eb").stroke();
          y += 10;
        }
        pageBreak();
        doc.fillColor("#1b2a6b").fontSize(12).text(`Total hours: ${total}`, x0, y);
        doc.moveDown(2);
        doc.fillColor("#201a4d").fontSize(11).text(`Accepted & electronically signed by: ${signedName}`);
        doc.fillColor("#6b6a86").fontSize(10).text(`Signed on ${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} (Pacific)`);
        doc.end();
      } catch (err) {
        reject(err);
      }
    });

    const filename = `Timecard_${empName.replace(/[^A-Za-z0-9]+/g, "_")}_${tc.pay_period_end || "period"}.pdf`;
    const row = await dbRun(
      `INSERT INTO hr_documents (employee_id, kind, filename, stored_name, mime_type, created_at)
       VALUES (?, 'timecard', ?, ?, 'application/pdf', ?) RETURNING id`,
      [tc.employee_id || null, filename, storedName, nowISO()]
    );
    return row.rows[0].id;
  }

  // ============================ OFFERS ============================
  function offerIsExpired(o) {
    return o && o.status === "sent" && o.expires_at && new Date(o.expires_at).getTime() < Date.now();
  }
  function shapeOfferPublic(o, applicant, position) {
    return {
      first_name: firstNameOf(applicant.full_name),
      full_name: applicant.full_name,
      job_title: o.job_title || (position ? position.title : "the role"),
      employment_type: o.employment_type,
      comp_amount: o.comp_amount,
      comp_unit: o.comp_unit,
      comp_notes: o.comp_notes,
      start_date: o.start_date,
      supervisor: o.supervisor,
      location: o.location || (position ? position.locations : ""),
      highlights: parseJson(o.highlights, []),
      custom_message: o.custom_message,
      expires_at: o.expires_at,
      status: offerIsExpired(o) ? "expired" : o.status,
      signed_name: o.signed_name,
    };
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
    if (pathname.startsWith("/schedule/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(scheduleHtml());
      return true;
    }
    if (pathname.startsWith("/verify-timecard/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(timecardVerifyHtml());
      return true;
    }
    if (pathname.startsWith("/offer/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(offerHtml());
      return true;
    }
    if (pathname === "/staff-availability" || pathname.startsWith("/staff-availability/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(staffAvailabilityHtml());
      return true;
    }
    return false;
  }

  // Public, client-rendered availability / scheduling form for a new hire.
  // Fetches the employee by token, lets them mark a weekly availability grid
  // and add scheduling stipulations, then POSTs back. No ${} interpolation on
  // purpose — everything comes from the token'd API call.
  function staffAvailabilityHtml() {
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Your Availability — Spectrum Squad</title>
<style>
  :root{--navy:#1b2a6b;--gold:#e0a430;--teal:#5fa8a0;--surface:#fff;--text:#201a4d;--muted:#6b6a86;}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--text);
    background:linear-gradient(160deg,#efe9ff 0%,#f7f8fb 45%,#e8f5f2 100%);min-height:100vh}
  .wrap{max-width:720px;margin:0 auto;padding:26px 18px 60px}
  .card{background:var(--surface);border:1px solid #e7e4f5;border-radius:20px;padding:24px;margin:18px 0;
    box-shadow:0 18px 50px rgba(41,34,92,.12)}
  h1{font-size:24px;margin:6px 0;color:var(--navy)} h2{color:var(--navy);font-size:18px;margin:0 0 6px}
  p.sub{color:var(--muted);margin:4px 0 16px}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th,td{border:1px solid #e7e4f5;padding:4px;text-align:center}
  th{background:#f6f4ff;color:var(--navy);font-weight:700}
  td.slot{cursor:pointer;user-select:none;background:#fff}
  td.slot.on{background:var(--teal);color:#fff;font-weight:700}
  td.daylabel{background:#faf9ff;font-weight:700;color:var(--navy);text-align:left;padding-left:8px}
  label.f{display:block;font-weight:600;margin:12px 0 4px;color:var(--navy)}
  textarea,input[type=text]{width:100%;border:1px solid #d7d3ee;border-radius:10px;padding:10px;font-size:15px;font-family:inherit}
  .chk{display:flex;align-items:center;gap:8px;margin:8px 0;font-size:15px}
  .btn{display:block;width:100%;background:linear-gradient(135deg,var(--gold),#f0b64a);color:#3a2a00;border:none;
    border-radius:14px;padding:16px;font-size:18px;font-weight:800;cursor:pointer;box-shadow:0 8px 20px rgba(224,164,48,.4);
    margin-top:18px}
  .btn[disabled]{opacity:.6;cursor:default}
  .hint{font-size:13px;color:var(--muted);margin:6px 0}
  .ok{text-align:center;padding:40px 10px}
  .ok .big{font-size:52px}
</style></head>
<body>
<div class="wrap" id="app"><div class="card"><p>Loading…</p></div></div>
<script>
(function(){
  var app=document.getElementById('app');
  var params=new URLSearchParams(location.search);
  var token=params.get('token')||'';
  var DAYS=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  var BLOCKS=[['morning','Morning (8a–12p)'],['afternoon','Afternoon (12p–4p)'],['evening','Evening (4p–7p)']];
  var grid={};
  function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}
  function err(msg){app.innerHTML='<div class="card"><h1>Hmm…</h1><p class="sub">'+esc(msg)+'</p></div>';}
  fetch('/api/hr/public/staff-availability?token='+encodeURIComponent(token))
    .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
    .then(function(res){
      if(!res.ok){return err(res.j.error||'This link is invalid or has expired.');}
      var d=res.j;
      if(d.availability&&typeof d.availability==='object'){grid=d.availability;}
      render(d);
    }).catch(function(){err('Could not load the form. Please try again.');});

  function render(d){
    var rows='';
    DAYS.forEach(function(day){
      rows+='<tr><td class="daylabel">'+day+'</td>';
      BLOCKS.forEach(function(b){
        var on=grid[day]&&grid[day][b[0]];
        rows+='<td class="slot'+(on?' on':'')+'" data-day="'+day+'" data-block="'+b[0]+'">'+(on?'✓':'')+'</td>';
      });
      rows+='</tr>';
    });
    var head='<tr><th>Day</th>'+BLOCKS.map(function(b){return '<th>'+b[1]+'</th>';}).join('')+'</tr>';
    var st=(d.stipulations&&typeof d.stipulations==='object')?d.stipulations:{};
    app.innerHTML=
      '<div class="card">'+
        '<h1>Welcome, '+esc(d.name||'')+'! 🎉</h1>'+
        '<p class="sub">Let us know when you\\'re available so we can build your schedule. Tap the time blocks that work for you.</p>'+
        '<h2>Weekly availability</h2>'+
        '<div style="overflow-x:auto"><table>'+head+rows+'</table></div>'+
        '<p class="hint">Tap a cell to toggle it on/off.</p>'+
      '</div>'+
      '<div class="card">'+
        '<h2>Transportation & scheduling notes</h2>'+
        '<label class="f">How will you get to sessions?</label>'+
        '<input type="text" id="transport" value="'+esc(st.transport||'')+'" placeholder="e.g. My own car, public transit, rides"/>'+
        '<label class="f">Earliest you can start each day</label>'+
        '<input type="text" id="earliest" value="'+esc(st.earliest||'')+'" placeholder="e.g. 9:00am after school drop-off"/>'+
        '<label class="f">Any days or times you absolutely cannot work?</label>'+
        '<textarea id="restrictions" rows="3" placeholder="e.g. No Fridays, classes Tue/Thu evenings">'+esc(st.restrictions||'')+'</textarea>'+
        '<label class="f">Preferred weekly hours</label>'+
        '<input type="text" id="hours" value="'+esc(st.hours||'')+'" placeholder="e.g. 25–30 hours"/>'+
        '<label class="f">Anything else we should know?</label>'+
        '<textarea id="notes" rows="3" placeholder="Optional">'+esc(st.notes||'')+'</textarea>'+
        '<button class="btn" id="submit">Submit my availability</button>'+
      '</div>';
    Array.prototype.forEach.call(document.querySelectorAll('td.slot'),function(td){
      td.addEventListener('click',function(){
        var day=td.getAttribute('data-day'),block=td.getAttribute('data-block');
        grid[day]=grid[day]||{};
        grid[day][block]=!grid[day][block];
        td.classList.toggle('on',grid[day][block]);
        td.textContent=grid[day][block]?'✓':'';
      });
    });
    document.getElementById('submit').addEventListener('click',submit);
  }
  function submit(){
    var btn=document.getElementById('submit');
    btn.disabled=true;btn.textContent='Submitting…';
    var stip={
      transport:val('transport'),earliest:val('earliest'),
      restrictions:val('restrictions'),hours:val('hours'),notes:val('notes')
    };
    fetch('/api/hr/public/staff-availability',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token:token,availability:grid,stipulations:stip})
    }).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
      .then(function(res){
        if(!res.ok){btn.disabled=false;btn.textContent='Submit my availability';return err(res.j.error||'Could not submit.');}
        app.innerHTML='<div class="card ok"><div class="big">✅</div><h1>Thank you!</h1>'+
          '<p class="sub">Your availability has been sent to the Spectrum Squad team. We\\'ll be in touch about your schedule soon.</p></div>';
      }).catch(function(){btn.disabled=false;btn.textContent='Submit my availability';err('Could not submit. Please try again.');});
  }
  function val(id){var el=document.getElementById(id);return el?el.value.trim():'';}
})();
</script>
</body></html>`;
  }

  // The cute, interactive offer page. Fully client-rendered (no ${} in this
  // template on purpose) — it fetches the offer by token and walks the
  // candidate through an envelope reveal, the offer, a type-to-sign accept, and
  // a confetti celebration.
  function offerHtml() {
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Your offer — Spectrum Squad</title>
<style>
  :root{--navy:#1b2a6b;--navy-dark:#101c4d;--gold:#e0a430;--teal:#5fa8a0;--surface:#fff;--text:#201a4d;--muted:#6b6a86;}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--text);
    background:linear-gradient(160deg,#efe9ff 0%,#f7f8fb 45%,#e8f5f2 100%);min-height:100vh;overflow-x:hidden}
  #confetti{position:fixed;inset:0;pointer-events:none;z-index:50}
  .balloons{position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0}
  .balloon{position:absolute;bottom:-80px;font-size:34px;animation:float linear infinite;opacity:.5}
  @keyframes float{to{transform:translateY(-115vh) rotate(20deg)}}
  .wrap{position:relative;z-index:10;max-width:640px;margin:0 auto;padding:26px 18px 60px}
  .center{text-align:center}
  .env{cursor:pointer;user-select:none;margin:36px auto;width:260px;max-width:80%;transition:transform .3s}
  .env:hover{transform:scale(1.04)}
  .env .flap{font-size:120px;line-height:1;filter:drop-shadow(0 10px 18px rgba(41,34,92,.25))}
  .pulse{animation:pulse 1.6s ease-in-out infinite}
  @keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}
  h1{font-size:26px;margin:10px 0} h2{color:var(--navy)}
  .tap{display:inline-block;margin-top:6px;color:var(--navy);font-weight:700}
  .card{background:var(--surface);border:1px solid #e7e4f5;border-radius:20px;padding:24px;margin:18px 0;
    box-shadow:0 18px 50px rgba(41,34,92,.14);animation:rise .6s cubic-bezier(.2,.8,.2,1) both}
  @keyframes rise{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}
  .role{font-size:24px;font-weight:800;color:var(--navy);text-align:center;margin:4px 0 2px}
  .sub{text-align:center;color:var(--muted);margin-bottom:14px}
  .terms{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0}
  .term{background:#f6f4ff;border-radius:14px;padding:12px 14px}
  .term .k{font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
  .term .v{font-size:17px;font-weight:700;color:var(--navy);margin-top:2px}
  .term.wide{grid-column:1 / -1}
  .chips{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin:6px 0 4px}
  .chip{background:#fff4dd;color:#a56b00;border-radius:20px;padding:6px 12px;font-size:13.5px;font-weight:600;
    animation:pop .4s both}
  @keyframes pop{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}
  .msg{background:#eef7f5;border-left:4px solid var(--teal);border-radius:10px;padding:12px 14px;margin:14px 0;white-space:pre-wrap}
  .btn{display:block;width:100%;background:linear-gradient(135deg,var(--gold),#f0b64a);color:#3a2a00;border:none;
    border-radius:14px;padding:16px;font-size:18px;font-weight:800;cursor:pointer;box-shadow:0 8px 20px rgba(224,164,48,.4);
    transition:transform .15s} .btn:hover{transform:translateY(-2px)} .btn[disabled]{opacity:.6;cursor:default;transform:none}
  .btn-navy{background:linear-gradient(135deg,var(--navy),#4a3f96);color:#fff;box-shadow:0 8px 20px rgba(41,34,92,.35)}
  input.sign{width:100%;padding:14px;border:2px dashed var(--navy);border-radius:12px;font-size:20px;
    font-family:"Segoe Script","Brush Script MT",cursive;text-align:center;margin:10px 0}
  .muted{color:var(--muted);font-size:13.5px} .link{background:none;border:none;color:var(--muted);text-decoration:underline;cursor:pointer;font-size:13.5px;margin-top:14px}
  .countdown{text-align:center;color:#b4571a;font-size:13.5px;font-weight:600;margin-top:8px}
  .big{font-size:64px} .err{color:#b91c1c;text-align:center}
  .hidden{display:none}
  body::before{content:"";position:fixed;inset:0;background:url('/logo.png') center 32% no-repeat;background-size:min(62vw,420px);opacity:.05;pointer-events:none;z-index:1}
  .brandbar{text-align:center;margin-bottom:8px}
  .brandbar img{max-width:220px;width:58%;height:auto}
  @media(max-width:520px){.terms{grid-template-columns:1fr}}
</style></head>
<body>
<canvas id="confetti"></canvas>
<div class="balloons" id="balloons"></div>
<div class="wrap"><div class="brandbar"><img src="/logo.png" alt="Spectrum Squad"/></div><div id="app"><p class="center muted">Loading your offer…</p></div></div>
<script>
(function(){
  var app=document.getElementById("app");
  var token=location.pathname.split("/offer/")[1]||"";
  var data=null;
  function esc(s){var d=document.createElement("div");d.textContent=s==null?"":String(s);return d.innerHTML;}
  function api(p,o){o=o||{};return fetch(p,{method:o.method||"GET",headers:o.body?{"Content-Type":"application/json"}:undefined,body:o.body?JSON.stringify(o.body):undefined}).then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.error||"Request failed");return d;});});}
  function money(a,u){if(a==null||a==="")return null;var n=Number(a);var s=isNaN(n)?a:"$"+n.toLocaleString();return s+(u==="hour"?"/hr":u==="year"?"/yr":"");}
  function fmtDate(d){if(!d)return null;var x=new Date(d);return isNaN(x)?d:x.toLocaleDateString(undefined,{month:"long",day:"numeric",year:"numeric"});}

  // ---- balloons ----
  var EMO=["🎈","🎉","⭐","💜","🎊","✨"];
  (function(){var b=document.getElementById("balloons");for(var i=0;i<14;i++){var s=document.createElement("span");s.className="balloon";s.textContent=EMO[i%EMO.length];s.style.left=(Math.random()*100)+"%";s.style.animationDuration=(9+Math.random()*10)+"s";s.style.animationDelay=(-Math.random()*12)+"s";s.style.fontSize=(24+Math.random()*26)+"px";b.appendChild(s);}})();

  // ---- confetti ----
  var cv=document.getElementById("confetti"),ctx=cv.getContext("2d"),parts=[],raf=null;
  function size(){cv.width=innerWidth;cv.height=innerHeight;} size(); addEventListener("resize",size);
  var COL=["#e0a430","#1b2a6b","#5fa8a0","#ef6f6c","#8b7ff0","#ffd166"];
  function spawn(n,spread){for(var i=0;i<n;i++){parts.push({x:innerWidth/2+(Math.random()-.5)*spread,y:innerHeight*0.35,vx:(Math.random()-.5)*9,vy:-6-Math.random()*9,g:.22+Math.random()*.15,s:6+Math.random()*7,c:COL[(Math.random()*COL.length)|0],r:Math.random()*6,vr:(Math.random()-.5)*.4});}}
  function rain(n){for(var i=0;i<n;i++){parts.push({x:Math.random()*innerWidth,y:-20,vx:(Math.random()-.5)*3,vy:2+Math.random()*4,g:.05,s:6+Math.random()*7,c:COL[(Math.random()*COL.length)|0],r:Math.random()*6,vr:(Math.random()-.5)*.4});}}
  function tick(){ctx.clearRect(0,0,cv.width,cv.height);for(var i=parts.length-1;i>=0;i--){var p=parts[i];p.vy+=p.g;p.x+=p.vx;p.y+=p.vy;p.r+=p.vr;ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.r);ctx.fillStyle=p.c;ctx.fillRect(-p.s/2,-p.s/2,p.s,p.s*.6);ctx.restore();if(p.y>innerHeight+30)parts.splice(i,1);}if(parts.length){raf=requestAnimationFrame(tick);}else{raf=null;}}
  function go(){if(!raf)raf=requestAnimationFrame(tick);}
  function celebrate(){spawn(140,300);go();}
  function celebrateBig(){spawn(160,360);var t=0,iv=setInterval(function(){rain(30);go();if(++t>10)clearInterval(iv);},250);go();}

  function load(){api("/api/hr/public/offer?token="+encodeURIComponent(token)).then(function(d){data=d;route();}).catch(function(e){app.innerHTML="<div class=\\"card err\\">"+esc(e.message)+"</div>";});}
  function route(){
    if(data.status==="accepted"){return accepted(true);}
    if(data.status==="declined"){app.innerHTML="<div class=\\"card center\\"><div class=\\"big\\">💜</div><h2>Thanks for letting us know</h2><p class=\\"muted\\">We appreciate you considering Spectrum Squad. The door is always open!</p></div>";return;}
    if(data.status==="expired"){app.innerHTML="<div class=\\"card center\\"><div class=\\"big\\">⏳</div><h2>This offer has expired</h2><p class=\\"muted\\">Please reach out to us and we\\'ll be happy to help.</p></div>";return;}
    envelope();
  }
  function envelope(){
    app.innerHTML="<div class=\\"center\\"><h1>Hi "+esc(data.first_name)+" — you\\'ve got something special! </h1><div class=\\"env pulse\\" id=\\"env\\"><div class=\\"flap\\">💌</div><div class=\\"tap\\">Tap to open your offer</div></div></div>";
    document.getElementById("env").addEventListener("click",function(){celebrate();reveal();});
  }
  function reveal(){
    var terms="";
    function term(k,v,wide){return v?"<div class=\\"term"+(wide?" wide":"")+"\\"><div class=\\"k\\">"+esc(k)+"</div><div class=\\"v\\">"+esc(v)+"</div></div>":"";}
    terms+=term("Compensation",money(data.comp_amount,data.comp_unit));
    terms+=term("Start date",fmtDate(data.start_date));
    terms+=term("Type",data.employment_type);
    terms+=term("Location",data.location);
    terms+=term("Reports to",data.supervisor);
    if(data.comp_notes)terms+=term("Details",data.comp_notes,true);
    var chips=(data.highlights||[]).map(function(h,i){return "<span class=\\"chip\\" style=\\"animation-delay:"+(i*90)+"ms\\">"+esc(h)+"</span>";}).join("");
    var html="<div class=\\"card\\"><div class=\\"center\\"><div class=\\"big\\">🎉</div><h1 style=\\"margin:0\\">We want you on the Squad!</h1></div>"+
      "<div class=\\"role\\">"+esc(data.job_title)+"</div><div class=\\"sub\\">A formal offer from Spectrum Squad</div>"+
      (chips?"<div class=\\"chips\\">"+chips+"</div>":"")+
      "<div class=\\"terms\\">"+terms+"</div>"+
      (data.custom_message?"<div class=\\"msg\\">"+esc(data.custom_message)+"</div>":"")+
      "<div id=\\"accept-zone\\"></div>"+
      (data.expires_at?"<div class=\\"countdown\\" id=\\"cd\\"></div>":"")+
      "<div class=\\"center\\"><button class=\\"link\\" id=\\"decline\\">This isn\\'t the right fit for me</button></div></div>";
    app.innerHTML=html;
    renderAcceptZone();
    if(data.expires_at)startCountdown();
    document.getElementById("decline").addEventListener("click",decline);
  }
  function renderAcceptZone(){
    var z=document.getElementById("accept-zone");
    z.innerHTML="<button class=\\"btn\\" id=\\"accept\\">Accept this offer 🎊</button>";
    document.getElementById("accept").addEventListener("click",function(){
      z.innerHTML="<p class=\\"muted center\\" style=\\"margin-bottom:2px\\">Type your full name to sign &amp; accept:</p>"+
        "<input class=\\"sign\\" id=\\"sign\\" placeholder=\\"Your full name\\" value=\\""+esc(data.full_name||"")+"\\"/>"+
        "<button class=\\"btn btn-navy\\" id=\\"sign-btn\\">Sign &amp; accept 🖊️</button><div class=\\"err\\" id=\\"sign-err\\"></div>";
      var inp=document.getElementById("sign");inp.focus();inp.select();
      document.getElementById("sign-btn").addEventListener("click",function(){
        var name=inp.value.trim();var er=document.getElementById("sign-err");
        if(!name){er.textContent="Please type your name to sign.";return;}
        var btn=document.getElementById("sign-btn");btn.disabled=true;btn.textContent="Signing…";
        api("/api/hr/public/offer/accept",{method:"POST",body:{token:token,signed_name:name}}).then(function(){data.signed_name=name;accepted(false);}).catch(function(e){er.textContent=e.message;btn.disabled=false;btn.textContent="Sign & accept 🖊️";});
      });
    });
  }
  function accepted(revisit){
    if(!revisit)celebrateBig(); else celebrate();
    app.innerHTML="<div class=\\"card center\\"><div class=\\"big\\">🎊</div><h1>Welcome to the Spectrum Squad, "+esc((data.signed_name||data.first_name||"").split(" ")[0])+"!</h1>"+
      "<p>We are so excited to have you. You\\'ll hear from our team soon with next steps.</p>"+
      "<p class=\\"muted\\">Signed by "+esc(data.signed_name||"")+" ✓</p></div>";
    window.scrollTo(0,0);
  }
  function decline(){
    if(!confirm("Are you sure you\\'d like to decline this offer?"))return;
    var reason=prompt("Anything you\\'d like us to know? (optional)","")||"";
    api("/api/hr/public/offer/decline",{method:"POST",body:{token:token,reason:reason}}).then(function(){data.status="declined";route();}).catch(function(e){alert(e.message);});
  }
  function startCountdown(){
    var el=document.getElementById("cd");var end=new Date(data.expires_at).getTime();
    function upd(){var ms=end-Date.now();if(ms<=0){el.textContent="This offer has expired.";return;}var days=Math.floor(ms/86400000),hrs=Math.floor(ms%86400000/3600000);el.textContent="⏳ Respond within "+days+"d "+hrs+"h";}
    upd();setInterval(upd,60000);
  }
  load();
})();
</script>
</body></html>`;
  }

  function timecardVerifyHtml() {
    // Cute, client-rendered employee timecard page. Fetches the timecard by
    // token, shows shifts (dates + times, no client names), and lets the
    // employee Accept (type-to-sign) or request Edits. No backticks / ${ } are
    // used inside the inline script on purpose so this stays a safe template.
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Your timecard — Spectrum Squad</title>
<style>
  :root{--brand:#1b2a6b;--brand2:#3f56b5;--gold:#e0a430;--bg:#f4f1ea;--card:#fff;--ink:#2b2a35;--muted:#8a8797;--line:#ece7db;--green:#22a565;}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);padding:22px 12px;}
  .wrap{max-width:600px;margin:0 auto;}
  .card{background:var(--card);border-radius:22px;overflow:hidden;box-shadow:0 10px 30px rgba(41,34,92,.12);border:1px solid var(--line);}
  .hero{background:linear-gradient(135deg,#1b2a6b,#3f56b5);color:#fff;padding:26px;}
  .hero h1{margin:6px 0 2px;font-size:21px;} .hero p{margin:0;opacity:.88;font-size:13.5px;}
  .period{display:inline-block;margin-top:12px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.25);padding:5px 12px;border-radius:999px;font-size:12.5px;font-weight:600;}
  .stats{display:flex;gap:12px;padding:18px 22px 4px;}
  .stat{flex:1;background:#faf8f2;border:1px solid var(--line);border-radius:16px;padding:14px 10px;text-align:center;}
  .stat b{display:block;font-size:24px;color:var(--brand);line-height:1;} .stat span{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;}
  .sec{padding:16px 22px 0;font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px;}
  thead th{text-align:left;font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;padding:8px 22px;border-bottom:1px solid var(--line);}
  tbody td{padding:11px 22px;border-bottom:1px solid #f4f0e7;vertical-align:middle;}
  tfoot td{padding:10px 22px;border-top:1px solid var(--line);background:#faf8f2;}
  .sub{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:700;}
  .muted{color:var(--muted);font-size:11.5px;} .c-hrs{font-weight:700;color:var(--brand);white-space:nowrap;}
  .badge{display:inline-block;font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;margin-right:4px;}
  .badge.ok{background:#e9f9ee;color:#177a3c;} .badge.alert{background:#fef3e0;color:#946213;}
  .actions{padding:20px 22px 26px;text-align:center;} .actions p{font-size:13px;color:var(--muted);margin:0 0 14px;}
  .btn{display:inline-block;border:none;border-radius:999px;padding:13px 22px;font-size:14.5px;font-weight:700;cursor:pointer;margin:4px;}
  .btn.accept{background:var(--green);color:#fff;} .btn.edit{background:#fff;color:var(--brand);border:2px solid var(--brand);} .btn.send{background:var(--gold);color:#3a2a05;}
  .note{width:100%;margin-top:12px;border:1px solid var(--line);border-radius:12px;padding:10px 12px;font-size:13px;font-family:inherit;resize:vertical;min-height:60px;display:none;}
  .sign{width:100%;max-width:320px;margin:8px auto 0;display:none;padding:12px;border:2px dashed var(--brand);border-radius:12px;font-size:18px;font-family:"Segoe Script","Brush Script MT",cursive;text-align:center;}
  .err{color:#b91c1c;} .done{text-align:center;padding:34px 22px;}
</style></head>
<body><div class="wrap"><div id="host"><div class="card"><div style="padding:40px;text-align:center;color:#8a8797;">Loading your timecard…</div></div></div>
<div style="text-align:center;color:#8a8797;font-size:11.5px;margin-top:14px;">Spectrum Squad · Reviewing never changes your pay automatically.</div></div>
<script>
(function(){
  var host=document.getElementById("host");
  var token=location.pathname.split("/verify-timecard/")[1]||"";
  var D=null, editing=false;
  function esc(s){var d=document.createElement("div");d.textContent=s==null?"":String(s);return d.innerHTML;}
  function api(p,o){o=o||{};return fetch(p,{method:o.method||"GET",headers:o.body?{"Content-Type":"application/json"}:undefined,body:o.body?JSON.stringify(o.body):undefined}).then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.error||"Request failed");return d;});});}
  function ptime(v){ if(!v) return "—"; var d=new Date(v); if(isNaN(d.getTime())) return String(v); var h=d.getHours(),m=d.getMinutes(),ap=h>=12?"PM":"AM"; h=h%12||12; return h+":"+(m<10?"0"+m:m)+" "+ap; }
  function fmt(x){ return (Math.round((parseFloat(x)||0)*100)/100).toString(); }
  function firstName(n){ return (n||"there").split(" ")[0]; }
  // Mirrors classifyBillable() on the server. "Non-Billable" must be tested
  // before "Billable" or every non-billable shift lands in the billable pile.
  function clsOf(e){ if(!e) return null; if(e.billable===true) return true; if(e.billable===false) return false;
    var s=String(e.appt_type||"").trim(); if(!s) return null;
    if(/non[-_ ]*billable/i.test(s)) return false; if(/billable/i.test(s)) return true; return null; }
  function sumOf(list){ var t=0; list.forEach(function(x){ t+=parseFloat(x.e.hours)||0; }); return Math.round(t*100)/100; }
  function shell(inner){ return "<div class=\\"card\\"><div class=\\"hero\\"><div style=\\"font-size:22px\\">✨</div><h1>Hi "+esc(firstName(D.employee_name))+" — here's your timecard!</h1><p>Please review your hours and tap Accept, or Edit if anything looks off.</p><div class=\\"period\\">Pay period · "+esc(D.pay_period.start||"")+" – "+esc(D.pay_period.end||"")+"</div></div>"+inner+"</div>"; }
  function load(){ api("/api/hr/public/timecard?token="+encodeURIComponent(token)).then(function(d){D=d;render();}).catch(function(e){host.innerHTML="<div class=\\"card\\"><div style=\\"padding:34px;text-align:center\\" class=\\"err\\">"+esc(e.message)+"</div></div>";}); }
  function doneView(icon,title,msg){ host.innerHTML=shell("<div class=\\"done\\"><div style=\\"font-size:40px\\">"+icon+"</div><h2 style=\\"color:#22a565;margin:8px 0 4px\\">"+esc(title)+"</h2><p class=\\"muted\\">"+esc(msg)+"</p></div>"); }
  function render(){
    if(D.status==="accepted"){ return doneView("🎉","Timecard accepted!","Thanks"+(D.signed_name?", "+esc(firstName(D.signed_name)):"")+" — your hours are confirmed and payroll's been notified."); }
    if(D.status==="edit_requested"){ return doneView("📨","Changes sent!","Your requested edits are with the office for review."); }
    var entries=D.entries||[];
    var groups={b:[],n:[],u:[]};
    entries.forEach(function(e,i){ var c=clsOf(e); groups[c===true?"b":c===false?"n":"u"].push({e:e,i:i}); });
    var hasSplit=(groups.b.length+groups.n.length)>0;
    var total=D.total_hours!=null?D.total_hours:sumOf(groups.b.concat(groups.n,groups.u));
    function rowsFor(list){ return list.map(function(x){
      var e=x.e,i=x.i,c=clsOf(e);
      var ver=e.verified==="Yes"?"<span class=\\"badge ok\\">✓ verified</span>":"";
      var al=e.alert?"<span class=\\"badge alert\\">⚠ "+esc(e.alert)+"</span>":"";
      var clocked=ptime(e.clock_in)+" – "+ptime(e.clock_out);
      return "<tr><td><b>"+esc(e.date||"")+"</b></td><td>"+esc(e.scheduled||"—")+"</td><td>"+esc(clocked)+"</td>"+
        "<td class=\\"c-hrs\\"><span class=\\"hv\\">"+fmt(e.hours)+"</span><input class=\\"he\\" data-i=\\""+i+"\\" data-grp=\\""+(c===true?"b":c===false?"n":"u")+"\\" type=\\"number\\" step=\\"0.01\\" value=\\""+fmt(e.hours)+"\\" style=\\"display:none;width:64px;\\"></td><td>"+ver+al+"</td></tr>";
    }).join(""); }
    function section(title,list,key,subLabel){ if(!list.length) return "";
      return "<div class=\\"sec\\">"+title+"</div><table><thead><tr><th>Date</th><th>Scheduled</th><th>Clocked</th><th>Hours</th><th></th></tr></thead><tbody>"+rowsFor(list)+
        "</tbody><tfoot><tr><td colspan=\\"3\\" class=\\"sub\\">"+subLabel+"</td><td class=\\"c-hrs\\" id=\\"sub-"+key+"\\">"+fmt(sumOf(list))+"</td><td></td></tr></tfoot></table>"; }
    var tiles=hasSplit
      ? "<div class=\\"stat\\"><b id=\\"stat-b\\">"+fmt(sumOf(groups.b))+"</b><span>Billable hrs</span></div>"+
        "<div class=\\"stat\\"><b id=\\"stat-n\\">"+fmt(sumOf(groups.n))+"</b><span>Non-billable</span></div>"+
        "<div class=\\"stat\\"><b id=\\"tot\\">"+fmt(total)+"</b><span>Total hrs</span></div>"
      : "<div class=\\"stat\\"><b id=\\"tot\\">"+fmt(total)+"</b><span>Total hrs</span></div>"+
        "<div class=\\"stat\\"><b>"+entries.length+"</b><span>Shifts</span></div>"+
        "<div class=\\"stat\\"><b>"+esc(D.role||"Staff")+"</b><span>Role</span></div>";
    var tables=hasSplit
      ? section("💙 Billable shifts",groups.b,"b","Billable subtotal")+
        section("🗂 Non-billable shifts",groups.n,"n","Non-billable subtotal")+
        section("❓ Not labeled",groups.u,"u","Unlabeled subtotal")
      : section("Your shifts",groups.u,"u","Total");
    var inner="<div class=\\"stats\\">"+tiles+"</div>"+tables+
      "<div class=\\"actions\\"><p id=\\"prompt\\">Everything look right?</p>"+
      "<button class=\\"btn accept\\" id=\\"b-accept\\">✓ Looks good — Accept</button>"+
      "<button class=\\"btn edit\\" id=\\"b-edit\\">✎ Something's off — Edit</button>"+
      "<input class=\\"sign\\" id=\\"sign\\" placeholder=\\"Type your full name to sign\\"/>"+
      "<textarea class=\\"note\\" id=\\"note\\" placeholder=\\"Tell us what needs fixing (e.g. 'Aug 4 should be 4 hrs')...\\"></textarea>"+
      "<div id=\\"confirm\\" style=\\"display:none;margin-top:6px\\"></div></div>";
    host.innerHTML=shell(inner);
    document.getElementById("b-accept").addEventListener("click",startAccept);
    document.getElementById("b-edit").addEventListener("click",startEdit);
  }
  function startAccept(){
    var sign=document.getElementById("sign");
    document.getElementById("prompt").textContent="Type your name below to sign and accept.";
    document.getElementById("note").style.display="none";
    sign.style.display="block"; sign.focus();
    var c=document.getElementById("confirm"); c.style.display="block";
    c.innerHTML="<button class=\\"btn accept\\" id=\\"b-do-accept\\">Sign & accept →</button>";
    document.getElementById("b-do-accept").addEventListener("click",function(){
      var name=sign.value.trim(); if(!name){sign.focus();return;}
      var btn=document.getElementById("b-do-accept"); btn.disabled=true; btn.textContent="Saving…";
      api("/api/hr/public/timecard/accept",{method:"POST",body:{token:token,signed_name:name}}).then(function(){D.status="accepted";D.signed_name=name;render();}).catch(function(e){alert(e.message);btn.disabled=false;btn.textContent="Sign & accept →";});
    });
  }
  function startEdit(){
    editing=true;
    document.getElementById("prompt").textContent="Adjust any hours, add a note, then send.";
    document.getElementById("sign").style.display="none";
    document.getElementById("note").style.display="block";
    Array.prototype.forEach.call(document.querySelectorAll(".hv"),function(e){e.style.display="none";});
    Array.prototype.forEach.call(document.querySelectorAll(".he"),function(e){e.style.display="inline-block";e.addEventListener("input",recalc);});
    var c=document.getElementById("confirm"); c.style.display="block";
    c.innerHTML="<button class=\\"btn send\\" id=\\"b-do-edit\\">Send my changes →</button>";
    document.getElementById("b-do-edit").addEventListener("click",function(){
      var edited=[]; Array.prototype.forEach.call(document.querySelectorAll(".he"),function(inp){ var i=Number(inp.getAttribute("data-i")); var e=(D.entries||[])[i]||{}; edited.push({index:i,date:e.date,appt_type:e.appt_type||"",hours:parseFloat(inp.value)||0}); });
      var btn=document.getElementById("b-do-edit"); btn.disabled=true; btn.textContent="Sending…";
      api("/api/hr/public/timecard/edit",{method:"POST",body:{token:token,edited:edited,note:document.getElementById("note").value.trim()}}).then(function(){D.status="edit_requested";render();}).catch(function(e){alert(e.message);btn.disabled=false;btn.textContent="Send my changes →";});
    });
  }
  function recalc(){
    var t=0,g={b:0,n:0,u:0};
    Array.prototype.forEach.call(document.querySelectorAll(".he"),function(e){
      var v=parseFloat(e.value)||0; t+=v;
      var k=e.getAttribute("data-grp")||"u"; g[k]=(g[k]||0)+v;
    });
    var r=function(x){return Math.round(x*100)/100;};
    document.getElementById("tot").textContent=r(t);
    ["b","n","u"].forEach(function(k){
      var sub=document.getElementById("sub-"+k); if(sub) sub.textContent=r(g[k]);
      var st=document.getElementById("stat-"+k); if(st) st.textContent=r(g[k]);
    });
  }
  load();
})();
</script>
</body></html>`;
  }

  function scheduleHtml() {
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Schedule your interview — Spectrum Squad</title>
<style>
  :root{--navy:#1b2a6b;--navy-dark:#101c4d;--navy-light:#edecf8;--gold:#e0a430;--bg:#f7f8fb;--surface:#fff;--border:#e5e7eb;--text:#201a4d;--muted:#6b6a86;--radius:14px;}
  *{box-sizing:border-box} body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.5}
  header{background:linear-gradient(135deg,var(--navy),var(--navy-dark));color:#fff;padding:36px 20px;text-align:center}
  header h1{margin:6px 0 4px;font-size:24px} header p{margin:0;opacity:.85}
  .wrap{max-width:640px;margin:0 auto;padding:20px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin:16px 0;box-shadow:0 1px 3px rgba(41,34,92,.08)}
  .slot{display:flex;justify-content:space-between;align-items:center;border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:10px}
  button,.btn{background:var(--navy);color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer}
  button:hover{background:var(--navy-dark)} .btn-ghost{background:#fff;color:var(--navy);border:1px solid var(--navy)}
  .muted{color:var(--muted);font-size:14px} .err{color:#b91c1c} .ok{color:#16a34a}
  .badge{display:inline-block;background:var(--navy-light);color:var(--navy);border-radius:20px;padding:2px 10px;font-size:12px;font-weight:600}
  .big{font-size:44px;text-align:center}
</style></head>
<body>
<header><h1>Schedule your interview</h1><p>Spectrum Squad</p></header>
<div class="wrap"><div style="text-align:center;margin-bottom:10px;"><img src="/logo.png" alt="Spectrum Squad" style="max-width:210px;width:60%;height:auto;"/></div><div id="app"><p class="muted">Loading…</p></div></div>
<script>
(function(){
  var app=document.getElementById("app");
  var token=location.pathname.split("/schedule/")[1]||"";
  function esc(s){var d=document.createElement("div");d.textContent=s==null?"":String(s);return d.innerHTML;}
  function api(p,opts){opts=opts||{};return fetch(p,{method:opts.method||"GET",headers:opts.body?{"Content-Type":"application/json"}:undefined,body:opts.body?JSON.stringify(opts.body):undefined}).then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.error||"Request failed");return d;});});}
  function fmt(iso){var d=new Date(iso);return isNaN(d)?iso:d.toLocaleString(undefined,{weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});}
  function load(){
    api("/api/hr/public/schedule?token="+encodeURIComponent(token)).then(render).catch(function(e){app.innerHTML='<div class="card err">'+esc(e.message)+'</div>';});
  }
  function render(d){
    var html="";
    if(d.current){
      html+='<div class="card"><h3 style="margin-top:0">Your interview is booked ✅</h3>'+
        '<p><span class="badge">'+esc(fmt(d.current.scheduled_at))+'</span> · '+esc(d.current.mode==="virtual"?"Virtual":"In person")+'</p>'+
        (d.current.location_or_link?'<p class="muted">'+esc(d.current.location_or_link)+'</p>':'')+
        '<button class="btn-ghost" id="cancel">Cancel / reschedule</button></div>';
    }
    html+='<div class="card"><h3 style="margin-top:0">'+(d.current?"Pick a different time":"Choose a time")+'</h3>'+
      (d.position_title?'<p class="muted">'+esc(d.position_title)+'</p>':'')+
      (d.slots&&d.slots.length? d.slots.map(function(s){return '<div class="slot"><div><strong>'+esc(fmt(s.start_at))+'</strong><div class="muted">'+esc(s.duration_min)+' min · '+esc(s.mode==="virtual"?"Virtual":"In person")+'</div></div><button data-slot="'+s.id+'">Book</button></div>';}).join(""):'<p class="muted">No times are open right now. We\\'ll be in touch soon!</p>')+
      '</div>';
    app.innerHTML=html;
    Array.prototype.forEach.call(app.querySelectorAll("button[data-slot]"),function(b){b.addEventListener("click",function(){book(b.getAttribute("data-slot"),b);});});
    var c=document.getElementById("cancel"); if(c) c.addEventListener("click",cancel);
  }
  function book(slotId,btn){btn.disabled=true;btn.textContent="Booking…";api("/api/hr/public/book",{method:"POST",body:{token:token,slot_id:slotId}}).then(function(){app.innerHTML='<div class="card" style="text-align:center"><div class="big">✅</div><h2>You\\'re booked!</h2><p class="muted">Check your email for the confirmation and calendar link.</p></div>';window.scrollTo(0,0);}).catch(function(e){alert(e.message);load();});}
  function cancel(){if(!confirm("Cancel this interview?"))return;api("/api/hr/public/cancel",{method:"POST",body:{token:token}}).then(load).catch(function(e){alert(e.message);});}
  load();
})();
</script>
</body></html>`;
  }

  function careersHtml() {
    // Public, single-page careers experience: a playful hero, colorful role
    // cards, and a friendly multi-step application wizard (basics -> fit ->
    // story -> review) that posts to the SAME public /api/hr/apply contract as
    // before. Routed at /careers, /careers/:slug and /apply/:token. Everything
    // is self-contained -- no backticks and no ${} interpolation inside the
    // returned template literal, and the inner script prefers double-quoted
    // strings so friendly copy with apostrophes needs no escaping.
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Careers — Join the Spectrum Squad</title>
<style>
  :root{
    /* Mustard-yellow theme drawn from the logo (#e0a430). The former accent
       names now all hold warm gold/bronze shades so the whole page reads gold. */
    --navy:#6b4f16;--navy-dark:#4a370f;--navy-light:#fbeecb;--gold:#e0a430;--gold-soft:#fdeecb;
    --teal:#c98f22;--mint:#a9761a;--coral:#c96f2c;--purple:#cf9422;--bg:#fbf7ec;--surface:#fff;
    --border:#eee1c2;--text:#3a2f14;--muted:#8a7c58;--ok:#1f9d63;--radius:18px;
  }
  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    background:var(--bg);color:var(--text);line-height:1.55;-webkit-font-smoothing:antialiased}
  a{color:var(--navy)}
  .wrap{max-width:860px;margin:0 auto;padding:0 18px}

  /* ---- Hero (mustard, like our social posts) ---- */
  header.hero{position:relative;overflow:hidden;color:#3a2a00;text-align:center;
    background:linear-gradient(135deg,#e7b24a 0%,#e0a430 45%,#cf9422 100%);padding:52px 20px 60px}
  header.hero .blob{position:absolute;border-radius:50%;filter:blur(2px);opacity:.3;animation:float 9s ease-in-out infinite}
  .blob.b1{width:180px;height:180px;background:#c98f22;top:-40px;left:-30px}
  .blob.b2{width:130px;height:130px;background:#f2cf76;bottom:-30px;right:10%;animation-delay:1.5s}
  .blob.b3{width:90px;height:90px;background:#b9781a;top:30px;right:16%;animation-delay:.8s}
  @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-18px)}}
  header.hero .inner{position:relative;z-index:2}
  header.hero img.logo{max-width:230px;width:64%;height:auto;background:#fff;padding:12px 18px;border-radius:16px;
    box-shadow:0 10px 30px rgba(0,0,0,.18)}
  header.hero h1{margin:20px 0 6px;font-size:31px;line-height:1.15;font-weight:800;letter-spacing:-.5px}
  header.hero p.tag{margin:0 auto;max-width:560px;font-size:17px;opacity:.92}
  .vibes{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin:20px 0 0}
  .vibe{background:rgba(255,255,255,.4);border:1px solid rgba(58,42,0,.16);color:#3a2a00;border-radius:999px;
    padding:7px 14px;font-size:13.5px;font-weight:600;backdrop-filter:blur(4px)}

  /* ---- Perks band ---- */
  .perks{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:-30px auto 8px;position:relative;z-index:3}
  .perk{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:14px 14px;
    box-shadow:0 10px 30px rgba(41,34,92,.08);text-align:center}
  .perk .ic{color:var(--gold);display:flex;justify-content:center;height:26px;margin-bottom:6px}
  .perk .ic svg{width:26px;height:26px}
  .perk .t{font-weight:700;font-size:13.5px;color:var(--navy)}
  .perk .d{font-size:12px;color:var(--muted)}

  .emptyic svg{width:44px;height:44px}
  .sec-title{text-align:center;font-size:22px;font-weight:800;color:var(--navy);margin:34px 0 4px}
  .sec-sub{text-align:center;color:var(--muted);margin:0 0 18px}

  /* ---- Role cards ---- */
  .roles{display:grid;grid-template-columns:1fr;gap:16px;margin-bottom:20px}
  @media(min-width:620px){.roles{grid-template-columns:1fr 1fr}}
  .role{position:relative;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
    padding:22px 20px 20px;box-shadow:0 6px 20px rgba(41,34,92,.07);cursor:pointer;overflow:hidden;
    transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease}
  .role:hover{transform:translateY(-4px);box-shadow:0 18px 40px rgba(41,34,92,.16);border-color:var(--navy)}
  .role .stripe{position:absolute;top:0;left:0;right:0;height:6px}
  .role .badge{display:inline-block;font-weight:800;font-size:15px;letter-spacing:.4px;color:#fff;
    background:var(--gold);padding:7px 14px;border-radius:12px;box-shadow:0 5px 14px rgba(224,164,48,.32)}
  .role h3{margin:12px 0 2px;font-size:19px;color:var(--navy)}
  .role .vibe-line{color:var(--muted);font-size:14.5px;margin:0 0 12px;min-height:40px}
  .chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
  .chip{border-radius:999px;padding:4px 11px;font-size:12px;font-weight:700;background:var(--navy-light);color:var(--navy)}
  .chip.loc{background:#f6ecd4;color:var(--mint)}
  .chip.type{background:#fbeecb;color:var(--purple)}
  .chip.urgent{background:var(--gold-soft);color:#a9761a;animation:pulse 1.8s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.55}}
  .role .cta{display:inline-flex;align-items:center;gap:7px;font-weight:800;color:var(--navy);font-size:15px}
  .role .cta .arr{transition:transform .16s ease}
  .role:hover .cta .arr{transform:translateX(4px)}
  .openings{position:absolute;top:16px;right:16px;font-size:12px;font-weight:700;color:var(--muted)}

  /* ---- Wizard ---- */
  .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:22px;
    margin:16px 0;box-shadow:0 6px 20px rgba(41,34,92,.07)}
  .rolehead{display:flex;align-items:center;gap:14px;margin:0 0 6px}
  .rolehead .badge{display:inline-block;font-weight:800;font-size:14px;letter-spacing:.4px;color:#fff;
    background:var(--gold);padding:6px 12px;border-radius:11px;white-space:nowrap}
  .rolehead h2{margin:0;font-size:20px;color:var(--navy)}
  .rolehead .sub{color:var(--muted);font-size:13.5px}
  .progress{display:flex;gap:8px;margin:18px 0 6px}
  .pstep{flex:1;text-align:center}
  .pstep .bar{height:7px;border-radius:999px;background:var(--navy-light);overflow:hidden}
  .pstep .bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--gold),#c98f22);transition:width .3s ease}
  .pstep.done .bar i,.pstep.active .bar i{width:100%}
  .pstep.active .bar i{background:linear-gradient(90deg,#e0a430,#b9781a)}
  .pstep .lbl{font-size:11.5px;font-weight:700;color:var(--muted);margin-top:5px}
  .pstep.active .lbl,.pstep.done .lbl{color:var(--navy)}
  .step-anim{animation:slidein .28s ease}
  @keyframes slidein{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  .step h3{margin:4px 0 2px;font-size:20px;color:var(--navy)}
  .step .lead{color:var(--muted);margin:0 0 14px}
  label{display:block;font-size:13.5px;font-weight:700;margin:14px 0 6px;color:var(--navy)}
  .req{color:var(--coral)}
  input,textarea,select{width:100%;padding:12px 13px;border:1.5px solid var(--border);border-radius:12px;font-size:15px;
    font-family:inherit;background:#fff;transition:border-color .15s ease,box-shadow .15s ease}
  input:focus,textarea:focus,select:focus{outline:none;border-color:var(--gold);box-shadow:0 0 0 3px rgba(224,164,48,.22)}
  textarea{min-height:96px;resize:vertical}
  .row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media(max-width:520px){.row2{grid-template-columns:1fr}}
  .q{margin:16px 0}
  .q .ql{font-weight:700;font-size:14.5px;color:var(--navy);margin:0 0 8px}
  .yesno{display:flex;gap:10px}
  .yesno button{flex:1;background:#fff;color:var(--navy);border:1.5px solid var(--border);border-radius:12px;
    padding:12px;font-size:15px;font-weight:700;cursor:pointer;transition:all .14s ease}
  .yesno button:hover{border-color:var(--navy)}
  .yesno button.sel{background:var(--gold);color:#3a2a00;border-color:var(--gold);box-shadow:0 6px 16px rgba(224,164,48,.3)}
  .yesno button.sel.no{background:var(--muted);border-color:var(--muted);box-shadow:none}

  /* availability selector */
  .day-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:4px}
  .day-btn{flex:1;min-width:56px;background:#fff;color:var(--navy);border:1.5px solid var(--border);border-radius:12px;
    padding:12px 6px;font-size:14px;font-weight:700;cursor:pointer;transition:all .14s ease}
  .day-btn:hover{border-color:var(--navy)}
  .day-btn.sel{background:var(--gold);color:#3a2a00;border-color:var(--gold);box-shadow:0 6px 16px rgba(224,164,48,.3)}
  .type-row{display:flex;gap:10px}
  .type-btn{flex:1;background:#fff;color:var(--navy);border:1.5px solid var(--border);border-radius:12px;
    padding:12px;font-size:15px;font-weight:700;cursor:pointer;transition:all .14s ease}
  .type-btn:hover{border-color:var(--navy)}
  .type-btn.sel{background:var(--gold);color:#3a2a00;border-color:var(--gold);box-shadow:0 6px 16px rgba(224,164,48,.3)}

  /* resume dropzone */
  .drop{border:2px dashed #e0d3b0;border-radius:14px;padding:22px;text-align:center;cursor:pointer;
    transition:all .15s ease;background:#fdfbf4}
  .drop:hover,.drop.over{border-color:var(--gold);background:#fdf7e8}
  .drop .ic{color:var(--gold);display:flex;justify-content:center;margin-bottom:4px}
  .drop .ic svg{width:30px;height:30px}
  .drop.has .ic{color:var(--ok)}
  .drop .hint{color:var(--muted);font-size:13px;margin-top:4px}
  .drop.has{border-style:solid;border-color:var(--ok);background:#f0fbf5}
  .drop .fname{font-weight:700;color:var(--ok)}

  .check{display:flex;gap:10px;align-items:flex-start;margin:14px 0;font-size:13.5px;font-weight:500;color:var(--text)}
  .check input{width:auto;margin-top:3px}
  .review-list{list-style:none;padding:0;margin:0}
  .review-list li{display:flex;justify-content:space-between;gap:14px;padding:9px 0;border-bottom:1px solid var(--border);font-size:14px}
  .review-list li .k{color:var(--muted);font-weight:600}
  .review-list li .v{font-weight:700;color:var(--navy);text-align:right;max-width:60%}
  .nav{display:flex;gap:10px;margin-top:22px}
  .btn{flex:1;border:none;border-radius:14px;padding:15px;font-size:16px;font-weight:800;cursor:pointer;transition:transform .12s ease,box-shadow .12s ease}
  .btn:active{transform:translateY(1px)}
  .btn.primary{background:linear-gradient(135deg,var(--gold),#f0b64a);color:#3a2a00;box-shadow:0 8px 20px rgba(224,164,48,.4)}
  .btn.primary:hover{box-shadow:0 12px 26px rgba(224,164,48,.5)}
  .btn.primary[disabled]{opacity:.65;cursor:default;box-shadow:none}
  .btn.ghost{flex:0 0 auto;background:#fff;color:var(--navy);border:1.5px solid var(--border);padding:15px 20px}
  .btn.ghost:hover{border-color:var(--navy)}
  .err{color:#b91c1c;font-size:13.5px;margin-top:12px;font-weight:600}

  /* success */
  .ok{text-align:center;padding:22px 6px}
  .ok .big{display:flex;justify-content:center;animation:pop .5s cubic-bezier(.2,1.4,.4,1)}
  .ok .big svg{width:76px;height:76px}
  @keyframes pop{from{transform:scale(0)}to{transform:scale(1)}}
  .ok h2{color:var(--navy);margin:10px 0 6px;font-size:24px}
  .next{text-align:left;max-width:420px;margin:18px auto 0}
  .next .n{display:flex;gap:12px;align-items:flex-start;margin:12px 0}
  .next .n .num{flex:0 0 28px;height:28px;border-radius:50%;background:var(--navy);color:#fff;font-weight:800;
    display:flex;align-items:center;justify-content:center;font-size:14px}
  .next .n .txt{font-size:14px}
  .next .n .txt b{color:var(--navy)}

  footer{text-align:center;color:var(--muted);font-size:12.5px;padding:34px 20px 44px}
  .spin{display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.5);border-top-color:#3a2a00;
    border-radius:50%;animation:sp .7s linear infinite;vertical-align:-2px;margin-right:6px}
  @keyframes sp{to{transform:rotate(360deg)}}
</style></head>
<body>
<header class="hero">
  <span class="blob b1"></span><span class="blob b2"></span><span class="blob b3"></span>
  <div class="inner">
    <img class="logo" src="/logo.png" alt="Spectrum Squad"/>
    <h1>Come do the best work of your life</h1>
    <p class="tag">We help children with autism thrive through compassionate, evidence-based ABA care — and we take just as good care of the people who make it happen.</p>
    <div class="vibes">
      <span class="vibe">Las Vegas &amp; Henderson, NV</span>
      <span class="vibe">Fast-growing team</span>
      <span class="vibe">Actually meaningful work</span>
    </div>
  </div>
</header>
<div class="wrap">
  <div class="perks" id="perks"></div>
  <div id="app"><p class="sec-sub" style="margin-top:34px">Loading open roles…</p></div>
</div>
<footer>
  Spectrum Squad · Compassionate ABA Therapy · Las Vegas &amp; Henderson, NV<br/>
  We are proud to be an equal-opportunity employer. Your information is used only to consider your application and is never sold.
</footer>
<script>
(function(){
  var app=document.getElementById("app");
  var perksEl=document.getElementById("perks");
  var path=location.pathname;
  var sourceToken=null, slug=null;
  if(path.indexOf("/apply/")===0){ sourceToken=path.split("/apply/")[1]; }
  else if(path.indexOf("/careers/")===0){ slug=decodeURIComponent(path.split("/careers/")[1]||""); }

  // ---- state for the wizard ----
  var STEPS=["You","Experience","Availability","Your fit","Review"];
  // The texting consent box was removed with the texting feature: asking
  // somebody to agree to messages nothing can send would be a false statement
  // on a form. Consents already given are kept on the candidate record.
  var DAYS_OF_WEEK=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  var state={position:null,source:"website",sourceId:null,step:0,data:{avail:{days:{},earliest:"",latest:"",type:""}},answers:{},resume:null};

  function esc(s){var d=document.createElement("div");d.textContent=s==null?"":String(s);return d.innerHTML;}
  function api(p,opts){opts=opts||{};return fetch(p,{method:opts.method||"GET",
    headers:opts.body?{"Content-Type":"application/json"}:undefined,
    body:opts.body?JSON.stringify(opts.body):undefined}).then(function(r){
      return r.json().then(function(d){if(!r.ok)throw new Error(d.error||"Something went wrong");return d;});});}

  // ---- perks band ----
  // Simple line icons (no emoji) drawn with currentColor so they take the theme.
  var SVG_OPEN="<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>";
  var ICON={
    grow:SVG_OPEN+"<path d='M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z'/><path d='M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z'/></svg>",
    mentor:SVG_OPEN+"<path d='M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'/><circle cx='9' cy='7' r='4'/><path d='M23 21v-2a4 4 0 0 0-3-3.87'/><path d='M16 3.13a4 4 0 0 1 0 7.75'/></svg>",
    calendar:SVG_OPEN+"<rect x='3' y='4' width='18' height='18' rx='2'/><path d='M16 2v4M8 2v4M3 10h18'/></svg>",
    trend:SVG_OPEN+"<path d='M23 6l-9.5 9.5-5-5L1 18'/><path d='M17 6h6v6'/></svg>",
    coffee:SVG_OPEN+"<path d='M18 8h1a4 4 0 0 1 0 8h-1'/><path d='M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z'/><path d='M6 1v3M10 1v3M14 1v3'/></svg>",
    heart:SVG_OPEN+"<path d='M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z'/></svg>",
    paperclip:SVG_OPEN+"<path d='M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48'/></svg>",
    filecheck:SVG_OPEN+"<path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'/><path d='M14 2v6h6'/><path d='M9 15l2 2 4-4'/></svg>",
    briefcase:SVG_OPEN+"<rect x='2' y='7' width='20' height='14' rx='2'/><path d='M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16'/></svg>",
    success:"<svg viewBox='0 0 52 52' fill='none' xmlns='http://www.w3.org/2000/svg'><circle cx='26' cy='26' r='24' fill='#fbeecb' stroke='#e0a430' stroke-width='3'/><path d='M16 27l7 7 13-14' stroke='#c98f22' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/></svg>"
  };
  var PERKS=[
    {ic:ICON.grow,t:"Grow on us",d:"CEU + credential support"},
    {ic:ICON.mentor,t:"Real mentorship",d:"BCBAs who actually teach"},
    {ic:ICON.calendar,t:"Flexible schedules",d:"Life outside work, too"},
    {ic:ICON.trend,t:"A clear path up",d:"RBT to BCaBA to BCBA"},
    {ic:ICON.coffee,t:"A team that shows up",d:"Supportive, kind, fun"},
    {ic:ICON.heart,t:"Meaning every day",d:"Kids you change forever"}
  ];
  perksEl.innerHTML=PERKS.map(function(p){
    return "<div class='perk'><span class='ic'>"+p.ic+"</span><div class='t'>"+esc(p.t)+"</div><div class='d'>"+esc(p.d)+"</div></div>";
  }).join("");

  // ---- per-role personality ----
  function roleMeta(p){
    var slugKey=(p.slug||"");
    var map={
      "rbt":{label:"RBT",accent:"#e0a430",tag:"Be the person a kid lights up to see. Deliver 1:1 therapy that changes a family's whole week."},
      "bcba-hybrid":{label:"BCBA",accent:"#c98f22",tag:"Lead the clinical vision. Design the programs, guide the team, and watch the breakthroughs happen."},
      "bcaba":{label:"BCaBA",accent:"#b9821f",tag:"Level up into the analyst you're becoming — with real supervision and a real path to BCBA."},
      "administrative-assistant":{label:"Admin",accent:"#d99a2b",tag:"Be the friendly face and steady hand that keeps the whole clinic running like magic."}
    };
    if(map[slugKey])return map[slugKey];
    if(p.role_type==="bcba")return {label:"BCBA",accent:"#c98f22",tag:"Lead the clinical vision and change lives across our clinic, home, and school programs."};
    if(p.role_type==="rbt")return {label:"RBT",accent:"#e0a430",tag:"Deliver the hands-on therapy that helps kids reach their next big milestone."};
    return {label:"Squad",accent:"#e0a430",tag:"Join a team doing work that genuinely matters."};
  }
  function typeLabel(t){return {full_time:"Full-time",part_time:"Part-time",contract:"Contract"}[t]||t;}
  function locLabel(t){return {hybrid:"Hybrid",onsite:"On-site",remote:"Remote"}[t]||t;}

  function start(){
    if(sourceToken){
      api("/api/hr/apply-link/"+encodeURIComponent(sourceToken))
        .then(function(d){openRole(d.position,d.source,d.source_id);})
        .catch(function(){ sourceToken=null; listPositions(); });
    } else if(slug){
      api("/api/hr/public/positions/"+encodeURIComponent(slug))
        .then(function(p){openRole(p,"website",null);})
        .catch(function(){ slug=null; history.replaceState({},"","/careers"); listPositions(); });
    } else { listPositions(); }
  }

  // ---- list view ----
  function listPositions(){
    perksEl.style.display="";
    api("/api/hr/public/positions").then(function(list){
      if(!list.length){
        app.innerHTML="<div class='card' style='text-align:center'><div class='emptyic' style='color:var(--gold);display:flex;justify-content:center'>"+ICON.briefcase+"</div>"+
          "<h3 style='color:var(--navy)'>No open roles this very second…</h3>"+
          "<p class='sec-sub'>But we're growing fast and always love meeting great people. Check back soon!</p></div>";
        return;
      }
      var cards=list.map(function(p){
        var m=roleMeta(p);
        var chips="";
        if(p.priority==="urgent")chips+="<span class='chip urgent'>Hiring now</span>";
        chips+="<span class='chip loc'>"+esc(locLabel(p.location_type))+"</span>";
        (p.employment_types||[]).forEach(function(t){chips+="<span class='chip type'>"+esc(typeLabel(t))+"</span>";});
        var openings=(p.openings_count&&p.openings_count>1)?("<span class='openings'>"+p.openings_count+" openings</span>"):"";
        return "<div class='role' data-slug='"+esc(p.slug)+"'>"+
          "<span class='stripe' style='background:"+m.accent+"'></span>"+openings+
          "<div class='badge' style='background:"+m.accent+"'>"+esc(m.label)+"</div>"+
          "<h3>"+esc(p.title)+"</h3>"+
          "<p class='vibe-line'>"+esc(m.tag)+"</p>"+
          "<div class='chips'>"+chips+"</div>"+
          "<span class='cta'>View role &amp; apply <span class='arr'>→</span></span>"+
          "</div>";
      }).join("");
      app.innerHTML="<h2 class='sec-title'>Find your seat on the Squad</h2>"+
        "<p class='sec-sub'>Four ways to make a real difference. Pick the one that feels like you.</p>"+
        "<div class='roles'>"+cards+"</div>";
      Array.prototype.forEach.call(app.querySelectorAll(".role"),function(b){
        b.addEventListener("click",function(){
          var s=b.getAttribute("data-slug");
          history.pushState({},"","/careers/"+encodeURIComponent(s));
          slug=s; sourceToken=null;
          api("/api/hr/public/positions/"+encodeURIComponent(s))
            .then(function(p){openRole(p,"website",null);})
            .catch(function(){listPositions();});
        });
      });
    }).catch(function(e){
      app.innerHTML="<div class='card err'>Could not load roles: "+esc(e.message)+"</div>";
    });
  }

  // ---- open a role into the wizard ----
  function openRole(p,source,sourceId){
    state={position:p,source:source||"website",sourceId:sourceId||null,step:0,
      data:{state:"NV",avail:{days:{},earliest:"",latest:"",type:""}},answers:{},resume:null};
    perksEl.style.display="none";
    window.scrollTo(0,0);
    renderWizard();
  }

  function backToList(){
    history.pushState({},"","/careers"); slug=null; sourceToken=null;
    perksEl.style.display=""; window.scrollTo(0,0); listPositions();
  }

  function progressHtml(){
    var out="<div class='progress'>";
    for(var i=0;i<STEPS.length;i++){
      var cls=i<state.step?"done":(i===state.step?"active":"");
      out+="<div class='pstep "+cls+"'><div class='bar'><i></i></div><div class='lbl'>"+esc(STEPS[i])+"</div></div>";
    }
    return out+"</div>";
  }

  function renderWizard(){
    var p=state.position, m=roleMeta(p);
    var head="<div class='card'>"+
      "<div class='rolehead'><span class='badge' style='background:"+m.accent+"'>"+esc(m.label)+"</span>"+
      "<div><h2>"+esc(p.title)+"</h2><div class='sub'>"+esc(locLabel(p.location_type))+
      (p.locations?(" · "+esc(p.locations)):"")+"</div></div></div>"+
      progressHtml()+
      "<div id='stepbody'></div>"+
      "<div id='err' class='err'></div>"+
      "<div class='nav' id='nav'></div>"+
      "</div>";
    app.innerHTML=head;
    renderStep();
  }

  function setErr(msg){document.getElementById("err").textContent=msg||"";}

  function renderStep(){
    var body=document.getElementById("stepbody");
    var nav=document.getElementById("nav");
    setErr("");
    if(state.step===0) body.innerHTML=stepBasics();
    else if(state.step===1) body.innerHTML=stepExperience();
    else if(state.step===2) body.innerHTML=stepAvailability();
    else if(state.step===3) body.innerHTML=stepFit();
    else body.innerHTML=stepReview();
    body.className="step-anim";
    wireStep();
    // nav buttons
    var backLbl=state.step===0?"← All roles":"← Back";
    var nextLbl=state.step===STEPS.length-1?"Submit application":"Continue →";
    nav.innerHTML="<button class='btn ghost' id='back'>"+backLbl+"</button>"+
      "<button class='btn primary' id='next'>"+nextLbl+"</button>";
    document.getElementById("back").addEventListener("click",goBack);
    document.getElementById("next").addEventListener("click",goNext);
    // refresh progress bar
    var ps=app.querySelectorAll(".pstep");
    for(var i=0;i<ps.length;i++){ps[i].className="pstep "+(i<state.step?"done":(i===state.step?"active":""));}
  }

  // step 0 — basics
  function stepBasics(){
    var d=state.data;
    return "<div class='step'><h3>First, the basics</h3>"+
      "<p class='lead'>Tell us who you are — this only takes a couple of minutes, promise.</p>"+
      "<div class='row2'>"+
        "<div><label>Full legal name <span class='req'>*</span></label><input id='full_name' value='"+esc(d.full_name||"")+"' placeholder='Alex Rivera'/></div>"+
        "<div><label>Preferred name</label><input id='preferred_name' value='"+esc(d.preferred_name||"")+"' placeholder='What should we call you?'/></div>"+
      "</div>"+
      "<div class='row2'>"+
        "<div><label>Email <span class='req'>*</span></label><input id='email' type='email' value='"+esc(d.email||"")+"' placeholder='you@email.com'/></div>"+
        "<div><label>Phone</label><input id='phone' type='tel' value='"+esc(d.phone||"")+"' placeholder='(702) 555-0123'/></div>"+
      "</div>"+
      "<label>Address</label>"+
      "<input id='address' value='"+esc(d.address||"")+"' placeholder='Street, city, state, ZIP'/>"+
      "<div class='row2'>"+
        "<div><label>City</label><input id='city' value='"+esc(d.city||"")+"' placeholder='Las Vegas'/></div>"+
        "<div><label>State</label><input id='state' value='"+esc(d.state||"NV")+"'/></div>"+
      "</div></div>";
  }

  // step 1 — experience, pay, credentials, education, resume
  function stepExperience(){
    var d=state.data, r=state.resume;
    var drop=r?
      ("<div class='drop has' id='drop'><div class='ic'>"+ICON.filecheck+"</div><div class='fname'>"+esc(r.filename)+"</div><div class='hint'>Looks great — tap to choose a different file</div></div>")
      :("<div class='drop' id='drop'><div class='ic'>"+ICON.paperclip+"</div><div><b>Add your resume</b></div><div class='hint'>PDF or Word · drag &amp; drop or tap · optional but loved</div></div>");
    return "<div class='step'><h3>Your experience</h3>"+
      "<p class='lead'>Give us the highlights — you can be brief.</p>"+
      "<div class='row2'>"+
        "<div><label>Desired pay rate</label><input id='desired_pay' value='"+esc(d.desired_pay||"")+"' placeholder='e.g. $25/hr or negotiable'/></div>"+
        "<div><label>Earliest start date</label><input id='earliest_start' value='"+esc(d.earliest_start||"")+"' placeholder='e.g. Immediately, or in 2 weeks'/></div>"+
      "</div>"+
      "<label>Certifications &amp; licenses</label>"+
      "<textarea id='certifications' placeholder='RBT, BCBA, BCaBA, CPR/BLS, driver&#39;s license…'>"+esc(d.certifications||"")+"</textarea>"+
      "<label>Education</label>"+
      "<textarea id='education' placeholder='Degrees, schools, years — most recent first'>"+esc(d.education||"")+"</textarea>"+
      "<label>Relevant experience &amp; employment history</label>"+
      "<textarea id='employment_history' placeholder='Roles, employers, and dates — most recent first. Tell us what you did!'>"+esc(d.employment_history||"")+"</textarea>"+
      "<label>Resume</label>"+drop+
      "<input type='file' id='resume' accept='.pdf,.docx,.doc' style='display:none'/></div>";
  }

  // step 2 — interactive availability selector
  function stepAvailability(){
    var a=state.data.avail||{days:{},earliest:"",latest:"",type:""};
    var dayBtns=DAYS_OF_WEEK.map(function(day){
      return "<button type='button' class='day-btn"+(a.days[day]?" sel":"")+"' data-day='"+day+"'>"+day+"</button>";
    }).join("");
    var typeBtn=function(v,label){return "<button type='button' class='type-btn"+(a.type===v?" sel":"")+"' data-type='"+v+"'>"+label+"</button>";};
    return "<div class='step'><h3>Your availability</h3>"+
      "<p class='lead'>Tap the days you can work, then set your typical hours. This helps us build a schedule that fits your life.</p>"+
      "<label>Days you're available</label>"+
      "<div class='day-row'>"+dayBtns+"</div>"+
      "<div class='row2'>"+
        "<div><label>Earliest start time</label><input id='av_earliest' type='time' value='"+esc(a.earliest||"")+"'/></div>"+
        "<div><label>Latest end time</label><input id='av_latest' type='time' value='"+esc(a.latest||"")+"'/></div>"+
      "</div>"+
      "<label>Preferred weekly hours</label>"+
      "<input id='av_hours' type='number' min='0' max='60' value='"+esc(a.weekly_hours||"")+"' placeholder='e.g. 25'/>"+
      "<label>Are you looking for…</label>"+
      "<div class='type-row'>"+typeBtn("full_time","Full-time")+typeBtn("part_time","Part-time")+typeBtn("either","Either works")+"</div>"+
      "<label>Any scheduling limitations?</label>"+
      "<textarea id='av_notes' placeholder='e.g. No Sundays, classes on Tue/Thu mornings, need afternoons…'>"+esc(a.notes||"")+"</textarea>"+
      "</div>";
  }

  // step 2 — screening questions
  function stepFit(){
    var qs=state.position.screening_questions||[];
    var inner="";
    if(!qs.length){
      inner="<p class='lead'>No extra questions for this role — you're all set. Hit continue!</p>";
    }
    qs.forEach(function(q){
      var val=state.answers[q.id]||"";
      inner+="<div class='q' data-qid='"+esc(q.id)+"'><div class='ql'>"+esc(q.label)+"</div>";
      if(q.type==="yesno"){
        inner+="<div class='yesno'>"+
          "<button type='button' data-yn='Yes' class='"+(val==="Yes"?"sel":"")+"'>Yes</button>"+
          "<button type='button' data-yn='No' class='no "+(val==="No"?"sel":"")+"'>No</button></div>";
      } else {
        inner+="<input class='qtext' value='"+esc(val)+"' placeholder='Type your answer…'/>";
      }
      inner+="</div>";
    });
    return "<div class='step'><h3>Let's see your fit</h3>"+
      "<p class='lead'>Quick, honest answers help us match you to the right spot. There are no wrong ones.</p>"+inner+
      "<label>Why Spectrum Squad? Anything you'd love us to know</label>"+
      "<textarea id='cover_letter' placeholder='Tell us what drew you to ABA, a moment you're proud of, or just say hi!'>"+esc(state.data.cover_letter||"")+"</textarea>"+
      "</div>";
  }

  // step 4 — review + consent
  function availabilitySummary(){
    var a=state.data.avail||{days:{}};
    var days=DAYS_OF_WEEK.filter(function(x){return a.days[x];}).join(", ");
    var parts=[];
    if(days) parts.push(days);
    if(a.earliest||a.latest) parts.push((a.earliest||"?")+"–"+(a.latest||"?"));
    if(a.weekly_hours) parts.push(a.weekly_hours+" hrs/wk");
    if(a.type) parts.push({full_time:"Full-time",part_time:"Part-time",either:"FT or PT"}[a.type]||a.type);
    return parts.join(" · ");
  }
  function stepReview(){
    var d=state.data, p=state.position, m=roleMeta(p);
    function row(k,v){return v?("<li><span class='k'>"+esc(k)+"</span><span class='v'>"+esc(v)+"</span></li>"):"";}
    var qs=state.position.screening_questions||[];
    var ans="";
    qs.forEach(function(q){ if(state.answers[q.id]) ans+=row(q.label,state.answers[q.id]); });
    return "<div class='step'><h3>Almost there!</h3>"+
      "<p class='lead'>Give it a quick look, then send it our way.</p>"+
      "<ul class='review-list'>"+
        row("Role",p.title)+
        row("Name",d.full_name)+
        row("Preferred name",d.preferred_name)+
        row("Email",d.email)+
        row("Phone",d.phone)+
        row("Address",d.address)+
        row("Desired pay",d.desired_pay)+
        row("Availability",availabilitySummary())+
        row("Earliest start",d.earliest_start)+
        row("Resume",state.resume?state.resume.filename:"")+
        ans+
      "</ul>"+
      "<div class='check'><input type='checkbox' id='consent_email' checked/>"+
        "<label for='consent_email' style='margin:0;font-weight:500'>Yes, email me about my application and next steps.</label></div>"+
      "<p class='sec-sub' style='font-size:12px;text-align:left;margin:6px 0 0'>Your info is used only to consider your application and is never sold. We welcome every applicant, without regard to any protected characteristic.</p>"+
      "</div>";
  }

  // wire up listeners for the current step
  function wireStep(){
    // Step 3 (Your fit): yes/no toggle buttons on screening questions.
    if(state.step===3){
      Array.prototype.forEach.call(app.querySelectorAll(".q"),function(qd){
        var qid=qd.getAttribute("data-qid");
        Array.prototype.forEach.call(qd.querySelectorAll("[data-yn]"),function(btn){
          btn.addEventListener("click",function(){
            var yn=btn.getAttribute("data-yn");
            state.answers[qid]=yn;
            Array.prototype.forEach.call(qd.querySelectorAll("[data-yn]"),function(b2){
              var on=b2.getAttribute("data-yn")===yn;
              b2.className=(b2.getAttribute("data-yn")==="No"?"no ":"")+(on?"sel":"");
            });
          });
        });
      });
    }
    // Step 1 (Experience): resume drag-and-drop.
    if(state.step===1){
      var drop=document.getElementById("drop");
      var file=document.getElementById("resume");
      if(drop&&file){
        drop.addEventListener("click",function(){file.click();});
        ["dragenter","dragover"].forEach(function(ev){drop.addEventListener(ev,function(e){e.preventDefault();drop.classList.add("over");});});
        ["dragleave","drop"].forEach(function(ev){drop.addEventListener(ev,function(e){e.preventDefault();drop.classList.remove("over");});});
        drop.addEventListener("drop",function(e){ if(e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0]) takeFile(e.dataTransfer.files[0]); });
        file.addEventListener("change",function(){ if(file.files&&file.files[0]) takeFile(file.files[0]); });
      }
    }
    // Step 2 (Availability): day and full/part-time toggle buttons.
    if(state.step===2){
      Array.prototype.forEach.call(app.querySelectorAll(".day-btn"),function(btn){
        btn.addEventListener("click",function(){
          var day=btn.getAttribute("data-day");
          state.data.avail.days[day]=!state.data.avail.days[day];
          btn.className="day-btn"+(state.data.avail.days[day]?" sel":"");
        });
      });
      Array.prototype.forEach.call(app.querySelectorAll(".type-btn"),function(btn){
        btn.addEventListener("click",function(){
          state.data.avail.type=btn.getAttribute("data-type");
          Array.prototype.forEach.call(app.querySelectorAll(".type-btn"),function(b2){
            b2.className="type-btn"+(b2.getAttribute("data-type")===state.data.avail.type?" sel":"");
          });
        });
      });
    }
  }

  function takeFile(f){
    if(f.size>8*1024*1024){ setErr("That resume is over 8MB — please pick a smaller file."); return; }
    var reader=new FileReader();
    reader.onload=function(){
      state.resume={filename:f.name,mime_type:f.type,content_base64:String(reader.result).split(",")[1]};
      renderStep();
    };
    reader.onerror=function(){ setErr("Couldn't read that file — try another one."); };
    reader.readAsDataURL(f);
  }

  // capture the current step's inputs into state
  function captureStep(){
    if(state.step===0){
      state.data.full_name=(val("full_name")||"").trim();
      state.data.preferred_name=(val("preferred_name")||"").trim();
      state.data.email=(val("email")||"").trim();
      state.data.phone=(val("phone")||"").trim();
      state.data.address=(val("address")||"").trim();
      state.data.city=(val("city")||"").trim();
      state.data.state=(val("state")||"").trim();
    } else if(state.step===1){
      state.data.desired_pay=(val("desired_pay")||"").trim();
      state.data.earliest_start=(val("earliest_start")||"").trim();
      state.data.certifications=(val("certifications")||"").trim();
      state.data.education=(val("education")||"").trim();
      state.data.employment_history=(val("employment_history")||"").trim();
    } else if(state.step===2){
      if(!state.data.avail) state.data.avail={days:{},earliest:"",latest:"",type:""};
      state.data.avail.earliest=val("av_earliest")||"";
      state.data.avail.latest=val("av_latest")||"";
      state.data.avail.weekly_hours=(val("av_hours")||"").trim();
      state.data.avail.notes=(val("av_notes")||"").trim();
    } else if(state.step===3){
      Array.prototype.forEach.call(app.querySelectorAll(".q"),function(qd){
        var qid=qd.getAttribute("data-qid");
        var txt=qd.querySelector(".qtext");
        if(txt) state.answers[qid]=txt.value.trim();
      });
      state.data.cover_letter=(val("cover_letter")||"").trim();
    }
  }
  function val(id){var e=document.getElementById(id);return e?e.value:"";}

  function validateStep(){
    if(state.step===0){
      if(!state.data.full_name) return "Please tell us your name.";
      if(!state.data.email && !state.data.phone) return "We need an email or a phone number to reach you.";
      if(state.data.email && state.data.email.indexOf("@")<0) return "That email doesn't look quite right.";
    }
    return null;
  }

  function goBack(){
    if(state.step===0){ backToList(); return; }
    captureStep();
    state.step--; window.scrollTo(0,0); renderStep();
  }

  function goNext(){
    captureStep();
    var v=validateStep();
    if(v){ setErr(v); return; }
    if(state.step<STEPS.length-1){ state.step++; window.scrollTo(0,0); renderStep(); return; }
    submitApplication();
  }

  function submitApplication(){
    var btn=document.getElementById("next");
    btn.disabled=true; btn.innerHTML="<span class='spin'></span>Sending…";
    var d=state.data, p=state.position;
    var payload={
      full_name:d.full_name, preferred_name:d.preferred_name, email:d.email, phone:d.phone,
      address:d.address, city:d.city, state:d.state,
      desired_pay:d.desired_pay, comp_expectation:d.desired_pay,
      certifications:d.certifications, education:d.education, employment_history:d.employment_history,
      earliest_start:d.earliest_start, cover_letter:d.cover_letter,
      availability:d.avail,
      screening_answers:state.answers,
      consent_email:document.getElementById("consent_email").checked,
      slug:p.slug, source:state.source, source_token:sourceToken
    };
    if(state.resume) payload.resume=state.resume;
    api("/api/hr/apply",{method:"POST",body:payload}).then(function(){
      renderSuccess();
    }).catch(function(e){
      setErr(e.message||"Something went wrong — please try again.");
      btn.disabled=false; btn.innerHTML="Submit application";
    });
  }

  function renderSuccess(){
    var p=state.position, m=roleMeta(p);
    perksEl.style.display="none";
    app.innerHTML="<div class='card ok'>"+
      "<div class='big'>"+ICON.success+"</div>"+
      "<h2>You're in the running!</h2>"+
      "<p class='sec-sub'>Thanks for applying to be our <b>"+esc(p.title)+"</b>, "+esc(firstName(state.data.full_name))+". We're genuinely excited to read it.</p>"+
      "<div class='next'>"+
        "<div class='n'><div class='num'>1</div><div class='txt'><b>We review your application</b> — a real human on our team, usually within a few business days.</div></div>"+
        "<div class='n'><div class='num'>2</div><div class='txt'><b>We reach out</b> to set up a friendly chat if it looks like a fit.</div></div>"+
        "<div class='n'><div class='num'>3</div><div class='txt'><b>You meet the Squad</b> and we figure out your perfect role together.</div></div>"+
      "</div>"+
      "<div class='nav'><button class='btn ghost' id='again' style='flex:1'>← Back to all roles</button></div>"+
      "</div>";
    document.getElementById("again").addEventListener("click",backToList);
    window.scrollTo(0,0);
    confetti();
  }
  function firstName(n){return (String(n||"").trim().split(/\s+/)[0])||"there";}

  // ---- lightweight canvas confetti (no libraries) ----
  function confetti(){
    var c=document.createElement("canvas");
    c.style.cssText="position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:9999";
    document.body.appendChild(c);
    var ctx=c.getContext("2d");
    function size(){c.width=window.innerWidth;c.height=window.innerHeight;} size();
    window.addEventListener("resize",size);
    var colors=["#e0a430","#c98f22","#f2cf76","#b9781a","#8a5f14","#e7b24a"];
    var P=[];
    for(var i=0;i<150;i++){
      P.push({x:Math.random()*c.width,y:-20-Math.random()*c.height*0.5,
        r:6+Math.random()*8,color:colors[i%colors.length],
        vy:2+Math.random()*4,vx:-2.5+Math.random()*5,rot:Math.random()*6.28,vr:-0.25+Math.random()*0.5});
    }
    var start=null;
    function frame(ts){
      if(start===null)start=ts;
      ctx.clearRect(0,0,c.width,c.height);
      for(var i=0;i<P.length;i++){
        var p=P[i]; p.x+=p.vx; p.y+=p.vy; p.vy+=0.03; p.rot+=p.vr;
        ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.rot); ctx.fillStyle=p.color;
        ctx.fillRect(-p.r/2,-p.r/2,p.r,p.r*0.62); ctx.restore();
      }
      if(ts-start<4200){ requestAnimationFrame(frame); } else { c.remove(); }
    }
    requestAnimationFrame(frame);
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
    processReminders,
    processDailySummary,
    processCredentialAlerts,
    processHrDocFollowups,
    processHrMilestones,
    milestonesThisWeek,
    // exposed for tests / future phases
    _internal: {
      evaluateMatch, PIPELINE_STAGES, APPLICATION_SOURCES, MATCH_CATEGORIES,
      hrCanAccess, hrCanManage, hrCanSeeSensitive, runScreening, buildScreeningContent, ASSESSMENT_SCHEMA,
      followupMessage, enrollFollowupSequence, processFollowups, missingQuestions,
      handleInbound, draftReply, parseCsv, extractEmail,
      detectTimecardAnomalies, importTimecard, buildDailySummary,
      parseXlsx, buildPayrollTimecards,
      classifyBillable, timecardTotals, shapeTimecardPreview, timecardEmailHtml, timecardVerifyHtml, saveTimecardPdf,
      parsePlatformApplication, matchPosition, handlePlatformApplication,
    },
  };
};
