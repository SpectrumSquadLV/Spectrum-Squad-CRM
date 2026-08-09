// onboarding.js -- new hire onboarding: the document portal and the pipeline
// that runs off it.
//
// One onboarding record per hire, created the moment their offer is accepted.
// It owns the list of documents that role actually has to produce, a tokenized
// portal they upload into, the 72-hour clock, and the detection that fires
// everything downstream once the last document lands.
//
// Rules this file exists to hold:
//
//   * The system never rescinds an offer. The email says documents are due in
//     72 hours; the CRM counts the hours, nudges before the deadline, and then
//     tells a human it ran out. Ending someone's employment before it starts
//     is not an automation.
//
//   * Social Security cards and passports are recorded as received, never
//     stored. The existing document tracker already works this way and there
//     is no reason for that file to sit on a disk.
//
//   * A certificate's dates are read from the file when the file has text to
//     read, and asked for when it does not. A photographed certificate has no
//     text layer and there is no OCR here. An expiry date is never guessed --
//     a wrong one silently arms, or fails to arm, a compliance reminder.
//
// Additive: new onboarding_* tables, routes under /api/onboarding/*, and a
// public portal page. Reuses hr_employees, the email templates, staff tasks
// and the certification records that already exist.

"use strict";

const fs = require("fs");
const path = require("path");

module.exports = function initOnboarding(ctx) {
  const {
    dbGet, dbAll, dbRun, nowISO, crypto, readBody, json, sendFile,
    sendEmail, APP_BASE_URL, getAppSetting, renderTemplate,
  } = ctx;

  const clean = (v) => (v == null ? "" : String(v).trim());
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const DATA_DIR = path.join(__dirname, "data");
  const DOC_DIR = path.join(DATA_DIR, "onboarding-docs");
  if (!fs.existsSync(DOC_DIR)) fs.mkdirSync(DOC_DIR, { recursive: true });

  const ADMIN_ROLES = ["owner", "super_admin", "admin", "hr_admin"];
  const canManage = (u) => !!u && ADMIN_ROLES.includes(u.role);

  // ======================= DOCUMENT REQUIREMENTS =============
  // Exactly the lists in the two welcome emails. `stored: false` means the
  // portal records receipt and discards the file.
  const DOCS = {
    bcba: [
      { key: "bcba_cert",   label: "BCBA certificate",            expires: true,  stored: true,  cert_name: "BCBA" },
      { key: "lba_license", label: "Nevada State LBA licensure",  expires: true,  stored: true,  cert_name: "Nevada LBA" },
      { key: "photo_id",    label: "Driver's license or state ID", expires: true, stored: true,  cert_name: "Driver's License" },
      { key: "ssn",         label: "Social Security card or passport", expires: false, stored: false },
      { key: "cpr",         label: "CPR / First Aid certification", expires: true, stored: true,  cert_name: "CPR / First Aid" },
    ],
    rbt: [
      { key: "rbt_cert",    label: "RBT certificate",              expires: true,  stored: true,  cert_name: "RBT" },
      { key: "rbt_license", label: "Nevada State RBT licensure",   expires: true,  stored: true,  cert_name: "Nevada RBT" },
      { key: "photo_id",    label: "Driver's license or state ID", expires: true,  stored: true,  cert_name: "Driver's License" },
      { key: "ssn",         label: "Social Security card",         expires: false, stored: false },
      { key: "cpr",         label: "CPR / First Aid certification", expires: true, stored: true,  cert_name: "CPR / First Aid" },
      { key: "resume",      label: "Resume showing Spectrum Squad as a present employer", expires: false, stored: true },
    ],
  };
  // The credentialing form is completed on ClickUp, so the portal only tracks
  // that the hire says they have done it.
  const ATTESTATIONS = [{ key: "credentialing", label: "Credentialing form completed" }];

  const roleKindFor = (title) => (/bcba|bcaba|analyst/i.test(clean(title)) ? "bcba" : "rbt");
  const DEADLINE_HOURS = 72;

  // ======================= SCHEMA ============================
  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS onboarding_records (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL UNIQUE,
      role_kind TEXT NOT NULL DEFAULT 'rbt',
      portal_token TEXT UNIQUE NOT NULL,
      started_at TEXT,
      deadline_at TEXT,
      extension_note TEXT,
      extended_by TEXT,
      docs_complete_at TEXT,
      completion_notified_at TEXT,
      nudge_sent_at TEXT,
      overdue_flagged_at TEXT,
      status TEXT DEFAULT 'awaiting_documents',
      created_at TEXT,
      updated_at TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS onboarding_documents (
      id SERIAL PRIMARY KEY,
      onboarding_id INTEGER NOT NULL,
      doc_key TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'awaiting',  -- awaiting | received | needs_dates
      stored_name TEXT,
      filename TEXT,
      mime_type TEXT,
      issued_date TEXT,
      expiration_date TEXT,
      dates_source TEXT,                        -- read_from_file | entered_by_hire | not_applicable
      received_at TEXT,
      UNIQUE (onboarding_id, doc_key)
    )`);

    console.log("Onboarding portal schema ready.");
  }

  // ======================= RECORD ============================
  async function startOnboarding(employee, actor) {
    if (!employee || !employee.id) return null;
    const existing = await dbGet("SELECT * FROM onboarding_records WHERE employee_id = ?", [employee.id]);
    if (existing) return existing;

    const kind = roleKindFor(employee.role_title);
    const token = crypto.randomBytes(24).toString("hex");
    const deadlineOn = clean(await getAppSetting(`onboarding_deadline_${kind}`, "on")) !== "off";
    const deadline = deadlineOn
      ? new Date(Date.now() + DEADLINE_HOURS * 3600 * 1000).toISOString()
      : null;

    const rec = await dbGet(
      `INSERT INTO onboarding_records
         (employee_id, role_kind, portal_token, started_at, deadline_at, status, created_at, updated_at)
       VALUES (?,?,?,?,?, 'awaiting_documents', ?, ?) RETURNING *`,
      [employee.id, kind, token, nowISO(), deadline, nowISO(), nowISO()]
    );
    for (const d of DOCS[kind]) {
      await dbRun(
        "INSERT INTO onboarding_documents (onboarding_id, doc_key, label, status) VALUES (?,?,?, 'awaiting')",
        [rec.id, d.key, d.label]
      ).catch(() => {});
    }
    for (const a of ATTESTATIONS) {
      await dbRun(
        "INSERT INTO onboarding_documents (onboarding_id, doc_key, label, status) VALUES (?,?,?, 'awaiting')",
        [rec.id, a.key, a.label]
      ).catch(() => {});
    }
    console.log(`Onboarding started for employee ${employee.id} (${kind}) by ${actor || "system"}`);
    return rec;
  }

  const portalUrl = (token) => `${APP_BASE_URL}/new-hire/?token=${token}`;

  function docSpec(kind, key) {
    return (DOCS[kind] || []).find((d) => d.key === key) || ATTESTATIONS.find((a) => a.key === key) || null;
  }

  // ======================= DATE READING ======================
  // Pull an issue and expiry date out of a certificate that has readable text.
  // Returns nulls rather than guesses; the portal then asks the hire.
  const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december";
  function parseDatesFromText(text) {
    const found = [];
    const push = (y, m, d) => {
      if (!y || !m || !d) return;
      const dt = new Date(Date.UTC(y, m - 1, d));
      if (!isNaN(dt.getTime())) found.push(dt.toISOString().slice(0, 10));
    };
    const t = String(text || "");
    let m;
    const numeric = /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/g;
    while ((m = numeric.exec(t))) {
      let y = Number(m[3]); if (y < 100) y += 2000;
      push(y, Number(m[1]), Number(m[2]));
    }
    const isoRe = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
    while ((m = isoRe.exec(t))) push(Number(m[1]), Number(m[2]), Number(m[3]));
    const words = new RegExp(`\\b(${MONTHS})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, "gi");
    while ((m = words.exec(t))) {
      const mo = MONTHS.split("|").indexOf(m[1].toLowerCase()) + 1;
      push(Number(m[3]), mo, Number(m[2]));
    }
    if (!found.length) return { issued: null, expires: null };
    const sorted = [...new Set(found)].sort();
    // An expiry is a future date; an issue date is in the past. With only one
    // date and no way to tell which it is, claim neither.
    const today = nowISO().slice(0, 10);
    const future = sorted.filter((d) => d > today);
    const past = sorted.filter((d) => d <= today);
    if (future.length && past.length) return { issued: past[past.length - 1], expires: future[0] };
    if (future.length === 1 && !past.length) return { issued: null, expires: future[0] };
    return { issued: null, expires: null };
  }

  function readTextFromBuffer(buffer, mime, filename) {
    const name = clean(filename).toLowerCase();
    try {
      if (/pdf/.test(mime || "") || name.endsWith(".pdf")) {
        if (typeof ctx.extractPdfLines === "function") return ctx.extractPdfLines(buffer).join("\n");
        return "";
      }
      if (/text|plain/.test(mime || "") || name.endsWith(".txt")) return buffer.toString("utf8");
    } catch (e) { return ""; }
    return ""; // images: no OCR in this stack, so nothing is claimed
  }

  // ======================= COMPLETION ========================
  async function docsFor(rec) {
    return dbAll("SELECT * FROM onboarding_documents WHERE onboarding_id = ? ORDER BY id", [rec.id]);
  }

  async function checkCompletion(rec, employee) {
    const docs = await docsFor(rec);
    const outstanding = docs.filter((d) => d.status !== "received");
    if (outstanding.length) return { complete: false, outstanding: outstanding.length };
    if (rec.docs_complete_at) return { complete: true, already: true };

    await dbRun(
      "UPDATE onboarding_records SET docs_complete_at = ?, status = 'documents_complete', updated_at = ? WHERE id = ?",
      [nowISO(), nowISO(), rec.id]
    );

    // Tell the people who act on it, and leave the two tasks they have to do.
    const owner = clean(await getAppSetting("owner_notification_email", ""));
    const director = clean(await getAppSetting("clinical_director_email", ""));
    const to = [...new Set([owner, director].filter(Boolean))];
    if (to.length && typeof renderTemplate === "function") {
      const t = await renderTemplate("hr_docs_complete_internal", {
        employee_name: employee.name,
        role_title: employee.role_title ? ` (${employee.role_title})` : "",
        documents_list: `<ul>${docs.map((d) => `<li>${esc(d.label)}${d.expiration_date ? ` — expires ${esc(d.expiration_date)}` : ""}</li>`).join("")}</ul>`,
        employee_link: `${APP_BASE_URL}/#/staff`,
      });
      if (t) {
        for (const addr of to) {
          await sendEmail({ to: addr, subject: t.subject, html: t.html, type: "hr_onboarding" })
            .catch((e) => console.error("onboarding completion email failed:", e.message));
        }
      }
    }
    if (typeof ctx.makeStaffTask === "function") {
      await ctx.makeStaffTask(`Submit the background check request for ${employee.name}`, employee.id).catch(() => {});
      await ctx.makeStaffTask(`Add ${employee.name} to HomeBase`, employee.id).catch(() => {});
    }
    await dbRun("UPDATE onboarding_records SET completion_notified_at = ? WHERE id = ?", [nowISO(), rec.id]);
    return { complete: true, notified: to };
  }

  // Certificates land as real certification records, so the expiry notices
  // that already exist arm themselves without anyone retyping a date.
  async function recordCertification(employee, spec, doc, actor) {
    if (!spec || !spec.cert_name || !doc.expiration_date) return;
    const existing = await dbGet(
      "SELECT id FROM staff_certifications WHERE employee_id = ? AND LOWER(name) = LOWER(?)",
      [employee.id, spec.cert_name]
    ).catch(() => null);
    if (existing) {
      await dbRun(
        "UPDATE staff_certifications SET issued_date = COALESCE(?, issued_date), expiration_date = ?, updated_at = ? WHERE id = ?",
        [doc.issued_date || null, doc.expiration_date, nowISO(), existing.id]
      ).catch(() => {});
      return;
    }
    await dbRun(
      `INSERT INTO staff_certifications
         (employee_id, name, issued_date, expiration_date, status, notes, notify_staff, created_by, created_at, updated_at)
       VALUES (?,?,?,?, 'active', ?, TRUE, ?, ?, ?)`,
      [employee.id, spec.cert_name, doc.issued_date || null, doc.expiration_date,
       `Created from the ${spec.label} uploaded during onboarding (${doc.dates_source === "read_from_file" ? "dates read from the file" : "dates entered by the new hire"}).`,
       actor || "onboarding portal", nowISO(), nowISO()]
    ).catch((e) => console.error("certification from onboarding failed:", e.message));
  }

  // ======================= DEADLINE SWEEP ====================
  // Nudges before the deadline, flags after it. Never rescinds.
  async function deadlineSweep() {
    const out = { nudged: 0, flagged: 0 };
    const rows = await dbAll(
      `SELECT r.*, e.name, e.email FROM onboarding_records r
         JOIN hr_employees e ON e.id = r.employee_id
        WHERE r.docs_complete_at IS NULL AND r.deadline_at IS NOT NULL`
    ).catch(() => []);
    const now = Date.now();
    for (const r of rows) {
      const due = new Date(r.deadline_at).getTime();
      if (isNaN(due)) continue;
      const hoursLeft = (due - now) / 3600000;
      if (hoursLeft > 0 && hoursLeft <= 24 && !r.nudge_sent_at && r.email) {
        await sendEmail({
          to: r.email,
          subject: "A quick reminder about your onboarding documents",
          html: `<p>Hi ${esc(clean(r.name).split(/\s+/)[0] || "there")},</p>
            <p>Just a friendly nudge — we're still waiting on a few of your onboarding documents, and the deadline is tomorrow.</p>
            <p>You can upload them here: <a href="${esc(portalUrl(r.portal_token))}">${esc(portalUrl(r.portal_token))}</a></p>
            <p>If you need more time on any of them, reply and let us know — we can work around it.</p>`,
          type: "hr_onboarding",
        }).catch((e) => console.error("onboarding nudge failed:", e.message));
        await dbRun("UPDATE onboarding_records SET nudge_sent_at = ? WHERE id = ?", [nowISO(), r.id]);
        out.nudged++;
      }
      if (hoursLeft <= 0 && !r.overdue_flagged_at) {
        // A human decides what happens next. The CRM only says the time is up.
        await dbRun("UPDATE onboarding_records SET overdue_flagged_at = ?, status = 'past_deadline' WHERE id = ?", [nowISO(), r.id]);
        if (typeof ctx.makeStaffTask === "function") {
          await ctx.makeStaffTask(`${r.name}'s 72-hour document deadline has passed — decide how to proceed`, r.employee_id).catch(() => {});
        }
        out.flagged++;
      }
    }
    return out;
  }

  // ======================= API ===============================
  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/onboarding/")) return false;

    try {
      // ---------------- public portal ----------------
      if (pathname === "/api/onboarding/public/portal" && method === "GET") {
        const rec = await dbGet("SELECT * FROM onboarding_records WHERE portal_token = ?", [clean(query.token)]);
        if (!rec) { json(res, 404, { error: "This link isn't valid. Check the link in your welcome email, or reply to it and we'll send a new one." }); return true; }
        const emp = await dbGet("SELECT id, name, role_title FROM hr_employees WHERE id = ?", [rec.employee_id]);
        const docs = await docsFor(rec);
        const credLink = clean(await getAppSetting(`credentialing_link_${rec.role_kind}`, ""));
        json(res, 200, {
          first_name: clean(emp && emp.name).split(/\s+/)[0] || "",
          role_kind: rec.role_kind,
          deadline_at: rec.deadline_at,
          complete: !!rec.docs_complete_at,
          credentialing_link: credLink,
          documents: docs.map((d) => ({
            doc_key: d.doc_key, label: d.label, status: d.status,
            filename: d.filename, expiration_date: d.expiration_date, issued_date: d.issued_date,
            needs_dates: d.status === "needs_dates",
            stored: (docSpec(rec.role_kind, d.doc_key) || {}).stored !== false,
            expires: (docSpec(rec.role_kind, d.doc_key) || {}).expires === true,
            attestation: ATTESTATIONS.some((a) => a.key === d.doc_key),
          })),
        });
        return true;
      }

      // Upload one document. Raw body, doc key and token on the query string,
      // which keeps the portal a single fetch with no multipart parser.
      if (pathname === "/api/onboarding/public/upload" && method === "POST") {
        const rec = await dbGet("SELECT * FROM onboarding_records WHERE portal_token = ?", [clean(query.token)]);
        if (!rec) { json(res, 404, { error: "This link isn't valid." }); return true; }
        const key = clean(query.doc_key);
        const doc = await dbGet("SELECT * FROM onboarding_documents WHERE onboarding_id = ? AND doc_key = ?", [rec.id, key]);
        if (!doc) { json(res, 404, { error: "That isn't one of the documents we asked for." }); return true; }
        const spec = docSpec(rec.role_kind, key);

        const chunks = [];
        let size = 0;
        const MAX = 15 * 1024 * 1024;
        const tooBig = await new Promise((resolve) => {
          req.on("data", (c) => { size += c.length; if (size > MAX) { resolve(true); req.destroy(); } else chunks.push(c); });
          req.on("end", () => resolve(false));
          req.on("error", () => resolve(true));
        });
        if (tooBig) { json(res, 413, { error: "That file is larger than 15 MB. A photo or a PDF of the document is plenty." }); return true; }
        const buffer = Buffer.concat(chunks);
        if (!buffer.length) { json(res, 400, { error: "That upload came through empty — please try again." }); return true; }

        const filename = clean(query.filename) || "upload";
        const mime = clean(query.mime) || "application/octet-stream";

        let storedName = null;
        if (spec && spec.stored !== false) {
          storedName = `ob_${rec.id}_${key}_${Date.now()}${path.extname(filename).slice(0, 8)}`;
          fs.writeFileSync(path.join(DOC_DIR, storedName), buffer);
        }

        let issued = null, expires = null, source = "not_applicable";
        if (spec && spec.expires) {
          const text = readTextFromBuffer(buffer, mime, filename);
          const parsed = parseDatesFromText(text);
          issued = parsed.issued; expires = parsed.expires;
          source = expires ? "read_from_file" : null;
        }
        const needsDates = !!(spec && spec.expires && !expires);

        await dbRun(
          `UPDATE onboarding_documents SET status = ?, stored_name = ?, filename = ?, mime_type = ?,
             issued_date = ?, expiration_date = ?, dates_source = ?, received_at = ?
           WHERE id = ?`,
          [needsDates ? "needs_dates" : "received", storedName, filename.slice(0, 160), mime,
           issued, expires, source, nowISO(), doc.id]
        );

        const emp = await dbGet("SELECT id, name, role_title FROM hr_employees WHERE id = ?", [rec.employee_id]);
        if (!needsDates && spec) {
          await recordCertification(emp, spec, { issued_date: issued, expiration_date: expires, dates_source: source }, "onboarding portal");
        }
        const completion = await checkCompletion(rec, emp);
        json(res, 200, {
          ok: true,
          needs_dates: needsDates,
          message: needsDates
            ? "Got it. We couldn't read the dates off this one, so please type them in below."
            : (spec && spec.stored === false ? "Received. We've recorded that we have it and haven't kept a copy." : "Received, thank you."),
          expiration_date: expires, issued_date: issued,
          complete: !!completion.complete,
        });
        return true;
      }

      // The hire types the dates the file didn't carry.
      if (pathname === "/api/onboarding/public/dates" && method === "POST") {
        const rec = await dbGet("SELECT * FROM onboarding_records WHERE portal_token = ?", [clean(query.token)]);
        if (!rec) { json(res, 404, { error: "This link isn't valid." }); return true; }
        const b = await readBody(req);
        const doc = await dbGet("SELECT * FROM onboarding_documents WHERE onboarding_id = ? AND doc_key = ?", [rec.id, clean(b.doc_key)]);
        if (!doc) { json(res, 404, { error: "Unknown document." }); return true; }
        const exp = clean(b.expiration_date);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(exp)) { json(res, 400, { error: "Please give the expiration date as a real date." }); return true; }
        await dbRun(
          "UPDATE onboarding_documents SET issued_date = ?, expiration_date = ?, dates_source = 'entered_by_hire', status = 'received' WHERE id = ?",
          [clean(b.issued_date) || null, exp, doc.id]
        );
        const emp = await dbGet("SELECT id, name, role_title FROM hr_employees WHERE id = ?", [rec.employee_id]);
        await recordCertification(emp, docSpec(rec.role_kind, doc.doc_key),
          { issued_date: clean(b.issued_date) || null, expiration_date: exp, dates_source: "entered_by_hire" }, "onboarding portal");
        const completion = await checkCompletion(rec, emp);
        json(res, 200, { ok: true, complete: !!completion.complete });
        return true;
      }

      // Ticking the credentialing form off.
      if (pathname === "/api/onboarding/public/attest" && method === "POST") {
        const rec = await dbGet("SELECT * FROM onboarding_records WHERE portal_token = ?", [clean(query.token)]);
        if (!rec) { json(res, 404, { error: "This link isn't valid." }); return true; }
        const b = await readBody(req);
        const doc = await dbGet("SELECT * FROM onboarding_documents WHERE onboarding_id = ? AND doc_key = ?", [rec.id, clean(b.doc_key)]);
        if (!doc) { json(res, 404, { error: "Unknown item." }); return true; }
        await dbRun("UPDATE onboarding_documents SET status = 'received', received_at = ?, dates_source = 'not_applicable' WHERE id = ?", [nowISO(), doc.id]);
        const emp = await dbGet("SELECT id, name, role_title FROM hr_employees WHERE id = ?", [rec.employee_id]);
        const completion = await checkCompletion(rec, emp);
        json(res, 200, { ok: true, complete: !!completion.complete });
        return true;
      }

      // ---------------- staff side ----------------
      if (!user) { json(res, 401, { error: "Please sign in." }); return true; }
      if (!canManage(user)) { json(res, 403, { error: "Not permitted" }); return true; }

      const empMatch = pathname.match(/^\/api\/onboarding\/employee\/(\d+)$/);
      if (empMatch && method === "GET") {
        const rec = await dbGet("SELECT * FROM onboarding_records WHERE employee_id = ?", [Number(empMatch[1])]);
        if (!rec) { json(res, 200, { onboarding: null }); return true; }
        json(res, 200, {
          onboarding: { ...rec, portal_url: portalUrl(rec.portal_token) },
          documents: await docsFor(rec),
        });
        return true;
      }
      if (empMatch && method === "POST") {
        const emp = await dbGet("SELECT * FROM hr_employees WHERE id = ?", [Number(empMatch[1])]);
        if (!emp) { json(res, 404, { error: "Not found" }); return true; }
        const rec = await startOnboarding(emp, user.email);
        json(res, 201, { onboarding: { ...rec, portal_url: portalUrl(rec.portal_token) } });
        return true;
      }

      // Granting the extension the welcome email promises.
      const extendMatch = pathname.match(/^\/api\/onboarding\/(\d+)\/extend$/);
      if (extendMatch && method === "POST") {
        const b = await readBody(req);
        const days = Number(b.days || 0);
        if (!days || days < 1 || days > 30) { json(res, 400, { error: "Choose between 1 and 30 extra days." }); return true; }
        const rec = await dbGet("SELECT * FROM onboarding_records WHERE id = ?", [Number(extendMatch[1])]);
        if (!rec) { json(res, 404, { error: "Not found" }); return true; }
        const base = rec.deadline_at && new Date(rec.deadline_at) > new Date() ? new Date(rec.deadline_at) : new Date();
        const next = new Date(base.getTime() + days * 86400000).toISOString();
        await dbRun(
          `UPDATE onboarding_records SET deadline_at = ?, extension_note = ?, extended_by = ?,
             overdue_flagged_at = NULL, nudge_sent_at = NULL, status = 'awaiting_documents', updated_at = ?
           WHERE id = ?`,
          [next, clean(b.reason) || `Extended by ${days} day(s)`, user.email, nowISO(), rec.id]
        );
        json(res, 200, { ok: true, deadline_at: next });
        return true;
      }

      if (pathname === "/api/onboarding/sweep" && method === "POST") {
        json(res, 200, await deadlineSweep());
        return true;
      }

      json(res, 404, { error: "Not found" });
      return true;
    } catch (err) {
      console.error("onboarding.js error on", method, pathname, err);
      json(res, 500, { error: err.message || "Something went wrong." });
      return true;
    }
  }

  return {
    initTables, handleApi, startOnboarding, deadlineSweep, portalUrl,
    _lib: { DOCS, ATTESTATIONS, parseDatesFromText, roleKindFor },
  };
};
