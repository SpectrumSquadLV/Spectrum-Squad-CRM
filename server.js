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
// use/need TLS. Any other host (e.g. the public proxy) does.
const needsSSL = DATABASE_URL && !DATABASE_URL.includes("railway.internal");

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
  next_stage_key TEXT
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
`;

// Small forward-compatible migrations for columns/tables added after the
// database already existed in production. Safe to run every boot.
const MIGRATIONS_SQL = `
ALTER TABLE client_documents ALTER COLUMN file_path DROP NOT NULL;
ALTER TABLE client_documents ADD COLUMN IF NOT EXISTS doc_type TEXT NOT NULL DEFAULT 'hosted';
ALTER TABLE client_documents ADD COLUMN IF NOT EXISTS external_url TEXT;

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
ALTER TABLE clients ADD COLUMN IF NOT EXISTS diagnosis_uploaded BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS insurance_card_uploaded BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS clinical_screener_completed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS insurance_verification_completed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS intake_packet_sent BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS intake_packet_returned BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS vineland_completed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS intake_assessment_scheduled_date TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS intake_assessment_completed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS authorization_submitted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS previous_provider_discharge_letter_received BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS physician_referral_received BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS additional_insurance_docs_received BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS rethink_client_created BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS assigned_rbt_name TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS schedule_finalized BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS stage_entered_at TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS assigned_intake_coordinator_name TEXT;
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
-- Rename the old Vineland stage task to the In-Clinic Assessment.
UPDATE stage_tasks SET label = 'Schedule In-Clinic Assessment' WHERE stage_key = 'assessment_scheduling' AND label = 'Schedule Vineland / Intake Assessment';
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_view_financials BOOLEAN NOT NULL DEFAULT false;

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

async function sendEmail({ to, subject, html, clientId = null, type = "parent_milestone", attachments = null }) {
  const { delivered, errorMsg } = await deliverEmail({ to, subject, html, attachments });

  await dbRun(
    `INSERT INTO notifications_log (client_id, type, recipient, subject, body, sent_at, delivered)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [clientId, type, to, subject, html, nowISO(), delivered + (errorMsg ? `: ${errorMsg}` : "")]
  );

  return { delivered, errorMsg };
}

// ---- Benefits & Eligibility Check -----------------------------------------
// When a new patient enrolls, send the billing/verification contact the info
// they need to run an eligibility check: child name, DOB, insurance details,
// and the insurance card itself (attached when a card image is on file). The
// recipient address is owner-configurable in Admin Settings.
function looksLikeInsuranceCard(doc) {
  const s = `${doc.label || ""} ${doc.filename || ""}`.toLowerCase();
  return /insur|card|member|benefit|policy/.test(s);
}

async function sendEligibilityCheck(client, actor) {
  const to = await getAppSetting("eligibility_check_email", "");
  if (!to) {
    console.log("Eligibility check email skipped: no recipient configured.");
    return { ok: false, error: "No recipient configured" };
  }

  const docs = await dbAll("SELECT * FROM client_documents WHERE client_id = ?", [client.id]);
  const cardDocs = docs.filter(looksLikeInsuranceCard);
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
        console.error("Could not attach insurance card:", e.message);
      }
    } else if (d.doc_type === "link" && d.external_url) {
      linkCards.push(d);
    }
  }

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const row = (label, val) => `<tr><td style="padding:6px 12px;color:#555;">${label}</td><td style="padding:6px 12px;font-weight:600;">${esc(val || "—")}</td></tr>`;
  const cardNote = attachments.length
    ? `<p>The insurance card ${attachments.length > 1 ? "images are" : "image is"} attached to this email.</p>`
    : linkCards.length
    ? `<p>Insurance card link(s): ${linkCards.map((d) => `<a href="${esc(d.external_url)}">${esc(d.label || d.filename)}</a>`).join(", ")}</p>`
    : `<p><em>No insurance card image is on file yet. Once it's uploaded to the client's record, you can re-send this from the CRM.</em></p>`;

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#222;">
      <h2 style="color:#29225c;">Benefits &amp; Eligibility Check</h2>
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
  await logFinancialAudit(
    actor || "system",
    "eligibility_check_sent",
    `client=${client.id} to=${to} attachments=${attachments.length} result=${result.delivered}`
  ).catch(() => {});
  return { ok: result.delivered !== "failed", ...result, attachments: attachments.length };
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
  { key: "admin", label: "Admin", privileged: false, description: "Manage clients, staff, settings, and email templates. Sees authorization and financial data." },
  { key: "intake", label: "Intake / Admin", privileged: false, description: "Works the enrollment pipeline: new leads, intake packets, and family communication." },
  { key: "clinical", label: "Clinical (BCBA)", privileged: false, description: "Clinical stage tasks, authorization alerts, and assessment scheduling." },
  { key: "billing", label: "Billing / Insurance", privileged: false, description: "Insurance verification, authorizations, and financial data." },
  { key: "scheduling", label: "Scheduling", privileged: false, description: "Therapy scheduling and first-day coordination." },
  { key: "hr_admin", label: "HR Admin", privileged: false, description: "Full access to the HR & Recruiting area, including sensitive hiring info." },
  { key: "hiring_manager", label: "Hiring Manager", privileged: false, description: "HR & Recruiting: requisitions, candidates, and the hiring pipeline." },
  { key: "interviewer", label: "Interviewer", privileged: false, description: "HR & Recruiting: view assigned candidates and interviews only." },
];
const VALID_ROLE_KEYS = ROLE_CATALOG.map((r) => r.key);

function canManageUsers(user) {
  return !!user && USER_ADMIN_ROLES.includes(user.role);
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
    key: "milestone_first_day_scheduled",
    label: "Ready to Schedule First Day",
    category: "Parent Milestone Emails",
    description: "Sent to the parent once authorization is in and scheduling can begin.",
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
];

// The CRM's original built-in copy -- used both as the seed data and as a
// last-resort fallback if a template row is somehow missing.
const EMAIL_TEMPLATE_DEFAULTS = {
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
};

async function seedEmailTemplates() {
  for (const def of EMAIL_TEMPLATE_DEFS) {
    const defaults = EMAIL_TEMPLATE_DEFAULTS[def.key];
    await dbRun(
      `INSERT INTO email_templates (template_key, label, category, subject_template, body_template, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, 'system', ?)
       ON CONFLICT (template_key) DO NOTHING`,
      [def.key, def.label, def.category, defaults.subject, defaults.body, nowISO()]
    );
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
    days_remaining: 30,
    assigned_bcba_name: "Allie R.",
    authorization_status: "Approved",
    client_link: `${APP_BASE_URL}/#/pipeline/123`,
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
  { key: "insurance_verification", label: "Insurance Verification", color: "#6660a8" },
  { key: "intake_packet", label: "Intake Packet", color: "#5fa8a0" },
  { key: "assessment_scheduling", label: "In-Clinic Assessment", color: "#29225c" },
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
async function enterStage(clientId, stageKey) {
  const client = await dbGet("SELECT * FROM clients WHERE id = ?", [clientId]);
  if (!client) return;

  await dbRun("UPDATE clients SET stage = ?, updated_at = ?, stage_entered_at = ? WHERE id = ?", [stageKey, nowISO(), nowISO(), clientId]);

  const tasks = await dbAll("SELECT * FROM stage_tasks WHERE stage_key = ?", [stageKey]);
  for (const task of tasks) {
    const dueDate = addBusinessDays(new Date(), task.sla_days).toISOString();
    await dbRun(
      `INSERT INTO client_tasks (client_id, stage_task_id, status, due_date, created_at)
       VALUES (?, ?, 'pending', ?, ?)`,
      [clientId, task.id, dueDate, nowISO()]
    );

    const dept = await dbGet("SELECT * FROM departments WHERE id = ?", [task.department_id]);
    if (dept && dept.notify_email) {
      const template = await emailTemplates.getEmailTemplate("department_alert");
      const fields = {
        dept_name: dept.name,
        child_name: client.child_name,
        parent_name: client.parent_name,
        stage_label: getStage(stageKey)?.label,
        task_label: task.label,
        due_date: new Date(dueDate).toLocaleDateString(),
      };
      sendEmail({
        to: dept.notify_email,
        subject: emailTemplates.renderMergeFields(template.subject_template, fields),
        html: emailTemplates.renderMergeFields(template.body_template, fields),
        clientId,
        type: "department_alert",
      }).catch((e) => console.error("sendEmail failed:", e));
    }
  }

  await sendParentMilestone(client, stageKey);
}

// Stages that trigger a parent-facing milestone email. Each maps to a
// "milestone_<stageKey>" row in the email_templates table (editable under
// Settings -> Email Templates).
const MILESTONE_STAGE_KEYS = ["new_submission", "intake_packet", "authorization", "first_day_scheduled", "active"];

async function sendParentMilestone(client, stageKey) {
  if (!MILESTONE_STAGE_KEYS.includes(stageKey) || !client.parent_email) return;
  const template = await emailTemplates.getEmailTemplate(`milestone_${stageKey}`);
  if (!template) return;
  const fields = {
    parent_name: client.parent_name,
    child_name: client.child_name,
    today: new Date().toLocaleDateString(),
  };
  await sendEmail({
    to: client.parent_email,
    subject: emailTemplates.renderMergeFields(template.subject_template, fields),
    html: emailTemplates.renderMergeFields(template.body_template, fields),
    clientId: client.id,
    type: "parent_milestone",
  }).catch((e) => console.error("sendEmail failed:", e));
}

async function completeTask(taskId, completedByUserId) {
  const task = await dbGet("SELECT * FROM client_tasks WHERE id = ?", [taskId]);
  if (!task) return { ok: false, error: "Task not found" };

  await dbRun("UPDATE client_tasks SET status = 'completed', completed_at = ? WHERE id = ?", [nowISO(), taskId]);

  // If all tasks for the client's current stage are complete, auto-advance.
  const client = await dbGet("SELECT * FROM clients WHERE id = ?", [task.client_id]);
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
    if (next) await enterStage(client.id, next);
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
    `SELECT ct.*, st.label, st.department_id, c.child_name, c.parent_name
     FROM client_tasks ct
     JOIN stage_tasks st ON st.id = ct.stage_task_id
     JOIN clients c ON c.id = ct.client_id
     WHERE ct.status = 'pending' AND ct.due_date < ? AND ct.overdue_notified_at IS NULL`,
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
async function processAssessmentReminders() {
  const clients = await dbAll(
    `SELECT * FROM clients
      WHERE stage = 'assessment_scheduling'
        AND (in_clinic_assessment_date IS NULL OR in_clinic_assessment_date = '')
        AND parent_email IS NOT NULL AND parent_email <> ''`
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
// ============================== PIPELINE V2 (MILESTONE DASHBOARD) ==============================
// Computes the 6-milestone view (New Lead, Intake & Eligibility, Clinical
// Assessment, Authorization, Ready to Start, Active Services) on top of the
// existing 10-value `stage` column, plus per-client progress %, missing
// checklist items, blocker category, owner, and next action. Read-only --
// does not change how `stage` itself is stored or advanced.
"use strict";

const MILESTONES = [
  { key: 1, label: "New Lead", stages: ["new_submission"] },
  { key: 2, label: "Intake & Eligibility", stages: ["clinical_screener", "insurance_verification", "intake_packet"] },
  { key: 3, label: "Clinical Assessment", stages: ["assessment_scheduling"] },
  { key: 4, label: "Authorization", stages: ["authorization"] },
  { key: 5, label: "Ready to Start", stages: ["first_day_scheduled"] },
  { key: 6, label: "Active Services", stages: ["active"] },
];

function milestoneForStage(stageKey) {
  if (stageKey === "discharged" || stageKey === "not_moving_forward") return null;
  const m = MILESTONES.find((m) => m.stages.includes(stageKey));
  return m ? m.key : 1;
}

const MILESTONE_CHECKLISTS = {
  1: [
    { key: "diagnosis_uploaded", label: "Diagnosis uploaded", blocker: "parent" },
    { key: "insurance_card_uploaded", label: "Insurance card uploaded", blocker: "parent" },
    { key: "clinical_screener_completed", label: "Clinical screener", blocker: "clinical" },
  ],
  2: [
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

  let owner;
  if (milestone <= 2) owner = client.assigned_intake_coordinator_name || "Unassigned";
  else owner = client.assigned_bcba_name || "Unassigned";

  const enteredAt = client.stage_entered_at || client.updated_at || client.submitted_at;
  const daysInStage = enteredAt ? Math.max(0, Math.floor((Date.now() - new Date(enteredAt).getTime()) / 86400000)) : 0;

  let priority = "Low";
  if (missing.length >= 3 || daysInStage >= 14) priority = "High";
  else if (missing.length >= 1 || daysInStage >= 7) priority = "Medium";

  const nextAction = missing.length
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

async function signNowRequest(path, options = {}) {
  const res = await fetch(`${SIGNNOW_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${SIGNNOW_API_KEY}`,
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
    throw new Error(`SignNow ${path} failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function sendEnrollmentPacket(client) {
  if (!SIGNNOW_API_KEY || !SIGNNOW_ENROLLMENT_TEMPLATE_ID) {
    console.error("SignNow not configured -- skipping enrollment packet for client", client.id);
    return;
  }
  if (!client.parent_email) {
    console.error("No parent_email on file -- skipping enrollment packet for client", client.id);
    return;
  }
  try {
    const copy = await signNowRequest(`/template/${SIGNNOW_ENROLLMENT_TEMPLATE_ID}/copy`, {
      method: "POST",
      body: JSON.stringify({ document_name: `Enrollment Packet - ${client.child_name}` }),
    });
    const documentId = copy.id;
    await signNowRequest(`/document/${documentId}/invite`, {
      method: "POST",
      body: JSON.stringify({
        to: [{ email: client.parent_email, role: "Recipient 1", order: 1 }],
        from: SIGNNOW_SENDER_EMAIL,
        subject: `Please complete ${client.child_name}'s enrollment packet — Spectrum Squad`,
        message: `Hi ${client.parent_name || "there"}, thank you for choosing Spectrum Squad! Please review and complete ${client.child_name}'s New Patient Enrollment Packet using the link below. If you have any questions, just reply to this email.`,
      }),
    });
    await dbRun(
      `INSERT INTO enrollment_packets (client_id, signnow_document_id, status, sent_at)
       VALUES (?, ?, 'sent', ?)
       ON CONFLICT (client_id) DO NOTHING`,
      [client.id, documentId, nowISO()]
    );
    console.log(`Enrollment packet sent to ${client.parent_email} for client ${client.id}`);
  } catch (err) {
    console.error("Failed to send enrollment packet for client", client.id, err.message);
  }
}

async function checkEnrollmentPackets() {
  if (!SIGNNOW_API_KEY) return;
  const pending = await dbAll("SELECT * FROM enrollment_packets WHERE status = 'sent'");
  const now = Date.now();

  for (const packet of pending) {
    let signNowStatus = null;
    try {
      const doc = await signNowRequest(`/document/${packet.signnow_document_id}`);
      const invites = doc.field_invites || doc.requests || [];
      if (invites.some((i) => String(i.status).toLowerCase() === "fulfilled")) {
        signNowStatus = "completed";
      } else if (invites.some((i) => String(i.status).toLowerCase() === "declined")) {
        signNowStatus = "declined";
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
      continue;
    }

    const sentAt = new Date(packet.sent_at).getTime();
    const daysSinceSent = (now - sentAt) / (1000 * 60 * 60 * 24);

    if (daysSinceSent >= 7) {
      const client = await dbGet("SELECT * FROM clients WHERE id = ?", [packet.client_id]);
      if (client && client.stage !== "not_moving_forward" && client.stage !== "discharged") {
        await dbRun(
          "UPDATE clients SET stage = 'not_moving_forward', discharge_reason = ?, updated_at = ? WHERE id = ?",
          ["Enrollment packet not completed within 7 days", nowISO(), client.id]
        );
      }
      await dbRun("UPDATE enrollment_packets SET status = 'expired' WHERE id = ?", [packet.id]);
      continue;
    }

    const lastReminder = packet.last_reminder_at ? new Date(packet.last_reminder_at).getTime() : sentAt;
    const hoursSinceReminder = (now - lastReminder) / (1000 * 60 * 60);
    if (hoursSinceReminder >= 24) {
      const client = await dbGet("SELECT * FROM clients WHERE id = ?", [packet.client_id]);
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
}, 30 * 1000);
setInterval(() => {
  checkEnrollmentPackets().catch((e) => console.error("checkEnrollmentPackets failed:", e));
}, 60 * 60 * 1000);

// ============================== AUTHORIZATION ALERTS ==============================
// server/authAlerts.js
// Tracks each client's insurance authorization window and fires escalating
// internal + email alerts as the expiration date approaches, so nobody
// discovers an authorization has lapsed by accident.
"use strict";

const AUTH_MILESTONES = [60, 30, 14, 7, 0]; // days-before-expiration thresholds
const AUTH_ALERT_LEVELS = { 60: "informational", 30: "attention", 14: "urgent", 7: "critical", 0: "overdue" };
const APP_BASE_URL = (process.env.APP_BASE_URL || "https://web4-production-16ed.up.railway.app").replace(/\/$/, "");

// Roles allowed to view authorization/insurance fields at all. Any role not
// in this list (e.g. intake, scheduling, and any future RBT login) never
// receives these fields in API responses -- least-privilege by default.
const AUTH_VIEW_ROLES = ["admin", "billing", "clinical"];
// Roles allowed to fully create/edit authorization fields + manage alerts.
const AUTH_EDIT_ROLES = ["admin", "billing"];

const AUTH_FIELDS = [
  "insurance_payer",
  "auth_start_date",
  "auth_expiration_date",
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

      const recipients = [
        client.assigned_bcba_email,
        client.assigned_billing_email,
        process.env.AUTH_ALERT_ADMIN_EMAIL || "admin@spectrumsquadlv.com",
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

const PUBLIC_ROUTES = new Set([
  "/api/auth/login",
  "/api/webhook/enrollment",
  "/api/admin/backfill-import",
  "/api/admin/purge-demo",
  "/api/admin/upload-document",
  "/api/admin/delete-document",
]);

const CLIENT_COLOR_PALETTE = ["#5fa8a0", "#e0a430", "#6660a8", "#3f8f89", "#c98a1b", "#8d85c8"];

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
  sendEligibilityCheck(client, "system").catch((e) => console.error("sendEligibilityCheck failed:", e));
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

// Returns true if the route was handled.
async function handle(req, res, pathname, method, query = {}) {
  if (!pathname.startsWith("/api/")) return false;

  const cookies = auth.parseCookies(req);
  const user = await auth.getUserFromToken(cookies.session);
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

  // Email images are embedded in emails opened by parents/staff in their own
  // mail client (no session cookie present), so this one path must stay
  // publicly readable regardless of the generated filename.
  const isPublicEmailImage = pathname.startsWith("/api/email-templates/images/");

  if (!PUBLIC_ROUTES.has(pathname) && !isPublicEmailImage && !user) {
    json(res, 401, { error: "Not authenticated" });
    return true;
  }

  try {
    // ---------- AUTH ----------
    if (pathname === "/api/auth/login" && method === "POST") {
      const { email, password } = await readBody(req);
      const result = await auth.login(email || "", password || "");
      if (!result) return json(res, 401, { error: "Invalid email or password" });
      res.setHeader(
        "Set-Cookie",
        `session=${result.token}; HttpOnly; Path=/; Max-Age=${12 * 3600}; SameSite=Lax`
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
      const overdue = (await dbGet("SELECT COUNT(*) AS n FROM client_tasks WHERE status = 'overdue'")).n;
      const pending = (await dbGet("SELECT COUNT(*) AS n FROM client_tasks WHERE status = 'pending'")).n;
      const today = new Date().toISOString().slice(0, 10);
      const upcomingFirstDays = await dbAll(
        "SELECT id, child_name, first_day_date FROM clients WHERE first_day_date IS NOT NULL AND first_day_date >= ? ORDER BY first_day_date LIMIT 5",
        [today]
      );
      const totalClients = (await dbGet("SELECT COUNT(*) AS n FROM clients")).n;

      let authCounts = null;
      if (authAlerts.canViewAuth(user)) {
        const activeAuths = await dbAll(
          "SELECT auth_expiration_date FROM clients WHERE authorization_status != 'Not Required' AND auth_expiration_date IS NOT NULL"
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

      return json(res, 200, {
        byStage,
        overdue,
        pending,
        upcomingFirstDays,
        totalClients,
        stages: pipeline.STAGES,
        authCounts,
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
      for (const c of list) {
        if (!c.child_name) continue;
        const client = await createClientBackfill(c);
        results.push({ id: client.id, child_name: client.child_name, stage: client.stage });
      }
      return json(res, 201, { imported: results.length, results });
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
      const client = await dbGet("SELECT id FROM clients WHERE id = ?", [client_id]);
      if (!client) return json(res, 404, { error: "Client not found" });

      if (content_base64) {
        const safeName = String(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
        const storedName = `${client_id}_${crypto.randomBytes(6).toString("hex")}_${safeName}`;
        const fullPath = path.join(DOCS_DIR, storedName);
        let buffer;
        try {
          buffer = Buffer.from(content_base64, "base64");
        } catch (e) {
          return json(res, 400, { error: "Invalid base64 content" });
        }
        fs.writeFileSync(fullPath, buffer);

        const row = await dbGet(
          `INSERT INTO client_documents (client_id, label, filename, mime_type, file_path, doc_type, external_url, uploaded_at)
           VALUES (?, ?, ?, ?, ?, 'hosted', NULL, ?) RETURNING id`,
          [client_id, label || filename, filename, mime_type || "application/octet-stream", storedName, nowISO()]
        );
        return json(res, 201, { id: row.id, client_id: Number(client_id), filename, label: label || filename, doc_type: "hosted" });
      } else {
        const row = await dbGet(
          `INSERT INTO client_documents (client_id, label, filename, mime_type, file_path, doc_type, external_url, uploaded_at)
           VALUES (?, ?, ?, ?, NULL, 'link', ?, ?) RETURNING id`,
          [client_id, label || filename, filename, mime_type || null, external_url, nowISO()]
        );
        return json(res, 201, { id: row.id, client_id: Number(client_id), filename, label: label || filename, doc_type: "link" });
      }
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
      const doc = await dbGet("SELECT * FROM client_documents WHERE id = ?", [downloadDocMatch[1]]);
      if (!doc) return json(res, 404, { error: "Not found" });
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

      const setClause = fields.map((f) => `${f} = ?`).join(", ");
      await dbRun(`UPDATE clients SET ${setClause}, updated_at = ? WHERE id = ?`, [
        ...fields.map((f) => body[f]),
        nowISO(),
        id,
      ]);
      const updated = await dbGet("SELECT * FROM clients WHERE id = ?", [id]);
      return json(res, 200, authAlerts.sanitizeClientForRole(user, updated));
    }

    const clientMatch = pathname.match(/^\/api\/clients\/(\d+)$/);
    if (clientMatch && method === "GET") {
      const id = clientMatch[1];
      const client = await dbGet("SELECT * FROM clients WHERE id = ?", [id]);
      if (!client) return json(res, 404, { error: "Not found" });
      const tasks = await dbAll(
        `SELECT ct.*, st.label, st.stage_key, d.name AS department_name, d.color AS department_color
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
      const notifications = await dbAll(
        "SELECT * FROM notifications_log WHERE client_id = ? ORDER BY sent_at DESC",
        [id]
      );
      const documents = await dbAll(
        "SELECT id, label, filename, mime_type, doc_type, external_url, uploaded_at FROM client_documents WHERE client_id = ? ORDER BY uploaded_at",
        [id]
      );
      return json(res, 200, {
        client: authAlerts.sanitizeClientForRole(user, client),
        tasks,
        sessions,
        notifications,
        documents,
      });
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

    const dischargeMatch = pathname.match(/^\/api\/clients\/(\d+)\/discharge$/);
    if (dischargeMatch && method === "POST") {
      const id = dischargeMatch[1];
      const { reason, stage } = await readBody(req);
      await dbRun(
        "UPDATE clients SET stage = ?, discharge_reason = ?, updated_at = ? WHERE id = ?",
        [stage || "discharged", reason || null, nowISO(), id]
      );
      return json(res, 200, await dbGet("SELECT * FROM clients WHERE id = ?", [id]));
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
      const label = (body.label || body.filename || "Document").trim();
      if (body.external_url) {
        const row = await dbGet(
          `INSERT INTO client_documents (client_id, label, filename, mime_type, file_path, doc_type, external_url, uploaded_at)
           VALUES (?, ?, ?, ?, NULL, 'link', ?, ?) RETURNING id`,
          [id, label, body.filename || body.external_url, body.mime_type || null, body.external_url, nowISO()]
        );
        return json(res, 201, { id: row.id, doc_type: "link" });
      }
      if (!body.content_base64 || !body.filename) {
        return json(res, 400, { error: "A file (or a link) is required." });
      }
      let buffer;
      try {
        buffer = Buffer.from(body.content_base64, "base64");
      } catch (e) {
        return json(res, 400, { error: "Invalid file data." });
      }
      if (buffer.length > 15 * 1024 * 1024) return json(res, 400, { error: "File is too large (15MB max)." });
      const safeName = String(body.filename).replace(/[^a-zA-Z0-9._-]/g, "_");
      const storedName = `${id}_${crypto.randomBytes(6).toString("hex")}_${safeName}`;
      try {
        fs.writeFileSync(path.join(DOCS_DIR, storedName), buffer);
      } catch (e) {
        return json(res, 500, { error: "Could not save file." });
      }
      const row = await dbGet(
        `INSERT INTO client_documents (client_id, label, filename, mime_type, file_path, doc_type, external_url, uploaded_at)
         VALUES (?, ?, ?, ?, ?, 'hosted', NULL, ?) RETURNING id`,
        [id, label, body.filename, body.mime_type || "application/octet-stream", storedName, nowISO()]
      );
      return json(res, 201, { id: row.id, doc_type: "hosted" });
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
    const setClause = fields.map((f) => `${f} = ?`).join(", ");
    await dbRun(`UPDATE clients SET ${setClause}, updated_at = ? WHERE id = ?`, [...fields.map((f) => body[f]), nowISO(), id]);
    const updated = await dbGet("SELECT * FROM clients WHERE id = ?", [id]);
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

      const owner = await auth.findUserByEmail("admin@spectrumsquadlv.com");
      if (!owner || !verifyPassword(password, owner.password_salt, owner.password_hash)) {
        return json(res, 403, { error: "Incorrect password" });
      }

      const client = await dbGet("SELECT * FROM clients WHERE id = ?", [clientId]);
      if (!client) return json(res, 404, { error: "Not found" });

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
    if (pathname === "/api/tasks" && method === "GET") {
      const showAll = query.status === "all";
      const tasks = await dbAll(
        `SELECT ct.*, st.label, st.stage_key, c.child_name, d.name AS department_name, d.color AS department_color
         FROM client_tasks ct
         JOIN stage_tasks st ON st.id = ct.stage_task_id
         JOIN clients c ON c.id = ct.client_id
         JOIN departments d ON d.id = st.department_id
         ${showAll ? "" : "WHERE ct.status != 'completed'"}
         ORDER BY ct.due_date ASC`
      );
      return json(res, 200, tasks);
    }

    const completeTaskMatch = pathname.match(/^\/api\/tasks\/(\d+)\/complete$/);
    if (completeTaskMatch && method === "POST") {
      const result = await pipeline.completeTask(completeTaskMatch[1], user.id);
      return json(res, result.ok ? 200 : 400, result);
    }

    const reopenTaskMatch = pathname.match(/^\/api\/tasks\/(\d+)\/reopen$/);
    if (reopenTaskMatch && method === "POST") {
      const id = reopenTaskMatch[1];
      const task = await dbGet("SELECT * FROM client_tasks WHERE id = ?", [id]);
      if (!task) return json(res, 404, { error: "Not found" });
      await dbRun(
        "UPDATE client_tasks SET status = 'pending', completed_at = NULL, overdue_notified_at = NULL WHERE id = ?",
        [id]
      );
      return json(res, 200, { ok: true });
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
          await dbRun(
            "UPDATE client_tasks SET status = 'pending', completed_at = NULL, overdue_notified_at = NULL WHERE id = ?",
            [id]
          );
          results.push({ ok: true });
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
      // The Message Outbox is private to the owner (and a co-owner super admin).
      if (!user || !["owner", "super_admin"].includes(user.role)) {
        return json(res, 403, { error: "Not permitted to view the message outbox" });
      }
      return json(
        res,
        200,
        await dbAll("SELECT * FROM notifications_log ORDER BY sent_at DESC LIMIT 100")
      );
    }

    // Manually (re)send the Benefits & Eligibility Check for a client -- used
    // once the insurance card has been uploaded, so billing gets the attachment.
    const eligibilityMatch = pathname.match(/^\/api\/clients\/(\d+)\/eligibility-check$/);
    if (eligibilityMatch && method === "POST") {
      const client = await dbGet("SELECT * FROM clients WHERE id = ?", [eligibilityMatch[1]]);
      if (!client) return json(res, 404, { error: "Not found" });
      const result = await sendEligibilityCheck(client, user.email);
      if (!result.ok && result.error) return json(res, 400, result);
      return json(res, 200, result);
    }

    const notifResendMatch = pathname.match(/^\/api\/notifications\/(\d+)\/resend$/);
    if (notifResendMatch && method === "POST") {
      // Outbox is owner-only; resending from it is too.
      if (!user || !["owner", "super_admin"].includes(user.role)) {
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
      const html = `
        <p>Hi ${client.parent_name || "there"},</p>
        <p>We wanted to reach out regarding <strong>${client.child_name}</strong>'s attendance. Based on our records, their current session attendance rate is <strong>${pct}%</strong>, which is below the level needed to maintain consistent progress and insurance authorization.</p>
        <p>Missed sessions can affect ${client.child_name}'s treatment progress and may put continued authorization at risk. We ask that you please help ensure ${client.child_name} attends all scheduled sessions going forward.</p>
        <p>Please reply to this email to let us know you've received this message, or reach out if you'd like to discuss scheduling.</p>
        <p>Thank you,<br/>Spectrum Squad</p>
      `;

      const result = await sendEmail({
        to: client.parent_email,
        subject,
        html,
        clientId: id,
        type: "attendance_alert",
      });
      return json(res, 200, result);
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
      const n = await pipeline.checkOverdueTasks();
      return json(res, 200, { flagged: n });
    }

    if (pathname === "/api/admin/departments" && method === "PATCH") {
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
      });
    }
    if (pathname === "/api/admin/settings" && method === "PATCH") {
      if (!canManageUsers(user)) return json(res, 403, { error: "Not permitted" });
      const body = await readBody(req);
      if ("eligibility_check_email" in body) {
        const email = (body.eligibility_check_email || "").trim();
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          return json(res, 400, { error: "Please enter a valid email address." });
        }
        await setAppSetting("eligibility_check_email", email);
      }
      return json(res, 200, {
        eligibility_check_email: await getAppSetting("eligibility_check_email", ""),
      });
    }

    // ---------- Team / user management (owner, admin, super_admin) ----------
    if (pathname === "/api/admin/users" && method === "GET") {
      if (!canManageUsers(user)) return json(res, 403, { error: "Not permitted to manage users" });
      const rows = await dbAll(
        `SELECT id, name, email, role, department_id, can_view_financials, created_at
         FROM users ORDER BY created_at NULLS LAST, id`
      );
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
        "SELECT id, name, email, role, department_id, can_view_financials, created_at FROM users WHERE id = ?",
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

      if (!sets.length) return json(res, 400, { error: "Nothing to update." });
      params.push(targetId);
      await dbRun(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, params);
      const updated = await dbGet(
        "SELECT id, name, email, role, department_id, can_view_financials, created_at FROM users WHERE id = ?",
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
    { key: "clinical", name: "Clinical (BCBA)", color: "#29225c", notify_email: "clinical@spectrumsquadlv.com" },
    { key: "billing", name: "Billing / Insurance", color: "#e0a430", notify_email: "billing@spectrumsquadlv.com" },
    { key: "scheduling", name: "Scheduling", color: "#6660a8", notify_email: "scheduling@spectrumsquadlv.com" },
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
  const rows = [
    ["new_submission", "Welcome call / initial contact", "intake", 1, 1],
    ["clinical_screener", "Complete Clinical Screener", "clinical", 2, 1],
    ["insurance_verification", "Verify Insurance Benefits", "billing", 3, 1],
    ["intake_packet", "Send Intake Packet", "intake", 1, 1],
    ["assessment_scheduling", "Schedule Vineland / Intake Assessment", "clinical", 5, 1],
    ["authorization", "Submit Authorization Request", "billing", 3, 1],
    ["first_day_scheduled", "Schedule First Day of ABA", "scheduling", 5, 1],
  ];
  for (const [stage_key, label, deptKey, sla_days, sort_order] of rows) {
    const did = await deptId(deptKey);
    await dbRun(
      `INSERT INTO stage_tasks (stage_key, label, department_id, sla_days, sort_order)
       VALUES (?, ?, ?, ?, ?)`,
      [stage_key, label, did, sla_days, sort_order]
    );
  }
}

async function seedUsers() {
  if (await findUserByEmail("admin@spectrumsquadlv.com")) return;
  await createUser({
    name: "Quiana Blake",
    email: "admin@spectrumsquadlv.com",
    password: "ChangeMe123!",
    role: "admin",
    department_id: null,
  });
  await createUser({
    name: "Intake Staff",
    email: "intake@spectrumsquadlv.com",
    password: "ChangeMe123!",
    role: "intake",
    department_id: await deptId("intake"),
  });
  await createUser({
    name: "Clinical Staff",
    email: "clinical@spectrumsquadlv.com",
    password: "ChangeMe123!",
    role: "clinical",
    department_id: await deptId("clinical"),
  });
  await createUser({
    name: "Billing Staff",
    email: "billing@spectrumsquadlv.com",
    password: "ChangeMe123!",
    role: "billing",
    department_id: await deptId("billing"),
  });
  await createUser({
    name: "Scheduling Staff",
    email: "scheduling@spectrumsquadlv.com",
    password: "ChangeMe123!",
    role: "scheduling",
    department_id: await deptId("scheduling"),
  });
}

async function seedTherapists() {
  const existing = await dbGet("SELECT COUNT(*) AS n FROM therapists");
  if (Number(existing.n) > 0) return;
  const rows = [
    ["Allie R.", "BCBA", "#29225c", 30],
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
      color: "#6660a8",
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
    const stagePath = ["new_submission", "clinical_screener", "insurance_verification", "intake_packet", "assessment_scheduling", "authorization", "first_day_scheduled", "active"];
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

function serveStatic(req, res, pathname) {
  if (pathname === "/server.js" || pathname === "/package.json") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  let filePath = pathname === "/" ? "/index.html" : pathname;
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
// ===== SCREENER add-on: clinical screener automation (send, remind, host, save) =====
const screener = require("./screener")({
  dbGet, dbAll, dbRun, sendEmail, nowISO, crypto, APP_BASE_URL, readBody, json, PUBLIC_DIR,
});
// ===== HR & RECRUITING add-on: job requisitions, applicant tracking, careers page =====
const hr = require("./hr")({
  dbGet, dbAll, dbRun, sendEmail, nowISO, crypto, APP_BASE_URL, readBody, json, sendFile, PUBLIC_DIR,
});
const clientForms = require("./client-forms")({
  dbGet, dbAll, dbRun, sendEmail, nowISO, crypto, APP_BASE_URL, readBody, json,
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

// SCREENER: serve the public form page at /screener/:token
  if (pathname === "/screener" || pathname.startsWith("/screener/")) {
    if (await screener.servePage(req, res, pathname)) return;
}

  // HR: serve the public careers + interview scheduling pages
  if (
    pathname === "/careers" || pathname.startsWith("/careers/") ||
    pathname.startsWith("/apply/") || pathname.startsWith("/schedule/") ||
    pathname.startsWith("/verify-timecard/") || pathname.startsWith("/offer/")
  ) {
    if (await hr.servePage(req, res, pathname)) return;
  }

  // Client-facing form pages (financial responsibility, etc.)
  if (pathname === "/financial-form" || pathname.startsWith("/financial-form/")) {
    if (await clientForms.servePage(req, res, pathname)) return;
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
  await hr.seed().catch((e) => console.error("HR seed failed:", e));
  await hr.processFollowups().catch((e) => console.error("HR follow-up sweep failed:", e));
  await hr.processReminders().catch((e) => console.error("HR interview reminder sweep failed:", e));
  await ensureSeeded();
  await pipeline.checkOverdueTasks();
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

  server.listen(PORT, () => {
    console.log(`Spectrum Squad CRM running at http://localhost:${PORT}`);
    console.log(`Demo login: admin@spectrumsquadlv.com / ChangeMe123!`);
  });
}

start().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
