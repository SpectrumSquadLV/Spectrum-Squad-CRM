// client-forms.js -- Parent-facing interactive client forms for Spectrum Squad.
// Backend add-on module (same pattern as hr.js): required from server.js with
// shared deps injected. Owns:
//   * Financial Obligation form (Good Faith Estimate / financial responsibility)
//     -- staff enter the eligibility results, the parent gets a cute interactive
//     form to sign, and the signed acknowledgment is kept in the client file.
//   * Parent schedule-request form (Phase 4) lives in its own module additions.
//
// Public endpoints (no auth) live under /api/client-forms/public/* and the
// pages are served at /financial-form/. Staff endpoints require a logged-in
// user (enforced here since this is dispatched before the global auth gate).
"use strict";

const path = require("path");
const fs = require("fs");

module.exports = function initClientForms(ctx) {
  const onCompletion = ctx.onCompletion || (() => {});
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
    // Optional: modules are constructed in different orders, and a missing
    // recorder must never be the reason a parent's signature fails to save.
  } = ctx;
  // Writing a file onto a client's record is server.js's job -- it owns the
  // volume, the size cap, the card/diagnosis detection and the eligibility
  // trigger. This module hands it the parent's upload rather than keeping a
  // second copy of any of that.
  const saveClientDocument = ctx.saveClientDocument || (async () => ({ ok: false, status: 500, error: "Uploads are not available on this server." }));

  // ============================ SCHEMA ============================
  async function initTables() {
    await dbRun(`
      CREATE TABLE IF NOT EXISTS client_financial_forms (
        id SERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        plan_type TEXT NOT NULL,            -- copay | secondary | mco
        copay_amount TEXT,
        copay_per TEXT,                     -- day | session
        coinsurance_pct TEXT,
        deductible TEXT,
        deductible_remaining TEXT,
        oop_max TEXT,
        oop_remaining TEXT,
        secondary_insurance_name TEXT,
        mco_name TEXT,
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'sent', -- sent | viewed | signed
        signed_name TEXT,
        signed_at TEXT,
        viewed_at TEXT,
        sent_at TEXT,
        created_by TEXT,
        created_at TEXT
      );
    `);
    await dbRun(`
      CREATE TABLE IF NOT EXISTS client_schedule_requests (
        id SERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'sent',  -- sent | viewed | submitted
        selected_slots TEXT,                  -- JSON: ["1-8","1-9","2-13",...] (day-hour)
        total_hours INTEGER,
        viewed_at TEXT,
        submitted_at TEXT,
        sent_at TEXT,
        created_at TEXT
      );
    `);
    // Documents we ask the PARENT for, and the tokenized link they upload
    // through. One row per client per request; asking again reuses the open
    // row rather than minting a second link, so a family never ends up with
    // two live upload pages.
    await dbRun(`
      CREATE TABLE IF NOT EXISTS client_document_requests (
        id SERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'sent',  -- sent | viewed | partial | complete
        received TEXT NOT NULL DEFAULT '{}',  -- JSON: { slotKey: {document_id, filename, at} }
        viewed_at TEXT,
        completed_at TEXT,
        sent_at TEXT,
        send_count INTEGER NOT NULL DEFAULT 1,
        last_sent_at TEXT,
        created_by TEXT,
        created_at TEXT
      );
    `);
    await dbRun(`CREATE INDEX IF NOT EXISTS client_document_requests_client_idx
                 ON client_document_requests (client_id)`).catch(() => {});
    console.log("Client Forms schema ready.");
  }

  // ==================== PARENT DOCUMENT REQUESTS ====================
  // The two things intake cannot start without: the official autism diagnosis,
  // and both sides of the insurance card. Asking for them by email and having
  // the reply land straight on the client's record is the whole point -- an
  // attachment in somebody's inbox is not on the record, and the eligibility
  // check is blocked until the card actually is.
  const DOC_SLOTS = [
    {
      key: "diagnosis",
      label: "Official autism diagnosis",
      hint: "The signed evaluation or diagnostic report from the doctor or psychologist. A photo of each page is fine.",
      icon: "📄",
      docLabel: "Official Autism Diagnosis",
    },
    {
      key: "card_front",
      label: "Insurance card — front",
      hint: "A clear photo of the front of the card. Make sure the member ID is readable.",
      icon: "💳",
      docLabel: "Insurance Card (front)",
      insuranceCard: true,
    },
    {
      key: "card_back",
      label: "Insurance card — back",
      hint: "The back of the same card — this is where the claims address and phone number live.",
      icon: "🔄",
      docLabel: "Insurance Card (back)",
      insuranceCard: true,
    },
  ];
  const DOC_SLOT_KEYS = DOC_SLOTS.map((s) => s.key);
  const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
  const MAX_UPLOADS_PER_REQUEST = 20;

  function parseReceived(row) {
    try { return JSON.parse((row && row.received) || "{}") || {}; } catch (e) { return {}; }
  }
  function requestStatus(received) {
    const have = DOC_SLOT_KEYS.filter((k) => received[k]);
    if (have.length === DOC_SLOT_KEYS.length) return "complete";
    if (have.length) return "partial";
    return "sent";
  }
  function documentRequestLink(token) {
    return `${APP_BASE_URL}/client-documents/?token=${token}`;
  }

  // Create (or reuse) a request and email the parent. `resend` is what the
  // staff button sends when they want to chase a family who already has a link
  // -- it re-emails the SAME link rather than issuing a new one.
  async function sendDocumentRequest(clientId, actor) {
    const client = await dbGet("SELECT * FROM clients WHERE id = ?", [clientId]);
    if (!client) return { ok: false, status: 404, error: "Client not found." };
    if (!client.parent_email) {
      return { ok: false, status: 400, error: "This family has no parent email on file, so the request can't be sent." };
    }

    let row = await dbGet(
      "SELECT * FROM client_document_requests WHERE client_id = ? ORDER BY id DESC LIMIT 1",
      [clientId]
    );
    const now = nowISO();
    if (!row) {
      const token = crypto.randomBytes(24).toString("hex");
      row = await dbGet(
        `INSERT INTO client_document_requests (client_id, token, status, received, sent_at, last_sent_at, send_count, created_by, created_at)
         VALUES (?, ?, 'sent', '{}', ?, ?, 1, ?, ?) RETURNING *`,
        [clientId, token, now, now, actor || "system", now]
      );
    } else {
      row = await dbGet(
        `UPDATE client_document_requests
            SET last_sent_at = ?, send_count = send_count + 1
          WHERE id = ? RETURNING *`,
        [now, row.id]
      );
    }

    const received = parseReceived(row);
    const outstanding = DOC_SLOTS.filter((sl) => !received[sl.key]);
    if (!outstanding.length) {
      return { ok: false, status: 409, code: "already_complete", error: "This family has already sent everything we asked for." };
    }

    const link = documentRequestLink(row.token);
    const items = outstanding
      .map((sl) => `<li style="margin-bottom:6px;"><strong>${esc(sl.label)}</strong><br/><span style="color:#666;font-size:13px;">${esc(sl.hint)}</span></li>`)
      .join("");
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#1b2a6b;">
        <h2 style="color:#1b2a6b;">Two documents for ${esc(client.child_name)} 💛</h2>
        <p>Hi ${esc(client.parent_name || "there")},</p>
        <p>To keep ${esc(client.child_name)}'s enrollment moving, we need a couple of documents from you. You can take photos with your phone and upload them straight from this link — no account, no printing, no scanner.</p>
        <ul style="padding-left:18px;">${items}</ul>
        <p style="text-align:center;margin:28px 0;">
          <a href="${esc(link)}" style="background:#e0a430;color:#1b2a6b;font-weight:700;text-decoration:none;padding:14px 28px;border-radius:999px;font-size:16px;display:inline-block;">Upload Documents →</a>
        </p>
        <p style="font-size:13px;color:#666;">If the button doesn't work, copy and paste this link:<br/>${esc(link)}</p>
        <p style="font-size:13px;color:#666;">This link is private to your family. Please don't forward it.</p>
        <p>Thank you!<br/>The Spectrum Squad Team</p>
      </div>`;

    const sent = await sendEmail({
      to: client.parent_email,
      subject: `Documents needed for ${client.child_name} — Spectrum Squad`,
      html,
      clientId,
      type: "document_request",
    }).catch((e) => { console.error("document request email failed:", e.message); return null; });

    return {
      ok: true,
      token: row.token,
      link,
      sent_to: client.parent_email,
      delivered: sent ? sent.delivered : "failed",
      outstanding: outstanding.map((sl) => sl.key),
      resend: Number(row.send_count) > 1,
    };
  }

  // What staff see on the client card.
  async function documentRequestStatus(clientId) {
    const row = await dbGet(
      "SELECT * FROM client_document_requests WHERE client_id = ? ORDER BY id DESC LIMIT 1",
      [clientId]
    );
    const received = parseReceived(row);
    return {
      client_id: Number(clientId),
      requested: !!row,
      status: row ? row.status : null,
      sent_at: row ? row.sent_at : null,
      last_sent_at: row ? row.last_sent_at : null,
      send_count: row ? Number(row.send_count || 1) : 0,
      viewed_at: row ? row.viewed_at : null,
      completed_at: row ? row.completed_at : null,
      link: row ? documentRequestLink(row.token) : null,
      items: DOC_SLOTS.map((sl) => ({
        key: sl.key,
        label: sl.label,
        received: !!received[sl.key],
        received_at: received[sl.key] ? received[sl.key].at : null,
        filename: received[sl.key] ? received[sl.key].filename : null,
        document_id: received[sl.key] ? received[sl.key].document_id : null,
      })),
    };
  }

  // The parent's upload. Files land on the client's record through the shared
  // saveClientDocument() in server.js -- the same function the client card and
  // the bulk importer use -- so the card is flagged as the card, the checklist
  // boxes tick themselves, and the eligibility check fires as soon as a card is
  // genuinely on file.
  async function receiveDocumentUpload(token, slotKey, file) {
    const row = await dbGet("SELECT * FROM client_document_requests WHERE token = ?", [token]);
    if (!row) return { ok: false, status: 404, error: "This upload link is not valid." };
    const slot = DOC_SLOTS.find((sl) => sl.key === slotKey);
    if (!slot) return { ok: false, status: 400, error: "Unknown document type." };
    // Re-uploading is legitimate -- a first photo is often too dark to read --
    // but the link is unauthenticated, so the number of files one request can
    // put on a client's record is bounded. Generous enough that no real family
    // will meet it.
    const already = await dbGet(
      "SELECT COUNT(*)::int AS n FROM client_documents WHERE client_id = ? AND label IN (?, ?, ?)",
      [row.client_id, DOC_SLOTS[0].docLabel, DOC_SLOTS[1].docLabel, DOC_SLOTS[2].docLabel]
    ).catch(() => ({ n: 0 }));
    if (already && Number(already.n) >= MAX_UPLOADS_PER_REQUEST) {
      return {
        ok: false, status: 429,
        error: "This link has reached its upload limit. Please contact Spectrum Squad and we'll send you a fresh one.",
      };
    }
    if (!file || !file.content_base64 || !file.filename) {
      return { ok: false, status: 400, error: "Please choose a file to upload." };
    }
    // Sized here as well as in saveClientDocument so a parent on a phone gets
    // the friendly message rather than a generic failure.
    const approxBytes = Math.floor((String(file.content_base64).length * 3) / 4);
    if (approxBytes > MAX_UPLOAD_BYTES) {
      return { ok: false, status: 400, error: "That file is too large (15MB max). Try taking the photo again at a smaller size." };
    }

    const saved = await saveClientDocument({
      client_id: row.client_id,
      label: slot.docLabel,
      filename: file.filename,
      mime_type: file.mime_type,
      content_base64: file.content_base64,
      is_insurance_card: !!slot.insuranceCard,
      is_diagnosis: slot.key === "diagnosis",
      actor: "parent upload",
    });
    if (!saved.ok) return { ok: false, status: saved.status || 400, error: saved.error };

    const received = parseReceived(row);
    received[slot.key] = { document_id: saved.document.id, filename: file.filename, at: nowISO() };
    const status = requestStatus(received);
    await dbRun(
      `UPDATE client_document_requests
          SET received = ?, status = ?, viewed_at = COALESCE(viewed_at, ?),
              completed_at = CASE WHEN ? = 'complete' THEN COALESCE(completed_at, ?) ELSE completed_at END
        WHERE id = ?`,
      [JSON.stringify(received), status, nowISO(), status, nowISO(), row.id]
    );

    if (status === "complete") {
      const client = await dbGet("SELECT child_name FROM clients WHERE id = ?", [row.client_id]).catch(() => null);
      onCompletion("client_documents_received", {
        subject: client && client.child_name,
        detail: "Diagnosis and both sides of the insurance card received",
        clientId: row.client_id,
        dedupeKey: `doc_request:${row.id}`,
        link: `${APP_BASE_URL}/#/pipeline/${row.client_id}`,
      });
    }

    return {
      ok: true,
      slot: slot.key,
      status,
      received: DOC_SLOT_KEYS.filter((k) => received[k]),
      eligibility_sent: !!(saved.eligibility && saved.eligibility.ok && !saved.eligibility.skipped),
    };
  }

  // Clinic operating window and scheduling rules (Mon-Fri 8am-7pm).
  const OPEN_HOUR = 8;   // 8am
  const CLOSE_HOUR = 19; // 7pm (last hour block starts at 18:00)
  const DAYS = [1, 2, 3, 4, 5]; // Mon..Fri
  const MIN_HOURS = 15;
  const MAX_HOURS_PER_DAY = 8;
  const RBT_WEEKLY_CAPACITY = 30;   // default hrs/week per RBT
  const BCBA_PER_RBT = 6;           // ~1 BCBA supervises up to 6 RBTs

  // ============================ HELPERS ============================
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function money(v) {
    if (v == null || v === "") return null;
    const n = String(v).replace(/[^0-9.\-]/g, "");
    if (n === "") return null;
    return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  const PLAN_TYPES = ["copay", "secondary", "mco"];

  // ============================ CORE ============================
  async function createFinancialForm(body, actor) {
    const clientId = Number(body.client_id);
    const client = await dbGet("SELECT * FROM clients WHERE id = ?", [clientId]);
    if (!client) return { ok: false, status: 404, error: "Client not found" };
    const planType = String(body.plan_type || "").trim();
    if (!PLAN_TYPES.includes(planType)) return { ok: false, status: 400, error: "Choose a plan type (co-pay, secondary, or MCO)." };

    const token = crypto.randomBytes(24).toString("hex");
    const row = await dbGet(
      `INSERT INTO client_financial_forms
        (client_id, token, plan_type, copay_amount, copay_per, coinsurance_pct, deductible,
         deductible_remaining, oop_max, oop_remaining, secondary_insurance_name, mco_name,
         notes, status, sent_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?)
       RETURNING *`,
      [
        clientId, token, planType,
        body.copay_amount || null, body.copay_per || "day", body.coinsurance_pct || null,
        body.deductible || null, body.deductible_remaining || null, body.oop_max || null,
        body.oop_remaining || null, body.secondary_insurance_name || null, body.mco_name || null,
        body.notes || null, nowISO(), actor || "staff", nowISO(),
      ]
    );

    // Email the parent a link to the interactive form.
    if (client.parent_email) {
      const link = `${APP_BASE_URL}/financial-form/?token=${token}`;
      const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;color:#1b2a6b;">
          <h2 style="color:#1b2a6b;">One quick step for ${esc(client.child_name)} 💛</h2>
          <p>Hi ${esc(client.parent_name || "there")},</p>
          <p>We've completed the insurance benefits check for <strong>${esc(client.child_name)}</strong>! The last step before we move forward is a quick, friendly review of what your insurance covers and what (if anything) you'd be responsible for — then a simple signature.</p>
          <p style="text-align:center;margin:28px 0;">
            <a href="${esc(link)}" style="background:#e0a430;color:#1b2a6b;font-weight:700;text-decoration:none;padding:14px 28px;border-radius:999px;font-size:16px;display:inline-block;">Review &amp; Sign →</a>
          </p>
          <p style="font-size:13px;color:#666;">It only takes a minute. If the button doesn't work, copy and paste this link:<br/>${esc(link)}</p>
          <p>Warmly,<br/>The Spectrum Squad Team</p>
        </div>`;
      await sendEmail({
        to: client.parent_email,
        subject: `Your financial review for ${client.child_name} — Spectrum Squad`,
        html,
        clientId,
        type: "financial_form",
      }).catch((e) => console.error("financial form email failed:", e));
    }

    return { ok: true, form: row, link: `${APP_BASE_URL}/financial-form/?token=${token}`, emailed: !!client.parent_email };
  }

  async function listFinancialForms(clientId) {
    return dbAll(
      `SELECT id, client_id, token, plan_type, copay_amount, copay_per, status,
              signed_name, signed_at, viewed_at, sent_at, created_at
         FROM client_financial_forms WHERE client_id = ? ORDER BY id DESC`,
      [clientId]
    );
  }

  async function getPublicForm(token) {
    const form = await dbGet("SELECT * FROM client_financial_forms WHERE token = ?", [token]);
    if (!form) return null;
    const client = await dbGet("SELECT child_name, parent_name FROM clients WHERE id = ?", [form.client_id]);
    if (form.status === "sent") {
      await dbRun("UPDATE client_financial_forms SET status = 'viewed', viewed_at = ? WHERE id = ? AND status = 'sent'", [nowISO(), form.id]);
    }
    return { form, client };
  }

  async function signForm(token, signedName) {
    const form = await dbGet("SELECT * FROM client_financial_forms WHERE token = ?", [token]);
    if (!form) return { ok: false, status: 404, error: "Form not found" };
    if (form.status === "signed") return { ok: true, alreadySigned: true };
    const name = String(signedName || "").trim();
    if (!name) return { ok: false, status: 400, error: "Please type your name to sign." };

    await dbRun(
      "UPDATE client_financial_forms SET status = 'signed', signed_name = ?, signed_at = ? WHERE id = ?",
      [name, nowISO(), form.id]
    );

    const client = await dbGet("SELECT * FROM clients WHERE id = ?", [form.client_id]);

    // The one Quiana named first: nothing used to tell anyone this had been
    // signed. The form id is the dedupe key -- a form can only be signed once,
    // and the early return above already handles a double submit.
    onCompletion("financial_form_signed", {
      subject: client && client.child_name,
      detail: `Signed by ${name}`,
      clientId: form.client_id,
      dedupeKey: `financial_form:${form.id}`,
      link: `${APP_BASE_URL}/#/pipeline/${form.client_id}`,
    });

    // Keep the signed acknowledgment in the client's file as a viewable link.
    await dbRun(
      `INSERT INTO client_documents (client_id, label, filename, mime_type, file_path, doc_type, external_url, uploaded_at)
       VALUES (?, ?, ?, NULL, NULL, 'link', ?, ?)`,
      [
        form.client_id,
        `Signed Financial Responsibility Form (${new Date().toLocaleDateString()})`,
        "financial-responsibility.html",
        `${APP_BASE_URL}/financial-form/?token=${token}`,
        nowISO(),
      ]
    ).catch((e) => console.error("could not file signed form:", e));

    // Confirmation to the parent + a copy of the record kept in the outbox.
    if (client && client.parent_email) {
      await sendEmail({
        to: client.parent_email,
        subject: `Thank you — financial form signed for ${client.child_name}`,
        html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#1b2a6b;">
          <h2>All done, thank you! 🎉</h2>
          <p>Hi ${esc(client.parent_name || "there")}, we've received your signed financial responsibility form for <strong>${esc(client.child_name)}</strong>. A copy is saved in your file. You can view it anytime here:</p>
          <p><a href="${esc(APP_BASE_URL)}/financial-form/?token=${esc(token)}">View signed form</a></p>
          <p>Warmly,<br/>The Spectrum Squad Team</p></div>`,
        clientId: form.client_id,
        type: "financial_form",
      }).catch((e) => console.error("sign confirmation email failed:", e));
    }

    return { ok: true, signed_at: nowISO(), signed_name: name };
  }

  // ======================= SCHEDULE REQUESTS =======================
  async function sendScheduleRequest(client, force) {
    if (!client) return { ok: false, error: "No client" };
    // Don't spam: reuse an outstanding (not-yet-submitted) request unless forced.
    if (!force) {
      const existing = await dbGet(
        "SELECT * FROM client_schedule_requests WHERE client_id = ? AND status <> 'submitted' ORDER BY id DESC LIMIT 1",
        [client.id]
      );
      if (existing) return { ok: true, reused: true, token: existing.token };
    }
    const token = crypto.randomBytes(24).toString("hex");
    await dbRun(
      `INSERT INTO client_schedule_requests (client_id, token, status, sent_at, created_at)
       VALUES (?, ?, 'sent', ?, ?)`,
      [client.id, token, nowISO(), nowISO()]
    );
    if (client.parent_email) {
      const link = `${APP_BASE_URL}/schedule-request/?token=${token}`;
      const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;color:#1b2a6b;">
          <h2 style="color:#1b2a6b;">Let's build ${esc(client.child_name)}'s schedule! 🗓️✨</h2>
          <p>Hi ${esc(client.parent_name || "there")},</p>
          <p>Exciting news — it's time to choose the days and times that work best for <strong>${esc(client.child_name)}</strong>'s therapy! We've made it fun and easy: just tap the times that work for your family.</p>
          <p style="text-align:center;margin:28px 0;">
            <a href="${esc(link)}" style="background:#e0a430;color:#1b2a6b;font-weight:700;text-decoration:none;padding:14px 28px;border-radius:999px;font-size:16px;display:inline-block;">Pick our times →</a>
          </p>
          <p style="font-size:13px;color:#666;">If the button doesn't work, paste this link:<br/>${esc(link)}</p>
          <p>Can't wait to get started,<br/>The Spectrum Squad Team</p>
        </div>`;
      await sendEmail({
        to: client.parent_email,
        subject: `Pick ${client.child_name}'s therapy schedule — Spectrum Squad`,
        html,
        clientId: client.id,
        type: "schedule_request",
      }).catch((e) => console.error("schedule request email failed:", e));
    }
    return { ok: true, token, emailed: !!client.parent_email };
  }

  async function getPublicScheduleRequest(token) {
    const reqRow = await dbGet("SELECT * FROM client_schedule_requests WHERE token = ?", [token]);
    if (!reqRow) return null;
    const client = await dbGet("SELECT child_name, parent_name FROM clients WHERE id = ?", [reqRow.client_id]);
    if (reqRow.status === "sent") {
      await dbRun("UPDATE client_schedule_requests SET status = 'viewed', viewed_at = ? WHERE id = ? AND status = 'sent'", [nowISO(), reqRow.id]);
    }
    return { reqRow, client };
  }

  function validateSlots(slots) {
    if (!Array.isArray(slots)) return { ok: false, error: "No times selected." };
    const clean = [];
    const perDay = {};
    for (const s of slots) {
      const m = /^([1-5])-(\d{1,2})$/.exec(String(s));
      if (!m) continue;
      const day = Number(m[1]), hour = Number(m[2]);
      if (!DAYS.includes(day) || hour < OPEN_HOUR || hour >= CLOSE_HOUR) continue;
      const key = `${day}-${hour}`;
      if (clean.includes(key)) continue;
      clean.push(key);
      perDay[day] = (perDay[day] || 0) + 1;
    }
    for (const d of Object.keys(perDay)) {
      if (perDay[d] > MAX_HOURS_PER_DAY) return { ok: false, error: `No more than ${MAX_HOURS_PER_DAY} hours per day.` };
    }
    if (clean.length < MIN_HOURS) return { ok: false, error: `Please select at least ${MIN_HOURS} hours.` };
    return { ok: true, slots: clean, total: clean.length };
  }

  async function submitScheduleRequest(token, slots) {
    const reqRow = await dbGet("SELECT * FROM client_schedule_requests WHERE token = ?", [token]);
    if (!reqRow) return { ok: false, status: 404, error: "This link is invalid or has expired." };
    if (reqRow.status === "submitted") return { ok: true, alreadySubmitted: true };
    const v = validateSlots(slots);
    if (!v.ok) return { ok: false, status: 400, error: v.error };
    await dbRun(
      "UPDATE client_schedule_requests SET status = 'submitted', selected_slots = ?, total_hours = ?, submitted_at = ? WHERE id = ?",
      [JSON.stringify(v.slots), v.total, nowISO(), reqRow.id]
    );
    // Store a friendly summary on the client's desired_schedule for quick reference.
    const client = await dbGet("SELECT * FROM clients WHERE id = ?", [reqRow.client_id]);
    onCompletion("schedule_request_submitted", {
      subject: client && client.child_name,
      detail: `${v.total} hrs/week requested`,
      clientId: reqRow.client_id,
      dedupeKey: `schedule_request:${reqRow.id}`,
      link: `${APP_BASE_URL}/#/pipeline/${reqRow.client_id}`,
    });
    await dbRun("UPDATE clients SET desired_schedule = ?, updated_at = ? WHERE id = ?", [
      `${v.total} hrs/wk (parent-selected)`, nowISO(), reqRow.client_id,
    ]);
    if (client) {
      await sendEmail({
        to: client.parent_email || (await getAppFallback()),
        subject: `Schedule received for ${client.child_name}`,
        html: `<p>Thank you! We received your preferred schedule (${v.total} hours/week) for ${esc(client.child_name)}. Our team will finalize therapist assignments and confirm with you.</p>`,
        clientId: client.id,
        type: "schedule_request",
      }).catch(() => {});
      // Notify the staff recipients an admin chose to receive schedule requests.
      // Configured under Admin Settings; blank means nobody is emailed (the
      // request is still attached to the client profile for tracking either way).
      const recipRow = await dbGet("SELECT value FROM app_settings WHERE key = 'schedule_request_recipients'").catch(() => null);
      const recipients = ((recipRow && recipRow.value) || "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
      for (const to of recipients) {
        await sendEmail({
          to,
          subject: `📅 ${client.child_name}'s family submitted their schedule (${v.total} hrs/week)`,
          html: `<p>${esc(client.parent_name || "A parent")} submitted a preferred schedule for <strong>${esc(client.child_name)}</strong>.</p>
            <p><strong>Requested:</strong> ${v.total} hours/week</p>
            <p>Open the client in the CRM to review the selected time blocks and finalize therapist assignments.</p>`,
          clientId: client.id,
          type: "schedule_request_staff",
        }).catch((e) => console.error("schedule request staff notify failed:", e.message));
      }
    }
    return { ok: true, total: v.total };
  }
  // parent_email may be null; sendEmail tolerates it (logs), so provide "" fallback.
  async function getAppFallback() { return ""; }

  async function listScheduleRequests(clientId) {
    return dbAll(
      "SELECT id, client_id, token, status, total_hours, selected_slots, viewed_at, submitted_at, sent_at FROM client_schedule_requests WHERE client_id = ? ORDER BY id DESC",
      [clientId]
    );
  }

  // ---- Staffing estimator ----
  // Demand = all submitted parent schedule requests for clients who are near or
  // in active services. Bin-packs the actual requested time slots into as few
  // hypothetical staff members as possible (1:1 ABA: a staff can serve different
  // clients at different times, but never two at once; <=8 hrs/day, <=capacity/wk).
  const DEMAND_STAGES = ["assessment_scheduling", "authorization", "first_day_scheduled", "active"];

  async function staffingEstimate(opts) {
    opts = opts || {};
    const rbtCapacity = Number(opts.rbtCapacity) || RBT_WEEKLY_CAPACITY;
    const bcbaPerRbt = Number(opts.bcbaPerRbt) || BCBA_PER_RBT;

    const requests = await dbAll(
      `SELECT sr.*, c.child_name, c.stage
         FROM client_schedule_requests sr
         JOIN clients c ON c.id = sr.client_id
        WHERE sr.status = 'submitted'
          AND c.stage NOT IN ('discharged','not_moving_forward')`
    );
    // Keep only the latest submitted request per client.
    const latestByClient = {};
    for (const r of requests) {
      if (!latestByClient[r.client_id] || r.id > latestByClient[r.client_id].id) latestByClient[r.client_id] = r;
    }
    // Count every family who has committed to a schedule (and isn't discharged
    // -- the SQL already excludes terminal stages), so you can plan hires ahead.
    const clientDemands = Object.values(latestByClient)
      .map((r) => {
        let slots = [];
        try { slots = JSON.parse(r.selected_slots || "[]"); } catch (e) {}
        return { client_id: r.client_id, child_name: r.child_name, stage: r.stage, slots };
      })
      .filter((c) => c.slots.length);

    const totalHours = clientDemands.reduce((s, c) => s + c.slots.length, 0);

    // Greedy bin-packing into staff.
    const staff = []; // each: { slots:Set, perDay:{}, total:0, clients:Set, grid:[] }
    function canFit(member, slots) {
      const dayCount = {};
      for (const s of slots) {
        if (member.slots.has(s)) return false; // time conflict (already booked)
        const day = s.split("-")[0];
        dayCount[day] = (dayCount[day] || 0) + 1;
      }
      if (member.total + slots.length > rbtCapacity) return false;
      for (const day of Object.keys(dayCount)) {
        const existing = member.perDay[day] || 0;
        if (existing + dayCount[day] > MAX_HOURS_PER_DAY) return false;
      }
      return true;
    }
    function place(member, c) {
      for (const s of c.slots) {
        member.slots.add(s);
        const day = s.split("-")[0];
        member.perDay[day] = (member.perDay[day] || 0) + 1;
        member.grid.push({ slot: s, client_id: c.client_id, child_name: c.child_name });
      }
      member.total += c.slots.length;
      member.clients.add(c.client_id);
    }
    // Place larger client demands first for a tighter pack.
    const ordered = clientDemands.slice().sort((a, b) => b.slots.length - a.slots.length);
    for (const c of ordered) {
      let placed = false;
      for (const m of staff) {
        if (canFit(m, c.slots)) { place(m, c); placed = true; break; }
      }
      if (!placed) {
        const m = { slots: new Set(), perDay: {}, total: 0, clients: new Set(), grid: [] };
        // A single client's request could exceed one staff's caps; split across days if needed.
        if (c.slots.length > rbtCapacity) {
          // Split this client's slots greedily across multiple staff.
          let remaining = c.slots.slice();
          while (remaining.length) {
            const target = staff.find((s) => canFitPartial(s, remaining, rbtCapacity)) || null;
            const bucket = target || { slots: new Set(), perDay: {}, total: 0, clients: new Set(), grid: [] };
            const took = takeFittable(bucket, { ...c, slots: remaining }, rbtCapacity);
            remaining = remaining.filter((s) => !took.includes(s));
            if (!target) staff.push(bucket);
            if (!took.length) break; // safety
          }
        } else {
          place(m, c);
          staff.push(m);
        }
      }
    }
    function canFitPartial(member, slots) {
      return slots.some((s) => !member.slots.has(s) && (member.perDay[s.split("-")[0]] || 0) < MAX_HOURS_PER_DAY) && member.total < rbtCapacity;
    }
    function takeFittable(member, c, cap) {
      const took = [];
      for (const s of c.slots) {
        if (member.total >= cap) break;
        if (member.slots.has(s)) continue;
        const day = s.split("-")[0];
        if ((member.perDay[day] || 0) >= MAX_HOURS_PER_DAY) continue;
        member.slots.add(s);
        member.perDay[day] = (member.perDay[day] || 0) + 1;
        member.total += 1;
        member.clients.add(c.client_id);
        member.grid.push({ slot: s, client_id: c.client_id, child_name: c.child_name });
        took.push(s);
      }
      return took;
    }

    const rbtsNeeded = staff.length;
    const bcbasNeeded = rbtsNeeded ? Math.ceil(rbtsNeeded / bcbaPerRbt) : 0;

    return {
      totalHours,
      clientCount: clientDemands.length,
      rbtsNeeded,
      bcbasNeeded,
      rbtCapacity,
      bcbaPerRbt,
      staff: staff.map((m, i) => ({
        name: `Proposed RBT ${i + 1}`,
        total: m.total,
        clientCount: m.clients.size,
        grid: m.grid,
      })),
      unstaffedNote:
        clientDemands.length === 0
          ? "No parent-submitted schedules yet. Once a parent picks their times (sent after the clinical screener), this estimate will populate."
          : null,
    };
  }

  // ============================ API ============================
  // Returns true if handled. Dispatched from server.js BEFORE the auth gate,
  // so public endpoints work without a session and staff endpoints check `user`.
  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/client-forms/")) return false;

    // ---- Public (no auth) ----
    // Parent document upload link. Nothing here identifies the family beyond
    // the child's first-line name, so a leaked link exposes no more than the
    // email it came in did.
    if (pathname === "/api/client-forms/public/documents" && method === "GET") {
      const row = await dbGet("SELECT * FROM client_document_requests WHERE token = ?", [query.token || ""]);
      if (!row) { json(res, 404, { error: "This upload link is invalid or has expired." }); return true; }
      if (!row.viewed_at) {
        await dbRun("UPDATE client_document_requests SET viewed_at = ?, status = CASE WHEN status = 'sent' THEN 'viewed' ELSE status END WHERE id = ?",
          [nowISO(), row.id]).catch(() => {});
      }
      const client = await dbGet("SELECT child_name, parent_name FROM clients WHERE id = ?", [row.client_id]).catch(() => null);
      const received = parseReceived(row);
      json(res, 200, {
        child_name: client ? client.child_name : "",
        parent_name: client ? client.parent_name : "",
        status: requestStatus(received),
        items: DOC_SLOTS.map((sl) => ({
          key: sl.key, label: sl.label, hint: sl.hint, icon: sl.icon,
          received: !!received[sl.key],
          received_at: received[sl.key] ? received[sl.key].at : null,
        })),
      });
      return true;
    }
    if (pathname === "/api/client-forms/public/documents/upload" && method === "POST") {
      const body = await readBody(req);
      const result = await receiveDocumentUpload(body.token || "", body.slot || "", {
        filename: body.filename,
        mime_type: body.mime_type,
        content_base64: body.content_base64,
      });
      json(res, result.ok ? 200 : (result.status || 400), result);
      return true;
    }

    if (pathname === "/api/client-forms/public/financial" && method === "GET") {
      const data = await getPublicForm(query.token || "");
      if (!data) { json(res, 404, { error: "This form link is invalid or has expired." }); return true; }
      const f = data.form;
      json(res, 200, {
        child_name: data.client ? data.client.child_name : "",
        parent_name: data.client ? data.client.parent_name : "",
        plan_type: f.plan_type,
        copay_amount: f.copay_amount,
        copay_per: f.copay_per,
        coinsurance_pct: f.coinsurance_pct,
        deductible: f.deductible,
        deductible_remaining: f.deductible_remaining,
        oop_max: f.oop_max,
        oop_remaining: f.oop_remaining,
        secondary_insurance_name: f.secondary_insurance_name,
        mco_name: f.mco_name,
        notes: f.notes,
        status: f.status,
        signed_name: f.signed_name,
        signed_at: f.signed_at,
      });
      return true;
    }
    if (pathname === "/api/client-forms/public/financial/sign" && method === "POST") {
      const body = await readBody(req);
      const result = await signForm(body.token || "", body.signed_name || "");
      json(res, result.ok ? 200 : (result.status || 400), result);
      return true;
    }
    if (pathname === "/api/client-forms/public/schedule" && method === "GET") {
      const data = await getPublicScheduleRequest(query.token || "");
      if (!data) { json(res, 404, { error: "This link is invalid or has expired." }); return true; }
      json(res, 200, {
        child_name: data.client ? data.client.child_name : "",
        parent_name: data.client ? data.client.parent_name : "",
        status: data.reqRow.status,
        selected_slots: data.reqRow.selected_slots ? JSON.parse(data.reqRow.selected_slots) : [],
        open_hour: OPEN_HOUR, close_hour: CLOSE_HOUR, days: DAYS,
        min_hours: MIN_HOURS, max_per_day: MAX_HOURS_PER_DAY,
      });
      return true;
    }
    if (pathname === "/api/client-forms/public/schedule/submit" && method === "POST") {
      const body = await readBody(req);
      const result = await submitScheduleRequest(body.token || "", body.slots || []);
      json(res, result.ok ? 200 : (result.status || 400), result);
      return true;
    }

    // ---- Staff (auth + role required) ----
    // These routes create a financial-responsibility form with whatever copay /
    // deductible / out-of-pocket figures the caller sends and email it to the
    // family for signature, so "any logged-in account" was too broad.
    if (!user) { json(res, 401, { error: "Not authenticated" }); return true; }
    const CF_ROLES = ["owner", "super_admin", "admin", "intake", "billing", "scheduling", "clinical"];
    if (!CF_ROLES.includes(user.role)) { json(res, 403, { error: "Not permitted" }); return true; }

    if (pathname === "/api/client-forms/financial" && method === "POST") {
      const body = await readBody(req);
      const result = await createFinancialForm(body, user.email);
      json(res, result.ok ? 201 : (result.status || 400), result);
      return true;
    }
    const listMatch = pathname.match(/^\/api\/client-forms\/financial\/(\d+)$/);
    if (listMatch && method === "GET") {
      json(res, 200, await listFinancialForms(Number(listMatch[1])));
      return true;
    }

    // Schedule requests (staff)
    if (pathname === "/api/client-forms/schedule" && method === "POST") {
      const body = await readBody(req);
      const client = await dbGet("SELECT * FROM clients WHERE id = ?", [Number(body.client_id)]);
      if (!client) { json(res, 404, { error: "Client not found" }); return true; }
      const result = await sendScheduleRequest(client, true);
      json(res, 200, result);
      return true;
    }
    const schedListMatch = pathname.match(/^\/api\/client-forms\/schedule\/(\d+)$/);
    if (schedListMatch && method === "GET") {
      json(res, 200, await listScheduleRequests(Number(schedListMatch[1])));
      return true;
    }
    // ---- Staff: ask the parent for their documents ----
    if (pathname === "/api/client-forms/documents" && method === "POST") {
      const body = await readBody(req);
      const result = await sendDocumentRequest(Number(body.client_id), user.email || user.name || "staff");
      json(res, result.ok ? 200 : (result.status || 400), result);
      return true;
    }
    const docReqMatch = pathname.match(/^\/api\/client-forms\/documents\/(\d+)$/);
    if (docReqMatch && method === "GET") {
      json(res, 200, await documentRequestStatus(Number(docReqMatch[1])));
      return true;
    }

    if (pathname === "/api/client-forms/staffing-estimate" && method === "GET") {
      json(res, 200, await staffingEstimate({ rbtCapacity: query.rbtCapacity, bcbaPerRbt: query.bcbaPerRbt }));
      return true;
    }

    return false;
  }

  // ============================ PUBLIC PAGE ============================
  async function servePage(req, res, pathname) {
    if (pathname === "/financial-form" || pathname.startsWith("/financial-form/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(financialFormHtml());
      return true;
    }
    if (pathname === "/schedule-request" || pathname.startsWith("/schedule-request/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(scheduleRequestHtml());
      return true;
    }
    if (pathname === "/client-documents" || pathname.startsWith("/client-documents/")) {
      // no-referrer so the token cannot leak to anything the page links out to.
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "no-referrer" });
      res.end(documentUploadHtml());
      return true;
    }
    return false;
  }

  // Fun, tappable weekly availability picker for parents. Mon-Fri, 8am-7pm,
  // min 15 hrs, max 8/day. Live counter, encouraging copy, confetti on submit.
  function scheduleRequestHtml() {
    return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Pick Your Schedule — Spectrum Squad</title>
<style>
  :root{--navy:#1b2a6b;--gold:#e0a430;--teal:#5fa8a0;}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--navy);
    background:linear-gradient(135deg,#fff4e0 0%,#eafaf6 100%);min-height:100vh;}
  #confetti{position:fixed;inset:0;pointer-events:none;z-index:60}
  .wrap{max-width:720px;margin:0 auto;padding:20px 12px 120px;}
  .brandbar{text-align:center;margin-bottom:12px;}
  .brandbar img{max-width:220px;width:58%;height:auto;}
  .card{position:relative;overflow:hidden;background:#fff;border-radius:20px;box-shadow:0 18px 50px rgba(41,34,92,.14);padding:22px 18px;animation:rise .5s ease both;}
  .card::before{content:"";position:absolute;inset:0;background:url('/logo.png') center 30% no-repeat;background-size:min(70%,360px);opacity:.05;pointer-events:none;z-index:0;}
  .card > *{position:relative;z-index:1;}
  @keyframes rise{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}
  h1{font-size:23px;margin:6px 0;}
  p{line-height:1.55;font-size:14.5px;}
  .hero{font-size:44px}
  .grid{display:grid;grid-template-columns:56px repeat(5,1fr);gap:4px;margin-top:14px;overflow-x:auto;}
  .gh{font-size:11px;font-weight:700;text-align:center;padding:6px 2px;color:var(--navy);}
  .gt{font-size:10.5px;color:#888;display:flex;align-items:center;justify-content:flex-end;padding-right:4px;}
  .cell{height:34px;border-radius:8px;background:#f1eefb;cursor:pointer;transition:transform .05s;border:2px solid transparent;}
  .cell:hover{transform:scale(1.04)}
  .cell.on{background:var(--gold);border-color:#c98a1b;}
  .cell.full{opacity:.4;cursor:not-allowed;}
  .bar{position:fixed;left:0;right:0;bottom:0;background:#fff;box-shadow:0 -8px 24px rgba(41,34,92,.14);padding:12px 16px;display:flex;align-items:center;gap:12px;z-index:40;}
  .bar .count{font-weight:800;font-size:16px;}
  .bar .hint{font-size:12px;color:#888;flex:1;}
  .btn{background:var(--gold);color:var(--navy);font-weight:800;border:none;border-radius:999px;padding:13px 22px;font-size:15px;cursor:pointer;}
  .btn:disabled{opacity:.45;cursor:not-allowed;}
  .legend{font-size:12px;color:#666;margin-top:10px;}
  .done{text-align:center;padding:24px 8px;}
  .done .big{font-size:60px;}
  .err{color:#b91c1c;text-align:center;padding:40px 16px;}
</style></head>
<body>
<canvas id="confetti"></canvas>
<div class="wrap"><div class="brandbar"><img src="/logo.png" alt="Spectrum Squad"/></div><div class="card" id="card"><p class="err">Loading…</p></div></div>
<div class="bar" id="bar" style="display:none;">
  <div class="count"><span id="cnt">0</span> hrs</div>
  <div class="hint" id="hint"></div>
  <button class="btn" id="submit" disabled>Submit</button>
</div>
<script>
var params=new URLSearchParams(location.search),token=params.get("token");
var card=document.getElementById("card"),bar=document.getElementById("bar");
var cfg=null,selected={};
var DAYNAMES={1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri"};
function esc(s){var d=document.createElement("div");d.textContent=s==null?"":String(s);return d.innerHTML;}
function hourLabel(h){var ap=h<12?"am":"pm";var hh=h%12;if(hh===0)hh=12;return hh+ap;}
if(!token){card.innerHTML='<p class="err">This link is missing its code. Please use the link from your email.</p>';}
else{fetch("/api/client-forms/public/schedule?token="+encodeURIComponent(token)).then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});}).then(function(res){
  if(!res.ok){card.innerHTML='<p class="err">'+esc(res.d.error||"This link is invalid or has expired.")+'</p>';return;}
  cfg=res.d; if(cfg.status==="submitted"){doneView();return;} render();
}).catch(function(){card.innerHTML='<p class="err">Something went wrong. Please try again.</p>';});}

function doneView(){card.innerHTML='<div class="done"><div class="big">🎉</div><h1>Your schedule is in!</h1><p>Thank you — we\\'ve got '+esc(cfg.child_name||"your child")+'\\'s preferred times. Our team will finalize therapists and confirm with you soon.</p></div>';}

function perDayCount(day){var n=0;for(var k in selected){if(selected[k]&&k.split("-")[0]==String(day))n++;}return n;}
function total(){var n=0;for(var k in selected){if(selected[k])n++;}return n;}

function render(){
  var hours=[];for(var h=cfg.open_hour;h<cfg.close_hour;h++)hours.push(h);
  var html='<div style="text-align:center"><div class="hero">🗓️✨</div>'+
    '<h1>Let\\'s pick '+esc(cfg.child_name||"your child")+'\\'s times!</h1>'+
    '<p>Tap the times that work best for your family. We\\'re open <strong>Monday–Friday, 8am–7pm</strong>. Pick at least <strong>'+cfg.min_hours+' hours</strong> total — up to '+cfg.max_per_day+' hours a day. Mix and match however you like! 💛</p></div>'+
    '<div class="grid"><div class="gh"></div>'+[1,2,3,4,5].map(function(d){return '<div class="gh">'+DAYNAMES[d]+'</div>';}).join("");
  hours.forEach(function(h){
    html+='<div class="gt">'+hourLabel(h)+'</div>';
    [1,2,3,4,5].forEach(function(d){html+='<div class="cell" data-slot="'+d+'-'+h+'"></div>';});
  });
  html+='</div><div class="legend">Tip: therapy is usually in a few-hour blocks. Choose what fits your routine — you can always adjust with our team later.</div>';
  card.innerHTML=html;bar.style.display="flex";
  card.querySelectorAll(".cell").forEach(function(c){
    c.addEventListener("click",function(){
      var slot=c.dataset.slot,day=slot.split("-")[0];
      if(selected[slot]){selected[slot]=false;c.classList.remove("on");}
      else{if(perDayCount(day)>=cfg.max_per_day){flash(day);return;}selected[slot]=true;c.classList.add("on");}
      upd();
    });
  });
  upd();
}
function flash(day){var hint=document.getElementById("hint");hint.textContent="That's the max "+cfg.max_per_day+" hours for "+DAYNAMES[day]+"!";hint.style.color="#b91c1c";setTimeout(function(){hint.style.color="#888";upd();},1600);}
function upd(){
  var t=total();document.getElementById("cnt").textContent=t;
  var need=cfg.min_hours-t;var hint=document.getElementById("hint");
  if(need>0)hint.textContent="Pick "+need+" more hour"+(need>1?"s":"")+" to continue.";
  else hint.textContent="Looks great! You can add more or submit. 🎉";
  document.getElementById("submit").disabled=t<cfg.min_hours;
}
document.getElementById("submit").addEventListener("click",function(){
  var btn=document.getElementById("submit");btn.disabled=true;btn.textContent="Sending…";
  var slots=[];for(var k in selected){if(selected[k])slots.push(k);}
  fetch("/api/client-forms/public/schedule/submit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:token,slots:slots})}).then(function(r){return r.json();}).then(function(res){
    if(res.ok){celebrate();bar.style.display="none";doneView();}
    else{btn.disabled=false;btn.textContent="Submit";alert(res.error||"Could not submit.");}
  }).catch(function(){btn.disabled=false;btn.textContent="Submit";alert("Something went wrong. Please try again.");});
});
function celebrate(){var cv=document.getElementById("confetti"),cx=cv.getContext("2d");cv.width=innerWidth;cv.height=innerHeight;var parts=[],colors=["#e0a430","#5fa8a0","#1b2a6b","#f6c667","#6f86e0"];for(var i=0;i<160;i++){parts.push({x:Math.random()*cv.width,y:-20-Math.random()*cv.height,r:4+Math.random()*6,c:colors[i%colors.length],vy:2+Math.random()*4,vx:-2+Math.random()*4,a:Math.random()*6});}var t=0;(function run(){cx.clearRect(0,0,cv.width,cv.height);parts.forEach(function(p){p.y+=p.vy;p.x+=p.vx;p.a+=.1;cx.save();cx.translate(p.x,p.y);cx.rotate(p.a);cx.fillStyle=p.c;cx.fillRect(-p.r/2,-p.r/2,p.r,p.r*1.6);cx.restore();});t++;if(t<260)requestAnimationFrame(run);else cx.clearRect(0,0,cv.width,cv.height);})();}
</script>
</body></html>`;
  }

  // Cute, friendly, interactive financial responsibility form. Fetches its own
  // data by token, shows the scenario that applies (co-pay / secondary / MCO),
  // the "keep your insurance current" reminder, the No Surprises Act
  // disclaimers, and a type-to-sign acknowledgment with a confetti celebration.
  function financialFormHtml() {
    return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Financial Review — Spectrum Squad</title>
<style>
  :root{--navy:#1b2a6b;--gold:#e0a430;--teal:#5fa8a0;}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--navy);
    background:linear-gradient(135deg,#f3f0ff 0%,#eafaf6 100%);min-height:100vh;}
  #confetti{position:fixed;inset:0;pointer-events:none;z-index:60}
  .wrap{max-width:640px;margin:0 auto;padding:24px 16px 80px;}
  .brandbar{text-align:center;margin-bottom:14px;}
  .brandbar img{max-width:230px;width:60%;height:auto;}
  .card{position:relative;overflow:hidden;background:#fff;border-radius:20px;box-shadow:0 18px 50px rgba(41,34,92,.14);padding:28px 26px;animation:rise .5s ease both;}
  .card::before{content:"";position:absolute;inset:0;background:url('/logo.png') center 42% no-repeat;background-size:min(78%,400px);opacity:.055;pointer-events:none;z-index:0;}
  .card > *{position:relative;z-index:1;}
  @keyframes rise{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}
  .badge{display:inline-block;background:#eef0fb;color:var(--navy);border-radius:999px;padding:6px 14px;font-size:12.5px;font-weight:700;margin-bottom:14px;}
  h1{font-size:24px;margin:0 0 6px;}
  h2{font-size:16px;margin:22px 0 8px;color:var(--navy);}
  p{line-height:1.6;font-size:15px;}
  .hero{font-size:44px;line-height:1;margin-bottom:6px;}
  .scenario{border-radius:14px;padding:16px 18px;margin:16px 0;border:2px solid;}
  .scenario.copay{background:#fff8ec;border-color:var(--gold);}
  .scenario.secondary{background:#eef6f5;border-color:var(--teal);}
  .scenario.mco{background:#f3f0ff;border-color:#6f86e0;}
  .scenario h3{margin:0 0 8px;font-size:17px;}
  table.figs{width:100%;border-collapse:collapse;margin-top:8px;font-size:14px;}
  table.figs td{padding:6px 8px;border-bottom:1px solid #eee;}
  table.figs td:last-child{text-align:right;font-weight:700;}
  .disclaimer{background:#faf9fd;border:1px solid #e7e4f2;border-radius:12px;padding:14px 16px;font-size:12.5px;color:#555;line-height:1.55;margin-top:18px;}
  .keepcurrent{background:#eafaf6;border:1px dashed var(--teal);border-radius:12px;padding:14px 16px;margin-top:16px;font-size:14px;}
  label.ack{display:flex;gap:10px;align-items:flex-start;margin:18px 0;font-size:14px;cursor:pointer;}
  label.ack input{margin-top:3px;transform:scale(1.3);}
  .sign-label{font-size:13px;font-weight:700;margin:14px 0 6px;}
  #sign{width:100%;padding:14px 16px;border:2px solid #ddd;border-radius:12px;font-size:22px;
    font-family:'Segoe Script','Brush Script MT',cursive;color:var(--navy);}
  #sign:focus{outline:none;border-color:var(--gold);}
  .btn{width:100%;margin-top:18px;background:var(--gold);color:var(--navy);font-weight:800;border:none;
    border-radius:999px;padding:16px;font-size:17px;cursor:pointer;transition:transform .1s;}
  .btn:hover{transform:translateY(-1px)}
  .btn:disabled{opacity:.5;cursor:not-allowed;transform:none;}
  .muted{color:#888;font-size:12.5px;text-align:center;margin-top:12px;}
  .done{text-align:center;padding:20px 0;}
  .done .big{font-size:60px;}
  .err{color:#b91c1c;text-align:center;padding:40px 16px;}
</style></head>
<body>
<canvas id="confetti"></canvas>
<div class="wrap"><div class="brandbar"><img src="/logo.png" alt="Spectrum Squad"/></div><div class="card" id="card"><p class="err">Loading…</p></div></div>
<script>
var params=new URLSearchParams(location.search),token=params.get("token");
var card=document.getElementById("card");
function money(v){if(v==null||v==="")return null;var n=String(v).replace(/[^0-9.\\-]/g,"");if(n==="")return null;return "$"+Number(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});}
function esc(s){var d=document.createElement("div");d.textContent=s==null?"":String(s);return d.innerHTML;}

if(!token){card.innerHTML='<p class="err">This form link is missing its code. Please use the link from your email.</p>';}
else{fetch("/api/client-forms/public/financial?token="+encodeURIComponent(token)).then(function(r){return r.json().then(function(d){return {ok:r.ok,d:d};});}).then(function(res){
  if(!res.ok){card.innerHTML='<p class="err">'+esc(res.d.error||"This link is invalid or has expired.")+'</p>';return;}
  render(res.d);
}).catch(function(){card.innerHTML='<p class="err">Something went wrong loading your form. Please try again.</p>';});}

function scenarioHTML(d){
  if(d.plan_type==="copay"){
    var rows="";
    var cp=money(d.copay_amount); if(cp) rows+='<td>Your co-pay</td><td>'+cp+' per '+esc(d.copay_per||"day")+'</td></tr><tr>';
    if(d.coinsurance_pct) rows+='<td>Co-insurance</td><td>'+esc(d.coinsurance_pct)+'%</td></tr><tr>';
    var ded=money(d.deductible); if(ded) rows+='<td>Deductible</td><td>'+ded+'</td></tr><tr>';
    var dedr=money(d.deductible_remaining); if(dedr) rows+='<td>Deductible remaining</td><td>'+dedr+'</td></tr><tr>';
    var oop=money(d.oop_max); if(oop) rows+='<td>Out-of-pocket max</td><td>'+oop+'</td></tr><tr>';
    var oopr=money(d.oop_remaining); if(oopr) rows+='<td>Out-of-pocket remaining</td><td>'+oopr+'</td></tr><tr>';
    if(rows) rows="<table class='figs'><tr>"+rows.replace(/<tr>$/,"")+"</table>";
    return '<div class="scenario copay"><h3>💳 You have a co-pay</h3>'+
      '<p>Your insurance covers ABA services, and you have a co-pay (and/or co-insurance) that applies to each visit. Here is what we have on file from your benefits check:</p>'+
      rows+
      '<p style="margin-top:10px;">Once your out-of-pocket maximum is met, insurance pays 100% for the rest of the calendar year. Actual amounts are always based on how your insurer processes each claim.</p></div>';
  }
  if(d.plan_type==="secondary"){
    return '<div class="scenario secondary"><h3>🧩 You have secondary insurance</h3>'+
      '<p>Great news — you have a <strong>secondary insurance'+(d.secondary_insurance_name?' ('+esc(d.secondary_insurance_name)+')':'')+'</strong>. Your primary insurance is billed first, and your secondary may cover some or all of the remaining balance (like your co-pay or co-insurance).</p>'+
      (money(d.copay_amount)?'<p>Any co-pay on file: <strong>'+money(d.copay_amount)+' per '+esc(d.copay_per||"day")+'</strong> — your secondary may reduce or cover this.</p>':'')+
      '<p>You are only responsible for amounts that neither plan pays. We will always bill both before anything comes to you.</p></div>';
  }
  // mco
  return '<div class="scenario mco"><h3>🛡️ You have an MCO plan</h3>'+
    '<p>Our records show '+ (d.mco_name?('you are enrolled in <strong>'+esc(d.mco_name)+'</strong>, a'):'you are enrolled in a') +' <strong>Managed Care Organization (MCO)</strong>.</p>'+
    '<p>While your MCO coverage is active, <strong>we are not able to bill for ABA services</strong>. That means services can\\'t be provided through your insurance during that time. If your MCO coverage changes — or if you gain other coverage — please let us know right away so we can help you keep services going.</p>'+
    '<p>We\\'ll walk through your options with you. You are never responsible for charges we cannot bill.</p></div>';
}

function render(d){
  if(d.status==="signed"){
    card.innerHTML='<div class="done"><div class="big">✅</div><h1>You\\'re all set!</h1>'+
      '<p>This financial responsibility form was signed by <strong>'+esc(d.signed_name)+'</strong>'+(d.signed_at?' on '+new Date(d.signed_at).toLocaleDateString():'')+'.</p>'+
      '<p class="muted">A copy is saved in '+esc(d.child_name||"your child")+'\\'s file. You can close this page.</p></div>';
    return;
  }
  var html='<span class="badge">Spectrum Squad · Financial Review</span>'+
    '<div class="hero">💛</div>'+
    '<h1>Almost there, '+esc(d.parent_name||"friend")+'!</h1>'+
    '<p>We finished the insurance benefits check for <strong>'+esc(d.child_name||"your child")+'</strong>. Here\\'s a clear, friendly summary of your coverage and what to expect — then just sign at the bottom.</p>'+
    scenarioHTML(d)+
    (d.notes?'<p><strong>A note from our team:</strong> '+esc(d.notes)+'</p>':'')+
    '<div class="keepcurrent"><strong>📌 Please keep your insurance up to date with us.</strong><br/>'+
      'Insurance plans change — new cards, new plans, new MCO enrollment, or a change in coverage can all affect services and billing. The moment anything about your insurance changes, please tell us. Keeping us current protects your child\\'s services and prevents surprise bills.</div>'+
    '<h2>Acknowledgment &amp; Signature</h2>'+
    '<div class="disclaimer">I understand that I am responsible for any portion of costs for services provided that are not reimbursed by my insurance company. This summary of benefits was provided by my insurance company; the actual determination of benefits will be made by the insurance company. This is a Good Faith Estimate under the No Surprises Act — it is an estimate, not a contract, and actual charges may differ. I have the right to initiate a dispute if billed charges are substantially more than this estimate.</div>'+
    '<label class="ack"><input type="checkbox" id="ack"/> <span>I have read and understand the information above, and I acknowledge my financial responsibility for '+esc(d.child_name||"my child")+'\\'s care.</span></label>'+
    '<div class="sign-label">✍️ Type your full name to sign</div>'+
    '<input id="sign" placeholder="Your full name" autocomplete="name"/>'+
    '<button class="btn" id="submit" disabled>Sign &amp; Submit</button>'+
    '<div class="muted">Signed electronically · '+new Date().toLocaleDateString()+'</div>';
  card.innerHTML=html;
  var ack=document.getElementById("ack"),sign=document.getElementById("sign"),btn=document.getElementById("submit");
  function upd(){btn.disabled=!(ack.checked && sign.value.trim().length>1);}
  ack.addEventListener("change",upd);sign.addEventListener("input",upd);
  btn.addEventListener("click",function(){
    btn.disabled=true;btn.textContent="Signing…";
    fetch("/api/client-forms/public/financial/sign",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({token:token,signed_name:sign.value.trim()})}).then(function(r){return r.json();}).then(function(res){
      if(res.ok){celebrate();card.innerHTML='<div class="done"><div class="big">🎉</div><h1>Thank you, '+esc(sign.value.trim())+'!</h1><p>Your financial responsibility form is signed and saved. Our team will be in touch with next steps for '+esc(d.child_name||"your child")+'.</p><p class="muted">You can close this page.</p></div>';}
      else{btn.disabled=false;btn.textContent="Sign & Submit";alert(res.error||"Could not sign. Please try again.");}
    }).catch(function(){btn.disabled=false;btn.textContent="Sign & Submit";alert("Something went wrong. Please try again.");});
  });
}

// ---- confetti ----
function celebrate(){
  var cv=document.getElementById("confetti"),cx=cv.getContext("2d");
  cv.width=innerWidth;cv.height=innerHeight;var parts=[];
  var colors=["#e0a430","#5fa8a0","#1b2a6b","#f6c667","#6f86e0"];
  for(var i=0;i<160;i++){parts.push({x:Math.random()*cv.width,y:-20-Math.random()*cv.height,r:4+Math.random()*6,c:colors[i%colors.length],vy:2+Math.random()*4,vx:-2+Math.random()*4,a:Math.random()*6});}
  var t=0;(function run(){cx.clearRect(0,0,cv.width,cv.height);parts.forEach(function(p){p.y+=p.vy;p.x+=p.vx;p.a+=.1;cx.save();cx.translate(p.x,p.y);cx.rotate(p.a);cx.fillStyle=p.c;cx.fillRect(-p.r/2,-p.r/2,p.r,p.r*1.6);cx.restore();});t++;if(t<260)requestAnimationFrame(run);else cx.clearRect(0,0,cv.width,cv.height);})();
}
</script>
</body></html>`;
  }

  // The page a parent lands on from the document-request email. Phone-first:
  // each slot is one big tap target that opens the camera, uploads immediately,
  // and turns green. No login, no account, no app.
  function documentUploadHtml() {
    return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="referrer" content="no-referrer"/>
<title>Upload Documents — Spectrum Squad</title>
<style>
  :root{--navy:#1b2a6b;--gold:#e0a430;--teal:#5fa8a0;--ok:#16a34a;}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--navy);
       background:linear-gradient(160deg,#f7f5ff 0%,#eef6f5 100%);min-height:100vh;padding:20px 14px 60px;}
  .wrap{max-width:560px;margin:0 auto;}
  h1{font-size:24px;margin:0 0 6px;}
  .sub{color:#5b5876;font-size:15px;line-height:1.5;margin:0 0 22px;}
  .slot{background:#fff;border:2px solid #e7e5f2;border-radius:16px;padding:16px 18px;margin-bottom:14px;
        box-shadow:0 2px 10px rgba(27,42,107,.05);transition:border-color .15s,background .15s;}
  .slot.done{border-color:var(--ok);background:#f2fdf6;}
  .slot h2{font-size:17px;margin:0 0 4px;display:flex;align-items:center;gap:9px;}
  .slot p{margin:0 0 12px;color:#666;font-size:13.5px;line-height:1.45;}
  .btn{display:inline-block;background:var(--gold);color:var(--navy);font-weight:800;border:none;
       padding:13px 22px;border-radius:999px;font-size:15.5px;cursor:pointer;width:100%;}
  .btn:disabled{opacity:.6;cursor:default;}
  .tick{color:var(--ok);font-weight:800;font-size:15px;display:flex;align-items:center;gap:8px;}
  .msg{font-size:13px;margin-top:9px;min-height:18px;}
  .err{color:#b91c1c;}
  input[type=file]{display:none;}
  .done-card{background:#fff;border-radius:16px;padding:28px 22px;text-align:center;box-shadow:0 2px 14px rgba(27,42,107,.08);}
  .foot{text-align:center;color:#8a8797;font-size:12.5px;margin-top:26px;line-height:1.6;}
</style></head><body>
<div class="wrap" id="app"><p class="sub">Loading…</p></div>
<script>
(function(){
  var token=new URL(location.href).searchParams.get("token")||"";
  var app=document.getElementById("app");
  function esc(s){var d=document.createElement("div");d.textContent=s==null?"":String(s);return d.innerHTML;}
  function api(p,o){o=o||{};return fetch(p,{method:o.method||"GET",headers:o.body?{"Content-Type":"application/json"}:undefined,
    body:o.body?JSON.stringify(o.body):undefined}).then(function(r){return r.json().catch(function(){return{};}).then(function(d){
      if(!r.ok)throw new Error(d.error||"Something went wrong.");return d;});});}

  function fail(msg){app.innerHTML='<div class="done-card"><div style="font-size:44px;">🌈</div><h1>'+esc(msg)+'</h1>'+
    '<p class="sub" style="margin-top:10px;">Please contact Spectrum Squad and we will send you a fresh link.</p></div>';}

  function render(d){
    if(d.status==="complete"){
      app.innerHTML='<div class="done-card"><div style="font-size:52px;">🎉</div>'+
        '<h1>All done — thank you!</h1><p class="sub" style="margin-top:10px;">We have everything we need for '+
        esc(d.child_name||"your child")+'. Our team will take it from here.</p></div>';
      return;
    }
    var slots=d.items.map(function(it,i){
      return '<div class="slot'+(it.received?" done":"")+'" id="slot-'+it.key+'">'+
        '<h2><span>'+it.icon+'</span> '+esc(it.label)+'</h2>'+
        (it.received
          ? '<div class="tick">✓ Received — thank you!</div>'
          : '<p>'+esc(it.hint)+'</p>'+
            '<button class="btn" data-pick="'+it.key+'">Choose or take a photo</button>'+
            '<input type="file" id="f-'+it.key+'" accept="image/*,application/pdf" />'+
            '<div class="msg" id="m-'+it.key+'"></div>')+
        '</div>';
    }).join("");
    app.innerHTML='<h1>Documents for '+esc(d.child_name||"your child")+'</h1>'+
      '<p class="sub">Hi '+esc(d.parent_name||"there")+' — just tap each one below and pick a photo. '+
      'They go straight into '+esc(d.child_name||"your child")+"'s file, and you can come back to this page any time.</p>"+
      slots+
      '<p class="foot">Your documents are sent securely and stored in your child&rsquo;s confidential record.<br/>Spectrum Squad &middot; Compassionate ABA Therapy</p>';

    Array.prototype.forEach.call(app.querySelectorAll("[data-pick]"),function(b){
      var key=b.getAttribute("data-pick");
      var input=document.getElementById("f-"+key);
      b.addEventListener("click",function(){input.click();});
      input.addEventListener("change",function(){
        var file=input.files&&input.files[0];
        if(!file)return;
        var msg=document.getElementById("m-"+key);
        if(file.size>15*1024*1024){msg.className="msg err";msg.textContent="That file is too large (15MB max). Try a smaller photo.";return;}
        b.disabled=true;msg.className="msg";msg.textContent="Uploading…";
        var reader=new FileReader();
        reader.onerror=function(){b.disabled=false;msg.className="msg err";msg.textContent="Could not read that file. Please try again.";};
        reader.onload=function(){
          api("/api/client-forms/public/documents/upload",{method:"POST",body:{
            token:token,slot:key,filename:file.name,mime_type:file.type||"application/octet-stream",
            content_base64:String(reader.result).split(",")[1]
          }}).then(function(){ load(); })
            .catch(function(e){b.disabled=false;msg.className="msg err";msg.textContent=e.message;});
        };
        reader.readAsDataURL(file);
      });
    });
  }

  function load(){
    if(!token){fail("This upload link looks incomplete.");return;}
    api("/api/client-forms/public/documents?token="+encodeURIComponent(token))
      .then(render).catch(function(e){fail(e.message||"This upload link is invalid or has expired.");});
  }
  load();
})();
</script>
</body></html>`;
  }

  return { initTables, handleApi, servePage, createFinancialForm, sendScheduleRequest, staffingEstimate, sendDocumentRequest, documentRequestStatus };
};
