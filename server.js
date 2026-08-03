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
  type TEXT NOT NULL, -- department_alert | parent_milestone | overdue_alert
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
`;

// Small forward-compatible migrations for columns added after the table
// already existed in production. Safe to run every boot.
const MIGRATIONS_SQL = `
ALTER TABLE client_documents ALTER COLUMN file_path DROP NOT NULL;
ALTER TABLE client_documents ADD COLUMN IF NOT EXISTS doc_type TEXT NOT NULL DEFAULT 'hosted';
ALTER TABLE client_documents ADD COLUMN IF NOT EXISTS external_url TEXT;
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
      sendEmail({
        to: dept.notify_email,
        subject: `[${dept.name}] Action needed: ${client.child_name} — ${task.label}`,
        html: `<p><strong>${client.child_name}</strong> (parent: ${client.parent_name}) has entered stage
          <strong>${getStage(stageKey)?.label}</strong> and needs: <strong>${task.label}</strong>.</p>
          <p>Due by: ${new Date(dueDate).toLocaleDateString()}</p>`,
        clientId,
        type: "department_alert",
      }).catch((e) => console.error("sendEmail failed:", e));
    }
  }

  await sendParentMilestone(client, stageKey);
}

const PARENT_MILESTONES = {
  new_submission: {
    subject: "We received your enrollment form — Spectrum Squad",
    html: (c) =>
      `<p>Hi ${c.parent_name},</p><p>Thanks for submitting your enrollment form for ${c.child_name}. Our intake team will reach out within 24-48 hours.</p>`,
  },
  intake_packet: {
    subject: "Your intake packet is on its way — Spectrum Squad",
    html: (c) =>
      `<p>Hi ${c.parent_name},</p><p>We're sending over ${c.child_name}'s intake packet. Please complete and return it so we can keep things moving.</p>`,
  },
  authorization: {
    subject: "We're requesting your authorization for services — Spectrum Squad",
    html: (c) =>
      `<p>Hi ${c.parent_name},</p><p>We're now submitting the authorization request for ${c.child_name}'s ABA services to your insurance.</p>`,
  },
  first_day_scheduled: {
    subject: "Let's get a first day scheduled! — Spectrum Squad",
    html: (c) =>
      `<p>Hi ${c.parent_name},</p><p>${c.child_name}'s authorization is in and we're ready to schedule a first day of ABA therapy. Our scheduling team will be in touch shortly.</p>`,
  },
  active: {
    subject: (c) => `Welcome to Spectrum Squad, ${c.child_name}!`,
    html: (c) =>
      `<p>Hi ${c.parent_name},</p><p>We're so excited — ${c.child_name} is officially starting ABA therapy with us! Your care team will follow up with weekly schedule details.</p>`,
  },
};

async function sendParentMilestone(client, stageKey) {
  const milestone = PARENT_MILESTONES[stageKey];
  if (!milestone || !client.parent_email) return;
  const subject = typeof milestone.subject === "function" ? milestone.subject(client) : milestone.subject;
  await sendEmail({
    to: client.parent_email,
    subject,
    html: milestone.html(client),
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
      sendEmail({
        to: dept.notify_email,
        subject: `⚠ OVERDUE: ${t.label} — ${t.child_name}`,
        html: `<p><strong>${t.label}</strong> for <strong>${t.child_name}</strong> (parent: ${t.parent_name}) was due ${new Date(
          t.due_date
        ).toLocaleDateString()} and has not been completed.</p>`,
        clientId: t.client_id,
        type: "overdue_alert",
      }).catch((e) => console.error("sendEmail failed:", e));
    }
  }
  return overdue.length;
}

const pipeline = { STAGES, STAGE_ORDER, nextStageKey, getStage, enterStage, completeTask, checkOverdueTasks, sendParentMilestone };

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
async function handle(req, res, pathname, method) {
  if (!pathname.startsWith("/api/")) return false;

  const cookies = auth.parseCookies(req);
  const user = await auth.getUserFromToken(cookies.session);

  if (!PUBLIC_ROUTES.has(pathname) && !user) {
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
      return json(res, 200, { byStage, overdue, pending, upcomingFirstDays, totalClients, stages: pipeline.STAGES });
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
      return json(res, 200, clients);
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

    // One-time cleanup helper: removes synthetic demo clients (identified by
    // a parent_email ending in @example.com) once real data has been
    // imported. Protected by the same ADMIN_IMPORT_SECRET as the backfill
    // route above.
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
      return json(res, 200, { client, tasks, sessions, notifications, documents });
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
      return json(res, 200, client);
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
      service_location: "In-Clinic",
      school_status: "None: Homeschooled/Not School Aged",
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
    const handled = await routes.handle(req, res, pathname, req.method);
    if (!handled) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
    return;
  }

  serveStatic(req, res, pathname);
});

// Overdue-task sweep: runs on boot and then every 30 minutes. In production,
// keep the Node process alive (e.g. via pm2 / a platform's process manager)
// so this interval keeps firing, or trigger POST /api/admin/check-overdue
// from an external scheduler instead.
async function start() {
  await initSchema();
  await ensureSeeded();
  await pipeline.checkOverdueTasks();
  setInterval(() => {
    pipeline.checkOverdueTasks().catch((e) => console.error("Overdue sweep failed:", e));
  }, 30 * 60 * 1000);

  server.listen(PORT, () => {
    console.log(`Spectrum Squad CRM running at http://localhost:${PORT}`);
    console.log(`Demo login: admin@spectrumsquadlv.com / ChangeMe123!`);
  });
}

start().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
