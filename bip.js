// bip.js -- Behavior Intervention Plan workspace.
//
// Design rule this module exists to serve: everything a BCBA needs for a
// client's BIP lives inside that client's card. There is no separate BIP
// application, no dashboard to click through. This file owns the data and the
// API; bip-frontend.js renders it inline in the client modal.
//
// Two clinical safety rules run through it:
//
//   * Nothing clinical is ever invented. A field with no source information is
//     recorded as not documented, never guessed at or filled from another
//     client's plan.
//   * Every edit is written to history with its before and after value, so a
//     plan can always be reconstructed and reviewed.
//
// Additive: new bip_* tables, routes under /api/bip/*. The clients table and
// the existing auth/permissions/email are reused, not replaced.

"use strict";

module.exports = function initBip(ctx) {
  const {
    dbGet, dbAll, dbRun, nowISO, crypto, readBody, json,
    sendEmail, APP_BASE_URL, getAppSetting, canAccessClients,
  } = ctx;

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ======================= ROLES =============================
  // Reading a BIP follows client-record access. Editing is clinical.
  const EDIT_ROLES = ["owner", "super_admin", "admin", "clinical"];
  const DIRECTOR_ROLES = ["owner", "super_admin", "admin"];

  function canViewBip(user) { return canAccessClients(user); }
  function canEditBip(user) { return !!user && EDIT_ROLES.includes(user.role); }
  async function canDirect(user) {
    if (!user) return false;
    if (DIRECTOR_ROLES.includes(user.role)) return true;
    // Whoever is configured as Clinical Director can answer, whatever their role.
    const cd = (await getAppSetting("clinical_director_email", "")) || "";
    return !!cd && String(user.email || "").toLowerCase() === cd.toLowerCase();
  }

  // ======================= CONSTANTS =========================
  const BIP_STATUSES = ["draft", "active", "pending_review", "changes_requested", "archived"];
  const STATUS_LABEL = {
    draft: "Draft",
    active: "Active",
    pending_review: "Pending Clinical Director Review",
    changes_requested: "Changes Requested",
    archived: "Archived",
  };

  const NOTE_CATEGORIES = [
    "Clinical Observation", "Intervention Update", "Data Concern",
    "Parent Information", "Staff Feedback", "Needs Discussion",
    "Clinical Director Guidance", "Other",
  ];

  const URGENCIES = ["Routine", "Needs Review Soon", "Time Sensitive"];
  const QUESTION_STATUSES = ["Awaiting Response", "Answered", "Follow-Up Needed", "Resolved"];

  // The fields a target behavior can carry. `core` ones count toward BIP
  // Health; the rest are shown as "Not documented" with an add link and do not
  // drag the score down, because the plans we import from only contain the
  // core four. See the health notes below.
  const BEHAVIOR_FIELDS = [
    { key: "operational_definition", label: "Operational Definition", core: true, long: true },
    { key: "examples", label: "Examples", long: true },
    { key: "non_examples", label: "Non-Examples", long: true },
    { key: "triggers_antecedents", label: "Triggers / Antecedents", long: true },
    { key: "setting_events", label: "Setting Events", long: true },
    { key: "hypothesized_function", label: "Hypothesized Function" },
    { key: "prevention_strategies", label: "Prevention Strategies", core: true, long: true },
    { key: "replacement_behaviors", label: "Replacement Behaviors", long: true },
    { key: "teaching_procedures", label: "Teaching Procedures", long: true },
    { key: "reinforcement_strategy", label: "Reinforcement Strategy", long: true },
    { key: "response_strategy", label: "Response Strategy", core: true, long: true },
    { key: "data_collection_method", label: "Data Collection Method" },
    { key: "safety_considerations", label: "Safety Considerations", long: true },
    { key: "clinical_notes", label: "Clinical Notes", long: true },
  ];
  const BEHAVIOR_KEYS = BEHAVIOR_FIELDS.map((f) => f.key);
  const CORE_KEYS = BEHAVIOR_FIELDS.filter((f) => f.core).map((f) => f.key);

  // ======================= SCHEMA ============================
  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS client_bips (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL UNIQUE,
      status TEXT DEFAULT 'draft',
      assigned_bcba TEXT,
      assigned_bcba_email TEXT,
      effective_date TEXT,
      next_review_date TEXT,
      safety_plan TEXT,
      crisis_procedures TEXT,
      general_notes TEXT,
      source_document_name TEXT,
      source_document_url TEXT,
      source_document_date TEXT,
      imported_at TEXT,
      last_updated_by TEXT,
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("client_bips:", e.message));

    await dbRun(`CREATE TABLE IF NOT EXISTS bip_behaviors (
      id SERIAL PRIMARY KEY,
      bip_id INTEGER NOT NULL,
      sort_order INTEGER DEFAULT 0,
      name TEXT NOT NULL,
      operational_definition TEXT,
      examples TEXT,
      non_examples TEXT,
      triggers_antecedents TEXT,
      setting_events TEXT,
      hypothesized_function TEXT,
      prevention_strategies TEXT,
      replacement_behaviors TEXT,
      teaching_procedures TEXT,
      reinforcement_strategy TEXT,
      response_strategy TEXT,
      data_collection_method TEXT,
      safety_considerations TEXT,
      clinical_notes TEXT,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("bip_behaviors:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_bip_beh ON bip_behaviors(bip_id)`).catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS bip_notes (
      id SERIAL PRIMARY KEY,
      bip_id INTEGER NOT NULL,
      behavior_id INTEGER,
      parent_id INTEGER,
      category TEXT,
      body TEXT NOT NULL,
      author TEXT,
      author_email TEXT,
      status TEXT DEFAULT 'open',
      created_at TEXT
    )`).catch((e) => console.error("bip_notes:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_bip_notes ON bip_notes(bip_id)`).catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS bip_questions (
      id SERIAL PRIMARY KEY,
      bip_id INTEGER NOT NULL,
      behavior_id INTEGER,
      section TEXT,
      question TEXT NOT NULL,
      tried TEXT,
      context TEXT,
      urgency TEXT DEFAULT 'Routine',
      status TEXT DEFAULT 'Awaiting Response',
      asked_by TEXT,
      asked_by_email TEXT,
      response TEXT,
      responded_by TEXT,
      responded_at TEXT,
      created_at TEXT
    )`).catch((e) => console.error("bip_questions:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_bip_q ON bip_questions(bip_id, status)`).catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS bip_history (
      id SERIAL PRIMARY KEY,
      bip_id INTEGER NOT NULL,
      behavior_id INTEGER,
      behavior_name TEXT,
      section TEXT,
      old_value TEXT,
      new_value TEXT,
      changed_by TEXT,
      changed_at TEXT
    )`).catch((e) => console.error("bip_history:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_bip_hist ON bip_history(bip_id)`).catch(() => {});

    // CRM client <-> Google Drive client folder. Saved once so the folder is
    // never rediscovered, and so Client Files can link straight to it.
    await dbRun(`CREATE TABLE IF NOT EXISTS client_drive_folders (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL UNIQUE,
      folder_id TEXT,
      folder_name TEXT,
      folder_url TEXT,
      matched_by TEXT,
      confirmed_by TEXT,
      created_at TEXT
    )`).catch((e) => console.error("client_drive_folders:", e.message));

    // Documents discovered in that folder, linked rather than copied.
    await dbRun(`CREATE TABLE IF NOT EXISTS client_drive_files (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL,
      file_id TEXT,
      title TEXT,
      kind TEXT,
      mime_type TEXT,
      modified_time TEXT,
      view_url TEXT,
      created_at TEXT
    )`).catch((e) => console.error("client_drive_files:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_cdf ON client_drive_files(client_id)`).catch(() => {});

    // Behavior Modification Notes.
    //
    // NOT bip_notes. That table is a threaded internal clinical discussion --
    // categories, parent_id, open/resolved -- read by clinicians. These are
    // the BCBA's own running record of a behavior and what to do about it:
    // dated, structured, and readable on its own. Same client, different
    // document, different reader.
    //
    // Anchored on client_id rather than bip_id on purpose: client_bips.client_id
    // is UNIQUE, so the two are equivalent, and this way a note survives a plan
    // row being recreated instead of being orphaned by it.
    await dbRun(`CREATE TABLE IF NOT EXISTS bip_behavior_notes (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL,
      note_date TEXT,
      behavior TEXT,
      strategy TEXT,
      instructions TEXT,
      author TEXT,
      author_email TEXT,
      created_at TEXT,
      updated_at TEXT,
      updated_by TEXT
    )`).catch((e) => console.error("bip_behavior_notes:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_bip_bnotes ON bip_behavior_notes(client_id)`).catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS bip_reviews (
      id SERIAL PRIMARY KEY,
      bip_id INTEGER NOT NULL,
      submitted_by TEXT,
      submitted_at TEXT,
      decision TEXT,                 -- approved | changes_requested
      decided_by TEXT,
      decided_at TEXT,
      note TEXT,
      requested_sections TEXT        -- JSON array of {behavior_id, section, note}
    )`).catch((e) => console.error("bip_reviews:", e.message));
  }

  // ======================= HELPERS ===========================
  function clean(v) { return v == null ? "" : String(v).trim(); }
  function filled(v) { return clean(v).length > 0; }
  function today() { return nowISO().slice(0, 10); }
  function daysUntil(dateStr) {
    if (!dateStr) return null;
    const t = Date.parse(String(dateStr).slice(0, 10) + "T00:00:00Z");
    if (isNaN(t)) return null;
    const now = Date.parse(today() + "T00:00:00Z");
    return Math.round((t - now) / 86400000);
  }

  async function logChange(bipId, behavior, section, oldVal, newVal, who) {
    if (clean(oldVal) === clean(newVal)) return;
    await dbRun(
      `INSERT INTO bip_history (bip_id, behavior_id, behavior_name, section, old_value, new_value, changed_by, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [bipId, behavior ? behavior.id : null, behavior ? behavior.name : null, section,
       clean(oldVal).slice(0, 4000), clean(newVal).slice(0, 4000), who || null, nowISO()]
    );
  }

  // ---- behavior note PDF ------------------------------------------------
  // A real PDF file rather than a print window, so a note can be saved and
  // attached somewhere. Written for the BCBA reading it, not for a family:
  // clinical field labels, no plain-language paraphrase.
  //
  // supervision.js already hand-rolls PDF bytes and this follows its technique,
  // but it wraps and paginates rather than truncating. That module caps at 40
  // rows and floors y at 90, which is survivable for a table of hours; a
  // clinical instruction cut off mid-sentence is not.
  const PDF_FONTS = { F: "Helvetica", FB: "Helvetica-Bold" };
  function pdfEsc(str) {
    // Latin-1 is what the WinAnsi fonts below can render. Anything outside it
    // becomes "?" rather than corrupting the byte stream.
    return String(str == null ? "" : str)
      .replace(/\r\n?/g, "\n")
      .split("").map((ch) => (ch.charCodeAt(0) > 255 ? "?" : ch)).join("")
      .replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  }
  // Helvetica is proportional, so this is an estimate rather than a measurement.
  // It is deliberately conservative: wrapping a line early costs nothing,
  // wrapping it late runs the text off the page edge.
  function wrapText(text, maxChars) {
    const out = [];
    for (const para of String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n")) {
      if (!para.trim()) { out.push(""); continue; }
      let line = "";
      for (const word of para.split(/\s+/)) {
        if (!line.length) { line = word; continue; }
        if ((line + " " + word).length <= maxChars) line += " " + word;
        else { out.push(line); line = word; }
      }
      if (line.length) out.push(line);
    }
    return out;
  }

  function buildNotePdf(client, note) {
    const pageW = 612, pageH = 792, m = 54, bottom = 64;
    const pages = [];
    let cur = [], y = pageH - m;
    const newPage = () => { if (cur.length) pages.push(cur); cur = []; y = pageH - m; };
    const line = (text, size, font, gap) => {
      if (y < bottom) newPage();
      cur.push(`BT /${font} ${size} Tf 1 0 0 1 ${m} ${y} Tm (${pdfEsc(text)}) Tj ET`);
      y -= (gap == null ? size + 4 : gap);
    };
    const block = (label, value, chars) => {
      if (!filled(value)) return;
      y -= 8;
      line(label.toUpperCase(), 9, "FB", 13);
      for (const l of wrapText(value, chars || 92)) {
        if (l === "") { y -= 6; continue; }
        line(l, 11, "F", 15);
      }
    };

    line("Behavior Modification Note", 18, "FB", 24);
    line("Spectrum Squad", 10, "F", 20);
    line(`${client.child_name || "Client"}`, 14, "FB", 17);
    line(`Date: ${note.note_date || ""}`, 11, "F", 16);
    if (filled(note.behavior)) line(`Behavior: ${note.behavior}`, 12, "FB", 16);
    block("Behavior modification / strategy", note.strategy);
    block("Notes / instructions", note.instructions);
    y -= 14;
    line(`Written by ${note.author || ""}`, 10, "F", 13);
    if (note.updated_by && note.updated_at) line(`Last edited by ${note.updated_by}`, 10, "F", 13);
    newPage();

    const enc = (str) => Buffer.from(str, "latin1");
    const chunks = []; let off = 0; const xr = [];
    const push = (b) => { chunks.push(b); off += b.length; };
    const obj = (n, body) => { xr[n] = off; push(enc(`${n} 0 obj\n`)); push(body); push(enc("\nendobj\n")); };

    const N = pages.length;
    const pageObj = (i) => 3 + i;                 // 3 .. 2+N
    const contentObj = (i) => 3 + N + i;          // 3+N .. 2+2N
    const fontReg = 3 + 2 * N, fontBold = 4 + 2 * N;
    const total = 5 + 2 * N;

    push(enc("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n"));
    obj(1, enc("<< /Type /Catalog /Pages 2 0 R >>"));
    obj(2, enc(`<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] /Count ${N} >>`));
    pages.forEach((_, i) => {
      obj(pageObj(i), enc(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
        `/Resources << /Font << /F ${fontReg} 0 R /FB ${fontBold} 0 R >> >> /Contents ${contentObj(i)} 0 R >>`));
    });
    pages.forEach((cmds, i) => {
      const body = enc(cmds.join("\n"));
      xr[contentObj(i)] = off;
      push(enc(`${contentObj(i)} 0 obj\n<< /Length ${body.length} >>\nstream\n`));
      push(body);
      push(enc("\nendstream\nendobj\n"));
    });
    obj(fontReg, enc(`<< /Type /Font /Subtype /Type1 /BaseFont /${PDF_FONTS.F} /Encoding /WinAnsiEncoding >>`));
    obj(fontBold, enc(`<< /Type /Font /Subtype /Type1 /BaseFont /${PDF_FONTS.FB} /Encoding /WinAnsiEncoding >>`));

    const xs = off;
    let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
    for (let i = 1; i < total; i++) x += String(xr[i] || 0).padStart(10, "0") + " 00000 n \n";
    push(enc(x));
    push(enc(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xs}\n%%EOF`));
    return Buffer.concat(chunks);
  }

  // ---- BIP Health -----------------------------------------------------
  // Scored against the fields a plan must have to be usable: each behavior
  // needs a name, an operational definition, prevention strategies and a
  // response strategy, and the plan needs a review date. The other ten fields
  // are surfaced as "Not documented" so they can be filled in over time, but
  // they are not counted as failures -- the plans we import from simply do not
  // record them, and scoring against them would mark every real plan as broken.
  function computeHealth(bip, behaviors) {
    const issues = [];
    let required = 0, met = 0;

    required++;
    if (behaviors.length) met++;
    else issues.push({ severity: "high", text: "No target behaviors documented yet.", anchor: "behaviors" });

    required++;
    if (filled(bip.next_review_date)) met++;
    else issues.push({ severity: "medium", text: "No next review date set.", anchor: "overview" });

    for (const b of behaviors) {
      for (const key of CORE_KEYS) {
        required++;
        if (filled(b[key])) met++;
        else {
          const label = (BEHAVIOR_FIELDS.find((f) => f.key === key) || {}).label || key;
          issues.push({
            severity: "high",
            text: `Missing ${label.toLowerCase()} for ${b.name}.`,
            anchor: `behavior-${b.id}`,
            behavior_id: b.id,
            field: key,
          });
        }
      }
    }

    // A review coming due is worth surfacing, but it isn't incompleteness.
    const dLeft = daysUntil(bip.next_review_date);
    if (dLeft != null && dLeft <= 30) {
      issues.push({
        severity: dLeft < 0 ? "high" : "medium",
        text: dLeft < 0 ? `Review was due ${Math.abs(dLeft)} days ago.` : `Review due in ${dLeft} days.`,
        anchor: "overview",
      });
    }

    const percent = required ? Math.round((met / required) * 100) : 0;
    // Count of fields present beyond the required core, for the owner who
    // wants to know how rich the plan is without being punished for it.
    let optionalTotal = 0, optionalMet = 0;
    for (const b of behaviors) {
      for (const f of BEHAVIOR_FIELDS) {
        if (f.core) continue;
        optionalTotal++;
        if (filled(b[f.key])) optionalMet++;
      }
    }
    return {
      percent,
      required, met,
      issues,
      optional: { total: optionalTotal, met: optionalMet },
    };
  }

  // ======================= LOAD ==============================
  async function loadWorkspace(clientId) {
    const client = await dbGet("SELECT id, child_name, dob, parent_name, parent_email FROM clients WHERE id = ?", [clientId]);
    if (!client) return null;
    const bip = await dbGet("SELECT * FROM client_bips WHERE client_id = ?", [clientId]);
    if (!bip) {
      return { client, bip: null, behaviors: [], notes: [], questions: [], review: null, health: null };
    }
    const behaviors = await dbAll("SELECT * FROM bip_behaviors WHERE bip_id = ? ORDER BY sort_order, id", [bip.id]);
    const notes = await dbAll("SELECT * FROM bip_notes WHERE bip_id = ? ORDER BY id DESC LIMIT 300", [bip.id]);
    const questions = await dbAll("SELECT * FROM bip_questions WHERE bip_id = ? ORDER BY id DESC LIMIT 200", [bip.id]);
    const review = await dbGet("SELECT * FROM bip_reviews WHERE bip_id = ? ORDER BY id DESC LIMIT 1", [bip.id]);
    return {
      client, bip, behaviors, notes, questions, review,
      health: computeHealth(bip, behaviors),
      meta: { fields: BEHAVIOR_FIELDS, note_categories: NOTE_CATEGORIES, urgencies: URGENCIES, question_statuses: QUESTION_STATUSES, status_label: STATUS_LABEL },
    };
  }

  // ======================= EMAIL =============================
  async function directorEmail() {
    let cd = await getAppSetting("clinical_director_email", "");
    if (!cd) cd = await getAppSetting("owner_notification_email", "");
    return cd || "";
  }

  function questionEmailHtml({ clientName, bcba, section, behaviorName, urgency, question, tried, context, url }) {
    const e = escapeHtml;
    const row = (label, value) => (value
      ? `<tr><td style="padding:6px 10px;color:#6b7280;font-size:12.5px;white-space:nowrap;vertical-align:top;">${e(label)}</td><td style="padding:6px 10px;font-size:13.5px;color:#1f2430;">${e(value)}</td></tr>`
      : "");
    const urgentPill = urgency && urgency !== "Routine"
      ? `<span style="background:#fdecec;color:#a3282e;border-radius:999px;padding:3px 10px;font-size:11.5px;font-weight:700;">${e(urgency)}</span>`
      : `<span style="background:#eef0f5;color:#555;border-radius:999px;padding:3px 10px;font-size:11.5px;font-weight:700;">Routine</span>`;
    return `
<div style="background:#f4f1ea;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:580px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;border:1px solid #ece7db;">
    <div style="background:linear-gradient(135deg,#1b2a6b,#3f56b5);color:#fff;padding:22px 24px;">
      <div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;opacity:.85;">Clinical question</div>
      <h1 style="margin:4px 0 0;font-size:19px;">${e(bcba)} has a BIP question</h1>
    </div>
    <div style="padding:20px 24px;">
      <table style="width:100%;border-collapse:collapse;margin-bottom:14px;">
        ${row("Client", clientName)}
        ${row("Asked by", bcba)}
        ${row("Section", section)}
        ${row("Behavior", behaviorName)}
        <tr><td style="padding:6px 10px;color:#6b7280;font-size:12.5px;">Urgency</td><td style="padding:6px 10px;">${urgentPill}</td></tr>
      </table>
      <div style="background:#f7f8fb;border-left:3px solid #3f56b5;border-radius:8px;padding:12px 14px;font-size:14px;line-height:1.6;color:#1f2430;">${e(question)}</div>
      ${tried ? `<div style="margin-top:10px;font-size:13px;color:#4b5563;"><strong>Already tried:</strong> ${e(tried)}</div>` : ""}
      ${context ? `<div style="margin-top:6px;font-size:13px;color:#4b5563;"><strong>Context:</strong> ${e(context)}</div>` : ""}
      <div style="text-align:center;margin-top:22px;">
        <a href="${url}" style="display:inline-block;background:#1b2a6b;color:#fff;text-decoration:none;border-radius:999px;padding:13px 26px;font-size:15px;font-weight:700;">Review question</a>
      </div>
      <p style="color:#8a8797;font-size:11.5px;margin:18px 0 0;text-align:center;">
        Opens this client's Behavior Intervention Plan in the CRM with the question ready to answer.
        Clinical detail stays inside the CRM behind your login.
      </p>
    </div>
  </div>
</div>`;
  }

  function answerEmailHtml({ clientName, director, response, url }) {
    const e = escapeHtml;
    return `
<div style="background:#f4f1ea;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:580px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;border:1px solid #ece7db;">
    <div style="background:linear-gradient(135deg,#217a5b,#2ea37a);color:#fff;padding:22px 24px;">
      <div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;opacity:.85;">Answered</div>
      <h1 style="margin:4px 0 0;font-size:19px;">${e(director)} replied about ${e(clientName)}</h1>
    </div>
    <div style="padding:20px 24px;">
      <div style="background:#f7f8fb;border-left:3px solid #217a5b;border-radius:8px;padding:12px 14px;font-size:14px;line-height:1.6;color:#1f2430;">${e(response)}</div>
      <div style="text-align:center;margin-top:22px;">
        <a href="${url}" style="display:inline-block;background:#1b2a6b;color:#fff;text-decoration:none;border-radius:999px;padding:13px 26px;font-size:15px;font-weight:700;">Open the BIP</a>
      </div>
    </div>
  </div>
</div>`;
  }

  function clientBipUrl(clientId, questionId) {
    const base = APP_BASE_URL || "";
    return `${base}/#/pipeline/${clientId}${questionId ? `?bipq=${questionId}` : "?bip=1"}`;
  }

  // ======================= API ===============================
  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/bip")) return false;
    if (!user) { json(res, 401, { error: "Not authenticated" }); return true; }
    if (!canViewBip(user)) { json(res, 403, { error: "Not permitted to view client clinical records" }); return true; }

    const who = user.name || user.email;

    try {
      // ---- the clinical director's counters (one small global widget) ----
      if (pathname === "/api/bip/inbox" && method === "GET") {
        const rows = await dbAll(
          `SELECT q.id, q.urgency, q.created_at, q.question, c.id AS client_id, c.child_name
             FROM bip_questions q
             JOIN client_bips b ON b.id = q.bip_id
             JOIN clients c ON c.id = b.client_id
            WHERE q.status IN ('Awaiting Response','Follow-Up Needed')
            ORDER BY CASE q.urgency WHEN 'Time Sensitive' THEN 0 WHEN 'Needs Review Soon' THEN 1 ELSE 2 END, q.id`
        );
        const pending = await dbAll(
          `SELECT b.id, b.next_review_date, c.id AS client_id, c.child_name
             FROM client_bips b JOIN clients c ON c.id = b.client_id
            WHERE b.status = 'pending_review' ORDER BY b.updated_at`
        );
        const overdue = await dbAll(
          `SELECT b.id, b.next_review_date, c.id AS client_id, c.child_name
             FROM client_bips b JOIN clients c ON c.id = b.client_id
            WHERE b.next_review_date IS NOT NULL AND b.next_review_date <> ''
              AND b.next_review_date < ? AND b.status <> 'archived'
            ORDER BY b.next_review_date`, [today()]
        );
        json(res, 200, { questions: rows, pending_review: pending, overdue_reviews: overdue });
        return true;
      }

      // ---- IMPORT FROM GOOGLE DRIVE -------------------------------
      // The CRM has no Google credentials, and giving it any would be a
      // standing key to every client's clinical file. So extraction happens
      // outside and the CRM receives a payload: it does the client matching
      // against its own records, shows a preview, and only writes on confirm.
      // Nothing is ever overwritten.
      if (pathname === "/api/bip/import/preview" && method === "POST") {
        if (!canEditBip(user)) { json(res, 403, { error: "Only clinical staff can import plans." }); return true; }
        const b = await readBody(req);
        const items = Array.isArray(b.imports) ? b.imports : [];
        if (!items.length) { json(res, 400, { error: "That file didn't contain any plans to import." }); return true; }
        const clients = await dbAll("SELECT id, child_name, dob FROM clients ORDER BY id");
        const out = [];
        for (const it of items) out.push(await previewOne(it, clients));
        json(res, 200, {
          items: out,
          summary: {
            total: out.length,
            matched: out.filter((x) => x.match && x.match.client_id).length,
            needs_match: out.filter((x) => !x.match || !x.match.client_id).length,
            would_create: out.filter((x) => x.match && x.match.client_id && !x.existing_bip).length,
            would_skip: out.filter((x) => x.existing_bip).length,
          },
        });
        return true;
      }

      if (pathname === "/api/bip/import/commit" && method === "POST") {
        if (!canEditBip(user)) { json(res, 403, { error: "Only clinical staff can import plans." }); return true; }
        const b = await readBody(req);
        const items = Array.isArray(b.imports) ? b.imports : [];
        const created = [], skipped = [];
        for (const it of items) {
          const clientId = Number(it.client_id || 0);
          if (!clientId) { skipped.push({ source: it.source_name, reason: "No client chosen." }); continue; }
          const client = await dbGet("SELECT id, child_name FROM clients WHERE id = ?", [clientId]);
          if (!client) { skipped.push({ source: it.source_name, reason: "That client no longer exists." }); continue; }
          // Never silently overwrite an existing plan.
          const existing = await dbGet("SELECT id FROM client_bips WHERE client_id = ?", [clientId]);
          if (existing) {
            skipped.push({ source: it.source_name, client: client.child_name, reason: "This client already has a BIP in the CRM. Nothing was changed." });
            continue;
          }
          const bipRow = await dbGet(
            `INSERT INTO client_bips (client_id, status, effective_date, source_document_name, source_document_url,
               source_document_date, imported_at, created_by, last_updated_by, created_at, updated_at)
             VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
            [clientId, it.source_date || null, it.source_name || null, it.source_url || null,
             it.source_date || null, nowISO(), who, who, nowISO(), nowISO()]
          );
          let n = 0;
          for (const bh of (it.behaviors || [])) {
            const name = clean(bh.name);
            if (!name) continue;
            const cols = ["bip_id", "sort_order", "name", ...BEHAVIOR_KEYS, "created_at", "updated_at"];
            const vals = [bipRow.id, ++n, name.slice(0, 160),
              ...BEHAVIOR_KEYS.map((k) => (clean(bh[k]) ? clean(bh[k]).slice(0, 8000) : null)),
              nowISO(), nowISO()];
            await dbRun(`INSERT INTO bip_behaviors (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, vals);
          }
          await logChange(bipRow.id, null, "Plan", "",
            `Imported from ${it.source_name || "Google Drive"} with ${n} target behavior${n === 1 ? "" : "s"}`, who);
          // Remember the folder so it is never rediscovered.
          if (it.folder_id) {
            await dbRun(
              `INSERT INTO client_drive_folders (client_id, folder_id, folder_name, folder_url, matched_by, confirmed_by, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (client_id) DO UPDATE SET folder_id = EXCLUDED.folder_id,
                 folder_name = EXCLUDED.folder_name, folder_url = EXCLUDED.folder_url, confirmed_by = EXCLUDED.confirmed_by`,
              [clientId, it.folder_id, it.folder_name || null, it.folder_url || null, it.matched_by || "manual", who, nowISO()]
            );
          }
          for (const f of (it.files || [])) {
            await dbRun(
              `INSERT INTO client_drive_files (client_id, file_id, title, kind, mime_type, modified_time, view_url, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [clientId, f.file_id || null, f.title || null, f.kind || "Other Clinical Document",
               f.mime_type || null, f.modified_time || null, f.view_url || null, nowISO()]
            );
          }
          created.push({ client: client.child_name, client_id: clientId, behaviors: n, bip_id: bipRow.id });
        }
        json(res, 200, { ok: true, created, skipped });
        return true;
      }

      // ---- client files (linked, not copied) ----
      const filesMatch = pathname.match(/^\/api\/bip\/client\/(\d+)\/files$/);
      if (filesMatch && method === "GET") {
        const clientId = Number(filesMatch[1]);
        json(res, 200, {
          folder: await dbGet("SELECT * FROM client_drive_folders WHERE client_id = ?", [clientId]),
          files: await dbAll("SELECT * FROM client_drive_files WHERE client_id = ? ORDER BY kind, title", [clientId]),
        });
        return true;
      }

      // ---- the Client Behavior roster ----
      // One row per open client, whether or not they have a plan yet: a client
      // with no BIP is the one most worth seeing, and hiding them behind an
      // inner join is how they stay unnoticed.
      //
      // Two stages, not one. A client in First Day Scheduling has a start date
      // and no sessions yet, which is exactly when a BCBA is WRITING the plan
      // -- so leaving them off meant the tab could not reach a plan during the
      // week it is being drafted. Active Therapy stays first in the ordering
      // because that is the everyday list; the pre-start clients follow.
      //
      // Every earlier stage is still excluded: a child in intake or insurance
      // verification has no behaviour to plan for, and the waitlist is excluded
      // at any stage because waitlisted is a BOOLEAN A CLIENT CARRIES, not a
      // stage -- a paused client can be active and waitlisted at once.
      if (pathname === "/api/bip/roster" && method === "GET") {
        const rows = await dbAll(
          `SELECT c.id, c.child_name, c.assigned_bcba_name, c.stage,
                  b.status AS bip_status, b.assigned_bcba,
                  (SELECT COUNT(*) FROM bip_behavior_notes n WHERE n.client_id = c.id) AS behavior_note_count
             FROM clients c
             LEFT JOIN client_bips b ON b.client_id = c.id
            WHERE c.stage IN ('active', 'first_day_scheduled')
              AND COALESCE(c.waitlisted, false) = false
            ORDER BY CASE c.stage WHEN 'active' THEN 0 ELSE 1 END, c.child_name`
        ).catch(() => []);
        json(res, 200, {
          clients: rows.map((r) => ({
            id: r.id,
            child_name: r.child_name,
            // The plan's own BCBA is the authority on who owns the plan; the
            // client record's is the fallback for a client without one.
            assigned_bcba: clean(r.assigned_bcba) || clean(r.assigned_bcba_name) || null,
            bip_status: r.bip_status || null,
            // So the page can say which of the two a row is. A plan being
            // drafted before day one reads differently from one in use.
            stage: r.stage || null,
            behavior_note_count: Number(r.behavior_note_count) || 0,
          })),
          can_edit: canEditBip(user),
        });
        return true;
      }

      // ---- behavior modification notes for a client ----
      const notesMatch = pathname.match(/^\/api\/bip\/client\/(\d+)\/behavior-notes$/);
      if (notesMatch && method === "GET") {
        const clientId = Number(notesMatch[1]);
        const client = await dbGet("SELECT id, child_name FROM clients WHERE id = ?", [clientId]);
        if (!client) { json(res, 404, { error: "Client not found" }); return true; }
        const bip = await dbGet("SELECT id FROM client_bips WHERE client_id = ?", [clientId]);
        json(res, 200, {
          client,
          // Offered as suggestions when writing a note, so the wording matches
          // the plan where a behavior is already in it.
          behaviors: bip ? await dbAll("SELECT id, name FROM bip_behaviors WHERE bip_id = ? ORDER BY sort_order, id", [bip.id]) : [],
          notes: await dbAll(
            "SELECT * FROM bip_behavior_notes WHERE client_id = ? ORDER BY note_date DESC, id DESC LIMIT 500",
            [clientId]
          ),
          can_edit: canEditBip(user),
        });
        return true;
      }

      // ---- one note as a PDF ----
      const pdfMatch = pathname.match(/^\/api\/bip\/behavior-notes\/(\d+)\/pdf$/);
      if (pdfMatch && method === "GET") {
        const note = await dbGet("SELECT * FROM bip_behavior_notes WHERE id = ?", [Number(pdfMatch[1])]);
        if (!note) { json(res, 404, { error: "Note not found" }); return true; }
        const client = await dbGet("SELECT id, child_name FROM clients WHERE id = ?", [note.client_id]);
        const buf = buildNotePdf(client || {}, note);
        const safe = String((client && client.child_name) || "client").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
        res.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="behavior-note-${safe}-${(note.note_date || "").slice(0, 10)}.pdf"`,
          "Content-Length": buf.length,
        });
        res.end(buf);
        return true;
      }

      // ---- load the whole workspace for a client ----
      const byClient = pathname.match(/^\/api\/bip\/client\/(\d+)$/);
      if (byClient && method === "GET") {
        const data = await loadWorkspace(Number(byClient[1]));
        if (!data) { json(res, 404, { error: "Client not found" }); return true; }
        data.can_edit = canEditBip(user);
        data.current_user = { name: user.name || user.email, email: user.email, role: user.role };
        data.can_direct = await canDirect(user);
        data.clinical_director_email = await directorEmail();
        json(res, 200, data);
        return true;
      }

      // Everything below changes something.
      if (!canEditBip(user) && !(await canDirect(user))) {
        json(res, 403, { error: "Only clinical staff can change a BIP." });
        return true;
      }

      // ---- write a behavior modification note ----
      // A note with nothing in any of its three fields is not a note; refusing
      // it here keeps blank rows out of a clinical record.
      if (notesMatch && method === "POST") {
        const clientId = Number(notesMatch[1]);
        const client = await dbGet("SELECT id FROM clients WHERE id = ?", [clientId]);
        if (!client) { json(res, 404, { error: "Client not found" }); return true; }
        const b = await readBody(req);
        if (!filled(b.behavior) && !filled(b.strategy) && !filled(b.instructions)) {
          json(res, 400, { error: "Add a behavior, a strategy, or instructions before saving." });
          return true;
        }
        const row = await dbGet(
          `INSERT INTO bip_behavior_notes (client_id, note_date, behavior, strategy, instructions,
             author, author_email, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          [clientId, clean(b.note_date) || today(), clean(b.behavior), clean(b.strategy),
           clean(b.instructions), who, user.email || null, nowISO()]
        );
        json(res, 200, { ok: true, note: row });
        return true;
      }

      // ---- edit one ----
      // The previous wording goes to bip_history like every other clinical
      // edit, so a note that changed can be reconstructed rather than just
      // silently reading differently than it did last week.
      const behaviorNoteEdit = pathname.match(/^\/api\/bip\/behavior-notes\/(\d+)$/);
      if (behaviorNoteEdit && method === "PATCH") {
        const id = Number(behaviorNoteEdit[1]);
        const existing = await dbGet("SELECT * FROM bip_behavior_notes WHERE id = ?", [id]);
        if (!existing) { json(res, 404, { error: "Note not found" }); return true; }
        const b = await readBody(req);
        const next = {
          note_date: b.note_date === undefined ? existing.note_date : (clean(b.note_date) || today()),
          behavior: b.behavior === undefined ? existing.behavior : clean(b.behavior),
          strategy: b.strategy === undefined ? existing.strategy : clean(b.strategy),
          instructions: b.instructions === undefined ? existing.instructions : clean(b.instructions),
        };
        if (!filled(next.behavior) && !filled(next.strategy) && !filled(next.instructions)) {
          json(res, 400, { error: "A note cannot be left completely empty." });
          return true;
        }
        const bip = await dbGet("SELECT id FROM client_bips WHERE client_id = ?", [existing.client_id]);
        if (bip) {
          for (const k of ["note_date", "behavior", "strategy", "instructions"]) {
            await logChange(bip.id, null, `Behavior note #${id} — ${k}`, existing[k], next[k], who).catch(() => {});
          }
        }
        const row = await dbGet(
          `UPDATE bip_behavior_notes SET note_date = ?, behavior = ?, strategy = ?, instructions = ?,
             updated_at = ?, updated_by = ? WHERE id = ? RETURNING *`,
          [next.note_date, next.behavior, next.strategy, next.instructions, nowISO(), who, id]
        );
        json(res, 200, { ok: true, note: row });
        return true;
      }

      // ---- create the BIP for a client ----
      if (byClient && method === "POST") {
        const clientId = Number(byClient[1]);
        const existing = await dbGet("SELECT id FROM client_bips WHERE client_id = ?", [clientId]);
        if (existing) { json(res, 200, { ok: true, bip_id: existing.id, existed: true }); return true; }
        const b = await readBody(req);
        const row = await dbGet(
          `INSERT INTO client_bips (client_id, status, assigned_bcba, assigned_bcba_email, effective_date,
             next_review_date, created_by, last_updated_by, created_at, updated_at)
           VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          [clientId, b.assigned_bcba || who, b.assigned_bcba_email || user.email,
           b.effective_date || today(), b.next_review_date || null, who, who, nowISO(), nowISO()]
        );
        await logChange(row.id, null, "Plan", "", "BIP created", who);
        json(res, 201, { ok: true, bip_id: row.id });
        return true;
      }

      // ---- BIP-level fields ----
      const bipMatch = pathname.match(/^\/api\/bip\/(\d+)$/);
      if (bipMatch && method === "PATCH") {
        const bipId = Number(bipMatch[1]);
        const bip = await dbGet("SELECT * FROM client_bips WHERE id = ?", [bipId]);
        if (!bip) { json(res, 404, { error: "Not found" }); return true; }
        const b = await readBody(req);
        const allowed = ["status", "assigned_bcba", "assigned_bcba_email", "effective_date",
                         "next_review_date", "safety_plan", "crisis_procedures", "general_notes"];
        const fields = Object.keys(b).filter((k) => allowed.includes(k));
        if (!fields.length) { json(res, 400, { error: "Nothing to update." }); return true; }
        if (b.status && !BIP_STATUSES.includes(b.status)) { json(res, 400, { error: "Unknown status." }); return true; }
        for (const f of fields) await logChange(bipId, null, labelFor(f), bip[f], b[f], who);
        await dbRun(
          `UPDATE client_bips SET ${fields.map((f) => `${f} = ?`).join(", ")}, last_updated_by = ?, updated_at = ? WHERE id = ?`,
          [...fields.map((f) => b[f]), who, nowISO(), bipId]
        );
        json(res, 200, { ok: true });
        return true;
      }

      // ---- target behaviors ----
      const behAdd = pathname.match(/^\/api\/bip\/(\d+)\/behaviors$/);
      if (behAdd && method === "POST") {
        const bipId = Number(behAdd[1]);
        const b = await readBody(req);
        const name = clean(b.name);
        if (!name) { json(res, 400, { error: "Give the behavior a name." }); return true; }
        const maxRow = await dbGet("SELECT COALESCE(MAX(sort_order), 0) AS m FROM bip_behaviors WHERE bip_id = ?", [bipId]);
        const cols = ["bip_id", "sort_order", "name", ...BEHAVIOR_KEYS, "created_at", "updated_at"];
        const vals = [bipId, Number(maxRow.m) + 1, name, ...BEHAVIOR_KEYS.map((k) => clean(b[k]) || null), nowISO(), nowISO()];
        const row = await dbGet(
          `INSERT INTO bip_behaviors (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) RETURNING *`, vals
        );
        await logChange(bipId, row, "Target Behavior", "", `Added "${name}"`, who);
        await dbRun("UPDATE client_bips SET last_updated_by = ?, updated_at = ? WHERE id = ?", [who, nowISO(), bipId]);
        json(res, 201, { ok: true, behavior: row });
        return true;
      }

      const behEdit = pathname.match(/^\/api\/bip\/behaviors\/(\d+)$/);
      if (behEdit && method === "PATCH") {
        const id = Number(behEdit[1]);
        const before = await dbGet("SELECT * FROM bip_behaviors WHERE id = ?", [id]);
        if (!before) { json(res, 404, { error: "Not found" }); return true; }
        const b = await readBody(req);
        const allowed = ["name", "sort_order", ...BEHAVIOR_KEYS];
        const fields = Object.keys(b).filter((k) => allowed.includes(k));
        if (!fields.length) { json(res, 400, { error: "Nothing to update." }); return true; }
        for (const f of fields) {
          if (f === "sort_order") continue;
          await logChange(before.bip_id, before, labelFor(f), before[f], b[f], who);
        }
        await dbRun(
          `UPDATE bip_behaviors SET ${fields.map((f) => `${f} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
          [...fields.map((f) => (f === "sort_order" ? Number(b[f]) || 0 : clean(b[f]))), nowISO(), id]
        );
        await dbRun("UPDATE client_bips SET last_updated_by = ?, updated_at = ? WHERE id = ?", [who, nowISO(), before.bip_id]);
        json(res, 200, { ok: true });
        return true;
      }

      if (behEdit && method === "DELETE") {
        const id = Number(behEdit[1]);
        const before = await dbGet("SELECT * FROM bip_behaviors WHERE id = ?", [id]);
        if (!before) { json(res, 404, { error: "Not found" }); return true; }
        await logChange(before.bip_id, before, "Target Behavior", before.name, "(removed)", who);
        await dbRun("DELETE FROM bip_behaviors WHERE id = ?", [id]);
        json(res, 200, { ok: true });
        return true;
      }

      // ---- team notes ----
      const noteAdd = pathname.match(/^\/api\/bip\/(\d+)\/notes$/);
      if (noteAdd && method === "POST") {
        const bipId = Number(noteAdd[1]);
        const b = await readBody(req);
        const body = clean(b.body);
        if (!body) { json(res, 400, { error: "Write something first." }); return true; }
        const row = await dbGet(
          `INSERT INTO bip_notes (bip_id, behavior_id, parent_id, category, body, author, author_email, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?) RETURNING *`,
          [bipId, b.behavior_id || null, b.parent_id || null,
           NOTE_CATEGORIES.includes(b.category) ? b.category : "Other",
           body, who, user.email, nowISO()]
        );
        json(res, 201, { ok: true, note: row });
        return true;
      }
      const noteEdit = pathname.match(/^\/api\/bip\/notes\/(\d+)$/);
      if (noteEdit && method === "PATCH") {
        const b = await readBody(req);
        if (b.status && !["open", "resolved"].includes(b.status)) { json(res, 400, { error: "Unknown status." }); return true; }
        await dbRun("UPDATE bip_notes SET status = ? WHERE id = ?", [b.status || "open", Number(noteEdit[1])]);
        json(res, 200, { ok: true });
        return true;
      }

      // ---- ask the clinical director ----
      const qAdd = pathname.match(/^\/api\/bip\/(\d+)\/questions$/);
      if (qAdd && method === "POST") {
        const bipId = Number(qAdd[1]);
        const b = await readBody(req);
        const question = clean(b.question);
        if (!question) { json(res, 400, { error: "Type your question first." }); return true; }
        const bip = await dbGet("SELECT * FROM client_bips WHERE id = ?", [bipId]);
        if (!bip) { json(res, 404, { error: "BIP not found" }); return true; }
        const client = await dbGet("SELECT id, child_name FROM clients WHERE id = ?", [bip.client_id]);
        const behavior = b.behavior_id ? await dbGet("SELECT id, name FROM bip_behaviors WHERE id = ?", [b.behavior_id]) : null;

        const row = await dbGet(
          `INSERT INTO bip_questions (bip_id, behavior_id, section, question, tried, context, urgency, status,
             asked_by, asked_by_email, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'Awaiting Response', ?, ?, ?) RETURNING *`,
          [bipId, behavior ? behavior.id : null, clean(b.section) || (behavior ? "Target Behavior" : "Plan"),
           question, clean(b.tried) || null, clean(b.context) || null,
           URGENCIES.includes(b.urgency) ? b.urgency : "Routine", who, user.email, nowISO()]
        );

        const to = await directorEmail();
        let sent = false;
        if (to) {
          await sendEmail({
            to,
            subject: `BIP Question – ${client ? client.child_name : "Client"} – ${who}`,
            html: questionEmailHtml({
              clientName: client ? client.child_name : "Client",
              bcba: who,
              section: row.section,
              behaviorName: behavior ? behavior.name : "",
              urgency: row.urgency,
              question, tried: clean(b.tried), context: clean(b.context),
              url: clientBipUrl(bip.client_id, row.id),
            }),
            type: "bip_question",
          }).then(() => { sent = true; }).catch((e) => console.error("BIP question email failed:", e.message));
        }
        json(res, 201, {
          ok: true, question: row, emailed: sent, director: to || null,
          note: to ? null : "No Clinical Director email is configured in Admin Settings, so the question was saved but not emailed.",
        });
        return true;
      }

      const qEdit = pathname.match(/^\/api\/bip\/questions\/(\d+)$/);
      if (qEdit && method === "PATCH") {
        const id = Number(qEdit[1]);
        const q = await dbGet("SELECT * FROM bip_questions WHERE id = ?", [id]);
        if (!q) { json(res, 404, { error: "Not found" }); return true; }
        const b = await readBody(req);
        const isDirector = await canDirect(user);

        if (clean(b.response)) {
          if (!isDirector) { json(res, 403, { error: "Only the Clinical Director can answer." }); return true; }
          await dbRun(
            "UPDATE bip_questions SET response = ?, responded_by = ?, responded_at = ?, status = 'Answered' WHERE id = ?",
            [clean(b.response), who, nowISO(), id]
          );
          // Tell the BCBA who asked.
          const bip = await dbGet("SELECT * FROM client_bips WHERE id = ?", [q.bip_id]);
          const client = bip ? await dbGet("SELECT child_name FROM clients WHERE id = ?", [bip.client_id]) : null;
          if (q.asked_by_email) {
            await sendEmail({
              to: q.asked_by_email,
              subject: `Answered: BIP question – ${client ? client.child_name : "Client"}`,
              html: answerEmailHtml({
                clientName: client ? client.child_name : "Client",
                director: who,
                response: clean(b.response),
                url: clientBipUrl(bip.client_id, id),
              }),
              type: "bip_answer",
            }).catch((e) => console.error("BIP answer email failed:", e.message));
          }
          json(res, 200, { ok: true });
          return true;
        }

        if (b.status) {
          if (!QUESTION_STATUSES.includes(b.status)) { json(res, 400, { error: "Unknown status." }); return true; }
          await dbRun("UPDATE bip_questions SET status = ? WHERE id = ?", [b.status, id]);
          json(res, 200, { ok: true });
          return true;
        }
        json(res, 400, { error: "Nothing to update." });
        return true;
      }

      // ---- review workflow ----
      const submitMatch = pathname.match(/^\/api\/bip\/(\d+)\/submit-review$/);
      if (submitMatch && method === "POST") {
        const bipId = Number(submitMatch[1]);
        const bip = await dbGet("SELECT * FROM client_bips WHERE id = ?", [bipId]);
        if (!bip) { json(res, 404, { error: "Not found" }); return true; }
        await dbRun("UPDATE client_bips SET status = 'pending_review', last_updated_by = ?, updated_at = ? WHERE id = ?", [who, nowISO(), bipId]);
        await dbRun(
          "INSERT INTO bip_reviews (bip_id, submitted_by, submitted_at) VALUES (?, ?, ?)",
          [bipId, who, nowISO()]
        );
        await logChange(bipId, null, "Status", STATUS_LABEL[bip.status] || bip.status, "Pending Clinical Director Review", who);
        const to = await directorEmail();
        const client = await dbGet("SELECT id, child_name FROM clients WHERE id = ?", [bip.client_id]);
        if (to) {
          await sendEmail({
            to,
            subject: `BIP Review Requested – ${client ? client.child_name : "Client"} – ${who}`,
            html: questionEmailHtml({
              clientName: client ? client.child_name : "Client",
              bcba: who, section: "Whole plan", behaviorName: "",
              urgency: "Needs Review Soon",
              question: `${who} has submitted this Behavior Intervention Plan for your review.`,
              tried: "", context: "",
              url: clientBipUrl(bip.client_id),
            }),
            type: "bip_review_request",
          }).catch((e) => console.error("BIP review email failed:", e.message));
        }
        json(res, 200, { ok: true, emailed: !!to });
        return true;
      }

      const decideMatch = pathname.match(/^\/api\/bip\/(\d+)\/review-decision$/);
      if (decideMatch && method === "POST") {
        if (!(await canDirect(user))) { json(res, 403, { error: "Only the Clinical Director can approve or request changes." }); return true; }
        const bipId = Number(decideMatch[1]);
        const b = await readBody(req);
        const decision = b.decision === "approved" ? "approved" : "changes_requested";
        const bip = await dbGet("SELECT * FROM client_bips WHERE id = ?", [bipId]);
        if (!bip) { json(res, 404, { error: "Not found" }); return true; }
        const newStatus = decision === "approved" ? "active" : "changes_requested";
        await dbRun("UPDATE client_bips SET status = ?, last_updated_by = ?, updated_at = ? WHERE id = ?", [newStatus, who, nowISO(), bipId]);
        const latest = await dbGet("SELECT id FROM bip_reviews WHERE bip_id = ? ORDER BY id DESC LIMIT 1", [bipId]);
        if (latest) {
          await dbRun(
            "UPDATE bip_reviews SET decision = ?, decided_by = ?, decided_at = ?, note = ?, requested_sections = ? WHERE id = ?",
            [decision, who, nowISO(), clean(b.note) || null, JSON.stringify(b.requested_sections || []), latest.id]
          );
        }
        await logChange(bipId, null, "Status", STATUS_LABEL[bip.status] || bip.status, STATUS_LABEL[newStatus], who);
        json(res, 200, { ok: true, status: newStatus });
        return true;
      }

      // ---- history ----
      const histMatch = pathname.match(/^\/api\/bip\/(\d+)\/history$/);
      if (histMatch && method === "GET") {
        const rows = await dbAll("SELECT * FROM bip_history WHERE bip_id = ? ORDER BY id DESC LIMIT 400", [Number(histMatch[1])]);
        json(res, 200, { history: rows });
        return true;
      }

      return false;
    } catch (e) {
      console.error("bip error:", e);
      json(res, 500, { error: "BIP error: " + e.message });
      return true;
    }
  }


  // ---- client matching -------------------------------------------------
  // Drive folders here are named by initials (KaPo = Kay Posey), and carry no
  // client id or date of birth, so an exact identifier match is not available.
  // We score name evidence and never auto-accept a weak match: anything below
  // "confident" comes back for a human to confirm.
  function normName(s) {
    return String(s || "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  }
  function initialsOf(fullName) {
    const parts = normName(fullName).split(" ").filter(Boolean);
    if (parts.length < 2) return "";
    return (parts[0].slice(0, 2) + parts[parts.length - 1].slice(0, 2));
  }
  function scoreClient(item, client) {
    const target = normName(client.child_name);
    const first = target.split(" ")[0] || "";
    let score = 0; const why = [];

    const claimed = normName(item.client_name);
    if (claimed && claimed === target) { score += 100; why.push("full name matches"); }
    else if (claimed && (target.includes(claimed) || claimed.includes(target))) { score += 60; why.push("name is contained in the client's name"); }

    const code = String(item.initials || "").toLowerCase().replace(/[^a-z]/g, "");
    if (code && code === initialsOf(client.child_name)) { score += 55; why.push(`initials ${code.toUpperCase()} match`); }

    const firstOnly = normName(item.first_name);
    if (firstOnly && first && firstOnly === first) { score += 35; why.push("first name matches"); }

    // A stated date of birth is strong corroboration when we have one.
    if (item.dob && client.dob && String(item.dob).slice(0, 10) === String(client.dob).slice(0, 10)) {
      score += 80; why.push("date of birth matches");
    } else if (item.dob && client.dob) {
      score -= 40; why.push("date of birth does NOT match");
    }
    return { score, why };
  }

  async function previewOne(item, clients) {
    const scored = clients
      .map((c) => ({ client: c, ...scoreClient(item, c) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    const runnerUp = scored[1];
    // "Confident" is deliberately hard to reach. Initials plus a first name is
    // not enough on a child's clinical record -- Kay Posey and Kayla Post share
    // both. It takes corroborating evidence (a matching date of birth, or an
    // exact full-name match on top of the initials) AND a clear gap over the
    // runner-up. Everything else comes back for a human to confirm.
    const confident = best && best.score >= 135 && (!runnerUp || best.score - runnerUp.score >= 40);
    const likely = best && best.score >= 55;

    const behaviors = (item.behaviors || []).filter((b) => clean(b.name));
    const counts = {};
    for (const f of BEHAVIOR_FIELDS) counts[f.key] = behaviors.filter((b) => clean(b[f.key])).length;

    let existing = null;
    if (best && (confident || likely)) {
      existing = await dbGet("SELECT id FROM client_bips WHERE client_id = ?", [best.client.id]);
    }

    return {
      source_name: item.source_name || "",
      source_url: item.source_url || "",
      source_date: item.source_date || "",
      folder_id: item.folder_id || null,
      folder_name: item.folder_name || null,
      folder_url: item.folder_url || null,
      files: item.files || [],
      stated_client: item.client_name || item.initials || "",
      match: best && (confident || likely)
        ? { client_id: best.client.id, child_name: best.client.child_name, score: best.score,
            confidence: confident ? "confident" : "needs confirmation", reasons: best.why }
        : null,
      alternatives: scored.slice(0, 5).filter((x) => x.score > 0)
        .map((x) => ({ client_id: x.client.id, child_name: x.client.child_name, score: x.score, reasons: x.why })),
      existing_bip: !!existing,
      behaviors,
      found: {
        target_behaviors: behaviors.length,
        operational_definitions: counts.operational_definition || 0,
        prevention_strategies: counts.prevention_strategies || 0,
        response_strategies: counts.response_strategy || 0,
        functions: counts.hypothesized_function || 0,
      },
      warnings: (item.warnings || []).concat(
        behaviors.length ? [] : ["No target behaviors could be read out of this document."]
      ),
    };
  }

  function labelFor(key) {
    const f = BEHAVIOR_FIELDS.find((x) => x.key === key);
    if (f) return f.label;
    return String(key).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  return {
    initTables,
    _test: { buildNotePdf, wrapText },
    handleApi,
    loadWorkspace,
    computeHealth,
    _lib: { BEHAVIOR_FIELDS, CORE_KEYS, NOTE_CATEGORIES, URGENCIES, STATUS_LABEL, computeHealth },
  };
};
