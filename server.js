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
`;

async function initSchema() {
  await pool.query(SCHEMA_SQL);
  await pool.query(MIGRATIONS_SQL);
  console.log("Postgres schema ready.");
}

function nowISO() {
  return new Date().toISOString();
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

async function sendEmail({ to, subject, html, clientId = null, type = "parent_milestone" }) {
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
        body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
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

  await dbRun(
    `INSERT INTO notifications_log (client_id, type, recipient, subject, body, sent_at, delivered)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [clientId, type, to, subject, html, nowISO(), delivered + (errorMsg ? `: ${errorMsg}` : "")]
  );

  return { delivered, errorMsg };
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

const EMAIL_TEMPLATE_EDIT_ROLES = ["admin"];

function canEditEmailTemplates(user) {
  return !!user && EMAIL_TEMPLATE_EDIT_ROLES.includes(user.role);
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
  { key: "assessment_scheduling", label: "Assessment (Vineland/Intake)", color: "#29225c" },
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

  await dbRun("UPDATE clients SET stage = ?, updated_at = ? WHERE id = ?", [stageKey, nowISO(), clientId]);

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

const pipeline = { STAGES, STAGE_ORDER, nextStageKey, getStage, enterStage, completeTask, checkOverdueTasks, sendParentMilestone };

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
const FINANCIAL_VIEW_ROLES = ["admin", "billing", "clinical"];
const FINANCIAL_EDIT_ROLES = ["admin", "billing"];
const FINANCIAL_ADMIN_ROLES = ["admin"];

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
  return dbGet("SELECT * FROM clients WHERE id = ?", [row.id]);
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

    // ---------- TASKS ----------
    if (pathname === "/api/tasks" && method === "GET") {
      const tasks = await dbAll(
        `SELECT ct.*, st.label, st.stage_key, c.child_name, d.name AS department_name, d.color AS department_color
         FROM client_tasks ct
         JOIN stage_tasks st ON st.id = ct.stage_task_id
         JOIN clients c ON c.id = ct.client_id
         JOIN departments d ON d.id = st.department_id
         WHERE ct.status != 'completed'
         ORDER BY ct.due_date ASC`
      );
      return json(res, 200, tasks);
    }

    const completeTaskMatch = pathname.match(/^\/api\/tasks\/(\d+)\/complete$/);
    if (completeTaskMatch && method === "POST") {
      const result = await pipeline.completeTask(completeTaskMatch[1], user.id);
      return json(res, result.ok ? 200 : 400, result);
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
      return json(
        res,
        200,
        await dbAll("SELECT * FROM notifications_log ORDER BY sent_at DESC LIMIT 100")
      );
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
  await ensureSeeded();
  await pipeline.checkOverdueTasks();
  await authAlerts.checkAuthExpirations().catch((e) => console.error("Auth expiration sweep failed:", e));
  await clickupIntegration.syncNow("scheduled").catch((e) => console.error("ClickUp sync failed:", e));

  setInterval(() => {
    pipeline.checkOverdueTasks().catch((e) => console.error("Overdue sweep failed:", e));
  }, 30 * 60 * 1000);

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

  server.listen(PORT, () => {
    console.log(`Spectrum Squad CRM running at http://localhost:${PORT}`);
    console.log(`Demo login: admin@spectrumsquadlv.com / ChangeMe123!`);
  });
}

start().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
