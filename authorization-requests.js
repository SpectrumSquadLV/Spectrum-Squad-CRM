// authorization-requests.js -- the Authorization Request.
//
// ONE FEATURE, ONE NAME. Parent signatures, document gathering, submission,
// payer review, approval and the projected start date are STAGES of an
// Authorization Request, not features of their own. There is no signature
// centre and no separate signatures page: a parent signature is a step inside
// the request that needs it, and only when the configured payer requirement
// says one is needed.
//
// WHAT IS NOT HARDCODED, on purpose:
//
//   * which documents a payer wants, per request type   (auth_payer_requirements)
//   * whether that payer wants a parent signature       (auth_payer_requirements)
//   * how long that payer takes, and in which days      (auth_payer_requirements)
//   * the internal processing time before submission    (auth_payer_requirements)
//   * the address an Authorization Request is sent to   (app_settings)
//
// Payer rules change without warning and a code deploy is the wrong unit of
// change for them. Defaults are SEEDED, once, and then owned by whoever edits
// them -- reseeding never overwrites an edit.
//
// THE STATUS IS COMPUTED, NOT TYPED. Everything up to submission is derived
// from the state of the documents and the signature, so a request cannot say
// "Ready to Submit" while a requirement is missing. After submission the payer
// owns the outcome and a person records it; those statuses are the only ones
// set by hand.
"use strict";

module.exports = function initAuthorizationRequests(ctx) {
  const {
    dbGet, dbAll, dbRun, nowISO, readBody, json,
    sendEmail, getSetting, setSetting, appBaseUrl,
    canAccessClients, isOwnerOrAdmin,
    documentPath, saveGeneratedPdf,
  } = ctx;

  const crypto = require("crypto");

  // ---- vocabulary ---------------------------------------------------------
  // The request types the BCBA picks from. "other" exists so an unusual
  // request is still tracked here rather than in somebody's inbox.
  const REQUEST_TYPES = [
    { key: "assessment", label: "Assessment Authorization" },
    { key: "aba_services", label: "ABA Services Authorization" },
    { key: "reauthorization", label: "Reauthorization / Continued Services" },
    { key: "other", label: "Other" },
  ];
  const REQUEST_TYPE_LABEL = {};
  REQUEST_TYPES.forEach((r) => { REQUEST_TYPE_LABEL[r.key] = r.label; });

  // Clinical document types. This is the METADATA the matcher reads -- a
  // filename is a hint, not a fact, and two clients can both have
  // "Vineland.pdf". A document with no clinical type is matched by name as a
  // fallback and always shown as a suggestion for a person to confirm.
  const DOC_TYPES = [
    { key: "diagnosis", label: "Diagnosis" },
    { key: "diagnostic_evaluation", label: "Diagnostic Evaluation" },
    { key: "vineland", label: "Vineland" },
    { key: "srs", label: "SRS" },
    { key: "pddbi", label: "PDDBI" },
    { key: "parent_stress_index", label: "Parent Stress Index" },
    { key: "treatment_plan", label: "Treatment Plan" },
    { key: "signed_treatment_plan", label: "Signed Treatment Plan" },
    { key: "authorization_approval", label: "Authorization Approval" },
    { key: "authorization_denial", label: "Authorization Denial" },
    { key: "other_assessment", label: "Other Assessment" },
  ];
  const DOC_TYPE_LABEL = {};
  DOC_TYPES.forEach((d) => { DOC_TYPE_LABEL[d.key] = d.label; });

  // Filename patterns, used ONLY when a document carries no clinical type --
  // the back-catalogue predates the field. A name match is never silently
  // accepted as fact: it is offered, and the row says it was matched by name.
  //
  // Shared with the SignNow import, which decides what a document is as it
  // arrives. One vocabulary, so a document the importer calls a Vineland is
  // one this will accept as a Vineland.
  const { NAME_HINTS } = require("./clinical-type.js");

  // §15. Everything before `submitted` is DERIVED; everything after is
  // recorded by a person, because the payer owns it and we cannot observe it.
  const STATUSES = [
    { key: "draft", label: "Draft", derived: true },
    { key: "missing_documents", label: "Missing Documents", derived: true },
    { key: "awaiting_parent_signature", label: "Awaiting Parent Signature", derived: true },
    { key: "ready_to_submit", label: "Ready to Submit", derived: true },
    { key: "submitted", label: "Submitted", derived: false },
    { key: "pending_payer", label: "Pending Payer", derived: false },
    { key: "info_requested", label: "Additional Information Requested", derived: false },
    { key: "approved", label: "Approved", derived: false },
    { key: "partially_approved", label: "Partially Approved", derived: false },
    { key: "denied", label: "Denied", derived: false },
    { key: "expired", label: "Expired", derived: false },
    { key: "cancelled", label: "Cancelled", derived: false },
  ];
  const STATUS_LABEL = {};
  STATUSES.forEach((s) => { STATUS_LABEL[s.key] = s.label; });
  const DERIVED_STATUSES = STATUSES.filter((s) => s.derived).map((s) => s.key);
  // A request that has left the derived range is the payer's to answer for,
  // and recomputing it from documents would overwrite what a person recorded.
  const isDerived = (status) => DERIVED_STATUSES.includes(status);

  // §2. The nodes of the tracker, in order. `parent_signature` is present only
  // when the payer configuration asks for one -- the tracker shows the journey
  // this request actually has, not a template with a greyed-out step.
  const NODE_ORDER = ["documents", "parent_signature", "ready", "submitted", "payer_review", "approved", "start"];
  const NODE_LABEL = {
    documents: "Documents", parent_signature: "Parent", ready: "Submit",
    submitted: "Submitted", payer_review: "Review", approved: "Approved", start: "Start",
  };

  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const clean = (v) => String(v == null ? "" : v).trim();
  const lower = (v) => clean(v).toLowerCase();
  const today = () => nowISO().slice(0, 10);
  const parseJson = (s, fb) => { try { const v = JSON.parse(s || ""); return v == null ? fb : v; } catch (e) { return fb; } };
  // A snapshot is only usable if it actually carries a requirement list. A row
  // written before the snapshot existed, or by a migration, holds `{}` -- and
  // `{}` is truthy, so a plain `||` fallback would hand the tracker a
  // configuration with no documents and no signature step in it. The card then
  // reads "0 of 0 ready" and quietly loses its Parent node.
  const usableSnapshot = (s) => {
    const v = parseJson(s, null);
    return v && Array.isArray(v.required_docs) ? v : null;
  };

  // ---- dates --------------------------------------------------------------
  // Business days skip Saturday and Sunday and nothing else. Payer holidays
  // are not modelled and the estimate says so on screen: a projected date that
  // pretended to know the payer's holiday calendar would be false precision on
  // a number that is already an estimate.
  function addDays(iso, n, basis) {
    const d = new Date(String(iso).slice(0, 10) + "T00:00:00Z");
    if (isNaN(d)) return null;
    let left = Math.max(0, Math.round(n));
    if (basis !== "business") {
      d.setUTCDate(d.getUTCDate() + left);
      return d.toISOString().slice(0, 10);
    }
    while (left > 0) {
      d.setUTCDate(d.getUTCDate() + 1);
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) left--;
    }
    return d.toISOString().slice(0, 10);
  }

  // ---- tables -------------------------------------------------------------
  async function initTables() {
    // The clinical type of a client document. client_documents.doc_type is
    // already taken and means something else entirely -- hosted vs link, i.e.
    // WHERE the file is, not WHAT it is. Naming this one clinical_type keeps
    // that distinction visible at every call site.
    await dbRun("ALTER TABLE client_documents ADD COLUMN IF NOT EXISTS clinical_type TEXT").catch(() => {});
    await dbRun("ALTER TABLE client_documents ADD COLUMN IF NOT EXISTS document_date TEXT").catch(() => {});
    // HOW the clinical type got there. A human picking it from the list is a
    // fact; a type derived from a SignNow title is a good guess wearing the
    // same clothes. Recorded so the audit trail can say which it was rather
    // than reporting every auto-attach as "matched by type".
    await dbRun("ALTER TABLE client_documents ADD COLUMN IF NOT EXISTS clinical_type_source TEXT").catch(() => {});
    await dbRun("CREATE INDEX IF NOT EXISTS idx_cdoc_clinical ON client_documents (client_id, clinical_type)").catch(() => {});

    // WHAT A PAYER WANTS. One row per payer per request type. Seeded once with
    // sensible defaults and owned by an administrator after that.
    await dbRun(`CREATE TABLE IF NOT EXISTS auth_payer_requirements (
      id SERIAL PRIMARY KEY,
      payer TEXT NOT NULL,
      request_type TEXT NOT NULL,
      required_docs TEXT NOT NULL DEFAULT '[]',
      optional_docs TEXT NOT NULL DEFAULT '[]',
      parent_signature_required BOOLEAN NOT NULL DEFAULT FALSE,
      parent_signature_doc TEXT,
      turnaround_days INTEGER NOT NULL DEFAULT 10,
      turnaround_basis TEXT NOT NULL DEFAULT 'business',
      internal_processing_days INTEGER NOT NULL DEFAULT 2,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      updated_by TEXT,
      updated_at TEXT,
      UNIQUE (payer, request_type)
    )`).catch((e) => console.error("auth_payer_requirements initTables:", e.message));

    await dbRun(`CREATE TABLE IF NOT EXISTS auth_requests (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL,
      request_type TEXT NOT NULL,
      payer TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      member_id TEXT,
      requested_services TEXT,
      requested_units TEXT,
      requested_hours TEXT,
      requested_start TEXT,
      requested_end TEXT,
      bcba_name TEXT,
      bcba_email TEXT,
      notes TEXT,
      -- the configuration this request was BUILT FROM, copied at creation.
      -- A payer rule edited next month must not silently rewrite the
      -- requirements of a request already in flight.
      requirements_snapshot TEXT NOT NULL DEFAULT '{}',
      projected_start_date TEXT,
      projected_response_date TEXT,
      actual_submitted_at TEXT,
      actual_approved_at TEXT,
      actual_start_date TEXT,
      authorization_number TEXT,
      approval_date TEXT,
      effective_start TEXT,
      effective_end TEXT,
      approved_cpt_codes TEXT,
      approved_units TEXT,
      approved_hours TEXT,
      frequency TEXT,
      approval_notes TEXT,
      outcome_reason TEXT,
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("auth_requests initTables:", e.message));
    await dbRun("CREATE INDEX IF NOT EXISTS idx_authreq_client ON auth_requests (client_id, id DESC)").catch(() => {});

    // One row per requirement per request: what satisfies it, or that nothing
    // does yet. Written at creation so "missing" is a row saying so rather
    // than an absence somebody has to notice.
    await dbRun(`CREATE TABLE IF NOT EXISTS auth_request_documents (
      id SERIAL PRIMARY KEY,
      request_id INTEGER NOT NULL,
      requirement_key TEXT NOT NULL,
      optional BOOLEAN NOT NULL DEFAULT FALSE,
      client_document_id INTEGER,
      document_date TEXT,
      match_source TEXT,
      status TEXT NOT NULL DEFAULT 'missing',
      chosen_by TEXT,
      chosen_at TEXT,
      UNIQUE (request_id, requirement_key)
    )`).catch((e) => console.error("auth_request_documents initTables:", e.message));

    await dbRun(`CREATE TABLE IF NOT EXISTS auth_signature_requests (
      id SERIAL PRIMARY KEY,
      request_id INTEGER NOT NULL,
      requirement_key TEXT NOT NULL,
      source_document_id INTEGER,
      token TEXT NOT NULL UNIQUE,
      parent_name TEXT,
      parent_email TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at TEXT,
      requested_by TEXT,
      last_reminder_at TEXT,
      last_reminder_day TEXT,
      reminders_sent INTEGER NOT NULL DEFAULT 0,
      viewed_at TEXT,
      signed_at TEXT,
      signed_name TEXT,
      completed_document_id INTEGER,
      cancelled_at TEXT
    )`).catch((e) => console.error("auth_signature_requests initTables:", e.message));
    // ONE REMINDER A DAY, enforced by the database rather than by a check the
    // sweep performs before writing. Two sweeps racing is the ordinary way a
    // parent gets two identical emails a minute apart.
    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_sig_reminder_day
      ON auth_signature_requests (id, last_reminder_day)`).catch(() => {});
    await dbRun(`CREATE TABLE IF NOT EXISTS auth_signature_reminders (
      id SERIAL PRIMARY KEY,
      signature_id INTEGER NOT NULL,
      sent_on TEXT NOT NULL,
      sent_at TEXT,
      delivered TEXT,
      UNIQUE (signature_id, sent_on)
    )`).catch((e) => console.error("auth_signature_reminders initTables:", e.message));

    await dbRun(`CREATE TABLE IF NOT EXISTS auth_submissions (
      id SERIAL PRIMARY KEY,
      request_id INTEGER NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      submitted_at TEXT,
      submitted_by TEXT,
      to_email TEXT,
      subject TEXT,
      attachment_names TEXT,
      attachment_count INTEGER NOT NULL DEFAULT 0,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      delivered TEXT,
      error TEXT,
      resubmission_reason TEXT
    )`).catch((e) => console.error("auth_submissions initTables:", e.message));

    await dbRun(`CREATE TABLE IF NOT EXISTS auth_info_requests (
      id SERIAL PRIMARY KEY,
      request_id INTEGER NOT NULL,
      requested_at TEXT,
      requested_by_payer TEXT,
      needed TEXT,
      due_date TEXT,
      notes TEXT,
      recorded_by TEXT,
      responded_at TEXT,
      responded_by TEXT,
      response_document_ids TEXT
    )`).catch((e) => console.error("auth_info_requests initTables:", e.message));

    // §19. Every significant action, with who and what changed. This is the
    // table the later analytics in §18 are computed from, which is why the
    // status transition is stored as a pair rather than only the new value.
    await dbRun(`CREATE TABLE IF NOT EXISTS auth_request_events (
      id SERIAL PRIMARY KEY,
      request_id INTEGER NOT NULL,
      at TEXT NOT NULL,
      actor TEXT,
      action TEXT NOT NULL,
      document_id INTEGER,
      prev_status TEXT,
      new_status TEXT,
      notes TEXT
    )`).catch((e) => console.error("auth_request_events initTables:", e.message));
    await dbRun("CREATE INDEX IF NOT EXISTS idx_authev_req ON auth_request_events (request_id, id)").catch(() => {});

    await seedPayerRequirements();
  }

  // ---- seeded defaults ----------------------------------------------------
  // SEEDED, NOT ENFORCED. Every row is inserted once and never updated by this
  // function again -- ON CONFLICT DO NOTHING is the whole point. An
  // administrator who corrects TRICARE's turnaround keeps that correction
  // through every deploy that follows.
  const TURNAROUND_SEED_KEY = "auth_turnaround_starting_points_applied";
  const DEFAULT_PAYERS = ["Tricare", "TriWest", "Molina", "Aetna", "Anthem BCBS", "SilverSummit", "CareSource"];

  // STARTING POINTS, AND ONLY THAT. Each is the decision deadline the payer's
  // plan type is held to, so a projection errs long rather than promising a
  // parent a start date that slips. They are ceilings, not observed experience:
  // the moment somebody here knows what a payer ACTUALLY takes, that number is
  // better than this one and belongs in Settings.
  //
  //   Medicaid managed care  14 calendar days, standard prior authorisation
  //                          (42 CFR 438.210(d)(1); expedited is 72 hours)
  //   Commercial             15 calendar days, non-urgent pre-service
  //                          (29 CFR 2560.503-1(f)(2)(iii)(B))
  //   Tricare / TriWest      the soft one. The Autism Care Demonstration has
  //                          no single published clock, and authorisation runs
  //                          through an assessment and then a plan review, so
  //                          30 is a planning figure rather than a rule. It is
  //                          the first number to correct with real experience.
  const PAYER_TURNAROUND = {
    "tricare":      { days: 30, basis: "calendar" },
    "triwest":      { days: 30, basis: "calendar" },
    "molina":       { days: 14, basis: "calendar" },
    "silversummit": { days: 14, basis: "calendar" },
    "caresource":   { days: 14, basis: "calendar" },
    "aetna":        { days: 15, basis: "calendar" },
    "anthem bcbs":  { days: 15, basis: "calendar" },
  };
  const DEFAULT_REQS = {
    assessment: { required: ["diagnosis", "diagnostic_evaluation"], optional: ["vineland"], sig: false, days: 10 },
    aba_services: { required: ["treatment_plan"], optional: [], sig: true, days: 10 },
    reauthorization: { required: ["treatment_plan"], optional: [], sig: true, days: 10 },
    other: { required: [], optional: [], sig: false, days: 10 },
  };
  // TRICARE's ABA package, which is the one Spectrum Squad named. It is a
  // SEED like every other row and an administrator owns it from here.
  const TRICARE_ABA = ["srs", "pddbi", "vineland", "treatment_plan", "parent_stress_index"];

  async function seedPayerRequirements() {
    for (const payer of DEFAULT_PAYERS) {
      for (const [type, d] of Object.entries(DEFAULT_REQS)) {
        const required = (payer === "Tricare" && type === "aba_services") ? TRICARE_ABA : d.required;
        await dbRun(
          `INSERT INTO auth_payer_requirements
             (payer, request_type, required_docs, optional_docs, parent_signature_required,
              parent_signature_doc, turnaround_days, turnaround_basis, internal_processing_days,
              active, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, TRUE, 'seed', ?)
           ON CONFLICT (payer, request_type) DO NOTHING`,
          [payer, type, JSON.stringify(required), JSON.stringify(d.optional),
           d.sig, d.sig ? "treatment_plan" : null,
           (PAYER_TURNAROUND[lower(payer)] || {}).days || d.days,
           (PAYER_TURNAROUND[lower(payer)] || {}).basis || "business", nowISO()]
        ).catch(() => {});
      }
    }

    // The seed above only inserts. Installs that already ran it carry the old
    // flat 10 business days, so those rows are brought up to the same starting
    // points -- ONCE, and only where nobody has touched the row.
    //
    // `updated_by = 'seed'` is the whole safety of this. The moment an admin
    // saves a payer, that column carries their address instead, and this walks
    // straight past it. The run-once flag then stops it reconsidering a row an
    // admin might later set back to 10 on purpose.
    if (!clean(await getSetting(TURNAROUND_SEED_KEY))) {
      for (const [payerKey, t] of Object.entries(PAYER_TURNAROUND)) {
        await dbRun(
          `UPDATE auth_payer_requirements
              SET turnaround_days = ?, turnaround_basis = ?, updated_at = ?
            WHERE LOWER(TRIM(payer)) = ? AND updated_by = 'seed'`,
          [t.days, t.basis, nowISO(), payerKey]
        ).catch(() => {});
      }
      await setSetting(TURNAROUND_SEED_KEY, nowISO());
    }
  }

  // ---- configuration reads ------------------------------------------------
  async function requirementsFor(payer, requestType) {
    const row = await dbGet(
      "SELECT * FROM auth_payer_requirements WHERE LOWER(TRIM(payer)) = ? AND request_type = ? AND active = TRUE",
      [lower(payer), requestType]
    ).catch(() => null);
    if (row) return shapeReq(row);
    // A payer nobody has configured yet is NOT a blocked request. It gets the
    // request type's own defaults and the screen says the payer is
    // unconfigured, because a BCBA should not be stopped by an admin task.
    const d = DEFAULT_REQS[requestType] || DEFAULT_REQS.other;
    return {
      payer: clean(payer) || null, request_type: requestType, configured: false,
      required_docs: d.required.slice(), optional_docs: d.optional.slice(),
      parent_signature_required: d.sig, parent_signature_doc: d.sig ? "treatment_plan" : null,
      turnaround_days: d.days, turnaround_basis: "business", internal_processing_days: 2,
    };
  }
  function shapeReq(row) {
    return {
      id: row.id, payer: row.payer, request_type: row.request_type, configured: true,
      required_docs: parseJson(row.required_docs, []),
      optional_docs: parseJson(row.optional_docs, []),
      parent_signature_required: row.parent_signature_required === true || row.parent_signature_required === "t",
      parent_signature_doc: row.parent_signature_doc || null,
      turnaround_days: Number(row.turnaround_days) || 0,
      turnaround_basis: row.turnaround_basis === "calendar" ? "calendar" : "business",
      internal_processing_days: Number(row.internal_processing_days) || 0,
      active: row.active === true || row.active === "t",
      updated_by: row.updated_by || null, updated_at: row.updated_at || null,
    };
  }

  const AUTH_EMAIL_KEY = "auth_request_email";
  const ATTACH_LIMIT_KEY = "auth_request_attachment_limit_mb";
  // Resend accepts 40MB per message. The default here is deliberately under
  // it: the ceiling that matters is the one the RECEIVING mail server
  // enforces, which we do not know, and a request that bounces at the payer's
  // gateway fails silently from our side.
  const DEFAULT_ATTACH_LIMIT_MB = 20;
  async function authEmail() { return clean(await getSetting(AUTH_EMAIL_KEY)) || null; }
  async function attachLimitBytes() {
    const mb = Number(await getSetting(ATTACH_LIMIT_KEY));
    return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_ATTACH_LIMIT_MB) * 1024 * 1024;
  }

  // ---- document matching --------------------------------------------------
  // §20. Type metadata first, filename only as a fallback, newest first, and
  // the date always carried so a BCBA can see they are about to attach last
  // year's Vineland.
  async function candidatesFor(clientId, requirementKey) {
    const docs = await dbAll(
      `SELECT id, label, filename, clinical_type, clinical_type_source, document_date, uploaded_at, doc_type, file_path
         FROM client_documents WHERE client_id = ? ORDER BY COALESCE(document_date, uploaded_at) DESC, id DESC`,
      [clientId]
    ).catch(() => []);
    const typed = docs.filter((d) => lower(d.clinical_type) === requirementKey);
    const hint = NAME_HINTS[requirementKey];
    // A typed match is authoritative; a name match is a suggestion. They are
    // never mixed, because "we think this is the Vineland because it is called
    // Vineland" is a different claim from "this is filed as the Vineland".
    const named = typed.length || !hint ? [] : docs.filter(
      (d) => !clean(d.clinical_type) && (hint.test(d.label || "") || hint.test(d.filename || "")));
    const shape = (d, source) => ({
      id: d.id, label: d.label, filename: d.filename,
      clinical_type: d.clinical_type || null,
      document_date: d.document_date || (d.uploaded_at || "").slice(0, 10) || null,
      has_file: !!d.file_path,
      // A type somebody chose and a type derived from a SignNow title are both
      // "type" for matching -- they are both filed facts about the document --
      // but the audit trail should not call the second one somebody's decision.
      match_source: source,
      type_source: source === "type" ? (clean(d.clinical_type_source) || "picked") : null,
    });
    return typed.map((d) => shape(d, "type")).concat(named.map((d) => shape(d, "filename")));
  }

  // ---- events -------------------------------------------------------------
  async function logEvent(requestId, actor, action, opts = {}) {
    await dbRun(
      `INSERT INTO auth_request_events (request_id, at, actor, action, document_id, prev_status, new_status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [requestId, nowISO(), actor || "system", action, opts.documentId || null,
       opts.prevStatus || null, opts.newStatus || null, opts.notes || null]
    ).catch(() => {});
  }

  // ---- the status engine --------------------------------------------------
  // The whole point: a request cannot claim to be ready while something is
  // missing, because nobody types this. It is recomputed from the rows every
  // time the rows change.
  async function recompute(requestId, actor) {
    const req = await dbGet("SELECT * FROM auth_requests WHERE id = ?", [requestId]);
    if (!req) return null;
    // Past submission the payer owns the answer. Recomputing would overwrite
    // an approval somebody recorded with "ready to submit".
    if (!isDerived(req.status)) return req;

    const rows = await dbAll("SELECT * FROM auth_request_documents WHERE request_id = ?", [requestId]).catch(() => []);
    const required = rows.filter((r) => !(r.optional === true || r.optional === "t"));
    const missing = required.filter((r) => r.status === "missing");
    const awaiting = required.filter((r) => r.status === "awaiting_parent_signature");

    let next = "ready_to_submit";
    if (missing.length) next = "missing_documents";
    else if (awaiting.length) next = "awaiting_parent_signature";
    if (!required.length) next = "missing_documents";

    if (next !== req.status) {
      await dbRun("UPDATE auth_requests SET status = ?, updated_at = ? WHERE id = ?", [next, nowISO(), requestId]);
      await logEvent(requestId, actor || "system", "status_changed", { prevStatus: req.status, newStatus: next });
      req.status = next;
    }
    await refreshProjection(requestId);
    return await dbGet("SELECT * FROM auth_requests WHERE id = ?", [requestId]);
  }

  // §9. An ESTIMATE, and labelled as one everywhere it is shown.
  //
  //   ready  = today, or today + internal processing if something is still
  //            outstanding -- an unsigned treatment plan pushes everything
  //            right, which is exactly the pressure the reminder emails exist
  //            to relieve.
  //   response = submitted (or projected submit) + the payer's turnaround
  //   start    = response + internal processing
  //
  // Once a real submission date exists the projection is anchored to it
  // rather than to today, so the date stops drifting forward every time
  // somebody opens the page.
  async function projectionFor(req, reqs) {
    const cfg = reqs || await requirementsFor(req.payer, req.request_type);
    const rows = await dbAll("SELECT * FROM auth_request_documents WHERE request_id = ?", [req.id]).catch(() => []);
    const required = rows.filter((r) => !(r.optional === true || r.optional === "t"));
    const outstanding = required.filter((r) => r.status !== "ready").length;
    const waitingOnParent = required.some((r) => r.status === "awaiting_parent_signature");

    const submitted = req.actual_submitted_at ? req.actual_submitted_at.slice(0, 10) : null;
    const internal = cfg.internal_processing_days || 0;
    // Nothing is known about how long a missing document takes to arrive, so
    // it is not guessed at: the projection assumes it lands today and says
    // separately that it has not. Inventing "documents usually take 3 days"
    // would be a number with no evidence behind it.
    const submitOn = submitted || addDays(today(), outstanding ? internal : 0, "calendar");
    const responseOn = addDays(submitOn, cfg.turnaround_days || 0, cfg.turnaround_basis);
    const startOn = addDays(responseOn, internal, "calendar");
    return {
      projected_submit_date: submitOn,
      projected_response_date: req.actual_approved_at ? req.actual_approved_at.slice(0, 10) : responseOn,
      projected_start_date: req.actual_start_date || startOn,
      waiting_on_parent: waitingOnParent,
      outstanding,
      turnaround_days: cfg.turnaround_days || 0,
      turnaround_basis: cfg.turnaround_basis,
      internal_processing_days: internal,
      payer_configured: cfg.configured !== false,
      estimate_note: `${cfg.payer || "This payer"} estimated review: ${cfg.turnaround_days || 0} ${cfg.turnaround_basis} days`,
      disclaimer: "Projected dates are estimates based on typical payer processing times and do not guarantee authorization approval.",
    };
  }
  async function refreshProjection(requestId) {
    const req = await dbGet("SELECT * FROM auth_requests WHERE id = ?", [requestId]);
    if (!req) return;
    const p = await projectionFor(req);
    await dbRun(
      "UPDATE auth_requests SET projected_start_date = ?, projected_response_date = ?, updated_at = ? WHERE id = ?",
      [p.projected_start_date, p.projected_response_date, nowISO(), requestId]
    ).catch(() => {});
  }

  // §2. The tracker. Node state is read off the request rather than stored,
  // so it can never disagree with the status.
  function trackerFor(req, cfg, docRows) {
    const required = (docRows || []).filter((r) => !(r.optional === true || r.optional === "t"));
    const ready = required.filter((r) => r.status === "ready").length;
    const awaiting = required.some((r) => r.status === "awaiting_parent_signature");
    const missing = required.some((r) => r.status === "missing");
    const s = req.status;
    const done = (k) => ({ key: k, label: NODE_LABEL[k], state: "complete" });
    const at = (k, state) => ({ key: k, label: NODE_LABEL[k], state });

    const afterSubmit = ["submitted", "pending_payer", "info_requested", "approved", "partially_approved", "denied", "expired"].includes(s);
    const nodes = [];

    nodes.push(missing && !afterSubmit
      ? at("documents", s === "draft" ? "not_started" : "action_needed")
      : (ready || afterSubmit ? done("documents") : at("documents", "not_started")));

    if (cfg.parent_signature_required) {
      nodes.push(afterSubmit || !awaiting ? (awaiting ? at("parent_signature", "waiting") : done("parent_signature"))
        : at("parent_signature", "waiting"));
    }

    nodes.push(afterSubmit ? done("ready")
      : s === "ready_to_submit" ? at("ready", "in_progress") : at("ready", "not_started"));
    nodes.push(afterSubmit ? done("submitted") : at("submitted", "not_started"));

    nodes.push(s === "approved" || s === "partially_approved" ? done("payer_review")
      : s === "denied" ? at("payer_review", "denied")
      : s === "info_requested" ? at("payer_review", "action_needed")
      : (s === "submitted" || s === "pending_payer") ? at("payer_review", "waiting")
      : at("payer_review", "not_started"));

    nodes.push(s === "denied" ? at("approved", "denied")
      : (s === "approved" || s === "partially_approved") ? done("approved")
      : at("approved", "not_started"));

    nodes.push(req.actual_start_date ? done("start")
      : (s === "approved" || s === "partially_approved") ? at("start", "in_progress")
      : at("start", "not_started"));

    return { nodes, ready_count: ready, required_count: required.length,
      percent: required.length ? Math.round((ready / required.length) * 100) : 0 };
  }

  // ---- creating a request -------------------------------------------------
  async function createRequest(user, body) {
    const clientId = Number(body.client_id);
    if (!clientId) return { ok: false, status: 400, error: "Choose a client." };
    const type = clean(body.request_type);
    if (!REQUEST_TYPE_LABEL[type]) return { ok: false, status: 400, error: "Choose what you are requesting." };
    const client = await dbGet("SELECT * FROM clients WHERE id = ?", [clientId]);
    if (!client) return { ok: false, status: 404, error: "That client is not on file." };

    // The payer comes from the client record unless the BCBA overrides it,
    // because the client card is where the payer is already maintained.
    const payer = clean(body.payer) || clean(client.insurance_provider);
    const cfg = await requirementsFor(payer, type);
    const now = nowISO();
    const row = await dbGet(
      `INSERT INTO auth_requests
         (client_id, request_type, payer, status, member_id, requested_services, requested_units,
          requested_hours, requested_start, requested_end, bcba_name, bcba_email, notes,
          requirements_snapshot, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [clientId, type, payer || null, clean(body.member_id) || null,
       clean(body.requested_services) || null, clean(body.requested_units) || null,
       clean(body.requested_hours) || null, clean(body.requested_start) || null,
       clean(body.requested_end) || null,
       clean(body.bcba_name) || clean(client.assigned_bcba_name) || user.name || null,
       clean(body.bcba_email) || clean(client.assigned_bcba_email) || user.email || null,
       clean(body.notes) || null, JSON.stringify(cfg), user.email || user.name || "unknown", now, now]
    );
    const id = row.id;
    await logEvent(id, user.email || user.name, "created", { newStatus: "draft",
      notes: `${REQUEST_TYPE_LABEL[type]}${payer ? " · " + payer : ""}` });

    // §4/§5/§20. Search the client's file BEFORE asking anybody to upload
    // anything. The commonest failure of a form like this is making a
    // clinician re-supply a document the CRM already holds.
    const all = cfg.required_docs.map((k) => ({ key: k, optional: false }))
      .concat(cfg.optional_docs.map((k) => ({ key: k, optional: true })));
    for (const r of all) {
      const cands = await candidatesFor(clientId, r.key);
      // ONLY A TYPED MATCH IS ACCEPTED ON ITS OWN. A filename match is a
      // guess -- "Parenting Stress Index.pdf" on the right client is probably
      // the right document, and probably is not good enough to send a payer.
      // It is still offered in the picker and in the preview, so confirming
      // it is one click and nobody re-uploads anything; it just is not
      // counted as ready until a person says so.
      const best = cands.filter(function (c) { return c.match_source === "type"; })[0] || null;
      const needsSig = cfg.parent_signature_required && cfg.parent_signature_doc === r.key;
      // A found treatment plan still is not READY when the payer wants the
      // parent's signature on it -- it is BCBA-signed and half done.
      const status = !best ? "missing" : (needsSig ? "awaiting_parent_signature" : "ready");
      await dbRun(
        `INSERT INTO auth_request_documents
           (request_id, requirement_key, optional, client_document_id, document_date, match_source, status, chosen_by, chosen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (request_id, requirement_key) DO NOTHING`,
        [id, r.key, r.optional, best ? best.id : null, best ? best.document_date : null,
         best ? best.match_source : null, r.optional && !best ? "ready" : status,
         best ? "auto" : null, best ? now : null]
      ).catch(() => {});
      if (best) {
        await logEvent(id, "system", "document_matched", { documentId: best.id,
          notes: `${DOC_TYPE_LABEL[r.key] || r.key} matched by ${
            best.type_source === "signnow_title" ? "type, filed from its SignNow title" : best.match_source}` });
      }
    }
    await recompute(id, user.email || user.name);
    return { ok: true, id };
  }

  // ---- reading ------------------------------------------------------------
  async function shapeRequest(req, opts = {}) {
    const cfg = usableSnapshot(req.requirements_snapshot) || await requirementsFor(req.payer, req.request_type);
    const docRows = await dbAll("SELECT * FROM auth_request_documents WHERE request_id = ? ORDER BY optional, id", [req.id]).catch(() => []);
    const client = await dbGet("SELECT id, child_name, dob, parent_name, parent_email, insurance_provider FROM clients WHERE id = ?", [req.client_id]).catch(() => null);
    const sig = await dbGet(
      "SELECT * FROM auth_signature_requests WHERE request_id = ? AND status <> 'cancelled' ORDER BY id DESC LIMIT 1",
      [req.id]).catch(() => null);
    const projection = await projectionFor(req, cfg);
    const tracker = trackerFor(req, cfg, docRows);

    const docs = [];
    for (const d of docRows) {
      const doc = d.client_document_id
        ? await dbGet("SELECT id, label, filename, clinical_type, document_date, uploaded_at, file_path FROM client_documents WHERE id = ?", [d.client_document_id]).catch(() => null)
        : null;
      docs.push({
        requirement_key: d.requirement_key,
        label: DOC_TYPE_LABEL[d.requirement_key] || d.requirement_key,
        optional: d.optional === true || d.optional === "t",
        status: d.status,
        match_source: d.match_source || null,
        document: doc ? {
          id: doc.id, label: doc.label, filename: doc.filename,
          clinical_type: doc.clinical_type || null,
          document_date: d.document_date || doc.document_date || (doc.uploaded_at || "").slice(0, 10) || null,
          has_file: !!doc.file_path,
        } : null,
      });
    }

    const out = {
      id: req.id, client_id: req.client_id,
      client_name: client ? client.child_name : null,
      client_dob: client ? client.dob : null,
      parent_name: client ? client.parent_name : null,
      parent_email: client ? client.parent_email : null,
      request_type: req.request_type, request_type_label: REQUEST_TYPE_LABEL[req.request_type] || req.request_type,
      payer: req.payer, member_id: req.member_id,
      status: req.status, status_label: STATUS_LABEL[req.status] || req.status,
      status_is_derived: isDerived(req.status),
      requested_services: req.requested_services, requested_units: req.requested_units,
      requested_hours: req.requested_hours, requested_start: req.requested_start, requested_end: req.requested_end,
      bcba_name: req.bcba_name, notes: req.notes,
      requirements: cfg, documents: docs, tracker, projection,
      actual_submitted_at: req.actual_submitted_at, actual_approved_at: req.actual_approved_at,
      actual_start_date: req.actual_start_date,
      authorization_number: req.authorization_number, approval_date: req.approval_date,
      effective_start: req.effective_start, effective_end: req.effective_end,
      approved_cpt_codes: req.approved_cpt_codes, approved_units: req.approved_units,
      approved_hours: req.approved_hours, frequency: req.frequency,
      approval_notes: req.approval_notes, outcome_reason: req.outcome_reason,
      created_at: req.created_at,
      signature: sig ? {
        id: sig.id, status: sig.status, requirement_key: sig.requirement_key,
        parent_name: sig.parent_name, parent_email: sig.parent_email,
        requested_at: sig.requested_at, last_reminder_at: sig.last_reminder_at,
        reminders_sent: Number(sig.reminders_sent) || 0,
        viewed_at: sig.viewed_at, signed_at: sig.signed_at, signed_name: sig.signed_name,
        completed_document_id: sig.completed_document_id,
        // The link is handed back so it can be sent another way when a
        // parent's email bounces. It is a secret, so it is only ever given
        // to a signed-in CRM user asking for this request.
        signing_url: sig.status === "pending" ? `${appBaseUrl()}/authorization-sign/${sig.token}` : null,
      } : null,
    };
    if (opts.full) {
      out.events = await dbAll("SELECT * FROM auth_request_events WHERE request_id = ? ORDER BY id", [req.id]).catch(() => []);
      out.submissions = await dbAll("SELECT * FROM auth_submissions WHERE request_id = ? ORDER BY id", [req.id]).catch(() => []);
      out.info_requests = await dbAll("SELECT * FROM auth_info_requests WHERE request_id = ? ORDER BY id", [req.id]).catch(() => []);
    }
    return out;
  }

  // ---- parent signature ---------------------------------------------------
  // §6/§7. The BCBA has already signed. This asks the PARENT, and only when
  // the payer configuration says the parent's signature is part of the
  // package. It lives inside the request; there is no signatures page.
  async function requestParentSignature(user, requestId, body = {}) {
    const req = await dbGet("SELECT * FROM auth_requests WHERE id = ?", [requestId]);
    if (!req) return { ok: false, status: 404, error: "That Authorization Request is not on file." };
    const cfg = usableSnapshot(req.requirements_snapshot) || await requirementsFor(req.payer, req.request_type);
    if (!cfg.parent_signature_required) {
      return { ok: false, status: 400, error: "This payer's configuration does not ask for a parent signature." };
    }
    const key = cfg.parent_signature_doc || "treatment_plan";
    const reqDoc = await dbGet("SELECT * FROM auth_request_documents WHERE request_id = ? AND requirement_key = ?", [requestId, key]);
    if (!reqDoc || !reqDoc.client_document_id) {
      return { ok: false, status: 400, error: `Attach the ${DOC_TYPE_LABEL[key] || key} before asking the family to sign it.` };
    }
    const client = await dbGet("SELECT child_name, parent_name, parent_email FROM clients WHERE id = ?", [req.client_id]);
    const to = clean(body.parent_email) || clean(client && client.parent_email);
    if (!to) return { ok: false, status: 400, error: "This client has no parent email on file." };

    const existing = await dbGet(
      "SELECT * FROM auth_signature_requests WHERE request_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
      [requestId]).catch(() => null);
    let sig = existing;
    if (!sig) {
      const token = crypto.randomBytes(24).toString("base64url");
      sig = await dbGet(
        `INSERT INTO auth_signature_requests
           (request_id, requirement_key, source_document_id, token, parent_name, parent_email,
            status, requested_at, requested_by, reminders_sent)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0) RETURNING *`,
        [requestId, key, reqDoc.client_document_id, token,
         clean(body.parent_name) || clean(client && client.parent_name) || null, to,
         nowISO(), user.email || user.name || "unknown"]
      );
      await dbRun("UPDATE auth_request_documents SET status = 'awaiting_parent_signature' WHERE request_id = ? AND requirement_key = ?", [requestId, key]);
      await logEvent(requestId, user.email || user.name, "parent_signature_requested", { notes: to });
    }
    const sent = await sendSignatureEmail(sig, req, client, false);
    await recompute(requestId, user.email || user.name);
    return { ok: true, signature_id: sig.id, delivered: sent.delivered,
      signing_url: `${appBaseUrl()}/authorization-sign/${sig.token}` };
  }

  // §8. The wording is the point: it says plainly that services may be
  // delayed, because that is the true consequence and a vaguer sentence gets
  // ignored for a week.
  function signatureEmailHtml(sig, req, client, isReminder) {
    const url = `${appBaseUrl()}/authorization-sign/${sig.token}`;
    const child = (client && client.child_name) || "your child";
    return `
      <p>Hello${sig.parent_name ? " " + esc(sig.parent_name) : ""},</p>
      <p>${isReminder ? "This is a reminder that your" : "Your"} signature is required to continue the
      authorization process for <strong>${esc(child)}</strong>.</p>
      <p><strong>A delay in receiving your signature may delay the start of ABA services.</strong></p>
      <p style="margin:22px 0;">
        <a href="${url}" style="background:#e0a430;color:#1b2a6b;font-weight:700;padding:12px 22px;
           border-radius:999px;text-decoration:none;display:inline-block;">Review &amp; Sign Treatment Plan</a>
      </p>
      <p style="font-size:12px;color:#6b6a86;">If the button does not work, open this link:<br/>${url}</p>`;
  }
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  async function sendSignatureEmail(sig, req, client, isReminder) {
    const child = (client && client.child_name) || "your child";
    return await sendEmail({
      to: sig.parent_email,
      subject: isReminder
        ? `Reminder: your signature is needed for ${child}'s treatment plan`
        : `Please review and sign ${child}'s treatment plan`,
      html: signatureEmailHtml(sig, req, client, isReminder),
      clientId: req.client_id,
      type: "authorization_parent_signature",
      refType: "auth_request", refId: req.id,
    });
  }

  // §8. Daily until signed, never twice in a day. The uniqueness is a
  // CONSTRAINT rather than a check-then-send: two sweeps overlapping is the
  // ordinary way a family gets the same email twice in a minute, and a
  // read-then-write cannot prevent it.
  async function sendDailyReminders(opts = {}) {
    const day = opts.day || today();
    const pending = await dbAll(
      "SELECT * FROM auth_signature_requests WHERE status = 'pending' ORDER BY id").catch(() => []);
    let sent = 0, skipped = 0;
    for (const sig of pending) {
      // Not on the day it was requested -- the request email has only just
      // arrived and a reminder the same afternoon reads as a system fault.
      if (clean(sig.requested_at).slice(0, 10) === day) { skipped++; continue; }
      const claim = await dbRun(
        `INSERT INTO auth_signature_reminders (signature_id, sent_on, sent_at)
         VALUES (?, ?, ?) ON CONFLICT (signature_id, sent_on) DO NOTHING`,
        [sig.id, day, nowISO()]).catch(() => null);
      const claimed = claim && (claim.rowCount != null ? claim.rowCount : (claim.changes || 0));
      if (!claimed) { skipped++; continue; }

      const req = await dbGet("SELECT * FROM auth_requests WHERE id = ?", [sig.request_id]);
      const client = req ? await dbGet("SELECT child_name, parent_name FROM clients WHERE id = ?", [req.client_id]) : null;
      if (!req) { skipped++; continue; }
      const r = await sendSignatureEmail(sig, req, client, true);
      await dbRun(
        `UPDATE auth_signature_requests
            SET reminders_sent = COALESCE(reminders_sent,0) + 1, last_reminder_at = ?, last_reminder_day = ?
          WHERE id = ?`, [nowISO(), day, sig.id]).catch(() => {});
      await dbRun("UPDATE auth_signature_reminders SET delivered = ? WHERE signature_id = ? AND sent_on = ?",
        [r.delivered || null, sig.id, day]).catch(() => {});
      await logEvent(sig.request_id, "system", "parent_reminder_sent", { notes: sig.parent_email });
      sent++;
    }
    return { sent, skipped, day };
  }

  // §7. THE COMPLETED TREATMENT PLAN IS ONE DOCUMENT.
  //
  // The BCBA-signed plan already exists as a PDF on the client's record. The
  // parent's signature is appended to THAT file rather than filed as a
  // separate certificate, because a payer receiving two attachments has to
  // work out that they belong together, and sometimes does not.
  //
  // The appended page is an attestation, not a drawn squiggle: the typed name,
  // the moment, and the identity of the document signed. That is what an
  // electronic signature is, and pretending otherwise with a scribble image
  // would look more official while proving less.
  //
  // If the source is not a PDF, or pdf-lib cannot read it, the signature is
  // still RECORDED and the request still advances -- with the certificate
  // stored on its own and the reason kept. Losing a signature a parent already
  // gave because of a file format would be the worst outcome here.
  async function buildCompletedPlan(sig, req, client) {
    const source = sig.source_document_id
      ? await dbGet("SELECT * FROM client_documents WHERE id = ?", [sig.source_document_id]).catch(() => null)
      : null;
    const child = (client && client.child_name) || "Client";
    const when = sig.signed_at || nowISO();
    const lines = [
      ["Client", child],
      ["Document", source ? (source.label || source.filename) : "Treatment Plan"],
      ["Signed by", `${sig.signed_name || sig.parent_name || "Parent/Guardian"} (parent/guardian)`],
      ["Signed at", when],
      ["Authorization Request", `#${req.id} — ${REQUEST_TYPE_LABEL[req.request_type] || req.request_type}`],
    ];

    let merged = null, note = null;
    try {
      const fs = require("fs");
      const srcPath = source && source.file_path ? documentPath(source.file_path) : null;
      if (srcPath && fs.existsSync(srcPath) && /\.pdf$/i.test(srcPath)) {
        const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
        const pdf = await PDFDocument.load(fs.readFileSync(srcPath));
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
        const page = pdf.addPage();
        const { width, height } = page.getSize();
        let y = height - 70;
        page.drawText("Electronic Signature", { x: 56, y, size: 20, font: bold, color: rgb(0.106, 0.165, 0.420) });
        y -= 16;
        page.drawText("Spectrum Squad", { x: 56, y, size: 11, font, color: rgb(0.42, 0.41, 0.52) });
        y -= 34;
        for (const [k, v] of lines) {
          page.drawText(k, { x: 56, y, size: 10, font, color: rgb(0.42, 0.41, 0.52) });
          page.drawText(String(v), { x: 176, y, size: 11, font: bold, color: rgb(0.125, 0.102, 0.302) });
          y -= 22;
        }
        y -= 10;
        page.drawText("The parent/guardian named above reviewed this document and applied their", { x: 56, y, size: 9.5, font, color: rgb(0.42, 0.41, 0.52) });
        y -= 14;
        page.drawText("electronic signature. This page was generated by the Spectrum Squad CRM.", { x: 56, y, size: 9.5, font, color: rgb(0.42, 0.41, 0.52) });
        merged = Buffer.from(await pdf.save());
      } else {
        note = srcPath ? "The treatment plan on file is not a PDF." : "The treatment plan on file has no stored file.";
      }
    } catch (e) {
      note = `The treatment plan PDF could not be opened (${String(e.message).slice(0, 120)}).`;
    }

    if (!merged) {
      // Certificate on its own. Recorded with its reason so nobody has to
      // wonder later why this one is shaped differently.
      const PDFDocument = require("pdfkit");
      merged = await new Promise((resolve, reject) => {
        try {
          const doc = new PDFDocument({ size: "LETTER", margin: 56 });
          const chunks = [];
          doc.on("data", (c) => chunks.push(c));
          doc.on("end", () => resolve(Buffer.concat(chunks)));
          doc.fillColor("#1b2a6b").fontSize(20).text("Electronic Signature");
          doc.fillColor("#6b6a86").fontSize(11).text("Spectrum Squad");
          doc.moveDown(1);
          lines.forEach(([k, v]) => {
            doc.fillColor("#6b6a86").fontSize(10).text(k);
            doc.fillColor("#201a4d").fontSize(12).text(String(v));
            doc.moveDown(0.4);
          });
          if (note) { doc.moveDown(0.6); doc.fillColor("#b45309").fontSize(10).text(note); }
          doc.end();
        } catch (e) { reject(e); }
      });
    }

    const safe = String(child).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client";
    const filename = `TreatmentPlan-Signed-${safe}.pdf`;
    const docId = await saveGeneratedPdf({
      clientId: req.client_id, filename, buffer: merged,
      label: `Treatment Plan — signed ${when.slice(0, 10)}`,
      clinicalType: "signed_treatment_plan", documentDate: when.slice(0, 10),
    });
    return { documentId: docId, merged_into_plan: !note, note };
  }

  // The parent presses Sign. Everything §7 lists happens here, in one place,
  // so a signature can never be recorded without the request moving with it.
  async function submitSignature(token, body) {
    const sig = await dbGet("SELECT * FROM auth_signature_requests WHERE token = ?", [clean(token)]);
    if (!sig) return { ok: false, status: 404, error: "This signing link is not valid." };
    if (sig.status === "signed") return { ok: false, status: 409, error: "This treatment plan has already been signed." };
    if (sig.status === "cancelled") return { ok: false, status: 409, error: "This signature request was withdrawn." };
    const typed = clean(body.signed_name);
    if (!typed) return { ok: false, status: 400, error: "Type your full name to sign." };

    const when = nowISO();
    // CLAIMED BEFORE ANYTHING ELSE. Two taps on a phone, or a double submit,
    // must not produce two completed plans and two "signed" events.
    const claim = await dbRun(
      "UPDATE auth_signature_requests SET status = 'signed', signed_at = ?, signed_name = ? WHERE id = ? AND status = 'pending'",
      [when, typed, sig.id]);
    const claimed = claim && (claim.rowCount != null ? claim.rowCount : (claim.changes || 0));
    if (!claimed) return { ok: false, status: 409, error: "This treatment plan has already been signed." };

    const req = await dbGet("SELECT * FROM auth_requests WHERE id = ?", [sig.request_id]);
    const client = req ? await dbGet("SELECT child_name, parent_name FROM clients WHERE id = ?", [req.client_id]) : null;
    sig.signed_at = when; sig.signed_name = typed;

    let built = { documentId: null, merged_into_plan: false, note: "The request could not be read." };
    if (req) built = await buildCompletedPlan(sig, req, client).catch((e) => ({ documentId: null, merged_into_plan: false, note: String(e.message).slice(0, 140) }));

    if (built.documentId) {
      await dbRun("UPDATE auth_signature_requests SET completed_document_id = ? WHERE id = ?", [built.documentId, sig.id]).catch(() => {});
      // The requirement is now met BY THE COMPLETED DOCUMENT, not by the
      // half-signed one it was pointing at.
      await dbRun(
        `UPDATE auth_request_documents SET status = 'ready', client_document_id = ?, document_date = ?, match_source = 'signature', chosen_by = 'parent-signature', chosen_at = ?
          WHERE request_id = ? AND requirement_key = ?`,
        [built.documentId, when.slice(0, 10), when, sig.request_id, sig.requirement_key]).catch(() => {});
    } else {
      await dbRun("UPDATE auth_request_documents SET status = 'ready' WHERE request_id = ? AND requirement_key = ?",
        [sig.request_id, sig.requirement_key]).catch(() => {});
    }
    await logEvent(sig.request_id, sig.parent_email || "parent", "parent_signed",
      { documentId: built.documentId, notes: built.merged_into_plan ? "Signature appended to the treatment plan" : (built.note || null) });
    // Reminders stop because the row is no longer pending -- the sweep reads
    // status, so there is nothing separate to switch off and nothing that can
    // be left on by mistake.
    await recompute(sig.request_id, "parent-signature");
    return { ok: true, merged: built.merged_into_plan, note: built.note || null };
  }

  async function markViewed(token) {
    await dbRun("UPDATE auth_signature_requests SET viewed_at = COALESCE(viewed_at, ?) WHERE token = ? AND status = 'pending'",
      [nowISO(), clean(token)]).catch(() => {});
  }

  // ---- submission ---------------------------------------------------------
  // §12/§13. The package is assembled, weighed and sent to the CONFIGURED
  // address. Nothing here knows an email address; an administrator owns it.
  async function buildPackage(req) {
    const rows = await dbAll("SELECT * FROM auth_request_documents WHERE request_id = ? ORDER BY optional, id", [req.id]).catch(() => []);
    const fs = require("fs");
    const files = [];
    const problems = [];
    for (const r of rows) {
      if (!r.client_document_id) {
        if (!(r.optional === true || r.optional === "t")) problems.push(`${DOC_TYPE_LABEL[r.requirement_key] || r.requirement_key} is missing.`);
        continue;
      }
      const doc = await dbGet("SELECT * FROM client_documents WHERE id = ?", [r.client_document_id]).catch(() => null);
      if (!doc) { problems.push(`${DOC_TYPE_LABEL[r.requirement_key] || r.requirement_key} points at a document that is no longer on file.`); continue; }
      if (!doc.file_path) {
        // A link is not an attachment. Saying so is better than sending a
        // package that is quietly one document short.
        problems.push(`${DOC_TYPE_LABEL[r.requirement_key] || r.requirement_key} is a link rather than a stored file and cannot be attached.`);
        continue;
      }
      const full = documentPath(doc.file_path);
      let stat = null;
      try { stat = fs.statSync(full); } catch (e) { stat = null; }
      if (!stat) { problems.push(`${DOC_TYPE_LABEL[r.requirement_key] || r.requirement_key} could not be read from storage.`); continue; }
      files.push({
        requirement_key: r.requirement_key,
        filename: doc.filename || `${r.requirement_key}.pdf`,
        path: full, bytes: stat.size,
        label: DOC_TYPE_LABEL[r.requirement_key] || r.requirement_key,
      });
    }
    const total = files.reduce((a, f) => a + f.bytes, 0);
    return { files, problems, total_bytes: total };
  }

  function submissionSubject(req, client) {
    return `Authorization Request – ${(client && client.child_name) || "Client"} – ${REQUEST_TYPE_LABEL[req.request_type] || req.request_type} – ${req.payer || "Payer"}`;
  }
  function submissionHtml(req, client, files) {
    const row = (k, v) => v ? `<tr><td style="padding:3px 14px 3px 0;color:#6b6a86;">${esc(k)}</td><td style="padding:3px 0;"><strong>${esc(v)}</strong></td></tr>` : "";
    return `
      <p>Please find attached an authorization request from Spectrum Squad.</p>
      <table style="border-collapse:collapse;font-size:14px;">
        ${row("Client", client && client.child_name)}
        ${row("Date of birth", client && client.dob)}
        ${row("Payer", req.payer)}
        ${row("Member ID", req.member_id)}
        ${row("Request type", REQUEST_TYPE_LABEL[req.request_type] || req.request_type)}
        ${row("Requested services", req.requested_services)}
        ${row("Requested units", req.requested_units)}
        ${row("Requested hours", req.requested_hours)}
        ${row("Requested date range", [req.requested_start, req.requested_end].filter(Boolean).join(" to "))}
        ${row("BCBA", req.bcba_name)}
        ${row("Submitted", nowISO().slice(0, 10))}
      </table>
      <p style="margin-top:16px;font-size:14px;">Attachments (${files.length}):</p>
      <ul style="font-size:14px;">${files.map((f) => `<li>${esc(f.filename)} — ${esc(f.label)}</li>`).join("")}</ul>`;
  }

  async function reviewPackage(requestId) {
    const req = await dbGet("SELECT * FROM auth_requests WHERE id = ?", [requestId]);
    if (!req) return { ok: false, status: 404, error: "That Authorization Request is not on file." };
    const client = await dbGet("SELECT * FROM clients WHERE id = ?", [req.client_id]).catch(() => null);
    const pkg = await buildPackage(req);
    const limit = await attachLimitBytes();
    const to = await authEmail();
    const prior = await dbAll("SELECT * FROM auth_submissions WHERE request_id = ? ORDER BY id", [requestId]).catch(() => []);
    return {
      ok: true,
      to, subject: submissionSubject(req, client),
      files: pkg.files.map((f) => ({ filename: f.filename, label: f.label, bytes: f.bytes })),
      problems: pkg.problems,
      total_bytes: pkg.total_bytes, limit_bytes: limit,
      over_limit: pkg.total_bytes > limit,
      already_submitted: prior.filter((p) => p.delivered !== "failed").length > 0,
      last_submitted_at: prior.length ? prior[prior.length - 1].submitted_at : null,
      email_configured: !!to,
      client: client ? { child_name: client.child_name, dob: client.dob } : null,
      request: { member_id: req.member_id, payer: req.payer, bcba_name: req.bcba_name,
        requested_services: req.requested_services, requested_units: req.requested_units,
        requested_hours: req.requested_hours, requested_start: req.requested_start, requested_end: req.requested_end },
    };
  }

  async function submit(user, requestId, body = {}) {
    const req = await dbGet("SELECT * FROM auth_requests WHERE id = ?", [requestId]);
    if (!req) return { ok: false, status: 404, error: "That Authorization Request is not on file." };
    const to = await authEmail();
    if (!to) return { ok: false, status: 400, error: "No Authorization Request email is configured. An administrator sets it in Settings." };

    const prior = await dbAll("SELECT * FROM auth_submissions WHERE request_id = ? AND delivered <> 'failed' ORDER BY id", [requestId]).catch(() => []);
    // §14. A second send is allowed, never by accident.
    if (prior.length && !clean(body.resubmission_reason)) {
      return { ok: false, status: 409, code: "already_submitted",
        error: `This Authorization Request was already submitted on ${clean(prior[prior.length - 1].submitted_at).slice(0, 10)}.`,
        requires: "resubmission_reason" };
    }

    const pkg = await buildPackage(req);
    if (pkg.problems.length && !prior.length) {
      return { ok: false, status: 400, error: "The package is not complete.", problems: pkg.problems };
    }
    const limit = await attachLimitBytes();
    if (pkg.total_bytes > limit) {
      // §13. Never a silent failure. The BCBA is told, and pointed at the
      // secure document route that already exists for exactly this.
      await logEvent(requestId, user.email || user.name, "submission_blocked_size",
        { notes: `${Math.round(pkg.total_bytes / 1048576)}MB over the ${Math.round(limit / 1048576)}MB limit` });
      return { ok: false, status: 413, code: "attachments_too_large",
        error: `These attachments total ${(pkg.total_bytes / 1048576).toFixed(1)}MB, over the ${Math.round(limit / 1048576)}MB limit for a single email. Send them through the secure document link instead and record the submission here.`,
        total_bytes: pkg.total_bytes, limit_bytes: limit };
    }

    const client = await dbGet("SELECT * FROM clients WHERE id = ?", [req.client_id]).catch(() => null);
    const fs = require("fs");
    const attachments = pkg.files.map((f) => ({
      filename: f.filename, content: fs.readFileSync(f.path).toString("base64"),
    }));
    const subject = submissionSubject(req, client);
    const attempt = (await dbAll("SELECT id FROM auth_submissions WHERE request_id = ?", [requestId]).catch(() => [])).length + 1;

    const sent = await sendEmail({
      to, subject, html: submissionHtml(req, client, pkg.files),
      clientId: req.client_id, type: "authorization_request_submission",
      attachments, refType: "auth_request", refId: requestId,
    });

    const now = nowISO();
    await dbRun(
      `INSERT INTO auth_submissions
         (request_id, attempt, submitted_at, submitted_by, to_email, subject, attachment_names,
          attachment_count, total_bytes, delivered, error, resubmission_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [requestId, attempt, now, user.email || user.name || "unknown", to, subject,
       JSON.stringify(pkg.files.map((f) => f.filename)), pkg.files.length, pkg.total_bytes,
       sent.delivered || null, sent.errorMsg || null, clean(body.resubmission_reason) || null]
    ).catch(() => {});

    if (sent.delivered === "failed") {
      await logEvent(requestId, user.email || user.name, "submission_failed", { notes: (sent.errorMsg || "").slice(0, 200) });
      return { ok: false, status: 502, error: "The Authorization Request could not be sent. Nothing was marked submitted.", detail: sent.errorMsg || null };
    }

    const prev = req.status;
    await dbRun(
      "UPDATE auth_requests SET status = 'submitted', actual_submitted_at = ?, updated_at = ? WHERE id = ?",
      [now, now, requestId]);
    await logEvent(requestId, user.email || user.name, "submitted",
      { prevStatus: prev, newStatus: "submitted",
        notes: `${pkg.files.length} attachment(s) to ${to}${clean(body.resubmission_reason) ? " · resubmitted: " + clean(body.resubmission_reason) : ""}` });
    await refreshProjection(requestId);
    const after = await dbGet("SELECT * FROM auth_requests WHERE id = ?", [requestId]);
    return { ok: true, submitted_at: now, attachments: pkg.files.length,
      projected_response_date: after.projected_response_date, projected_start_date: after.projected_start_date };
  }

  // ---- outcomes -----------------------------------------------------------
  const OUTCOME_STATUSES = ["pending_payer", "info_requested", "approved", "partially_approved", "denied", "expired", "cancelled"];

  async function recordOutcome(user, requestId, body) {
    const req = await dbGet("SELECT * FROM auth_requests WHERE id = ?", [requestId]);
    if (!req) return { ok: false, status: 404, error: "That Authorization Request is not on file." };
    const status = clean(body.status);
    if (!OUTCOME_STATUSES.includes(status)) return { ok: false, status: 400, error: "That is not a status somebody records by hand." };
    if (isDerived(req.status) && status !== "cancelled") {
      return { ok: false, status: 400, error: "This Authorization Request has not been submitted yet." };
    }
    const sets = ["status = ?", "updated_at = ?"];
    const params = [status, nowISO()];
    const put = (col, val) => { sets.push(`${col} = ?`); params.push(val); };

    if (status === "approved" || status === "partially_approved") {
      put("authorization_number", clean(body.authorization_number) || null);
      put("approval_date", clean(body.approval_date) || today());
      put("effective_start", clean(body.effective_start) || null);
      put("effective_end", clean(body.effective_end) || null);
      put("approved_cpt_codes", clean(body.approved_cpt_codes) || null);
      put("approved_units", clean(body.approved_units) || null);
      put("approved_hours", clean(body.approved_hours) || null);
      put("frequency", clean(body.frequency) || null);
      put("approval_notes", clean(body.approval_notes) || null);
      put("actual_approved_at", nowISO());
      // §18. The actual start is stored beside the projected one, never over
      // it: the gap between them is the measurement this data exists for.
      if (clean(body.actual_start_date)) put("actual_start_date", clean(body.actual_start_date));
    } else {
      put("outcome_reason", clean(body.outcome_reason) || clean(body.notes) || null);
    }
    params.push(requestId);
    await dbRun(`UPDATE auth_requests SET ${sets.join(", ")} WHERE id = ?`, params);
    await logEvent(requestId, user.email || user.name, "outcome_recorded",
      { prevStatus: req.status, newStatus: status, notes: clean(body.authorization_number) || clean(body.outcome_reason) || null });
    await refreshProjection(requestId);
    return { ok: true };
  }

  // §16. The payer wants more. It stays on the SAME request -- a second
  // request would split the history of one authorization across two records
  // and make every turnaround figure wrong.
  async function recordInfoRequest(user, requestId, body) {
    const req = await dbGet("SELECT * FROM auth_requests WHERE id = ?", [requestId]);
    if (!req) return { ok: false, status: 404, error: "That Authorization Request is not on file." };
    const row = await dbGet(
      `INSERT INTO auth_info_requests (request_id, requested_at, requested_by_payer, needed, due_date, notes, recorded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [requestId, clean(body.requested_at) || today(), clean(body.requested_by_payer) || null,
       clean(body.needed) || null, clean(body.due_date) || null, clean(body.notes) || null,
       user.email || user.name || "unknown"]);
    const prev = req.status;
    await dbRun("UPDATE auth_requests SET status = 'info_requested', updated_at = ? WHERE id = ?", [nowISO(), requestId]);
    await logEvent(requestId, user.email || user.name, "info_requested",
      { prevStatus: prev, newStatus: "info_requested", notes: clean(body.needed) || null });
    return { ok: true, id: row.id };
  }

  async function sendInfoResponse(user, requestId, infoId, body) {
    const req = await dbGet("SELECT * FROM auth_requests WHERE id = ?", [requestId]);
    const info = await dbGet("SELECT * FROM auth_info_requests WHERE id = ? AND request_id = ?", [infoId, requestId]);
    if (!req || !info) return { ok: false, status: 404, error: "That information request is not on file." };
    const to = await authEmail();
    if (!to) return { ok: false, status: 400, error: "No Authorization Request email is configured." };
    const ids = Array.isArray(body.document_ids) ? body.document_ids.map(Number).filter(Boolean) : [];
    const fs = require("fs");
    const attachments = [];
    const names = [];
    let bytes = 0;
    for (const id of ids) {
      const doc = await dbGet("SELECT * FROM client_documents WHERE id = ? AND client_id = ?", [id, req.client_id]).catch(() => null);
      if (!doc || !doc.file_path) continue;
      const full = documentPath(doc.file_path);
      if (!fs.existsSync(full)) continue;
      const buf = fs.readFileSync(full);
      bytes += buf.length;
      attachments.push({ filename: doc.filename, content: buf.toString("base64") });
      names.push(doc.filename);
    }
    const limit = await attachLimitBytes();
    if (bytes > limit) {
      return { ok: false, status: 413, code: "attachments_too_large",
        error: `These attachments total ${(bytes / 1048576).toFixed(1)}MB, over the ${Math.round(limit / 1048576)}MB limit for a single email.` };
    }
    const client = await dbGet("SELECT child_name, dob FROM clients WHERE id = ?", [req.client_id]).catch(() => null);
    const sent = await sendEmail({
      to, subject: `Additional information – ${(client && client.child_name) || "Client"} – ${REQUEST_TYPE_LABEL[req.request_type]} – ${req.payer || ""}`.trim(),
      html: `<p>Additional information for the authorization request below.</p>
             <p><strong>${esc((client && client.child_name) || "Client")}</strong>${client && client.dob ? " · DOB " + esc(client.dob) : ""}</p>
             ${info.needed ? `<p style="color:#6b6a86;">Requested: ${esc(info.needed)}</p>` : ""}
             ${clean(body.message) ? `<p>${esc(clean(body.message))}</p>` : ""}
             <ul>${names.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`,
      clientId: req.client_id, type: "authorization_info_response",
      attachments, refType: "auth_request", refId: requestId,
    });
    if (sent.delivered === "failed") return { ok: false, status: 502, error: "That could not be sent.", detail: sent.errorMsg || null };
    await dbRun(
      "UPDATE auth_info_requests SET responded_at = ?, responded_by = ?, response_document_ids = ? WHERE id = ?",
      [nowISO(), user.email || user.name || "unknown", JSON.stringify(ids), infoId]).catch(() => {});
    await dbRun("UPDATE auth_requests SET status = 'pending_payer', updated_at = ? WHERE id = ?", [nowISO(), requestId]);
    await logEvent(requestId, user.email || user.name, "info_sent",
      { prevStatus: "info_requested", newStatus: "pending_payer", notes: `${names.length} document(s)` });
    return { ok: true, attachments: names.length };
  }

  // ---- choosing a different document --------------------------------------
  async function chooseDocument(user, requestId, key, body) {
    const req = await dbGet("SELECT * FROM auth_requests WHERE id = ?", [requestId]);
    if (!req) return { ok: false, status: 404, error: "That Authorization Request is not on file." };
    const docId = Number(body.client_document_id);
    if (!docId) return { ok: false, status: 400, error: "Choose a document." };
    const doc = await dbGet("SELECT * FROM client_documents WHERE id = ? AND client_id = ?", [docId, req.client_id]);
    if (!doc) return { ok: false, status: 404, error: "That document is not on this client's record." };
    const cfg = usableSnapshot(req.requirements_snapshot) || await requirementsFor(req.payer, req.request_type);
    const needsSig = cfg.parent_signature_required && cfg.parent_signature_doc === key;
    // Choosing a NEW treatment plan while one is out for signature invalidates
    // that signature request: the family would otherwise be signing a document
    // the package no longer contains.
    if (needsSig) {
      const open = await dbGet("SELECT * FROM auth_signature_requests WHERE request_id = ? AND status = 'pending'", [requestId]).catch(() => null);
      if (open && open.source_document_id !== docId) {
        await dbRun("UPDATE auth_signature_requests SET status = 'cancelled', cancelled_at = ? WHERE id = ?", [nowISO(), open.id]);
        await logEvent(requestId, user.email || user.name, "parent_signature_cancelled",
          { notes: "A different treatment plan was chosen, so the open signature request was withdrawn." });
      }
    }
    await dbRun(
      `UPDATE auth_request_documents
          SET client_document_id = ?, document_date = ?, match_source = 'chosen', status = ?, chosen_by = ?, chosen_at = ?
        WHERE request_id = ? AND requirement_key = ?`,
      [docId, doc.document_date || (doc.uploaded_at || "").slice(0, 10) || null,
       needsSig ? "awaiting_parent_signature" : "ready",
       user.email || user.name || "unknown", nowISO(), requestId, key]);
    // Filing the clinical type as it is used means the next request for this
    // client matches by type instead of by filename.
    if (!clean(doc.clinical_type)) {
      await dbRun("UPDATE client_documents SET clinical_type = ? WHERE id = ?", [key, docId]).catch(() => {});
    }
    await logEvent(requestId, user.email || user.name, "document_chosen",
      { documentId: docId, notes: DOC_TYPE_LABEL[key] || key });
    await recompute(requestId, user.email || user.name);
    return { ok: true };
  }

  // ---- the parent's page --------------------------------------------------
  // §7. Mobile first, no CRM session, one job. The parent is not a user of
  // this system and never will be, so the page asks for exactly one thing and
  // explains what it is for.
  function signPageHtml() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Review &amp; Sign — Spectrum Squad</title>
<style>
  :root{--navy:#1b2a6b;--ink:#201a4d;--muted:#6b6a86;--line:#e6e1d4;--bg:#faf8f2;--gold:#e0a430}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
  .wrap{max-width:620px;margin:0 auto;padding:20px 16px 64px}
  .card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:14px}
  h1{font-size:21px;margin:0 0 6px;color:var(--navy)}
  .muted{color:var(--muted);font-size:14px}
  .k{color:var(--muted);font-size:12.5px;text-transform:uppercase;letter-spacing:.05em;font-weight:700;margin-bottom:2px}
  .v{font-size:16px;font-weight:600;margin-bottom:14px}
  label{display:block;font-weight:700;font-size:14px;margin:16px 0 6px}
  input[type=text]{width:100%;padding:14px;border:1px solid var(--line);border-radius:10px;font-size:17px;font-family:inherit}
  button{width:100%;background:var(--gold);color:var(--navy);font-weight:800;border:0;border-radius:999px;
    padding:16px;font-size:17px;cursor:pointer;font-family:inherit;margin-top:18px}
  button:disabled{opacity:.55;cursor:default}
  a.view{display:block;text-align:center;border:1px solid var(--line);border-radius:10px;padding:13px;
    text-decoration:none;color:var(--navy);font-weight:700;background:#fff}
  .note{background:#fff8e6;border:1px solid #f3e0b0;border-radius:10px;padding:12px 14px;font-size:14px;margin-top:14px}
  .ok{background:#e9f9ee;border:1px solid #bfe6cd;color:#166534;border-radius:12px;padding:18px;text-align:center}
  .err{background:#fee2e2;border:1px solid #fca5a5;color:#991b1b;border-radius:10px;padding:12px 14px;font-size:14px;margin-top:12px}
  @media (max-width:420px){ .wrap{padding:14px 12px 50px} }
</style></head><body><div class="wrap" id="app"><div class="card muted">Loading…</div></div>
<script>
var TOKEN = location.pathname.split("/").filter(Boolean).pop();
var app = document.getElementById("app");
function esc(s){var d=document.createElement("div");d.textContent=s==null?"":String(s);return d.innerHTML;}
// A parent should not be shown an ISO timestamp. Formatted here, in the page,
// because the date arrives as data and this is the only place it is read.
// The backslashes are doubled: this whole page is a template literal, and a
// single \d would reach the browser as a bare "d" and quietly never match.
var MONTHS=["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
function longDate(iso){var m=/^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(String(iso||"").slice(0,10));
  return m?MONTHS[Number(m[2])-1]+" "+Number(m[3])+", "+m[1]:String(iso||"");}
function card(h){return '<div class="card">'+h+'</div>';}
function render(d){
  if(d.signed){
    app.innerHTML = card('<div class="ok"><div style="font-size:30px;line-height:1">&#10003;</div>'+
      '<h1 style="margin:8px 0 4px">Thank you</h1>'+
      '<div class="muted">You signed '+esc(d.client_name)+"'s treatment plan on "+esc((d.signed_at||"").slice(0,10))+'.</div></div>');
    return;
  }
  app.innerHTML =
    card('<h1>Review &amp; sign</h1><div class="muted">Your signature is required to continue the authorization process. '+
      'A delay in receiving your signature may delay the start of ABA services.</div>') +
    card('<div class="k">Client</div><div class="v">'+esc(d.client_name)+'</div>'+
      '<div class="k">Document</div><div class="v">'+esc(d.document_label)+'</div>'+
      (d.can_view ? '<a class="view" href="/authorization-sign/'+encodeURIComponent(TOKEN)+'/document" target="_blank" rel="noopener">View the treatment plan</a>'
                  : '<div class="note">This document cannot be previewed here. Your clinician can send you a copy.</div>')) +
    card('<label for="nm">Type your full name to sign</label>'+
      '<input id="nm" type="text" autocomplete="name" placeholder="Your full name" />'+
      '<div class="muted" style="margin-top:10px">Signing on '+esc(longDate(d.today))+' as the parent or guardian of '+esc(d.client_name)+'.</div>'+
      '<button id="go">Sign Treatment Plan</button><div id="err"></div>');
  var btn=document.getElementById("go"), nm=document.getElementById("nm");
  btn.addEventListener("click", function(){
    var v=(nm.value||"").trim();
    if(!v){document.getElementById("err").innerHTML='<div class="err">Type your full name to sign.</div>';return;}
    btn.disabled=true; btn.textContent="Signing…";
    fetch("/api/authorization-sign/"+encodeURIComponent(TOKEN),{method:"POST",
      headers:{"Content-Type":"application/json"},body:JSON.stringify({signed_name:v})})
      .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
      .then(function(res){
        if(!res.ok){btn.disabled=false;btn.textContent="Sign Treatment Plan";
          document.getElementById("err").innerHTML='<div class="err">'+esc(res.j.error||"That did not go through.")+'</div>';return;}
        load();
      })
      .catch(function(){btn.disabled=false;btn.textContent="Sign Treatment Plan";
        document.getElementById("err").innerHTML='<div class="err">That did not go through. Please try again.</div>';});
  });
}
function load(){
  fetch("/api/authorization-sign/"+encodeURIComponent(TOKEN))
    .then(function(r){return r.json();})
    .then(function(d){ if(d.error){app.innerHTML=card('<h1>This link is not valid</h1><div class="muted">'+esc(d.error)+'</div>');return;} render(d); })
    .catch(function(){app.innerHTML=card('<h1>Something went wrong</h1><div class="muted">Please try the link again.</div>');});
}
load();
</script></body></html>`;
  }

  async function publicSignatureView(token) {
    const sig = await dbGet("SELECT * FROM auth_signature_requests WHERE token = ?", [clean(token)]);
    if (!sig) return { error: "This signing link is not valid." };
    const req = await dbGet("SELECT * FROM auth_requests WHERE id = ?", [sig.request_id]);
    const client = req ? await dbGet("SELECT child_name FROM clients WHERE id = ?", [req.client_id]) : null;
    const doc = sig.source_document_id ? await dbGet("SELECT label, filename, file_path FROM client_documents WHERE id = ?", [sig.source_document_id]).catch(() => null) : null;
    if (sig.status === "cancelled") return { error: "This signature request was withdrawn. Your clinician can send a new one." };
    await markViewed(token);
    return {
      signed: sig.status === "signed",
      signed_at: sig.signed_at || null,
      client_name: (client && client.child_name) || "your child",
      document_label: (doc && (doc.label || doc.filename)) || "Treatment Plan",
      can_view: !!(doc && doc.file_path),
      today: today(),
    };
  }

  async function serveSignedDocument(req, res, token) {
    const fs = require("fs");
    const path = require("path");
    const sig = await dbGet("SELECT * FROM auth_signature_requests WHERE token = ?", [clean(token)]);
    if (!sig || sig.status === "cancelled" || !sig.source_document_id) { res.writeHead(404); res.end("Not found"); return true; }
    const doc = await dbGet("SELECT * FROM client_documents WHERE id = ?", [sig.source_document_id]).catch(() => null);
    if (!doc || !doc.file_path) { res.writeHead(404); res.end("Not found"); return true; }
    const full = documentPath(doc.file_path);
    if (!fs.existsSync(full)) { res.writeHead(404); res.end("Not found"); return true; }
    res.writeHead(200, {
      "Content-Type": doc.mime_type || "application/pdf",
      // inline so a phone opens it in the browser rather than downloading it
      "Content-Disposition": `inline; filename="${path.basename(doc.filename || "treatment-plan.pdf").replace(/"/g, "")}"`,
      "Cache-Control": "no-store",
    });
    fs.createReadStream(full).pipe(res);
    return true;
  }

  async function servePage(req, res, pathname) {
    if (pathname.startsWith("/authorization-sign/")) {
      const rest = pathname.slice("/authorization-sign/".length);
      if (rest.endsWith("/document")) {
        return await serveSignedDocument(req, res, rest.slice(0, -"/document".length));
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(signPageHtml());
      return true;
    }
    return false;
  }

  // ---- API ----------------------------------------------------------------
  async function handleApi(req, res, pathname, method, query, user) {
    // The parent's two routes carry no session at all: the token IS the
    // authorisation, and it only ever reaches one signature request.
    if (pathname.startsWith("/api/authorization-sign/")) {
      const token = pathname.slice("/api/authorization-sign/".length);
      if (method === "GET") { json(res, 200, await publicSignatureView(token)); return true; }
      if (method === "POST") {
        const body = await readBody(req);
        const r = await submitSignature(token, body);
        json(res, r.ok ? 200 : (r.status || 400), r.ok ? { ok: true, merged: r.merged } : { error: r.error });
        return true;
      }
      return false;
    }

    if (!pathname.startsWith("/api/authorization-requests")) return false;
    if (!user) { json(res, 401, { error: "Not signed in" }); return true; }
    // The same gate the client pipeline uses: an Authorization Request is a
    // view of a client record and belongs behind client access, not behind a
    // rule of its own.
    if (!canAccessClients(user)) { json(res, 403, { error: "Not permitted" }); return true; }
    const actor = user.email || user.name || "unknown";

    // -- configuration (admin) --
    if (pathname === "/api/authorization-requests/config" && method === "GET") {
      const rows = await dbAll("SELECT * FROM auth_payer_requirements ORDER BY payer, request_type").catch(() => []);
      json(res, 200, {
        payers: rows.map(shapeReq),
        request_types: REQUEST_TYPES, doc_types: DOC_TYPES, statuses: STATUSES,
        auth_email: await authEmail(),
        attachment_limit_mb: Math.round((await attachLimitBytes()) / 1048576),
        can_configure: isOwnerOrAdmin(user),
      });
      return true;
    }
    if (pathname === "/api/authorization-requests/config" && method === "PUT") {
      if (!isOwnerOrAdmin(user)) { json(res, 403, { error: "Only an owner or admin can change authorization settings." }); return true; }
      const b = await readBody(req);
      if ("auth_email" in b) await setSetting(AUTH_EMAIL_KEY, clean(b.auth_email));
      if ("attachment_limit_mb" in b) await setSetting(ATTACH_LIMIT_KEY, String(Number(b.attachment_limit_mb) || DEFAULT_ATTACH_LIMIT_MB));
      if (Array.isArray(b.payers)) {
        for (const p of b.payers) {
          if (!clean(p.payer) || !REQUEST_TYPE_LABEL[clean(p.request_type)]) continue;
          await dbRun(
            `INSERT INTO auth_payer_requirements
               (payer, request_type, required_docs, optional_docs, parent_signature_required, parent_signature_doc,
                turnaround_days, turnaround_basis, internal_processing_days, active, updated_by, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (payer, request_type) DO UPDATE SET
               required_docs = EXCLUDED.required_docs, optional_docs = EXCLUDED.optional_docs,
               parent_signature_required = EXCLUDED.parent_signature_required,
               parent_signature_doc = EXCLUDED.parent_signature_doc,
               turnaround_days = EXCLUDED.turnaround_days, turnaround_basis = EXCLUDED.turnaround_basis,
               internal_processing_days = EXCLUDED.internal_processing_days,
               active = EXCLUDED.active, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
            [clean(p.payer), clean(p.request_type),
             JSON.stringify(Array.isArray(p.required_docs) ? p.required_docs : []),
             JSON.stringify(Array.isArray(p.optional_docs) ? p.optional_docs : []),
             p.parent_signature_required === true, clean(p.parent_signature_doc) || null,
             Number(p.turnaround_days) || 0, p.turnaround_basis === "calendar" ? "calendar" : "business",
             Number(p.internal_processing_days) || 0, p.active !== false, actor, nowISO()]
          ).catch(() => {});
        }
      }
      json(res, 200, { ok: true });
      return true;
    }

    // -- what a request would require, before creating one --
    if (pathname === "/api/authorization-requests/preview" && method === "GET") {
      const clientId = Number(query.client_id);
      const type = clean(query.request_type);
      if (!clientId || !REQUEST_TYPE_LABEL[type]) { json(res, 400, { error: "Choose a client and what you are requesting." }); return true; }
      const client = await dbGet("SELECT id, child_name, insurance_provider, parent_email FROM clients WHERE id = ?", [clientId]);
      if (!client) { json(res, 404, { error: "That client is not on file." }); return true; }
      const payer = clean(query.payer) || clean(client.insurance_provider);
      const cfg = await requirementsFor(payer, type);
      const items = [];
      for (const k of cfg.required_docs.concat(cfg.optional_docs)) {
        const cands = await candidatesFor(clientId, k);
        items.push({ key: k, label: DOC_TYPE_LABEL[k] || k,
          optional: cfg.optional_docs.includes(k), candidates: cands, found: cands.length > 0 });
      }
      json(res, 200, { client: { id: client.id, child_name: client.child_name, parent_email: client.parent_email },
        payer, requirements: cfg, items });
      return true;
    }

    // -- list --
    if (pathname === "/api/authorization-requests" && method === "GET") {
      const where = [], params = [];
      if (query.client_id) { where.push("client_id = ?"); params.push(Number(query.client_id)); }
      if (query.status) { where.push("status = ?"); params.push(clean(query.status)); }
      if (!query.include_closed) where.push("status NOT IN ('cancelled','expired')");
      const rows = await dbAll(
        `SELECT * FROM auth_requests ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT 200`,
        params).catch(() => []);
      const out = [];
      for (const r of rows) out.push(await shapeRequest(r));
      json(res, 200, { requests: out, request_types: REQUEST_TYPES, doc_types: DOC_TYPES });
      return true;
    }
    if (pathname === "/api/authorization-requests" && method === "POST") {
      const r = await createRequest(user, await readBody(req));
      if (!r.ok) { json(res, r.status || 400, { error: r.error }); return true; }
      const row = await dbGet("SELECT * FROM auth_requests WHERE id = ?", [r.id]);
      json(res, 201, await shapeRequest(row, { full: true }));
      return true;
    }

    const m = pathname.match(/^\/api\/authorization-requests\/(\d+)(?:\/([a-z-]+))?(?:\/(\d+))?$/);
    if (!m) return false;
    const id = Number(m[1]), action = m[2] || null, sub = m[3] ? Number(m[3]) : null;
    const existing = await dbGet("SELECT * FROM auth_requests WHERE id = ?", [id]);
    if (!existing) { json(res, 404, { error: "That Authorization Request is not on file." }); return true; }

    if (!action && method === "GET") { json(res, 200, await shapeRequest(existing, { full: true })); return true; }

    if (!action && method === "PATCH") {
      const b = await readBody(req);
      const cols = ["member_id", "requested_services", "requested_units", "requested_hours",
        "requested_start", "requested_end", "bcba_name", "notes", "actual_start_date"];
      const sets = [], params = [];
      for (const c of cols) if (c in b) { sets.push(`${c} = ?`); params.push(clean(b[c]) || null); }
      if (!sets.length) { json(res, 400, { error: "Nothing to update." }); return true; }
      sets.push("updated_at = ?"); params.push(nowISO(), id);
      await dbRun(`UPDATE auth_requests SET ${sets.join(", ")} WHERE id = ?`, params);
      await logEvent(id, actor, "details_updated");
      await refreshProjection(id);
      json(res, 200, await shapeRequest(await dbGet("SELECT * FROM auth_requests WHERE id = ?", [id]), { full: true }));
      return true;
    }

    if (action === "candidates" && method === "GET") {
      const key = clean(query.requirement_key);
      json(res, 200, { candidates: await candidatesFor(existing.client_id, key) });
      return true;
    }
    if (action === "document" && method === "POST") {
      const b = await readBody(req);
      const r = await chooseDocument(user, id, clean(b.requirement_key), b);
      json(res, r.ok ? 200 : (r.status || 400), r.ok ? await shapeRequest(await dbGet("SELECT * FROM auth_requests WHERE id = ?", [id]), { full: true }) : { error: r.error });
      return true;
    }
    if (action === "request-signature" && method === "POST") {
      const r = await requestParentSignature(user, id, await readBody(req));
      json(res, r.ok ? 200 : (r.status || 400), r.ok ? { ok: true, signing_url: r.signing_url, delivered: r.delivered } : { error: r.error });
      return true;
    }
    if (action === "resend-signature" && method === "POST") {
      const sig = await dbGet("SELECT * FROM auth_signature_requests WHERE request_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1", [id]);
      if (!sig) { json(res, 400, { error: "There is no signature request waiting on this family." }); return true; }
      const client = await dbGet("SELECT child_name, parent_name FROM clients WHERE id = ?", [existing.client_id]);
      const sent = await sendSignatureEmail(sig, existing, client, true);
      await dbRun("UPDATE auth_signature_requests SET reminders_sent = COALESCE(reminders_sent,0) + 1, last_reminder_at = ? WHERE id = ?", [nowISO(), sig.id]);
      await logEvent(id, actor, "parent_reminder_sent", { notes: "sent by hand" });
      json(res, 200, { ok: true, delivered: sent.delivered });
      return true;
    }
    if (action === "review" && method === "GET") { json(res, 200, await reviewPackage(id)); return true; }
    if (action === "submit" && method === "POST") {
      const r = await submit(user, id, await readBody(req));
      json(res, r.ok ? 200 : (r.status || 400), r.ok ? r : r);
      return true;
    }
    if (action === "outcome" && method === "POST") {
      const r = await recordOutcome(user, id, await readBody(req));
      json(res, r.ok ? 200 : (r.status || 400), r.ok ? await shapeRequest(await dbGet("SELECT * FROM auth_requests WHERE id = ?", [id]), { full: true }) : { error: r.error });
      return true;
    }
    if (action === "info-request" && method === "POST") {
      const r = await recordInfoRequest(user, id, await readBody(req));
      json(res, r.ok ? 200 : (r.status || 400), r.ok ? await shapeRequest(await dbGet("SELECT * FROM auth_requests WHERE id = ?", [id]), { full: true }) : { error: r.error });
      return true;
    }
    if (action === "info-response" && method === "POST" && sub) {
      const r = await sendInfoResponse(user, id, sub, await readBody(req));
      json(res, r.ok ? 200 : (r.status || 400), r.ok ? r : r);
      return true;
    }
    return false;
  }

  return {
    initTables, handleApi, servePage, sendDailyReminders,
    REQUEST_TYPES, DOC_TYPES, STATUSES, NODE_ORDER,
    _internal: { addDays, requirementsFor, candidatesFor, trackerFor, projectionFor,
      recompute, createRequest, submitSignature, buildPackage, seedPayerRequirements, isDerived },
  };
};
