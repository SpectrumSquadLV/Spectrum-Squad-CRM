// server.js -- Spectrum Squad ABA Client Pipeline CRM
// Single-file build (consolidated for easy manual deployment via GitHub's
// web UI). Uses Postgres (via the `pg` package) for persistent storage, and
// the Railway volume mounted at /app/data for uploaded client documents.
// Run with: node server.js
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const crypto = require("crypto");
const { Pool } = require("pg");

// ============================== DATABASE ==============================
// server/db.js
// Postgres layer using the `pg` package. Requires DATABASE_URL to be set
// (Railway provides this automatically when a Postgres service is linked).
"use strict";

const DATABASE_URL = process.env.DATABASE_URL || "";
if (!DATABASE_URL) {
  console.error("FATAL: DATABASE_URL is not set. Cannot connect to Postgres.");
}

// Railway's internal networking (host ending in .railway.internal) does not
// use/need TLS, and neither does a Postgres on this machine: a local or
// containerised server has no TLS at all unless somebody configures it, and
// the connection never leaves the host. Demanding it anyway is not a stricter
// posture, it is a refusal to start -- "The server does not support SSL
// connections" is what CI got from the stock postgres:16 image, and what
// anyone gets running the app against a plain local Postgres.
// Any other host (e.g. Railway's public proxy) still gets TLS.
const dbHost = (() => {
  try { return new URL(DATABASE_URL).hostname; } catch (e) { return ""; }
})();
const DB_HOST_IS_LOCAL = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(dbHost);
const needsSSL = DATABASE_URL && !DATABASE_URL.includes("railway.internal") && !DB_HOST_IS_LOCAL;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: needsSSL ? { rejectUnauthorized: false } : false,
});

// Converts our SQLite-style "?" placeholders into Postgres-style "$1, $2..."
// placeholders, so the rest of the app can keep using "?" everywhere.
function toPgQuery(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function dbGet(sql, params = []) {
  const res = await pool.query(toPgQuery(sql), params);
  return res.rows[0];
}

async function dbAll(sql, params = []) {
  const res = await pool.query(toPgQuery(sql), params);
  return res.rows;
}

async function dbRun(sql, params = []) {
  const res = await pool.query(toPgQuery(sql), params);
  return { rowCount: res.rowCount, rows: res.rows };
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS departments (
  id SERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  notify_email TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL, -- admin | intake | clinical | billing | scheduling
  department_id INTEGER,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  child_name TEXT NOT NULL,
  dob TEXT,
  parent_name TEXT,
  parent_relationship TEXT,
  parent_email TEXT,
  parent_phone TEXT,
  address TEXT,
  service_location TEXT,
  school_status TEXT,
  start_urgency TEXT,
  insurance_provider TEXT,
  num_insurances TEXT,
  has_asd_diagnosis TEXT,
  has_iep TEXT,
  prior_aba_nv TEXT,
  preferred_contact TEXT,
  desired_schedule TEXT, -- Full-Time | Part Time AM | Part Time PM
  rethink_status TEXT,
  stage TEXT NOT NULL DEFAULT 'new_submission',
  notes TEXT,
  color TEXT,
  first_day_date TEXT,
  discharge_reason TEXT,
  submitted_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS stage_tasks (
  id SERIAL PRIMARY KEY,
  stage_key TEXT NOT NULL,
  label TEXT NOT NULL,
  department_id INTEGER NOT NULL,
  sla_days INTEGER NOT NULL,
  sort_order INTEGER NOT NULL,
  next_stage_key TEXT,
  -- Whether this stage task may be assigned to a staff member. The automated,
  -- parent-driven Clinical Screener is seeded false (see seedStageTasks).
  assignable BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS client_tasks (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL,
  stage_task_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | completed | overdue
  due_date TEXT NOT NULL,
  completed_at TEXT,
  overdue_notified_at TEXT,
  created_at TEXT,
  FOREIGN KEY (client_id) REFERENCES clients(id),
  FOREIGN KEY (stage_task_id) REFERENCES stage_tasks(id)
);

CREATE TABLE IF NOT EXISTS notifications_log (
  id SERIAL PRIMARY KEY,
  client_id INTEGER,
  type TEXT NOT NULL, -- department_alert | parent_milestone | overdue_alert | auth_alert
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_at TEXT,
  delivered TEXT DEFAULT 'simulated' -- simulated | sent | failed
);

CREATE TABLE IF NOT EXISTS therapists (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL, -- BCBA | RBT
  color TEXT NOT NULL,
  weekly_capacity_hours REAL DEFAULT 30
);

CREATE TABLE IF NOT EXISTS schedule_sessions (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL,
  therapist_id INTEGER NOT NULL,
  day_of_week INTEGER NOT NULL, -- 0=Sun .. 6=Sat
  start_time TEXT NOT NULL, -- 'HH:MM'
  end_time TEXT NOT NULL,
  session_type TEXT DEFAULT 'ABA Therapy',
  created_at TEXT,
  FOREIGN KEY (client_id) REFERENCES clients(id),
  FOREIGN KEY (therapist_id) REFERENCES therapists(id)
);

CREATE TABLE IF NOT EXISTS schedule_targets (
  key TEXT PRIMARY KEY,
  weekly_hours REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS client_documents (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT,
  file_path TEXT,
  doc_type TEXT NOT NULL DEFAULT 'hosted', -- hosted | link
  external_url TEXT,
  uploaded_at TEXT,
  FOREIGN KEY (client_id) REFERENCES clients(id)
);

CREATE TABLE IF NOT EXISTS client_notes (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL,
  author_id INTEGER,
  author_name TEXT,
  body TEXT NOT NULL,
  created_at TEXT,
  FOREIGN KEY (client_id) REFERENCES clients(id)
);

-- Staff to-do items: assignable to any user, with a due date + email reminder.
CREATE TABLE IF NOT EXISTS staff_tasks (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  assigned_user_id INTEGER,
  assigned_name TEXT,
  client_id INTEGER,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | done
  reminder_sent_at TEXT,
  created_by TEXT,
  created_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS auth_alerts (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL,
  milestone_days INTEGER NOT NULL, -- 60 | 30 | 14 | 7 | 0
  alert_level TEXT NOT NULL, -- informational | attention | urgent | critical | overdue
  expiration_snapshot TEXT NOT NULL, -- auth_expiration_date this alert was generated against
  status TEXT NOT NULL DEFAULT 'open', -- open | reviewed | renewal_started | completed | reopened | superseded
  assigned_to TEXT,
  email_sent TEXT, -- sent | failed | partial | simulated | not_configured
  email_sent_at TEXT,
  email_recipients TEXT,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (client_id) REFERENCES clients(id)
);

CREATE TABLE IF NOT EXISTS auth_audit_log (
  id SERIAL PRIMARY KEY,
  client_id INTEGER,
  alert_id INTEGER,
  action TEXT NOT NULL,
  actor TEXT,
  previous_value TEXT,
  new_value TEXT,
  detail TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS clickup_config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  encrypted_token TEXT,
  token_iv TEXT,
  token_auth_tag TEXT,
  workspace_id TEXT,
  space_id TEXT,
  folder_id TEXT,
  list_ids TEXT, -- comma-separated ClickUp list IDs to sync
  last_connection_status TEXT, -- connected | disconnected | connection_failed
  updated_by TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS clickup_sync_log (
  id SERIAL PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running', -- running | success | failed
  tasks_synced INTEGER DEFAULT 0,
  tasks_created INTEGER DEFAULT 0,
  tasks_updated INTEGER DEFAULT 0,
  error TEXT,
  triggered_by TEXT NOT NULL DEFAULT 'scheduled' -- scheduled | manual
);

CREATE TABLE IF NOT EXISTS clickup_tasks (
  id SERIAL PRIMARY KEY,
  clickup_task_id TEXT UNIQUE NOT NULL,
  list_id TEXT,
  name TEXT,
  status TEXT,
  category TEXT, -- mapped via clickup_category_mappings
  assignee TEXT,
  due_date TEXT,
  date_created TEXT,
  date_closed TEXT,
  url TEXT,
  raw_json TEXT,
  first_synced_at TEXT,
  last_synced_at TEXT
);

CREATE TABLE IF NOT EXISTS clickup_category_mappings (
  id SERIAL PRIMARY KEY,
  list_id TEXT NOT NULL UNIQUE,
  list_name TEXT,
  category TEXT NOT NULL, -- Billing | Credentialing | Authorizations | Appeals | Provider Enrollment | Insurance Follow-up | Client Billing | Collections | Other
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS financial_audit_log (
  id SERIAL PRIMARY KEY,
  actor TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT
);

-- Generic key/value store for owner-configurable settings (e.g. the address
-- Benefits & Eligibility Check emails are sent to).
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS email_templates (
  id SERIAL PRIMARY KEY,
  template_key TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  category TEXT,
  subject_template TEXT NOT NULL,
  body_template TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS enrollment_packets (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL UNIQUE,
  signnow_document_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent', -- sent | completed | declined | expired
  sent_at TEXT NOT NULL,
  last_reminder_at TEXT,
  reminder_count INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  FOREIGN KEY (client_id) REFERENCES clients(id)
  );
CREATE TABLE IF NOT EXISTS newhire_packets (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL UNIQUE,
  signnow_document_id TEXT,
  status TEXT NOT NULL DEFAULT 'sent', -- sent | completed | failed | blocked
  recipient_email TEXT,
  sent_at TEXT,
  completed_at TEXT,
  error_detail TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  triggered_by TEXT
  );
`;

// Small forward-compatible migrations for columns/tables added after the
// database already existed in production. Safe to run every boot.
const MIGRATIONS_SQL = `
ALTER TABLE client_documents ALTER COLUMN file_path DROP NOT NULL;
ALTER TABLE client_documents ADD COLUMN IF NOT EXISTS doc_type TEXT NOT NULL DEFAULT 'hosted';
ALTER TABLE client_documents ADD COLUMN IF NOT EXISTS external_url TEXT;
ALTER TABLE client_documents ADD COLUMN IF NOT EXISTS is_insurance_card BOOLEAN NOT NULL DEFAULT false;

-- Enrollment packet reliability: record failed/blocked attempts (not just successes)
-- so nothing fails silently, and allow a null document id for a failed attempt.
ALTER TABLE enrollment_packets ALTER COLUMN signnow_document_id DROP NOT NULL;
ALTER TABLE enrollment_packets ADD COLUMN IF NOT EXISTS error_detail TEXT;
ALTER TABLE enrollment_packets ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE enrollment_packets ADD COLUMN IF NOT EXISTS last_attempt_at TEXT;
-- The 7-day "not completed -> not moving forward" clock stops while a client
-- sits on the waitlist. paused_since marks when the current pause started;
-- paused_ms is the total time already excluded from previous pauses. Elapsed
-- time is measured against sent_at minus paused_ms, so a family who waited
-- three weeks resumes with the days they actually had left, not zero.
ALTER TABLE enrollment_packets ADD COLUMN IF NOT EXISTS paused_since TEXT;
ALTER TABLE enrollment_packets ADD COLUMN IF NOT EXISTS paused_ms BIGINT NOT NULL DEFAULT 0;

-- A deliberate, reversible hold on the automated intake-paperwork chasers,
-- put there by a person for a family the automatic rules cannot spot: the case
-- it was built for is a packet the CRM believes it sent and SignNow never
-- delivered, where the family is being chased daily for a document they never
-- received and would be closed out for not signing it. The timestamp is the
-- flag; who and why are recorded alongside so the hold can be audited and
-- safely lifted rather than becoming permanent silence. See intake-chasing.js.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS intake_chasing_paused_at TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS intake_chasing_paused_by TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS intake_chasing_pause_note TEXT;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS insurance_payer TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS auth_start_date TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS auth_expiration_date TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS assigned_bcba_name TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS assigned_bcba_email TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS assigned_billing_name TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS assigned_billing_email TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS authorization_status TEXT NOT NULL DEFAULT 'Not Required';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS auth_notes TEXT;

ALTER TABLE clickup_config ADD COLUMN IF NOT EXISTS last_connection_status TEXT;
ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS acknowledged BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS acknowledged_at TEXT;
ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS ack_token TEXT;
-- Which channel a notification went out on. Defaults to 'email' so every
-- existing row keeps its meaning; SMS sends write 'sms'.
ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'email';
-- SMS opt-out suppression list (TCPA). One row per phone that has texted STOP
-- (or been suppressed by staff); honored on every outbound send.
CREATE TABLE IF NOT EXISTS sms_opt_outs (
  phone TEXT PRIMARY KEY,
  opted_out_at TEXT,
  reason TEXT
);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS diagnosis_uploaded BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS insurance_card_uploaded BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS eligibility_check_sent_at TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS clinical_screener_completed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS insurance_verification_completed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS intake_packet_sent BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS intake_packet_returned BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS vineland_completed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS intake_assessment_scheduled_date TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS intake_assessment_completed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS authorization_submitted BOOLEAN NOT NULL DEFAULT false;
-- When the treatment plan actually went out for authorization, and when the
-- payer came back with a yes. Kept as separate dates because they are weeks
-- apart and parents are told different things at each point.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS treatment_plan_submitted_date TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS authorization_approved_date TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS previous_provider_discharge_letter_received BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS physician_referral_received BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS additional_insurance_docs_received BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS rethink_client_created BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS assigned_rbt_name TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS schedule_finalized BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS stage_entered_at TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS assigned_intake_coordinator_name TEXT;
-- A task can be assigned to someone who works here but has no CRM login, so
-- their address is stored on the task rather than resolved through users.
ALTER TABLE staff_tasks ADD COLUMN IF NOT EXISTS assigned_email TEXT;
-- Reopening a task that was ticked by accident. The task itself is reused --
-- never duplicated -- so these columns are what is left to show that it WAS
-- completed and was later put back: when it was last completed, who reopened
-- it, when, and how many times. Additive; every existing row reads as
-- "never reopened".
ALTER TABLE staff_tasks ADD COLUMN IF NOT EXISTS last_completed_at TEXT;
ALTER TABLE staff_tasks ADD COLUMN IF NOT EXISTS reopened_at TEXT;
ALTER TABLE staff_tasks ADD COLUMN IF NOT EXISTS reopened_by TEXT;
ALTER TABLE staff_tasks ADD COLUMN IF NOT EXISTS reopen_count INTEGER NOT NULL DEFAULT 0;
-- The same, for the per-client stage tasks on the client record.
ALTER TABLE client_tasks ADD COLUMN IF NOT EXISTS last_completed_at TEXT;
ALTER TABLE client_tasks ADD COLUMN IF NOT EXISTS reopened_at TEXT;
ALTER TABLE client_tasks ADD COLUMN IF NOT EXISTS reopened_by TEXT;
ALTER TABLE client_tasks ADD COLUMN IF NOT EXISTS reopen_count INTEGER NOT NULL DEFAULT 0;
-- Backfill: a task that is already completed has its completion date copied
-- across, so a task ticked before this change still shows its original
-- completion date if it is reopened later. Runs once; the WHERE clause makes
-- it a no-op afterwards.
UPDATE client_tasks SET last_completed_at = completed_at WHERE completed_at IS NOT NULL AND last_completed_at IS NULL;
UPDATE staff_tasks SET last_completed_at = completed_at WHERE completed_at IS NOT NULL AND last_completed_at IS NULL;
-- Task priority for the personal Task Center: low | normal | high | urgent.
ALTER TABLE staff_tasks ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS waitlisted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS waitlisted_at TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS waitlist_reason TEXT;
-- In-clinic / in-home assessment (observation used to build the treatment plan)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS in_clinic_assessment_date TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS assessment_location TEXT; -- in_clinic | in_home
ALTER TABLE clients ADD COLUMN IF NOT EXISTS assessment_reminder_sent_at TEXT;
-- Standardized assessment battery: each has its own checkmark + date.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS pddbi_completed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS pddbi_date TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS srs2_completed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS srs2_date TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS psi_completed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS psi_date TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS vineland_tricare_completed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS vineland_tricare_date TEXT;
-- Treatment plan is due 14 calendar days after the in-person assessment. The
-- due date is computed when the assessment date is entered; tp_reminders_sent
-- records which escalation steps (assigned / 7 / 3 / 1 / overdue) have already
-- fired so the sweep never emails the same step twice.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS treatment_plan_due_date TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS tp_reminders_sent TEXT NOT NULL DEFAULT '[]';
-- Transportation services provided by Spectrum Squad (surfaced to schedulers).
ALTER TABLE clients ADD COLUMN IF NOT EXISTS transportation_services BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS transportation_notes TEXT;
-- Parent/guardian express consent to receive text messages (TCPA). Texting has
-- since been removed, but these columns stay: a consent a family gave is a
-- record about them, not a feature flag, and deleting it would destroy the
-- evidence that it was properly obtained.
-- A task ticked as "already done" rather than done now: the work happened
-- outside the CRM, so no parent email or department alert was sent for it.
-- Recorded because somebody will later ask why a family never heard about a
-- step, and "it was back-filled" is the answer.
ALTER TABLE client_tasks ADD COLUMN IF NOT EXISTS completed_silently BOOLEAN NOT NULL DEFAULT false;
-- The child is already receiving ABA somewhere else. A child can only be
-- authorised with one ABA provider at a time, so this blocks a start date until
-- a termination letter from the current provider is in hand. Captured from the
-- clinical screener, where the parent is the one who knows.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS current_aba_provider TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS needs_aba_termination_letter BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS aba_termination_letter_received_at TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS parent_sms_consent BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS parent_sms_consent_at TEXT;
-- Rename the old Vineland stage task to the In-Clinic Assessment.
UPDATE stage_tasks SET label = 'Schedule In-Clinic Assessment' WHERE stage_key = 'assessment_scheduling' AND label = 'Schedule Vineland / Intake Assessment';
-- The Clinical Screener is auto-triggered when a family starts intake and is
-- driven entirely by the screener module (invite, remind, host, mark complete).
-- It must NEVER be handed to a staff member, so it is flagged non-assignable.
-- Other stage tasks default to assignable = true.
ALTER TABLE stage_tasks ADD COLUMN IF NOT EXISTS assignable BOOLEAN NOT NULL DEFAULT true;
UPDATE stage_tasks SET assignable = false WHERE stage_key = 'clinical_screener';
-- "Intake Packet" was retired as a phase. Anyone parked in it moves to the
-- next stage along. This is a plain UPDATE rather than enterStage() on
-- purpose: enterStage fires the department alert and the parent milestone
-- email, and a family should not receive "great news, time for your
-- assessment" because of a schema change. Their existing intake-packet tasks
-- are deliberately left alone -- still visible, still tickable -- rather than
-- silently marked done on someone's behalf. Idempotent: after the first run
-- there is nothing left to match.
UPDATE clients SET stage = 'assessment_scheduling', updated_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE stage = 'intake_packet';
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_view_financials BOOLEAN NOT NULL DEFAULT false;
-- Per-user granular module access overrides: JSON map { moduleKey: bool }.
-- Absent key = fall back to the role default. Lets the owner grant or restrict
-- individual nav sections per user.
ALTER TABLE users ADD COLUMN IF NOT EXISTS module_access TEXT;

  CREATE TABLE IF NOT EXISTS client_financial_settings (
    client_id INTEGER PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
    authorized_hours_per_week REAL,
    custom_projected_hours_per_week REAL,
    hours_source_preference TEXT,
    service_start_date_override TEXT,
    service_end_date_override TEXT,
    lifetime_calc_source TEXT NOT NULL DEFAULT 'estimated_from_schedule',
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS owner_financial_settings (
    id INTEGER PRIMARY KEY,
    avg_revenue_per_hour REAL NOT NULL DEFAULT 50,
    avg_net_profit_per_hour REAL NOT NULL DEFAULT 11,
    monthly_conversion_factor REAL NOT NULL DEFAULT 4.33,
    default_hours_source TEXT NOT NULL DEFAULT 'scheduled',
    financial_view_roles TEXT NOT NULL DEFAULT 'owner,super_admin'
  );

  INSERT INTO owner_financial_settings (id, avg_revenue_per_hour, avg_net_profit_per_hour, monthly_conversion_factor, default_hours_source, financial_view_roles)
  VALUES (1, 50, 11, 4.33, 'scheduled', 'owner,super_admin')
  ON CONFLICT (id) DO NOTHING;

  UPDATE users SET role = 'owner' WHERE email = 'admin@spectrumsquadlv.com' AND role = 'admin';

  -- Financials are owner-only. Clear any per-user financial-view flag that may
  -- have been granted to a non-owner account, and reset the stored view-roles
  -- list so nothing outside owner/super_admin can ever be shown financial data.
  UPDATE users SET can_view_financials = false WHERE role NOT IN ('owner', 'super_admin');
  UPDATE owner_financial_settings SET financial_view_roles = 'owner,super_admin';

  -- Default recipient for automatic Benefits & Eligibility Check emails.
  INSERT INTO app_settings (key, value, updated_at)
  VALUES ('eligibility_check_email', 'vb@cubetherapybilling.com', now()::text)
  ON CONFLICT (key) DO NOTHING;
`;

async function initSchema() {
  await pool.query(SCHEMA_SQL);
  await pool.query(MIGRATIONS_SQL);
  console.log("Postgres schema ready.");
}

function nowISO() {
  return new Date().toISOString();
}

// Today as YYYY-MM-DD in Pacific, which is the office's day -- UTC would roll
// over mid-afternoon and stamp tomorrow's date on this afternoon's work.
function todayISODate() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

// ---- App settings (owner-configurable key/value store) ----
async function getAppSetting(key, fallback = null) {
  const row = await dbGet("SELECT value FROM app_settings WHERE key = ?", [key]);
  return row && row.value != null ? row.value : fallback;
}
async function setAppSetting(key, value) {
  await dbRun(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, value, nowISO()]
  );
}

// ---- Document storage (Railway volume mounted at /app/data) ----
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DOCS_DIR = path.join(DATA_DIR, "documents");
if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });
const IMAGES_DIR = path.join(DATA_DIR, "email-images");
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });


// Save an uploaded file (base64 in a JSON body, the way client documents
// arrive) onto the volume and hand back the stored name. Shared so modules
// that need to keep a file do not each invent their own path handling.
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
function saveDocumentFile({ prefix = "doc", filename, contentBase64 }) {
  if (!contentBase64 || !filename) return { ok: false, status: 400, error: "A file is required." };
  let buffer;
  try { buffer = Buffer.from(String(contentBase64), "base64"); }
  catch (e) { return { ok: false, status: 400, error: "Invalid file data." }; }
  if (!buffer.length) return { ok: false, status: 400, error: "That file came through empty. Please try again." };
  if (buffer.length > MAX_UPLOAD_BYTES) return { ok: false, status: 400, error: "File is too large (15MB max)." };
  const safeName = String(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  const storedName = `${prefix}_${crypto.randomBytes(6).toString("hex")}_${safeName}`;
  try { fs.writeFileSync(path.join(DOCS_DIR, storedName), buffer); }
  catch (e) {
    console.error("Could not save document:", e.message);
    return { ok: false, status: 500, error: "Could not save file." };
  }
  return { ok: true, stored_name: storedName, bytes: buffer.length };
}
// ============================== AUTH ==============================
// server/auth.js
// scrypt password hashing + random session tokens (cookie-based).
"use strict";

const SESSION_TTL_HOURS = 12;

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expectedHash));
}

async function createUser({ name, email, password, role, department_id = null }) {
  const { hash, salt } = hashPassword(password);
  const row = await dbGet(
    `INSERT INTO users (name, email, password_hash, password_salt, role, department_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [name, email.toLowerCase(), hash, salt, role, department_id, nowISO()]
  );
  return row.id;
}

async function findUserByEmail(email) {
  return dbGet("SELECT * FROM users WHERE email = ?", [email.toLowerCase()]);
}

async function login(email, password) {
  const user = await findUserByEmail(email);
  if (!user) return null;
  if (!verifyPassword(password, user.password_salt, user.password_hash)) return null;

  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
  await dbRun("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [
    token,
    user.id,
    nowISO(),
    expires,
  ]);
  return { token, user: sanitizeUser(user) };
}

async function logout(token) {
  await dbRun("DELETE FROM sessions WHERE token = ?", [token]);
}

async function getUserFromToken(token) {
  if (!token) return null;
  const session = await dbGet("SELECT * FROM sessions WHERE token = ?", [token]);
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    await dbRun("DELETE FROM sessions WHERE token = ?", [token]);
    return null;
  }
  const user = await dbGet("SELECT * FROM users WHERE id = ?", [session.user_id]);
  return user ? sanitizeUser(user) : null;
}

function sanitizeUser(user) {
  const { password_hash, password_salt, ...safe } = user;
  return safe;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  });
  return out;
}

const auth = { createUser, findUserByEmail, login, logout, getUserFromToken, parseCookies, sanitizeUser };

// ============================== EMAIL ==============================
// server/email.js
// Zero-dependency email sending using the built-in `fetch` (Node 18+) against
// a transactional email HTTP API (Resend by default). No SMTP library needed.
//
// If no provider API key is configured, emails are "simulated": logged to the
// notifications_log table and printed to the console, so the whole app is
// fully demoable with zero external accounts.
"use strict";

const PROVIDER = (process.env.EMAIL_PROVIDER || "none").toLowerCase(); // resend | sendgrid | none
const FROM_EMAIL = process.env.EMAIL_FROM || "no-reply@spectrumsquadlv.com";

// Low-level provider delivery. Returns { delivered, errorMsg } WITHOUT writing
// to notifications_log, so both first-time sends (sendEmail) and manual retries
// of previously-failed emails (resendFailedEmail) share the exact same provider
// logic.
async function deliverEmail({ to, subject, html, attachments }) {
  // attachments: optional array of { filename, content(base64 string), contentType }
  let delivered = "simulated";
  let errorMsg = null;

  try {
    if (PROVIDER === "resend" && process.env.RESEND_API_KEY) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: [to],
          subject,
          html,
          ...(attachments && attachments.length
            ? { attachments: attachments.map((a) => ({ filename: a.filename, content: a.content })) }
            : {}),
        }),
      });
      delivered = res.ok ? "sent" : "failed";
      if (!res.ok) errorMsg = await res.text();
    } else if (PROVIDER === "sendgrid" && process.env.SENDGRID_API_KEY) {
      const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: FROM_EMAIL },
          subject,
          content: [{ type: "text/html", value: html }],
          ...(attachments && attachments.length
            ? {
                attachments: attachments.map((a) => ({
                  content: a.content,
                  filename: a.filename,
                  type: a.contentType || "application/octet-stream",
                  disposition: "attachment",
                })),
              }
            : {}),
        }),
      });
      delivered = res.ok ? "sent" : "failed";
      if (!res.ok) errorMsg = await res.text();
    } else {
      // Demo mode: no provider configured.
      console.log(`\n[EMAIL:SIMULATED] To: ${to}\nSubject: ${subject}\n${stripHtml(html)}\n`);
    }
  } catch (err) {
    delivered = "failed";
    errorMsg = err.message;
  }

  return { delivered, errorMsg };
}

// Wrap any email body in the Spectrum Squad brand shell: logo header + footer.
// The logo is served publicly at /logo.png. A marker comment prevents
// double-wrapping if an already-branded body is passed back in (e.g. resends).
function brandedEmail(innerHtml) {
  if (typeof innerHtml === "string" && innerHtml.includes("data-ss-branded")) return innerHtml;
  const logoUrl = `${APP_BASE_URL}/logo.png`;
  return `<!-- data-ss-branded -->
  <div style="background:#f5f4fb;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 3px 14px rgba(41,34,92,.08);">
      <div style="text-align:center;padding:24px 20px 6px;">
        <img src="${logoUrl}" alt="Spectrum Squad" width="230" style="max-width:230px;height:auto;border:0;" />
      </div>
      <div style="padding:10px 30px 26px;color:#1b2a6b;font-size:15px;line-height:1.6;">${innerHtml}</div>
      <div style="background:#1b2a6b;color:#cfc9ec;text-align:center;padding:16px 20px;font-size:12px;">
        Spectrum Squad &middot; Compassionate ABA Therapy
      </div>
    </div>
  </div>`;
}

async function sendEmail({ to, subject, html, clientId = null, type = "parent_milestone", attachments = null }) {
  const branded = brandedEmail(html);
  const { delivered, errorMsg } = await deliverEmail({ to, subject, html: branded, attachments });

  await dbRun(
    `INSERT INTO notifications_log (client_id, type, recipient, subject, body, sent_at, delivered)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [clientId, type, to, subject, branded, nowISO(), delivered + (errorMsg ? `: ${errorMsg}` : "")]
  );

  return { delivered, errorMsg };
}

// Texting was removed at Quiana's request -- it was never connected to Twilio
// and is no longer wanted. What is deliberately KEPT is the record of it: the
// sms_opt_outs table, the parent_sms_consent / applicant sms_consent columns,
// and every past message in notifications_log (channel='sms'). Consent someone
// gave, and a STOP someone sent, are facts about that person; they are not
// ours to delete because we stopped using the channel. Nothing sends or
// receives a text any more -- these rows are read-only history.

// ---- Benefits & Eligibility Check -----------------------------------------
// When a new patient enrolls, send the billing/verification contact the info
// they need to run an eligibility check: child name, DOB, insurance details,
// and the insurance card itself (attached when a card image is on file). The
// recipient address is owner-configurable in Admin Settings.
// Whether a document is the insurance card.
//
// This used to test the label and filename alone, which is why cards kept
// reading as "not uploaded": a parent photographs their card on a phone and it
// arrives as IMG_4821.jpg or image.jpg. Nothing in that says "insurance", so a
// card that was plainly on file was invisible to the eligibility check.
//
// An explicit marker set at upload time now wins. The keyword test stays as a
// fallback for everything already in the database, and an image sitting on a
// client with no other card is treated as one -- a phone photo is exactly what
// gets uploaded here, and missing a real card costs more than an extra
// attachment on an internal billing email.
function looksLikeInsuranceCard(doc) {
  if (doc.is_insurance_card === true || doc.is_insurance_card === "t") return true;
  const s = `${doc.label || ""} ${doc.filename || ""}`.toLowerCase();
  return /insur|card|member|benefit|policy/.test(s);
}

// Photographed cards, for when nothing is explicitly marked or named.
function looksLikePhotographedCard(doc) {
  return doc.doc_type === "hosted" && /^image\//i.test(String(doc.mime_type || ""));
}

// The cards to attach to an eligibility check: the marked and named ones, or --
// if there are none -- any images on the record, which is what a phone upload
// looks like.
function insuranceCardDocs(docs) {
  const named = (docs || []).filter(looksLikeInsuranceCard);
  if (named.length) return named;
  return (docs || []).filter(looksLikePhotographedCard);
}

async function sendEligibilityCheck(client, actor) {
  // Every outcome below says so in the log. This path used to be silent on both
  // success and refusal, so "did billing ever get it?" could not be answered
  // from the logs at all -- two checks went out in one afternoon without
  // leaving a trace. Client id and the billing recipient only: no patient name,
  // no parent contact details, since these lines are kept for a long time.
  const to = await getAppSetting("eligibility_check_email", "");
  if (!to) {
    console.log(`[eligibility] client=${client.id} not sent: no recipient configured in Admin Settings`);
    return { ok: false, error: "No recipient configured" };
  }

  const docs = await dbAll("SELECT * FROM client_documents WHERE client_id = ?", [client.id]);
  const cardDocs = insuranceCardDocs(docs);
  const attachments = [];
  const linkCards = [];
  for (const d of cardDocs) {
    if (d.doc_type === "hosted" && d.file_path) {
      try {
        const buf = fs.readFileSync(path.join(DOCS_DIR, d.file_path));
        attachments.push({
          filename: d.filename || "insurance-card",
          content: buf.toString("base64"),
          contentType: d.mime_type || "application/octet-stream",
        });
      } catch (e) {
        console.error(`[eligibility] client=${client.id} could not read card file ${d.file_path}: ${e.message}`);
      }
    } else if (d.doc_type === "link" && d.external_url) {
      linkCards.push(d);
    }
  }

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const row = (label, val) => `<tr><td style="padding:6px 12px;color:#555;">${label}</td><td style="padding:6px 12px;font-weight:600;">${esc(val || "—")}</td></tr>`;
  // The card is the point of this email: billing cannot run a benefits check
  // without it, and a request that arrives with nothing attached just becomes
  // a second job for somebody. So this never sends card-less -- not on the
  // automatic trigger, and not from the manual button either. The caller gets
  // a "no_card" answer it can act on instead.
  //
  // Tested on what actually came out the other end rather than on what is on
  // the record: a card row whose file has gone missing from disk fails the
  // read above and leaves attachments empty, and that must block the send too.
  if (!attachments.length && !linkCards.length) {
    console.log(
      `[eligibility] client=${client.id} not sent: no readable insurance card (card rows=${cardDocs.length})`
    );
    return {
      ok: false,
      code: "no_card",
      error: cardDocs.length
        ? "This client's insurance card is on file but could not be read, so the eligibility check was not sent. Re-upload the card and try again."
        : "No insurance card is on file for this client, so the eligibility check was not sent. Use \u201cRequest documents from parent\u201d to ask the family for the front and back of the card.",
      attachments: 0,
    };
  }

  const cardNote = attachments.length
    ? `<p>The insurance card ${attachments.length > 1 ? "images are" : "image is"} attached to this email.</p>`
    : `<p>Insurance card link(s): ${linkCards.map((d) => `<a href="${esc(d.external_url)}">${esc(d.label || d.filename)}</a>`).join(", ")}</p>`;

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#222;">
      <h2 style="color:#1b2a6b;">Benefits &amp; Eligibility Check</h2>
      <p>Please run a benefits &amp; eligibility check for the following new patient:</p>
      <table style="border-collapse:collapse;font-size:14px;">
        ${row("Patient name", client.child_name)}
        ${row("Date of birth", client.dob)}
        ${row("Insurance provider", client.insurance_provider)}
        ${row("Number of insurances", client.num_insurances)}
        ${row("Parent / guardian", client.parent_name)}
        ${row("Parent phone", client.parent_phone)}
        ${row("Parent email", client.parent_email)}
        ${row("Service location", client.service_location)}
      </table>
      ${cardNote}
      <p style="color:#888;font-size:12px;">Sent automatically by the Spectrum Squad CRM.</p>
    </div>`;

  const result = await sendEmail({
    to,
    subject: "Benefits & Eligibility Check",
    html,
    clientId: client.id,
    type: "eligibility_check",
    attachments,
  });
  console.log(
    `[eligibility] client=${client.id} to=${to} attachments=${attachments.length} links=${linkCards.length} ` +
    `result=${result.delivered}${result.errorMsg ? ` error=${result.errorMsg}` : ""}`
  );
  await logFinancialAudit(
    actor || "system",
    "eligibility_check_sent",
    `client=${client.id} to=${to} attachments=${attachments.length} result=${result.delivered}`
  ).catch(() => {});
  return { ok: result.delivered !== "failed", ...result, attachments: attachments.length };
}

// Send the eligibility check only once, and only when the card is actually on
// file.
//
// It used to fire the moment an intake form was submitted, before any card
// could exist, so billing routinely received a request with nothing attached
// and somebody re-sent it by hand later. Now the trigger is the card, not the
// form: whichever happens last -- the intake arriving or the card being
// uploaded -- is what sends it, exactly once.
//
// A client with no card never silently loses the email; it stays pending until
// a card appears, and the manual re-send is still there for the cases where
// billing needs it before then.
async function maybeSendEligibilityCheck(clientId, actor) {
  const client = await dbGet("SELECT * FROM clients WHERE id = ?", [clientId]).catch(() => null);
  if (!client) return { ok: false, skipped: "no such client" };
  if (client.eligibility_check_sent_at) {
    console.log(`[eligibility] client=${clientId} not re-sent: already sent at ${client.eligibility_check_sent_at}`);
    return { ok: true, skipped: "already sent" };
  }

  const docs = await dbAll("SELECT * FROM client_documents WHERE client_id = ?", [clientId]).catch(() => []);
  if (!insuranceCardDocs(docs).length) {
    console.log(`[eligibility] client=${clientId} pending: waiting for an insurance card before sending`);
    return { ok: false, skipped: "no insurance card on file yet" };
  }

  const result = await sendEligibilityCheck(client, actor || "system");
  if (result && result.ok) {
    await dbRun("UPDATE clients SET eligibility_check_sent_at = ? WHERE id = ?", [nowISO(), clientId])
      .catch((e) => console.error("Could not stamp eligibility_check_sent_at:", e.message));
  }
  return result;
}

const MAX_CLIENT_DOC_BYTES = 15 * 1024 * 1024;

// Whether a document is the official diagnosis, so the checklist item stops
// waiting on someone to tick a box the upload already answered. Kept narrow on
// purpose -- "progress report" and "session note" must not read as a diagnosis.
function looksLikeDiagnosis(doc) {
  const s = `${doc.label || ""} ${doc.filename || ""}`.toLowerCase();
  return /diagnos|autism|\basd\b|\bdx\b|psych/.test(s);
}

// ---- One way to put a document on a client's record ----------------------
// Staff uploads from the client card, the admin bulk import, and the parent's
// own upload link all land here, so the three of them cannot drift on the
// things that matter: where the file is written, how big it may be, whether it
// counts as the insurance card or the diagnosis, which checklist boxes that
// ticks, and -- the part that was missing -- kicking the eligibility check now
// that the card it was waiting for has arrived.
//
// Before this, only the bulk-import path fired the eligibility check. A card
// uploaded the normal way, from the client card, never triggered anything,
// which is why staff fell back to pressing "Send Benefits & Eligibility Check"
// by hand and billing kept receiving requests with nothing attached.
async function saveClientDocument(opts) {
  const clientId = Number(opts.client_id);
  const client = await dbGet("SELECT id FROM clients WHERE id = ?", [clientId]);
  if (!client) return { ok: false, status: 404, error: "Client not found." };

  const filename = String(opts.filename || "").trim();
  const label = String(opts.label || filename || "Document").trim();
  const mimeType = opts.mime_type || null;

  let row;
  if (opts.external_url) {
    row = await dbGet(
      `INSERT INTO client_documents (client_id, label, filename, mime_type, file_path, doc_type, external_url, uploaded_at, is_insurance_card)
       VALUES (?, ?, ?, ?, NULL, 'link', ?, ?, ?) RETURNING *`,
      [clientId, label, filename || opts.external_url, mimeType, opts.external_url, nowISO(), opts.is_insurance_card === true]
    );
  } else {
    if (!opts.content_base64 || !filename) {
      return { ok: false, status: 400, error: "A file (or a link) is required." };
    }
    let buffer;
    try {
      buffer = Buffer.from(String(opts.content_base64), "base64");
    } catch (e) {
      return { ok: false, status: 400, error: "Invalid file data." };
    }
    if (!buffer.length) return { ok: false, status: 400, error: "That file came through empty. Please try again." };
    if (buffer.length > MAX_CLIENT_DOC_BYTES) {
      return { ok: false, status: 400, error: "File is too large (15MB max)." };
    }
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storedName = `${clientId}_${crypto.randomBytes(6).toString("hex")}_${safeName}`;
    try {
      fs.writeFileSync(path.join(DOCS_DIR, storedName), buffer);
    } catch (e) {
      console.error("Could not save client document:", e.message);
      return { ok: false, status: 500, error: "Could not save file." };
    }
    row = await dbGet(
      `INSERT INTO client_documents (client_id, label, filename, mime_type, file_path, doc_type, external_url, uploaded_at, is_insurance_card)
       VALUES (?, ?, ?, ?, ?, 'hosted', NULL, ?, ?) RETURNING *`,
      [clientId, label, filename, mimeType || "application/octet-stream", storedName, nowISO(), opts.is_insurance_card === true]
    );
  }

  // Checklist flags the upload has already answered. An explicit flag from the
  // caller wins; otherwise the label/filename is read, which is what the
  // eligibility check has always done.
  const isCard = opts.is_insurance_card === true || looksLikeInsuranceCard(row);
  if (isCard) {
    await dbRun("UPDATE clients SET insurance_card_uploaded = true WHERE id = ?", [clientId])
      .catch((e) => console.error("Could not flag insurance card uploaded:", e.message));
  }
  if (opts.is_diagnosis === true || looksLikeDiagnosis(row)) {
    await dbRun("UPDATE clients SET diagnosis_uploaded = true WHERE id = ?", [clientId])
      .catch((e) => console.error("Could not flag diagnosis uploaded:", e.message));
  }

  // Fired on every upload rather than only on ones we think are a card:
  // maybeSendEligibilityCheck decides for itself whether a card is on file and
  // whether the email has already gone, so it is safe to call and it cannot
  // miss a card that arrived under an unhelpful filename.
  const eligibility = await maybeSendEligibilityCheck(clientId, opts.actor || "system")
    .catch((e) => { console.error("eligibility check failed:", e.message); return null; });

  return {
    ok: true,
    document: {
      id: row.id,
      client_id: clientId,
      filename: row.filename,
      label: row.label,
      doc_type: row.doc_type,
      insurance_card: isCard,
    },
    eligibility,
  };
}

// ---- Failed-email retry ("push" failed emails) --------------------------
// Admins/owners can review emails the provider rejected or errored on and
// re-attempt delivery from Settings -> Failed Emails. A resend re-uses the
// exact subject/body that was originally attempted (merge fields were already
// substituted at first-send time) and updates the SAME notifications_log row
// in place, so a recovered email drops off the failed list instead of leaving
// a duplicate row behind.
async function listFailedEmails() {
  return dbAll(
    `SELECT id, client_id, type, recipient, subject, sent_at, delivered
       FROM notifications_log
      WHERE delivered LIKE 'failed%'
      ORDER BY id DESC`
  );
}

async function resendFailedEmail(id, actor) {
  const row = await dbGet("SELECT * FROM notifications_log WHERE id = ?", [id]);
  if (!row) return { ok: false, error: "Email not found" };
  if (!String(row.delivered || "").startsWith("failed")) {
    return { ok: false, error: "This email is not in a failed state" };
  }

  const { delivered, errorMsg } = await deliverEmail({
    to: row.recipient,
    subject: row.subject,
    html: row.body,
  });

  await dbRun("UPDATE notifications_log SET delivered = ?, sent_at = ? WHERE id = ?", [
    delivered + (errorMsg ? `: ${errorMsg}` : ""),
    nowISO(),
    id,
  ]);

  await logFinancialAudit(
    actor,
    "failed_email_resent",
    `id=${id} to=${row.recipient} result=${delivered}${errorMsg ? " - " + errorMsg : ""}`
  ).catch(() => {});

  return { ok: delivered !== "failed", id, delivered, errorMsg };
}

async function resendAllFailedEmails(actor) {
  const failed = await listFailedEmails();
  let resent = 0;
  let stillFailed = 0;
  for (const row of failed) {
    const result = await resendFailedEmail(row.id, actor);
    if (result.ok) resent++;
    else stillFailed++;
  }
  return { ok: true, attempted: failed.length, resent, stillFailed };
}

// Resend ANY single logged email (not just failed ones) to its original
// recipient, re-using the exact subject/body that was sent. This powers the
// per-message "Resend" button in the Message Outbox, so the owner can push out
// one email again individually instead of re-triggering a whole batch.
async function resendNotificationEmail(id, actor) {
  const row = await dbGet("SELECT * FROM notifications_log WHERE id = ?", [id]);
  if (!row) return { ok: false, error: "Email not found" };
  if (!row.recipient) return { ok: false, error: "This message has no recipient on file" };

  const { delivered, errorMsg } = await deliverEmail({
    to: row.recipient,
    subject: row.subject,
    html: row.body,
  });

  await dbRun("UPDATE notifications_log SET delivered = ?, sent_at = ? WHERE id = ?", [
    delivered + (errorMsg ? `: ${errorMsg}` : ""),
    nowISO(),
    id,
  ]);

  await logFinancialAudit(
    actor,
    "notification_resent",
    `id=${id} to=${row.recipient} result=${delivered}${errorMsg ? " - " + errorMsg : ""}`
  ).catch(() => {});

  return { ok: delivered !== "failed", id, delivered, errorMsg };
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// ============================== EMAIL TEMPLATES ==============================
// server/emailTemplates.js
// Every automated email the CRM sends (parent milestone emails, internal
// staff alerts, and authorization expiration alerts) is stored in the
// email_templates table and editable from Settings -> Email Templates. Each
// template's subject/body may contain {{merge_field}} tokens that get
// substituted with real values at send time -- including links, dates, and
// uploaded photos, all embeddable as plain HTML. Templates are seeded with
// the CRM's original built-in copy on every boot (INSERT ... ON CONFLICT DO
// NOTHING) so nothing breaks before an admin has ever touched this page.
"use strict";

// Highest-privilege roles. Note the seeded owner login (admin@spectrumsquadlv.com)
// is migrated from role "admin" to "owner" on boot (see initSchema), so "owner"
// MUST be included here or the actual owner is locked out of template editing.
const EMAIL_TEMPLATE_EDIT_ROLES = ["owner", "admin", "super_admin"];

function canEditEmailTemplates(user) {
  return !!user && EMAIL_TEMPLATE_EDIT_ROLES.includes(user.role);
}

// ---------- User / team management ----------
// Who can open the Team Members area and add/edit/remove logins.
const USER_ADMIN_ROLES = ["owner", "admin", "super_admin"];
// Only the very top roles may create or promote someone TO owner/super_admin,
// so a regular admin can't silently escalate an account (or themselves).
const PRIVILEGED_ROLE_ASSIGNERS = ["owner", "super_admin"];
const PRIVILEGED_ROLES = ["owner", "super_admin"];

// The full menu of roles an admin can assign, with a plain-language summary of
// what each one can see. Shown as a legend in the Team Members UI.
const ROLE_CATALOG = [
  { key: "owner", label: "Owner", privileged: true, description: "Full access to everything, including financials, offers, and sensitive HR information." },
  { key: "super_admin", label: "Super Admin", privileged: true, description: "Same full access as the Owner — for a trusted second administrator." },
  { key: "admin", label: "Admin", privileged: false, description: "Manage clients, staff, settings, and email templates. Sees authorization data. No financial access." },
  { key: "intake", label: "Intake / Admin", privileged: false, description: "Works the enrollment pipeline: new leads, intake packets, and family communication." },
  { key: "clinical", label: "Clinical (BCBA)", privileged: false, description: "Clinical stage tasks, authorization alerts, and assessment scheduling." },
  { key: "billing", label: "Billing / Insurance", privileged: false, description: "Insurance verification and authorizations. No financial access." },
  { key: "scheduling", label: "Scheduling", privileged: false, description: "Therapy scheduling and first-day coordination." },
  { key: "hr_admin", label: "HR Admin", privileged: false, description: "Full access to the HR & Recruiting area, including sensitive hiring info." },
  { key: "hiring_manager", label: "Hiring Manager", privileged: false, description: "HR & Recruiting: requisitions, candidates, and the hiring pipeline." },
  { key: "interviewer", label: "Interviewer", privileged: false, description: "HR & Recruiting: view assigned candidates and interviews only." },
  { key: "ot_admin", label: "OT Admin", privileged: false, description: "Occupational Therapy: full OT access + OT settings. Shared family demographics only — no ABA clinical, authorization, billing, or financial data." },
  { key: "ot_staff", label: "OT Staff", privileged: false, description: "Occupational Therapy: OT clients, intake, and documents. Shared family demographics only — no ABA clinical, authorization, billing, or financial data." },
];
const VALID_ROLE_KEYS = ROLE_CATALOG.map((r) => r.key);

function canManageUsers(user) {
  return !!user && USER_ADMIN_ROLES.includes(user.role);
}

// Roles allowed to see client (family) records at all. HR-side roles
// (hr_admin, hiring_manager, interviewer) and OT-only roles are deliberately
// excluded -- they have no reason to see a child's PHI. Mirrors
// CLIENT_ACCESS_ROLES in index.html.
const CLIENT_ACCESS_ROLES = [
  "owner", "super_admin", "admin", "intake", "clinical", "billing", "scheduling",
];
function canAccessClients(user) {
  return !!user && CLIENT_ACCESS_ROLES.includes(user.role);
}

// ---- Communication privacy (Phase 4, items 6 / 16 / 17) ----
// Owner, super_admin and admin see all communications org-wide. Everyone else
// is scoped to the clients they are assigned to.
function canSeeAllMessages(user) {
  return !!user && ["owner", "super_admin", "admin"].includes(user.role);
}
// A staffer is "assigned" to a client when their login email matches one of the
// client's assigned-email fields, or their name matches an assigned-name field.
// (Assignments are stored as free-text name/email on the client, not user ids.)
function userAssignedToClient(user, client) {
  if (!user || !client) return false;
  if (canSeeAllMessages(user)) return true;
  const email = (user.email || "").trim().toLowerCase();
  const name = (user.name || "").trim().toLowerCase();
  const emails = [client.assigned_bcba_email, client.assigned_billing_email]
    .map((e) => (e || "").trim().toLowerCase()).filter(Boolean);
  const names = [client.assigned_bcba_name, client.assigned_rbt_name, client.assigned_billing_name, client.assigned_intake_coordinator_name]
    .map((n) => (n || "").trim().toLowerCase()).filter(Boolean);
  return (!!email && emails.includes(email)) || (!!name && names.includes(name));
}
// The set of client ids a scoped (non-admin) user is assigned to. Used to filter
// the Message Outbox at the query layer.
async function assignedClientIds(user) {
  const email = (user.email || "").trim().toLowerCase();
  const name = (user.name || "").trim().toLowerCase();
  const rows = await dbAll(
    `SELECT id FROM clients
       WHERE (? <> '' AND (lower(assigned_bcba_email) = ? OR lower(assigned_billing_email) = ?))
          OR (? <> '' AND (lower(assigned_bcba_name) = ? OR lower(assigned_rbt_name) = ?
                           OR lower(assigned_billing_name) = ? OR lower(assigned_intake_coordinator_name) = ?))`,
    [email, email, email, name, name, name, name, name]
  );
  return rows.map((r) => r.id);
}

// Metadata shown in the admin UI: human-readable label/category/description,
// plus the exact list of merge fields available for that template so the
// editor can offer an "insert field" picker instead of making the admin guess.
const EMAIL_TEMPLATE_DEFS = [
  {
    key: "milestone_new_submission",
    label: "New Submission Received",
    category: "Parent Milestone Emails",
    description: "Sent to the parent as soon as their enrollment form is received.",
    fields: ["parent_name", "child_name", "today"],
  },
  {
    key: "milestone_intake_packet",
    label: "Intake Packet Sent",
    category: "Parent Milestone Emails",
    description: "Sent to the parent when the intake packet goes out.",
    fields: ["parent_name", "child_name", "today"],
  },
  {
    key: "milestone_authorization",
    label: "Authorization Requested",
    category: "Parent Milestone Emails",
    description: "Sent to the parent when the authorization request is submitted to insurance.",
    fields: ["parent_name", "child_name", "today"],
  },
  {
    key: "milestone_treatment_plan_submitted",
    label: "Treatment Plan Submitted for Authorization",
    category: "Parent Milestone Emails",
    description: "Sent to the parent the moment the 'Submit Authorization Request' task is marked done. Tells them the plan is with their insurance and that the clinical director will be in touch. Does NOT promise a start date — nothing is approved yet.",
    fields: ["parent_name", "child_name", "today", "treatment_plan_submitted_date", "insurance_payer"],
  },
  {
    key: "milestone_authorization_approved",
    label: "Authorization Approved — Let's Schedule",
    category: "Parent Milestone Emails",
    description: "Sent to the parent when the Authorization Status is set to 'Approved'. This is the email that asks them to schedule the first day of ABA.",
    fields: ["parent_name", "child_name", "today", "treatment_plan_submitted_date", "authorization_approved_date", "insurance_payer", "assigned_bcba_name"],
  },
  {
    key: "milestone_first_day_scheduled",
    label: "Ready to Schedule First Day (retired)",
    category: "Parent Milestone Emails",
    description: "No longer sent automatically. This used to fire when the authorization request was SUBMITTED, which told parents the authorization was already in. It has been replaced by 'Treatment Plan Submitted for Authorization' (on submit) and 'Authorization Approved' (on approval). Kept so past sends still render.",
    fields: ["parent_name", "child_name", "today"],
  },
  {
    key: "milestone_active",
    label: "Welcome / Active Therapy",
    category: "Parent Milestone Emails",
    description: "Sent to the parent when their child officially starts ABA therapy.",
    fields: ["parent_name", "child_name", "today"],
  },
  {
    key: "department_alert",
    label: "Staff Department Alert",
    category: "Internal Staff Alerts",
    description: "Sent to a department's notify email whenever a client enters a stage that needs their action.",
    fields: ["dept_name", "child_name", "parent_name", "stage_label", "task_label", "due_date"],
  },
  {
    key: "overdue_alert",
    label: "Overdue Task Alert",
    category: "Internal Staff Alerts",
    description: "Sent to a department when one of their tasks passes its due date.",
    fields: ["task_label", "child_name", "parent_name", "due_date"],
  },
  {
    key: "auth_alert",
    label: "Authorization Expiration Alert",
    category: "Authorization Alerts",
    description: "Sent to the assigned BCBA, billing contact, and admin as an authorization approaches or passes its expiration date.",
    fields: [
      "initials", "milestone_label", "insurance_payer", "auth_expiration_date",
      "days_remaining", "assigned_bcba_name", "authorization_status", "client_link",
    ],
  },
  {
    key: "enrollment_packet_reminder",
    label: "Enrollment Packet Reminder",
    category: "Parent Milestone Emails",
    description: "Sent daily to the parent while the New Patient Enrollment Packet is still unsigned.",
    fields: ["parent_name", "child_name"],
  },
  // The Clinical Screener emails. These were built as hardcoded strings inside
  // screener.js, so they never appeared in this editor and the wording could
  // not be changed without a deploy. Registered here so they are edited like
  // every other parent email; screener.js renders from these rows.
  {
    key: "screener_invite",
    label: "Clinical Screener — Invitation",
    category: "Clinical Screener Emails",
    description: "Sent to the parent when the clinical screener goes out — automatically once the enrollment packet is signed, or by hand from the Send Screener button on the client card. Must contain {{screener_link}}: it is the parent's private link to the screener, and the CRM will append it if you remove it.",
    fields: ["parent_name", "child_name", "screener_link"],
  },
  {
    key: "screener_reminder",
    label: "Clinical Screener — Reminder",
    category: "Clinical Screener Emails",
    description: "Sent to the parent once a day while the clinical screener is still outstanding, and used for a deliberate resend. Must contain {{screener_link}}.",
    fields: ["parent_name", "child_name", "screener_link"],
  },
  {
    key: "assessment_reminder",
    label: "Assessment Scheduling Reminder",
    category: "Parent Milestone Emails",
    description: "Sent to the parent when their child has reached the assessment stage but no in-clinic/in-home assessment date is on file yet.",
    fields: ["parent_name", "child_name", "today"],
  },
  {
    key: "client_waitlist",
    label: "Placed on Waitlist",
    category: "Waitlist Emails",
    description: "Sent to the parent when their child is placed on the waitlist.",
    fields: ["parent_name", "child_name", "today", "waitlist_reason"],
  },
  {
    key: "client_waitlist_opening",
    label: "Removed from Waitlist / Spot Available",
    category: "Waitlist Emails",
    description: "Sent to the parent when their child comes off the waitlist and enrollment can continue.",
    fields: ["parent_name", "child_name", "today"],
  },
  // ---- HR / Onboarding emails (staff), used by the Offer-Accepted bundle + milestones ----
  { key: "hr_welcome_docs_bcba", label: "New Hire — Welcome + Required Documents (BCBA)", category: "HR / Onboarding Emails",
    description: "Sent to a BCBA the moment their offer is accepted, alongside the SignNow packet. Carries the 72-hour document deadline.",
    fields: ["first_name", "credentialing_form_link", "upload_portal_link"] },
  { key: "hr_welcome_docs_rbt", label: "New Hire — Welcome + Required Documents (RBT)", category: "HR / Onboarding Emails",
    description: "Sent to an RBT the moment their offer is accepted. Points them at HomeBase for the background check and payroll.",
    fields: ["first_name", "credentialing_form_link", "upload_portal_link"] },
  { key: "hr_welcome_docs_cota", label: "New Hire — Welcome + Required Documents (COTA)", category: "HR / Onboarding Emails",
    description: "Sent to a COTA the moment their offer is accepted. Carries the 72-hour document deadline and OT credentialing link.",
    fields: ["first_name", "credentialing_form_link", "upload_portal_link"] },
  { key: "hr_first_day", label: "New Hire — Your First Day", category: "HR / Onboarding Emails",
    description: "Sent ahead of their first day, once a start date has been entered. The dress code and shirt count only appear if they are set.",
    fields: ["first_name", "first_day_date", "dress_code", "shirt_count", "supervisor_name", "scheduling_lead_name"] },
  { key: "hr_docs_complete_internal", label: "New Hire — All Documents Received (internal)", category: "HR / Onboarding Emails",
    description: "Sent to the owner and Clinical Director when a new hire finishes uploading everything.",
    fields: ["employee_name", "role_title", "documents_list", "employee_link"] },
  { key: "hr_welcome_dojo", label: "New Hire — Class Dojo Welcome", category: "HR / Onboarding Emails",
    description: "Sent to a new hire when their offer is accepted (Class Dojo invite).",
    fields: ["first_name", "hire_date", "class_dojo_link"] },
  { key: "hr_rethink_creds", label: "New Hire — Rethink Credentials", category: "HR / Onboarding Emails",
    description: "Sent to a new hire with their Rethink username (password goes by a separate channel).",
    fields: ["first_name", "rethink_username"] },
  { key: "hr_scheduling_request", label: "New Hire — Scheduling / Availability", category: "HR / Onboarding Emails",
    description: "Sent to a new hire asking them to complete their availability form.",
    fields: ["first_name", "scheduling_form_link"] },
  { key: "hr_milestone_30", label: "Staff Milestone — 30 Days", category: "HR / Onboarding Emails",
    description: "Auto-sent 30 days after a staff member's hire date.", fields: ["first_name"] },
  { key: "hr_milestone_60", label: "Staff Milestone — 60 Days", category: "HR / Onboarding Emails",
    description: "Auto-sent 60 days after a staff member's hire date.", fields: ["first_name"] },
  { key: "hr_milestone_90", label: "Staff Milestone — 90 Days", category: "HR / Onboarding Emails",
    description: "Auto-sent 90 days after a staff member's hire date.", fields: ["first_name"] },
  { key: "post_assessment_next_steps", label: "Post-Assessment / Next Steps (Parent)", category: "Parent Milestone Emails",
    description: "Sent to the family after they complete their in-clinic assessment. Congratulates them, thanks them for coming in, and sets clear, realistic expectations for the next steps in intake. Sent manually from the client profile, with a preview first.",
    fields: ["parent_name", "child_name", "today", "assigned_bcba_name"] },
  { key: "lead_checkin_7", label: "Relationship Check-in — 1 Week", category: "Lead / Contract Emails",
    description: "A friendly 1-week relationship check-in you can send to a contracted organization's contact from the Lead profile (preview first). The 7/30/60/90 automation creates a follow-up task reminding the assigned team member to reach out; this is the email they can send.",
    fields: ["org_name", "contact_name", "assigned_to", "weekly_hours"] },
  { key: "lead_checkin_30", label: "Relationship Check-in — 30 Days", category: "Lead / Contract Emails",
    description: "A warm 30-day relationship check-in you can send to a contracted organization's contact from the Lead profile (preview first). The 30/60/90 automation creates a follow-up task reminding the assigned team member to reach out; this is the email they can send.",
    fields: ["org_name", "contact_name", "assigned_to", "weekly_hours"] },
  { key: "lead_checkin_60", label: "Relationship Check-in — 60 Days", category: "Lead / Contract Emails",
    description: "A 60-day relationship check-in for a contracted organization's contact, sent from the Lead profile.",
    fields: ["org_name", "contact_name", "assigned_to", "weekly_hours"] },
  { key: "lead_checkin_90", label: "Relationship Check-in — 90 Days", category: "Lead / Contract Emails",
    description: "A 90-day relationship check-in for a contracted organization's contact, sent from the Lead profile.",
    fields: ["org_name", "contact_name", "assigned_to", "weekly_hours"] },
];

// The CRM's original built-in copy -- used both as the seed data and as a
// last-resort fallback if a template row is somehow missing.
const EMAIL_TEMPLATE_DEFAULTS = {
  lead_checkin_7: {
    subject: "Checking in after your first week — {{org_name}}",
    body: "<p>Hi {{contact_name}},</p><p>It's been about a week since we started working together and I wanted to check in personally. How are the first few days going on your end? If anything came up or you have questions as {{org_name}} gets settled in, I'm just an email away.</p><p>Warmly,<br/>{{assigned_to}} · Spectrum Squad</p>",
  },
  lead_checkin_30: {
    subject: "Checking in on our first month together — {{org_name}}",
    body: "<p>Hi {{contact_name}},</p><p>We're about a month into working together and I wanted to check in personally. How are things going from your side? Is the current level of support meeting {{org_name}}'s needs, and is there anything we could be doing better?</p><p>Warmly,<br/>{{assigned_to}} · Spectrum Squad</p>",
  },
  lead_checkin_60: {
    subject: "Two months in — how are we doing, {{contact_name}}?",
    body: "<p>Hi {{contact_name}},</p><p>As we pass the two-month mark, I'd love your honest read on how the partnership is working. Are there upcoming needs, staffing changes, or additional services we should be planning for together?</p><p>Warmly,<br/>{{assigned_to}} · Spectrum Squad</p>",
  },
  lead_checkin_90: {
    subject: "Our first quarter together — a quick check-in",
    body: "<p>Hi {{contact_name}},</p><p>We've reached our first quarter with {{org_name}} and I'd love to hear how you feel it's going. This is a great moment to talk through satisfaction, any changes on the horizon, and whether it makes sense to revisit the scope of our work together.</p><p>Warmly,<br/>{{assigned_to}} · Spectrum Squad</p>",
  },
  post_assessment_next_steps: {
    subject: "Thank you for completing {{child_name}}'s assessment — here's what happens next",
    body:
      "<p>Hi {{parent_name}},</p>" +
      "<p>Congratulations on completing {{child_name}}'s in-clinic assessment — and thank you so much for coming in! It was a genuine pleasure to spend that time with your family.</p>" +
      "<p><strong>Here's what happens next:</strong></p>" +
      "<ul>" +
      "<li>Our clinical team is now reviewing everything from the assessment and building {{child_name}}'s individualized treatment plan.</li>" +
      "<li>Once the plan is ready, we submit it to your insurance for authorization. Insurance review usually takes a couple of weeks.</li>" +
      "<li>As soon as the authorization comes back approved, we'll reach out to schedule {{child_name}}'s very first day of ABA therapy.</li>" +
      "</ul>" +
      "<p>You don't need to do anything right now — we'll keep you updated at every step. If a question comes up in the meantime, just reply to this email and our team will be glad to help.</p>" +
      "<p>Warmly,<br/>The Spectrum Squad Team</p>",
  },
  milestone_new_submission: {
    subject: "We received your enrollment form — Spectrum Squad",
    body: "<p>Hi {{parent_name}},</p><p>Thanks for submitting your enrollment form for {{child_name}}. Our intake team will reach out within 24-48 hours.</p>",
  },
  milestone_intake_packet: {
    subject: "Your intake packet is on its way — Spectrum Squad",
    body: "<p>Hi {{parent_name}},</p><p>We're sending over {{child_name}}'s intake packet. Please complete and return it so we can keep things moving.</p>",
  },
  milestone_authorization: {
    subject: "We're requesting your authorization for services — Spectrum Squad",
    body: "<p>Hi {{parent_name}},</p><p>We're now submitting the authorization request for {{child_name}}'s ABA services to your insurance.</p>",
  },
  milestone_treatment_plan_submitted: {
    subject: "{{child_name}}'s treatment plan has been submitted — Spectrum Squad",
    body:
      "<p>Hi {{parent_name}},</p>" +
      "<p>Good news — we submitted {{child_name}}'s treatment plan for authorization on <strong>{{treatment_plan_submitted_date}}</strong>. It's now with {{insurance_payer}} for review.</p>" +
      "<p>Our clinical director will be contacting you to talk through the plan and to get {{child_name}}'s first day of ABA scheduled as soon as the authorization comes back approved.</p>" +
      "<p>Insurance review usually takes a couple of weeks. You don't need to do anything right now — we'll reach out to you.</p>" +
      "<p>Warmly,<br>The Spectrum Squad Team</p>",
  },
  milestone_authorization_approved: {
    subject: "{{child_name}} is approved — let's pick a first day! — Spectrum Squad",
    body:
      "<p>Hi {{parent_name}},</p>" +
      "<p>{{child_name}}'s authorization has been <strong>approved</strong>. We can officially get started.</p>" +
      "<p>Our clinical director will be reaching out to schedule {{child_name}}'s first day of ABA therapy and to go over what to expect. If you already have days or times that work best for your family, just reply to this email and we'll build around them.</p>" +
      "<p>We're so glad to have you with us.</p>" +
      "<p>Warmly,<br>The Spectrum Squad Team</p>",
  },
  milestone_first_day_scheduled: {
    subject: "Let's get a first day scheduled! — Spectrum Squad",
    body: "<p>Hi {{parent_name}},</p><p>{{child_name}}'s authorization is in and we're ready to schedule a first day of ABA therapy. Our scheduling team will be in touch shortly.</p>",
  },
  milestone_active: {
    subject: "Welcome to Spectrum Squad, {{child_name}}!",
    body: "<p>Hi {{parent_name}},</p><p>We're so excited — {{child_name}} is officially starting ABA therapy with us! Your care team will follow up with weekly schedule details.</p>",
  },
  department_alert: {
    subject: "[{{dept_name}}] Action needed: {{child_name}} — {{task_label}}",
    body: "<p><strong>{{child_name}}</strong> (parent: {{parent_name}}) has entered stage <strong>{{stage_label}}</strong> and needs: <strong>{{task_label}}</strong>.</p><p>Due by: {{due_date}}</p>",
  },
  overdue_alert: {
    subject: "⚠ OVERDUE: {{task_label}} — {{child_name}}",
    body: "<p><strong>{{task_label}}</strong> for <strong>{{child_name}}</strong> (parent: {{parent_name}}) was due {{due_date}} and has not been completed.</p>",
  },
  auth_alert: {
    subject: "Authorization {{milestone_label}} — {{initials}}",
    body: `<p>An ABA authorization needs attention.</p>
    <ul>
      <li><strong>Client:</strong> {{initials}}</li>
      <li><strong>Insurance Payer:</strong> {{insurance_payer}}</li>
      <li><strong>Authorization Expiration Date:</strong> {{auth_expiration_date}}</li>
      <li><strong>Days Remaining:</strong> {{days_remaining}}</li>
      <li><strong>Assigned BCBA:</strong> {{assigned_bcba_name}}</li>
      <li><strong>Authorization Status:</strong> {{authorization_status}}</li>
    </ul>
    <p><a href="{{client_link}}">View client authorization record</a></p>
    <p>Please begin or complete the renewal process if this hasn't been started already.</p>`,
  },
  enrollment_packet_reminder: {
    subject: "Action needed: complete {{child_name}}'s enrollment packet — Spectrum Squad",
    body: `<p>Hi {{parent_name}},</p>
    <p>We're still waiting on <strong>{{child_name}}'s</strong> New Patient Enrollment Packet. Completing this is an important next step -- we're not able to continue moving {{child_name}} forward toward services without it.</p>
    <p>Please check your email for the signing link from SignNow (sender: qblake@spectrumsquadlv.com), or reach out to us if you're having trouble finding it or completing it.</p>
    <p>Thank you,<br/>Spectrum Squad</p>`,
  },
  assessment_reminder: {
    subject: "Let's schedule {{child_name}}'s assessment — Spectrum Squad",
    body: `<p>Hi {{parent_name}},</p>
    <p>We're ready for the next step in {{child_name}}'s care: an in-clinic or in-home assessment. This is where our team observes {{child_name}} so we can build a treatment plan that's just right for them.</p>
    <p>We don't have an assessment date scheduled yet. Please reach out so we can find a time that works for your family — the sooner we complete this, the sooner {{child_name}} can begin services.</p>
    <p>Thank you,<br/>The Spectrum Squad Team</p>`,
  },
  client_waitlist: {
    subject: "An update on {{child_name}}'s enrollment — Spectrum Squad",
    body: `<p>Hi {{parent_name}},</p>
    <p>Thank you for your patience as we work to find the right fit for <strong>{{child_name}}</strong>. At this time we've placed {{child_name}} on our <strong>waitlist</strong> for ABA services.</p>
    <p>Being on the waitlist means we have {{child_name}}'s information on file and will reach out just as soon as a spot opens up that matches your family's needs. You don't need to do anything right now — we'll contact you with next steps.</p>
    <p>If anything changes with your availability or contact information, please let us know so we can keep {{child_name}}'s file up to date.</p>
    <p>Warmly,<br/>The Spectrum Squad Team</p>`,
  },
  client_waitlist_opening: {
    subject: "Good news — a spot has opened for {{child_name}}! — Spectrum Squad",
    body: `<p>Hi {{parent_name}},</p>
    <p>We're excited to share that a spot has opened up and <strong>{{child_name}}</strong> has come off our waitlist! We're ready to continue moving forward with enrollment.</p>
    <p>Our team will be in touch shortly with the next steps. If you have any questions in the meantime, just reply to this email.</p>
    <p>Warmly,<br/>The Spectrum Squad Team</p>`,
  },
  hr_welcome_docs_bcba: {
    subject: "Welcome to Spectrum Squad, {{first_name}}!",
    body: `<p>Hi {{first_name}},</p>
    <p>Welcome to the Spectrum Squad family! We are so excited to have you join us as our newest BCBA. Your energy and dedication are exactly what we look for in our team, and we can't wait for you to start making an impact with our kiddos.</p>
    <p>As we get everything set up for your onboarding, please send the following documents at your earliest convenience so we can complete your HR file. These documents are required within 72 hours otherwise we will unfortunately have to rescind our offer. If you need time to get a certain document please let me know and we can work around that:</p>
    <p><strong>Required Documents:</strong></p>
    <ul>
      <li>Copy of your BCBA certificate and Nevada State LBA Licensure</li>
      <li>Copy of your driver's license or state ID</li>
      <li>Copy of your Social Security card/Passport</li>
      <li>Proof of CPR/First Aid certification</li>
      <li>Please complete this link, it is for our credentialing company (please let me know once it is completed as well)<br/><a href="{{credentialing_form_link}}">{{credentialing_form_link}}</a></li>
    </ul>
    <p>You can upload everything in one place here: <a href="{{upload_portal_link}}">{{upload_portal_link}}</a></p>
    <p>Please also be on the lookout for a document from Sign Now, it is your new hire packet.</p>`,
  },
  hr_welcome_docs_rbt: {
    subject: "Welcome to Spectrum Squad, {{first_name}}!",
    body: `<p>Hi {{first_name}},</p>
    <p>Welcome to the Spectrum Squad family! We are so excited to have you join us as our newest Registered Behavior Technician. Your energy and dedication are exactly what we look for in our team, and we can't wait for you to start making an impact with our kiddos.</p>
    <p>As we get everything set up for your onboarding, please send the following documents at your earliest convenience so we can complete your HR file. These documents are required within 72 hours otherwise we will unfortunately have to rescind our offer. If you need time to get a certain document please let me know and we can work around that:</p>
    <p><strong>Required Documents:</strong></p>
    <ul>
      <li>Copy of your RBT certificate and Nevada State RBT Licensure</li>
      <li>Copy of your driver's license or state ID</li>
      <li>Copy of your Social Security card</li>
      <li>Proof of CPR/First Aid certification</li>
      <li>Updated copy of your resume showing Spectrum Squad as a present employer</li>
      <li>Please also complete the link below &mdash; PLEASE LET ME KNOW ONCE YOU HAVE COMPLETED IT<br/><a href="{{credentialing_form_link}}">{{credentialing_form_link}}</a></li>
    </ul>
    <p>You can upload everything in one place here: <a href="{{upload_portal_link}}">{{upload_portal_link}}</a></p>
    <p>Please also be on the lookout for a document from Sign Now, it is your new hire packet.</p>
    <p>Please also be on the lookout for an email from HomeBase our Payroll processor for your background check and to enroll in Payroll!</p>`,
  },
  hr_welcome_docs_cota: {
    subject: "Welcome to Spectrum Squad, {{first_name}}!",
    body: `<p>Hi {{first_name}},</p>
    <p>Welcome to the Spectrum Squad family! We are so excited to have you join us as our newest Certified Occupational Therapy Assistant. Your energy and dedication are exactly what we look for in our team, and we can't wait for you to start making an impact with our kiddos.</p>
    <p>As we get everything set up for your onboarding, please send the following documents at your earliest convenience so we can complete your HR file. These documents are required within 72 hours otherwise we will unfortunately have to rescind our offer. If you need time to get a certain document please let me know and we can work around that:</p>
    <p><strong>Required Documents:</strong></p>
    <ul>
      <li>Copy of your NBCOT certification</li>
      <li>Copy of your Nevada Occupational Therapy Assistant (OTA) license</li>
      <li>Proof of CPR/BLS certification</li>
      <li>Updated copy of your resume</li>
      <li>Copy of your government-issued ID</li>
      <li>Please also complete the link below for our credentialing company &mdash; PLEASE LET ME KNOW ONCE YOU HAVE COMPLETED IT<br/><a href="{{credentialing_form_link}}">{{credentialing_form_link}}</a></li>
    </ul>
    <p>You can upload everything in one place here: <a href="{{upload_portal_link}}">{{upload_portal_link}}</a></p>
    <p>Please also be on the lookout for a document from Sign Now, it is your new hire packet.</p>
    <p>Please also be on the lookout for an email from HomeBase our Payroll processor for your background check and to enroll in Payroll!</p>`,
  },
  hr_first_day: {
    subject: "Welcome to your first day at Spectrum Squad, {{first_name}}!",
    body: `<p>Hi {{first_name}},</p>
    <p>We're so excited to officially welcome you to Spectrum Squad! Your first day{{first_day_date}} is designed to help you get comfortable with the team, understand how we operate, and make sure you leave feeling prepared and supported.</p>
    <p>During your first day, we'll walk you through the clinic, introduce you to the team, review important expectations, and make sure you have everything you need to get started.</p>
    <p><strong>What to Expect</strong><br/>
    You'll start with a welcome and team introduction, followed by a tour of the clinic and a review of important spaces, safety procedures, staff expectations, communication systems, and daily routines.<br/>
    We'll also review your role, schedule, chain of communication, who to go to when you need support, and how Spectrum Squad works together as a team.</p>
    {{dress_code}}
    <p><strong>Your Spectrum Squad Gear &amp; Equipment</strong><br/>
    RBTs will receive their Spectrum Squad shirts{{shirt_count}} during onboarding.<br/>
    Employees who require access will also be issued their company keys.<br/>
    You will also be issued a Spectrum Squad company iPad for work-related use, including accessing approved systems, schedules, clinical documentation, communication, and other job-related responsibilities.<br/>
    We'll review expectations for the care, security, and appropriate use of all company-issued equipment.</p>
    <p><strong>Technology Setup</strong><br/>
    We'll help you get logged into the systems you need for your position, which may include:</p>
    <ul>
      <li>Spectrum Squad CRM</li>
      <li>Scheduling system</li>
      <li>Clinical documentation/session notes</li>
      <li>Company email and communication platforms</li>
      <li>Rethink or other clinical systems applicable to your role</li>
    </ul>
    <p>We'll make sure you know where to find your schedule, client information, important forms, policies, and resources.</p>
    <p><strong>Clinical &amp; Role-Specific Training</strong><br/>
    For RBTs, your first day may also include reviewing session expectations, documentation procedures, data collection, client transitions, pairing expectations, and how to request support from your BCBA or RBT(1).<br/>
    Depending on your role and schedule, you may shadow another team member before independently working with clients.</p>
    <p><strong>Before You Leave</strong><br/>
    Before the end of your first day, we want to make sure you can answer:<br/>
    Where do I find my schedule?<br/>
    Who is my direct supervisor?{{supervisor_name}}<br/>
    Who is my RBT(1)/scheduling lead?{{scheduling_lead_name}}<br/>
    How do I complete a session note?<br/>
    How do I ask for help?<br/>
    What do I do if I am going to be late or absent?<br/>
    Where do I find Spectrum Squad policies and resources?</p>
    <p>Most importantly, we want you to leave your first day knowing that you're part of a team and that you do not have to figure everything out alone.</p>
    <p>Welcome to the Squad &mdash; we're happy you're here!</p>`,
  },
  hr_docs_complete_internal: {
    subject: "{{employee_name}} has sent in all their onboarding documents",
    body: `<p><strong>{{employee_name}}</strong>{{role_title}} has finished uploading their onboarding documents.</p>
    {{documents_list}}
    <p><strong>Next steps:</strong></p>
    <ul>
      <li>Submit the background check request</li>
      <li>Add them to HomeBase</li>
      <li>Enter their first day of work so their welcome email can go out</li>
    </ul>
    <p><a href="{{employee_link}}">Open their staff record</a></p>`,
  },
  hr_welcome_dojo: {
    subject: "Welcome to the team, {{first_name}}!",
    body: `<p>Hi {{first_name}},</p>
    <p>We're so glad to have you! Your first step is joining our <strong>Class Dojo</strong>, where our team communicates day to day: <a href="{{class_dojo_link}}">{{class_dojo_link}}</a></p>
    <p>Your start date is <strong>{{hire_date}}</strong>. Reach out any time with questions.</p>
    <p>Warmly,<br/>The Spectrum Squad Team</p>`,
  },
  // Deliberately the same words screener.js has been sending, so registering
  // these changes nothing about what families receive until somebody edits
  // them. The button markup is part of the body so it stays editable too.
  screener_invite: {
    subject: "One more step for {{child_name}} 🌈 — Spectrum Squad",
    body:
      "<p>Hi {{parent_name}},</p>" +
      "<p>Thank you for completing {{child_name}}'s enrollment packet! 🎉</p>" +
      "<p>The last step to get started is a short clinical screener so our clinical team can build the perfect care plan. It's quick (about 10 minutes), phone-friendly, and there are no wrong answers.</p>" +
      '<p style="text-align:center;margin:26px 0;"><a href="{{screener_link}}" style="background:#e0a430;color:#3a2c05;text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:12px;display:inline-block;">Start the Screener →</a></p>' +
      '<p style="font-size:12px;color:#7a7796;">Or paste this link into your browser:<br/>{{screener_link}}</p>',
  },
  screener_reminder: {
    subject: "Reminder: {{child_name}}'s clinical screener — Spectrum Squad",
    body:
      "<p>Hi {{parent_name}},</p>" +
      "<p>Just a gentle reminder — we're still waiting on {{child_name}}'s clinical screener. It takes about 10 minutes and works great on your phone. Whenever you have a moment! 💜</p>" +
      '<p style="text-align:center;margin:26px 0;"><a href="{{screener_link}}" style="background:#e0a430;color:#3a2c05;text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:12px;display:inline-block;">Start the Screener →</a></p>' +
      '<p style="font-size:12px;color:#7a7796;">Or paste this link into your browser:<br/>{{screener_link}}</p>',
  },
  hr_rethink_creds: {
    subject: "Your Rethink login",
    body: `<p>Hi {{first_name}},</p>
    <p>Your Rethink account is ready.</p>
    <p><strong>Username:</strong> {{rethink_username}}</p>
    <p>Your temporary password will be sent to you separately. You'll be prompted to change it at first login.</p>
    <p>The Spectrum Squad Team</p>`,
  },
  hr_scheduling_request: {
    subject: "Your availability — quick form",
    body: `<p>Hi {{first_name}},</p>
    <p>Before your start date, please fill out your availability and any scheduling needs (transportation, in-clinic vs in-home, etc.): <a href="{{scheduling_form_link}}">{{scheduling_form_link}}</a></p>
    <p>Thank you,<br/>The Spectrum Squad Team</p>`,
  },
  hr_milestone_30: {
    subject: "30 days in — congratulations, {{first_name}}!",
    body: `<p>Hi {{first_name}},</p>
    <p>You've hit your first month with us. Thank you for the work you're putting in with our clients. If anything would make your job easier, tell us.</p>
    <p>The Spectrum Squad Team</p>`,
  },
  hr_milestone_60: {
    subject: "60 days with the team!",
    body: `<p>Hi {{first_name}},</p>
    <p>Two months in and you're part of the fabric here. Congratulations, {{first_name}}.</p>
    <p>The Spectrum Squad Team</p>`,
  },
  hr_milestone_90: {
    subject: "90 days — a real milestone",
    body: `<p>Hi {{first_name}},</p>
    <p>Congratulations on 90 days, {{first_name}}. That's a significant mark, and we're grateful you're here.</p>
    <p>The Spectrum Squad Team</p>`,
  },
};

async function seedEmailTemplates() {
  for (const def of EMAIL_TEMPLATE_DEFS) {
    const defaults = EMAIL_TEMPLATE_DEFAULTS[def.key];
    if (!defaults) { console.error("No default body for email template:", def.key); continue; }
    await dbRun(
      `INSERT INTO email_templates (template_key, label, category, subject_template, body_template, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, 'system', ?)
       ON CONFLICT (template_key) DO UPDATE SET label = EXCLUDED.label, category = EXCLUDED.category`,
      [def.key, def.label, def.category, defaults.subject, defaults.body, nowISO()]
    );
  }
  await refreshSystemTemplates();
}

// The insert above does nothing when a template already exists, which is right
// for anything a human has edited and wrong for a template whose default was
// later corrected. This brings forward only the copies still marked as
// system-owned; the moment someone saves an edit, updated_by stops being
// 'system' and the CRM never touches their wording again.
const TEMPLATES_TO_KEEP_CURRENT = ["hr_welcome_docs_bcba", "hr_welcome_docs_rbt", "hr_welcome_docs_cota", "hr_first_day", "hr_docs_complete_internal"];

async function refreshSystemTemplates() {
  for (const key of TEMPLATES_TO_KEEP_CURRENT) {
    const defaults = EMAIL_TEMPLATE_DEFAULTS[key];
    if (!defaults) continue;
    const row = await dbGet("SELECT body_template, updated_by FROM email_templates WHERE template_key = ?", [key]);
    if (!row || row.updated_by !== "system") continue;
    if (row.body_template === defaults.body) continue;
    await dbRun(
      "UPDATE email_templates SET subject_template = ?, body_template = ?, updated_at = ? WHERE template_key = ? AND updated_by = 'system'",
      [defaults.subject, defaults.body, nowISO(), key]
    );
    console.log("Email template refreshed from its default (never edited by hand):", key);
  }
}

// {{field_name}} -> value substitution. Unknown/blank fields render as "".
function renderMergeFields(str, fields) {
  return String(str || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, key) => {
    const v = fields ? fields[key] : undefined;
    return v === undefined || v === null ? "" : String(v);
  });
}

async function getEmailTemplate(key) {
  const row = await dbGet("SELECT * FROM email_templates WHERE template_key = ?", [key]);
  if (row) return row;
  // Defensive fallback in case a row is somehow missing (shouldn't happen --
  // seedEmailTemplates runs on every boot).
  const def = EMAIL_TEMPLATE_DEFS.find((d) => d.key === key);
  const defaults = EMAIL_TEMPLATE_DEFAULTS[key];
  if (!def || !defaults) return null;
  return {
    template_key: key,
    label: def.label,
    category: def.category,
    subject_template: defaults.subject,
    body_template: defaults.body,
  };
}

async function listEmailTemplates() {
  const rows = await dbAll("SELECT * FROM email_templates ORDER BY category, label");
  return rows.map((row) => {
    const def = EMAIL_TEMPLATE_DEFS.find((d) => d.key === row.template_key) || {};
    return { ...row, description: def.description || null, fields: def.fields || [] };
  });
}

async function saveEmailTemplate(key, { subject_template, body_template }, actor) {
  const def = EMAIL_TEMPLATE_DEFS.find((d) => d.key === key);
  if (!def) return { ok: false, error: "Unknown template key" };
  await dbRun(
    `UPDATE email_templates SET subject_template = ?, body_template = ?, updated_by = ?, updated_at = ? WHERE template_key = ?`,
    [subject_template, body_template, actor, nowISO(), key]
  );
  return { ok: true };
}

// Sample merge-field values for the live preview / send-test features, so an
// admin can see (and receive) a realistic-looking email before it ever goes
// out to a real family or staff member.
function sampleFieldsFor() {
  return {
    parent_name: "Jane Doe",
    child_name: "Alex Doe",
    today: new Date().toLocaleDateString(),
    dept_name: "Billing / Insurance",
    stage_label: "Authorization Pending",
    task_label: "Submit Authorization Request",
    due_date: new Date(Date.now() + 3 * 86400000).toLocaleDateString(),
    initials: "AD",
    milestone_label: "Expiring in 30 Days",
    insurance_payer: "Aetna",
    auth_expiration_date: new Date(Date.now() + 30 * 86400000).toLocaleDateString(),
    treatment_plan_submitted_date: fmtDateLong(new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10)),
    authorization_approved_date: fmtDateLong(new Date().toISOString().slice(0, 10)),
    auth_start_date: fmtDateLong(new Date().toISOString().slice(0, 10)),
    days_remaining: 30,
    assigned_bcba_name: "Allie R.",
    authorization_status: "Approved",
    client_link: `${APP_BASE_URL}/#/pipeline/123`,
    org_name: "Sunrise Elementary School",
    contact_name: "Jordan Lee",
    assigned_to: "Quiana Blake",
    weekly_hours: "20",
  };
}

async function previewEmailTemplate(key) {
  const template = await getEmailTemplate(key);
  if (!template) return null;
  const fields = sampleFieldsFor();
  return {
    subject: renderMergeFields(template.subject_template, fields),
    html: renderMergeFields(template.body_template, fields),
  };
}

async function sendTestEmailTemplate(key, toEmail, actor) {
  const rendered = await previewEmailTemplate(key);
  if (!rendered) return { ok: false, error: "Unknown template key" };
  const result = await sendEmail({
    to: toEmail,
    subject: `[TEST] ${rendered.subject}`,
    html: rendered.html,
    type: "template_test",
  });
  await logFinancialAudit(actor, "email_template_test_sent", `key=${key} to=${toEmail} delivered=${result.delivered}`).catch(
    () => {}
  );
  return { ok: result.delivered !== "failed", ...result };
}

// ---- Image storage for template bodies (Railway volume) ----
function guessExtFromMime(mimeType) {
  const map = { "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };
  return map[mimeType] || ".png";
}

function saveEmailImage(filename, mimeType, base64Content) {
  const rawExt = path.extname(filename || "").toLowerCase();
  const ext = /^\.(png|jpe?g|gif|webp)$/.test(rawExt) ? rawExt : guessExtFromMime(mimeType);
  const storedName = `${crypto.randomBytes(8).toString("hex")}${ext}`;
  const buffer = Buffer.from(base64Content, "base64");
  fs.writeFileSync(path.join(IMAGES_DIR, storedName), buffer);
  return storedName;
}

const emailTemplates = {
  canEditEmailTemplates,
  EMAIL_TEMPLATE_DEFS,
  seedEmailTemplates,
  renderMergeFields,
  getEmailTemplate,
  listEmailTemplates,
  saveEmailTemplate,
  previewEmailTemplate,
  sendTestEmailTemplate,
  saveEmailImage,
};

// ============================== PIPELINE ==============================
// server/pipeline.js
// The enrollment pipeline: stage order, per-stage tasks/SLAs, department alerts,
// and parent milestone emails -- modeled directly on Spectrum Squad's real
// enrollment sheet columns (Clinical Screener, Insurance Verification, Intake
// Packet, Vineland/Assessment, Authorization, First Day of ABA).
"use strict";

const STAGES = [
  { key: "new_submission", label: "New Submission", color: "#6b7280" },
  { key: "clinical_screener", label: "Clinical Screener", color: "#3f8f89" },
  { key: "insurance_verification", label: "Insurance Verification", color: "#3f56b5" },
  // "Intake Packet" was retired at Quiana's request. The SignNow enrollment
  // packet is unaffected -- it is sent at new submission and chased on its own
  // clock, and never depended on a client being parked in a stage named after
  // it. The migration below moves anyone who was in that stage on to the next
  // one; the key is deliberately left out of STAGE_ORDER so nextStageKey()
  // steps straight from insurance verification to the assessment.
  { key: "assessment_scheduling", label: "In-Clinic Assessment", color: "#1b2a6b" },
  { key: "authorization", label: "Authorization Pending", color: "#c98a1b" },
  { key: "first_day_scheduled", label: "First Day Scheduling", color: "#e0a430" },
  { key: "active", label: "Active Therapy", color: "#22c55e" },
  { key: "discharged", label: "Discharged", color: "#64748b" },
  { key: "not_moving_forward", label: "Not Moving Forward", color: "#ef4444" },
];

const STAGE_ORDER = STAGES.map((s) => s.key);

function nextStageKey(currentKey) {
  const idx = STAGE_ORDER.indexOf(currentKey);
  if (idx === -1 || idx >= STAGE_ORDER.length - 1) return null;
  // skip terminal stages
  const next = STAGE_ORDER[idx + 1];
  if (next === "discharged" || next === "not_moving_forward") return null;
  return next;
}

function getStage(key) {
  return STAGES.find((s) => s.key === key);
}

// Create the task(s) required for a given stage, due `sla_days` business days
// from now, and fire the department alert email that tells staff a client
// needs attention at this stage.
// `silent` records the stage move without telling anybody about it. That is
// for catching the CRM up on work that already happened outside it: emailing a
// family a "welcome to the next step" for a step they completed a fortnight
// ago is worse than not emailing at all, and the department alert asks staff to
// action something already actioned. The move, the tasks and the history are
// all still written -- only the outbound messages are held.
async function enterStage(clientId, stageKey, { silent = false } = {}) {
  const client = await dbGet("SELECT * FROM clients WHERE id = ?", [clientId]);
  if (!client) return;

  await dbRun("UPDATE clients SET stage = ?, updated_at = ?, stage_entered_at = ? WHERE id = ?", [stageKey, nowISO(), nowISO(), clientId]);

  // Reaching Active Therapy is the one every other stage is working towards,
  // so it is reported as its own thing rather than buried among stage moves.
  if (stageKey !== client.stage) {
    const stageDef = STAGES.find((s) => s.key === stageKey);
    completions.record(stageKey === "active" ? "client_active" : "client_stage_advanced", {
      subject: client.child_name,
      detail: stageKey === "active" ? null : `Now in ${(stageDef && stageDef.label) || stageKey}`,
      clientId,
      dedupeKey: `stage:${clientId}:${stageKey}`,
      link: `${APP_BASE_URL}/#/pipeline/${clientId}`,
    });
  }

  const tasks = await dbAll("SELECT * FROM stage_tasks WHERE stage_key = ?", [stageKey]);
  for (const task of tasks) {
    const dueDate = addBusinessDays(new Date(), task.sla_days).toISOString();
    await dbRun(
      `INSERT INTO client_tasks (client_id, stage_task_id, status, due_date, created_at)
       VALUES (?, ?, 'pending', ?, ?)`,
      [clientId, task.id, dueDate, nowISO()]
    );

    // The Clinical Prescreen is a system-managed, parent-driven step: the
    // screener module invites and reminds the PARENT automatically, and marks
    // the client complete on submission. Staff should not be pinged to "do" it,
    // so we skip the department alert for this stage. The task row still exists
    // and is visible for tracking; it simply never nags staff. (Overdue alerts
    // for it are likewise suppressed in checkOverdueTasks.)
    const dept = await dbGet("SELECT * FROM departments WHERE id = ?", [task.department_id]);
    if (dept && dept.notify_email && stageKey !== "clinical_screener") {
      const template = await emailTemplates.getEmailTemplate("department_alert");
      const fields = {
        dept_name: dept.name,
        child_name: client.child_name,
        parent_name: client.parent_name,
        stage_label: getStage(stageKey)?.label,
        task_label: task.label,
        due_date: new Date(dueDate).toLocaleDateString(),
      };
      if (!silent) {
        sendEmail({
          to: dept.notify_email,
          subject: emailTemplates.renderMergeFields(template.subject_template, fields),
          html: emailTemplates.renderMergeFields(template.body_template, fields),
          clientId,
          type: "department_alert",
        }).catch((e) => console.error("sendEmail failed:", e));
      }
    }
  }

  if (!silent) await sendParentMilestone(client, stageKey);
}

// Stages that trigger a parent-facing milestone email, mapped to the template
// key they send (rows in email_templates, editable under Settings -> Email
// Templates).
//
// Note "first_day_scheduled": a client lands in that stage the moment the
// "Submit Authorization Request" task is ticked, which is BEFORE the payer has
// approved anything. It used to send milestone_first_day_scheduled ("your
// authorization is in"), which told parents they were approved when the
// request had only just gone out. It now sends the treatment-plan-submitted
// email instead; the approval email is fired separately, by the authorization
// status actually changing to Approved.
const MILESTONE_STAGE_TEMPLATES = {
  new_submission: "milestone_new_submission",
  authorization: "milestone_authorization",
  first_day_scheduled: "milestone_treatment_plan_submitted",
  active: "milestone_active",
};
// "2026-08-10" -> "August 10, 2026". Parents read these in an email, not a
// database. Anything unparseable is passed through untouched.
function fmtDateLong(value) {
  if (!value) return "";
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T12:00:00` : value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

// Every merge field a parent-facing milestone email can use. Blank values
// render as "" rather than the raw {{token}}, so a template that references a
// date we don't have yet degrades quietly instead of leaking placeholder text.
function parentMilestoneFields(client) {
  return {
    parent_name: client.parent_name,
    child_name: client.child_name,
    today: new Date().toLocaleDateString(),
    treatment_plan_submitted_date: fmtDateLong(client.treatment_plan_submitted_date),
    authorization_approved_date: fmtDateLong(client.authorization_approved_date),
    auth_start_date: fmtDateLong(client.auth_start_date),
    auth_expiration_date: fmtDateLong(client.auth_expiration_date),
    insurance_payer: client.insurance_payer || "your insurance",
    assigned_bcba_name: client.assigned_bcba_name || "",
    authorization_status: client.authorization_status || "",
  };
}

async function sendParentMilestone(client, stageKey) {
  const templateKey = MILESTONE_STAGE_TEMPLATES[stageKey];
  if (!templateKey || !client.parent_email) return;
  await sendParentTemplate(client, templateKey);
}

// Send one parent-facing template to a client's parent. Shared by the stage
// milestones and by the authorization-approved email, so both get the same
// merge fields, branding and notifications_log entry.
async function sendParentTemplate(client, templateKey) {
  if (!client || !client.parent_email) return { sent: false, reason: "no_parent_email" };
  const template = await emailTemplates.getEmailTemplate(templateKey);
  if (!template) return { sent: false, reason: "no_template" };
  const fields = parentMilestoneFields(client);
  await sendEmail({
    to: client.parent_email,
    subject: emailTemplates.renderMergeFields(template.subject_template, fields),
    html: emailTemplates.renderMergeFields(template.body_template, fields),
    clientId: client.id,
    type: "parent_milestone",
  }).catch((e) => console.error("sendEmail failed:", e));
  return { sent: true };
}

async function completeTask(taskId, completedByUserId, opts = {}) {
  const task = await dbGet("SELECT * FROM client_tasks WHERE id = ?", [taskId]);
  if (!task) return { ok: false, error: "Task not found" };

  // last_completed_at mirrors completed_at and is deliberately never cleared,
  // so a task that is reopened still shows when it had been ticked.
  await dbRun("UPDATE client_tasks SET status = 'completed', completed_at = ?, last_completed_at = ? WHERE id = ?", [nowISO(), nowISO(), taskId]);

  // Marked as already-done rather than done-now. Recorded on the row, because
  // "no email went out for this one" is a fact somebody will need later when
  // they wonder why a family never heard about a step.
  const silent = opts.silent === true;
  if (silent) {
    await dbRun("UPDATE client_tasks SET completed_silently = TRUE WHERE id = ?", [taskId]).catch(() => {});
  }

  const taskLabel = await dbGet("SELECT label, stage_key FROM stage_tasks WHERE id = ?", [task.stage_task_id]).catch(() => null);

  // Ticking "Submit Authorization Request" is the moment the treatment plan
  // goes to the payer. Record the date BEFORE advancing the stage, because the
  // parent email that follows quotes it back to the family.
  //
  // A date is always stored, never left blank: an explicit one from the office
  // wins, otherwise today. Bulk-completing tasks sends no date, and an email
  // reading "submitted on ." would be worse than an approximate day. An
  // existing date is only overwritten by an explicit one, so undoing and
  // re-ticking a task can't quietly rewrite real history.
  if (taskLabel && taskLabel.stage_key === "authorization") {
    const raw = String(opts.treatment_plan_submitted_date || "").slice(0, 10);
    const explicit = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
    const existing = await dbGet("SELECT treatment_plan_submitted_date FROM clients WHERE id = ?", [task.client_id]);
    const date = explicit || (existing && existing.treatment_plan_submitted_date) || todayISODate();
    await dbRun("UPDATE clients SET treatment_plan_submitted_date = ?, authorization_submitted = true, updated_at = ? WHERE id = ?",
      [date, nowISO(), task.client_id]);
  }

  // If all tasks for the client's current stage are complete, auto-advance.
  const client = await dbGet("SELECT * FROM clients WHERE id = ?", [task.client_id]);

  completions.record("stage_task_completed", {
    subject: client && client.child_name,
    detail: taskLabel && taskLabel.label,
    clientId: task.client_id,
    // A task can be un-ticked and re-ticked; each completion is real news, so
    // the timestamp is part of the key rather than the task id alone.
    dedupeKey: `stage_task:${taskId}:${nowISO()}`,
    link: `${APP_BASE_URL}/#/pipeline/${task.client_id}`,
  });
  const stageTaskRows = await dbAll("SELECT id FROM stage_tasks WHERE stage_key = ?", [client.stage]);
  const stageTaskIds = stageTaskRows.map((r) => r.id);

  const remaining = await dbGet(
    `SELECT COUNT(*) AS n FROM client_tasks
     WHERE client_id = ? AND status != 'completed' AND stage_task_id IN (${stageTaskIds
       .map(() => "?")
       .join(",") || "-1"})`,
    [task.client_id, ...stageTaskIds]
  );

  if (Number(remaining.n) === 0) {
    const next = nextStageKey(client.stage);
    if (next) await enterStage(client.id, next, { silent });
  }

  return { ok: true };
}

function addBusinessDays(date, days) {
  const result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay();
    if (day !== 0 && day !== 6) added++;
  }
  return result;
}

// Scan for pending tasks past due; mark overdue and fire one alert per task.
async function checkOverdueTasks() {
  const now = new Date().toISOString();
  const overdue = await dbAll(
    // The Clinical Prescreen is system-managed and parent-driven, so its stage
    // task is deliberately excluded here: it is never marked overdue and never
    // nags staff. The parent gets reminded by the screener module instead.
    `SELECT ct.*, st.label, st.department_id, c.child_name, c.parent_name
     FROM client_tasks ct
     JOIN stage_tasks st ON st.id = ct.stage_task_id
     JOIN clients c ON c.id = ct.client_id
     WHERE ct.status = 'pending' AND ct.due_date < ? AND ct.overdue_notified_at IS NULL
       AND st.stage_key <> 'clinical_screener'
       -- Nobody is working a waitlisted or closed client, so flagging their
       -- tasks overdue only emails staff about work they are not meant to do.
       -- The task stays pending; it is simply not chased.
       AND COALESCE(c.waitlisted, false) = false
       AND c.stage NOT IN ('discharged','not_moving_forward')`,
    [now]
  );

  for (const t of overdue) {
    await dbRun("UPDATE client_tasks SET status = 'overdue', overdue_notified_at = ? WHERE id = ?", [nowISO(), t.id]);
    const dept = await dbGet("SELECT * FROM departments WHERE id = ?", [t.department_id]);
    if (dept && dept.notify_email) {
      const template = await emailTemplates.getEmailTemplate("overdue_alert");
      const fields = {
        task_label: t.label,
        child_name: t.child_name,
        parent_name: t.parent_name,
        due_date: new Date(t.due_date).toLocaleDateString(),
      };
      sendEmail({
        to: dept.notify_email,
        subject: emailTemplates.renderMergeFields(template.subject_template, fields),
        html: emailTemplates.renderMergeFields(template.body_template, fields),
        clientId: t.client_id,
        type: "overdue_alert",
      }).catch((e) => console.error("sendEmail failed:", e));
    }
  }
  return overdue.length;
}

// Remind parents to schedule the in-clinic / in-home assessment. Fires for any
// active client that has reached the assessment stage but has no assessment
// date on file, throttled to once every 3 days per client.
// A client on the waitlist has been told, in the waitlist email itself, that
// they don't need to do anything right now. Every automated "please finish X"
// message to the parent is therefore held while that is true, and picks back up
// when they come off -- along with the other cases in intake-chasing.js.
const { isWaitlisted, intakeChasingPaused, chasingState } = require("./intake-chasing");
const { packetSweepStep } = require("./packet-clock");

async function processAssessmentReminders() {
  const clients = await dbAll(
    `SELECT * FROM clients
      WHERE stage = 'assessment_scheduling'
        AND (in_clinic_assessment_date IS NULL OR in_clinic_assessment_date = '')
        AND parent_email IS NOT NULL AND parent_email <> ''
        AND waitlisted = false`
  );
  const now = Date.now();
  const THROTTLE_MS = 3 * 24 * 60 * 60 * 1000;
  let sent = 0;
  for (const c of clients) {
    if (c.assessment_reminder_sent_at && now - new Date(c.assessment_reminder_sent_at).getTime() < THROTTLE_MS) continue;
    const template = await emailTemplates.getEmailTemplate("assessment_reminder");
    if (!template) continue;
    const fields = { parent_name: c.parent_name, child_name: c.child_name, today: new Date().toLocaleDateString() };
    await sendEmail({
      to: c.parent_email,
      subject: emailTemplates.renderMergeFields(template.subject_template, fields),
      html: emailTemplates.renderMergeFields(template.body_template, fields),
      clientId: c.id,
      type: "assessment_reminder",
    }).catch((e) => console.error("assessment reminder failed:", e));
    await dbRun("UPDATE clients SET assessment_reminder_sent_at = ? WHERE id = ?", [nowISO(), c.id]);
    sent++;
  }
  return sent;
}

const pipeline = { STAGES, STAGE_ORDER, nextStageKey, getStage, enterStage, completeTask, checkOverdueTasks, sendParentMilestone, processAssessmentReminders };

// The live pipeline stages a closed-out client may be restored into. Derived
// from STAGES so a stage added later is automatically offered, minus the two
// terminal ones (restoring a client INTO "not moving forward" is a no-op) and
// minus "active", which is a clinical state reached by finishing the pipeline
// rather than something to be dropped into by hand.
const REACTIVATABLE_STAGES = STAGE_ORDER.filter(
  (k) => !["discharged", "not_moving_forward", "active"].includes(k)
);

// A note written by the app on the user's behalf, in the client's existing
// note trail. Used for record-level events (closed out, reactivated) that
// staff need to still see months later.
async function addSystemClientNote(clientId, user, body) {
  await dbRun(
    `INSERT INTO client_notes (client_id, author_id, author_name, body, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [clientId, (user && user.id) || null, (user && (user.name || user.email)) || "System", body, nowISO()]
  ).catch((e) => console.error("addSystemClientNote failed:", e.message));
}

// Put a completed client stage task back on the open list. The SAME task row
// is reused -- reopening never creates a second copy of the task, and its due
// date, department and stage are all untouched. What changes is only its
// status, plus the small history trail (who reopened it, when, how many times,
// and the completion date it is being rolled back from) that lets the card say
// "completed 3 Aug, reopened by Quiana 5 Aug".
//
// Deliberately does NOT rewind the client's stage: the stage change already
// fired its department alert and its parent milestone email, and walking those
// back would either re-send them or leave the record claiming something that
// never un-happened.
async function reopenClientTask(taskId, user) {
  const task = await dbGet("SELECT * FROM client_tasks WHERE id = ?", [taskId]);
  if (!task) return { ok: false, error: "Task not found" };
  if (task.status !== "completed") return { ok: true, already_open: true };
  await dbRun(
    `UPDATE client_tasks
        SET status = 'pending', completed_at = NULL, overdue_notified_at = NULL,
            last_completed_at = COALESCE(last_completed_at, ?),
            reopened_at = ?, reopened_by = ?, reopen_count = COALESCE(reopen_count, 0) + 1
      WHERE id = ?`,
    [task.completed_at, nowISO(), (user && (user.name || user.email)) || "staff", taskId]
  );
  const label = await dbGet("SELECT label FROM stage_tasks WHERE id = ?", [task.stage_task_id]).catch(() => null);
  console.log(`[client ${task.client_id}] task ${taskId} (${(label && label.label) || "?"}) reopened by ${(user && user.email) || "unknown"} at ${nowISO()}`);
  return { ok: true, reopened: true };
}

// ---- Staff to-do tasks (assignable, with due dates + email reminders) ----
const TASK_PRIORITIES = ["low", "normal", "high", "urgent"];
function normalizePriority(p) {
  const v = String(p || "").trim().toLowerCase();
  return TASK_PRIORITIES.includes(v) ? v : "normal";
}
async function createStaffTask({ title, description, assigned_user_id, assigned_name, assigned_email, client_id, due_date, created_by, priority, grant_id }) {
  // If assigned by name only, try to resolve to a user for reminders.
  let uid = assigned_user_id || null;
  let uname = assigned_name || null;
  let uemail = (assigned_email || "").trim() || null;
  if (!uid && uname) {
    const u = await dbGet("SELECT id, name FROM users WHERE lower(name) = lower(?) LIMIT 1", [uname]);
    if (u) uid = u.id;
  }
  if (uid && !uname) {
    const u = await dbGet("SELECT name FROM users WHERE id = ?", [uid]);
    if (u) uname = u.name;
  }
  // Someone on the staff roster without a CRM login still has to hear about
  // the task, so their address is looked up once and kept on the row rather
  // than resolved through users on every send.
  if (!uemail && uname) {
    const e = await dbGet(
      "SELECT email FROM hr_employees WHERE lower(name) = lower(?) AND email IS NOT NULL AND email <> '' LIMIT 1",
      [uname]
    ).catch(() => null);
    if (e) uemail = e.email;
  }
  const row = await dbGet(
    `INSERT INTO staff_tasks (title, description, assigned_user_id, assigned_name, assigned_email, client_id, grant_id, due_date, priority, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?) RETURNING *`,
    [title, description || null, uid, uname, uemail, client_id || null, grant_id || null, due_date || null, normalizePriority(priority), created_by || "system", nowISO()]
  );
  // Notify the assignee immediately that a task was assigned to them.
  {
    const u = uid
      ? await dbGet("SELECT email, name FROM users WHERE id = ?", [uid]).catch(() => null)
      : (uemail ? { email: uemail, name: uname } : null);
    if (u && u.email) {
      let childName = null;
      if (client_id) { const c = await dbGet("SELECT child_name FROM clients WHERE id = ?", [client_id]).catch(() => null); childName = c && c.child_name; }
      await sendEmail({
        to: u.email,
        subject: `New task assigned to you: ${title}`,
        html: `<p>Hi ${uname || u.name || "there"},</p>
          <p>A new task has been assigned to you${created_by ? ` by ${created_by}` : ""}${due_date ? `, due <strong>${new Date(due_date).toLocaleDateString()}</strong>` : ""}:</p>
          <p style="font-size:16px;"><strong>${title}</strong></p>
          ${description ? `<p>${description}</p>` : ""}
          ${childName ? `<p>Client: <strong>${childName}</strong></p>` : ""}
          <p>Please log in to the CRM to view and complete it.</p>`,
        type: "staff_task_assigned",
      }).catch((e) => console.error("staff task assignment email failed:", e.message));
    }
  }
  return row;
}

// Email the assignee when a staff task is due today or overdue (once).
async function processStaffTaskReminders() {
  const today = new Date().toISOString().slice(0, 10);
  const due = await dbAll(
    // COALESCE so a task assigned to someone without a login still gets its
    // reminder -- before, no login meant no email, silently.
    `SELECT st.*, COALESCE(u.email, st.assigned_email) AS assignee_email, c.child_name
       FROM staff_tasks st
       LEFT JOIN users u ON u.id = st.assigned_user_id
       LEFT JOIN clients c ON c.id = st.client_id
      WHERE st.status = 'open' AND st.due_date IS NOT NULL
        AND st.due_date <= ? AND st.reminder_sent_at IS NULL`,
    [today + "T23:59:59.999Z"]
  );
  let sent = 0;
  for (const t of due) {
    if (t.assignee_email) {
      await sendEmail({
        to: t.assignee_email,
        subject: `Task due: ${t.title}`,
        html: `<p>Hi ${t.assigned_name || "there"},</p>
          <p>This is a reminder that a task assigned to you is due${t.due_date ? " (" + new Date(t.due_date).toLocaleDateString() + ")" : ""}:</p>
          <p style="font-size:16px;"><strong>${t.title}</strong></p>
          ${t.description ? `<p>${t.description}</p>` : ""}
          ${t.child_name ? `<p>Client: <strong>${t.child_name}</strong></p>` : ""}
          <p>Please log in to the CRM to mark it complete once done.</p>`,
        type: "staff_task_reminder",
      }).catch((e) => console.error("staff task reminder failed:", e));
    }
    await dbRun("UPDATE staff_tasks SET reminder_sent_at = ? WHERE id = ?", [nowISO(), t.id]);
    sent++;
  }
  return sent;
}

// ===================== TREATMENT PLAN DUE DATE + ESCALATION =====================
// The treatment plan is due 14 calendar days after the in-person assessment.
// recomputeTreatmentPlanDueDate() sets/updates that deadline; the sweep emails
// the assigned BCBA an escalating ladder (assigned -> 7 -> 3 -> 1 day -> overdue),
// each step at most once, and everything stops the moment the plan is submitted.
function addCalendarDays(dateStr, n) {
  const base = String(dateStr || "").slice(0, 10);
  const d = new Date(base + "T12:00:00");
  if (isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + Number(n));
  return d.toISOString().slice(0, 10);
}
async function markTpReminderSent(clientId, level) {
  const c = await dbGet("SELECT tp_reminders_sent FROM clients WHERE id = ?", [clientId]);
  let arr = [];
  try { arr = JSON.parse((c && c.tp_reminders_sent) || "[]"); } catch (e) { arr = []; }
  if (!arr.includes(level)) arr.push(level);
  await dbRun("UPDATE clients SET tp_reminders_sent = ? WHERE id = ?", [JSON.stringify(arr), clientId]);
}
async function sendTreatmentPlanReminder(client, level, dueDate) {
  const to = client.assigned_bcba_email;
  const bcbaName = client.assigned_bcba_name || "there";
  const child = client.child_name;
  const dueLong = fmtDateLong(dueDate);
  const LABELS = {
    assigned: { subj: `Treatment plan assigned: ${child} — due ${dueLong}`, lead: `A treatment plan is now due for ${child}. The clock started at their in-person assessment.` },
    "7":      { subj: `7 days left — ${child}'s treatment plan (due ${dueLong})`, lead: `Heads up: ${child}'s treatment plan is due in about 7 days.` },
    "3":      { subj: `3 days left — ${child}'s treatment plan (due ${dueLong})`, lead: `${child}'s treatment plan is due in about 3 days.` },
    "1":      { subj: `Due tomorrow — ${child}'s treatment plan (${dueLong})`, lead: `${child}'s treatment plan is due tomorrow.` },
    overdue:  { subj: `OVERDUE — ${child}'s treatment plan was due ${dueLong}`, lead: `${child}'s treatment plan is now overdue (it was due ${dueLong}).` },
  };
  const m = LABELS[level] || LABELS.assigned;
  if (!to) { console.warn(`[client ${client.id}] TP reminder "${level}" skipped: no assigned BCBA email`); return { sent: false }; }
  await sendEmail({
    to,
    subject: m.subj,
    html: `<p>Hi ${bcbaName},</p><p>${m.lead}</p>
      <p><strong>Client:</strong> ${child}<br/>
      <strong>Assessment date:</strong> ${fmtDateLong(client.in_clinic_assessment_date)}<br/>
      <strong>Treatment plan due:</strong> ${dueLong}</p>
      <p>Please complete and submit the treatment plan in the CRM. These reminders stop automatically once it's submitted.</p>`,
    clientId: client.id,
    type: "treatment_plan_reminder",
  }).catch((e) => console.error("TP reminder email failed:", e.message));
  return { sent: true };
}
async function recomputeTreatmentPlanDueDate(clientId) {
  const c = await dbGet("SELECT * FROM clients WHERE id = ?", [clientId]);
  if (!c) return;
  const asmt = c.in_clinic_assessment_date ? String(c.in_clinic_assessment_date).slice(0, 10) : null;
  if (!asmt) {
    // Assessment date cleared -> clear the deadline and the reminder ladder.
    if (c.treatment_plan_due_date) await dbRun("UPDATE clients SET treatment_plan_due_date = NULL, tp_reminders_sent = '[]' WHERE id = ?", [clientId]);
    return;
  }
  const due = addCalendarDays(asmt, 14);
  if (!due) return;
  const changed = String(c.treatment_plan_due_date || "").slice(0, 10) !== due;
  if (!changed) return;
  // A new or moved deadline resets the ladder so reminders re-evaluate.
  await dbRun("UPDATE clients SET treatment_plan_due_date = ?, tp_reminders_sent = '[]' WHERE id = ?", [due, clientId]);
  // Assignment notification to the BCBA, once, unless the plan is already in.
  if (!c.treatment_plan_submitted_date) {
    await sendTreatmentPlanReminder({ ...c, treatment_plan_due_date: due }, "assigned", due);
    await markTpReminderSent(clientId, "assigned");
  }
}
async function processTreatmentPlanReminders() {
  const today = todayISODate();
  const rows = await dbAll(
    `SELECT * FROM clients
      WHERE treatment_plan_due_date IS NOT NULL
        AND (treatment_plan_submitted_date IS NULL OR treatment_plan_submitted_date = '')
        AND (waitlisted IS NOT TRUE)
        AND stage NOT IN ('discharged','not_moving_forward','active')`
  );
  let sent = 0;
  for (const c of rows) {
    const due = String(c.treatment_plan_due_date).slice(0, 10);
    let done = [];
    try { done = JSON.parse(c.tp_reminders_sent || "[]"); } catch (e) { done = []; }
    const daysLeft = Math.round((new Date(due + "T12:00:00") - new Date(today + "T12:00:00")) / 86400000);
    let level = null;
    if (daysLeft < 0) level = "overdue";
    else if (daysLeft <= 1) level = "1";
    else if (daysLeft <= 3) level = "3";
    else if (daysLeft <= 7) level = "7";
    if (!level || done.includes(level)) continue;
    await sendTreatmentPlanReminder(c, level, due);
    await markTpReminderSent(c.id, level);
    sent++;
  }
  return sent;
}

// ============================== PIPELINE V2 (MILESTONE DASHBOARD) ==============================
// Computes the 5-phase view (Intake & Eligibility, Assessment, Authorization,
// Ready to Start, Active) on top of the existing 10-value `stage` column, plus
// per-client progress %, missing
// checklist items, blocker category, owner, and next action. Read-only --
// does not change how `stage` itself is stored or advanced.
"use strict";

// The primary pipeline is five phases:
//   Intake & Eligibility -> Assessment -> Authorization -> Ready to Start -> Active
// "New Lead" was retired as a standalone phase at Quiana's request: a brand-new
// submission now lives inside Intake & Eligibility (its first sub-step) instead
// of a column of its own. new_submission is folded into the key-2 stage list,
// and milestoneForStage() falls back to Intake & Eligibility. The key NUMBERS
// (2..6) are deliberately preserved so the checklist map and the milestone<=2 /
// milestone>=6 logic in computeMilestoneView keep working unchanged. This is a
// display/grouping change only -- no client's `stage` is altered, and nothing
// here sends email.
// "intake_packet" stays listed so any client still carrying that retired stage
// key -- an old row, a stale browser tab mid-save -- still resolves to a
// milestone instead of falling through.
const MILESTONES = [
  { key: 2, label: "Intake & Eligibility", stages: ["new_submission", "clinical_screener", "insurance_verification", "intake_packet"] },
  { key: 3, label: "Assessment", stages: ["assessment_scheduling"] },
  { key: 4, label: "Authorization", stages: ["authorization"] },
  { key: 5, label: "Ready to Start", stages: ["first_day_scheduled"] },
  { key: 6, label: "Active", stages: ["active"] },
];

function milestoneForStage(stageKey) {
  if (stageKey === "discharged" || stageKey === "not_moving_forward") return null;
  const m = MILESTONES.find((m) => m.stages.includes(stageKey));
  return m ? m.key : 2;
}

const MILESTONE_CHECKLISTS = {
  // Intake & Eligibility now also carries the two items that used to live under
  // "New Lead" (diagnosis + insurance card), so nothing that was tracked there
  // is lost -- it just lives under the merged phase now.
  2: [
    { key: "diagnosis_uploaded", label: "Diagnosis uploaded", blocker: "parent" },
    { key: "insurance_card_uploaded", label: "Insurance card uploaded", blocker: "parent" },
    { key: "clinical_screener_completed", label: "Clinical screener completed", blocker: "clinical" },
    { key: "insurance_verification_completed", label: "Insurance verification completed", blocker: "insurance" },
    { key: "intake_packet_sent", label: "Intake packet sent", blocker: "clinical" },
    { key: "intake_packet_returned", label: "Intake packet returned", blocker: "parent" },
  ],
  3: [
    { key: "vineland_completed", label: "Vineland", blocker: "clinical" },
    { key: "intake_assessment_scheduled_date", label: "Intake assessment scheduled", blocker: "clinical" },
    { key: "intake_assessment_completed", label: "Intake assessment completed", blocker: "clinical" },
  ],
  4: [
    { key: "authorization_submitted", label: "Authorization submitted", blocker: "insurance" },
    { key: "__authorization_approved", label: "Authorization approved", blocker: "insurance" },
    { key: "previous_provider_discharge_letter_received", label: "Previous provider discharge letter", blocker: "provider" },
    { key: "physician_referral_received", label: "Physician referral", blocker: "parent" },
    { key: "additional_insurance_docs_received", label: "Additional insurance documents", blocker: "parent" },
  ],
  5: [
    { key: "rethink_client_created", label: "Rethink client created", blocker: "clinical" },
    { key: "__bcba_assigned", label: "BCBA assigned", blocker: "clinical" },
    { key: "__rbt_assigned", label: "RBT assigned", blocker: "clinical" },
    { key: "schedule_finalized", label: "Schedule finalized", blocker: "clinical" },
    { key: "__first_session_scheduled", label: "First ABA session scheduled", blocker: "clinical" },
  ],
};

function checklistItemDone(client, item) {
  if (item.key === "__authorization_approved") return client.authorization_status === "Approved";
  if (item.key === "__bcba_assigned") return !!client.assigned_bcba_name;
  if (item.key === "__rbt_assigned") return !!client.assigned_rbt_name;
  if (item.key === "__first_session_scheduled") return !!client.first_day_date;
  return !!client[item.key];
}

function computeMilestoneView(client) {
  const milestone = milestoneForStage(client.stage);
  if (milestone === null) {
    return {
      milestone: null,
      milestoneLabel: client.stage === "discharged" ? "Discharged" : "Not Moving Forward",
      progressPct: 0, missingItems: [], blocker: null, owner: null, nextAction: null, daysInStage: null, priority: null,
    };
  }
  const def = MILESTONES.find((m) => m.key === milestone);
  const checklist = MILESTONE_CHECKLISTS[milestone] || [];
  const missing = checklist.filter((item) => !checklistItemDone(client, item));
  const progressPct = checklist.length ? Math.round(((checklist.length - missing.length) / checklist.length) * 100) : 100;

  let blocker = "ready";
  if (missing.length) blocker = missing[0].blocker;
  else if (milestone >= 6) blocker = "active"; // already receiving services -- not "ready for scheduling"

  let owner;
  if (milestone <= 2) owner = client.assigned_intake_coordinator_name || "Unassigned";
  else owner = client.assigned_bcba_name || "Unassigned";

  const enteredAt = client.stage_entered_at || client.updated_at || client.submitted_at;
  const daysInStage = enteredAt ? Math.max(0, Math.floor((Date.now() - new Date(enteredAt).getTime()) / 86400000)) : 0;

  let priority = "Low";
  if (missing.length >= 3 || daysInStage >= 14) priority = "High";
  else if (missing.length >= 1 || daysInStage >= 7) priority = "Medium";

  const nextAction = milestone >= 6
    ? "In active services."
    : missing.length
    ? `Follow up on: ${missing[0].label.toLowerCase()}.`
    : "Ready to advance to the next milestone.";

return { milestone, milestoneLabel: def ? def.label : null, progressPct, missingItems: missing.map((m) => m.label), missingItemKeys: missing.map((m) => m.key), blocker, owner, nextAction, daysInStage, priority };  
}

const pipelineV2 = { MILESTONES, milestoneForStage, computeMilestoneView };
// ============================== OWNER FINANCIALS (PERMISSIONS) ==============================
  // Mirrors the existing canViewAuth/sanitizeClientForRole pattern used for
  // authorization fields. Financial figures themselves are computed in a
  // later phase -- this just adds the permission check + settings lookup
  // that every financial code path will be gated behind.
  async function getOwnerFinancialSettings() {
    let row = await dbGet("SELECT * FROM owner_financial_settings WHERE id = 1");
    if (!row) {
      await dbRun(
        "INSERT INTO owner_financial_settings (id, avg_revenue_per_hour, avg_net_profit_per_hour, monthly_conversion_factor, default_hours_source, financial_view_roles) VALUES (1, 50, 11, 4.33, 'scheduled', 'owner,super_admin') ON CONFLICT (id) DO NOTHING"
      );
      row = await dbGet("SELECT * FROM owner_financial_settings WHERE id = 1");
    }
    return row;
  }

  // Financials are private to the business owner. Only the Owner (and a
  // Super Admin, which is defined as a co-owner login) may see any financial
  // data anywhere in the app. This intentionally ignores the per-user
  // can_view_financials flag and the configurable role list -- financials must
  // stay completely hidden from every other role, with no way to grant it by
  // accident from the Team Members screen.
  async function canViewFinancials(user) {
    return !!user && (user.role === "owner" || user.role === "super_admin");
  }

  const FINANCIAL_MISSING_LABELS = {
    service_start_date: "Service start date needed",
    scheduled_hours: "Scheduled hours needed",
    authorized_hours: "Authorized hours needed",
    custom_hours: "Custom projected hours needed",
    authorization_dates: "Authorization dates needed",
    service_end_date: "Service end date needed",
  };

  const MS_PER_WEEK = 86400000 * 7;

  function timeStrToHours(t) {
    if (!t) return 0;
    const parts = String(t).split(":");
    const h = Number(parts[0]) || 0;
    const m = Number(parts[1]) || 0;
    return h + m / 60;
  }

  async function getScheduledHoursByClient() {
    const rows = await dbAll("SELECT client_id, start_time, end_time FROM schedule_sessions");
    const totals = {};
    for (const r of rows) {
      const hrs = timeStrToHours(r.end_time) - timeStrToHours(r.start_time);
      totals[r.client_id] = (totals[r.client_id] || 0) + (hrs > 0 ? hrs : 0);
    }
    return totals;
  }

  function weeksBetween(startISO, endISO) {
    if (!startISO || !endISO) return null;
    const start = new Date(startISO);
    const end = new Date(endISO);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
    const diff = (end.getTime() - start.getTime()) / MS_PER_WEEK;
    return diff > 0 ? diff : 0;
  }

  function resolveProjectedHours(fsRow, ownerSettings, scheduledHoursPerWeek) {
    const pref = (fsRow && fsRow.hours_source_preference) || ownerSettings.default_hours_source || "scheduled";
    const authorized = fsRow && fsRow.authorized_hours_per_week != null ? Number(fsRow.authorized_hours_per_week) : null;
    const custom = fsRow && fsRow.custom_projected_hours_per_week != null ? Number(fsRow.custom_projected_hours_per_week) : null;
    const scheduled = scheduledHoursPerWeek != null ? Number(scheduledHoursPerWeek) : null;

    if (pref === "custom") {
      if (custom != null) return { hours: custom, source: "custom", sourceLabel: `${custom} custom projected hours per week` };
      return { hours: null, source: "custom", missing: "custom_hours" };
    }
    if (pref === "authorized") {
      if (authorized != null) return { hours: authorized, source: "authorized", sourceLabel: `${authorized} authorized hours per week` };
      return { hours: null, source: "authorized", missing: "authorized_hours" };
    }
    if (scheduled != null && scheduled > 0) return { hours: scheduled, source: "scheduled", sourceLabel: `${round2(scheduled)} scheduled hours per week` };
    if (authorized != null) return { hours: authorized, source: "authorized", sourceLabel: `${authorized} authorized hours per week (no scheduled hours found)` };
    return { hours: null, source: "scheduled", missing: "scheduled_hours" };
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }
  function roundDollars(n) {
    return n == null ? null : Math.round(n);
  }

  function computeClientFinancials(client, fsRow, ownerSettings, scheduledHoursPerWeek, nowDate) {
    const now = nowDate || new Date();
    const nowIso = now.toISOString();
    const missing = [];

    const revenuePerHour = Number(ownerSettings.avg_revenue_per_hour);
    const profitPerHour = Number(ownerSettings.avg_net_profit_per_hour);
    const monthlyFactor = Number(ownerSettings.monthly_conversion_factor);

    const hoursResult = resolveProjectedHours(fsRow, ownerSettings, scheduledHoursPerWeek);
    if (hoursResult.missing) missing.push(hoursResult.missing);
    const weeklyHours = hoursResult.hours;

    const isInactive = client.stage === "discharged" || client.stage === "not_moving_forward";

    const serviceStartDate = (fsRow && fsRow.service_start_date_override) || client.first_day_date || client.submitted_at || null;
    if (!serviceStartDate) missing.push("service_start_date");

    const serviceEndDate = (fsRow && fsRow.service_end_date_override) || null;
    if (isInactive && !serviceEndDate) missing.push("service_end_date");

    if (!client.auth_start_date || !client.auth_expiration_date) missing.push("authorization_dates");

    const out = {
      inputs: {
        weeklyHoursUsed: weeklyHours,
        hoursSource: hoursResult.source,
        hoursSourceLabel: hoursResult.sourceLabel || null,
        revenuePerHour,
        profitPerHour,
        monthlyFactor,
        serviceStartDate,
        serviceEndDate: isInactive ? serviceEndDate : null,
        isInactive,
      },
      revenue: null,
      netProfit: null,
      lifetime: null,
      missing,
      missingLabels: missing.map((m) => FINANCIAL_MISSING_LABELS[m] || m),
    };

    if (weeklyHours != null) {
      const monthlyHours = weeklyHours * monthlyFactor;
      const annualHours = weeklyHours * 52;
      out.revenue = {
        weekly: roundDollars(weeklyHours * revenuePerHour),
        monthly: roundDollars(monthlyHours * revenuePerHour),
        annual: roundDollars(annualHours * revenuePerHour),
        authorizationPeriod: null,
      };
      out.netProfit = {
        weekly: roundDollars(weeklyHours * profitPerHour),
        monthly: roundDollars(monthlyHours * profitPerHour),
        annual: roundDollars(annualHours * profitPerHour),
        authorizationPeriod: null,
      };

      const authWeeks = weeksBetween(client.auth_start_date, client.auth_expiration_date);
      if (authWeeks != null) {
        const authHours = weeklyHours * authWeeks;
        out.revenue.authorizationPeriod = roundDollars(authHours * revenuePerHour);
        out.netProfit.authorizationPeriod = roundDollars(authHours * profitPerHour);
      }
    }

    if (weeklyHours != null && serviceStartDate) {
      const lifetimeEndIso = isInactive ? (serviceEndDate || client.updated_at || nowIso) : nowIso;
      const weeksSinceStart = weeksBetween(serviceStartDate, lifetimeEndIso);
      const lifetimeHours = weeksSinceStart != null ? weeklyHours * weeksSinceStart : null;
      const lifetimeRevenue = lifetimeHours != null ? lifetimeHours * revenuePerHour : null;
      const lifetimeNetProfit = lifetimeHours != null ? lifetimeHours * profitPerHour : null;

      const lifetime = {
        serviceStartDate,
        serviceEndDate: isInactive ? serviceEndDate : null,
        isInactive,
        totalServiceWeeks: weeksSinceStart != null ? round2(weeksSinceStart) : null,
        lifetimeHours: lifetimeHours != null ? round2(lifetimeHours) : null,
        lifetimeRevenue: roundDollars(lifetimeRevenue),
        lifetimeNetProfit: roundDollars(lifetimeNetProfit),
        calculationSource: (fsRow && fsRow.lifetime_calc_source) || "estimated_from_schedule",
        projected12moRevenue: null,
        projected12moNetProfit: null,
        combinedRevenue: roundDollars(lifetimeRevenue),
        combinedNetProfit: roundDollars(lifetimeNetProfit),
      };

      if (!isInactive) {
        const projectedAnnualHours = weeklyHours * 52;
        lifetime.projected12moRevenue = roundDollars(projectedAnnualHours * revenuePerHour);
        lifetime.projected12moNetProfit = roundDollars(projectedAnnualHours * profitPerHour);
        lifetime.combinedRevenue = roundDollars((lifetimeRevenue || 0) + projectedAnnualHours * revenuePerHour);
        lifetime.combinedNetProfit = roundDollars((lifetimeNetProfit || 0) + projectedAnnualHours * profitPerHour);
      }

      out.lifetime = lifetime;
    }

    return out;
  }

  const ownerFinancials = {
    getOwnerFinancialSettings,
    canViewFinancials,
    FINANCIAL_MISSING_LABELS,
    getScheduledHoursByClient,
    computeClientFinancials,
  };
// ============================== SIGNNOW ENROLLMENT PACKET ==============================
// Automatically sends the "Spectrum Squad New Patient Enrollment Packet"
// via SignNow the moment a new lead is created (see createClientFromPayload
// below), then polls for completion, sends a daily reminder email while
// it's outstanding, and marks the client "Not Moving Forward" after 7 days
// with no signature. No fields are pre-filled -- the parent completes the
// whole packet themselves; this only handles sending + tracking.
const SIGNNOW_API_KEY = process.env.SIGNNOW_API_KEY || "";
const SIGNNOW_ENROLLMENT_TEMPLATE_ID = process.env.SIGNNOW_ENROLLMENT_TEMPLATE_ID || "";
const SIGNNOW_SENDER_EMAIL = process.env.SIGNNOW_SENDER_EMAIL || "qblake@spectrumsquadlv.com";
const SIGNNOW_API_BASE = "https://api.signnow.com";
// Auto-refresh credentials (preferred): the SignNow API app's Basic token plus
// the account login. When these are set, the app mints its own short-lived
// access token and renews it automatically, so it can never silently expire.
const SIGNNOW_BASIC_TOKEN = process.env.SIGNNOW_BASIC_TOKEN || "";
const SIGNNOW_USERNAME = process.env.SIGNNOW_USERNAME || "";
const SIGNNOW_PASSWORD = process.env.SIGNNOW_PASSWORD || "";

// True if we can authenticate against SignNow at all -- either the
// auto-refresh credentials or the legacy static API key. Reading a document's
// status only needs this; sending additionally needs a template (below).
// One helper rather than the same expression copied into five places, because
// the copies had already drifted: checkEnrollmentPackets tested SIGNNOW_API_KEY
// alone and so did nothing on installs using the auto-refresh credentials.
function signNowAuthConfigured() {
  return !!((SIGNNOW_BASIC_TOKEN && SIGNNOW_USERNAME && SIGNNOW_PASSWORD) || SIGNNOW_API_KEY);
}

// True if SignNow can send at all: authentication is available AND we have a
// template to send.
function signNowConfigured() {
  return !!(signNowAuthConfigured() && SIGNNOW_ENROLLMENT_TEMPLATE_ID);
}

// Cached access token so we don't re-auth on every call.
let _signNowToken = { value: "", expiresAt: 0 };
async function getSignNowAccessToken() {
  // If auto-refresh creds aren't configured, fall back to the legacy static key.
  if (!(SIGNNOW_BASIC_TOKEN && SIGNNOW_USERNAME && SIGNNOW_PASSWORD)) {
    return SIGNNOW_API_KEY;
  }
  // Reuse the cached token until 60s before it expires.
  if (_signNowToken.value && _signNowToken.expiresAt - 60000 > Date.now()) {
    return _signNowToken.value;
  }
  const res = await fetch(`${SIGNNOW_API_BASE}/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${SIGNNOW_BASIC_TOKEN}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "password",
      username: SIGNNOW_USERNAME,
      password: SIGNNOW_PASSWORD,
      scope: "*",
    }).toString(),
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch (e) { body = { raw: text }; }
  if (!res.ok || !body.access_token) {
    throw new Error(`SignNow auth failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
  }
  // expires_in is seconds; default to 30 days if absent.
  _signNowToken = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 2592000) * 1000 };
  return body.access_token;
}

async function signNowRequest(path, options = {}) {
  const token = await getSignNowAccessToken();
  const res = await fetch(`${SIGNNOW_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch (e) {
    body = { raw: text };
  }
  if (!res.ok) {
    // A 401 usually means an expired/rotated token — drop the cache so the next
    // attempt re-authenticates from scratch.
    if (res.status === 401) _signNowToken = { value: "", expiresAt: 0 };
    throw new Error(`SignNow ${path} failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

// signNowRequest parses JSON. A signed PDF is not JSON, so downloads need
// their own path -- same auth, no parsing, and a hard size ceiling so one
// oversized file cannot exhaust memory on a small Railway instance.
const SIGNNOW_MAX_DOWNLOAD = 25 * 1024 * 1024;
async function signNowFetchRaw(apiPath) {
  const token = await getSignNowAccessToken();
  const res = await fetch(`${SIGNNOW_API_BASE}${apiPath}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    if (res.status === 401) _signNowToken = { value: "", expiresAt: 0 };
    throw new Error(`SignNow ${apiPath} failed (${res.status})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > SIGNNOW_MAX_DOWNLOAD) {
    throw new Error(`File is ${Math.round(buf.length / 1048576)} MB, over the ${SIGNNOW_MAX_DOWNLOAD / 1048576} MB ceiling`);
  }
  return buf;
}

// Records the outcome of every enrollment-packet attempt (success, failure, or
// blocked) so nothing fails silently and the UI can show status + retry. Upserts
// on client_id and bumps the attempt counter.
async function recordPacketOutcome(clientId, { status, documentId = null, error = null }) {
  await dbRun(
    `INSERT INTO enrollment_packets (client_id, signnow_document_id, status, sent_at, error_detail, attempts, last_attempt_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT (client_id) DO UPDATE SET
       status = EXCLUDED.status,
       signnow_document_id = COALESCE(EXCLUDED.signnow_document_id, enrollment_packets.signnow_document_id),
       error_detail = EXCLUDED.error_detail,
       attempts = enrollment_packets.attempts + 1,
       last_attempt_at = EXCLUDED.last_attempt_at,
       sent_at = CASE WHEN EXCLUDED.status = 'sent' THEN EXCLUDED.sent_at ELSE enrollment_packets.sent_at END`,
    [clientId, documentId, status, nowISO(), error, nowISO()]
  );
}

// Reading SignNow's answers -- "is this signed yet?" and, at send time, "did an
// invite actually get created?" -- lives in its own module so a test can call
// the real functions. The bug behind the first was exactly one unverified line.
// See signnow-status.js.
const { readSignNowCompletion, readSignNowInviteDelivered } = require("./signnow-status");

async function sendEnrollmentPacket(client) {
  if (!signNowConfigured()) {
    const msg = "SignNow is not configured on the server (need SIGNNOW_ENROLLMENT_TEMPLATE_ID plus either the auto-refresh creds SIGNNOW_BASIC_TOKEN/SIGNNOW_USERNAME/SIGNNOW_PASSWORD, or a static SIGNNOW_API_KEY).";
    console.error(msg, "-- client", client.id);
    await recordPacketOutcome(client.id, { status: "blocked", error: msg }).catch(() => {});
    return { ok: false, status: "blocked", error: msg };
  }
  if (!client.parent_email) {
    const msg = "No parent email on file — cannot send the enrollment packet.";
    console.error(msg, "-- client", client.id);
    await recordPacketOutcome(client.id, { status: "blocked", error: msg }).catch(() => {});
    return { ok: false, status: "blocked", error: msg };
  }
  try {
    // Reuse the copy a previous failed attempt left behind, rather than making
    // another one. retryFailedEnrollmentPackets() retries a failed packet up to
    // six times, and each attempt used to copy a fresh document -- which is
    // where three identical "Enrollment Packet - Valeria Hernandez" documents
    // came from, none of them ever sent to anybody.
    //
    // Only reused when SignNow positively confirms the document is still there
    // AND still carries no invite. Anything less certain copies fresh:
    // re-inviting a document that DID get an invite would put a second packet
    // in front of a family who already had one.
    let documentId = null;
    const prior = await dbGet(
      "SELECT signnow_document_id, status FROM enrollment_packets WHERE client_id = ?", [client.id]);
    if (prior && prior.signnow_document_id && prior.status === "failed") {
      const stranded = await signNowRequest(`/document/${prior.signnow_document_id}`).catch(() => null);
      if (stranded && readSignNowInviteDelivered(stranded) === false) {
        documentId = prior.signnow_document_id;
        console.log(`[signnow] reusing the uninvited copy from the last attempt for client ${client.id} doc=${documentId}`);
      }
    }
    if (!documentId) {
      const copy = await signNowRequest(`/template/${SIGNNOW_ENROLLMENT_TEMPLATE_ID}/copy`, {
        method: "POST",
        body: JSON.stringify({ document_name: `Enrollment Packet - ${client.child_name}` }),
      });
      documentId = copy.id;
    }
    // Carried on the error so the catch below can record which copy was left
    // behind. Without it a failed invite abandons a real document in the
    // account with nothing in the CRM pointing at it.
    const tagDoc = (e) => { e.signNowDocumentId = documentId; throw e; };
    await signNowRequest(`/document/${documentId}/invite`, {
      method: "POST",
      body: JSON.stringify({
        to: [{ email: client.parent_email, role: "Recipient 1", order: 1 }],
        from: SIGNNOW_SENDER_EMAIL,
        subject: `Please complete ${client.child_name}'s enrollment packet — Spectrum Squad`,
        message: `Hi ${client.parent_name || "there"}, thank you for choosing Spectrum Squad! Please review and complete ${client.child_name}'s New Patient Enrollment Packet using the link below. If you have any questions, just reply to this email.`,
      }),
    }).catch(tagDoc);
    // Read the document back and check an invite really exists before telling
    // the CRM this family has been written to.
    //
    // On 2026-08-24, five families sat at "sent, awaiting signature" against
    // documents that carried no invite at all -- copied from the template,
    // every field empty, nothing ever emailed to the parent. They were chased
    // daily for a document they had never received, and the 7-day rule was
    // lined up to close them out for not signing it.
    //
    // The invite POST above had not thrown, so nothing here could have
    // noticed. A packet recorded as sent is the trigger for all of that
    // chasing, so it should mean an invite was observed, not that a request
    // came back 2xx.
    let delivered = null;
    try {
      delivered = readSignNowInviteDelivered(await signNowRequest(`/document/${documentId}`));
    } catch (readErr) {
      console.error(`[signnow] could not verify the invite for client ${client.id} doc=${documentId}: ${readErr.message}`);
    }

    if (delivered === false) {
      // The document exists and has no invite on it. Recorded as failed WITH
      // the document id, so the copy is traceable rather than orphaned in the
      // account -- three duplicate copies of one child's packet came from
      // retries that each dropped the id they had just created.
      const msg = "SignNow accepted the invite request but no invite exists on the document, so nothing reached the family.";
      console.error(`[signnow] packet not delivered for client ${client.id} doc=${documentId} -- ${msg}`);
      await recordPacketOutcome(client.id, { status: "failed", documentId, error: msg }).catch(() => {});
      return { ok: false, status: "failed", documentId, error: msg };
    }

    await recordPacketOutcome(client.id, { status: "sent", documentId });
    // `delivered === null` means the check itself could not be made, not that
    // the invite is missing -- failing the send on a blip at SignNow would send
    // a second copy to a family who already had one. It is recorded as sent and
    // the uncertainty is logged.
    console.log(`Enrollment packet sent for client ${client.id} doc=${documentId}`
      + (delivered === true ? " invite=confirmed" : " invite=unverified"));
    return { ok: true, status: "sent", documentId, inviteVerified: delivered === true };
  } catch (err) {
    console.error("Failed to send enrollment packet for client", client.id, err.message);
    // The document id when there is one: a failed send that drops it leaves the
    // copy stranded in SignNow with nothing pointing at it, which is how the
    // duplicates accumulated.
    await recordPacketOutcome(client.id, {
      status: "failed", documentId: err.signNowDocumentId || null, error: err.message,
    }).catch(() => {});
    return { ok: false, status: "failed", error: err.message };
  }
}

// ============================== NEW-HIRE EMPLOYMENT PACKET ==============================
// The staff-side twin of the enrollment packet: the moment an offer is
// accepted, the new hire gets their employment packet to sign in SignNow.
//
// The template id is read from the admin settings first and the environment
// second, so the packet can be pointed at a new SignNow template from the
// Admin screen without a redeploy.
//
// It is deliberately keyed on employee_id with a UNIQUE constraint: an offer
// can be marked accepted from the candidate's public link AND from the staff
// card, and neither path should be able to send a second packet to the same
// person.
const SIGNNOW_NEWHIRE_TEMPLATE_ID_ENV = process.env.SIGNNOW_NEWHIRE_TEMPLATE_ID || "";

// Settings that need a real stored value from the first boot, because more
// than one part of the app reads them.
const DEFAULT_SETTINGS = {
  // Quiana's SignNow "New Hire Employee Packet" template. Verified against the
  // account: it is a prepared template whose single role is "Recipient 1",
  // which is exactly the role sendNewHirePacket() invites -- so an offer
  // acceptance now actually sends instead of recording a blocked packet.
  // Seeded, not hard-coded: if she pastes a different ID in Admin Settings the
  // stored value wins and this line is never read again. Note there are two
  // templates by this name in the account; this is the one she gave, and the
  // more recently updated of the pair.
  signnow_newhire_template_id: "9b5e62f356aa42b297d72e71b965dfa4266ed957",
  credentialing_link_bcba: "https://sparkz.clickup.com/forms/3501350/f/3av96-450954/AMW0KVAC3YL07DEEMM",
  credentialing_link_rbt: "https://sparkz.clickup.com/forms/3501350/f/3av96-450934/OFTQKDCKHXT758222Z",
  class_dojo_link: "https://teach.classdojo.com/#/singleLinkSignup/TT6SYWAH3",
  shirt_count_full_time: "4",
  shirt_count_part_time: "3",
  // A draft, not a policy. Shirts are issued on the first day, so a new hire
  // arrives without one and the email has to tell them what to turn up in.
  // Left editable in Admin Settings like everything else here.
  first_day_dress_code:
    "Come as you are comfortable moving in — closed-toe shoes, and clothes you don't mind getting messy. "
    + "You'll get your Spectrum Squad shirts on the day, so no need to worry about wearing one.",
};

async function newHireTemplateId() {
  const fromSettings = (await getAppSetting("signnow_newhire_template_id", "")) || "";
  return String(fromSettings || SIGNNOW_NEWHIRE_TEMPLATE_ID_ENV).trim();
}

async function recordNewHirePacket(employeeId, { status, documentId = null, error = null, email = null, actor = null }) {
  await dbRun(
    `INSERT INTO newhire_packets (employee_id, signnow_document_id, status, recipient_email, sent_at,
       error_detail, attempts, last_attempt_at, triggered_by)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (employee_id) DO UPDATE SET
       status = EXCLUDED.status,
       signnow_document_id = COALESCE(EXCLUDED.signnow_document_id, newhire_packets.signnow_document_id),
       recipient_email = COALESCE(EXCLUDED.recipient_email, newhire_packets.recipient_email),
       error_detail = EXCLUDED.error_detail,
       attempts = newhire_packets.attempts + 1,
       last_attempt_at = EXCLUDED.last_attempt_at,
       triggered_by = COALESCE(EXCLUDED.triggered_by, newhire_packets.triggered_by),
       sent_at = CASE WHEN EXCLUDED.status = 'sent' THEN EXCLUDED.sent_at ELSE newhire_packets.sent_at END`,
    [employeeId, documentId, status, email, nowISO(), error, nowISO(), actor]
  );
}

// employee: { id, name, email, role_title }. `force` re-sends after a failure
// or when someone deliberately asks for a second copy from the staff card.
async function sendNewHirePacket(employee, { actor = "automation", force = false } = {}) {
  if (!employee || !employee.id) return { ok: false, status: "blocked", error: "No employee record." };

  const existing = await dbGet("SELECT * FROM newhire_packets WHERE employee_id = ?", [employee.id]);
  if (existing && ["sent", "completed"].includes(existing.status) && !force) {
    return { ok: true, status: existing.status, already: true, documentId: existing.signnow_document_id };
  }

  const templateId = await newHireTemplateId();
  const hasAuth = signNowAuthConfigured();
  if (!hasAuth || !templateId) {
    const msg = !hasAuth
      ? "SignNow is not connected on the server (needs SIGNNOW_BASIC_TOKEN / SIGNNOW_USERNAME / SIGNNOW_PASSWORD, or SIGNNOW_API_KEY)."
      : "No new-hire packet template is set. Add the SignNow template ID in Admin Settings → New-hire employment packet.";
    await recordNewHirePacket(employee.id, { status: "blocked", error: msg, email: employee.email || null, actor }).catch(() => {});
    return { ok: false, status: "blocked", error: msg };
  }
  if (!employee.email) {
    const msg = "No email address on file for this staff member — the employment packet could not be sent.";
    await recordNewHirePacket(employee.id, { status: "blocked", error: msg, actor }).catch(() => {});
    return { ok: false, status: "blocked", error: msg };
  }

  try {
    const copy = await signNowRequest(`/template/${templateId}/copy`, {
      method: "POST",
      body: JSON.stringify({ document_name: `New Hire Employment Packet - ${employee.name}` }),
    });
    const documentId = copy.id;
    const firstName = String(employee.name || "").trim().split(/\s+/)[0] || "there";
    await signNowRequest(`/document/${documentId}/invite`, {
      method: "POST",
      body: JSON.stringify({
        to: [{ email: employee.email, role: "Recipient 1", order: 1 }],
        from: SIGNNOW_SENDER_EMAIL,
        subject: `Welcome to Spectrum Squad — please complete your new hire paperwork`,
        message: `Hi ${firstName}, welcome to the team! Please review and sign your New Hire Employment Packet${employee.role_title ? ` for the ${employee.role_title} role` : ""} using the link below. Getting this back before your start date keeps your onboarding on track. If anything looks off, just reply to this email.`,
      }),
    });
    await recordNewHirePacket(employee.id, { status: "sent", documentId, email: employee.email, actor });
    console.log(`New-hire packet sent to ${employee.email} for employee ${employee.id}`);
    return { ok: true, status: "sent", documentId };
  } catch (err) {
    console.error("Failed to send new-hire packet for employee", employee.id, err.message);
    await recordNewHirePacket(employee.id, { status: "failed", error: err.message, email: employee.email, actor }).catch(() => {});
    return { ok: false, status: "failed", error: err.message };
  }
}

async function getNewHirePacket(employeeId) {
  const row = await dbGet("SELECT * FROM newhire_packets WHERE employee_id = ?", [employeeId]);
  const templateId = await newHireTemplateId();
  const hasAuth = signNowAuthConfigured();
  return { packet: row || null, configured: hasAuth && !!templateId, signnow_connected: hasAuth, template_set: !!templateId };
}

// Self-healing sweep: re-attempts the enrollment packet for any early-stage
// client whose packet never successfully sent (missing row, or status
// failed/blocked). Runs on the same hourly cadence as the packet checker, so a
// transient SignNow outage or a briefly-missing config self-corrects instead of
// silently dropping a family. Capped attempts so a permanently-bad config
// doesn't loop forever (it stays visible as 'failed'/'blocked' for manual fix).
async function retryFailedEnrollmentPackets() {
  if (!signNowConfigured()) return; // nothing we can do until configured
  const EARLY_STAGES = ["new_submission", "clinical_screener", "insurance_verification", "intake_packet"];
  const placeholders = EARLY_STAGES.map(() => "?").join(",");
  const rows = await dbAll(
    `SELECT c.* FROM clients c
       LEFT JOIN enrollment_packets p ON p.client_id = c.id
      WHERE c.stage IN (${placeholders})
        AND c.parent_email IS NOT NULL
        AND c.waitlisted = false
        AND (p.id IS NULL OR (p.status IN ('failed','blocked') AND p.attempts < 6))`,
    EARLY_STAGES
  );
  for (const client of rows) {
    await sendEnrollmentPacket(client).catch((e) => console.error("retry packet failed:", e.message));
  }
}

async function checkEnrollmentPackets() {
  // Polling a document's status needs authentication, not a template. This
  // used to test SIGNNOW_API_KEY, which is empty on every install using the
  // preferred auto-refresh credentials -- so the sweep returned immediately,
  // packets were never marked 'completed', the daily reminders never went out,
  // and (because the Clinical Screener invite is triggered by packet
  // completion) no screener was ever sent automatically.
  if (!signNowAuthConfigured()) return;
  const pending = await dbAll("SELECT * FROM enrollment_packets WHERE status = 'sent'");
  const now = Date.now();

  for (const packet of pending) {
    let signNowStatus = null;
    try {
      const doc = await signNowRequest(`/document/${packet.signnow_document_id}`);
      signNowStatus = readSignNowCompletion(doc);
      if (!signNowStatus) {
        // Not signed yet -- or a response shape we do not understand. Those two
        // look identical from here and used to be silently treated as "still
        // waiting", which is how completed packets sat unnoticed for weeks.
        // Log the shape (keys only, never field values -- a signed enrollment
        // packet is full of a family's personal details) so a mismatch shows up
        // in the logs instead of as a mystery.
        // Document id and status strings only -- both safe to log. The first
        // version of this printed the response's key list, which proved the
        // shape was not what the fix assumed but could not say WHICH packet was
        // which, so it could not be checked against SignNow. The document id
        // makes that cross-reference possible; the statuses say what SignNow
        // actually calls the state we are failing to recognise.
        const inviteStatuses = []
          .concat((doc.field_invites || []).map((i) => `fi:${i && i.status}`))
          .concat((doc.requests || []).map((i) => `rq:${i && i.status}${i && i.signature_id ? "+sig" : ""}`));
        console.log(`[signnow] packet ${packet.id} not complete yet. `
          + `doc=${packet.signnow_document_id} `
          + `field_invites=${(doc.field_invites || []).length} `
          + `requests=${(doc.requests || []).length} `
          + `signatures=${(doc.signatures || []).length} `
          + `group=${doc.document_group_info ? "yes" : "no"} `
          + `statuses=[${inviteStatuses.join(" ")}]`);
      }
    } catch (err) {
      console.error("SignNow status check failed for packet", packet.id, err.message);
      continue;
    }

    if (signNowStatus === "completed" || signNowStatus === "declined") {
      await dbRun("UPDATE enrollment_packets SET status = ?, completed_at = ? WHERE id = ?", [
        signNowStatus,
        nowISO(),
        packet.id,
      ]);
      if (signNowStatus === "completed") {
        const pc = await dbGet("SELECT child_name FROM clients WHERE id = ?", [packet.client_id]).catch(() => null);
        // This sweep re-reads the same packet every hour until its row flips,
        // so the packet id is the dedupe key -- one notice per packet, ever.
        completions.record("enrollment_packet_completed", {
          subject: pc && pc.child_name,
          clientId: packet.client_id,
          dedupeKey: `enrollment_packet:${packet.id}`,
          link: `${APP_BASE_URL}/#/pipeline/${packet.client_id}`,
        });
      }
      continue;
    }

    // What to do with this packet -- reminder, expiry, or leave it alone -- is
    // decided by packet-clock.js. It is the part of this sweep with teeth (it
    // emails families and closes them out), and keeping it out here, wrapped
    // in a SignNow call, meant it could only ever be tested by copying it.
    const packetClient = await dbGet("SELECT * FROM clients WHERE id = ?", [packet.client_id]);
    const step = packetSweepStep({ packet, client: packetClient, now });

    if (step.action === "hold") {
      if (step.startPause) {
        await dbRun("UPDATE enrollment_packets SET paused_since = ? WHERE id = ?", [nowISO(), packet.id]);
      }
      continue;
    }

    // Time spent held is banked before anything else acts on the packet's age.
    if (step.bankMs !== null) {
      await dbRun("UPDATE enrollment_packets SET paused_since = NULL, paused_ms = ? WHERE id = ?", [step.bankMs, packet.id]);
      packet.paused_ms = step.bankMs;
      packet.paused_since = null;
    }

    if (step.action === "expire") {
      const client = packetClient;
      if (client && client.stage !== "not_moving_forward" && client.stage !== "discharged") {
        await dbRun(
          "UPDATE clients SET stage = 'not_moving_forward', discharge_reason = ?, updated_at = ? WHERE id = ?",
          ["Enrollment packet not completed within 7 days", nowISO(), client.id]
        );
      }
      await dbRun("UPDATE enrollment_packets SET status = 'expired' WHERE id = ?", [packet.id]);
      continue;
    }

    if (step.action === "remind") {
      const client = packetClient;
      if (client && client.parent_email) {
        const template = await emailTemplates.getEmailTemplate("enrollment_packet_reminder");
        const fields = { parent_name: client.parent_name, child_name: client.child_name };
        sendEmail({
          to: client.parent_email,
          subject: emailTemplates.renderMergeFields(template.subject_template, fields),
          html: emailTemplates.renderMergeFields(template.body_template, fields),
          clientId: client.id,
          type: "enrollment_packet_reminder",
        }).catch((e) => console.error("sendEmail failed:", e));
      }
      await dbRun(
        "UPDATE enrollment_packets SET last_reminder_at = ?, reminder_count = reminder_count + 1 WHERE id = ?",
        [nowISO(), packet.id]
      );
    }
  }
}

// Run shortly after boot (gives Postgres/schema time to be ready), then
// hourly forever after. Each packet's own timestamps -- not server uptime
// -- determine what's actually due, so this is safe across redeploys/restarts.
setTimeout(() => {
  checkEnrollmentPackets().catch((e) => console.error("checkEnrollmentPackets failed:", e));
  retryFailedEnrollmentPackets().catch((e) => console.error("retryFailedEnrollmentPackets failed:", e));
  ot.reminderSweep().catch((e) => console.error("OT reminderSweep failed:", e));
  attendance.dailySweep().catch((e) => console.error("Attendance dailySweep failed:", e));
  geoMap.geocodeSweep().catch((e) => console.error("Geo geocodeSweep failed:", e));
}, 30 * 1000);
setInterval(() => {
  checkEnrollmentPackets().catch((e) => console.error("checkEnrollmentPackets failed:", e));
  retryFailedEnrollmentPackets().catch((e) => console.error("retryFailedEnrollmentPackets failed:", e));
  ot.reminderSweep().catch((e) => console.error("OT reminderSweep failed:", e));
  attendance.dailySweep().catch((e) => console.error("Attendance dailySweep failed:", e));
  geoMap.geocodeSweep().catch((e) => console.error("Geo geocodeSweep failed:", e));
}, 60 * 60 * 1000);

// ============================== AUTHORIZATION ALERTS ==============================
// server/authAlerts.js
// Tracks each client's insurance authorization window and fires escalating
// internal + email alerts as the expiration date approaches, so nobody
// discovers an authorization has lapsed by accident.
"use strict";

const AUTH_MILESTONES = [60, 30, 14, 7, 0]; // days-before-expiration thresholds
const AUTH_ALERT_LEVELS = { 60: "informational", 30: "attention", 14: "urgent", 7: "critical", 0: "overdue" };
const APP_BASE_URL = (process.env.APP_BASE_URL || "https://crm.spectrumsquadlv.com").replace(/\/$/, "");

// Roles allowed to view authorization/insurance fields at all. Any role not
// in this list (e.g. intake, scheduling, and any future RBT login) never
// receives these fields in API responses -- least-privilege by default.
// "owner" and "super_admin" were missing here while being present in every
// other role list in the app, so the business owner's own account was the one
// login that could not see authorization data -- sanitizeClientForRole strips
// those fields, which would have blanked the auth section of every client card
// and left the dashboard's expiry counts empty. Restored to match.
const AUTH_VIEW_ROLES = ["owner", "super_admin", "admin", "billing", "clinical"];
// Roles allowed to fully create/edit authorization fields + manage alerts.
const AUTH_EDIT_ROLES = ["owner", "super_admin", "admin", "billing"];

const AUTH_FIELDS = [
  "insurance_payer",
  "auth_start_date",
  "auth_expiration_date",
  "treatment_plan_submitted_date",
  "authorization_approved_date",
  "assigned_bcba_name",
  "assigned_bcba_email",
  "assigned_billing_name",
  "assigned_billing_email",
  "authorization_status",
  "auth_notes",
];

function initialsOf(name) {
  return (name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase())
    .join("");
}

// Whole days remaining until `dateStr` (negative once past). Null if no date.
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exp = new Date(dateStr);
  if (isNaN(exp)) return null;
  exp.setHours(0, 0, 0, 0);
  return Math.round((exp - today) / 86400000);
}

function canViewAuth(user) {
  return !!user && AUTH_VIEW_ROLES.includes(user.role);
}
function canEditAuth(user) {
  return !!user && AUTH_EDIT_ROLES.includes(user.role);
}

// Strips authorization/insurance fields from a client row for roles that
// shouldn't see them (e.g. intake, scheduling -- and any future RBT login).
function sanitizeClientForRole(user, client) {
  if (!client) return client;
  if (canViewAuth(user)) return client;
  const copy = { ...client };
  for (const f of AUTH_FIELDS) delete copy[f];
  return copy;
}

async function logAuthAudit(clientId, alertId, action, actor, previousValue, newValue, detail) {
  await dbRun(
    `INSERT INTO auth_audit_log (client_id, alert_id, action, actor, previous_value, new_value, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [clientId, alertId, action, actor || "system", previousValue ?? null, newValue ?? null, detail ?? null, nowISO()]
  );
}

async function authAlertEmailContent(client, milestone, daysRemaining) {
  const initials = initialsOf(client.child_name);
  let milestoneLabel;
  if (milestone === 0) {
    milestoneLabel = daysRemaining < 0 ? "Expired" : "Expires Today";
  } else {
    milestoneLabel = `Expiring in ${milestone} Days`;
  }
  const link = `${APP_BASE_URL}/#/pipeline/${client.id}`;
  const template = await emailTemplates.getEmailTemplate("auth_alert");
  const fields = {
    initials,
    milestone_label: milestoneLabel,
    insurance_payer: client.insurance_payer || "—",
    auth_expiration_date: client.auth_expiration_date || "—",
    days_remaining: daysRemaining,
    assigned_bcba_name: client.assigned_bcba_name || "—",
    authorization_status: client.authorization_status || "—",
    client_link: link,
  };
  return {
    subject: emailTemplates.renderMergeFields(template.subject_template, fields),
    html: emailTemplates.renderMergeFields(template.body_template, fields),
  };
}

// The daily (and manually-triggerable) sweep: finds every client whose
// authorization needs a milestone alert, creates the internal alert record
// (once -- duplicates are prevented per client+milestone+expiration date),
// and emails the assigned BCBA, assigned billing contact, and admin/leadership.
async function checkAuthExpirations() {
  const clients = await dbAll(
    "SELECT * FROM clients WHERE authorization_status != 'Not Required' AND auth_expiration_date IS NOT NULL"
  );
  let created = 0;
  for (const client of clients) {
    const daysRemaining = daysUntil(client.auth_expiration_date);
    if (daysRemaining === null) continue;

    for (const milestone of AUTH_MILESTONES) {
      if (daysRemaining > milestone) continue;

      const existing = await dbGet(
        "SELECT id FROM auth_alerts WHERE client_id = ? AND milestone_days = ? AND expiration_snapshot = ?",
        [client.id, milestone, client.auth_expiration_date]
      );
      if (existing) continue; // duplicate prevention: never re-create/re-email this milestone

      const alertLevel = AUTH_ALERT_LEVELS[milestone];
      const row = await dbGet(
        `INSERT INTO auth_alerts (client_id, milestone_days, alert_level, expiration_snapshot, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?) RETURNING id`,
        [client.id, milestone, alertLevel, client.auth_expiration_date, nowISO(), nowISO()]
      );
      created++;
      await logAuthAudit(
        client.id,
        row.id,
        "alert_created",
        "system",
        null,
        String(milestone),
        `${milestone}-day milestone alert created (level: ${alertLevel})`
      );

      // Resolve the owner notification recipient: a configured setting wins,
      // else the real owner mailbox (never the dead seeded admin@ account).
      let ownerNotify = await getAppSetting("owner_notification_email", "");
      if (!ownerNotify) {
        const o = await dbGet("SELECT email FROM users WHERE role = 'owner' AND email <> 'admin@spectrumsquadlv.com' ORDER BY id LIMIT 1");
        ownerNotify = (o && o.email) || process.env.AUTH_ALERT_ADMIN_EMAIL || "";
      }
      const recipients = [
        client.assigned_bcba_email,
        client.assigned_billing_email,
        ownerNotify,
      ].filter(Boolean);
      const uniqueRecipients = [...new Set(recipients.map((r) => r.trim().toLowerCase()))];

      let overallStatus;
      if (uniqueRecipients.length === 0) {
        overallStatus = "not_configured";
        await logAuthAudit(
          client.id,
          row.id,
          "email_skipped",
          "system",
          null,
          null,
          "No recipient emails configured (assigned BCBA / billing / admin all blank)"
        );
      } else {
        const { subject, html } = await authAlertEmailContent(client, milestone, daysRemaining);
        const results = [];
        for (const to of uniqueRecipients) {
          const r = await sendEmail({ to, subject, html, clientId: client.id, type: "auth_alert" }).catch((e) => ({
            delivered: "failed",
            errorMsg: e.message,
          }));
          results.push(r.delivered);
          await logAuthAudit(
            client.id,
            row.id,
            "email_sent",
            "system",
            null,
            to,
            `Delivery: ${r.delivered}${r.errorMsg ? " - " + r.errorMsg : ""}`
          );
        }
        if (results.every((r) => r === "sent")) overallStatus = "sent";
        else if (results.some((r) => r === "sent")) overallStatus = "partial";
        else if (results.every((r) => r === "simulated")) overallStatus = "simulated";
        else overallStatus = "failed";
      }

      await dbRun("UPDATE auth_alerts SET email_sent = ?, email_sent_at = ?, email_recipients = ? WHERE id = ?", [
        overallStatus,
        nowISO(),
        uniqueRecipients.join(", "),
        row.id,
      ]);
    }
  }
  return created;
}

const authAlerts = {
  AUTH_MILESTONES,
  AUTH_ALERT_LEVELS,
  AUTH_FIELDS,
  initialsOf,
  daysUntil,
  canViewAuth,
  canEditAuth,
  sanitizeClientForRole,
  logAuthAudit,
  checkAuthExpirations,
};

// ============================== ENCRYPTION ==============================
// server/encryption.js
// Encrypts secrets (currently: the ClickUp Personal API Token) at rest using
// AES-256-GCM. The key is derived from CLICKUP_ENCRYPTION_KEY (set this in
// Railway's environment variables -- never commit it to source control). If
// it's not set, a random key is generated at boot as a safe fallback so the
// app doesn't crash, but any token saved before a real key is configured
// will stop decrypting after a restart and will need to be re-entered once
// CLICKUP_ENCRYPTION_KEY is set (documented in the setup instructions).
"use strict";

const ENCRYPTION_KEY_RAW = process.env.CLICKUP_ENCRYPTION_KEY || "";
if (!ENCRYPTION_KEY_RAW) {
  console.warn(
    "WARNING: CLICKUP_ENCRYPTION_KEY is not set. Using a random ephemeral key -- " +
      "the saved ClickUp token will need to be re-entered after every restart until " +
      "you set CLICKUP_ENCRYPTION_KEY in Railway's environment variables."
  );
}
const ENCRYPTION_KEY = ENCRYPTION_KEY_RAW
  ? crypto.createHash("sha256").update(ENCRYPTION_KEY_RAW).digest()
  : crypto.randomBytes(32);

function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encrypted: encrypted.toString("hex"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

function decryptSecret(encryptedHex, ivHex, authTagHex) {
  if (!encryptedHex || !ivHex || !authTagHex) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedHex, "hex")), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (e) {
    return null; // key rotated/mismatched, or corrupted -- treat as "not configured"
  }
}

// ============================== CLICKUP INTEGRATION ==============================
// server/clickupIntegration.js
// Read-only, one-directional integration (ClickUp -> CRM): pulls billing,
// credentialing, and authorization-related tasks from a ClickUp workspace
// managed by an external billing company, so leadership gets an executive
// summary inside the CRM without logging into ClickUp all day. This module
// never writes back to ClickUp.
"use strict";

const CLICKUP_API_BASE = "https://api.clickup.com/api/v2";

// Mirrors the existing Authorization Alerts permission model: admin + billing
// + clinical (BCBA) can view financial data; only admin + billing can edit
// records or trigger a sync; only admin can change API credentials/workspace
// config. Any other role (intake, scheduling -- and any future RBT login)
// gets no access at all, per the spec's "RBTs: No access" requirement.
// Financials (including the Financial Center / ClickUp billing integration)
// are private to the business owner. Only the Owner and a co-owner Super Admin
// may view, edit, or administer any of it -- every other role is fully locked out.
const FINANCIAL_VIEW_ROLES = ["owner", "super_admin"];
const FINANCIAL_EDIT_ROLES = ["owner", "super_admin"];
const FINANCIAL_ADMIN_ROLES = ["owner", "super_admin"];

function canViewFinancial(user) {
  return !!user && FINANCIAL_VIEW_ROLES.includes(user.role);
}
function canEditFinancial(user) {
  return !!user && FINANCIAL_EDIT_ROLES.includes(user.role);
}
function canAdminFinancial(user) {
  return !!user && FINANCIAL_ADMIN_ROLES.includes(user.role);
}

async function logFinancialAudit(actor, action, detail) {
  await dbRun("INSERT INTO financial_audit_log (actor, action, detail, created_at) VALUES (?, ?, ?, ?)", [
    actor || "system",
    action,
    detail ?? null,
    nowISO(),
  ]);
}

async function getConfig() {
  return dbGet("SELECT * FROM clickup_config WHERE id = 1");
}

// Server-side only -- includes the decrypted token. Never return this
// directly from an API route; use getConfigStatus() for that.
async function getConfigWithToken() {
  const row = await getConfig();
  if (!row) return null;
  const token = decryptSecret(row.encrypted_token, row.token_iv, row.token_auth_tag);
  return { ...row, token };
}

// Safe-to-return-to-the-frontend view: never includes the raw or encrypted token.
async function getConfigStatus() {
  const row = await getConfig();
  if (!row || !row.encrypted_token) {
    return {
      configured: false,
      workspace_id: null,
      space_id: null,
      folder_id: null,
      list_ids: null,
      connection_status: "disconnected",
    };
  }
  return {
    configured: true,
    workspace_id: row.workspace_id,
    space_id: row.space_id,
    folder_id: row.folder_id,
    list_ids: row.list_ids,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
    connection_status: row.last_connection_status || "disconnected",
  };
}

async function saveConfig({ token, workspace_id, space_id, folder_id, list_ids }, actor) {
  const existing = await getConfig();
  let encFields = {};
  if (token) {
    const { encrypted, iv, authTag } = encryptSecret(token);
    encFields = { encrypted_token: encrypted, token_iv: iv, token_auth_tag: authTag };
  }
  if (existing) {
    await dbRun(
      `UPDATE clickup_config SET
         encrypted_token = COALESCE(?, encrypted_token),
         token_iv = COALESCE(?, token_iv),
         token_auth_tag = COALESCE(?, token_auth_tag),
         workspace_id = ?, space_id = ?, folder_id = ?, list_ids = ?,
         updated_by = ?, updated_at = ?
       WHERE id = 1`,
      [
        encFields.encrypted_token || null,
        encFields.token_iv || null,
        encFields.token_auth_tag || null,
        workspace_id ?? existing.workspace_id,
        space_id ?? existing.space_id,
        folder_id ?? existing.folder_id,
        list_ids ?? existing.list_ids,
        actor,
        nowISO(),
      ]
    );
  } else {
    await dbRun(
      `INSERT INTO clickup_config (id, encrypted_token, token_iv, token_auth_tag, workspace_id, space_id, folder_id, list_ids, updated_by, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        encFields.encrypted_token || null,
        encFields.token_iv || null,
        encFields.token_auth_tag || null,
        workspace_id || null,
        space_id || null,
        folder_id || null,
        list_ids || null,
        actor,
        nowISO(),
      ]
    );
  }
  await logFinancialAudit(
    actor,
    "config_saved",
    `workspace=${workspace_id || "-"} space=${space_id || "-"} folder=${folder_id || "-"} lists=${list_ids || "-"}${
      token ? " (token updated)" : ""
    }`
  );
}

async function setConnectionStatus(status) {
  await dbRun("UPDATE clickup_config SET last_connection_status = ? WHERE id = 1", [status]).catch(() => {});
}

// Calls ClickUp's GET /team endpoint (lightweight -- works with any valid
// Personal API Token regardless of workspace/space/list configuration) to
// verify the token itself is valid before attempting a full sync.
async function testConnection(actor) {
  const config = await getConfigWithToken();
  if (!config || !config.token) {
    return { ok: false, status: "disconnected", detail: "No API token configured yet." };
  }
  try {
    const res = await fetch(`${CLICKUP_API_BASE}/team`, { headers: { Authorization: config.token } });
    if (res.status === 401) {
      await setConnectionStatus("connection_failed");
      await logFinancialAudit(actor, "test_connection", "Failed: invalid token (401 Unauthorized)");
      return { ok: false, status: "connection_failed", detail: "ClickUp rejected the API token (401 Unauthorized). Double-check the Personal API Token." };
    }
    if (!res.ok) {
      await setConnectionStatus("connection_failed");
      await logFinancialAudit(actor, "test_connection", `Failed: HTTP ${res.status}`);
      return { ok: false, status: "connection_failed", detail: `ClickUp API returned HTTP ${res.status}.` };
    }
    const data = await res.json();
    const teamNames = (data.teams || []).map((t) => t.name).join(", ") || "none";
    await setConnectionStatus("connected");
    await logFinancialAudit(actor, "test_connection", `Success: token valid, workspaces visible: ${teamNames}`);
    return { ok: true, status: "connected", detail: `Connected. Workspaces visible to this token: ${teamNames}.` };
  } catch (e) {
    await setConnectionStatus("connection_failed");
    await logFinancialAudit(actor, "test_connection", `Failed: ${e.message}`);
    return { ok: false, status: "connection_failed", detail: `Network error contacting ClickUp: ${e.message}` };
  }
}

// ---- Task category mapping (admin-customizable) ----
async function getCategoryMappings() {
  return dbAll("SELECT * FROM clickup_category_mappings ORDER BY list_name, list_id");
}

async function saveCategoryMapping({ list_id, list_name, category }, actor) {
  const existing = await dbGet("SELECT * FROM clickup_category_mappings WHERE list_id = ?", [list_id]);
  if (existing) {
    await dbRun("UPDATE clickup_category_mappings SET list_name = ?, category = ?, updated_at = ? WHERE list_id = ?", [
      list_name || existing.list_name,
      category,
      nowISO(),
      list_id,
    ]);
  } else {
    await dbRun(
      "INSERT INTO clickup_category_mappings (list_id, list_name, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [list_id, list_name || null, category, nowISO(), nowISO()]
    );
  }
  await logFinancialAudit(actor, "category_mapping_saved", `list ${list_id} -> ${category}`);
}

async function categoryForList(listId) {
  const row = await dbGet("SELECT category FROM clickup_category_mappings WHERE list_id = ?", [listId]);
  return row ? row.category : "Uncategorized";
}

// ---- Sync engine ----
// One-directional, read-only: pulls tasks from every configured List ID,
// upserts into clickup_tasks keyed by clickup_task_id (this is what prevents
// duplicate records on every 15-minute re-sync), and always writes a row to
// clickup_sync_log -- success or failure -- so Last Sync / Next Sync / Last
// Successful Sync / Errors can always be shown accurately.
async function syncNow(triggeredBy = "scheduled") {
  const startedAt = nowISO();
  const logRow = await dbGet(
    "INSERT INTO clickup_sync_log (started_at, status, triggered_by) VALUES (?, 'running', ?) RETURNING id",
    [startedAt, triggeredBy]
  );

  const config = await getConfigWithToken();
  if (!config || !config.token) {
    await dbRun("UPDATE clickup_sync_log SET finished_at = ?, status = 'failed', error = ? WHERE id = ?", [
      nowISO(),
      "No ClickUp API token configured yet",
      logRow.id,
    ]);
    return { ok: false, error: "No ClickUp API token configured yet" };
  }

  const listIds = (config.list_ids || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!listIds.length) {
    await dbRun("UPDATE clickup_sync_log SET finished_at = ?, status = 'failed', error = ? WHERE id = ?", [
      nowISO(),
      "No List IDs configured to sync yet",
      logRow.id,
    ]);
    return { ok: false, error: "No List IDs configured to sync yet" };
  }

  let created = 0;
  let updated = 0;
  let totalSeen = 0;
  const errors = [];

  for (const listId of listIds) {
    try {
      const res = await fetch(`${CLICKUP_API_BASE}/list/${listId}/task?include_closed=true`, {
        headers: { Authorization: config.token },
      });
      if (!res.ok) {
        errors.push(`List ${listId}: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const tasks = data.tasks || [];
      const category = await categoryForList(listId);
      for (const t of tasks) {
        totalSeen++;
        const existing = await dbGet("SELECT id FROM clickup_tasks WHERE clickup_task_id = ?", [t.id]);
        const fields = [
          (t.list && t.list.id) || listId,
          t.name || null,
          (t.status && t.status.status) || null,
          category,
          (t.assignees || []).map((a) => a.username).join(", ") || null,
          t.due_date ? new Date(Number(t.due_date)).toISOString() : null,
          t.date_created ? new Date(Number(t.date_created)).toISOString() : null,
          t.date_closed ? new Date(Number(t.date_closed)).toISOString() : null,
          t.url || null,
          JSON.stringify(t),
        ];
        if (existing) {
          await dbRun(
            `UPDATE clickup_tasks SET list_id=?, name=?, status=?, category=?, assignee=?, due_date=?, date_created=?, date_closed=?, url=?, raw_json=?, last_synced_at=?
             WHERE clickup_task_id = ?`,
            [...fields, nowISO(), t.id]
          );
          updated++;
        } else {
          await dbRun(
            `INSERT INTO clickup_tasks (clickup_task_id, list_id, name, status, category, assignee, due_date, date_created, date_closed, url, raw_json, first_synced_at, last_synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [t.id, ...fields, nowISO(), nowISO()]
          );
          created++;
        }
      }
    } catch (e) {
      errors.push(`List ${listId}: ${e.message}`);
    }
  }

  const failedEntirely = errors.length > 0 && created + updated === 0 && totalSeen === 0;
  const status = failedEntirely ? "failed" : "success";
  await dbRun(
    "UPDATE clickup_sync_log SET finished_at = ?, status = ?, tasks_synced = ?, tasks_created = ?, tasks_updated = ?, error = ? WHERE id = ?",
    [nowISO(), status, totalSeen, created, updated, errors.length ? errors.join("; ") : null, logRow.id]
  );
  await setConnectionStatus(failedEntirely ? "connection_failed" : "connected");
  await logFinancialAudit(
    triggeredBy === "manual" ? "manual_sync" : "system",
    "sync_completed",
    `${status}: ${totalSeen} tasks seen, ${created} created, ${updated} updated${errors.length ? `, errors: ${errors.join("; ")}` : ""}`
  );

  return { ok: !failedEntirely, tasksSeen: totalSeen, created, updated, errors };
}

async function getSyncStatus() {
  const last = await dbGet("SELECT * FROM clickup_sync_log ORDER BY id DESC LIMIT 1");
  const lastSuccessful = await dbGet("SELECT * FROM clickup_sync_log WHERE status = 'success' ORDER BY id DESC LIMIT 1");
  const config = await getConfig();
  let nextSync = null;
  if (last && last.finished_at) {
    nextSync = new Date(new Date(last.finished_at).getTime() + 15 * 60 * 1000).toISOString();
  }
  return {
    configured: !!(config && config.encrypted_token),
    lastSync: last
      ? {
          startedAt: last.started_at,
          finishedAt: last.finished_at,
          status: last.status,
          tasksSynced: last.tasks_synced,
          error: last.error,
          triggeredBy: last.triggered_by,
        }
      : null,
    lastSuccessfulSync: lastSuccessful
      ? { finishedAt: lastSuccessful.finished_at, tasksSynced: lastSuccessful.tasks_synced }
      : null,
    nextSync,
  };
}

async function getRecentSyncLogs(limit = 20) {
  return dbAll("SELECT * FROM clickup_sync_log ORDER BY id DESC LIMIT ?", [limit]);
}

const clickupIntegration = {
  canViewFinancial,
  canEditFinancial,
  canAdminFinancial,
  getConfigStatus,
  saveConfig,
  testConnection,
  getCategoryMappings,
  saveCategoryMapping,
  syncNow,
  getSyncStatus,
  getRecentSyncLogs,
  logFinancialAudit,
};

// ============================== ROUTES ==============================
// server/routes.js
// All REST API route handlers, hand-routed (no Express) against Node's http module.
"use strict";

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
  return true; // signals to the caller that the response has been written
}

function sendFile(res, status, buffer, contentType, filename) {
  res.writeHead(status, {
    "Content-Type": contentType || "application/octet-stream",
    "Content-Disposition": `attachment; filename="${encodeURIComponent(filename || "document")}"`,
    "Content-Length": buffer.length,
  });
  res.end(buffer);
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = "";
    req.on("data", (c) => (chunks += c));
    req.on("end", () => {
      if (!chunks) return resolve({});
      try {
        resolve(JSON.parse(chunks));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// Raw request body (unparsed) -- needed for webhook signature verification,
// where the exact bytes must match what the sender signed.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = "";
    req.on("data", (c) => (chunks += c));
    req.on("end", () => resolve(chunks));
    req.on("error", reject);
  });
}
const stripeClient = require("./stripe-client");

const PUBLIC_ROUTES = new Set([
  "/api/stripe/webhook",
  "/api/auth/login",
  "/api/webhook/enrollment",
  "/api/admin/backfill-import",
  "/api/admin/purge-demo",
  "/api/admin/upload-document",
  "/api/admin/delete-document",
]);

const CLIENT_COLOR_PALETTE = ["#5fa8a0", "#e0a430", "#3f56b5", "#3f8f89", "#c98a1b", "#8d85c8"];

// Returns the first existing client whose child_name AND parent_email both
// match (case-insensitive, trim-insensitive) the given values, or undefined.
// Used to dedupe re-imports so we never create duplicates or revive
// discharged/not-moving-forward clients. An empty parent_email never matches.
async function findExistingClientKey(child_name, parent_email) {
  if (!child_name || !parent_email) return undefined;
  return dbGet(
    `SELECT id, stage, child_name FROM clients
     WHERE lower(trim(child_name)) = lower(trim(?))
       AND lower(trim(parent_email)) = lower(trim(?))
     LIMIT 1`,
    [child_name, parent_email]
  );
}

async function createClientFromPayload(c) {
  const color = CLIENT_COLOR_PALETTE[Math.floor(Math.random() * CLIENT_COLOR_PALETTE.length)];
  const submittedAt = nowISO();
  const row = await dbGet(
    `INSERT INTO clients (
      child_name, dob, parent_name, parent_relationship, parent_email, parent_phone,
      address, service_location, school_status, start_urgency, insurance_provider,
      num_insurances, has_asd_diagnosis, has_iep, prior_aba_nv, preferred_contact,
      desired_schedule, rethink_status, color, submitted_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      c.child_name, c.dob || null, c.parent_name || null, c.parent_relationship || null,
      c.parent_email || null, c.parent_phone || null, c.address || null, c.service_location || null,
      c.school_status || null, c.start_urgency || null, c.insurance_provider || null,
      c.num_insurances || null, c.has_asd_diagnosis || null, c.has_iep || null,
      c.prior_aba_nv || null, c.preferred_contact || null, c.desired_schedule || null,
      c.rethink_status || null, color, submittedAt, submittedAt,
    ]
  );
  await pipeline.enterStage(row.id, "new_submission");
  const client = await dbGet("SELECT * FROM clients WHERE id = ?", [row.id]);
  sendEnrollmentPacket(client).catch((e) => console.error("sendEnrollmentPacket failed:", e));
  // Sends only if a card came in with the intake; otherwise it waits for the
  // upload, which triggers it below.
  maybeSendEligibilityCheck(client.id, "system").catch((e) => console.error("eligibility check failed:", e));
  return client;
}

// ---- One-time historical backfill (silent -- no live emails) ----
// Used to import clients who already exist in the real world (from the old
// enrollment spreadsheet) without re-triggering "welcome!" / department
// alert emails for signups that happened months ago.

async function createClientBackfill(c) {
  const color = CLIENT_COLOR_PALETTE[Math.floor(Math.random() * CLIENT_COLOR_PALETTE.length)];
  const submittedAt = c.submitted_at || nowISO();
  const row = await dbGet(
    `INSERT INTO clients (
      child_name, dob, parent_name, parent_relationship, parent_email, parent_phone,
      address, service_location, school_status, start_urgency, insurance_provider,
      num_insurances, has_asd_diagnosis, has_iep, prior_aba_nv, preferred_contact,
      desired_schedule, rethink_status, notes, color, first_day_date, discharge_reason,
      stage, submitted_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      c.child_name, c.dob || null, c.parent_name || null, c.parent_relationship || null,
      c.parent_email || null, c.parent_phone || null, c.address || null, c.service_location || null,
      c.school_status || null, c.start_urgency || null, c.insurance_provider || null,
      c.num_insurances || null, c.has_asd_diagnosis || null, c.has_iep || null,
      c.prior_aba_nv || null, c.preferred_contact || null, c.desired_schedule || null,
      c.rethink_status || null, c.notes || null, color, c.first_day_date || null,
      c.discharge_reason || null, "new_submission", submittedAt, submittedAt,
    ]
  );
  const clientId = row.id;
  await silentFastForward(clientId, c.stage || "new_submission");
  return dbGet("SELECT * FROM clients WHERE id = ?", [clientId]);
}

// Silently walks a client through every stage up to (and including)
// targetStageKey: earlier stages' tasks are marked completed (historical),
// and the target stage's tasks are created as normal pending tasks (so
// overdue tracking + dashboards behave correctly going forward). No emails
// are ever sent by this path.
async function silentFastForward(clientId, targetStageKey) {
  const targetIdx = STAGE_ORDER.indexOf(targetStageKey);
  const idx = targetIdx === -1 ? 0 : targetIdx;

  for (let i = 0; i <= idx; i++) {
    const stageKey = STAGE_ORDER[i];
    const tasks = await dbAll("SELECT * FROM stage_tasks WHERE stage_key = ?", [stageKey]);
    for (const task of tasks) {
      if (i < idx) {
        const ts = nowISO();
        await dbRun(
          `INSERT INTO client_tasks (client_id, stage_task_id, status, due_date, completed_at, created_at)
           VALUES (?, ?, 'completed', ?, ?, ?)`,
          [clientId, task.id, ts, ts, ts]
        );
      } else {
        const dueDate = addBusinessDays(new Date(), task.sla_days).toISOString();
        await dbRun(
          `INSERT INTO client_tasks (client_id, stage_task_id, status, due_date, created_at)
           VALUES (?, ?, 'pending', ?, ?)`,
          [clientId, task.id, dueDate, nowISO()]
        );
      }
    }
  }

  await dbRun("UPDATE clients SET stage = ?, updated_at = ? WHERE id = ?", [targetStageKey, nowISO(), clientId]);
}

// ---- Login throttling -------------------------------------------------
// In-memory only: 10 bad attempts per IP+email pair locks that pair out for
// 15 minutes. Resets on deploy, which is fine -- this is here to stop
// password guessing, not to be an audit trail.
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginAttempts = new Map();

function loginKey(req, email) {
  const fwd = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = fwd || (req.socket && req.socket.remoteAddress) || "unknown";
  return `${ip}|${String(email || "").toLowerCase()}`;
}
function loginLockRemaining(key) {
  const rec = loginAttempts.get(key);
  if (!rec || rec.count < LOGIN_MAX_ATTEMPTS) return 0;
  const left = rec.last + LOGIN_LOCK_MS - Date.now();
  if (left <= 0) { loginAttempts.delete(key); return 0; }
  return Math.ceil(left / 60000);
}
function noteFailedLogin(key) {
  const rec = loginAttempts.get(key) || { count: 0, last: 0 };
  rec.count += 1;
  rec.last = Date.now();
  loginAttempts.set(key, rec);
}
function clearFailedLogins(key) {
  loginAttempts.delete(key);
}
setInterval(() => {
  const cutoff = Date.now() - LOGIN_LOCK_MS;
  for (const [k, v] of loginAttempts) if (v.last < cutoff) loginAttempts.delete(k);
}, LOGIN_LOCK_MS).unref?.();

// Returns true if the route was handled.
async function handle(req, res, pathname, method, query = {}) {
  if (!pathname.startsWith("/api/")) return false;

  const cookies = auth.parseCookies(req);
  const user = await auth.getUserFromToken(cookies.session);

  // Per-user granular module access: if the owner explicitly turned a module OFF
  // for this user, block its API here (public sub-routes are exempt). Absent =
  // role defaults apply, so existing users are unaffected.
  if (user && user.module_access && !pathname.includes("/public")) {
    let ma = null; try { ma = JSON.parse(user.module_access); } catch (e) { ma = null; }
    if (ma) {
      const prefixKey = (
        pathname.startsWith("/api/hr/") ? "hr" :
        pathname.startsWith("/api/ot/") ? "ot" :
        pathname.startsWith("/api/supervision") ? "supervision" :
        pathname.startsWith("/api/fin/") ? "financial-center" :
        pathname.startsWith("/api/leads") ? "leads" :
        pathname.startsWith("/api/policies") ? "policies" :
        pathname.startsWith("/api/geo") ? "map" :
        pathname.startsWith("/api/supply") ? "supply" :
        // Staff attendance is its own section now that it has its own page in
        // the nav, so it gets its own access key instead of borrowing the
        // staff directory's. A grant or a block on "staff" no longer silently
        // decides who can see attendance points and discipline levels.
        pathname.startsWith("/api/attendance") ? "attendance" :
        // The sections below were listed in the Access editor but never
        // enforced server-side, so switching them off only hid the sidebar
        // button -- the data was still reachable by URL.
        pathname.startsWith("/api/clients") ? "pipeline" :
        pathname.startsWith("/api/stages") ? "pipeline" :
        pathname.startsWith("/api/tasks") ? "tasks" :
        pathname.startsWith("/api/staff-tasks") ? "tasks" :
        pathname.startsWith("/api/schedule") ? "schedule" :
        pathname.startsWith("/api/dashboard") ? "dashboard" :
        // The completions feed renders on the dashboard, so it follows the
        // dashboard's access. Its own handler is owner/admin only on top.
        pathname.startsWith("/api/completions") ? "dashboard" :
        pathname.startsWith("/api/signnow-import") ? "admin" :
        pathname.startsWith("/api/notifications") ? "outbox" :
        pathname.startsWith("/api/email-templates") ? "email-templates" :
        pathname.startsWith("/api/failed-emails") ? "failed-emails" :
        pathname.startsWith("/api/auth-alerts") ? "auth-alerts" :
        pathname.startsWith("/api/admin") ? "admin" :
        // People add-on. Certifications live on the staff card and departments
        // are an admin setting, so each follows its host section. Emergency
        // contacts exist on both client and staff records, so they follow
        // whichever record is being asked for -- which is why every call sends
        // owner_type on the query string, not only in the body.
        pathname.startsWith("/api/sched/") ? "schedule" :
        pathname.startsWith("/api/auth-util/") ? "auth-alerts" :
        pathname.startsWith("/api/people/certifications") ? "staff" :
        pathname.startsWith("/api/people/departments") ? "admin" :
        pathname.startsWith("/api/people/emergency-contacts")
          ? (String(query.owner_type || "") === "staff" ? "staff" : "pipeline")
          :
        null
      );
      if (prefixKey && ma[prefixKey] === false) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Your account doesn't have access to this section." }));
        return true;
      }
    }
  }

  // ---- OT-ONLY LOCKDOWN ----
  // OT Admin / OT Staff may only reach OT routes and their own auth/session.
  // This MUST run before the add-on dispatch below: the screener and
  // client-forms modules were being handed the request first, which let an
  // OT-only login read ABA clinical screeners and client financial forms by
  // calling those URLs directly. Public sub-routes (the "/public/" convention
  // every add-on follows, plus the login endpoint) stay reachable so a logged-in
  // OT user can still open a public form link.
  if (user && (user.role === "ot_admin" || user.role === "ot_staff")) {
    const otAllowed =
      pathname.startsWith("/api/ot/") ||
      pathname.startsWith("/api/auth/") ||
      pathname === "/api/logout" ||
      pathname.includes("/public") ||
      PUBLIC_ROUTES.has(pathname);
    if (!otAllowed) {
      json(res, 403, { error: "Not permitted." });
      return true;
    }
  }

  if (pathname.startsWith("/api/screener/")) {
    const handled = await screener.handleApi(req, res, pathname, method, query, user);
    if (handled) return true;
  }

  // HR & Recruiting add-on owns all /api/hr/* routes (it enforces its own
  // public/authenticated split internally, so it is dispatched before the
  // global 401 gate below).
  if (pathname.startsWith("/api/hr/")) {
    const handled = await hr.handleApi(req, res, pathname, method, query, user);
    if (handled) return true;
  }

  // Client-facing forms add-on owns /api/client-forms/* (public + staff split
  // enforced internally), dispatched before the global 401 gate.
  if (pathname.startsWith("/api/client-forms/")) {
    const handled = await clientForms.handleApi(req, res, pathname, method, query, user);
    if (handled) return true;
  }

  // Occupational Therapy add-on owns /api/ot/* (public intake + staff, permission
  // enforced internally), dispatched before the global 401 gate.
  if (pathname.startsWith("/api/ot/")) {
    const handled = await ot.handleApi(req, res, pathname, method, query, user);
    if (handled) return true;
  }

  // Employee Attendance add-on owns /api/attendance/* (permission enforced
  // internally; a self "/me" endpoint lets an employee read their own standing).
  if (pathname.startsWith("/api/attendance/")) {
    const handled = await attendance.handleApi(req, res, pathname, method, query, user);
    if (handled) return true;
  }

  // Billable requirements add-on owns /api/billable/* (per-BCBA monthly hours
  // targets and the monthly summary email).
  if (pathname.startsWith("/api/billable")) {
    const handled = await billable.handleApi(req, res, pathname, method, query, user);
    if (handled) return true;
  }

  // PTO add-on owns /api/pto/* (accrual and balances; leave taken still lives
  // in staff_time_off, which the scheduler owns).
  if (pathname.startsWith("/api/pto")) {
    const handled = await pto.handleApi(req, res, pathname, method, query, user);
    if (handled) return true;
  }

  // Supply Requests add-on owns /api/supply/* (public submit/track split enforced
  // internally, so it is dispatched before the global 401 gate below).
  if (pathname.startsWith("/api/supervision")) {
    const handled = await supervision.handleApi(req, res, pathname, method, query, user);
    if (handled) return true;
  }

  // Rethink integration status, filter confirmation and manual sync.
  if (pathname.startsWith("/api/rethink")) {
    const handled = await rethink.handleApi(req, res, pathname, method, query, user);
    if (handled) return true;
  }

  if (pathname.startsWith("/api/fin/")) {
    // The ledger module claims only the routes it owns and returns false for
    // the rest, so the original Financial Center routes below still run.
    const ledgerHandled = await finLedger.handleApi(req, res, pathname, method, query, user);
    if (ledgerHandled) return true;
    const handled = await financialAdvisor.handleApi(req, res, pathname, method, query, user);
    if (handled) return true;
  }

  if (pathname.startsWith("/api/bip")) {
    const handled = await bip.handleApi(req, res, pathname, method, query, user);
    if (handled) return true;
  }

  if (pathname.startsWith("/api/grants/")) {
    const handled = await grants.handleApi(req, res, pathname, method, query, user);
    if (handled) return true;
  }

  if (pathname.startsWith("/api/people/")) {
    const handled = await people.handleApi(req, res, pathname, method, query, user);
    if (handled) return true;
  }

  if (pathname.startsWith("/api/signnow-import")) {
    const handled = await signnowImport.handleApi(req, res, pathname, method, query, user);
    if (handled) return true;
  }

  if (pathname.startsWith("/api/completions")) {
    const handled = await completions.handleApi(req, res, pathname, method, query, user);
    if (handled) return true;
  }

  if (pathname.startsWith("/api/onboarding/")) {
    const handled = await onboarding.handleApi(req, res, pathname, method, query, user);
    if (handled) return true;
  }

  if (pathname.startsWith("/api/sched/")) {
    const handled = await scheduling.handleApi(req, res, pathname, method, query, user);
    if (handled) return true;
  }

  if (pathname.startsWith("/api/auth-util/")) {
    const handled = await authorizations.handleApi(req, res, pathname, method, query, user);
    if (handled) return true;
  }

  if (pathname.startsWith("/api/leads") || pathname.startsWith("/api/policies")) {
    const handled = await growth.handleApi(req, res, pathname, method, query, user);
    if (handled) return true;
  }

  // Events owns /api/events/* and enforces its own role tiers internally.
  if (pathname.startsWith("/api/events")) {
    const handled = await events.handleApi(req, res, pathname, method, query, user);
    if (handled) return true;
  }

  if (pathname.startsWith("/api/supply/")) {
    const handled = await supply.handleApi(req, res, pathname, method, query, user);
    if (handled) return true;
  }

  // Clients & Clinicians Map add-on owns /api/geo/* (owner/admin/scheduling only,
  // enforced internally).
  if (pathname.startsWith("/api/geo/")) {
    const handled = await geoMap.handleApi(req, res, pathname, method, query, user);
    if (handled) return true;
  }

  // Email images are embedded in emails opened by parents/staff in their own
  // mail client (no session cookie present), so this one path must stay
  // publicly readable regardless of the generated filename.
  const isPublicEmailImage = pathname.startsWith("/api/email-templates/images/");

  if (!PUBLIC_ROUTES.has(pathname) && !isPublicEmailImage && !user) {
    json(res, 401, { error: "Not authenticated" });
    return true;
  }

  // (The OT-only lockdown now runs above the add-on dispatch, so that OT logins
  // cannot reach add-on routes such as the clinical screener.)

  // ---- CLIENT RECORD LOCK ----
  // Client records are a child's PHI: name, DOB, home address, parent contact
  // and insurance. Previously any logged-in staff member in any role could
  // list, edit, add notes to and upload documents against every family --
  // including HR-side roles (hiring_manager, interviewer) that have no reason
  // to see them. An explicit "pipeline" grant from the Access editor still
  // opens it for a specific person.
  if (/^\/api\/clients(\/|$)/.test(pathname) || /^\/api\/stages(\/|$)/.test(pathname)) {
    if (!canAccessClients(user) && !moduleGranted(user, "pipeline")) {
      json(res, 403, { error: "Not permitted to access client records" });
      return true;
    }
  }

  // ---- MASTER FINANCIAL LOCK (belt-and-suspenders) ----
  // Every financial route — the owner financials, the per-client figures, and
  // the ClickUp Financial Center — is Owner/Super-Admin only, no exceptions.
  // This gate runs BEFORE any individual handler, so even a financial route
  // added later without its own permission check can never expose data to
  // another role. Denied attempts are recorded in the financial audit log.
  {
    const isFinancialPath =
      /^\/api\/financial(\/|$)/.test(pathname) ||
      /^\/api\/owner-financial/.test(pathname) ||
      pathname === "/api/clients/financials-summary" ||
      /^\/api\/clients\/\d+\/financials$/.test(pathname);
    if (isFinancialPath && !canViewFinancial(user)) {
      await logFinancialAudit(
        user ? user.email : "anonymous",
        "financial_access_denied",
        `${method} ${pathname}`
      ).catch(() => {});
      json(res, 403, { error: "Not permitted to access financial data" });
      return true;
    }
  }

  try {
    // ---------- AUTH ----------
    if (pathname === "/api/auth/login" && method === "POST") {
      const { email, password } = await readBody(req);
      const who = loginKey(req, email);
      const lock = loginLockRemaining(who);
      if (lock > 0) {
        return json(res, 429, { error: `Too many failed attempts. Try again in ${lock} minute${lock === 1 ? "" : "s"}.` });
      }
      const result = await auth.login(email || "", password || "");
      if (!result) {
        noteFailedLogin(who);
        return json(res, 401, { error: "Invalid email or password" });
      }
      clearFailedLogins(who);
      // Session-only cookie (no Max-Age/Expires): it is cleared when the
      // browser closes, so providers must re-enter their password each new
      // browser session rather than staying logged in indefinitely.
      res.setHeader(
        "Set-Cookie",
        `session=${result.token}; HttpOnly; Path=/; SameSite=Lax`
      );
      return json(res, 200, { user: result.user });
    }

    if (pathname === "/api/auth/logout" && method === "POST") {
      if (cookies.session) await auth.logout(cookies.session);
      res.setHeader("Set-Cookie", "session=; HttpOnly; Path=/; Max-Age=0");
      return json(res, 200, { ok: true });
    }

    if (pathname === "/api/auth/me" && method === "GET") {
      return json(res, 200, { user });
    }

    // ---------- DASHBOARD ----------
    if (pathname === "/api/dashboard" && method === "GET") {
      const byStage = await dbAll("SELECT stage, COUNT(*) AS n FROM clients GROUP BY stage");
      // Counted over the same population the Tasks & Alerts page shows, so the
      // dashboard number and the list cannot disagree.
      const workedTasks = `FROM client_tasks ct JOIN clients c ON c.id = ct.client_id
         WHERE COALESCE(c.waitlisted, false) = false AND c.stage NOT IN ('discharged','not_moving_forward')`;
      const overdue = (await dbGet(`SELECT COUNT(*) AS n ${workedTasks} AND ct.status = 'overdue'`)).n;
      const pending = (await dbGet(`SELECT COUNT(*) AS n ${workedTasks} AND ct.status = 'pending'`)).n;
      const today = new Date().toISOString().slice(0, 10);
      const upcomingFirstDays = await dbAll(
        "SELECT id, child_name, first_day_date FROM clients WHERE first_day_date IS NOT NULL AND first_day_date >= ? ORDER BY first_day_date LIMIT 5",
        [today]
      );
      const totalClients = (await dbGet("SELECT COUNT(*) AS n FROM clients")).n;
      // The Pipeline Snapshot hides discharged and not-moving-forward clients,
      // so it has to divide by the same population it shows. Dividing live
      // stages by an all-time headcount made every bar read short, and got
      // worse with every client ever closed out.
      const CLOSED = "('discharged','not_moving_forward')";
      const activeClients = Number((await dbGet(`SELECT COUNT(*) AS n FROM clients WHERE stage NOT IN ${CLOSED}`)).n);
      const closedClients = Number(totalClients) - activeClients;
      const waitlistedActive = Number((await dbGet(`SELECT COUNT(*) AS n FROM clients WHERE waitlisted = true AND stage NOT IN ${CLOSED}`)).n);

      // Active-pipeline clients grouped by insurance provider (for the dashboard chart).
      const byInsuranceRaw = await dbAll(
        `SELECT COALESCE(NULLIF(TRIM(insurance_provider), ''), 'Unknown') AS provider, COUNT(*) AS n
           FROM clients
          WHERE stage NOT IN ('discharged','not_moving_forward')
          GROUP BY COALESCE(NULLIF(TRIM(insurance_provider), ''), 'Unknown')
          ORDER BY n DESC`
      );
      const byInsurance = byInsuranceRaw.map((r) => ({ provider: r.provider, n: Number(r.n) }));

      let authCounts = null;
      if (authAlerts.canViewAuth(user)) {
        // Discharged and not-moving-forward clients are excluded: an expired
        // authorization for a family who left is not a problem anyone can
        // act on, and leaving them in made the dashboard's expiry counts
        // permanently overstated.
        const activeAuths = await dbAll(
          `SELECT auth_expiration_date FROM clients
            WHERE authorization_status != 'Not Required'
              AND auth_expiration_date IS NOT NULL
              AND stage NOT IN ${CLOSED}`
        );
        // Cumulative buckets: a client 5 days out counts toward every window
        // it falls within (≤60, ≤30, ≤14, ≤7), matching "expiring within X
        // days" as plain English reads. Already-expired is its own bucket.
        authCounts = { d60: 0, d30: 0, d14: 0, d7: 0, expired: 0 };
        for (const row of activeAuths) {
          const d = authAlerts.daysUntil(row.auth_expiration_date);
          if (d === null) continue;
          if (d < 0) {
            authCounts.expired++;
            continue;
          }
          if (d <= 60) authCounts.d60++;
          if (d <= 30) authCounts.d30++;
          if (d <= 14) authCounts.d14++;
          if (d <= 7) authCounts.d7++;
        }
      }

      // Supervision widget (owner/admin/clinical see it on the dashboard).
      let supervisionWidget = null;
      try {
        if (["owner", "super_admin", "admin", "hr_admin", "clinical"].includes(user && user.role)) {
          supervisionWidget = await supervision.widget();
        }
      } catch (e) { /* non-fatal */ }

      return json(res, 200, {
        byStage,
        overdue,
        pending,
        upcomingFirstDays,
        totalClients,
        activeClients,
        closedClients,
        waitlistedActive,
        stages: pipeline.STAGES,
        byInsurance,
        authCounts,
        supervision: supervisionWidget,
      });
    }

    // ---------- STAGES / DEPARTMENTS ----------
    if (pathname === "/api/stages" && method === "GET") {
      return json(res, 200, pipeline.STAGES);
    }

    if (pathname === "/api/departments" && method === "GET") {
      return json(res, 200, await dbAll("SELECT * FROM departments"));
    }

    // ---------- CLIENTS ----------
    if (pathname === "/api/clients" && method === "GET") {
      const clients = await dbAll("SELECT * FROM clients ORDER BY submitted_at DESC");
      return json(res, 200, clients.map((c) => authAlerts.sanitizeClientForRole(user, c)));
    }

    if (pathname === "/api/clients" && method === "POST") {
      const c = await readBody(req);
      const client = await createClientFromPayload(c);
      return json(res, 201, client);
    }

    // Stripe webhook (public, signature-verified). Point your Stripe dashboard
    // webhook here and set STRIPE_WEBHOOK_SECRET. Reads the RAW body so the
    // signature can be verified, then updates only the contract's safe payment
    // fields (status, brand + last4, amounts) -- never any sensitive data.
    if (pathname === "/api/stripe/webhook" && method === "POST") {
      const raw = await readRawBody(req);
      let event;
      try { event = stripeClient.verifyWebhook(raw, req.headers["stripe-signature"]); }
      catch (e) { return json(res, 400, { error: e.message }); }
      const r = await growth.applyStripeEvent(event).catch((e) => ({ ok: false, error: e.message }));
      return json(res, 200, r);
    }

    // Public webhook: point a Google Apps Script "on form submit" trigger (or
    // your website's enrollment form) at this endpoint to feed new signups
    // straight into the pipeline, with no manual re-entry. Protect it with
    // WEBHOOK_SECRET in .env once you're live.
    if (pathname === "/api/webhook/enrollment" && method === "POST") {
      const secret = process.env.WEBHOOK_SECRET;
      if (secret && req.headers["x-webhook-secret"] !== secret) {
        return json(res, 401, { error: "Invalid webhook secret" });
      }
      const c = await readBody(req);
      if (!c.child_name || !c.parent_email) {
        return json(res, 400, { error: "child_name and parent_email are required" });
      }
      // Dedupe: never re-create or revive an existing client (any stage,
      // including discharged / not_moving_forward). No emails are sent.
      const existing = await findExistingClientKey(c.child_name, c.parent_email);
      if (existing) {
        return json(res, 200, {
          skipped: true,
          reason: "duplicate",
          existing_id: existing.id,
          existing_stage: existing.stage,
        });
      }
      const client = await createClientFromPayload(c);
      return json(res, 201, client);
    }

    // One-time historical import: creates clients silently (no live emails)
    // at whatever real-world stage they're already at. Protected by
    // ADMIN_IMPORT_SECRET -- set that env var only while running an import,
    // then remove/rotate it.
    if (pathname === "/api/admin/backfill-import" && method === "POST") {
      const secret = process.env.ADMIN_IMPORT_SECRET;
      if (!secret || req.headers["x-admin-secret"] !== secret) {
        return json(res, 401, { error: "Invalid admin secret" });
      }
      const body = await readBody(req);
      const list = Array.isArray(body.clients) ? body.clients : [];
      const results = [];
      let skippedDuplicates = 0;
      for (const c of list) {
        if (!c.child_name) continue;
        // Dedupe: skip records that already exist (any stage). Existing rows
        // are left untouched -- never revived or modified.
        const existing = await findExistingClientKey(c.child_name, c.parent_email);
        if (existing) {
          skippedDuplicates++;
          continue;
        }
        const client = await createClientBackfill(c);
        results.push({ id: client.id, child_name: client.child_name, stage: client.stage });
      }
      return json(res, 201, { imported: results.length, skipped_duplicates: skippedDuplicates, results });
    }

    // One-time cleanup helper: removes synthetic demo/test clients
    // (identified by a parent_email ending in @example.com), along with any
    // related rows across every table that references a client, once real
    // data has been imported or QA testing is done. Protected by the same
    // ADMIN_IMPORT_SECRET as the backfill route above.
    if (pathname === "/api/admin/purge-demo" && method === "POST") {
      const secret = process.env.ADMIN_IMPORT_SECRET;
      if (!secret || req.headers["x-admin-secret"] !== secret) {
        return json(res, 401, { error: "Invalid admin secret" });
      }
      const demo = await dbAll("SELECT id FROM clients WHERE parent_email LIKE '%@example.com'");
      const ids = demo.map((r) => r.id);
      for (const clientId of ids) {
        await dbRun("DELETE FROM client_tasks WHERE client_id = ?", [clientId]);
        await dbRun("DELETE FROM schedule_sessions WHERE client_id = ?", [clientId]);
        await dbRun("DELETE FROM notifications_log WHERE client_id = ?", [clientId]);
        await dbRun("DELETE FROM client_documents WHERE client_id = ?", [clientId]);
        await dbRun("DELETE FROM auth_audit_log WHERE client_id = ?", [clientId]);
        await dbRun("DELETE FROM auth_alerts WHERE client_id = ?", [clientId]);
        await dbRun("DELETE FROM clients WHERE id = ?", [clientId]);
      }
      const remaining = (await dbGet("SELECT COUNT(*) AS n FROM clients")).n;
      return json(res, 200, { purged: ids.length, remainingClients: remaining });
    }

    // One-time/ongoing document import: accepts EITHER base64 file content
    // (hosted on the Railway volume) OR an external_url (e.g. a Google Drive
    // link), and attaches it to a client record. Protected by the same
    // ADMIN_IMPORT_SECRET as the routes above.
    if (pathname === "/api/admin/upload-document" && method === "POST") {
      const secret = process.env.ADMIN_IMPORT_SECRET;
      if (!secret || req.headers["x-admin-secret"] !== secret) {
        return json(res, 401, { error: "Invalid admin secret" });
      }
      const body = await readBody(req);
      const { client_id, label, filename, mime_type, content_base64, external_url } = body;
      if (!client_id || !filename) {
        return json(res, 400, { error: "client_id and filename are required" });
      }
      if (!content_base64 && !external_url) {
        return json(res, 400, { error: "content_base64 or external_url is required" });
      }
      // Same storage, same card/diagnosis detection and same eligibility
      // trigger as the client card and the parent's upload link. The importer
      // keeps its one extra rule: an image with no other signal is treated as
      // the card, because a bulk import of phone photos is exactly that.
      const result = await saveClientDocument({
        client_id,
        label,
        filename,
        mime_type,
        content_base64,
        external_url,
        is_insurance_card: body.is_insurance_card === true
          || looksLikeInsuranceCard({ label, filename })
          || (!!content_base64 && /^image\//i.test(String(mime_type || ""))),
        actor: (user && user.email) || "import",
      });
      if (!result.ok) return json(res, result.status || 400, { error: result.error });
      return json(res, 201, result.document);
    }

    // Removes a single document row (and its file on disk, if hosted).
    // Protected by the same ADMIN_IMPORT_SECRET as the routes above.
    if (pathname === "/api/admin/delete-document" && method === "POST") {
      const secret = process.env.ADMIN_IMPORT_SECRET;
      if (!secret || req.headers["x-admin-secret"] !== secret) {
        return json(res, 401, { error: "Invalid admin secret" });
      }
      const { document_id } = await readBody(req);
      if (!document_id) return json(res, 400, { error: "document_id is required" });
      const doc = await dbGet("SELECT * FROM client_documents WHERE id = ?", [document_id]);
      if (!doc) return json(res, 404, { error: "Not found" });
      if (doc.doc_type === "hosted" && doc.file_path) {
        const fullPath = path.join(DOCS_DIR, doc.file_path);
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      }
      await dbRun("DELETE FROM client_documents WHERE id = ?", [document_id]);
      return json(res, 200, { ok: true });
    }

    const downloadDocMatch = pathname.match(/^\/api\/documents\/(\d+)\/download$/);
    if (downloadDocMatch && method === "GET") {
      // These are client records, and since the SignNow import copies signed
      // enrollment packets in, some of them carry SSNs and insurance cards.
      // Being logged in was the only requirement here before, which meant any
      // staff account could pull any family's packet. Same gate as the client
      // records themselves now, and every view is written down -- if PHI is
      // going to live in two systems, the second one should at least be able
      // to say who opened it.
      if (!canAccessClients(user)) return json(res, 403, { error: "Not permitted to view client documents" });
      const doc = await dbGet("SELECT * FROM client_documents WHERE id = ?", [downloadDocMatch[1]]);
      if (!doc) return json(res, 404, { error: "Not found" });
      await dbRun(
        `INSERT INTO hr_audit_log (actor, action, entity_type, entity_id, detail, created_at)
         VALUES (?, 'client_document_viewed', 'client', ?, ?, ?)`,
        [user.email || user.name || "unknown", doc.client_id, `Opened "${doc.label || doc.filename}"`, nowISO()]
      ).catch((e) => console.error("document view audit failed:", e.message));
      if (doc.doc_type === "link") {
        res.writeHead(302, { Location: doc.external_url });
        res.end();
        return true;
      }
      const fullPath = path.join(DOCS_DIR, doc.file_path);
      if (!fs.existsSync(fullPath)) return json(res, 404, { error: "File missing on disk" });
      const buffer = fs.readFileSync(fullPath);
      return sendFile(res, 200, buffer, doc.mime_type, doc.filename);
    }

    // ---------- AUTHORIZATION ALERTS ----------
    // List alerts, optionally filtered by ?level=informational|attention|urgent|critical|overdue
    // and/or ?status=open|reviewed|renewal_started|completed|reopened|superseded.
    // Only visible to roles that can see authorization data at all.
    if (pathname === "/api/auth-alerts" && method === "GET") {
      if (!authAlerts.canViewAuth(user)) return json(res, 403, { error: "Not permitted to view authorization alerts" });
      const conditions = [];
      const params = [];
      if (query.level) {
        conditions.push("aa.alert_level = ?");
        params.push(query.level);
      }
      if (query.status) {
        conditions.push("aa.status = ?");
        params.push(query.status);
      } else {
        // default view: hide superseded (stale) alerts unless explicitly asked for
        conditions.push("aa.status != 'superseded'");
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = await dbAll(
        `SELECT aa.*, c.child_name, c.insurance_payer, c.assigned_bcba_name, c.assigned_billing_name
         FROM auth_alerts aa
         JOIN clients c ON c.id = aa.client_id
         ${where}
         ORDER BY aa.milestone_days ASC, aa.created_at DESC`,
        params
      );
      const shaped = rows.map((r) => ({
        id: r.id,
        client_id: r.client_id,
        initials: authAlerts.initialsOf(r.child_name),
        insurance_payer: r.insurance_payer,
        expiration_date: r.expiration_snapshot,
        days_remaining: authAlerts.daysUntil(r.expiration_snapshot),
        assigned_bcba_name: r.assigned_bcba_name,
        assigned_billing_name: r.assigned_billing_name,
        milestone_days: r.milestone_days,
        alert_level: r.alert_level,
        status: r.status,
        assigned_to: r.assigned_to,
        email_sent: r.email_sent,
        email_sent_at: r.email_sent_at,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));
      return json(res, 200, shaped);
    }

    const alertStatusMatch = pathname.match(/^\/api\/auth-alerts\/(\d+)\/status$/);
    if (alertStatusMatch && method === "POST") {
      if (!authAlerts.canViewAuth(user)) return json(res, 403, { error: "Not permitted" });
      const alertId = alertStatusMatch[1];
      const { status, assigned_to } = await readBody(req);
      const validStatuses = ["open", "reviewed", "renewal_started", "completed", "reopened"];
      if (!validStatuses.includes(status)) return json(res, 400, { error: "Invalid status" });

      // Clinical (BCBA) users may only move an alert into renewal-in-progress
      // or completed, and may add themselves as the assignee -- everything
      // else (reviewed/reopened/open, or assigning other staff) requires
      // admin or billing.
      if (!authAlerts.canEditAuth(user) && !["renewal_started", "completed"].includes(status)) {
        return json(res, 403, { error: "Only admin/billing can set this status" });
      }

      const alert = await dbGet("SELECT * FROM auth_alerts WHERE id = ?", [alertId]);
      if (!alert) return json(res, 404, { error: "Not found" });

      const fields = ["status = ?"];
      const params = [status];
      if (assigned_to !== undefined) {
        fields.push("assigned_to = ?");
        params.push(assigned_to);
      }
      fields.push("updated_at = ?");
      params.push(nowISO());
      params.push(alertId);
      await dbRun(`UPDATE auth_alerts SET ${fields.join(", ")} WHERE id = ?`, params);

      await authAlerts.logAuthAudit(
        alert.client_id,
        alertId,
        "alert_status_changed",
        user.email,
        alert.status,
        status,
        assigned_to !== undefined ? `Assigned to: ${assigned_to || "—"}` : null
      );
      return json(res, 200, { ok: true });
    }

    const clientAuthAuditMatch = pathname.match(/^\/api\/clients\/(\d+)\/auth-audit$/);
    if (clientAuthAuditMatch && method === "GET") {
      if (!authAlerts.canViewAuth(user)) return json(res, 403, { error: "Not permitted" });
      const rows = await dbAll(
        "SELECT * FROM auth_audit_log WHERE client_id = ? ORDER BY created_at DESC",
        [clientAuthAuditMatch[1]]
      );
      return json(res, 200, rows);
    }

    // Manually trigger the daily authorization-expiration sweep (used for
    // testing, and as a way to get an immediate alert right after entering
    // a new expiration date rather than waiting for the next scheduled run).
    if (pathname === "/api/admin/check-auth-expirations" && method === "POST") {
      if (!authAlerts.canEditAuth(user)) return json(res, 403, { error: "Only admin/billing can run this" });
      const created = await authAlerts.checkAuthExpirations();
      return json(res, 200, { created });
    }

    const authorizationMatch = pathname.match(/^\/api\/clients\/(\d+)\/authorization$/);
    if (authorizationMatch && method === "PATCH") {
      const id = authorizationMatch[1];
      const client = await dbGet("SELECT * FROM clients WHERE id = ?", [id]);
      if (!client) return json(res, 404, { error: "Not found" });

      const body = await readBody(req);
      let allowedFields;
      if (authAlerts.canEditAuth(user)) {
        allowedFields = authAlerts.AUTH_FIELDS;
      } else if (user.role === "clinical") {
        allowedFields = ["auth_notes"]; // BCBAs can add notes only
      } else {
        return json(res, 403, { error: "Not permitted to edit authorization fields" });
      }

      const fields = Object.keys(body).filter((k) => allowedFields.includes(k));
      if (!fields.length) return json(res, 400, { error: "No editable fields provided" });

      // If the expiration date is changing, invalidate not-yet-actioned
      // alerts tied to the old date so stale milestones don't linger, and
      // record the change for audit history. Completed / renewal-in-progress
      // alerts are left alone as historical record.
      if (fields.includes("auth_expiration_date") && body.auth_expiration_date !== client.auth_expiration_date) {
        await dbRun(
          "UPDATE auth_alerts SET status = 'superseded', updated_at = ? WHERE client_id = ? AND status IN ('open','reviewed')",
          [nowISO(), id]
        );
        await authAlerts.logAuthAudit(
          id,
          null,
          "expiration_date_changed",
          user.email,
          client.auth_expiration_date,
          body.auth_expiration_date,
          "Open/reviewed alerts tied to the previous date were superseded"
        );
      }
      for (const f of fields) {
        if (f === "auth_expiration_date") continue; // already logged above with more detail
        if (body[f] !== client[f]) {
          await authAlerts.logAuthAudit(id, null, `${f}_changed`, user.email, client[f], body[f], null);
        }
      }

      // Moving the status INTO "Approved" is what tells the parent they can
      // start. Detected as a transition, not a state, so re-saving the form
      // while already approved never emails the family twice.
      const becameApproved =
        fields.includes("authorization_status") &&
        String(body.authorization_status || "").trim().toLowerCase() === "approved" &&
        String(client.authorization_status || "").trim().toLowerCase() !== "approved";

      const setClause = fields.map((f) => `${f} = ?`).join(", ");
      await dbRun(`UPDATE clients SET ${setClause}, updated_at = ? WHERE id = ?`, [
        ...fields.map((f) => body[f]),
        nowISO(),
        id,
      ]);

      // Stamp the approval date if the office didn't type one in the same save.
      if (becameApproved && !body.authorization_approved_date && !client.authorization_approved_date) {
        await dbRun("UPDATE clients SET authorization_approved_date = ? WHERE id = ?", [todayISODate(), id]);
      }

      const updated = await dbGet("SELECT * FROM clients WHERE id = ?", [id]);

      let approvalEmail = null;
      if (becameApproved) {
        await authAlerts.logAuthAudit(id, null, "authorization_approved", user.email, client.authorization_status,
          "Approved", `Approved on ${updated.authorization_approved_date || todayISODate()}`);
        const r = await sendParentTemplate(updated, "milestone_authorization_approved");
        approvalEmail = r.sent ? { sent: true, to: updated.parent_email } : { sent: false, reason: r.reason };
        completions.record("client_stage_advanced", {
          subject: updated.child_name,
          detail: "Authorization approved",
          clientId: Number(id),
          dedupeKey: `auth_approved:${id}`,
          link: `${APP_BASE_URL}/#/pipeline/${id}`,
        });
      }
      return json(res, 200, { ...authAlerts.sanitizeClientForRole(user, updated), approval_email: approvalEmail });
    }

    const clientMatch = pathname.match(/^\/api\/clients\/(\d+)$/);
    if (clientMatch && method === "GET") {
      const id = clientMatch[1];
      const client = await dbGet("SELECT * FROM clients WHERE id = ?", [id]);
      if (!client) return json(res, 404, { error: "Not found" });
      const tasks = await dbAll(
        `SELECT ct.*, st.label, st.stage_key, st.assignable, d.name AS department_name, d.color AS department_color
         FROM client_tasks ct
         JOIN stage_tasks st ON st.id = ct.stage_task_id
         JOIN departments d ON d.id = st.department_id
         WHERE ct.client_id = ? ORDER BY ct.created_at`,
        [id]
      );
      const sessions = await dbAll(
        `SELECT ss.*, t.name AS therapist_name, t.color AS therapist_color
         FROM schedule_sessions ss JOIN therapists t ON t.id = ss.therapist_id
         WHERE ss.client_id = ?`,
        [id]
      );
      // Communication history is scoped: owner/admin see it for every client,
      // but a staffer only sees the emails for clients they're assigned to.
      const canSeeComms = userAssignedToClient(user, client);
      const notifications = canSeeComms
        ? await dbAll("SELECT * FROM notifications_log WHERE client_id = ? ORDER BY sent_at DESC", [id])
        : [];
      const documents = await dbAll(
        "SELECT id, label, filename, mime_type, doc_type, external_url, uploaded_at, is_insurance_card FROM client_documents WHERE client_id = ? ORDER BY uploaded_at",
        [id]
      );
      const enrollmentPacket = await dbGet(
        "SELECT status, error_detail, attempts, sent_at, last_attempt_at, completed_at FROM enrollment_packets WHERE client_id = ?",
        [id]
      );
      return json(res, 200, {
        client: authAlerts.sanitizeClientForRole(user, client),
        tasks,
        sessions,
        notifications,
        communications_restricted: !canSeeComms,
        documents,
        enrollmentPacket: enrollmentPacket || null,
        signnowConfigured: signNowConfigured(),
        // Derived by intake-chasing.js rather than by the card, so the screen
        // and the sweeps can never disagree about whether a family is being
        // chased. The card used to work this out from `waitlisted` alone,
        // which was already one copy of the rule too many.
        intakeChasing: chasingState(client),
      });
    }

    // Manually (re)send the enrollment packet for a client. Owner/admin only.
    // "This packet is already signed." For a family who signed on paper, or in
    // SignNow before the CRM was watching. Marking it stops the daily chase and
    // releases everything gated on packet completion -- notably the clinical
    // screener, which fires on exactly this.
    const packetDoneMatch = pathname.match(/^\/api\/clients\/(\d+)\/enrollment-packet\/mark-complete$/);
    if (packetDoneMatch && method === "POST") {
      if (!["owner", "super_admin", "admin", "intake"].includes(user.role)) {
        return json(res, 403, { error: "Not permitted" });
      }
      const clientId = Number(packetDoneMatch[1]);
      const client = await dbGet("SELECT * FROM clients WHERE id = ?", [clientId]);
      if (!client) return json(res, 404, { error: "Not found" });
      const actor = user.email || "staff";
      const existing = await dbGet("SELECT * FROM enrollment_packets WHERE client_id = ?", [clientId]);
      if (existing) {
        await dbRun("UPDATE enrollment_packets SET status = 'completed', completed_at = ? WHERE id = ?",
          [nowISO(), existing.id]);
      } else {
        // No packet was ever sent from here -- the family signed elsewhere. A
        // row is still written so the rest of the system (the screener trigger,
        // the card, the sweep) sees a completed packet rather than none at all.
        // The document id is null, which is honest: there is no SignNow
        // document behind this one.
        await dbRun(
          `INSERT INTO enrollment_packets (client_id, signnow_document_id, status, sent_at, completed_at)
           VALUES (?, NULL, 'completed', ?, ?)`,
          [clientId, nowISO(), nowISO()]
        );
      }
      await dbRun(
        `INSERT INTO client_notes (client_id, author_name, body, created_at) VALUES (?, ?, ?, ?)`,
        [clientId, actor, "Enrollment packet marked as already completed.", nowISO()]
      ).catch((e) => console.error("packet note insert failed:", e.message));
      console.log(`[packet] client ${clientId} marked already-complete by ${actor}`);
      return json(res, 200, { ok: true, marked_by: actor, marked_at: nowISO() });
    }

    // Put the automated intake chasers on hold for one family, or take them
    // off it. Owner/admin/intake only -- the same people who may send or
    // already-complete a packet.
    //
    // This exists because the automatic rules can only see things the CRM
    // knows: a stage, a waitlist flag. They cannot see that a packet the CRM
    // believes it sent was never actually delivered, which is the case it was
    // built for. Left alone, such a family is emailed daily about a document
    // they never received and then closed out by the 7-day rule for not
    // signing it.
    //
    // Deliberately NOT the waitlist. Putting somebody on the waitlist to
    // silence them would move them on the board, badge them as waiting for a
    // place they are not waiting for, and email them to say so.
    const chasingHoldMatch = pathname.match(/^\/api\/clients\/(\d+)\/intake-chasing$/);
    if (chasingHoldMatch && method === "POST") {
      if (!["owner", "super_admin", "admin", "intake"].includes(user.role)) {
        return json(res, 403, { error: "Not permitted" });
      }
      const clientId = Number(chasingHoldMatch[1]);
      const client = await dbGet("SELECT * FROM clients WHERE id = ?", [clientId]);
      if (!client) return json(res, 404, { error: "Not found" });

      const body = await readBody(req);
      const wantHold = body.on_hold !== false; // default: place the hold
      const note = String(body.note || "").trim().slice(0, 500) || null;
      const actor = user.email || "staff";

      if (wantHold) {
        // Idempotent: holding a family who is already held keeps the original
        // date and the original holder. Overwriting them would move "Held 24
        // August" forward every time somebody pressed it, which is the one
        // thing the record is there to answer. A new note is taken; the absence
        // of one does not erase the note already there.
        await dbRun(
          `UPDATE clients SET
             intake_chasing_paused_at  = COALESCE(NULLIF(intake_chasing_paused_at, ''), ?),
             intake_chasing_paused_by  = COALESCE(NULLIF(intake_chasing_paused_by, ''), ?),
             intake_chasing_pause_note = COALESCE(?, intake_chasing_pause_note),
             updated_at = ?
           WHERE id = ?`,
          [nowISO(), actor, note, nowISO(), clientId]
        );
        // Stop the packet's 7-day clock at the moment somebody clicked, not at
        // the next hourly sweep. The sweep would bank it anyway, but the button
        // says the deadline stops now and it should be true when they read it.
        // Only when no pause is already open, so an existing one is not lost.
        await dbRun(
          "UPDATE enrollment_packets SET paused_since = ? WHERE client_id = ? AND status = 'sent' AND paused_since IS NULL",
          [nowISO(), clientId]
        ).catch((e) => console.error("packet clock pause failed:", e.message));
      } else {
        await dbRun(
          `UPDATE clients SET intake_chasing_paused_at = NULL, intake_chasing_paused_by = NULL,
                              intake_chasing_pause_note = NULL, updated_at = ?
             WHERE id = ?`,
          [nowISO(), clientId]
        );
        // The banking of the paused time is left to the sweep, which already
        // does it correctly for the waitlist and would otherwise be a second
        // copy of that arithmetic here.
      }

      // Written to the case notes, not only to the columns: a hold that stops
      // a family being contacted is a decision about that family, and it should
      // be readable in the same place as every other one.
      await dbRun(
        `INSERT INTO client_notes (client_id, author_name, body, created_at) VALUES (?, ?, ?, ?)`,
        [clientId, actor,
         wantHold
           ? "Automatic intake reminders put on hold." + (note ? " Reason: " + note : "")
           : "Automatic intake reminders taken off hold.",
         nowISO()]
      ).catch((e) => console.error("chasing hold note insert failed:", e.message));

      console.log(`[intake-chasing] client ${clientId} ${wantHold ? "held" : "released"} by ${actor}`);
      const updated = await dbGet("SELECT * FROM clients WHERE id = ?", [clientId]);
      return json(res, 200, {
        ok: true,
        client: authAlerts.sanitizeClientForRole(user, updated),
        intakeChasing: chasingState(updated),
      });
    }

    const packetSendMatch = pathname.match(/^\/api\/clients\/(\d+)\/enrollment-packet\/send$/);
    if (packetSendMatch && method === "POST") {
      if (!["owner", "super_admin", "admin", "intake"].includes(user.role)) {
        return json(res, 403, { error: "Not permitted" });
      }
      const client = await dbGet("SELECT * FROM clients WHERE id = ?", [packetSendMatch[1]]);
      if (!client) return json(res, 404, { error: "Not found" });
      const result = await sendEnrollmentPacket(client);
      return json(res, result.ok ? 200 : 400, result);
    }

    if (clientMatch && method === "PATCH") {
      const id = clientMatch[1];
      const updates = await readBody(req);
      const allowed = [
        "child_name", "dob", "parent_name", "parent_relationship", "parent_email", "parent_phone",
        "address", "service_location", "school_status", "start_urgency", "insurance_provider",
        "num_insurances", "has_asd_diagnosis", "has_iep", "prior_aba_nv", "preferred_contact",
        "desired_schedule", "rethink_status", "notes", "first_day_date", "discharge_reason",
        // Assessment scheduling + battery (Phase 3)
        "in_clinic_assessment_date", "assessment_location",
        "pddbi_completed", "pddbi_date", "srs2_completed", "srs2_date",
        "psi_completed", "psi_date", "vineland_tricare_completed", "vineland_tricare_date",
        // Transportation services provided by Spectrum Squad
        "transportation_services", "transportation_notes",
        // parent_sms_consent is deliberately absent: texting is gone, so there
        // is nothing left to consent to. The stored values stay as the record
        // of a consent that was given, and are now read-only.
      ];
      const fields = Object.keys(updates).filter((k) => allowed.includes(k));
      if (fields.length) {
        const setClause = fields.map((f) => `${f} = ?`).join(", ");
        await dbRun(`UPDATE clients SET ${setClause}, updated_at = ? WHERE id = ?`, [
          ...fields.map((f) => updates[f]),
          nowISO(),
          id,
        ]);
      }
      // Treatment plan is due 14 calendar days after the in-person assessment.
      // When that date is entered (or changed), (re)compute the deadline and,
      // the first time, notify the assigned BCBA that the clock has started.
      if (Object.prototype.hasOwnProperty.call(updates, "in_clinic_assessment_date")) {
        await recomputeTreatmentPlanDueDate(id).catch((e) => console.error("TP due date recompute failed:", e.message));
      }
      const client = await dbGet("SELECT * FROM clients WHERE id = ?", [id]);
      return json(res, 200, authAlerts.sanitizeClientForRole(user, client));
    }

    const advanceMatch = pathname.match(/^\/api\/clients\/(\d+)\/advance$/);
    if (advanceMatch && method === "POST") {
      const id = advanceMatch[1];
      const client = await dbGet("SELECT * FROM clients WHERE id = ?", [id]);
      if (!client) return json(res, 404, { error: "Not found" });
      const { stage } = await readBody(req);
      const target = stage || pipeline.nextStageKey(client.stage);
      if (!target) return json(res, 400, { error: "No next stage" });
      await pipeline.enterStage(id, target);
      return json(res, 200, await dbGet("SELECT * FROM clients WHERE id = ?", [id]));
    }

    // Templates a staffer may render/send by hand from a client profile. Only
    // these keys are reachable through the per-client preview/send routes.
    const MANUAL_CLIENT_TEMPLATES = new Set(["post_assessment_next_steps"]);

    // Render a manual template with THIS client's real merge fields, for the
    // "preview before sending" step. Read-only; sends nothing.
    const previewTplMatch = pathname.match(/^\/api\/clients\/(\d+)\/preview-template$/);
    if (previewTplMatch && method === "POST") {
      const { key } = await readBody(req);
      if (!MANUAL_CLIENT_TEMPLATES.has(key)) return json(res, 400, { error: "That template can't be sent from here." });
      const client = await dbGet("SELECT * FROM clients WHERE id = ?", [previewTplMatch[1]]);
      if (!client) return json(res, 404, { error: "Not found" });
      const template = await emailTemplates.getEmailTemplate(key);
      if (!template) return json(res, 404, { error: "Template not found" });
      const fields = parentMilestoneFields(client);
      return json(res, 200, {
        to: client.parent_email || null,
        subject: emailTemplates.renderMergeFields(template.subject_template, fields),
        html: emailTemplates.renderMergeFields(template.body_template, fields),
      });
    }

    // Send a manual template to the client's parent. Logs to notifications_log
    // (the client's communication history) with who triggered it and when.
    const sendTplMatch = pathname.match(/^\/api\/clients\/(\d+)\/send-template$/);
    if (sendTplMatch && method === "POST") {
      const { key } = await readBody(req);
      if (!MANUAL_CLIENT_TEMPLATES.has(key)) return json(res, 400, { error: "That template can't be sent from here." });
      const client = await dbGet("SELECT * FROM clients WHERE id = ?", [sendTplMatch[1]]);
      if (!client) return json(res, 404, { error: "Not found" });
      if (!client.parent_email) return json(res, 400, { error: "This client has no parent email on file." });
      const result = await sendParentTemplate(client, key);
      if (!result.sent) return json(res, 400, { error: "Could not send (" + (result.reason || "unknown") + ")." });
      console.log(`[client ${client.id}] ${key} sent by ${user.email} at ${nowISO()}`);
      return json(res, 200, { ok: true, sent_at: nowISO(), sent_by: user.email });
    }

    // Item 4: Authorization -> Scheduling. Moves a client whose authorization
    // is in hand into the First Day Scheduling stage. enterStage() creates the
    // "Schedule First Day of ABA" task, alerts the scheduling department, and
    // sends the parent milestone -- the authorization fields are untouched.
    // The confirmation happens client-side; this records who triggered it.
    const moveSchedMatch = pathname.match(/^\/api\/clients\/(\d+)\/move-to-scheduling$/);
    if (moveSchedMatch && method === "POST") {
      const id = moveSchedMatch[1];
      const client = await dbGet("SELECT * FROM clients WHERE id = ?", [id]);
      if (!client) return json(res, 404, { error: "Not found" });
      if (!client.auth_start_date) {
        return json(res, 400, { error: "Enter the authorization (including its start date) before moving to scheduling." });
      }
      if (client.stage === "first_day_scheduled" || client.stage === "active") {
        return json(res, 409, { error: "This client is already in scheduling or active therapy." });
      }
      await pipeline.enterStage(id, "first_day_scheduled");
      console.log(`[client ${client.id}] moved to First Day Scheduling by ${user.email} at ${nowISO()} (auth_start=${client.auth_start_date})`);
      return json(res, 200, await dbGet("SELECT * FROM clients WHERE id = ?", [id]));
    }

    const dischargeMatch = pathname.match(/^\/api\/clients\/(\d+)\/discharge$/);
    if (dischargeMatch && method === "POST") {
      const id = dischargeMatch[1];
      const { reason, stage } = await readBody(req);
      const before = await dbGet("SELECT stage FROM clients WHERE id = ?", [id]);
      const target = stage || "discharged";
      await dbRun(
        "UPDATE clients SET stage = ?, discharge_reason = ?, updated_at = ? WHERE id = ?",
        [target, reason || null, nowISO(), id]
      );
      // Closing a record out is written into the client's own note history, so
      // that when it is later reopened the timeline still shows it happened,
      // who did it and why. Uses the existing client_notes trail rather than a
      // second audit store.
      if (!before || before.stage !== target) {
        await addSystemClientNote(
          id, user,
          `Marked ${target === "not_moving_forward" ? "Not Moving Forward" : "Discharged"}` +
          (reason ? ` — ${reason}` : "") + "."
        );
      }
      return json(res, 200, await dbGet("SELECT * FROM clients WHERE id = ?", [id]));
    }

    // Bring a client back from "Not Moving Forward" (or Discharged) into the
    // live pipeline. Deliberately NOT pipeline.enterStage(): that fires the
    // department alert and the parent milestone email, and a family being put
    // back on the board should not receive "great news, time for your
    // assessment" as a side effect of an office correction.
    //
    // The same record is reused throughout -- no new client row, nothing
    // deleted, notes/documents/tasks/communications all stay attached -- and
    // the closure it is coming back from is written into the client's note
    // history first, so the fact that they were once marked Not Moving Forward
    // survives the restore.
    const reactivateMatch = pathname.match(/^\/api\/clients\/(\d+)\/reactivate$/);
    if (reactivateMatch && method === "POST") {
      const id = reactivateMatch[1];
      const client = await dbGet("SELECT * FROM clients WHERE id = ?", [id]);
      if (!client) return json(res, 404, { error: "Not found" });
      if (client.stage !== "not_moving_forward" && client.stage !== "discharged") {
        return json(res, 409, { error: "This client is already in the active pipeline." });
      }
      const body = await readBody(req).catch(() => ({}));
      const requested = (body && body.stage) || "new_submission";
      if (!REACTIVATABLE_STAGES.includes(requested)) {
        return json(res, 400, { error: "Choose a stage in the active pipeline to move this client back into." });
      }
      const closedAs = client.stage === "not_moving_forward" ? "Not Moving Forward" : "Discharged";
      const stageDef = pipeline.getStage(requested);
      const note = (body && String(body.note || "").trim()) || "";

      await addSystemClientNote(
        id, user,
        `Reactivated — moved back into the ${(stageDef && stageDef.label) || requested} stage. ` +
        `Previously marked ${closedAs}${client.discharge_reason ? ` (reason on file: ${client.discharge_reason})` : ""}.` +
        (note ? ` Note: ${note}` : "")
      );

      // discharge_reason is cleared because it now describes a closure that has
      // been undone -- it would otherwise keep showing on the live record as if
      // still current. Its text is preserved verbatim in the note above.
      await dbRun(
        "UPDATE clients SET stage = ?, discharge_reason = NULL, stage_entered_at = ?, updated_at = ? WHERE id = ?",
        [requested, nowISO(), nowISO(), id]
      );

      // Give the stage its checklist back, but only the tasks that are actually
      // missing: a client who already has a row for one of these tasks keeps
      // that row (and its completion history) rather than gaining a duplicate.
      const stageTasks = await dbAll("SELECT * FROM stage_tasks WHERE stage_key = ?", [requested]);
      let tasksCreated = 0;
      for (const task of stageTasks) {
        const existing = await dbGet(
          "SELECT id FROM client_tasks WHERE client_id = ? AND stage_task_id = ?",
          [id, task.id]
        );
        if (existing) continue;
        await dbRun(
          `INSERT INTO client_tasks (client_id, stage_task_id, status, due_date, created_at)
           VALUES (?, ?, 'pending', ?, ?)`,
          [id, task.id, addBusinessDays(new Date(), task.sla_days).toISOString(), nowISO()]
        );
        tasksCreated++;
      }

      console.log(`[client ${id}] reactivated from ${closedAs} into ${requested} by ${user.email} at ${nowISO()}`);
      const updated = await dbGet("SELECT * FROM clients WHERE id = ?", [id]);
      return json(res, 200, {
        ...authAlerts.sanitizeClientForRole(user, updated),
        reactivated_from: closedAs,
        tasks_created: tasksCreated,
      });
    }

    // Place a client on (or take them off) the waitlist. Placing sends the
    // automated "you're on the waitlist" email to the parent; removing sends
    // the "a spot has opened" email. Both templates are editable under
    // Settings -> Email Templates -> Waitlist Emails.
    const waitlistMatch = pathname.match(/^\/api\/clients\/(\d+)\/waitlist$/);
    if (waitlistMatch && method === "POST") {
      const id = waitlistMatch[1];
      const client = await dbGet("SELECT * FROM clients WHERE id = ?", [id]);
      if (!client) return json(res, 404, { error: "Not found" });
      const body = await readBody(req);
      const wantWaitlisted = body.waitlisted !== false; // default true
      const reason = body.reason || null;
      const wasWaitlisted = client.waitlisted === true || client.waitlisted === "t";

      if (wantWaitlisted) {
        await dbRun(
          "UPDATE clients SET waitlisted = true, waitlisted_at = ?, waitlist_reason = ?, updated_at = ? WHERE id = ?",
          [nowISO(), reason, nowISO(), id]
        );
      } else {
        await dbRun(
          "UPDATE clients SET waitlisted = false, waitlist_reason = ?, updated_at = ? WHERE id = ?",
          [reason, nowISO(), id]
        );
      }

      // Only email on an actual state change, and only if we have a parent email.
      if (client.parent_email && wantWaitlisted !== wasWaitlisted) {
        const templateKey = wantWaitlisted ? "client_waitlist" : "client_waitlist_opening";
        const template = await emailTemplates.getEmailTemplate(templateKey);
        if (template) {
          const fields = {
            parent_name: client.parent_name,
            child_name: client.child_name,
            today: new Date().toLocaleDateString(),
            waitlist_reason: reason || "",
          };
          sendEmail({
            to: client.parent_email,
            subject: emailTemplates.renderMergeFields(template.subject_template, fields),
            html: emailTemplates.renderMergeFields(template.body_template, fields),
            clientId: client.id,
            type: "parent_milestone",
          }).catch((e) => console.error("waitlist sendEmail failed:", e));
        }
      }

      const updated = await dbGet("SELECT * FROM clients WHERE id = ?", [id]);
      return json(res, 200, authAlerts.sanitizeClientForRole(user, updated));
    }

    // ---------- Case notes (running log of staff updates per client) ----------
    const notesMatch = pathname.match(/^\/api\/clients\/(\d+)\/notes$/);
    if (notesMatch && method === "GET") {
      const id = notesMatch[1];
      const notes = await dbAll(
        "SELECT id, client_id, author_id, author_name, body, created_at FROM client_notes WHERE client_id = ? ORDER BY created_at DESC, id DESC",
        [id]
      );
      return json(res, 200, notes);
    }
    if (notesMatch && method === "POST") {
      const id = notesMatch[1];
      const client = await dbGet("SELECT id FROM clients WHERE id = ?", [id]);
      if (!client) return json(res, 404, { error: "Not found" });
      const body = await readBody(req);
      const text = (body.body || "").trim();
      if (!text) return json(res, 400, { error: "Note can't be empty." });
      const row = await dbGet(
        `INSERT INTO client_notes (client_id, author_id, author_name, body, created_at)
         VALUES (?, ?, ?, ?, ?) RETURNING id, client_id, author_id, author_name, body, created_at`,
        [id, user.id, user.name || user.email || "Staff", text, nowISO()]
      );
      return json(res, 201, row);
    }

    const noteItemMatch = pathname.match(/^\/api\/clients\/(\d+)\/notes\/(\d+)$/);
    if (noteItemMatch && method === "DELETE") {
      const noteId = noteItemMatch[2];
      const note = await dbGet("SELECT * FROM client_notes WHERE id = ?", [noteId]);
      if (!note) return json(res, 404, { error: "Note not found" });
      // The note's author or a user-admin (owner/admin/super_admin) may delete it.
      if (note.author_id !== user.id && !canManageUsers(user)) {
        return json(res, 403, { error: "You can only delete your own notes." });
      }
      await dbRun("DELETE FROM client_notes WHERE id = ?", [noteId]);
      return json(res, 200, { ok: true });
    }

    // ---------- In-app document upload (store additional documents) ----------
    const docsMatch = pathname.match(/^\/api\/clients\/(\d+)\/documents$/);
    if (docsMatch && method === "POST") {
      const id = Number(docsMatch[1]);
      const client = await dbGet("SELECT id FROM clients WHERE id = ?", [id]);
      if (!client) return json(res, 404, { error: "Not found" });
      const body = await readBody(req);
      const result = await saveClientDocument({
        client_id: id,
        label: body.label,
        filename: body.filename,
        mime_type: body.mime_type,
        content_base64: body.content_base64,
        external_url: body.external_url,
        is_insurance_card: body.is_insurance_card === true,
        is_diagnosis: body.is_diagnosis === true,
        actor: user.email,
      });
      if (!result.ok) return json(res, result.status || 400, { error: result.error });
      return json(res, 201, result.document);
    }

    const docItemMatch = pathname.match(/^\/api\/clients\/(\d+)\/documents\/(\d+)$/);
    if (docItemMatch && method === "DELETE") {
      const docId = Number(docItemMatch[2]);
      const doc = await dbGet("SELECT * FROM client_documents WHERE id = ? AND client_id = ?", [docId, Number(docItemMatch[1])]);
      if (!doc) return json(res, 404, { error: "Document not found" });
      if (doc.doc_type === "hosted" && doc.file_path) {
        try { fs.unlinkSync(path.join(DOCS_DIR, doc.file_path)); } catch (e) {}
      }
      await dbRun("DELETE FROM client_documents WHERE id = ?", [docId]);
      return json(res, 200, { ok: true });
    }

if (pathname === "/api/dashboard/pipeline-v2" && method === "GET") {
      const clients = await dbAll(
        "SELECT * FROM clients WHERE stage NOT IN ('discharged','not_moving_forward') ORDER BY submitted_at DESC"
      );
      const shaped = clients.map((c) => ({
        id: c.id,
        child_name: c.child_name,
        parent_name: c.parent_name,
        insurance_provider: c.insurance_provider,
        service_location: c.service_location,
        assigned_bcba_name: c.assigned_bcba_name,
        assigned_intake_coordinator_name: c.assigned_intake_coordinator_name,
        // Waitlist status travels with the card so the board can show it
        // without anyone opening a client to find out. A waitlisted family is
        // deliberately not being chased, so a card that looks stalled and a
        // card that is waiting on purpose have to be tellable apart at a
        // glance -- otherwise the board reads as a pile of neglected clients.
        waitlisted: c.waitlisted === true || c.waitlisted === "t",
        waitlisted_at: c.waitlisted_at || null,
        waitlist_reason: c.waitlist_reason || null,
        // Transportation travels with the card so schedulers see at a glance
        // that a ride must be coordinated, without opening the client.
        transportation_services: c.transportation_services === true || c.transportation_services === "t",
        ...pipelineV2.computeMilestoneView(c),
      }));
      return json(res, 200, shaped);
    }
    const checklistMatch = pathname.match(/^\/api\/clients\/(\d+)\/checklist$/);
  if (checklistMatch && method === "PATCH") {
    const id = checklistMatch[1];
    const client = await dbGet("SELECT * FROM clients WHERE id = ?", [id]);
    if (!client) return json(res, 404, { error: "Not found" });
    const body = await readBody(req);
    const allowedChecklistFields = [
      "diagnosis_uploaded", "insurance_card_uploaded", "clinical_screener_completed",
      "insurance_verification_completed", "intake_packet_sent", "intake_packet_returned",
      "vineland_completed", "intake_assessment_scheduled_date", "intake_assessment_completed",
      "authorization_submitted", "previous_provider_discharge_letter_received",
      "physician_referral_received", "additional_insurance_docs_received",
      "rethink_client_created", "assigned_rbt_name", "schedule_finalized",
      "assigned_intake_coordinator_name",
    ];
    const fields = Object.keys(body).filter((k) => allowedChecklistFields.includes(k));
    if (!fields.length) return json(res, 400, { error: "No editable fields provided" });
    const wasScreenerDone = client.clinical_screener_completed === true;
    const wasAssessmentDone = client.intake_assessment_completed === true;
    const setClause = fields.map((f) => `${f} = ?`).join(", ");
    await dbRun(`UPDATE clients SET ${setClause}, updated_at = ? WHERE id = ?`, [...fields.map((f) => body[f]), nowISO(), id]);
    const updated = await dbGet("SELECT * FROM clients WHERE id = ?", [id]);
    // When the clinical screener is first marked complete, invite the parent to
    // pick their child's schedule (Phase 4). Fire-and-forget; dedupes internally.
    // Held for waitlisted families -- asking a parent to pick therapy times we
    // cannot yet offer is the most confusing message in the whole chain. The
    // "Send schedule form" button on the client card still works if someone
    // decides to send it deliberately.
    if (!wasScreenerDone && updated.clinical_screener_completed === true && !isWaitlisted(updated)) {
      clientForms.sendScheduleRequest(updated).catch((e) => console.error("sendScheduleRequest failed:", e));
    }
    // When the in-clinic assessment is first marked complete, make sure the
    // treatment-plan deadline (14 calendar days after the assessment) is set and
    // the BCBA has been notified, then create the "write the treatment plan"
    // task due on that same deadline -- so the Task Center and the escalation
    // reminders agree on one date.
    if (!wasAssessmentDone && updated.intake_assessment_completed === true) {
      await recomputeTreatmentPlanDueDate(id).catch((e) => console.error("TP due date recompute failed:", e.message));
      const fresh = await dbGet("SELECT * FROM clients WHERE id = ?", [id]);
      const tpDue = (fresh && fresh.treatment_plan_due_date)
        ? String(fresh.treatment_plan_due_date).slice(0, 10)
        : addCalendarDays(todayISODate(), 14);
      const existingTp = await dbGet(
        "SELECT id FROM staff_tasks WHERE client_id = ? AND title LIKE 'Write treatment plan%' LIMIT 1",
        [id]
      ).catch(() => null);
      if (!existingTp) {
        createStaffTask({
          title: `Write treatment plan for ${updated.child_name}`,
          description: "The in-clinic assessment is complete. Please write and submit the treatment plan.",
          assigned_name: updated.assigned_bcba_name || null,
          client_id: Number(id),
          due_date: tpDue,
          created_by: "system",
        }).catch((e) => console.error("treatment-plan task failed:", e));
      }
    }
    return json(res, 200, { id: updated.id, ...pipelineV2.computeMilestoneView(updated) });
  }

const clientFinancialsMatch = pathname.match(/^\/api\/clients\/(\d+)\/financials$/);
  if (clientFinancialsMatch && method === "GET") {
    if (!(await ownerFinancials.canViewFinancials(user))) return json(res, 403, { error: "Not permitted to view financial data" });
    const id = clientFinancialsMatch[1];
    const client = await dbGet("SELECT * FROM clients WHERE id = ?", [id]);
    if (!client) return json(res, 404, { error: "Not found" });
    const fsRow = await dbGet("SELECT * FROM client_financial_settings WHERE client_id = ?", [id]);
    const ownerSettings = await ownerFinancials.getOwnerFinancialSettings();
    const scheduledByClient = await ownerFinancials.getScheduledHoursByClient();
    const result = ownerFinancials.computeClientFinancials(client, fsRow, ownerSettings, scheduledByClient[id] || 0);
     result.settings = fsRow || {};
    return json(res, 200, result);
  }

  const clientFinancialSettingsMatch = pathname.match(/^\/api\/clients\/(\d+)\/financial-settings$/);
  if (clientFinancialSettingsMatch && method === "PATCH") {
    if (!(await ownerFinancials.canViewFinancials(user))) return json(res, 403, { error: "Not permitted to edit financial data" });
    const id = clientFinancialSettingsMatch[1];
    const client = await dbGet("SELECT id FROM clients WHERE id = ?", [id]);
    if (!client) return json(res, 404, { error: "Not found" });
    const body = await readBody(req);
    const allowedFinancialFields = [
      "authorized_hours_per_week",
      "custom_projected_hours_per_week",
      "hours_source_preference",
      "service_start_date_override",
      "service_end_date_override",
      "lifetime_calc_source",
    ];
    const fields = Object.keys(body).filter((k) => allowedFinancialFields.includes(k));
    if (!fields.length) return json(res, 400, { error: "No editable fields provided" });

    const existing = await dbGet("SELECT client_id FROM client_financial_settings WHERE client_id = ?", [id]);
    if (existing) {
      const setClause = fields.map((f) => `${f} = ?`).join(", ");
      await dbRun(`UPDATE client_financial_settings SET ${setClause}, updated_at = ? WHERE client_id = ?`, [
        ...fields.map((f) => body[f]),
        nowISO(),
        id,
      ]);
    } else {
      const cols = ["client_id", ...fields, "updated_at"];
      const placeholders = cols.map(() => "?").join(", ");
      await dbRun(`INSERT INTO client_financial_settings (${cols.join(", ")}) VALUES (${placeholders})`, [
        id,
        ...fields.map((f) => body[f]),
        nowISO(),
      ]);
    }

    const updatedClient = await dbGet("SELECT * FROM clients WHERE id = ?", [id]);
    const fsRow = await dbGet("SELECT * FROM client_financial_settings WHERE client_id = ?", [id]);
    const ownerSettings = await ownerFinancials.getOwnerFinancialSettings();
    const scheduledByClient = await ownerFinancials.getScheduledHoursByClient();
    const result = ownerFinancials.computeClientFinancials(updatedClient, fsRow, ownerSettings, scheduledByClient[id] || 0);
    result.settings = fsRow || {};
    return json(res, 200, result);
  }

  if (pathname === "/api/clients/financials-summary" && method === "GET") {
    if (!(await ownerFinancials.canViewFinancials(user))) return json(res, 403, { error: "Not permitted to view financial data" });
    const clients = await dbAll("SELECT * FROM clients");
    const fsRows = await dbAll("SELECT * FROM client_financial_settings");
    const fsByClient = {};
    fsRows.forEach((r) => { fsByClient[r.client_id] = r; });
    const ownerSettings = await ownerFinancials.getOwnerFinancialSettings();
    const scheduledByClient = await ownerFinancials.getScheduledHoursByClient();

    const summary = {};
    for (const c of clients) {
      const full = ownerFinancials.computeClientFinancials(c, fsByClient[c.id], ownerSettings, scheduledByClient[c.id] || 0);
      summary[c.id] = {
        estMonthlyRevenue: full.revenue ? full.revenue.monthly : null,
        estMonthlyNetProfit: full.netProfit ? full.netProfit.monthly : null,
        estLifetimeRevenue: full.lifetime ? full.lifetime.lifetimeRevenue : null,
        estLifetimeNetProfit: full.lifetime ? full.lifetime.lifetimeNetProfit : null,
        hasMissing: full.missing.length > 0,
      };
    }
    return json(res, 200, summary);
  }

  if (pathname === "/api/owner-financial-settings" && method === "GET") {
    if (!(await ownerFinancials.canViewFinancials(user))) return json(res, 403, { error: "Not permitted to view financial settings" });
    const settings = await ownerFinancials.getOwnerFinancialSettings();
    return json(res, 200, settings);
  }

  if (pathname === "/api/owner-financial-settings" && method === "PATCH") {
    if (!(await ownerFinancials.canViewFinancials(user))) return json(res, 403, { error: "Not permitted to edit financial settings" });
    const body = await readBody(req);
    const allowedSettingsFields = [
      "avg_revenue_per_hour",
      "avg_net_profit_per_hour",
      "monthly_conversion_factor",
      "default_hours_source",
      "financial_view_roles",
    ];
    const fields = Object.keys(body).filter((k) => allowedSettingsFields.includes(k));
    if (!fields.length) return json(res, 400, { error: "No editable fields provided" });
    const setClause = fields.map((f) => `${f} = ?`).join(", ");
    await dbRun(`UPDATE owner_financial_settings SET ${setClause} WHERE id = 1`, fields.map((f) => body[f]));
    const updated = await ownerFinancials.getOwnerFinancialSettings();
    return json(res, 200, updated);
  }


    
const deleteClientMatch = pathname.match(/^\/api\/clients\/(\d+)$/);
    if (deleteClientMatch && method === "DELETE") {
      const clientId = deleteClientMatch[1];
      const { password } = await readBody(req);
      if (!password) return json(res, 400, { error: "Password is required" });

      // Confirm with the password of whoever is actually logged in, and only
      // let owner-level roles delete. (This used to check the seeded
      // admin@ account's password, which meant the published default
      // password could delete client records.)
      if (!user || !["owner", "super_admin", "admin"].includes(user.role)) {
        return json(res, 403, { error: "Not permitted to delete clients" });
      }
      const me = await auth.findUserByEmail(user.email);
      if (!me || !verifyPassword(password, me.password_salt, me.password_hash)) {
        return json(res, 403, { error: "Incorrect password" });
      }

      const client = await dbGet("SELECT * FROM clients WHERE id = ?", [clientId]);
      if (!client) return json(res, 404, { error: "Not found" });

      await dbRun("DELETE FROM client_notes WHERE client_id = ?", [clientId]);
      await dbRun("DELETE FROM client_tasks WHERE client_id = ?", [clientId]);
      await dbRun("DELETE FROM schedule_sessions WHERE client_id = ?", [clientId]);
      await dbRun("DELETE FROM notifications_log WHERE client_id = ?", [clientId]);
      await dbRun("DELETE FROM client_documents WHERE client_id = ?", [clientId]);
      await dbRun("DELETE FROM auth_audit_log WHERE client_id = ?", [clientId]);
      await dbRun("DELETE FROM auth_alerts WHERE client_id = ?", [clientId]);
      await dbRun("DELETE FROM enrollment_packets WHERE client_id = ?", [clientId]);
      await dbRun("DELETE FROM clients WHERE id = ?", [clientId]);

      return json(res, 200, { ok: true, deleted: clientId });
    }
    // ---------- TASKS ----------
    // By default only open (non-completed) tasks are returned, same as
    // before. Pass ?status=all to also include completed tasks (used by
    // the "Show completed" toggle so completed tasks can be marked undone).
    // Lightweight user list for assignment dropdowns (any authenticated staff).
    if (pathname === "/api/staff" && method === "GET") {
      // This list feeds the "Assign to" picker. It used to be the users table
      // alone -- CRM login accounts -- which meant the only people you could
      // assign work to were the handful who had been given a password. The
      // team lives in the Staff directory (hr_employees), so both are offered,
      // matched on email so someone with both a login and a staff record
      // appears once and keeps the login (that is what drives their reminder
      // emails and "my tasks").
      const users = await dbAll("SELECT id, name, role, email FROM users ORDER BY name");
      let employees = [];
      try {
        employees = await dbAll(
          `SELECT id, name, email, role_title FROM hr_employees
            WHERE COALESCE(status, 'active') NOT IN ('terminated', 'inactive')
              AND name IS NOT NULL AND name <> ''
            ORDER BY name`
        );
      } catch (e) { /* HR add-on not present: fall back to logins only */ }

      const byEmail = new Map();
      const out = [];
      for (const u of users) {
        const key = (u.email || "").trim().toLowerCase();
        const entry = {
          id: u.id, user_id: u.id, employee_id: null,
          name: u.name, email: u.email || null,
          role: u.role, has_login: true,
        };
        if (key) byEmail.set(key, entry);
        out.push(entry);
      }
      for (const e of employees) {
        const key = (e.email || "").trim().toLowerCase();
        const existing = key ? byEmail.get(key) : null;
        if (existing) { existing.employee_id = e.id; continue; }
        // No login: `id` is deliberately null so the picker cannot submit a
        // users.id that does not exist. They are assigned by name + email.
        out.push({
          id: null, user_id: null, employee_id: e.id,
          name: e.name, email: e.email || null,
          role: e.role_title || null, has_login: false,
        });
      }
      // Two people can share a name, and two rows for the same person can exist
      // (the seeded admin@ account is literally named after the owner). Merging
      // by name would risk assigning work to the wrong person, so nothing is
      // merged -- but an identical label twice in a dropdown is unusable, so
      // any repeated name is disambiguated by its address.
      const nameCounts = out.reduce((m, s) => {
        const k = String(s.name || "").trim().toLowerCase();
        m[k] = (m[k] || 0) + 1;
        return m;
      }, {});
      for (const s of out) {
        const k = String(s.name || "").trim().toLowerCase();
        if (nameCounts[k] > 1 && s.email) s.label = `${s.name} (${s.email})`;
        else s.label = s.name;
      }
      out.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
      return json(res, 200, out);
    }

    // ---------- Staff to-do tasks (assignable, due dates, reminders) ----------
    // Supervisory roles (owner / super_admin / admin) may see the whole
    // organization's task list. Everyone else is scoped at the QUERY level --
    // enforced here on the server, not merely hidden in the UI -- so a normal
    // staffer can never browse another employee's task list.
    //
    // What a non-supervisory staff member may see is exactly three things:
    //   1. tasks assigned to them (by user id, or by email for staff with no
    //      CRM login),
    //   2. tasks they created themselves,
    //   3. tasks attached to a client they are assigned to (their own
    //      caseload -- the same "assigned to this client" test the message
    //      history already uses).
    // Anything else -- another staffer's personal to-do list, a client task on
    // a family they have nothing to do with -- is invisible to them, and stays
    // invisible however the request is crafted.
    const canSeeAllTasks = (u) => !!u && ["owner", "super_admin", "admin"].includes(u.role);
    // "Mine" = tasks whose assigned_user_id is me, or whose assigned_email
    // matches my login (which covers staff who have no CRM user id).
    const mineClause = "(st.assigned_user_id = ? OR (st.assigned_email IS NOT NULL AND lower(st.assigned_email) = lower(?)))";
    // 15 placeholders, filled by visibleParams() below in this order:
    // my user id, my email (assignee), my email (creator), then my email twice
    // for each of the two assigned-*-email columns and my name twice for each
    // of the four assigned-*-name columns.
    const visibleClause =
      "(" + mineClause +
      " OR (st.created_by IS NOT NULL AND lower(st.created_by) = lower(?))" +
      " OR (st.client_id IS NOT NULL AND EXISTS (" +
      "      SELECT 1 FROM clients vc WHERE vc.id = st.client_id AND (" +
      "        (? <> '' AND lower(COALESCE(vc.assigned_bcba_email, '')) = lower(?))" +
      "     OR (? <> '' AND lower(COALESCE(vc.assigned_billing_email, '')) = lower(?))" +
      "     OR (? <> '' AND lower(COALESCE(vc.assigned_bcba_name, '')) = lower(?))" +
      "     OR (? <> '' AND lower(COALESCE(vc.assigned_rbt_name, '')) = lower(?))" +
      "     OR (? <> '' AND lower(COALESCE(vc.assigned_billing_name, '')) = lower(?))" +
      "     OR (? <> '' AND lower(COALESCE(vc.assigned_intake_coordinator_name, '')) = lower(?))" +
      "      )))" +
      ")";
    const visibleParams = (u) => {
      const email = String((u && u.email) || "").trim();
      const name = String((u && u.name) || "").trim();
      return [
        u.id, email,                                    // assigned to me
        email,                                          // created by me
        email, email,                                   // caseload: assigned_bcba_email
        email, email,                                   // caseload: assigned_billing_email
        name, name,                                     // caseload: assigned_bcba_name
        name, name,                                     // caseload: assigned_rbt_name
        name, name,                                     // caseload: assigned_billing_name
        name, name,                                     // caseload: assigned_intake_coordinator_name
      ];
    };
    // Only a task's assignee, its creator, or a supervisor may change or delete
    // it. Without this, a staffer who knows a task id could tick off or delete
    // work belonging to someone whose list they cannot even read.
    async function canEditStaffTask(u, taskId) {
      if (canSeeAllTasks(u)) return true;
      const t = await dbGet("SELECT assigned_user_id, assigned_email, created_by FROM staff_tasks WHERE id = ?", [taskId]);
      if (!t) return false;
      const email = String((u && u.email) || "").trim().toLowerCase();
      return (
        (t.assigned_user_id != null && Number(t.assigned_user_id) === Number(u.id)) ||
        (!!t.assigned_email && String(t.assigned_email).trim().toLowerCase() === email) ||
        (!!t.created_by && String(t.created_by).trim().toLowerCase() === email)
      );
    }

    if (pathname === "/api/staff-tasks/summary" && method === "GET") {
      // Counts for the logged-in user's OWN incomplete tasks -- powers the
      // "Tasks & Alerts (N)" nav badge and the Task Center header. Always
      // personal, regardless of role.
      const now = nowISO();
      const today = todayISODate();
      const rows = await dbAll(
        `SELECT due_date FROM staff_tasks st WHERE st.status = 'open' AND ${mineClause}`,
        [user.id, user.email || ""]
      );
      let open = rows.length, overdue = 0, dueToday = 0, upcoming = 0;
      for (const r of rows) {
        const d = r.due_date ? String(r.due_date).slice(0, 10) : null;
        if (d && d < today) overdue++;
        else if (d && d === today) dueToday++;
        else upcoming++;
      }
      return json(res, 200, { open, overdue, today: dueToday, upcoming });
    }

    if (pathname === "/api/staff-tasks" && method === "GET") {
      // scope=mine   -> only tasks assigned to me (the personal Task Center).
      // default      -> everything a supervisor may see, or the three-way
      //                 visible set above for everyone else.
      // A non-supervisory user CANNOT widen this by asking: the else-branch
      // applies visibleClause unconditionally.
      const clauses = [];
      const params = [];
      if (query.scope === "mine") {
        clauses.push(mineClause);
        params.push(user.id, user.email || "");
      } else if (!canSeeAllTasks(user)) {
        clauses.push(visibleClause);
        params.push(...visibleParams(user));
      }
      if (query.status === "open" || query.status === "done") { clauses.push("st.status = ?"); params.push(query.status); }
      const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
      const rows = await dbAll(
        `SELECT st.*, c.child_name FROM staff_tasks st
         LEFT JOIN clients c ON c.id = st.client_id
         ${where}
         ORDER BY (st.status = 'done'), st.due_date NULLS LAST, st.id DESC`,
        params
      );
      // So the UI can render the right buttons without guessing at the rules.
      const email = String(user.email || "").trim().toLowerCase();
      return json(res, 200, rows.map((r) => ({
        ...r,
        can_edit: canSeeAllTasks(user) ||
          (r.assigned_user_id != null && Number(r.assigned_user_id) === Number(user.id)) ||
          (!!r.assigned_email && String(r.assigned_email).trim().toLowerCase() === email) ||
          (!!r.created_by && String(r.created_by).trim().toLowerCase() === email),
      })));
    }
    if (pathname === "/api/staff-tasks" && method === "POST") {
      const body = await readBody(req);
      const title = (body.title || "").trim();
      if (!title) return json(res, 400, { error: "A task title is required." });

      // Any signed-in staff member may raise a task -- for themselves, or for
      // a colleague. Assigning is not a supervisory privilege; SEEING someone
      // else's list still is (the GET above), so handing work over never opens
      // up the rest of that person's to-do list.
      let assignedUserId = body.assigned_user_id ? Number(body.assigned_user_id) : null;
      let assignedName = body.assigned_name || null;
      let assignedEmail = body.assigned_email || null;
      // No assignee given = a task for myself. This is what makes "create a
      // task for myself" a single click rather than picking your own name.
      if (!assignedUserId && !assignedName && !assignedEmail) {
        assignedUserId = user.id;
        assignedName = user.name || null;
        assignedEmail = user.email || null;
      }

      // Attaching a task to a client is client-record access, so it is checked
      // as such rather than trusted from the body.
      let clientId = body.client_id ? Number(body.client_id) : null;
      if (clientId) {
        if (!canAccessClients(user) && !moduleGranted(user, "pipeline")) {
          return json(res, 403, { error: "You don't have access to client records, so this task can't be linked to a client." });
        }
        const exists = await dbGet("SELECT id FROM clients WHERE id = ?", [clientId]);
        if (!exists) return json(res, 400, { error: "That client no longer exists." });
      }

      const row = await createStaffTask({
        title,
        description: body.description,
        assigned_user_id: assignedUserId,
        assigned_name: assignedName,
        assigned_email: assignedEmail,
        client_id: clientId,
        due_date: body.due_date || null,
        priority: body.priority,
        created_by: user.email,
      });
      return json(res, 201, row);
    }
    const staffTaskMatch = pathname.match(/^\/api\/staff-tasks\/(\d+)$/);
    if (staffTaskMatch && method === "PATCH") {
      const id = Number(staffTaskMatch[1]);
      // Backend, not just the UI: a task may only be changed by the person it
      // is assigned to, the person who raised it, or a supervisor.
      if (!(await canEditStaffTask(user, id))) {
        return json(res, 403, { error: "This task belongs to someone else." });
      }
      const body = await readBody(req);
      const sets = [];
      const params = [];
      if (typeof body.title === "string" && body.title.trim()) { sets.push("title = ?"); params.push(body.title.trim()); }
      if ("description" in body) { sets.push("description = ?"); params.push(body.description || null); }
      if ("priority" in body) { sets.push("priority = ?"); params.push(normalizePriority(body.priority)); }
      if ("due_date" in body) { sets.push("due_date = ?", "reminder_sent_at = NULL"); params.push(body.due_date || null); }
      if ("assigned_user_id" in body) {
        const uid = body.assigned_user_id ? Number(body.assigned_user_id) : null;
        let uname = null;
        if (uid) { const u = await dbGet("SELECT name FROM users WHERE id = ?", [uid]); uname = u ? u.name : null; }
        sets.push("assigned_user_id = ?", "assigned_name = ?", "reminder_sent_at = NULL");
        params.push(uid, uname);
      }
      if ("status" in body) {
        const done = body.status === "done";
        sets.push("status = ?", "completed_at = ?");
        params.push(done ? "done" : "open", done ? nowISO() : null);
        if (done) {
          // Kept even after a later reopen, so the task can still say when it
          // had been completed.
          sets.push("last_completed_at = ?");
          params.push(nowISO());
        } else {
          // Reopening: the SAME task goes back on the open list -- title, due
          // date, assignee, client link and description all untouched -- with
          // a trail of who put it back and how many times.
          sets.push(
            "last_completed_at = COALESCE(last_completed_at, completed_at)",
            "reminder_sent_at = NULL",
            "reopened_at = ?", "reopened_by = ?",
            "reopen_count = COALESCE(reopen_count, 0) + 1"
          );
          params.push(nowISO(), user.name || user.email || "staff");
        }
      }
      if (!sets.length) return json(res, 400, { error: "Nothing to update." });
      params.push(id);
      const beforeTask = await dbGet("SELECT status FROM staff_tasks WHERE id = ?", [id]).catch(() => null);
      await dbRun(`UPDATE staff_tasks SET ${sets.join(", ")} WHERE id = ?`, params);
      const afterTask = await dbGet("SELECT * FROM staff_tasks WHERE id = ?", [id]);
      // Only the open -> done transition is news. Re-saving a task that was
      // already done, or editing its title, is not.
      if (afterTask && afterTask.status === "done" && (!beforeTask || beforeTask.status !== "done")) {
        completions.record("staff_task_completed", {
          subject: afterTask.assigned_name || null,
          detail: afterTask.title,
          clientId: afterTask.client_id || null,
          dedupeKey: `staff_task:${id}:${afterTask.completed_at || nowISO()}`,
        });
      }
      return json(res, 200, afterTask);
    }
    if (staffTaskMatch && method === "DELETE") {
      const id = Number(staffTaskMatch[1]);
      if (!(await canEditStaffTask(user, id))) {
        return json(res, 403, { error: "This task belongs to someone else." });
      }
      await dbRun("DELETE FROM staff_tasks WHERE id = ?", [id]);
      return json(res, 200, { ok: true });
    }

    if (pathname === "/api/tasks" && method === "GET") {
      const showAll = query.status === "all";
      // Waitlisted and closed clients are not being worked, so their tasks are
      // noise on this page -- an overdue count nobody can act on, sitting next
      // to real work. The tasks themselves are untouched and still show on the
      // client's own card; only this list stops carrying them.
      const notWorked = `COALESCE(c.waitlisted, false) = false AND c.stage NOT IN ('discharged','not_moving_forward')`;
      const tasks = await dbAll(
        `SELECT ct.*, st.label, st.stage_key, c.child_name, d.name AS department_name, d.color AS department_color
         FROM client_tasks ct
         JOIN stage_tasks st ON st.id = ct.stage_task_id
         JOIN clients c ON c.id = ct.client_id
         JOIN departments d ON d.id = st.department_id
         WHERE ${notWorked}${showAll ? "" : " AND ct.status != 'completed'"}
         ORDER BY ct.due_date ASC`
      );
      return json(res, 200, tasks);
    }

    const completeTaskMatch = pathname.match(/^\/api\/tasks\/(\d+)\/complete$/);
    if (completeTaskMatch && method === "POST") {
      // Body is optional -- the bulk "complete" buttons send none. Only the
      // authorization-submission task passes a treatment_plan_submitted_date.
      const body = await readBody(req).catch(() => ({}));
      const result = await pipeline.completeTask(completeTaskMatch[1], user.id, {
        treatment_plan_submitted_date: body && body.treatment_plan_submitted_date,
        // "Already done": tick it, tell nobody. For catching the CRM up on work
        // that happened outside it.
        silent: !!(body && body.silent),
      });
      return json(res, result.ok ? 200 : 400, result);
    }

    const reopenTaskMatch = pathname.match(/^\/api\/tasks\/(\d+)\/reopen$/);
    if (reopenTaskMatch && method === "POST") {
      const r = await reopenClientTask(reopenTaskMatch[1], user);
      return json(res, r.ok ? 200 : 404, r);
    }

    if (pathname === "/api/tasks/bulk-update" && method === "POST") {
      const { ids, status } = await readBody(req);
      if (!Array.isArray(ids) || !ids.length) {
        return json(res, 400, { error: "ids must be a non-empty array" });
      }
      if (status !== "completed" && status !== "pending") {
        return json(res, 400, { error: "status must be 'completed' or 'pending'" });
      }
      const results = [];
      for (const id of ids) {
        if (status === "completed") {
          results.push(await pipeline.completeTask(id, user.id));
        } else {
          results.push(await reopenClientTask(id, user));
        }
      }
      return json(res, 200, { ok: true, results });
    }

    // ---------- THERAPISTS ----------
    if (pathname === "/api/therapists" && method === "GET") {
      return json(res, 200, await dbAll("SELECT * FROM therapists"));
    }

    // ---------- SCHEDULE ----------
    if (pathname === "/api/schedule" && method === "GET") {
      const sessions = await dbAll(
        `SELECT ss.*, c.child_name, c.color AS client_color, t.name AS therapist_name, t.color AS therapist_color
         FROM schedule_sessions ss
         JOIN clients c ON c.id = ss.client_id
         JOIN therapists t ON t.id = ss.therapist_id`
      );
      return json(res, 200, sessions);
    }

    if (pathname === "/api/schedule" && method === "POST") {
      const s = await readBody(req);
      // conflict check: same therapist, same day, overlapping time
      const conflicts = await dbAll(
        `SELECT * FROM schedule_sessions WHERE therapist_id = ? AND day_of_week = ?
         AND NOT (end_time <= ? OR start_time >= ?)`,
        [s.therapist_id, s.day_of_week, s.start_time, s.end_time]
      );
      if (conflicts.length) {
        return json(res, 409, { error: "Therapist already has a session in that time slot", conflicts });
      }
      const row = await dbGet(
        `INSERT INTO schedule_sessions (client_id, therapist_id, day_of_week, start_time, end_time, session_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [s.client_id, s.therapist_id, s.day_of_week, s.start_time, s.end_time, s.session_type || "ABA Therapy", nowISO()]
      );
      return json(res, 201, { id: row.id });
    }

    // Move a session (drag-and-drop): change day and/or time, with a conflict check.
    const patchSessionMatch = pathname.match(/^\/api\/schedule\/(\d+)$/);
    if (patchSessionMatch && method === "PATCH") {
      const id = Number(patchSessionMatch[1]);
      const existing = await dbGet("SELECT * FROM schedule_sessions WHERE id = ?", [id]);
      if (!existing) return json(res, 404, { error: "Session not found" });
      const b = await readBody(req);
      const day = b.day_of_week != null ? Number(b.day_of_week) : existing.day_of_week;
      const start = b.start_time || existing.start_time;
      const end = b.end_time || existing.end_time;
      const conflicts = await dbAll(
        `SELECT * FROM schedule_sessions WHERE therapist_id = ? AND day_of_week = ? AND id <> ?
         AND NOT (end_time <= ? OR start_time >= ?)`,
        [existing.therapist_id, day, id, start, end]
      );
      if (conflicts.length) return json(res, 409, { error: "That therapist already has a session in that time slot." });
      await dbRun(
        "UPDATE schedule_sessions SET day_of_week = ?, start_time = ?, end_time = ? WHERE id = ?",
        [day, start, end, id]
      );
      return json(res, 200, { ok: true });
    }

    const deleteSessionMatch = pathname.match(/^\/api\/schedule\/(\d+)$/);
    if (deleteSessionMatch && method === "DELETE") {
      await dbRun("DELETE FROM schedule_sessions WHERE id = ?", [deleteSessionMatch[1]]);
      return json(res, 200, { ok: true });
    }

    if (pathname === "/api/schedule-targets" && method === "GET") {
      return json(res, 200, await dbAll("SELECT * FROM schedule_targets"));
    }

    // ---------- NOTIFICATIONS / OUTBOX ----------
    if (pathname === "/api/notifications" && method === "GET") {
      // Message Outbox privacy (items 6 / 16), enforced here at the API layer:
      //  - owner / super_admin / admin see the whole organization's outbox.
      //  - any other client-access staffer sees ONLY messages tied to a client
      //    they are assigned to (org-wide and unassigned-client messages are
      //    never returned to them).
      //  - anyone without client access is refused outright.
      if (canSeeAllMessages(user)) {
        return json(res, 200, await dbAll("SELECT * FROM notifications_log ORDER BY sent_at DESC LIMIT 100"));
      }
      if (!canAccessClients(user)) {
        return json(res, 403, { error: "Not permitted to view the message outbox" });
      }
      const ids = await assignedClientIds(user);
      if (!ids.length) return json(res, 200, []);
      const placeholders = ids.map(() => "?").join(",");
      const rows = await dbAll(
        `SELECT * FROM notifications_log WHERE client_id IN (${placeholders}) ORDER BY sent_at DESC LIMIT 100`,
        ids
      );
      return json(res, 200, rows);
    }

    // Manually (re)send the Benefits & Eligibility Check for a client -- used
    // once the insurance card has been uploaded, so billing gets the attachment.
    const eligibilityMatch = pathname.match(/^\/api\/clients\/(\d+)\/eligibility-check$/);
    if (eligibilityMatch && method === "POST") {
      const client = await dbGet("SELECT * FROM clients WHERE id = ?", [eligibilityMatch[1]]);
      if (!client) return json(res, 404, { error: "Not found" });
      const result = await sendEligibilityCheck(client, user.email);
      // Only a send that actually happened is stamped. Stamping a refused send
      // would be the worst of both worlds: billing never gets the request, and
      // the automatic card-triggered send is permanently switched off for this
      // family because the CRM thinks it already went.
      if (result && result.ok) {
        await dbRun("UPDATE clients SET eligibility_check_sent_at = ? WHERE id = ?", [nowISO(), client.id]).catch(() => {});
      }
      if (!result.ok) return json(res, 400, result);
      return json(res, 200, result);
    }

    const notifResendMatch = pathname.match(/^\/api\/notifications\/(\d+)\/resend$/);
    if (notifResendMatch && method === "POST") {
      // Resending a message is a full-outbox action: owner / super_admin / admin
      // only. Scoped staff can view their clients' messages but not resend.
      if (!canSeeAllMessages(user)) {
        return json(res, 403, { error: "Not permitted" });
      }
      const result = await resendNotificationEmail(Number(notifResendMatch[1]), user.email);
      if (result.error) return json(res, 404, result);
      return json(res, 200, result);
    }

    const attendanceAlertMatch = pathname.match(/^\/api\/clients\/(\d+)\/attendance-alert$/);
    if (attendanceAlertMatch && method === "POST") {
      const id = attendanceAlertMatch[1];
      const client = await dbGet("SELECT * FROM clients WHERE id = ?", [id]);
      if (!client) return json(res, 404, { error: "Not found" });
      if (!client.parent_email) return json(res, 400, { error: "No parent email on file for this client" });

      const { percentage } = await readBody(req);
      const pct = Number(percentage);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        return json(res, 400, { error: "percentage must be a number between 0 and 100" });
      }

      const subject = `Attendance Update for ${client.child_name}`;
      const ackToken = crypto.randomBytes(16).toString("hex");
      const ackLink = `${APP_BASE_URL}/attendance-ack?token=${ackToken}`;
      const html = `
        <p>Hi ${client.parent_name || "there"},</p>
        <p>We wanted to reach out regarding <strong>${client.child_name}</strong>'s attendance. Based on our records, their current session attendance rate is <strong>${pct}%</strong>, which is below the level needed to maintain consistent progress and insurance authorization.</p>
        <p>Missed sessions can affect ${client.child_name}'s treatment progress and may put continued authorization at risk. We ask that you please help ensure ${client.child_name} attends all scheduled sessions going forward.</p>
        <p>Please click below to let us know you've received this message:</p>
        <p style="text-align:center;margin:24px 0;">
          <a href="${ackLink}" style="background:#e0a430;color:#1b2a6b;font-weight:700;text-decoration:none;padding:12px 24px;border-radius:999px;font-size:15px;display:inline-block;">✅ I acknowledge this message</a>
        </p>
        <p style="font-size:12px;color:#888;">If the button doesn't work, open this link: ${ackLink}</p>
        <p>Thank you,<br/>Spectrum Squad</p>
      `;

      // Send + record with an acknowledgment token so the parent can confirm.
      const brandedHtml = brandedEmail(html);
      const { delivered, errorMsg } = await deliverEmail({ to: client.parent_email, subject, html: brandedHtml });
      await dbRun(
        `INSERT INTO notifications_log (client_id, type, recipient, subject, body, sent_at, delivered, ack_token)
         VALUES (?, 'attendance_alert', ?, ?, ?, ?, ?, ?)`,
        [id, client.parent_email, subject, brandedHtml, nowISO(), delivered + (errorMsg ? `: ${errorMsg}` : ""), ackToken]
      );
      return json(res, 200, { delivered, errorMsg });
    }

    const ackNotificationMatch = pathname.match(/^\/api\/notifications\/(\d+)\/acknowledge$/);
    if (ackNotificationMatch && method === "POST") {
      const id = ackNotificationMatch[1];
      await dbRun(
        "UPDATE notifications_log SET acknowledged = true, acknowledged_at = ? WHERE id = ?",
        [nowISO(), id]
      );
      return json(res, 200, await dbGet("SELECT * FROM notifications_log WHERE id = ?", [id]));
    }
    
    
    // ---------- FINANCIAL CENTER (ClickUp) ----------
    // All routes below are session-authenticated (normal cookie login, not
    // the one-off ADMIN_IMPORT_SECRET pattern) and role-gated inline, mirroring
    // the Authorization Alerts routes above.
    if (pathname === "/api/financial/config-status" && method === "GET") {
      if (!clickupIntegration.canViewFinancial(user)) return json(res, 403, { error: "Not permitted" });
      return json(res, 200, await clickupIntegration.getConfigStatus());
    }

    if (pathname === "/api/financial/config" && method === "POST") {
      if (!clickupIntegration.canAdminFinancial(user)) {
        return json(res, 403, { error: "Only admin can configure the ClickUp integration" });
      }
      const body = await readBody(req);
      await clickupIntegration.saveConfig(body, user.email);
      return json(res, 200, await clickupIntegration.getConfigStatus());
    }

    if (pathname === "/api/financial/test-connection" && method === "POST") {
      if (!clickupIntegration.canAdminFinancial(user)) {
        return json(res, 403, { error: "Only admin can test the ClickUp connection" });
      }
      const result = await clickupIntegration.testConnection(user.email);
      return json(res, result.ok ? 200 : 502, result);
    }

    if (pathname === "/api/financial/sync-now" && method === "POST") {
      if (!clickupIntegration.canEditFinancial(user)) return json(res, 403, { error: "Not permitted" });
      const result = await clickupIntegration.syncNow("manual");
      return json(res, result.ok ? 200 : 502, result);
    }

    if (pathname === "/api/financial/sync-status" && method === "GET") {
      if (!clickupIntegration.canViewFinancial(user)) return json(res, 403, { error: "Not permitted" });
      return json(res, 200, await clickupIntegration.getSyncStatus());
    }

    if (pathname === "/api/financial/sync-logs" && method === "GET") {
      if (!clickupIntegration.canViewFinancial(user)) return json(res, 403, { error: "Not permitted" });
      return json(res, 200, await clickupIntegration.getRecentSyncLogs());
    }

    if (pathname === "/api/financial/category-mappings" && method === "GET") {
      if (!clickupIntegration.canViewFinancial(user)) return json(res, 403, { error: "Not permitted" });
      return json(res, 200, await clickupIntegration.getCategoryMappings());
    }

    if (pathname === "/api/financial/category-mappings" && method === "POST") {
      if (!clickupIntegration.canAdminFinancial(user)) {
        return json(res, 403, { error: "Only admin can edit category mappings" });
      }
      const body = await readBody(req);
      if (!body.list_id || !body.category) return json(res, 400, { error: "list_id and category are required" });
      await clickupIntegration.saveCategoryMapping(body, user.email);
      return json(res, 200, await clickupIntegration.getCategoryMappings());
    }

    if (pathname === "/api/financial/tasks" && method === "GET") {
      if (!clickupIntegration.canViewFinancial(user)) return json(res, 403, { error: "Not permitted" });
      const tasks = await dbAll(
        `SELECT id, clickup_task_id, list_id, name, status, category, assignee, due_date, date_created, date_closed, url, last_synced_at
         FROM clickup_tasks ORDER BY date_created DESC LIMIT 500`
      );
      return json(res, 200, tasks);
    }

    // ---------- EMAIL TEMPLATES ----------
    // Every automated email the CRM sends is editable here. Kept to admin-only
    // since it controls messaging content sent workspace-wide to families and
    // staff, mirroring the access level required to change ClickUp credentials.
    if (pathname === "/api/email-templates" && method === "GET") {
      if (!emailTemplates.canEditEmailTemplates(user)) return json(res, 403, { error: "Not permitted" });
      return json(res, 200, await emailTemplates.listEmailTemplates());
    }

    if (pathname === "/api/email-templates/upload-image" && method === "POST") {
      if (!emailTemplates.canEditEmailTemplates(user)) return json(res, 403, { error: "Not permitted" });
      const { filename, mime_type, content_base64 } = await readBody(req);
      if (!content_base64) return json(res, 400, { error: "content_base64 is required" });
      let storedName;
      try {
        storedName = emailTemplates.saveEmailImage(filename || "image.png", mime_type || "image/png", content_base64);
      } catch (e) {
        return json(res, 400, { error: "Invalid image data" });
      }
      return json(res, 201, { url: `/api/email-templates/images/${storedName}` });
    }

    const emailImageMatch = pathname.match(/^\/api\/email-templates\/images\/([a-zA-Z0-9._-]+)$/);
    if (emailImageMatch && method === "GET") {
      const fullPath = path.join(IMAGES_DIR, emailImageMatch[1]);
      if (!fs.existsSync(fullPath)) return json(res, 404, { error: "Not found" });
      const buffer = fs.readFileSync(fullPath);
      const ext = path.extname(fullPath).toLowerCase();
      const mimeMap = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
      res.writeHead(200, {
        "Content-Type": mimeMap[ext] || "application/octet-stream",
        "Content-Length": buffer.length,
        "Cache-Control": "public, max-age=31536000",
      });
      res.end(buffer);
      return true;
    }

    const emailTemplatePreviewMatch = pathname.match(/^\/api\/email-templates\/([a-z0-9_]+)\/preview$/);
    if (emailTemplatePreviewMatch && method === "POST") {
      if (!emailTemplates.canEditEmailTemplates(user)) return json(res, 403, { error: "Not permitted" });
      const rendered = await emailTemplates.previewEmailTemplate(emailTemplatePreviewMatch[1]);
      if (!rendered) return json(res, 404, { error: "Unknown template" });
      return json(res, 200, rendered);
    }

    const emailTemplateTestMatch = pathname.match(/^\/api\/email-templates\/([a-z0-9_]+)\/send-test$/);
    if (emailTemplateTestMatch && method === "POST") {
      if (!emailTemplates.canEditEmailTemplates(user)) return json(res, 403, { error: "Not permitted" });
      const result = await emailTemplates.sendTestEmailTemplate(emailTemplateTestMatch[1], user.email, user.email);
      return json(res, result.ok ? 200 : 502, result);
    }

    const emailTemplateMatch = pathname.match(/^\/api\/email-templates\/([a-z0-9_]+)$/);
    if (emailTemplateMatch && method === "GET") {
      if (!emailTemplates.canEditEmailTemplates(user)) return json(res, 403, { error: "Not permitted" });
      const template = await emailTemplates.getEmailTemplate(emailTemplateMatch[1]);
      if (!template) return json(res, 404, { error: "Unknown template" });
      const def = emailTemplates.EMAIL_TEMPLATE_DEFS.find((d) => d.key === emailTemplateMatch[1]);
      return json(res, 200, { ...template, fields: def ? def.fields : [] });
    }

    if (emailTemplateMatch && method === "PUT") {
      if (!emailTemplates.canEditEmailTemplates(user)) return json(res, 403, { error: "Not permitted" });
      const { subject_template, body_template } = await readBody(req);
      if (!subject_template || !body_template) {
        return json(res, 400, { error: "subject_template and body_template are required" });
      }
      const result = await emailTemplates.saveEmailTemplate(
        emailTemplateMatch[1],
        { subject_template, body_template },
        user.email
      );
      if (!result.ok) return json(res, 404, result);
      return json(res, 200, await emailTemplates.getEmailTemplate(emailTemplateMatch[1]));
    }

    // ---------- FAILED EMAILS (retry / "push" failed sends) ----------
    // Same admin/owner gate as template editing -- controls workspace-wide
    // messaging to families and staff.
    if (pathname === "/api/failed-emails" && method === "GET") {
      if (!emailTemplates.canEditEmailTemplates(user)) return json(res, 403, { error: "Not permitted" });
      return json(res, 200, await listFailedEmails());
    }

    if (pathname === "/api/failed-emails/resend-all" && method === "POST") {
      if (!emailTemplates.canEditEmailTemplates(user)) return json(res, 403, { error: "Not permitted" });
      return json(res, 200, await resendAllFailedEmails(user.email));
    }

    const failedEmailResendMatch = pathname.match(/^\/api\/failed-emails\/(\d+)\/resend$/);
    if (failedEmailResendMatch && method === "POST") {
      if (!emailTemplates.canEditEmailTemplates(user)) return json(res, 403, { error: "Not permitted" });
      const result = await resendFailedEmail(Number(failedEmailResendMatch[1]), user.email);
      // Distinguish client errors (bad id / not failed) from a delivery that
      // was attempted but the provider still rejected -- the latter returns 200
      // with ok:false so the UI can surface the specific provider error.
      if (result.error === "Email not found") return json(res, 404, result);
      if (result.error) return json(res, 400, result);
      return json(res, 200, result);
    }

    // ---------- ADMIN ----------
    if (pathname === "/api/admin/check-overdue" && method === "POST") {
      // Can fire a burst of staff emails; admin-only like the rest of /api/admin.
      if (!canManageUsers(user)) return json(res, 403, { error: "Not permitted" });
      const n = await pipeline.checkOverdueTasks();
      return json(res, 200, { flagged: n });
    }

    // Manually run the treatment-plan escalation sweep (also runs daily on its
    // own). Admin-only; each step still fires at most once per client.
    if (pathname === "/api/admin/run-tp-reminders" && method === "POST") {
      if (!canManageUsers(user)) return json(res, 403, { error: "Not permitted" });
      const n = await processTreatmentPlanReminders();
      return json(res, 200, { sent: n });
    }

    // Manually run the lead nurturing + contract-expiry sweeps. Admin-only;
    // each milestone still fires at most once per lead.
    if (pathname === "/api/admin/run-lead-sweeps" && method === "POST") {
      if (!canManageUsers(user)) return json(res, 403, { error: "Not permitted" });
      const nurtured = growth.nurtureSweep ? await growth.nurtureSweep() : 0;
      const alerts = growth.contractAlertSweep ? await growth.contractAlertSweep() : 0;
      return json(res, 200, { nurture_tasks: nurtured, contract_alerts: alerts });
    }

    if (pathname === "/api/admin/departments" && method === "PATCH") {
      // Department alert emails carry child names, parent names and stage
      // details. Without this check any logged-in account could redirect them
      // to an outside address.
      if (!canManageUsers(user)) return json(res, 403, { error: "Not permitted" });
      const { id, notify_email } = await readBody(req);
      await dbRun("UPDATE departments SET notify_email = ? WHERE id = ?", [notify_email, id]);
      return json(res, 200, { ok: true });
    }

    // Owner-configurable app settings (currently just the eligibility-check
    // recipient). Owner/admin/super_admin only.
    if (pathname === "/api/admin/settings" && method === "GET") {
      if (!canManageUsers(user)) return json(res, 403, { error: "Not permitted" });
      return json(res, 200, {
        eligibility_check_email: await getAppSetting("eligibility_check_email", ""),
        screener_completed_recipient: await getAppSetting("screener_completed_recipient", ""),
        owner_notification_email: await getAppSetting("owner_notification_email", ""),
        clinical_director_email: await getAppSetting("clinical_director_email", ""),
        completion_digest_recipients: await getAppSetting("completion_digest_recipients", ""),
        attendance_review_recipients: await getAppSetting("attendance_review_recipients", ""),
        completion_digest_hour: await getAppSetting("completion_digest_hour", "18"),
        schedule_request_recipients: await getAppSetting("schedule_request_recipients", ""),
        signnow_newhire_template_id: await getAppSetting("signnow_newhire_template_id", ""),
        credentialing_link_bcba: await getAppSetting("credentialing_link_bcba", DEFAULT_SETTINGS.credentialing_link_bcba),
        credentialing_link_rbt: await getAppSetting("credentialing_link_rbt", DEFAULT_SETTINGS.credentialing_link_rbt),
        class_dojo_link: await getAppSetting("class_dojo_link", DEFAULT_SETTINGS.class_dojo_link),
        first_day_dress_code: await getAppSetting("first_day_dress_code", ""),
        shirt_count_full_time: await getAppSetting("shirt_count_full_time", DEFAULT_SETTINGS.shirt_count_full_time),
        shirt_count_part_time: await getAppSetting("shirt_count_part_time", DEFAULT_SETTINGS.shirt_count_part_time),
        signnow_newhire_env_default: SIGNNOW_NEWHIRE_TEMPLATE_ID_ENV ? "set" : "",
        signnow_connected: signNowAuthConfigured(),
      });
    }
    if (pathname === "/api/admin/settings" && method === "PATCH") {
      if (!canManageUsers(user)) return json(res, 403, { error: "Not permitted" });
      const body = await readBody(req);
      const validEmail = (e) => !e || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
      if ("eligibility_check_email" in body) {
        const email = (body.eligibility_check_email || "").trim();
        if (!validEmail(email)) return json(res, 400, { error: "Please enter a valid email address." });
        await setAppSetting("eligibility_check_email", email);
      }
      // Who gets the monthly attendance roster summary. Blank falls back to the
      // owner notification address, then to a real owner/admin mailbox, so the
      // review cannot quietly go nowhere.
      if ("attendance_review_recipients" in body) {
        const raw = String(body.attendance_review_recipients || "").trim();
        const list = raw ? raw.split(/[,;]/).map((x) => x.trim()).filter(Boolean) : [];
        for (const addr of list) {
          if (!validEmail(addr)) return json(res, 400, { error: `"${addr}" is not a valid email address.` });
        }
        await setAppSetting("attendance_review_recipients", list.join(", "));
      }
      if ("clinical_director_email" in body) {
        // Who receives BIP questions and review requests. Never hard-coded.
        const email = (body.clinical_director_email || "").trim();
        if (!validEmail(email)) return json(res, 400, { error: "Please enter a valid Clinical Director email address." });
        await setAppSetting("clinical_director_email", email);
      }
      if ("owner_notification_email" in body) {
        const email = (body.owner_notification_email || "").trim();
        if (!validEmail(email)) return json(res, 400, { error: "Please enter a valid owner email address." });
        await setAppSetting("owner_notification_email", email);
      }
      // Who gets the nightly "here's what finished" email. Blank is allowed and
      // means "fall back to the owner address", which is what most installs
      // want; a typo is not allowed, because a digest sent to a dead address
      // fails silently every night.
      if ("completion_digest_recipients" in body) {
        const raw = String(body.completion_digest_recipients || "").trim();
        const list = raw ? raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : [];
        const bad = list.filter((e) => !validEmail(e));
        if (bad.length) return json(res, 400, { error: `Not a valid email address: ${bad.join(", ")}` });
        await setAppSetting("completion_digest_recipients", list.join(", "));
      }
      if ("completion_digest_hour" in body) {
        const h = Number(body.completion_digest_hour);
        if (!Number.isInteger(h) || h < 0 || h > 23) {
          return json(res, 400, { error: "Digest hour must be a whole number from 0 to 23." });
        }
        await setAppSetting("completion_digest_hour", String(h));
      }
      // Who gets emailed when a parent submits their schedule request. A blank
      // value means "no staff notification" (the request still lands on the
      // client profile either way). Comma/semicolon separated.
      if ("schedule_request_recipients" in body) {
        const raw = String(body.schedule_request_recipients || "").trim();
        const list = raw ? raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : [];
        const bad = list.filter((e) => !validEmail(e));
        if (bad.length) return json(res, 400, { error: `Not a valid email address: ${bad.join(", ")}` });
        await setAppSetting("schedule_request_recipients", list.join(", "));
      }
      // The two credentialing forms are different per role, so they live here
      // rather than being pasted into a template body where a change means
      // editing prose.
      for (const key of ["credentialing_link_bcba", "credentialing_link_rbt"]) {
        if (key in body) {
          const url = (body[key] || "").trim();
          if (url && !/^https:\/\/[^\s]+$/.test(url)) {
            return json(res, 400, { error: "That credentialing link needs to be a full https:// URL." });
          }
          if (/urldefense\.proofpoint\.com/i.test(url)) {
            return json(res, 400, {
              error: "That's a Proofpoint-wrapped link. It only opens for readers inside Spectrum Squad mail, and new hires are on personal addresses — paste the original ClickUp URL instead.",
            });
          }
          await setAppSetting(key, url);
        }
      }
      if ("first_day_dress_code" in body) await setAppSetting("first_day_dress_code", (body.first_day_dress_code || "").trim());
      if ("class_dojo_link" in body) {
        const url = (body.class_dojo_link || "").trim();
        if (url && !/^https:\/\/[^\s]+$/.test(url)) return json(res, 400, { error: "The Class Dojo link needs to be a full https:// URL." });
        await setAppSetting("class_dojo_link", url);
      }
      for (const key of ["shirt_count_full_time", "shirt_count_part_time"]) {
        if (key in body) {
          const n = String(body[key] || "").trim();
          if (n && !/^\d{1,2}$/.test(n)) return json(res, 400, { error: "Shirt counts need to be a whole number." });
          await setAppSetting(key, n);
        }
      }
      if ("signnow_newhire_template_id" in body) {
        // Which SignNow template the new-hire employment packet is copied from.
        // Kept in settings rather than only in the environment so the packet can
        // be re-pointed at a new template without a redeploy.
        const tpl = (body.signnow_newhire_template_id || "").trim();
        if (tpl && !/^[A-Za-z0-9_-]{10,80}$/.test(tpl)) {
          return json(res, 400, { error: "That doesn't look like a SignNow template ID. Copy it from the template's URL in SignNow." });
        }
        await setAppSetting("signnow_newhire_template_id", tpl);
      }
      if ("screener_completed_recipient" in body) {
        // May be a comma/semicolon-separated list of addresses.
        const raw = (body.screener_completed_recipient || "").trim();
        const parts = raw.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
        if (parts.some((p) => !validEmail(p))) return json(res, 400, { error: "One of the screener recipient addresses is invalid." });
        await setAppSetting("screener_completed_recipient", parts.join(", "));
      }
      return json(res, 200, {
        eligibility_check_email: await getAppSetting("eligibility_check_email", ""),
        screener_completed_recipient: await getAppSetting("screener_completed_recipient", ""),
        owner_notification_email: await getAppSetting("owner_notification_email", ""),
      });
    }

    // ---------- Team / user management (owner, admin, super_admin) ----------
    if (pathname === "/api/admin/users" && method === "GET") {
      if (!canManageUsers(user)) return json(res, 403, { error: "Not permitted to manage users" });
      const rows = await dbAll(
        `SELECT id, name, email, role, department_id, can_view_financials, module_access, created_at
         FROM users ORDER BY created_at NULLS LAST, id`
      );
      // A login and a staff record are separate rows joined only by email, so
      // the photo has to be looked up rather than assumed to be on the user.
      for (const u of rows) {
        const emp = await dbGet(
          "SELECT id, (hr_photo IS NOT NULL) AS has_photo FROM hr_employees WHERE LOWER(email) = LOWER(?)",
          [u.email]
        ).catch(() => null);
        u.employee_id = emp ? emp.id : null;
        u.has_photo = !!(emp && emp.has_photo);
      }
      return json(res, 200, { users: rows, roles: ROLE_CATALOG });
    }

    if (pathname === "/api/admin/users" && method === "POST") {
      if (!canManageUsers(user)) return json(res, 403, { error: "Not permitted to manage users" });
      const body = await readBody(req);
      const name = (body.name || "").trim();
      const email = (body.email || "").trim().toLowerCase();
      const password = body.password || "";
      const role = (body.role || "").trim();
      const departmentId = body.department_id ? Number(body.department_id) : null;

      if (!name || !email || !password) return json(res, 400, { error: "Name, email, and a temporary password are required." });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: "Please enter a valid email address." });
      if (password.length < 8) return json(res, 400, { error: "Temporary password must be at least 8 characters." });
      if (!VALID_ROLE_KEYS.includes(role)) return json(res, 400, { error: "Please choose a valid role." });
      if (PRIVILEGED_ROLES.includes(role) && !PRIVILEGED_ROLE_ASSIGNERS.includes(user.role)) {
        return json(res, 403, { error: "Only an Owner or Super Admin can create Owner / Super Admin accounts." });
      }
      if (await findUserByEmail(email)) return json(res, 409, { error: "A user with that email already exists." });

      const newId = await createUser({ name, email, password, role, department_id: departmentId });
      const created = await dbGet(
        "SELECT id, name, email, role, department_id, can_view_financials, module_access, created_at FROM users WHERE id = ?",
        [newId]
      );
      return json(res, 201, created);
    }

    const userMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
    if (userMatch && method === "PATCH") {
      if (!canManageUsers(user)) return json(res, 403, { error: "Not permitted to manage users" });
      const targetId = Number(userMatch[1]);
      const target = await dbGet("SELECT * FROM users WHERE id = ?", [targetId]);
      if (!target) return json(res, 404, { error: "User not found" });
      const body = await readBody(req);

      const sets = [];
      const params = [];

      if (typeof body.name === "string" && body.name.trim()) {
        sets.push("name = ?");
        params.push(body.name.trim());
      }

      if (typeof body.role === "string" && body.role) {
        const newRole = body.role.trim();
        if (!VALID_ROLE_KEYS.includes(newRole)) return json(res, 400, { error: "Please choose a valid role." });
        // Guard against privilege escalation and locking everyone out.
        if (PRIVILEGED_ROLES.includes(newRole) && !PRIVILEGED_ROLE_ASSIGNERS.includes(user.role)) {
          return json(res, 403, { error: "Only an Owner or Super Admin can grant the Owner / Super Admin role." });
        }
        if (PRIVILEGED_ROLES.includes(target.role) && !PRIVILEGED_ROLE_ASSIGNERS.includes(user.role)) {
          return json(res, 403, { error: "Only an Owner or Super Admin can change an Owner / Super Admin account." });
        }
        // Don't allow removing the last Owner.
        if (target.role === "owner" && newRole !== "owner") {
          const owners = await dbGet("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'");
          if (Number(owners.n) <= 1) return json(res, 400, { error: "You can't change the role of the last Owner account." });
        }
        sets.push("role = ?");
        params.push(newRole);
      }

      if ("department_id" in body) {
        sets.push("department_id = ?");
        params.push(body.department_id ? Number(body.department_id) : null);
      }

      if (body.password) {
        if (String(body.password).length < 8) return json(res, 400, { error: "New password must be at least 8 characters." });
        const { hash, salt } = hashPassword(String(body.password));
        sets.push("password_hash = ?", "password_salt = ?");
        params.push(hash, salt);
      }

      if ("module_access" in body) {
        // JSON map { moduleKey: bool }. Store null to clear (revert to role defaults).
        let ma = null;
        if (body.module_access && typeof body.module_access === "object") {
          const clean = {};
          for (const k of Object.keys(body.module_access)) clean[String(k).slice(0, 40)] = !!body.module_access[k];
          ma = JSON.stringify(clean);
        }
        sets.push("module_access = ?");
        params.push(ma);
      }

      if (!sets.length) return json(res, 400, { error: "Nothing to update." });
      params.push(targetId);
      await dbRun(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, params);
      const updated = await dbGet(
        "SELECT id, name, email, role, department_id, can_view_financials, module_access, created_at FROM users WHERE id = ?",
        [targetId]
      );
      return json(res, 200, updated);
    }

    if (userMatch && method === "DELETE") {
      if (!canManageUsers(user)) return json(res, 403, { error: "Not permitted to manage users" });
      const targetId = Number(userMatch[1]);
      const target = await dbGet("SELECT * FROM users WHERE id = ?", [targetId]);
      if (!target) return json(res, 404, { error: "User not found" });
      if (targetId === user.id) return json(res, 400, { error: "You can't delete your own account." });
      if (PRIVILEGED_ROLES.includes(target.role) && !PRIVILEGED_ROLE_ASSIGNERS.includes(user.role)) {
        return json(res, 403, { error: "Only an Owner or Super Admin can remove an Owner / Super Admin account." });
      }
      if (target.role === "owner") {
        const owners = await dbGet("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'");
        if (Number(owners.n) <= 1) return json(res, 400, { error: "You can't delete the last Owner account." });
      }
      await dbRun("DELETE FROM sessions WHERE user_id = ?", [targetId]);
      await dbRun("DELETE FROM users WHERE id = ?", [targetId]);
      return json(res, 200, { ok: true });
    }

    return false;
  } catch (err) {
    console.error(err);
    json(res, 500, { error: "Server error", detail: err.message });
    return true;
  }
}

const routes = { handle };

// ============================== SEED ==============================
// server/seed.js
// Seeds departments, pipeline stage-tasks, demo staff logins, demo therapists,
// schedule targets, and a handful of SYNTHETIC demo clients (not real patient
// data) so the app is fully explorable out of the box.
"use strict";

async function run() {
  await seedDepartments();
  await seedStageTasks();
  await seedUsers();
  await seedTherapists();
  await seedScheduleTargets();
  await seedDemoClients();
  console.log("Seed complete.");
}

async function seedDepartments() {
  const existing = await dbGet("SELECT COUNT(*) AS n FROM departments");
  if (Number(existing.n) > 0) return;
  const depts = [
    { key: "intake", name: "Intake / Admin", color: "#5fa8a0", notify_email: "intake@spectrumsquadlv.com" },
    { key: "clinical", name: "Clinical (BCBA)", color: "#1b2a6b", notify_email: "clinical@spectrumsquadlv.com" },
    { key: "billing", name: "Billing / Insurance", color: "#e0a430", notify_email: "billing@spectrumsquadlv.com" },
    { key: "scheduling", name: "Scheduling", color: "#3f56b5", notify_email: "scheduling@spectrumsquadlv.com" },
  ];
  for (const d of depts) {
    await dbRun("INSERT INTO departments (key, name, color, notify_email) VALUES (?, ?, ?, ?)", [
      d.key, d.name, d.color, d.notify_email,
    ]);
  }
}

async function deptId(key) {
  const row = await dbGet("SELECT id FROM departments WHERE key = ?", [key]);
  return row.id;
}

async function seedStageTasks() {
  const existing = await dbGet("SELECT COUNT(*) AS n FROM stage_tasks");
  if (Number(existing.n) > 0) return;
  // Last field = assignable. The Clinical Screener is automated (parent-driven,
  // system-managed) and must never be assigned to staff, so it seeds as false.
  const rows = [
    ["new_submission", "Welcome call / initial contact", "intake", 1, 1, true],
    ["clinical_screener", "Complete Clinical Screener", "clinical", 2, 1, false],
    ["insurance_verification", "Verify Insurance Benefits", "billing", 3, 1, true],
    ["assessment_scheduling", "Schedule Vineland / Intake Assessment", "clinical", 5, 1, true],
    ["authorization", "Submit Authorization Request", "billing", 3, 1, true],
    ["first_day_scheduled", "Schedule First Day of ABA", "scheduling", 5, 1, true],
  ];
  for (const [stage_key, label, deptKey, sla_days, sort_order, assignable] of rows) {
    const did = await deptId(deptKey);
    await dbRun(
      `INSERT INTO stage_tasks (stage_key, label, department_id, sla_days, sort_order, assignable)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [stage_key, label, did, sla_days, sort_order, assignable]
    );
  }
}

const LEGACY_SEED_PASSWORD = "ChangeMe123!";
const SEEDED_EMAILS = [
  "admin@spectrumsquadlv.com",
  "intake@spectrumsquadlv.com",
  "clinical@spectrumsquadlv.com",
  "billing@spectrumsquadlv.com",
  "scheduling@spectrumsquadlv.com",
];

async function seedUsers() {
  if (await findUserByEmail("admin@spectrumsquadlv.com")) return;
  // Fresh installs get a random, unusable password for every seeded account.
  // The owner sets real passwords from Admin Settings > Users. Nothing is
  // ever printed to the deploy log.
  const rnd = () => crypto.randomBytes(24).toString("base64url");
  // Seeded as the Owner outright. A migration in MIGRATIONS_SQL promotes this
  // account from 'admin' to 'owner', but migrations run before seeding, so on
  // a brand-new install the account sat on 'admin' until the NEXT restart --
  // and owner-only features (the full supply-request queue, owner financials)
  // quietly did nothing in the meantime. The migration is still there for
  // installs that were seeded before this change.
  await createUser({ name: "Quiana Blake", email: "admin@spectrumsquadlv.com", password: rnd(), role: "owner", department_id: null });
  await createUser({ name: "Intake Staff", email: "intake@spectrumsquadlv.com", password: rnd(), role: "intake", department_id: await deptId("intake") });
  await createUser({ name: "Clinical Staff", email: "clinical@spectrumsquadlv.com", password: rnd(), role: "clinical", department_id: await deptId("clinical") });
  await createUser({ name: "Billing Staff", email: "billing@spectrumsquadlv.com", password: rnd(), role: "billing", department_id: await deptId("billing") });
  await createUser({ name: "Scheduling Staff", email: "scheduling@spectrumsquadlv.com", password: rnd(), role: "scheduling", department_id: await deptId("scheduling") });
}

// One-time remediation for installs that were seeded before the above change:
// any seeded account still sitting on the published default password gets a
// random one, which locks it until the owner resets it in Admin Settings.
// Accounts whose password was already changed are left completely alone.
async function retireDefaultPasswords() {
  for (const email of SEEDED_EMAILS) {
    const u = await findUserByEmail(email);
    if (!u) continue;
    if (!verifyPassword(LEGACY_SEED_PASSWORD, u.password_salt, u.password_hash)) continue;
    const { hash, salt } = hashPassword(crypto.randomBytes(24).toString("base64url"));
    await dbRun("UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?", [hash, salt, u.id]);
    await dbRun("DELETE FROM sessions WHERE user_id = ?", [u.id]);
    console.log(`Security: retired default password on ${email} -- reset it in Admin Settings if this account is still in use.`);
  }
}

async function seedTherapists() {
  const existing = await dbGet("SELECT COUNT(*) AS n FROM therapists");
  if (Number(existing.n) > 0) return;
  const rows = [
    ["Allie R.", "BCBA", "#1b2a6b", 30],
    ["Katelyn S.", "RBT", "#5fa8a0", 30],
    ["April M.", "RBT", "#3f8f89", 30],
    ["Marcus T.", "RBT", "#e0a430", 25],
  ];
  for (const r of rows) {
    await dbRun("INSERT INTO therapists (name, role, color, weekly_capacity_hours) VALUES (?, ?, ?, ?)", r);
  }
}

async function seedScheduleTargets() {
  const existing = await dbGet("SELECT COUNT(*) AS n FROM schedule_targets");
  if (Number(existing.n) > 0) return;
  const rows = [
    ["Full-Time", 30],
    ["Part Time AM", 15],
    ["Part Time PM", 15],
  ];
  for (const r of rows) {
    await dbRun("INSERT INTO schedule_targets (key, weekly_hours) VALUES (?, ?)", r);
  }
}

// Synthetic demo clients only -- mirrors the real form's fields/pipeline
// without using any actual family's data.
async function seedDemoClients() {
  const existing = await dbGet("SELECT COUNT(*) AS n FROM clients");
  if (Number(existing.n) > 0) return;

  const demo = [
    {
      child_name: "Demo Child A",
      dob: "2020-04-12",
      parent_name: "Demo Parent A",
      parent_relationship: "Parent / Legal Guardian",
      parent_email: "demo.parentA@example.com",
      parent_phone: "555-010-0001",
      address: "123 Example St, Las Vegas, NV",
      service_location: "In-Clinic",
      school_status: "None: Homeschooled/Not School Aged",
      start_urgency: "ASAP",
      insurance_provider: "Medicaid",
      num_insurances: "1",
      has_asd_diagnosis: "Yes",
      has_iep: "No",
      prior_aba_nv: "No",
      preferred_contact: "Text, Email",
      desired_schedule: "Full-Time",
      rethink_status: "In Rethink",
      stage: "new_submission",
      color: "#5fa8a0",
    },
    {
      child_name: "Demo Child B",
      dob: "2019-09-02",
      parent_name: "Demo Parent B",
      parent_relationship: "Parent / Legal Guardian",
      parent_email: "demo.parentB@example.com",
      parent_phone: "555-010-0002",
      address: "456 Example Ave, Henderson, NV",
      service_location: "In Home",
      school_status: "School",
      start_urgency: "Within 30-60 days",
      insurance_provider: "Aetna",
      num_insurances: "1",
      has_asd_diagnosis: "Yes",
      has_iep: "Yes",
      prior_aba_nv: "No",
      preferred_contact: "Phone Call",
      desired_schedule: "Part Time PM",
      rethink_status: "Not in Rethink",
      stage: "insurance_verification",
      color: "#e0a430",
    },
    {
      child_name: "Demo Child C",
      dob: "2021-01-20",
      parent_name: "Demo Parent C",
      parent_relationship: "Parent / Legal Guardian",
      parent_email: "demo.parentC@example.com",
      parent_phone: "555-010-0003",
      address: "789 Example Blvd, Las Vegas, NV",
      school_status: "None: Homeschooled/Not School Aged",
      service_location: "In-Clinic",
      start_urgency: "ASAP",
      insurance_provider: "TriCare",
      num_insurances: "2",
      has_asd_diagnosis: "Yes",
      has_iep: "No",
      prior_aba_nv: "Yes",
      preferred_contact: "Text, Email, Phone Call",
      desired_schedule: "Full-Time",
      rethink_status: "In Rethink",
      stage: "authorization",
      color: "#3f56b5",
    },
    {
      child_name: "Demo Child D",
      dob: "2018-06-15",
      parent_name: "Demo Parent D",
      parent_relationship: "Parent / Legal Guardian",
      parent_email: "demo.parentD@example.com",
      parent_phone: "555-010-0004",
      address: "321 Example Dr, North Las Vegas, NV",
      service_location: "In Home",
      school_status: "School",
      start_urgency: "ASAP",
      insurance_provider: "Medicaid",
      num_insurances: "1",
      has_asd_diagnosis: "Yes",
      has_iep: "Yes",
      prior_aba_nv: "No",
      preferred_contact: "Text",
      desired_schedule: "Full-Time",
      rethink_status: "In Rethink",
      stage: "active",
      color: "#8d85c8",
    },
  ];

  for (const c of demo) {
    const submittedAt = nowISO();
    const row = await dbGet(
      `INSERT INTO clients (
        child_name, dob, parent_name, parent_relationship, parent_email, parent_phone,
        address, service_location, school_status, start_urgency, insurance_provider,
        num_insurances, has_asd_diagnosis, has_iep, prior_aba_nv, preferred_contact,
        desired_schedule, rethink_status, stage, color, submitted_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new_submission', ?, ?, ?) RETURNING id`,
      [
        c.child_name, c.dob, c.parent_name, c.parent_relationship, c.parent_email, c.parent_phone,
        c.address, c.service_location, c.school_status, c.start_urgency, c.insurance_provider,
        c.num_insurances, c.has_asd_diagnosis, c.has_iep, c.prior_aba_nv, c.preferred_contact,
        c.desired_schedule, c.rethink_status, c.color, submittedAt, submittedAt,
      ]
    );
    // Walk the client through stages up to its target demo stage so tasks +
    // notifications get generated realistically (and land in the outbox).
    const stagePath = ["new_submission", "clinical_screener", "insurance_verification", "assessment_scheduling", "authorization", "first_day_scheduled", "active"];
    const targetIdx = stagePath.indexOf(c.stage);
    for (let i = 0; i <= targetIdx; i++) {
      await enterStage(row.id, stagePath[i]);
      // auto-complete tasks for all but the current (final) stage, so the
      // client appears to have organically progressed to `c.stage`.
      if (i < targetIdx) {
        const tasks = await dbAll(
          `SELECT ct.id FROM client_tasks ct JOIN stage_tasks st ON st.id = ct.stage_task_id
           WHERE ct.client_id = ? AND st.stage_key = ?`,
          [row.id, stagePath[i]]
        );
        for (const t of tasks) {
          await dbRun("UPDATE client_tasks SET status='completed', completed_at=? WHERE id=?", [nowISO(), t.id]);
        }
      }
    }
  }

  // Give "Demo Child D" (active) a sample weekly schedule.
  const activeClient = await dbGet("SELECT id FROM clients WHERE child_name = 'Demo Child D'");
  const therapist = await dbGet("SELECT id FROM therapists LIMIT 1");
  if (activeClient && therapist) {
    const sessions = [
      [1, "09:00", "12:00"],
      [3, "09:00", "12:00"],
      [5, "09:00", "12:00"],
    ];
    for (const [day, start, end] of sessions) {
      await dbRun(
        "INSERT INTO schedule_sessions (client_id, therapist_id, day_of_week, start_time, end_time, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [activeClient.id, therapist.id, day, start, end, nowISO()]
      );
    }
  }
}

// ============================== SERVER BOOTSTRAP ==============================
// server/index.js
// Entry point. Run with: node server.js
"use strict";

loadEnvFile();

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname; // index.html lives alongside server.js in this deployment

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

async function ensureSeeded() {
  const row = await dbGet("SELECT COUNT(*) AS n FROM departments");
  if (Number(row.n) === 0) {
    console.log("First run detected -- seeding demo data...");
    await run();
  }
}

// Only these files are public. Everything else in the app folder -- backend
// modules, package.json, and crucially the /data volume where uploaded
// insurance cards, diagnoses, resumes and signed forms live -- is never
// served directly. Uploaded documents are reachable only through the
// authenticated /api/... download routes.
const PUBLIC_FILES = new Set([
  "/index.html",
  "/logo.png",
  "/clinical-screener.html",
  "/ot-intake.html",
  "/supply-request.html",
  // Front-end bundles loaded by index.html
  "/theme.js",
  "/attendance.js",
  "/email-templates.js",
  "/financial-center.js",
  "/owner-financials.js",
  "/pipeline-v2.js",
  "/screener-admin.js",
  "/hr-recruiting.js",
  "/ot-frontend.js",
  "/hr-attendance-frontend.js",
  "/billable-frontend.js",
  "/pto-frontend.js",
  "/supervision-frontend.js",
  "/growth-frontend.js",
  "/events-frontend.js",
  "/supply-requests-frontend.js",
  "/geo-map-frontend.js",
  "/bip-frontend.js",
  "/people-frontend.js",
  "/signnow-import-frontend.js",
  "/new-hire.html",
  "/scheduling-frontend.js",
  // Rethink client matching screen. Without this entry the file 404s, the
  // window.__renderRethinkMatch global never defines, and #/rethink-clients
  // silently falls back to the dashboard -- which is exactly what happened.
  "/rethink-match-frontend.js",
  // Grant Finder. Same trap as the line above: leave it off and #/grants falls
  // back to the dashboard with no error anywhere.
  "/grants-frontend.js",
]);

function serveStatic(req, res, pathname) {
  let filePath = pathname === "/" ? "/index.html" : pathname;
  // Anything not on the allowlist that *looks* like a file is refused
  // outright; app routes (no dot in the last segment) still fall through to
  // the SPA handler below so deep links keep working.
  if (!PUBLIC_FILES.has(filePath)) {
    const last = filePath.split("/").pop() || "";
    if (last.includes(".")) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
  }
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  let fullPath = path.join(PUBLIC_DIR, filePath);

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      // SPA fallback: unknown non-file routes serve index.html
      const indexPath = path.join(PUBLIC_DIR, "index.html");
      fs.readFile(indexPath, (err2, indexData) => {
        if (err2) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        res.end(indexData);
      });
      return;
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}
// ---- Per-user module grants ------------------------------------------
// The Access editor can switch a section explicitly ON for a user whose role
// would not normally include it. `handle()` above enforces the OFF case;
// this is the ON case, which each add-on consults alongside its role list.
// A grant unlocks a module's ordinary access tier only -- manage/sensitive
// tiers (HR compensation, payroll, offers) stay role-gated on purpose, so
// flipping a nav toggle can never hand over payroll data.
function moduleGranted(user, key) {
  if (!user || !user.module_access || !key) return false;
  let ma = user.module_access;
  if (typeof ma === "string") { try { ma = JSON.parse(ma); } catch (e) { return false; } }
  return !!ma && ma[key] === true;
}

// ===== SCREENER add-on: clinical screener automation (send, remind, host, save) =====
const screener = require("./screener")({
  dbGet, dbAll, dbRun, sendEmail, nowISO, crypto, APP_BASE_URL, readBody, json, PUBLIC_DIR, moduleGranted,
  onCompletion: (...a) => completions.record(...a),
  // One place decides who should not be chased about intake paperwork, so the
  // screener and the enrollment packet cannot drift apart on it.
  intakeChasingPaused,
  // A screener answer can create work (a child already in ABA needs a
  // termination letter from the current provider), so the module needs the
  // same task system everything else uses rather than its own.
  createStaffTask,
  // The screener's parent emails are editable templates like every other
  // parent email, rather than strings baked into the module.
  getEmailTemplate: (key) => emailTemplates.getEmailTemplate(key),
  renderMergeFields: (str, fields) => emailTemplates.renderMergeFields(str, fields),
});
// ===== HR & RECRUITING add-on: job requisitions, applicant tracking, careers page =====
const hr = require("./hr")({
  dbGet, dbAll, dbRun, sendEmail, nowISO, crypto, APP_BASE_URL, readBody, json, sendFile, PUBLIC_DIR, moduleGranted,
  onCompletion: (...a) => completions.record(...a),
  // New-hire employment packet (SignNow). Passed in rather than reimplemented so
  // there is one SignNow client, one token cache, and one place that knows how
  // a packet send is recorded.
  sendNewHirePacket, getNewHirePacket, getAppSetting,
  // Late-bound: onboarding is constructed after hr, so this resolves at call
  // time rather than at require time.
  startOnboarding: (employee, actor) => onboarding.startOnboarding(employee, actor),
  onboardingPortalUrl: (token) => onboarding.portalUrl(token),
});
// ===== PTO add-on: accrual per hour worked, on top of the existing
// staff_time_off table (which already records leave taken) =====
const pto = require("./pto")({
  dbGet, dbAll, dbRun, nowISO, readBody, json, getAppSetting, setAppSetting,
});
// ===== BILLABLE add-on: per-BCBA monthly requirements + the monthly email =====
const billable = require("./billable")({
  dbGet, dbAll, dbRun, sendEmail, nowISO, readBody, json,
});
const clientForms = require("./client-forms")({
  dbGet, dbAll, dbRun, sendEmail, nowISO, crypto, APP_BASE_URL, readBody, json, moduleGranted,
  onCompletion: (...a) => completions.record(...a),
  // The parent document-request link uploads through the one shared writer, so
  // a file a parent sends is filed exactly like one staff uploads by hand.
  saveClientDocument: (opts) => saveClientDocument(opts),
});
const ot = require("./ot")({
  dbGet, dbAll, dbRun, sendEmail, nowISO, crypto, APP_BASE_URL, readBody, json, sendFile, moduleGranted,
});
// ===== EMPLOYEE ATTENDANCE MANAGEMENT add-on: points engine, discipline,
// bonus cycles, policy editor, attendance emails, historical import. Reuses the
// existing hr_employees identity + Resend. Owns all /api/attendance/* routes. =====
let attendance;
try {
  attendance = require("./hr-attendance")({
    dbGet, dbAll, dbRun, sendEmail, nowISO, crypto, APP_BASE_URL, readBody, json,
    // Recipients for the monthly attendance roster summary.
    getAppSetting, setAppSetting,
  });
} catch (e) {
  // The hr-attendance module file isn't present yet. Keep the app booting with a
  // no-op stub so the rest of the CRM works; full Employee Attendance features
  // activate automatically once hr-attendance.js is added to the repo.
  console.error("hr-attendance module not found — Employee Attendance features disabled until hr-attendance.js is added:", e.message);
  attendance = { initTables: async () => {}, handleApi: async () => false, dailySweep: async () => {} };
}
// ===== CLINIC SUPPLY / SHOPPING REQUESTS add-on: public submit link, tokenized
// tracking, full status flow with requester email updates. Owns /api/supply/*. =====
const supply = require("./supply-requests")({
  dbGet, dbAll, dbRun, sendEmail, nowISO, crypto, APP_BASE_URL, readBody, json, sendFile, moduleGranted,
});
// ===== CLIENTS & CLINICIANS MAP add-on: geocodes existing client + employee
// addresses (OpenStreetMap) and pairs nearest clinicians for in-homes. =====
const geoMap = require("./geo-map")({
  dbGet, dbAll, dbRun, nowISO, crypto, json, moduleGranted,
});
// ===== RBT SUPERVISION TRACKER add-on: monthly supervision logs per employee,
// Rethink-hours import, BCBA sign-off with auto-email + PDF. Owns /api/supervision/*. =====
const supervision = require("./supervision")({
  dbGet, dbAll, dbRun, sendEmail, nowISO, crypto, APP_BASE_URL, readBody, json, moduleGranted,
  onCompletion: (...args) => completions.record(...args),
  // Verified completed hours from Rethink, when the filter has been confirmed.
  // Returns {} until then, so the tracker keeps using the uploaded figure.
  rethinkVerifiedHours: (month) => rethink.verifiedHoursByEmployee(month),
});
// ===== RETHINK INTEGRATION: the one place that talks to the Rethink API.
// Owns /api/rethink/*. Supplies verified monthly service hours to the
// supervision tracker and 97153 authorization dates to the existing
// authorization-expiration alert engine. =====
const rethink = require("./rethink")({
  dbGet, dbAll, dbRun, nowISO, readBody, json,
  // "Rethink Provider Match Needed" is a supervision-page warning, so it must
  // use the supervision tracker's own population rule rather than a second
  // copy of it. Without this the warning names every staff member without a
  // Rethink ID -- BCBAs, the clinical director, the owner -- none of whom are
  // supervisees. Passed lazily so there is no construction-order coupling.
  isSupervisionTracked: (emp) => supervision.isTracked(emp),
});
// ===== COMPLETIONS: one recorder for every "X finished" event, a dashboard
// feed, and a single daily digest email. Constructed early so every module
// below can be handed completions.record. =====
// ===== SIGNNOW IMPORT: file the back-catalogue of signed documents onto the
// client and staff records they belong to. Preview first, nothing written
// without a human ticking it. =====
const signnowImport = require("./signnow-import")({
  dbGet, dbAll, dbRun, nowISO, crypto, json, readBody,
  signNowRequest, signNowConfigured, signNowFetchRaw,
  DOCS_DIR,
  // hr.js owns this directory; the path is rebuilt rather than exported so the
  // two modules cannot drift apart silently if one of them moves.
  RESUME_DIR: path.join(DATA_DIR, "hr-resumes"),
  logAudit: (actor, action, entityType, entityId, detail) => dbRun(
    `INSERT INTO hr_audit_log (actor, action, entity_type, entity_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [actor || "system", action, entityType || null, entityId || null, detail || null, nowISO()]
  ).catch((e) => console.error("signnow import audit failed:", e.message)),
});
const completions = require("./completions")({
  dbGet, dbAll, dbRun, sendEmail, nowISO, json, readBody, getAppSetting, setAppSetting, APP_BASE_URL,
});
// ===== FINANCIAL CENTER ADVISOR add-on: owner-only money advisor from uploaded
// bank/QuickBooks/payroll data — budgets, wage sim, reconciliation, insights. =====
const financialAdvisor = require("./financial-advisor")({
  dbGet, dbAll, dbRun, nowISO, crypto, readBody, json, moduleGranted,
});
// ===== FINANCIAL CENTER LEDGER add-on: document upload ledger, normalization
// and the reconciliation engine (bank + payroll). Owns /api/fin/documents,
// /api/fin/ledger, /api/fin/reconcile, /api/fin/unrecognized, /api/fin/vendor-rules
// and /api/fin/trace; the older overview routes stay in financial-advisor.js. =====
const finLedger = require("./fin-ledger")({
  dbGet, dbAll, dbRun, nowISO, crypto, readBody, json, moduleGranted,
  extractPdfLines: (buf) => financialAdvisor.extractPdfLines(buf),
  unzip: (buf) => financialAdvisor.unzip(buf),
});

// ===== GROWTH add-on: Lead Management + Policies/SOPs (public QR viewer). =====
// Gets the PDF/zip readers from the financial advisor (initialised above) so
// policy uploads can read .pdf and .docx without a second copy of that code.
// ===== EVENTS: the reusable community-event system (Halloween Palooza is the
// first ROW in it, not the architecture). Owns /api/events/*. Additive: new
// tables only, and deliberately no client or clinical data. =====
const events = require("./events")({
  dbGet, dbAll, dbRun, nowISO, readBody, json, moduleGranted,
  // Phase 3 outreach: sending, merge fields and absolute links for the
  // unsubscribe footer. sendEmail already writes every send to
  // notifications_log, which is the activity log the outreach spec required.
  sendEmail, renderMergeFields, APP_BASE_URL,
  randomToken: () => crypto.randomBytes(24).toString("hex"),
});

const growth = require("./growth")({
  dbGet, dbAll, dbRun, nowISO, crypto, readBody, json, moduleGranted,
  extractPdfLines: (buf) => financialAdvisor.extractPdfLines(buf),
  unzip: (buf) => financialAdvisor.unzip(buf),
  // Contract management (Phase 5): email, editable check-in templates, and
  // follow-up tasks that land in the assignee's Task Center.
  sendEmail, getAppSetting, APP_BASE_URL,
  emailTemplates,
  createStaffTask: (t) => createStaffTask(t),
  // Stripe payments (Phase 6b): the module stores only safe identifiers.
  stripe: stripeClient,
});
// ===== BEHAVIOR INTERVENTION PLAN workspace: lives inside the client card.
// Owns /api/bip/*. Reuses the clients table, auth, permissions and email. =====
const bip = require("./bip")({
  dbGet, dbAll, dbRun, nowISO, crypto, readBody, json,
  sendEmail, APP_BASE_URL, getAppSetting, canAccessClients,
});

// ===== PEOPLE add-on: department management, emergency contacts on client and
// staff cards, and staff certification expiry with staged notices. Owns
// /api/people/*. Extends the existing departments table rather than replacing
// it, so every stage-routing reference keeps working. =====
const people = require("./people")({
  dbGet, dbAll, dbRun, nowISO, readBody, json,
  sendEmail, APP_BASE_URL, getAppSetting, canAccessClients,
});

// ===== GRANT FINDER add-on: funding opportunities, the Spectrum Squad
// organisation profile they are matched against, eligibility analysis and
// match scoring. Owns /api/grants/*. =====
const aiClient = require("./ai-client");
const grants = require("./grants")({
  dbGet, dbAll, dbRun, nowISO, readBody, json,
  // Phase 2: deadline alerts email through the same gate everything else does,
  // application tasks are ordinary staff tasks, and uploaded grant documents
  // land on the same volume as every other document.
  getAppSetting, sendEmail,
  createStaffTask: (t) => createStaffTask(t),
  saveDocument: (o) => saveDocumentFile(o),
  // Phase 3: the grant assistant. One shared Claude client, so this is not a
  // third copy of the same fetch.
  callClaude: (o) => aiClient.callClaude(o),
  aiConfigured: () => aiClient.configured(),
});

// ===== SCHEDULING CENTER add-on: dated sessions on the real staff directory,
// recurrence series, conflict detection, availability and time off, and the
// day operations board. Replaces the old weekly-pattern Therapy Schedule; the
// legacy rows are converted once by /api/sched/migrate-legacy. Owns
// /api/sched/*. =====
// ===== NEW HIRE ONBOARDING add-on: the document portal a new hire uploads
// into, the 72-hour clock, and the completion detection that notifies the
// owner and Clinical Director and raises the background-check and HomeBase
// tasks. Owns /api/onboarding/* and the public /new-hire page. =====
const onboarding = require("./onboarding")({
  dbGet, dbAll, dbRun, nowISO, crypto, readBody, json, sendFile,
  sendEmail, APP_BASE_URL, getAppSetting,
  onCompletion: (...a) => completions.record(...a),
  // There is no shared renderer on the templates module, so this mirrors the
  // one hr.js uses: pull the row, substitute {{merge}} fields.
  renderTemplate: async (key, fields) => {
    const row = await dbGet("SELECT subject_template, body_template FROM email_templates WHERE template_key = ?", [key]);
    if (!row) return null;
    const sub = (s) => String(s || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, k) => (fields[k] == null ? "" : String(fields[k])));
    return { subject: sub(row.subject_template), html: sub(row.body_template) };
  },
  extractPdfLines: (buf) => financialAdvisor.extractPdfLines(buf),
  makeStaffTask: async (title, employeeId) => {
    await dbRun(
      `INSERT INTO staff_tasks (title, description, status, created_at) VALUES (?, ?, 'open', ?)`,
      [title, `Staff #${employeeId}`, nowISO()]
    ).catch((e) => console.error("onboarding staff task failed:", e.message));
  },
});

const scheduling = require("./scheduling")({
  dbGet, dbAll, dbRun, nowISO, readBody, json, canAccessClients, moduleGranted,
});

// ===== AUTHORIZATIONS add-on: real per-service authorization records imported
// from the Rethink "Authorization Utilization" export, replacing the three
// free-text columns on the client row. Every parse is reconciled against the
// export's own Totals line before anything is offered for import. Owns
// /api/auth-util/*. =====
const authorizations = require("./authorizations")({
  dbGet, dbAll, dbRun, nowISO, crypto, readBody, json, canAccessClients,
  unzip: (buf) => financialAdvisor.unzip(buf),
});

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);

  if (pathname.startsWith("/api/")) {
    const handled = await routes.handle(req, res, pathname, req.method, parsed.query || {});
    if (!handled) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
    return;
  }

  // Onboarding portal: /new-hire (and /new-hire/) serve the upload page. The
  // token stays in the query string, never in the path, so it does not end up
  // in a referrer header on the way to the credentialing form.
  if (pathname === "/new-hire" || pathname === "/new-hire/") {
    const file = path.join(PUBLIC_DIR, "new-hire.html");
    if (fs.existsSync(file)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "no-referrer" });
      res.end(fs.readFileSync(file));
      return;
    }
  }

  // VENDOR SIGN-UP: the public form a vendor fills in themselves. Closed per
  // event until somebody opens it; see serveVendorSignup for the defences.
  if (pathname.startsWith("/vendor-signup/")) {
    if (await events.serveVendorSignup(req, res, pathname, req.method)) return;
  }

  // OUTREACH OPT-OUT: the unsubscribe link in every outreach email. Public and
  // unauthenticated on purpose -- the recipient is a business owner with no
  // account here, and must not need one in order to be left alone.
  if (pathname === "/outreach/unsubscribe") {
    if (await events.handleUnsubscribe(req, res, parsed.query || {})) return;
  }

// SCREENER: serve the public form page at /screener/:token
  if (pathname === "/screener" || pathname.startsWith("/screener/")) {
    if (await screener.servePage(req, res, pathname)) return;
}

  // HR: serve the public careers + interview scheduling pages
  if (
    pathname === "/careers" || pathname.startsWith("/careers/") ||
    pathname.startsWith("/apply/") || pathname.startsWith("/schedule/") ||
    pathname.startsWith("/verify-timecard/") || pathname.startsWith("/offer/") ||
    pathname === "/staff-availability" || pathname.startsWith("/staff-availability/")
  ) {
    if (await hr.servePage(req, res, pathname)) return;
  }

  // Client-facing form pages (financial responsibility, schedule picker, etc.)
  if (
    pathname === "/financial-form" || pathname.startsWith("/financial-form/") ||
    pathname === "/schedule-request" || pathname.startsWith("/schedule-request/") ||
    pathname === "/client-documents" || pathname.startsWith("/client-documents/")
  ) {
    if (await clientForms.servePage(req, res, pathname)) return;
  }

  // Occupational Therapy public parent intake page.
  if (pathname === "/ot-intake" || pathname.startsWith("/ot-intake/")) {
    if (await ot.servePage(req, res, pathname)) return;
  }

  // Public supply/shopping request submit + tracking page.
  if (pathname === "/supply-request" || pathname.startsWith("/supply-request/")) {
    if (await supply.servePage(req, res, pathname)) return;
  }

  // Public employee attendance-acknowledgment signing page.
  if (pathname === "/attendance-sign" || pathname.startsWith("/attendance-sign/")) {
    if (attendance.servePage && await attendance.servePage(req, res, pathname)) return;
  }

  // Public policies/SOPs viewer (QR-code target).
  if (pathname === "/policies" || pathname.startsWith("/policies/")) {
    if (growth.servePage && growth.servePage(req, res, pathname)) return;
  }

  // Parent attendance acknowledgment: one click from the email marks it
  // acknowledged and shows a thank-you page.
  if (pathname === "/attendance-ack") {
    const token = (parsed.query && parsed.query.token) || "";
    let ok = false;
    if (token) {
      const row = await dbGet("SELECT id FROM notifications_log WHERE ack_token = ?", [token]).catch(() => null);
      if (row) {
        await dbRun("UPDATE notifications_log SET acknowledged = true, acknowledged_at = ? WHERE ack_token = ?", [nowISO(), token]).catch(() => {});
        ok = true;
      }
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Spectrum Squad</title>
      <style>body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:linear-gradient(135deg,#f3f0ff,#eafaf6);min-height:100vh;display:flex;align-items:center;justify-content:center;color:#1b2a6b;}
      .c{background:#fff;border-radius:20px;box-shadow:0 18px 50px rgba(41,34,92,.14);padding:40px 32px;max-width:420px;text-align:center;margin:16px;}
      .c img.logo{max-width:200px;width:70%;height:auto;margin-bottom:12px;}
      .big{font-size:56px}</style></head>
      <body><div class="c"><img class="logo" src="/logo.png" alt="Spectrum Squad"/><div class="big">${ok ? "✅" : "⚠️"}</div>
      <h1>${ok ? "Thank you!" : "Link not found"}</h1>
      <p>${ok ? "We've recorded that you received this attendance message. Please reach out anytime to discuss your child's schedule." : "This acknowledgment link is invalid or has already been used. If you have questions, please contact us."}</p>
      </div></body></html>`);
    return;
  }

  serveStatic(req, res, pathname);
});

// Overdue-task + authorization-expiration + ClickUp Financial Center sweeps:
// run on boot, then on their own intervals. In production, keep the Node
// process alive (e.g. via pm2 / a platform's process manager) so these
// intervals keep firing, or trigger the equivalent POST /api/admin/... routes
// from an external scheduler instead.
async function start() {
  await initSchema();
  await emailTemplates.seedEmailTemplates();
  await hr.initTables().catch((e) => console.error("HR initTables failed:", e));
  await clientForms.initTables().catch((e) => console.error("Client Forms initTables failed:", e));
  await ot.initTables().catch((e) => console.error("OT initTables failed:", e));
  await attendance.initTables().catch((e) => console.error("Attendance initTables failed:", e));
  await supply.initTables().catch((e) => console.error("Supply initTables failed:", e));
  await billable.initTables().catch((e) => console.error("Billable initTables failed:", e));
  await pto.initTables().catch((e) => console.error("PTO initTables failed:", e));
  await supervision.initTables().catch((e) => console.error("Supervision initTables failed:", e));
  await financialAdvisor.initTables().catch((e) => console.error("Financial advisor initTables failed:", e));
  await finLedger.initTables().catch((e) => console.error("Financial ledger initTables failed:", e));
  await bip.initTables().catch((e) => console.error("BIP initTables failed:", e));
  await people.initTables().catch((e) => console.error("People initTables failed:", e));
  await grants.initTables().catch((e) => console.error("Grants initTables failed:", e));
  await scheduling.initTables().catch((e) => console.error("Scheduling initTables failed:", e));
  await onboarding.initTables().catch((e) => console.error("Onboarding initTables failed:", e));
  await completions.initTables().catch((e) => console.error("Completions initTables failed:", e));
  await signnowImport.initTables().catch((e) => console.error("SignNow import initTables failed:", e));
  // Seed the credentialing links rather than defaulting them at read time.
  // Two places read them -- the settings screen and the onboarding portal --
  // and a default that only exists in one of them is a link that silently
  // comes out blank in a real hire's email.
  for (const [key, url] of Object.entries(DEFAULT_SETTINGS)) {
    const existing = await dbGet("SELECT value FROM app_settings WHERE key = ?", [key]).catch(() => null);
    if (!existing) await setAppSetting(key, url).catch(() => {});
  }
  await authorizations.initTables().catch((e) => console.error("Authorizations initTables failed:", e));
  await rethink.initTables().catch((e) => console.error("Rethink initTables failed:", e));

  // One-time backfill: every client that existed before the eligibility check
  // became card-triggered is stamped as already sent.
  //
  // Without this, uploading a card to a client enrolled months ago would fire a
  // fresh benefits request at billing for somebody whose eligibility was
  // settled long ago -- the old code already sent theirs at enrollment. The
  // stamp records that enrollment date rather than today, because that is when
  // the email actually went.
  //
  // Guarded by a setting so it runs exactly once. Clients created afterwards
  // keep a NULL stamp and are handled by the normal card trigger.
  if (!(await getAppSetting("eligibility_backfill_done", ""))) {
    const done = await dbRun(
      `UPDATE clients SET eligibility_check_sent_at = COALESCE(submitted_at, updated_at, ?)
        WHERE eligibility_check_sent_at IS NULL`,
      [nowISO()]
    ).catch((e) => { console.error("Eligibility backfill failed:", e.message); return null; });
    if (done) {
      await setAppSetting("eligibility_backfill_done", nowISO()).catch(() => {});
      console.log("Eligibility check backfill: existing clients stamped as already sent.");
    }
  }

  // One-time grace for the enrollment-packet sweep.
  //
  // checkEnrollmentPackets() used to bail out unless a static SIGNNOW_API_KEY
  // was set, so on an install using the auto-refresh credentials it had never
  // actually run. Now that it does, every packet still sitting at 'sent' would
  // be measured against its ORIGINAL send date on the very first sweep -- and
  // anything older than seven days would be marked "Not Moving Forward" and
  // chased with a reminder in the same minute, for a deadline that was never
  // being enforced against those families.
  //
  // So the elapsed time is banked into paused_ms (the field the waitlist pause
  // already uses) and the reminder clock is stamped as of now: every
  // outstanding family gets a clean seven days and their first nudge tomorrow,
  // rather than being closed out retroactively. Guarded by a setting so it
  // happens exactly once; packets sent from here on are timed normally.
  if (!(await getAppSetting("packet_sweep_grace_done", ""))) {
    const graced = await dbRun(
      `UPDATE enrollment_packets
          SET paused_ms = GREATEST(0, EXTRACT(EPOCH FROM (now() - sent_at::timestamptz)) * 1000)::bigint,
              last_reminder_at = ?
        WHERE status = 'sent' AND sent_at IS NOT NULL`,
      [nowISO()]
    ).catch((e) => { console.error("Packet sweep grace failed:", e.message); return null; });
    if (graced) {
      await setAppSetting("packet_sweep_grace_done", nowISO()).catch(() => {});
      console.log(`Enrollment packet sweep: ${graced.rowCount} outstanding packet(s) given a fresh 7-day window (the sweep had not been running).`);
    }
  }
  await growth.initTables().catch((e) => console.error("Growth initTables failed:", e));
  await events.initTables().catch((e) => console.error("Events initTables failed:", e));

  // Event outreach follow-ups (Phase 4). Drafts only -- it writes messages
  // into the review queue and cannot send; a person still approves each one.
  // Daily rather than hourly: a follow-up delay is measured in days, so there
  // is nothing an hourly pass would catch sooner that matters.
  //
  // Deliberately NOT on boot. A few redeploys in an afternoon should not each
  // be a chance to draft the same batch, and nothing here is time-critical.
  setInterval(() => {
    events.followUpSweepAll()
      .then((r) => { if (r && r.drafted) console.log(`[outreach] daily follow-up sweep drafted ${r.drafted} message(s) across ${r.events} event(s)`); })
      .catch((e) => console.error("Follow-up sweep failed:", e.message));
  }, 24 * 60 * 60 * 1000);
  await geoMap.initTables().catch((e) => console.error("Geo Map initTables failed:", e));
  await hr.seed().catch((e) => console.error("HR seed failed:", e));
  await hr.processFollowups().catch((e) => console.error("HR follow-up sweep failed:", e));
  await hr.processReminders().catch((e) => console.error("HR interview reminder sweep failed:", e));
  await ensureSeeded();
  await retireDefaultPasswords().catch((e) => console.error("Default-password retirement failed:", e.message));
  await pipeline.checkOverdueTasks();

  // Rethink sync runs BEFORE the expiration sweep so the alert engine reads
  // freshly synced 97153 dates rather than yesterday's. Both are no-ops with a
  // recorded reason when credentials are absent, so a CRM without the
  // integration configured boots exactly as it did before.
  const rethinkSweep = () => {
    rethink.syncSupervisionHours("scheduled").catch((e) => console.error("Rethink hours sync failed:", e.message));
    rethink.syncAuthorizations("scheduled").catch((e) => console.error("Rethink authorization sync failed:", e.message));
  };
  await rethink.syncAuthorizations("boot").catch((e) => console.error("Rethink authorization sync failed:", e.message));
  await rethink.syncSupervisionHours("boot").catch((e) => console.error("Rethink hours sync failed:", e.message));

  await authAlerts.checkAuthExpirations().catch((e) => console.error("Auth expiration sweep failed:", e));
  await clickupIntegration.syncNow("scheduled").catch((e) => console.error("ClickUp sync failed:", e));

  setInterval(() => {
    pipeline.checkOverdueTasks().catch((e) => console.error("Overdue sweep failed:", e));
  }, 30 * 60 * 1000);

  // Assessment-scheduling reminders to parents (also runs on boot below).
  pipeline.processAssessmentReminders().catch((e) => console.error("Assessment reminder sweep failed:", e));
  setInterval(() => {
    pipeline.processAssessmentReminders().catch((e) => console.error("Assessment reminder sweep failed:", e));
  }, 24 * 60 * 60 * 1000);

  // Staff task due-date reminders (email the assignee), also on boot.
  processStaffTaskReminders().catch((e) => console.error("Staff task reminder sweep failed:", e));
  setInterval(() => {
    processStaffTaskReminders().catch((e) => console.error("Staff task reminder sweep failed:", e));
  }, 6 * 60 * 60 * 1000);

  // Treatment-plan escalating reminders to the assigned BCBA (7 / 3 / 1 day /
  // overdue). Runs on boot and then daily; each step fires at most once and the
  // whole ladder stops as soon as the plan is submitted.
  processTreatmentPlanReminders().catch((e) => console.error("Treatment plan reminder sweep failed:", e));
  setInterval(() => {
    processTreatmentPlanReminders().catch((e) => console.error("Treatment plan reminder sweep failed:", e));
  }, 24 * 60 * 60 * 1000);

  // Lead/contract nurturing (30/60/90-day check-in tasks) and contract-expiry
  // alerts. Runs on boot and then daily; each milestone fires at most once.
  const growthSweeps = () => {
    if (growth.nurtureSweep) growth.nurtureSweep().catch((e) => console.error("Lead nurture sweep failed:", e));
    if (growth.contractAlertSweep) growth.contractAlertSweep().catch((e) => console.error("Contract alert sweep failed:", e));
  };
  growthSweeps();
  setInterval(growthSweeps, 24 * 60 * 60 * 1000);

  // Grant submission-deadline notices (30/14/7/3/1/day-of). Runs on boot and
  // then daily; each stage fires at most once per grant, and anything we are
  // likely ineligible for is never chased.
  grants.deadlineSweep().catch((e) => console.error("Grant deadline sweep failed:", e));
  setInterval(() => {
    grants.deadlineSweep().catch((e) => console.error("Grant deadline sweep failed:", e));
  }, 24 * 60 * 60 * 1000);

  // Automated grant discovery: daily, but deliberately NOT on boot. Every other
  // sweep here only touches our own database, so running one at start-up is
  // free; this one calls out to somebody else's API, and a few deploys in an
  // afternoon should not become a few rounds of traffic at a funder. Sources
  // that cannot run (an API key nobody has set) are skipped rather than logged
  // as a daily failure -- the connectors screen is where that is reported.
  setInterval(() => {
    grants.discoverySweep().catch((e) => console.error("Grant discovery sweep failed:", e));
  }, 24 * 60 * 60 * 1000);

  // Monthly billable summaries to clinical staff who carry a requirement.
  // Checked hourly rather than monthly: a redeploy resets an interval, and a
  // restart on the 2nd would otherwise skip the month. The notices table is
  // what prevents a second send, not the timing.
  setInterval(() => {
    billable.tick().catch((e) => console.error("Billable monthly tick failed:", e));
  }, 60 * 60 * 1000);

  // Staff certification expiry -- staged notices to the staff member and the
  // Clinical Director. Runs on boot and then daily. Each stage sends at most
  // once per certification per expiration date, so a restart cannot re-send.
  people.certificationSweep().catch((e) => console.error("Certification sweep failed:", e));
  setInterval(() => {
    people.certificationSweep().catch((e) => console.error("Certification sweep failed:", e));
  }, 24 * 60 * 60 * 1000);

  // Scheduling: flip sessions whose end time has passed to completed (which is
  // what raises "session note required"), and keep open-ended recurring series
  // materialised a few months ahead. Every 10 minutes so the Day board is live.
  const schedSweep = () => {
    scheduling.sweepEndedSessions().catch((e) => console.error("Session sweep failed:", e));
    scheduling.extendOpenSeries().catch((e) => console.error("Series extension failed:", e));
  };
  schedSweep();
  setInterval(schedSweep, 10 * 60 * 1000);

  // Onboarding deadlines: nudge a day out, flag when the time is up. The CRM
  // never rescinds an offer -- it tells a person the clock ran out.
  onboarding.deadlineSweep().catch((e) => console.error("Onboarding sweep failed:", e));
  setInterval(() => {
    onboarding.deadlineSweep().catch((e) => console.error("Onboarding sweep failed:", e));
  }, 60 * 60 * 1000);

  // Rethink refresh. Every 4 hours -- six passes a day, which keeps the
  // month-to-date figure live without hammering an API whose rate limits we
  // have not been told. Both syncs are cheap when nothing has changed.
  setInterval(rethinkSweep, 4 * 60 * 60 * 1000);

  // Daily authorization-expiration check (also runs once on boot above).
  setInterval(() => {
    authAlerts.checkAuthExpirations().catch((e) => console.error("Auth expiration sweep failed:", e));
  }, 24 * 60 * 60 * 1000);

  // ClickUp Financial Center sync, every 15 minutes (also runs once on boot
  // above). Harmless no-op (logs a clear "not configured" sync-log entry)
  // until an admin saves a ClickUp Personal API Token under Financial Center
  // -> Integration Settings.
  setInterval(() => {
    clickupIntegration.syncNow("scheduled").catch((e) => console.error("ClickUp sync failed:", e));
  }, 15 * 60 * 1000);

  // HR recruiting follow-up sequences: send any due warm follow-ups.
  setInterval(() => {
    hr.processFollowups().catch((e) => console.error("HR follow-up sweep failed:", e));
  }, 15 * 60 * 1000);

  // HR interview reminders: send 24h / 2h reminders for upcoming interviews.
  setInterval(() => {
    hr.processReminders().catch((e) => console.error("HR interview reminder sweep failed:", e));
  }, 15 * 60 * 1000);

  // HR daily recruiting summary: fires once/day at the configured UTC hour.
  setInterval(() => {
    hr.processDailySummary().catch((e) => console.error("HR daily summary failed:", e));
  }, 15 * 60 * 1000);

  // HR credential expiration alerts: once/day, notify on soon-to-expire creds.
  setInterval(() => {
    hr.processCredentialAlerts().catch((e) => console.error("HR credential alert sweep failed:", e));
  }, 15 * 60 * 1000);

  // HR document tracker follow-ups (3-day requested / 60-day RBT renewal), also on boot.
  hr.processHrDocFollowups().catch((e) => console.error("HR doc follow-up sweep failed:", e));
  setInterval(() => {
    hr.processHrDocFollowups().catch((e) => console.error("HR doc follow-up sweep failed:", e));
  }, 6 * 60 * 60 * 1000);

  // HR 30/60/90-day onboarding milestone emails, also on boot.
  hr.processHrMilestones().catch((e) => console.error("HR milestone sweep failed:", e));
  setInterval(() => {
    hr.processHrMilestones().catch((e) => console.error("HR milestone sweep failed:", e));
  }, 6 * 60 * 60 * 1000);

  // Daily completion digest. Checked every 20 minutes rather than scheduled
  // for one exact moment, because the process restarts on every deploy and a
  // once-a-day timer would simply never fire in a week with a few pushes.
  // maybeSendDaily() holds the once-per-day rule itself, keyed on the date it
  // last actually sent, so extra checks cost nothing.
  setInterval(() => {
    completions.maybeSendDaily().catch((e) => console.error("Completion digest failed:", e));
  }, 20 * 60 * 1000);

  server.listen(PORT, () => {
    console.log(`Spectrum Squad CRM running at http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
