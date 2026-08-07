// ot.js -- Spectrum Squad CRM: Occupational Therapy module (backend)
// Self-contained add-on, mirroring the screener.js / hr.js pattern: it owns its
// own tables (all prefixed ot_), its own /api/ot/* routes, its own OT settings,
// and (in Phase 2) a public parent intake page. It NEVER modifies existing ABA
// tables or behavior.
//
// Shared-identity model: the existing `clients` row IS the shared family/child
// identity (demographics + contact). An ot_clients row represents that child's
// OT enrollment, linked by client_id. A child can have ABA (existing clients
// fields), OT (ot_* tables), or both -- always ONE client identity.
//
// Permission model (enforced here + by a gate in server.js):
//   ot_admin / ot_staff  -> OT clients + shared demographics ONLY. Never ABA
//                           clinical, authorization, billing, or financial data.
//   owner / super_admin / admin -> full access to both ABA and OT.
"use strict";

const fs = require("fs");
const path = require("path");

module.exports = function initOt(ctx) {
  const { dbGet, dbAll, dbRun, sendEmail, nowISO, crypto, APP_BASE_URL, readBody, json, sendFile } = ctx;

  // Private file storage on the Railway volume (same volume ABA/HR use). Never
  // served through predictable public URLs -- only via authenticated endpoints.
  const DATA_DIR = path.join(__dirname, "data");
  const OT_DIR = path.join(DATA_DIR, "ot-files");
  if (!fs.existsSync(OT_DIR)) fs.mkdirSync(OT_DIR, { recursive: true });

  // The OT intake / onboarding pipeline (order matters for the dashboard board).
  const OT_STATUSES = [
    "New OT Lead",
    "Intake Started",
    "Intake Incomplete",
    "Intake Submitted",
    "Insurance Verification Needed",
    "Insurance Verification Pending",
    "Insurance Verified",
    "Previous OT Discharge Letter Needed",
    "Referral / Order Needed",
    "Ready for OT Evaluation",
    "Evaluation Scheduled",
    "Evaluation Completed",
    "Authorization Needed",
    "Authorization Pending",
    "Ready to Start Services",
    "Active OT",
    "Waitlist",
    "Discharged",
  ];

  // ---- permissions ----
  const OT_VIEW_ROLES = ["owner", "super_admin", "admin", "ot_admin", "ot_staff"];
  const OT_ADMIN_ROLES = ["owner", "super_admin", "admin", "ot_admin"];
  function canViewOT(user) { return !!user && OT_VIEW_ROLES.includes(user.role); }
  function canAdminOT(user) { return !!user && OT_ADMIN_ROLES.includes(user.role); }
  // OT-only users must never see ABA data anywhere.
  function isOtOnly(user) { return !!user && (user.role === "ot_admin" || user.role === "ot_staff"); }

  function parseJson(str, fallback) {
    try { return str ? JSON.parse(str) : fallback; } catch (e) { return fallback; }
  }
  function newToken() { return crypto.randomBytes(24).toString("hex"); }

  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS ot_clients (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'New OT Lead',
      intake_token TEXT UNIQUE,
      intake_progress INTEGER NOT NULL DEFAULT 0,
      intake_started_at TEXT,
      intake_submitted_at TEXT,
      intake_opened_at TEXT,
      last_activity_at TEXT,
      intake_data TEXT,                 -- full parent intake responses (JSON)
      insurance_provider TEXT,
      insurance_member_id TEXT,
      secondary_insurance TEXT,
      previous_ot_nv BOOLEAN DEFAULT FALSE,
      discharge_letter_needed BOOLEAN DEFAULT FALSE,
      eligibility_status TEXT DEFAULT 'not_started',   -- not_started|sent|pending|verified
      eligibility_sent_at TEXT,
      eligibility_email_to TEXT,
      referral_needed BOOLEAN DEFAULT FALSE,
      availability TEXT,                -- JSON grid + free text
      created_at TEXT,
      updated_at TEXT
    )`);
    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ot_clients_client ON ot_clients(client_id)`).catch(() => {});
    await dbRun(`CREATE TABLE IF NOT EXISTS ot_documents (
      id SERIAL PRIMARY KEY,
      ot_client_id INTEGER NOT NULL,
      kind TEXT,                        -- insurance_front|insurance_back|secondary_front|secondary_back|referral|order|prev_eval|discharge_letter|iep|medical|other
      filename TEXT,
      stored_name TEXT,
      mime_type TEXT,
      created_at TEXT
    )`);
    await dbRun(`CREATE TABLE IF NOT EXISTS ot_status_history (
      id SERIAL PRIMARY KEY,
      ot_client_id INTEGER NOT NULL,
      status TEXT,
      note TEXT,
      actor TEXT,
      created_at TEXT
    )`);
    await dbRun(`CREATE TABLE IF NOT EXISTS ot_activity (
      id SERIAL PRIMARY KEY,
      ot_client_id INTEGER NOT NULL,
      type TEXT,
      detail TEXT,
      actor TEXT,
      created_at TEXT
    )`);
    await dbRun(`CREATE TABLE IF NOT EXISTS ot_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    )`);
    // Seed configurable defaults (blank = admin must set before emails send).
    for (const k of ["ot_eligibility_email", "ot_intake_notification_emails", "ot_referral_email", "ot_general_notification_email"]) {
      await dbRun("INSERT INTO ot_settings (key, value, updated_at) VALUES (?, '', ?) ON CONFLICT (key) DO NOTHING", [k, nowISO()]).catch(() => {});
    }
    // Phase 2: a parent may start an intake before we've linked/created a shared
    // client identity, so client_id is nullable for drafts. Family matching &
    // linking is an explicit admin action (Phase 4) — we never auto-merge.
    await dbRun(`ALTER TABLE ot_clients ALTER COLUMN client_id DROP NOT NULL`).catch(() => {});
    await dbRun(`ALTER TABLE ot_clients ADD COLUMN IF NOT EXISTS potential_matches TEXT`).catch(() => {});
    await dbRun(`ALTER TABLE ot_clients ADD COLUMN IF NOT EXISTS signed_name TEXT`).catch(() => {});
    await dbRun(`ALTER TABLE ot_clients ADD COLUMN IF NOT EXISTS signed_at TEXT`).catch(() => {});
    // Phase 4: incomplete-intake reminders.
    await dbRun(`ALTER TABLE ot_clients ADD COLUMN IF NOT EXISTS reminder_stage INTEGER NOT NULL DEFAULT 0`).catch(() => {});
    await dbRun(`ALTER TABLE ot_clients ADD COLUMN IF NOT EXISTS last_reminder_at TEXT`).catch(() => {});
    await dbRun("INSERT INTO ot_settings (key, value, updated_at) VALUES ('ot_reminders_enabled', 'true', ?) ON CONFLICT (key) DO NOTHING", [nowISO()]).catch(() => {});
  }

  // ---- Phase 4: incomplete-intake reminder sweep (configurable, no spam) ----
  // Sends at most one reminder per stage (24h / 72h / 7d) after the intake was
  // started, only while it's unfinished, only if we have the parent's email.
  async function reminderSweep() {
    if (((await getSetting("ot_reminders_enabled")) || "true") !== "true") return;
    const rows = await dbAll(
      "SELECT * FROM ot_clients WHERE intake_submitted_at IS NULL AND intake_token IS NOT NULL AND status IN ('Intake Started','Intake Incomplete')"
    );
    const now = Date.now();
    const THRESH = [{ stage: 1, ms: 24 * 3600000, label: "24h" }, { stage: 2, ms: 72 * 3600000, label: "72h" }, { stage: 3, ms: 7 * 24 * 3600000, label: "7d" }];
    for (const o of rows) {
      const started = o.intake_started_at ? new Date(o.intake_started_at).getTime() : now;
      const elapsed = now - started;
      let target = 0, label = "";
      for (const t of THRESH) { if (elapsed >= t.ms) { target = t.stage; label = t.label; } }
      if (target <= (o.reminder_stage || 0)) continue;
      const demo = await resolveDemographics(o);
      if (!demo.parent_email) { await dbRun("UPDATE ot_clients SET reminder_stage = ? WHERE id = ?", [target, o.id]); continue; }
      const link = APP_BASE_URL + "/ot-intake?token=" + o.intake_token;
      await sendEmail({
        to: demo.parent_email,
        subject: "Finish your Spectrum Squad OT intake 💛",
        html: "<p>Hi " + esc(demo.parent_name || "there") + ",</p>" +
          "<p>You started your child’s Occupational Therapy intake with Spectrum Squad but haven’t finished yet. It only takes a few more minutes — and your progress is saved.</p>" +
          '<p><a href="' + link + '">Continue where you left off →</a></p>' +
          "<p>Warmly,<br>Spectrum Squad Occupational Therapy</p>",
        type: "ot_reminder",
      }).catch((e) => console.error("OT reminder email failed:", e.message));
      await dbRun("UPDATE ot_clients SET reminder_stage = ?, last_reminder_at = ? WHERE id = ?", [target, nowISO(), o.id]);
      await logActivity(o.id, "reminder_sent", "Incomplete-intake reminder (" + label + ")", "system");
    }
  }

  // Demographics for an OT record: from the linked shared client if one exists,
  // otherwise from the parent's own intake answers (unlinked draft/lead).
  async function resolveDemographics(o) {
    if (o && o.client_id) {
      const c = await dbGet("SELECT * FROM clients WHERE id = ?", [o.client_id]);
      if (c) return sharedDemographics(c);
    }
    const d = parseJson(o && o.intake_data, {}) || {};
    const cg = (d.caregivers && d.caregivers[0]) || {};
    return {
      client_id: null,
      child_name: d.child_name || [d.child_first, d.child_middle, d.child_last].filter(Boolean).join(" ").trim() || "New OT Lead",
      dob: d.dob || "",
      parent_name: d.parent_name || cg.name || "",
      parent_relationship: cg.relationship || "",
      parent_email: d.parent_email || cg.email || "",
      parent_phone: d.parent_phone || cg.phone || "",
      address: d.address || [d.street, d.city, d.state, d.zip].filter(Boolean).join(", "),
      also_aba: false,
    };
  }

  // Safe, conservative match check against existing families — NEVER auto-merges.
  // Returns candidates for an admin to confirm/link later (Phase 4).
  async function computePotentialMatches(intake) {
    const cg = (intake.caregivers && intake.caregivers[0]) || {};
    const email = (intake.parent_email || cg.email || "").trim().toLowerCase();
    const phone = (intake.parent_phone || cg.phone || "").replace(/\D/g, "");
    const childName = (intake.child_name || [intake.child_first, intake.child_last].filter(Boolean).join(" ")).trim().toLowerCase();
    const dob = (intake.dob || "").trim();
    const out = [];
    const seen = new Set();
    const add = (c, why) => { if (c && !seen.has(c.id)) { seen.add(c.id); out.push({ client_id: c.id, child_name: c.child_name, why }); } };
    if (email) { const rows = await dbAll("SELECT id, child_name FROM clients WHERE LOWER(parent_email) = ?", [email]); rows.forEach((c) => add(c, "same parent email")); }
    if (childName && dob) { const rows = await dbAll("SELECT id, child_name, dob FROM clients WHERE LOWER(child_name) = ? AND dob = ?", [childName, dob]); rows.forEach((c) => add(c, "same child name + DOB")); }
    if (phone) { const rows = await dbAll("SELECT id, child_name, parent_phone FROM clients"); rows.forEach((c) => { if (c.parent_phone && c.parent_phone.replace(/\D/g, "") === phone) add(c, "same phone"); }); }
    return out;
  }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
  function formatDob(dob) {
    if (!dob) return "";
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dob));
    return m ? m[2] + "/" + m[3] + "/" + m[1] : String(dob);
  }
  // Insurance card images (front/back + secondary), base64, for email attachment.
  async function buildEligibilityAttachments(otClientId) {
    const all = await dbAll("SELECT * FROM ot_documents WHERE ot_client_id = ? ORDER BY id", [otClientId]);
    const want = ["insurance_front", "insurance_back", "secondary_front", "secondary_back"];
    const atts = [];
    for (const d of all) {
      if (want.indexOf(d.kind) < 0) continue;
      const full = path.join(OT_DIR, d.stored_name);
      if (!fs.existsSync(full)) continue;
      atts.push({ filename: d.filename || d.kind, content: fs.readFileSync(full).toString("base64"), contentType: d.mime_type || "application/octet-stream" });
    }
    return atts;
  }
  // Sends the Eligibility & Benefits Verification email to the configured OT
  // recipient with the exact subject/body and the insurance card attachments.
  // Records status + activity. Never includes clinical info.
  async function sendEligibilityEmail(o, actor) {
    const recipient = (await getSetting("ot_eligibility_email") || "").trim();
    const demo = await resolveDemographics(o);
    const ins = (parseJson(o.intake_data, {}) || {}).insurance || {};
    const provider = o.insurance_provider || ins.provider || "";
    const memberId = o.insurance_member_id || ins.member_id || "";
    const childName = demo.child_name;
    const dob = formatDob(demo.dob);
    if (!recipient) {
      await dbRun("UPDATE ot_clients SET eligibility_status = 'needs_config', status = CASE WHEN status IN ('Intake Submitted','New OT Lead','Intake Incomplete') THEN 'Insurance Verification Needed' ELSE status END, updated_at = ? WHERE id = ?", [nowISO(), o.id]);
      await logActivity(o.id, "eligibility_blocked", "No OT eligibility email is configured in Settings.", actor || "system");
      return { ok: false, reason: "no_recipient" };
    }
    const attachments = await buildEligibilityAttachments(o.id);
    const subject = `Eligibility & Benefits Verification Needed - Spectrum Squad OT - ${childName} - DOB ${dob}`;
    const html =
      "<p>Hello,</p>" +
      "<p>Please complete an Eligibility &amp; Benefits Verification for the following Spectrum Squad Occupational Therapy client:</p>" +
      "<p><b>Child’s Name:</b><br>" + esc(childName) + "</p>" +
      "<p><b>DOB:</b><br>" + esc(dob) + "</p>" +
      "<p><b>Insurance:</b><br>" + esc(provider) + "</p>" +
      "<p><b>Member ID:</b><br>" + esc(memberId) + "</p>" +
      "<p><b>Parent/Caregiver:</b><br>" + esc(demo.parent_name) + "</p>" +
      "<p><b>Phone:</b><br>" + esc(demo.parent_phone) + "</p>" +
      "<p><b>Email:</b><br>" + esc(demo.parent_email) + "</p>" +
      "<p>Please verify Occupational Therapy benefits and eligibility.</p>" +
      "<p>Thank you,<br>Spectrum Squad Occupational Therapy</p>" +
      (attachments.length ? "<p>Insurance card " + (attachments.length > 1 ? "images are" : "image is") + " attached.</p>" : "");
    let delivered = "sent";
    try {
      const r = await sendEmail({ to: recipient.split(",").map((s) => s.trim()).filter(Boolean), subject, html, attachments, type: "ot_eligibility" });
      if (r && r.delivered != null) delivered = String(r.delivered);
    } catch (e) {
      await dbRun("UPDATE ot_clients SET eligibility_status = 'failed', updated_at = ? WHERE id = ?", [nowISO(), o.id]);
      await logActivity(o.id, "eligibility_failed", e.message, actor || "system");
      return { ok: false, reason: "send_failed", error: e.message };
    }
    await dbRun(
      "UPDATE ot_clients SET eligibility_status = 'sent', eligibility_sent_at = ?, eligibility_email_to = ?, status = CASE WHEN status IN ('Intake Submitted','Insurance Verification Needed','New OT Lead','Intake Incomplete') THEN 'Insurance Verification Pending' ELSE status END, updated_at = ? WHERE id = ?",
      [nowISO(), recipient, nowISO(), o.id]
    );
    await dbRun("INSERT INTO ot_status_history (ot_client_id, status, note, actor, created_at) VALUES (?, 'Insurance Verification Pending', ?, ?, ?)", [o.id, "Eligibility email sent to " + recipient, actor || "system", nowISO()]);
    await logActivity(o.id, "eligibility_sent", "Eligibility verification sent to " + recipient + " with " + attachments.length + " attachment(s)", actor || "system");
    return { ok: true, to: recipient, attachments: attachments.length, delivered };
  }

  async function getSetting(key) {
    const row = await dbGet("SELECT value FROM ot_settings WHERE key = ?", [key]);
    return row ? row.value : "";
  }
  async function setSetting(key, value) {
    await dbRun(
      "INSERT INTO ot_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at",
      [key, value || "", nowISO()]
    );
  }
  async function logActivity(otClientId, type, detail, actor) {
    await dbRun(
      "INSERT INTO ot_activity (ot_client_id, type, detail, actor, created_at) VALUES (?, ?, ?, ?, ?)",
      [otClientId, type, detail || "", actor || "system", nowISO()]
    );
  }

  // Only shared demographics ever cross into OT -- never ABA clinical/billing.
  function sharedDemographics(client) {
    if (!client) return {};
    return {
      client_id: client.id,
      child_name: client.child_name,
      dob: client.dob,
      parent_name: client.parent_name,
      parent_relationship: client.parent_relationship,
      parent_email: client.parent_email,
      parent_phone: client.parent_phone,
      address: client.address,
      preferred_contact: client.preferred_contact,
      also_aba: true, // presence of a clients row means they're known to ABA/intake
    };
  }

  // At-a-glance missing items for a dashboard card (no need to open the record).
  function missingItems(ot, docsByKind) {
    const items = [];
    const has = (k) => !!docsByKind[k];
    items.push({ label: "OT Intake", ok: ot.intake_submitted_at ? true : false, value: ot.intake_submitted_at ? "Complete" : `${ot.intake_progress || 0}%` });
    items.push({ label: "Insurance Card", ok: has("insurance_front") && has("insurance_back") });
    items.push({ label: "Eligibility", ok: ot.eligibility_status === "verified", value: ot.eligibility_status === "verified" ? "Verified" : (ot.eligibility_status === "sent" ? "Sent" : ot.eligibility_status === "pending" ? "Pending" : "Needed") });
    if (ot.discharge_letter_needed) items.push({ label: "Discharge Letter", ok: has("discharge_letter") });
    if (ot.referral_needed) items.push({ label: "Referral / Order", ok: has("referral") || has("order") });
    items.push({ label: "Availability", ok: !!ot.availability });
    return items;
  }

  async function docsByKindFor(otClientId) {
    const docs = await dbAll("SELECT id, kind, filename FROM ot_documents WHERE ot_client_id = ? ORDER BY id DESC", [otClientId]);
    const map = {};
    docs.forEach((d) => { if (!map[d.kind]) map[d.kind] = d; });
    return { docs, map };
  }

  // ---- API ----
  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/ot/")) return false;

    // Public (tokenized) intake endpoints get their own space in Phase 2.
    // Everything else requires an OT-permitted user.
    const isPublic = pathname.startsWith("/api/ot/public/");
    if (!isPublic) {
      if (!canViewOT(user)) { json(res, 403, { error: "Not permitted to access OT." }); return true; }
    }

    // ================= PUBLIC PARENT INTAKE (tokenized, no login) =================
    if (pathname === "/api/ot/public/intake/start" && method === "POST") {
      const token = newToken();
      const now = nowISO();
      await dbRun(
        `INSERT INTO ot_clients (status, intake_token, intake_progress, intake_started_at, intake_opened_at, last_activity_at, intake_data, created_at, updated_at)
         VALUES ('Intake Started', ?, 0, ?, ?, ?, '{}', ?, ?)`,
        [token, now, now, now, now, now]
      );
      return (json(res, 200, { token }), true);
    }
    const pubToken = pathname.match(/^\/api\/ot\/public\/intake\/([a-f0-9]+)(\/upload|\/submit)?$/);
    if (pubToken) {
      const token = pubToken[1];
      const sub = pubToken[2];
      const o = await dbGet("SELECT * FROM ot_clients WHERE intake_token = ?", [token]);
      if (!o) return (json(res, 404, { error: "This intake link is invalid or expired." }), true);

      // Resume: return saved answers so far.
      if (!sub && method === "GET") {
        return (json(res, 200, { data: parseJson(o.intake_data, {}), progress: o.intake_progress, submitted: !!o.intake_submitted_at }), true);
      }
      // Autosave partial answers.
      if (!sub && method === "PATCH") {
        if (o.intake_submitted_at) return (json(res, 200, { ok: true, locked: true }), true);
        const b = await readBody(req);
        const merged = Object.assign(parseJson(o.intake_data, {}), b.data || {});
        const progress = Number.isFinite(b.progress) ? b.progress : o.intake_progress;
        const ins = merged.insurance || {};
        await dbRun(
          `UPDATE ot_clients SET intake_data = ?, intake_progress = ?,
             status = CASE WHEN status = 'Intake Started' AND ? > 0 THEN 'Intake Incomplete' ELSE status END,
             insurance_provider = ?, insurance_member_id = ?, previous_ot_nv = ?,
             availability = ?, last_activity_at = ?, updated_at = ? WHERE intake_token = ?`,
          [JSON.stringify(merged), progress, progress, ins.provider || null, ins.member_id || null, !!merged.previous_ot_nv,
           merged.availability ? JSON.stringify(merged.availability) : o.availability, nowISO(), nowISO(), token]
        );
        return (json(res, 200, { ok: true }), true);
      }
      // File upload (insurance cards, discharge letter, referral, etc.).
      if (sub === "/upload" && method === "POST") {
        const b = await readBody(req);
        if (!b.content_base64 || !b.kind) return (json(res, 400, { error: "kind and file are required" }), true);
        const storedName = crypto.randomBytes(12).toString("hex");
        fs.writeFileSync(path.join(OT_DIR, storedName), Buffer.from(b.content_base64, "base64"));
        await dbRun(
          `INSERT INTO ot_documents (ot_client_id, kind, filename, stored_name, mime_type, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          [o.id, b.kind, b.filename || b.kind, storedName, b.mime_type || "application/octet-stream", nowISO()]
        );
        await logActivity(o.id, "document_uploaded", b.kind, "parent");
        return (json(res, 200, { ok: true, kind: b.kind }), true);
      }
      // Final submit — idempotent (prevents duplicate emails on refresh/resubmit).
      if (sub === "/submit" && method === "POST") {
        if (o.intake_submitted_at) return (json(res, 200, { ok: true, already: true }), true);
        const b = await readBody(req);
        const merged = Object.assign(parseJson(o.intake_data, {}), b.data || {});
        const ins = merged.insurance || {};
        const hasDischarge = await dbGet("SELECT id FROM ot_documents WHERE ot_client_id = ? AND kind = 'discharge_letter'", [o.id]);
        const dischargeNeeded = !!merged.previous_ot_nv && !hasDischarge;
        const matches = await computePotentialMatches(merged);
        await dbRun(
          `UPDATE ot_clients SET status = 'Intake Submitted', intake_progress = 100, intake_submitted_at = ?,
             intake_data = ?, insurance_provider = ?, insurance_member_id = ?, previous_ot_nv = ?,
             discharge_letter_needed = ?, availability = ?, signed_name = ?, signed_at = ?,
             potential_matches = ?, last_activity_at = ?, updated_at = ? WHERE id = ?`,
          [nowISO(), JSON.stringify(merged), ins.provider || null, ins.member_id || null, !!merged.previous_ot_nv,
           dischargeNeeded, merged.availability ? JSON.stringify(merged.availability) : null,
           b.signed_name || merged.signed_name || null, nowISO(), JSON.stringify(matches), nowISO(), nowISO(), o.id]
        );
        await dbRun("INSERT INTO ot_status_history (ot_client_id, status, note, actor, created_at) VALUES (?, 'Intake Submitted', '', 'parent', ?)", [o.id, nowISO()]);
        await logActivity(o.id, "intake_submitted", "Parent submitted OT intake", "parent");
        // Auto-send the Eligibility & Benefits Verification email once the
        // insurance card is submitted — but only once (guarded by
        // eligibility_sent_at, so a refresh/resubmit never re-sends).
        const freshO = await dbGet("SELECT * FROM ot_clients WHERE id = ?", [o.id]);
        const hasFront = await dbGet("SELECT id FROM ot_documents WHERE ot_client_id = ? AND kind = 'insurance_front'", [o.id]);
        const hasBack = await dbGet("SELECT id FROM ot_documents WHERE ot_client_id = ? AND kind = 'insurance_back'", [o.id]);
        if (hasFront && hasBack && !freshO.eligibility_sent_at) {
          await sendEligibilityEmail(freshO, "auto-intake").catch((e) => console.error("OT eligibility auto-send failed:", e.message));
        }
        // Notify the OT team if a recipient is configured.
        const notify = await getSetting("ot_intake_notification_emails");
        if (notify) {
          const demo = await resolveDemographics(await dbGet("SELECT * FROM ot_clients WHERE id = ?", [o.id]));
          sendEmail({
            to: notify.split(",").map((s) => s.trim()).filter(Boolean),
            subject: `New OT Intake — ${demo.child_name}`,
            html: `<p>A new Occupational Therapy intake was submitted.</p>
              <p><b>${demo.child_name}</b>${demo.dob ? ` (DOB ${demo.dob})` : ""}<br>
              Parent: ${demo.parent_name || "—"} · ${demo.parent_phone || "—"}<br>
              Insurance: ${ins.provider || "—"}${dischargeNeeded ? "<br><b>Previous OT discharge letter needed.</b>" : ""}</p>
              <p>Open the OT dashboard to review.</p>`,
            type: "ot_notification",
          }).catch((e) => console.error("OT intake notification failed:", e.message));
        }
        return (json(res, 200, { ok: true, discharge_letter_needed: dischargeNeeded }), true);
      }
    }

    // Dashboard: OT clients grouped by status with at-a-glance missing items.
    if (pathname === "/api/ot/dashboard" && method === "GET") {
      const rows = await dbAll(
        `SELECT * FROM ot_clients ORDER BY updated_at DESC NULLS LAST, id DESC`
      );
      const cards = [];
      for (const o of rows) {
        const { map } = await docsByKindFor(o.id);
        const demo = await resolveDemographics(o);
        cards.push({
          ot_client_id: o.id,
          client_id: o.client_id,
          child_name: demo.child_name,
          dob: demo.dob,
          parent_name: demo.parent_name,
          status: o.status,
          intake_progress: o.intake_progress,
          missing: missingItems(o, map),
          last_activity_at: o.last_activity_at,
        });
      }
      const byStatus = {};
      OT_STATUSES.forEach((s) => { byStatus[s] = []; });
      cards.forEach((c) => { (byStatus[c.status] = byStatus[c.status] || []).push(c); });
      return (json(res, 200, { statuses: OT_STATUSES, byStatus, total: cards.length }), true);
    }

    // Staff-initiated OT enrollment: creates a New OT Lead and (optionally)
    // emails the parent the intake link.
    if (pathname === "/api/ot/enrollment" && method === "POST") {
      const b = await readBody(req);
      const child = (b.child_name || "").trim();
      if (!child) return (json(res, 400, { error: "Child name is required." }), true);
      const token = newToken();
      const now = nowISO();
      const intakeData = JSON.stringify({ child_name: child, parent_name: (b.parent_name || "").trim(), parent_email: (b.parent_email || "").trim(), parent_phone: (b.parent_phone || "").trim() });
      const row = await dbRun(
        `INSERT INTO ot_clients (status, intake_token, intake_progress, intake_started_at, intake_opened_at, last_activity_at, intake_data, created_at, updated_at)
         VALUES ('New OT Lead', ?, 0, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [token, now, now, now, intakeData, now, now]
      );
      let emailed = false;
      if (b.parent_email) {
        const link = APP_BASE_URL + "/ot-intake?token=" + token;
        const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const r = await sendEmail({
          to: (b.parent_email || "").trim(),
          subject: "Complete your Occupational Therapy intake — Spectrum Squad",
          html: `<p>Hi ${esc(b.parent_name || "there")},</p><p>Thanks for your interest in Occupational Therapy at Spectrum Squad. Please complete your child's intake form to get started:</p><p><a href="${link}">Start the OT intake</a></p><p>Warmly,<br/>Spectrum Squad</p>`,
          type: "ot_notification",
        }).catch(() => null);
        emailed = !!(r && (r.delivered === "sent" || r.delivered === "simulated"));
      }
      return (json(res, 201, { ok: true, id: row.rows[0].id, token, emailed }), true);
    }

    // OT message outbox: every OT-related email sent (eligibility, reminders,
    // notifications). Viewable full-body in the OT area.
    if (pathname === "/api/ot/notifications" && method === "GET") {
      const rows = await dbAll(
        "SELECT id, client_id, type, recipient, subject, body, sent_at, delivered FROM notifications_log WHERE type LIKE 'ot%' ORDER BY sent_at DESC LIMIT 200"
      );
      return (json(res, 200, rows), true);
    }

    // OT client detail (shared demographics + OT record + docs + history).
    const detailMatch = pathname.match(/^\/api\/ot\/clients\/(\d+)$/);
    if (detailMatch && method === "GET") {
      const o = await dbGet("SELECT * FROM ot_clients WHERE id = ?", [detailMatch[1]]);
      if (!o) return (json(res, 404, { error: "Not found" }), true);
      const { docs } = await docsByKindFor(o.id);
      const history = await dbAll("SELECT * FROM ot_status_history WHERE ot_client_id = ? ORDER BY id DESC", [o.id]);
      const activity = await dbAll("SELECT * FROM ot_activity WHERE ot_client_id = ? ORDER BY id DESC LIMIT 100", [o.id]);
      return (json(res, 200, {
        ot: { ...o, intake_data: parseJson(o.intake_data, {}), availability: parseJson(o.availability, null), potential_matches: parseJson(o.potential_matches, []) },
        shared: await resolveDemographics(o),
        documents: docs,
        statusHistory: history,
        activity,
        statuses: OT_STATUSES,
      }), true);
    }

    // Update OT status (records history + activity).
    const statusMatch = pathname.match(/^\/api\/ot\/clients\/(\d+)\/status$/);
    if (statusMatch && method === "POST") {
      if (!canViewOT(user)) return (json(res, 403, { error: "Not permitted" }), true);
      const b = await readBody(req);
      if (!OT_STATUSES.includes(b.status)) return (json(res, 400, { error: "Invalid status" }), true);
      const id = Number(statusMatch[1]);
      await dbRun("UPDATE ot_clients SET status = ?, updated_at = ?, last_activity_at = ? WHERE id = ?", [b.status, nowISO(), nowISO(), id]);
      await dbRun("INSERT INTO ot_status_history (ot_client_id, status, note, actor, created_at) VALUES (?, ?, ?, ?, ?)", [id, b.status, b.note || "", user.email, nowISO()]);
      await logActivity(id, "status_change", `Status set to ${b.status}`, user.email);
      return (json(res, 200, { ok: true }), true);
    }

    // Manually (re)send the eligibility verification email. Admin only.
    const eligResend = pathname.match(/^\/api\/ot\/clients\/(\d+)\/eligibility\/resend$/);
    if (eligResend && method === "POST") {
      if (!canAdminOT(user)) return (json(res, 403, { error: "Not permitted" }), true);
      const o = await dbGet("SELECT * FROM ot_clients WHERE id = ?", [eligResend[1]]);
      if (!o) return (json(res, 404, { error: "Not found" }), true);
      const r = await sendEligibilityEmail(o, user.email);
      if (!r.ok && r.reason === "no_recipient") return (json(res, 400, { error: "No OT eligibility email is set. Add it in OT Settings first." }), true);
      return (json(res, r.ok ? 200 : 400, r), true);
    }

    // Family search (shared demographics ONLY — never ABA clinical) to link an
    // OT intake to an existing family. Respects permissions (OT-permitted users).
    if (pathname === "/api/ot/family-search" && method === "GET") {
      const q = (query.q || "").trim().toLowerCase();
      if (q.length < 2) return (json(res, 200, { results: [] }), true);
      const like = "%" + q + "%";
      const digits = q.replace(/\D/g, "");
      const rows = await dbAll(
        `SELECT id, child_name, dob, parent_name, parent_email, parent_phone FROM clients
          WHERE LOWER(child_name) LIKE ? OR LOWER(parent_name) LIKE ? OR LOWER(parent_email) LIKE ?
             OR (? <> '' AND REPLACE(REPLACE(REPLACE(REPLACE(parent_phone,'-',''),' ',''),'(',''),')','') LIKE ?)
          ORDER BY child_name LIMIT 15`,
        [like, like, like, digits, "%" + digits + "%"]
      );
      return (json(res, 200, { results: rows }), true);
    }
    // Link an OT record to an existing shared family (admin only). Audited.
    const linkMatch = pathname.match(/^\/api\/ot\/clients\/(\d+)\/link$/);
    if (linkMatch && method === "POST") {
      if (!canAdminOT(user)) return (json(res, 403, { error: "Not permitted" }), true);
      const b = await readBody(req);
      const o = await dbGet("SELECT * FROM ot_clients WHERE id = ?", [linkMatch[1]]);
      if (!o) return (json(res, 404, { error: "Not found" }), true);
      const target = await dbGet("SELECT id, child_name FROM clients WHERE id = ?", [b.client_id]);
      if (!target) return (json(res, 404, { error: "That family record was not found." }), true);
      await dbRun("UPDATE ot_clients SET client_id = ?, updated_at = ? WHERE id = ?", [target.id, nowISO(), o.id]);
      await logActivity(o.id, "family_linked", `Linked to existing family "${target.child_name}" (client #${target.id}) — was ${o.client_id ? "client #" + o.client_id : "unlinked"}`, user.email);
      return (json(res, 200, { ok: true }), true);
    }
    const unlinkMatch = pathname.match(/^\/api\/ot\/clients\/(\d+)\/unlink$/);
    if (unlinkMatch && method === "POST") {
      if (!canAdminOT(user)) return (json(res, 403, { error: "Not permitted" }), true);
      const o = await dbGet("SELECT * FROM ot_clients WHERE id = ?", [unlinkMatch[1]]);
      if (!o) return (json(res, 404, { error: "Not found" }), true);
      await dbRun("UPDATE ot_clients SET client_id = NULL, updated_at = ? WHERE id = ?", [nowISO(), o.id]);
      await logActivity(o.id, "family_unlinked", `Unlinked from client #${o.client_id}`, user.email);
      return (json(res, 200, { ok: true }), true);
    }

    // Serve an OT document (authenticated only -- never a public URL).
    const docMatch = pathname.match(/^\/api\/ot\/documents\/(\d+)$/);
    if (docMatch && method === "GET") {
      const doc = await dbGet("SELECT * FROM ot_documents WHERE id = ?", [docMatch[1]]);
      if (!doc) return (json(res, 404, { error: "Not found" }), true);
      const full = path.join(OT_DIR, doc.stored_name);
      if (!fs.existsSync(full)) return (json(res, 404, { error: "File missing" }), true);
      return (sendFile(res, 200, fs.readFileSync(full), doc.mime_type || "application/octet-stream", doc.filename || "document"), true);
    }

    // OT settings (admin only).
    if (pathname === "/api/ot/settings" && method === "GET") {
      if (!canAdminOT(user)) return (json(res, 403, { error: "Not permitted" }), true);
      const rows = await dbAll("SELECT key, value FROM ot_settings ORDER BY key");
      const out = {};
      rows.forEach((r) => { out[r.key] = r.value; });
      return (json(res, 200, out), true);
    }
    if (pathname === "/api/ot/settings" && method === "POST") {
      if (!canAdminOT(user)) return (json(res, 403, { error: "Not permitted" }), true);
      const b = await readBody(req);
      const allowed = ["ot_eligibility_email", "ot_intake_notification_emails", "ot_referral_email", "ot_general_notification_email"];
      for (const k of allowed) { if (b[k] !== undefined) await setSetting(k, b[k]); }
      return (json(res, 200, { ok: true }), true);
    }

    return false;
  }

  // ---- public pages ----
  // Phase 2 replaces this stub with the full multi-step parent intake form.
  async function servePage(req, res, pathname) {
    if (pathname === "/ot-intake" || pathname.startsWith("/ot-intake/")) {
      const file = path.join(__dirname, "ot-intake.html");
      if (fs.existsSync(file)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(fs.readFileSync(file, "utf8"));
        return true;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>OT Intake</title><p>OT intake form is being set up. Please check back shortly.</p>");
      return true;
    }
    return false;
  }

  return { initTables, handleApi, servePage, reminderSweep, canViewOT, canAdminOT, isOtOnly, OT_STATUSES };
};
