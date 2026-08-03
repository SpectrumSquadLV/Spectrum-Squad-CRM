// server.js -- Spectrum Squad ABA Client Pipeline CRM
// Single-file build (consolidated for easy manual deployment via GitHub's
// web UI). Zero npm dependencies -- pure Node built-ins only.
// Run with: node server.js
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

// ============================== DATABASE ==============================
// server/db.js
// Zero-dependency SQLite layer using Node's built-in node:sqlite module (Node 22+).
// No npm install required to run this app.
"use strict";

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "crm.db");
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    notify_email TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL, -- admin | intake | clinical | billing | scheduling
    department_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    submitted_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS stage_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage_key TEXT NOT NULL,
    label TEXT NOT NULL,
    department_id INTEGER NOT NULL,
    sla_days INTEGER NOT NULL,
    sort_order INTEGER NOT NULL,
    next_stage_key TEXT
  );

  CREATE TABLE IF NOT EXISTS client_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    stage_task_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | completed | overdue
    due_date TEXT NOT NULL,
    completed_at TEXT,
    overdue_notified_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id),
    FOREIGN KEY (stage_task_id) REFERENCES stage_tasks(id)
  );

  CREATE TABLE IF NOT EXISTS notifications_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER,
    type TEXT NOT NULL, -- department_alert | parent_milestone | overdue_alert
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    sent_at TEXT DEFAULT (datetime('now')),
    delivered TEXT DEFAULT 'simulated' -- simulated | sent | failed
  );

  CREATE TABLE IF NOT EXISTS therapists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT NOT NULL, -- BCBA | RBT
    color TEXT NOT NULL,
    weekly_capacity_hours REAL DEFAULT 30
  );

  CREATE TABLE IF NOT EXISTS schedule_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    therapist_id INTEGER NOT NULL,
    day_of_week INTEGER NOT NULL, -- 0=Sun .. 6=Sat
    start_time TEXT NOT NULL, -- 'HH:MM'
    end_time TEXT NOT NULL,
    session_type TEXT DEFAULT 'ABA Therapy',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id),
    FOREIGN KEY (therapist_id) REFERENCES therapists(id)
  );

  CREATE TABLE IF NOT EXISTS schedule_targets (
    key TEXT PRIMARY KEY,
    weekly_hours REAL NOT NULL
  );
`);



// ============================== AUTH ==============================
// server/auth.js
// Zero-dependency auth: scrypt password hashing + random session tokens (cookie-based).
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

function createUser({ name, email, password, role, department_id = null }) {
  const { hash, salt } = hashPassword(password);
  const stmt = db.prepare(
    `INSERT INTO users (name, email, password_hash, password_salt, role, department_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(name, email.toLowerCase(), hash, salt, role, department_id);
  return info.lastInsertRowid;
}

function findUserByEmail(email) {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase());
}

function login(email, password) {
  const user = findUserByEmail(email);
  if (!user) return null;
  if (!verifyPassword(password, user.password_salt, user.password_hash)) return null;

  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(
    token,
    user.id,
    expires
  );
  return { token, user: sanitizeUser(user) };
}

function logout(token) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

function getUserFromToken(token) {
  if (!token) return null;
  const session = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id);
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

  db.prepare(
    `INSERT INTO notifications_log (client_id, type, recipient, subject, body, delivered)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(clientId, type, to, subject, html, delivered + (errorMsg ? `: ${errorMsg}` : ""));

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
function enterStage(clientId, stageKey) {
  const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(clientId);
  if (!client) return;

  db.prepare("UPDATE clients SET stage = ?, updated_at = datetime('now') WHERE id = ?").run(
    stageKey,
    clientId
  );

  const tasks = db.prepare("SELECT * FROM stage_tasks WHERE stage_key = ?").all(stageKey);
  for (const task of tasks) {
    const dueDate = addBusinessDays(new Date(), task.sla_days).toISOString();
    db.prepare(
      `INSERT INTO client_tasks (client_id, stage_task_id, status, due_date)
       VALUES (?, ?, 'pending', ?)`
    ).run(clientId, task.id, dueDate);

    const dept = db.prepare("SELECT * FROM departments WHERE id = ?").get(task.department_id);
    if (dept && dept.notify_email) {
      sendEmail({
        to: dept.notify_email,
        subject: `[${dept.name}] Action needed: ${client.child_name} — ${task.label}`,
        html: `<p><strong>${client.child_name}</strong> (parent: ${client.parent_name}) has entered stage
               <strong>${getStage(stageKey)?.label}</strong> and needs: <strong>${task.label}</strong>.</p>
               <p>Due by: ${new Date(dueDate).toLocaleDateString()}</p>`,
        clientId,
        type: "department_alert",
      });
    }
  }

  sendParentMilestone(client, stageKey);
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

function sendParentMilestone(client, stageKey) {
  const milestone = PARENT_MILESTONES[stageKey];
  if (!milestone || !client.parent_email) return;
  const subject = typeof milestone.subject === "function" ? milestone.subject(client) : milestone.subject;
  sendEmail({
    to: client.parent_email,
    subject,
    html: milestone.html(client),
    clientId: client.id,
    type: "parent_milestone",
  });
}

function completeTask(taskId, completedByUserId) {
  const task = db.prepare("SELECT * FROM client_tasks WHERE id = ?").get(taskId);
  if (!task) return { ok: false, error: "Task not found" };

  db.prepare(
    "UPDATE client_tasks SET status = 'completed', completed_at = datetime('now') WHERE id = ?"
  ).run(taskId);

  // If all tasks for the client's current stage are complete, auto-advance.
  const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(task.client_id);
  const stageTaskIds = db
    .prepare("SELECT id FROM stage_tasks WHERE stage_key = ?")
    .all(client.stage)
    .map((r) => r.id);

  const remaining = db
    .prepare(
      `SELECT COUNT(*) AS n FROM client_tasks
       WHERE client_id = ? AND status != 'completed' AND stage_task_id IN (${stageTaskIds
         .map(() => "?")
         .join(",") || "-1"})`
    )
    .get(task.client_id, ...stageTaskIds);

  if (remaining.n === 0) {
    const next = nextStageKey(client.stage);
    if (next) enterStage(client.id, next);
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
function checkOverdueTasks() {
  const now = new Date().toISOString();
  const overdue = db
    .prepare(
      `SELECT ct.*, st.label, st.department_id, c.child_name, c.parent_name
       FROM client_tasks ct
       JOIN stage_tasks st ON st.id = ct.stage_task_id
       JOIN clients c ON c.id = ct.client_id
       WHERE ct.status = 'pending' AND ct.due_date < ? AND ct.overdue_notified_at IS NULL`
    )
    .all(now);

  for (const t of overdue) {
    db.prepare("UPDATE client_tasks SET status = 'overdue', overdue_notified_at = datetime('now') WHERE id = ?").run(
      t.id
    );
    const dept = db.prepare("SELECT * FROM departments WHERE id = ?").get(t.department_id);
    if (dept && dept.notify_email) {
      sendEmail({
        to: dept.notify_email,
        subject: `⚠ OVERDUE: ${t.label} — ${t.child_name}`,
        html: `<p><strong>${t.label}</strong> for <strong>${t.child_name}</strong> (parent: ${t.parent_name}) was due ${new Date(
          t.due_date
        ).toLocaleDateString()} and has not been completed.</p>`,
        clientId: t.client_id,
        type: "overdue_alert",
      });
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

const PUBLIC_ROUTES = new Set(["/api/auth/login", "/api/webhook/enrollment"]);

const CLIENT_COLOR_PALETTE = ["#5fa8a0", "#e0a430", "#6660a8", "#3f8f89", "#c98a1b", "#8d85c8"];

function createClientFromPayload(c) {
  const stmt = db.prepare(`
    INSERT INTO clients (
      child_name, dob, parent_name, parent_relationship, parent_email, parent_phone,
      address, service_location, school_status, start_urgency, insurance_provider,
      num_insurances, has_asd_diagnosis, has_iep, prior_aba_nv, preferred_contact,
      desired_schedule, rethink_status, color
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const color = CLIENT_COLOR_PALETTE[Math.floor(Math.random() * CLIENT_COLOR_PALETTE.length)];
  const info = stmt.run(
    c.child_name, c.dob || null, c.parent_name || null, c.parent_relationship || null,
    c.parent_email || null, c.parent_phone || null, c.address || null, c.service_location || null,
    c.school_status || null, c.start_urgency || null, c.insurance_provider || null,
    c.num_insurances || null, c.has_asd_diagnosis || null, c.has_iep || null,
    c.prior_aba_nv || null, c.preferred_contact || null, c.desired_schedule || null,
    c.rethink_status || null, color
  );
  pipeline.enterStage(info.lastInsertRowid, "new_submission");
  return db.prepare("SELECT * FROM clients WHERE id = ?").get(info.lastInsertRowid);
}

// Returns true if the route was handled.
async function handle(req, res, pathname, method) {
  if (!pathname.startsWith("/api/")) return false;

  const cookies = auth.parseCookies(req);
  const user = auth.getUserFromToken(cookies.session);

  if (!PUBLIC_ROUTES.has(pathname) && !user) {
    json(res, 401, { error: "Not authenticated" });
    return true;
  }

  try {
    // ---------- AUTH ----------
    if (pathname === "/api/auth/login" && method === "POST") {
      const { email, password } = await readBody(req);
      const result = auth.login(email || "", password || "");
      if (!result) return json(res, 401, { error: "Invalid email or password" });
      res.setHeader(
        "Set-Cookie",
        `session=${result.token}; HttpOnly; Path=/; Max-Age=${12 * 3600}; SameSite=Lax`
      );
      return json(res, 200, { user: result.user });
    }

    if (pathname === "/api/auth/logout" && method === "POST") {
      if (cookies.session) auth.logout(cookies.session);
      res.setHeader("Set-Cookie", "session=; HttpOnly; Path=/; Max-Age=0");
      return json(res, 200, { ok: true });
    }

    if (pathname === "/api/auth/me" && method === "GET") {
      return json(res, 200, { user });
    }

    // ---------- DASHBOARD ----------
    if (pathname === "/api/dashboard" && method === "GET") {
      const byStage = db
        .prepare("SELECT stage, COUNT(*) AS n FROM clients GROUP BY stage")
        .all();
      const overdue = db
        .prepare("SELECT COUNT(*) AS n FROM client_tasks WHERE status = 'overdue'")
        .get().n;
      const pending = db
        .prepare("SELECT COUNT(*) AS n FROM client_tasks WHERE status = 'pending'")
        .get().n;
      const upcomingFirstDays = db
        .prepare(
          "SELECT id, child_name, first_day_date FROM clients WHERE first_day_date IS NOT NULL AND first_day_date >= date('now') ORDER BY first_day_date LIMIT 5"
        )
        .all();
      const totalClients = db.prepare("SELECT COUNT(*) AS n FROM clients").get().n;
      return json(res, 200, { byStage, overdue, pending, upcomingFirstDays, totalClients, stages: pipeline.STAGES });
    }

    // ---------- STAGES / DEPARTMENTS ----------
    if (pathname === "/api/stages" && method === "GET") {
      return json(res, 200, pipeline.STAGES);
    }

    if (pathname === "/api/departments" && method === "GET") {
      return json(res, 200, db.prepare("SELECT * FROM departments").all());
    }

    // ---------- CLIENTS ----------
    if (pathname === "/api/clients" && method === "GET") {
      const clients = db.prepare("SELECT * FROM clients ORDER BY submitted_at DESC").all();
      return json(res, 200, clients);
    }

    if (pathname === "/api/clients" && method === "POST") {
      const c = await readBody(req);
      const client = createClientFromPayload(c);
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
      const client = createClientFromPayload(c);
      return json(res, 201, client);
    }

    const clientMatch = pathname.match(/^\/api\/clients\/(\d+)$/);
    if (clientMatch && method === "GET") {
      const id = clientMatch[1];
      const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
      if (!client) return json(res, 404, { error: "Not found" });
      const tasks = db
        .prepare(
          `SELECT ct.*, st.label, st.stage_key, d.name AS department_name, d.color AS department_color
           FROM client_tasks ct
           JOIN stage_tasks st ON st.id = ct.stage_task_id
           JOIN departments d ON d.id = st.department_id
           WHERE ct.client_id = ? ORDER BY ct.created_at`
        )
        .all(id);
      const sessions = db
        .prepare(
          `SELECT ss.*, t.name AS therapist_name, t.color AS therapist_color
           FROM schedule_sessions ss JOIN therapists t ON t.id = ss.therapist_id
           WHERE ss.client_id = ?`
        )
        .all(id);
      const notifications = db
        .prepare("SELECT * FROM notifications_log WHERE client_id = ? ORDER BY sent_at DESC")
        .all(id);
      return json(res, 200, { client, tasks, sessions, notifications });
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
        db.prepare(`UPDATE clients SET ${setClause}, updated_at = datetime('now') WHERE id = ?`).run(
          ...fields.map((f) => updates[f]),
          id
        );
      }
      const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
      return json(res, 200, client);
    }

    const advanceMatch = pathname.match(/^\/api\/clients\/(\d+)\/advance$/);
    if (advanceMatch && method === "POST") {
      const id = advanceMatch[1];
      const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
      if (!client) return json(res, 404, { error: "Not found" });
      const { stage } = await readBody(req);
      const target = stage || pipeline.nextStageKey(client.stage);
      if (!target) return json(res, 400, { error: "No next stage" });
      pipeline.enterStage(id, target);
      return json(res, 200, db.prepare("SELECT * FROM clients WHERE id = ?").get(id));
    }

    const dischargeMatch = pathname.match(/^\/api\/clients\/(\d+)\/discharge$/);
    if (dischargeMatch && method === "POST") {
      const id = dischargeMatch[1];
      const { reason, stage } = await readBody(req);
      db.prepare(
        "UPDATE clients SET stage = ?, discharge_reason = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(stage || "discharged", reason || null, id);
      return json(res, 200, db.prepare("SELECT * FROM clients WHERE id = ?").get(id));
    }

    // ---------- TASKS ----------
    if (pathname === "/api/tasks" && method === "GET") {
      const tasks = db
        .prepare(
          `SELECT ct.*, st.label, st.stage_key, c.child_name, d.name AS department_name, d.color AS department_color
           FROM client_tasks ct
           JOIN stage_tasks st ON st.id = ct.stage_task_id
           JOIN clients c ON c.id = ct.client_id
           JOIN departments d ON d.id = st.department_id
           WHERE ct.status != 'completed'
           ORDER BY ct.due_date ASC`
        )
        .all();
      return json(res, 200, tasks);
    }

    const completeTaskMatch = pathname.match(/^\/api\/tasks\/(\d+)\/complete$/);
    if (completeTaskMatch && method === "POST") {
      const result = pipeline.completeTask(completeTaskMatch[1], user.id);
      return json(res, result.ok ? 200 : 400, result);
    }

    // ---------- THERAPISTS ----------
    if (pathname === "/api/therapists" && method === "GET") {
      return json(res, 200, db.prepare("SELECT * FROM therapists").all());
    }

    // ---------- SCHEDULE ----------
    if (pathname === "/api/schedule" && method === "GET") {
      const sessions = db
        .prepare(
          `SELECT ss.*, c.child_name, c.color AS client_color, t.name AS therapist_name, t.color AS therapist_color
           FROM schedule_sessions ss
           JOIN clients c ON c.id = ss.client_id
           JOIN therapists t ON t.id = ss.therapist_id`
        )
        .all();
      return json(res, 200, sessions);
    }

    if (pathname === "/api/schedule" && method === "POST") {
      const s = await readBody(req);
      // conflict check: same therapist, same day, overlapping time
      const conflicts = db
        .prepare(
          `SELECT * FROM schedule_sessions WHERE therapist_id = ? AND day_of_week = ?
           AND NOT (end_time <= ? OR start_time >= ?)`
        )
        .all(s.therapist_id, s.day_of_week, s.start_time, s.end_time);
      if (conflicts.length) {
        return json(res, 409, { error: "Therapist already has a session in that time slot", conflicts });
      }
      const info = db
        .prepare(
          `INSERT INTO schedule_sessions (client_id, therapist_id, day_of_week, start_time, end_time, session_type)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(s.client_id, s.therapist_id, s.day_of_week, s.start_time, s.end_time, s.session_type || "ABA Therapy");
      return json(res, 201, { id: info.lastInsertRowid });
    }

    const deleteSessionMatch = pathname.match(/^\/api\/schedule\/(\d+)$/);
    if (deleteSessionMatch && method === "DELETE") {
      db.prepare("DELETE FROM schedule_sessions WHERE id = ?").run(deleteSessionMatch[1]);
      return json(res, 200, { ok: true });
    }

    if (pathname === "/api/schedule-targets" && method === "GET") {
      return json(res, 200, db.prepare("SELECT * FROM schedule_targets").all());
    }

    // ---------- NOTIFICATIONS / OUTBOX ----------
    if (pathname === "/api/notifications" && method === "GET") {
      return json(
        res,
        200,
        db.prepare("SELECT * FROM notifications_log ORDER BY sent_at DESC LIMIT 100").all()
      );
    }

    // ---------- ADMIN ----------
    if (pathname === "/api/admin/check-overdue" && method === "POST") {
      const n = pipeline.checkOverdueTasks();
      return json(res, 200, { flagged: n });
    }

    if (pathname === "/api/admin/departments" && method === "PATCH") {
      const { id, notify_email } = await readBody(req);
      db.prepare("UPDATE departments SET notify_email = ? WHERE id = ?").run(notify_email, id);
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

function run() {
  seedDepartments();
  seedStageTasks();
  seedUsers();
  seedTherapists();
  seedScheduleTargets();
  seedDemoClients();
  console.log("Seed complete.");
}

function seedDepartments() {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM departments").get();
  if (existing.n > 0) return;
  const depts = [
    { key: "intake", name: "Intake / Admin", color: "#5fa8a0", notify_email: "intake@spectrumsquadlv.com" },
    { key: "clinical", name: "Clinical (BCBA)", color: "#29225c", notify_email: "clinical@spectrumsquadlv.com" },
    { key: "billing", name: "Billing / Insurance", color: "#e0a430", notify_email: "billing@spectrumsquadlv.com" },
    { key: "scheduling", name: "Scheduling", color: "#6660a8", notify_email: "scheduling@spectrumsquadlv.com" },
  ];
  const stmt = db.prepare(
    "INSERT INTO departments (key, name, color, notify_email) VALUES (?, ?, ?, ?)"
  );
  for (const d of depts) stmt.run(d.key, d.name, d.color, d.notify_email);
}

function deptId(key) {
  return db.prepare("SELECT id FROM departments WHERE key = ?").get(key).id;
}

function seedStageTasks() {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM stage_tasks").get();
  if (existing.n > 0) return;
  const rows = [
    ["new_submission", "Welcome call / initial contact", "intake", 1, 1],
    ["clinical_screener", "Complete Clinical Screener", "clinical", 2, 1],
    ["insurance_verification", "Verify Insurance Benefits", "billing", 3, 1],
    ["intake_packet", "Send Intake Packet", "intake", 1, 1],
    ["assessment_scheduling", "Schedule Vineland / Intake Assessment", "clinical", 5, 1],
    ["authorization", "Submit Authorization Request", "billing", 3, 1],
    ["first_day_scheduled", "Schedule First Day of ABA", "scheduling", 5, 1],
  ];
  const stmt = db.prepare(
    `INSERT INTO stage_tasks (stage_key, label, department_id, sla_days, sort_order)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const [stage_key, label, deptKey, sla_days, sort_order] of rows) {
    stmt.run(stage_key, label, deptId(deptKey), sla_days, sort_order);
  }
}

function seedUsers() {
  if (findUserByEmail("admin@spectrumsquadlv.com")) return;
  createUser({
    name: "Quiana Blake",
    email: "admin@spectrumsquadlv.com",
    password: "ChangeMe123!",
    role: "admin",
    department_id: null,
  });
  createUser({
    name: "Intake Staff",
    email: "intake@spectrumsquadlv.com",
    password: "ChangeMe123!",
    role: "intake",
    department_id: deptId("intake"),
  });
  createUser({
    name: "Clinical Staff",
    email: "clinical@spectrumsquadlv.com",
    password: "ChangeMe123!",
    role: "clinical",
    department_id: deptId("clinical"),
  });
  createUser({
    name: "Billing Staff",
    email: "billing@spectrumsquadlv.com",
    password: "ChangeMe123!",
    role: "billing",
    department_id: deptId("billing"),
  });
  createUser({
    name: "Scheduling Staff",
    email: "scheduling@spectrumsquadlv.com",
    password: "ChangeMe123!",
    role: "scheduling",
    department_id: deptId("scheduling"),
  });
}

function seedTherapists() {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM therapists").get();
  if (existing.n > 0) return;
  const rows = [
    ["Allie R.", "BCBA", "#29225c", 30],
    ["Katelyn S.", "RBT", "#5fa8a0", 30],
    ["April M.", "RBT", "#3f8f89", 30],
    ["Marcus T.", "RBT", "#e0a430", 25],
  ];
  const stmt = db.prepare(
    "INSERT INTO therapists (name, role, color, weekly_capacity_hours) VALUES (?, ?, ?, ?)"
  );
  for (const r of rows) stmt.run(...r);
}

function seedScheduleTargets() {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM schedule_targets").get();
  if (existing.n > 0) return;
  const rows = [
    ["Full-Time", 30],
    ["Part Time AM", 15],
    ["Part Time PM", 15],
  ];
  const stmt = db.prepare("INSERT INTO schedule_targets (key, weekly_hours) VALUES (?, ?)");
  for (const r of rows) stmt.run(...r);
}

// Synthetic demo clients only -- mirrors the real form's fields/pipeline
// without using any actual family's data.
function seedDemoClients() {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM clients").get();
  if (existing.n > 0) return;

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

  const insertStmt = db.prepare(`
    INSERT INTO clients (
      child_name, dob, parent_name, parent_relationship, parent_email, parent_phone,
      address, service_location, school_status, start_urgency, insurance_provider,
      num_insurances, has_asd_diagnosis, has_iep, prior_aba_nv, preferred_contact,
      desired_schedule, rethink_status, stage, color
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new_submission', ?)
  `);

  for (const c of demo) {
    const info = insertStmt.run(
      c.child_name, c.dob, c.parent_name, c.parent_relationship, c.parent_email, c.parent_phone,
      c.address, c.service_location, c.school_status, c.start_urgency, c.insurance_provider,
      c.num_insurances, c.has_asd_diagnosis, c.has_iep, c.prior_aba_nv, c.preferred_contact,
      c.desired_schedule, c.rethink_status, c.color
    );
    // Walk the client through stages up to its target demo stage so tasks +
    // notifications get generated realistically (and land in the outbox).
    const path = ["new_submission", "clinical_screener", "insurance_verification", "intake_packet", "assessment_scheduling", "authorization", "first_day_scheduled", "active"];
    const targetIdx = path.indexOf(c.stage);
    for (let i = 0; i <= targetIdx; i++) {
      enterStage(info.lastInsertRowid, path[i]);
      // auto-complete tasks for all but the current (final) stage, so the
      // client appears to have organically progressed to `c.stage`.
      if (i < targetIdx) {
        const tasks = db
          .prepare(
            `SELECT ct.id FROM client_tasks ct JOIN stage_tasks st ON st.id = ct.stage_task_id
             WHERE ct.client_id = ? AND st.stage_key = ?`
          )
          .all(info.lastInsertRowid, path[i]);
        for (const t of tasks) {
          db.prepare("UPDATE client_tasks SET status='completed', completed_at=datetime('now') WHERE id=?").run(t.id);
        }
      }
    }
  }

  // Give "Demo Child D" (active) a sample weekly schedule.
  const activeClient = db.prepare("SELECT id FROM clients WHERE child_name = 'Demo Child D'").get();
  const therapist = db.prepare("SELECT id FROM therapists LIMIT 1").get();
  if (activeClient && therapist) {
    const sessions = [
      [1, "09:00", "12:00"],
      [3, "09:00", "12:00"],
      [5, "09:00", "12:00"],
    ];
    const stmt = db.prepare(
      "INSERT INTO schedule_sessions (client_id, therapist_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?, ?)"
    );
    for (const [day, start, end] of sessions) {
      stmt.run(activeClient.id, therapist.id, day, start, end);
    }
  }
}


// ============================== SERVER BOOTSTRAP ==============================
// server/index.js
// Entry point. Zero npm dependencies -- pure Node built-ins (http, fs, path,
// node:sqlite, crypto). Run with: node server/index.js
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

function ensureSeeded() {
  const count = db.prepare("SELECT COUNT(*) AS n FROM departments").get().n;
  if (count === 0) {
    console.log("First run detected -- seeding demo data...");
    run();
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

ensureSeeded();

// Overdue-task sweep: runs on boot and then every 30 minutes. In production,
// keep the Node process alive (e.g. via pm2 / a platform's process manager)
// so this interval keeps firing, or trigger POST /api/admin/check-overdue
// from an external scheduler instead.
pipeline.checkOverdueTasks();
setInterval(() => {
  try {
    pipeline.checkOverdueTasks();
  } catch (e) {
    console.error("Overdue sweep failed:", e);
  }
}, 30 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Spectrum Squad CRM running at http://localhost:${PORT}`);
  console.log(`Demo login: admin@spectrumsquadlv.com / ChangeMe123!`);
});

