// hire-packet.js -- the employment application and policy packet, as a form
// instead of a clipboard.
//
// The paper packet is fourteen pages: IRS Form 8850, a five-page employment
// application, the Mandatory Reporting Acknowledgment, the RBT Continuing
// Education Policy, and the Nevada Civil Name Check background waiver with its
// instruction sheet. This module hosts the parts that can honestly be retyped
// and hands over the parts that cannot.
//
// The line between those two is the whole design:
//
//   * Retyped: the application, the acknowledgement clauses, and the two
//     policies. These are Spectrum Squad's own documents. What the applicant
//     reads on screen is what goes in the PDF that lands in their file --
//     both are read out of hire-packet.html itself (hire-packet-content.js),
//     so the record cannot drift from the form.
//
//   * Handed over untouched: Form 8850 and the Nevada waiver. They are served
//     as the published PDFs, byte for byte, and come back as the applicant's
//     own signed copy. Nothing is pre-filled into them and nothing is stamped
//     onto them. The Nevada instruction sheet is explicit that the state
//     accepts a physical pen-to-paper signature and no other kind, so an
//     e-signature there would produce a rejected background check rather than
//     a completed one.
//
// It is keyed to an APPLICANT rather than to an employee, and the forms say so
// themselves: Form 8850 is a declaration that the information was given "on or
// before the day I was offered a job", and the Nevada waiver is granted "in
// consideration for processing my application for employment". Both are
// pre-offer documents.
//
// Two things this module deliberately never holds: the social security number,
// date of birth, race and physical description the Nevada form asks for, and
// the SSN on Form 8850. Those exist only inside the applicant's own uploaded
// file, which is stored off the public web root and reachable only through an
// authenticated download.
//
// Additive: new hire_packet_* tables, routes under /api/hire-packet/*, and a
// public page at /hire-packet. Reuses hr_applicants, hr_applicant_documents,
// the email plumbing and the completions feed that already exist.
"use strict";

const fs = require("fs");
const path = require("path");

module.exports = function initHirePacket(ctx) {
  const {
    dbGet, dbAll, dbRun, nowISO, crypto, readBody, json, sendFile,
    sendEmail, APP_BASE_URL,
  } = ctx;
  const onCompletion = ctx.onCompletion || (() => {});
  const getAppSetting = ctx.getAppSetting || (async (_k, d) => d);
  const renderTemplate = ctx.renderTemplate || null;
  const createStaffTask = ctx.createStaffTask || (async () => null);

  const clean = (v) => (v == null ? "" : String(v).trim());
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const DATA_DIR = path.join(__dirname, "data");
  const PACKET_DIR = path.join(DATA_DIR, "hire-packets");
  if (!fs.existsSync(PACKET_DIR)) fs.mkdirSync(PACKET_DIR, { recursive: true });

  const FORM_FILE = path.join(__dirname, "hire-packet.html");
  const BLANK_FORM_DIR = path.join(__dirname, "forms");

  // ======================= WHO CAN SEE WHAT ==================
  // Three tiers, mirroring hr.js so the packet cannot become the back door
  // into something the applicant record already protects.
  const HR_MANAGE_ROLES = ["owner", "admin", "super_admin", "hr_admin"];
  const HR_ACCESS_ROLES = HR_MANAGE_ROLES.concat(["hiring_manager", "interviewer"]);
  const HR_SENSITIVE_ROLES = ["owner", "super_admin"];
  const canSee = (u) => !!u && (HR_ACCESS_ROLES.includes(u.role) || (ctx.moduleGranted && ctx.moduleGranted(u, "hr")));
  const canManage = (u) => !!u && HR_MANAGE_ROLES.includes(u.role);
  const canSensitive = (u) => !!u && HR_SENSITIVE_ROLES.includes(u.role);

  // What somebody expects to be paid, and what they used to be paid, is
  // owner-only on the applicant record (hr.js hides comp_expectation from
  // everyone else). The application asks the same questions in its own words,
  // so the same rule is applied to the same facts rather than leaving a
  // second, softer copy of them on this screen.
  const PAY_FIELDS = /^(salary_desired|employer[1-4]_(starting|ending)_pay)$/;

  // ======================= SECTIONS ==========================
  // `upload: true` means the blank PDF goes out and the applicant's own signed
  // copy comes back. `sign: true` means it is completed and signed on screen.
  const SECTIONS = [
    { key: "application",         label: "Employment application",              sign: false, upload: false },
    { key: "acknowledgement",     label: "Acknowledgement",                     sign: true,  upload: false },
    { key: "mandatory_reporting", label: "Mandatory Reporting Acknowledgment",  sign: true,  upload: false },
    { key: "rbt_ce_policy",       label: "RBT Continuing Education Policy",     sign: true,  upload: false },
    { key: "form_8850",           label: "IRS Form 8850",                       sign: false, upload: true, file: "irs-form-8850.pdf" },
    { key: "background_waiver",   label: "Nevada background waiver",            sign: false, upload: true, file: "nv-civil-name-check.pdf" },
  ];
  const sectionSpec = (key) => SECTIONS.find((s) => s.key === key) || null;

  // The CE policy states its own scope: "Applies To: All Registered Behavior
  // Technicians employed by Spectrum Squad." So it is asked of RBTs -- and of
  // anyone applying to no recorded position at all, because a missing position
  // is not evidence that somebody is not an RBT, and the cost of asking a
  // non-RBT to read a training policy is far below the cost of an RBT never
  // signing it.
  function sectionsFor(position) {
    const keys = SECTIONS.map((s) => s.key);
    const text = `${clean(position && position.role_type)} ${clean(position && position.title)}`;
    const isRbt = /\brbt\b|registered behavior technician/i.test(text);
    const roleKnown = !!(position && clean(position.role_type));
    if (!isRbt && roleKnown) return keys.filter((k) => k !== "rbt_ce_policy");
    return keys;
  }

  // A packet stops when the application does. Same shape as the onboarding
  // portal closing on a former employee: the link is work keyed to a live
  // application, and chasing somebody for paperwork after they have been told
  // no is the thing nobody would ever do on purpose.
  const CLOSED_STAGES = ["not_selected", "withdrawn"];
  const PACKET_CLOSED =
    "This link is no longer active. If you think that's a mistake, reply to the email we sent you and we'll get it sorted.";
  const PACKET_UNKNOWN =
    "This link isn't valid. Check the link in your email, or reply to it and we'll send you a new one.";

  const applicationClosed = (a) => !a || CLOSED_STAGES.includes(clean(a.stage).toLowerCase());
  // Paused, not closed: the link still opens and anything already sent still
  // counts. Only the chasing stops.
  function chasingPaused(a) {
    if (!a) return true;
    if (a.do_not_contact === true) return true;
    if (a.automation_paused === true) return true;
    return clean(a.stage).toLowerCase() === "talent_pool";
  }

  const AUTO_SEND_STAGES = ["credentials_references", "offer_approval", "offer_sent"];
  const REMINDER_INTERVAL_HOURS = 24;
  const MAX_REMINDERS = 14;
  const MANUAL_RESEND_COOLDOWN_HOURS = 12;

  // ======================= SCHEMA ============================
  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS hire_packets (
      id SERIAL PRIMARY KEY,
      applicant_id INTEGER NOT NULL UNIQUE,
      token TEXT NOT NULL UNIQUE,
      sections TEXT NOT NULL DEFAULT '[]',
      answers TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'sent',
      sent_at TEXT,
      last_reminder_at TEXT,
      reminder_count INTEGER NOT NULL DEFAULT 0,
      last_manual_sent_at TEXT,
      last_manual_sent_by TEXT,
      manual_send_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      completed_at TEXT,
      document_id INTEGER,
      created_at TEXT,
      updated_at TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS hire_packet_sections (
      id SERIAL PRIMARY KEY,
      packet_id INTEGER NOT NULL,
      section_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'awaiting',   -- awaiting | signed | received
      typed_name TEXT,
      signature TEXT,                            -- data URL, drawn on screen
      sig_w INTEGER,
      sig_h INTEGER,
      initials TEXT,                             -- JSON: clause key -> initials
      stored_name TEXT,                          -- the applicant's signed upload
      filename TEXT,
      mime_type TEXT,
      size INTEGER,
      completed_at TEXT,
      UNIQUE (packet_id, section_key)
    )`);

    console.log("Hire packet schema ready.");
  }

  // ======================= RECORD ============================
  async function applicantWithPosition(applicantId) {
    return dbGet(
      `SELECT a.*, p.title AS position_title, p.role_type AS position_role_type
         FROM hr_applicants a
         LEFT JOIN hr_positions p ON p.id = a.position_id
        WHERE a.id = ?`,
      [applicantId]
    );
  }

  async function ensurePacket(applicant) {
    const existing = await dbGet("SELECT * FROM hire_packets WHERE applicant_id = ?", [applicant.id]);
    if (existing) return existing;
    const token = crypto.randomBytes(24).toString("hex");
    const sections = sectionsFor({ title: applicant.position_title, role_type: applicant.position_role_type });
    await dbRun(
      `INSERT INTO hire_packets (applicant_id, token, sections, answers, status, sent_at, created_at, updated_at)
       VALUES (?, ?, ?, '{}', 'sent', ?, ?, ?) ON CONFLICT (applicant_id) DO NOTHING`,
      [applicant.id, token, JSON.stringify(sections), nowISO(), nowISO(), nowISO()]
    );
    const row = await dbGet("SELECT * FROM hire_packets WHERE applicant_id = ?", [applicant.id]);
    if (row) {
      for (const key of sections) {
        await dbRun(
          `INSERT INTO hire_packet_sections (packet_id, section_key, status)
           VALUES (?, ?, 'awaiting') ON CONFLICT (packet_id, section_key) DO NOTHING`,
          [row.id, key]
        );
      }
    }
    return row;
  }

  const packetSections = (packet) => {
    try {
      const parsed = JSON.parse(packet.sections || "[]");
      return Array.isArray(parsed) && parsed.length ? parsed : SECTIONS.map((s) => s.key);
    } catch (e) { return SECTIONS.map((s) => s.key); }
  };
  const packetAnswers = (packet) => {
    try { const p = JSON.parse(packet.answers || "{}"); return p && typeof p === "object" ? p : {}; }
    catch (e) { return {}; }
  };

  function portalUrl(token) { return `${APP_BASE_URL}/hire-packet?token=${encodeURIComponent(token)}`; }

  // ======================= EMAIL =============================
  function emailShell(inner) {
    return `<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:520px;margin:0 auto;color:#241d52;">
      <div style="background:#1b2a6b;color:#fff;padding:20px 24px;border-radius:14px 14px 0 0;">
        <div style="font-size:20px;font-weight:800;">Spectrum Squad 🌈</div>
      </div>
      <div style="background:#ffffff;border:1px solid #e7e5f2;border-top:none;padding:24px;border-radius:0 0 14px 14px;line-height:1.6;">
        ${inner}
      </div>
      <p style="text-align:center;color:#7a7796;font-size:12px;margin:14px 0;">Spectrum Squad · Las Vegas, NV</p>
    </div>`;
  }
  function ctaButton(link, label) {
    return `<p style="text-align:center;margin:26px 0;">
      <a href="${link}" style="background:#e0a430;color:#3a2c05;text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:12px;display:inline-block;">${label}</a>
    </p>
    <p style="font-size:12px;color:#7a7796;">Or paste this link into your browser:<br>${link}</p>`;
  }
  const firstNameOf = (full) => clean(full).split(/\s+/)[0] || "there";

  async function sendPacketEmail(applicant, token, isReminder) {
    const link = portalUrl(token);
    const key = isReminder ? "hire_packet_reminder" : "hire_packet_invite";
    const fields = {
      applicant_name: clean(applicant.full_name),
      first_name: firstNameOf(applicant.full_name),
      position: clean(applicant.position_title) || "the role you applied for",
      packet_link: link,
    };

    let subject = null, html = null;
    if (renderTemplate) {
      const tpl = await renderTemplate(key, fields).catch(() => null);
      if (tpl && tpl.html) { subject = tpl.subject; html = tpl.html; }
    }
    if (html == null) {
      // Deliberately noisy: a missing template is a configuration problem, not
      // a reason for an applicant to go without their paperwork.
      console.error(`[hire-packet] no ${key} template -- falling back to the built-in wording`);
      subject = isReminder
        ? "Reminder: your Spectrum Squad paperwork"
        : "Your Spectrum Squad application packet 🌈";
      const intro = isReminder
        ? `<p>Hi ${esc(fields.first_name)},</p><p>Just a friendly nudge — we still need your application packet. It saves as you go, so you can do it in a couple of sittings.</p>`
        : `<p>Hi ${esc(fields.first_name)},</p><p>Great news — we'd like to move forward with you for <strong>${esc(fields.position)}</strong>.</p>
           <p>Here is the paperwork. Most of it you can do right on your phone; two of the forms are government forms you'll download, print and sign by hand. It takes about 20 minutes and it remembers where you left off.</p>`;
      html = emailShell(intro + ctaButton(link, "Open my packet →"));
    }
    if (!String(html).includes(link)) {
      console.error(`[hire-packet] the ${key} template has no {{packet_link}} in it -- appending the link so the email still works`);
      html += ctaButton(link, "Open my packet →");
    }
    await sendEmail({
      to: applicant.email,
      subject: subject || "Your Spectrum Squad application packet",
      html,
      type: isReminder ? "hire_packet_reminder" : "hire_packet_invite",
    });
  }

  // ======================= SWEEP =============================
  async function sweep() {
    const autoOn = clean(await getAppSetting("hire_packet_auto", "on").catch(() => "on")) !== "off";

    if (autoOn) {
      // Form 8850 has to be in hand on or before the day a job is offered --
      // that is the declaration the applicant signs on it -- so the packet
      // goes out at the decision stages rather than at the offer itself.
      const placeholders = AUTO_SEND_STAGES.map(() => "?").join(", ");
      const candidates = await dbAll(
        `SELECT a.*, p.title AS position_title, p.role_type AS position_role_type
           FROM hr_applicants a
           LEFT JOIN hr_positions p ON p.id = a.position_id
          WHERE a.stage IN (${placeholders})
            AND a.email IS NOT NULL AND a.email <> ''
            AND NOT EXISTS (SELECT 1 FROM hire_packets hp WHERE hp.applicant_id = a.id)`,
        AUTO_SEND_STAGES
      ).catch((e) => { console.error("[hire-packet] candidate query failed:", e.message); return []; });

      for (const applicant of candidates.filter((a) => !chasingPaused(a) && !applicationClosed(a))) {
        try {
          const packet = await ensurePacket(applicant);
          if (packet) await sendPacketEmail(applicant, packet.token, false);
        } catch (e) {
          console.error("[hire-packet] send failed for applicant", applicant.id, e.message);
        }
      }
    }

    const pending = await dbAll("SELECT * FROM hire_packets WHERE status <> 'completed'");
    const now = Date.now();
    for (const packet of pending) {
      const applicant = await applicantWithPosition(packet.applicant_id);
      if (!applicant) continue;
      if (applicationClosed(applicant)) continue;
      if (chasingPaused(applicant)) continue;
      if (!clean(applicant.email)) continue;
      if (Number(packet.reminder_count || 0) >= MAX_REMINDERS) continue;
      const lastAt = packet.last_reminder_at || packet.last_manual_sent_at || packet.sent_at;
      const hours = lastAt ? (now - new Date(lastAt).getTime()) / 3600000 : Infinity;
      if (hours < REMINDER_INTERVAL_HOURS) continue;
      try {
        await sendPacketEmail(applicant, packet.token, true);
        await dbRun(
          "UPDATE hire_packets SET last_reminder_at = ?, reminder_count = reminder_count + 1, updated_at = ? WHERE id = ?",
          [nowISO(), nowISO(), packet.id]
        );
      } catch (e) {
        console.error("[hire-packet] reminder failed for applicant", applicant.id, e.message);
      }
    }
  }

  // ======================= THE PACKET DOCUMENT ===============
  function decodeSignature(sig) {
    if (!sig) return null;
    let b64 = String(sig);
    const comma = b64.indexOf(",");
    if (b64.startsWith("data:") && comma >= 0) b64 = b64.slice(comma + 1);
    try {
      const buf = Buffer.from(b64, "base64");
      return buf.length < 100 ? null : buf;
    } catch (e) { return null; }
  }

  // The personnel-file copy. Everything on it -- the questions, the clauses,
  // the policy wording -- is read out of the form the applicant filled in, so
  // the document says what they actually saw.
  function buildPacketPdf(applicant, packet, sections, opts) {
    const { buildPdf } = require("./pdf-doc");
    const content = require("./hire-packet-content");
    const questions = content.packetQuestions();
    const clauses = content.packetClauses();
    const answers = packetAnswers(packet);
    const includePay = !!(opts && opts.includePay);
    const blocks = [];
    const byKey = {};
    for (const row of sections) byKey[row.section_key] = row;

    const shown = (v) => (Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v));

    const signatureBlock = (row, nameLabel) => {
      if (!row || row.status !== "signed") {
        blocks.push({ type: "text", text: "Not signed." });
        return;
      }
      const jpeg = decodeSignature(row.signature);
      if (jpeg) blocks.push({ type: "image", jpeg, w: row.sig_w || 500, h: row.sig_h || 160, width: 220 });
      blocks.push({ type: "row", label: nameLabel || "Signed by", value: clean(row.typed_name) });
      blocks.push({ type: "row", label: "Signed (UTC)", value: clean(row.completed_at) });
    };

    // --- the application, in the order the questions are asked on screen ---
    if (byKey.application || Object.keys(answers).length) {
      blocks.push({ type: "heading", text: "Employment application" });
      let withheld = 0;
      for (const key of Object.keys(questions)) {
        if (!(key in answers)) continue;
        if (PAY_FIELDS.test(key) && !includePay) { if (shown(answers[key]).trim()) withheld++; continue; }
        const value = shown(answers[key]);
        if (!value.trim()) continue;
        blocks.push({ type: "row", label: questions[key], value });
      }
      if (withheld) {
        blocks.push({ type: "space", size: 6 });
        blocks.push({ type: "text", text: `${withheld} pay-related answer${withheld === 1 ? "" : "s"} withheld from this copy. Pay expectations are owner-only, the same as on the applicant record.` });
      }
    }

    // --- the acknowledgement, clause by clause with the initials ---
    const ack = byKey.acknowledgement;
    if (ack) {
      blocks.push({ type: "space", size: 10 });
      blocks.push({ type: "heading", text: "Acknowledgement" });
      let stamped = {};
      try { stamped = JSON.parse(ack.initials || "{}") || {}; } catch (e) { stamped = {}; }
      for (const key of Object.keys(clauses)) {
        blocks.push({ type: "row", label: `[${clean(stamped[key]) || "not initialled"}]`, value: clauses[key] });
      }
      blocks.push({ type: "space", size: 6 });
      signatureBlock(ack, "Applicant's signature");
    }

    // --- the policies, with the wording that was on screen that day ---
    const policyOrder = [
      { key: "mandatory_reporting", pane: "reporting", title: "Mandatory Reporting Acknowledgment", nameLabel: "Staff name" },
      { key: "rbt_ce_policy", pane: "ce", title: "RBT Continuing Education Policy", nameLabel: "Employee full name" },
    ];
    for (const p of policyOrder) {
      const row = byKey[p.key];
      if (!row) continue;
      blocks.push({ type: "space", size: 10 });
      blocks.push({ type: "heading", text: p.title });
      for (const part of content.packetPolicy(p.pane)) {
        if (part.kind === "heading") blocks.push({ type: "heading", text: part.text });
        else blocks.push({ type: "text", text: part.kind === "bullet" ? `- ${part.text}` : part.text });
      }
      blocks.push({ type: "space", size: 6 });
      signatureBlock(row, p.nameLabel);
    }

    // --- the two forms that were handed over untouched ---
    const handed = SECTIONS.filter((s) => s.upload && byKey[s.key]);
    if (handed.length) {
      blocks.push({ type: "space", size: 10 });
      blocks.push({ type: "heading", text: "Forms signed on paper" });
      blocks.push({ type: "text", text: "These were sent to the applicant as the published PDFs, unaltered, and returned as their own signed copies. They are filed separately and are not reproduced here." });
      for (const spec of handed) {
        const row = byKey[spec.key];
        blocks.push({
          type: "row",
          label: spec.label,
          value: row.status === "received"
            ? `Received ${clean(row.completed_at)} — ${clean(row.filename) || "file on record"}`
            : "Not received",
        });
      }
    }

    return buildPdf({
      title: "Employment Application & Onboarding Packet",
      subtitle: `${clean(applicant.full_name)}${applicant.position_title ? ` — ${clean(applicant.position_title)}` : ""}   ·   Spectrum Squad LLC`,
      footer: `${clean(applicant.full_name)} · packet completed ${clean(packet.completed_at) || "in progress"}`,
      blocks,
    });
  }

  async function sectionRows(packetId) {
    return dbAll("SELECT * FROM hire_packet_sections WHERE packet_id = ? ORDER BY id", [packetId]);
  }

  // ======================= COMPLETION ========================
  // The application has no button of its own -- it saves as it is typed -- so
  // "done" for it is that there is an application there at all. A packet of
  // signatures attached to an empty form is not a completed application, and
  // it would be filed as one.
  function applicationStarted(packet) {
    const a = packetAnswers(packet);
    return !!(clean(a.name_first) || clean(a.name_last));
  }

  async function isComplete(packet) {
    if (!applicationStarted(packet)) return false;
    const rows = await sectionRows(packet.id);
    const needed = packetSections(packet);
    for (const key of needed) {
      const spec = sectionSpec(key);
      if (!spec || (!spec.sign && !spec.upload)) continue;
      const row = rows.find((r) => r.section_key === key);
      if (!row || row.status === "awaiting") return false;
    }
    return true;
  }

  async function finishPacket(packet, applicant) {
    const rows = await sectionRows(packet.id);
    // The owner's copy. The PDF filed against the applicant is the full one --
    // it is the record -- and the pay-withholding rule is applied when a
    // non-owner asks for a copy, not when the record itself is made.
    const pdf = buildPacketPdf(applicant, packet, rows, { includePay: true });
    const storedName = `packet_${packet.id}_${crypto.randomBytes(6).toString("hex")}.pdf`;
    fs.writeFileSync(path.join(PACKET_DIR, storedName), pdf);

    const filename = `Application packet - ${clean(applicant.full_name) || "applicant"}.pdf`;
    let documentId = null;
    try {
      const ins = await dbRun(
        `INSERT INTO hr_applicant_documents (applicant_id, kind, filename, mime_type, stored_name, size, uploaded_by, uploaded_at)
         VALUES (?, 'application_packet', ?, 'application/pdf', ?, ?, 'hire packet', ?) RETURNING id`,
        [applicant.id, filename, storedName, pdf.length, nowISO()]
      );
      documentId = ins && ins.rows && ins.rows[0] ? ins.rows[0].id : null;
    } catch (e) {
      // The packet is complete either way. Losing the filing is a problem for
      // whoever looks for the document later, not a reason to tell somebody
      // who has just finished twenty minutes of paperwork that it failed.
      console.error("[hire-packet] could not file the packet document:", e.message);
    }

    await dbRun(
      "UPDATE hire_packets SET status = 'completed', completed_at = ?, document_id = ?, updated_at = ? WHERE id = ?",
      [nowISO(), documentId, nowISO(), packet.id]
    );

    onCompletion("hire_packet_completed", {
      subject: clean(applicant.full_name),
      dedupeKey: `hire_packet:${packet.id}`,
      link: `${APP_BASE_URL}/#/hr/applicants/${applicant.id}`,
    });

    notifyTeam(applicant, packet, rows).catch((e) => console.error("[hire-packet] team notify failed:", e.message));
    createStaffTask({
      title: `Application packet completed — ${clean(applicant.full_name)}`,
      description:
        `${clean(applicant.full_name)} has finished their application packet.\n\n`
        + `The signed Form 8850 and the signed Nevada background waiver are on the applicant record and still need to go out: `
        + `Form 8850 to the state workforce agency, and the waiver to AccuSearch for the name check.`,
      created_by: "hire packet",
      priority: "high",
    }).catch((e) => console.error("[hire-packet] could not raise the follow-up task:", e.message));

    return documentId;
  }

  async function notifyTeam(applicant, packet, rows) {
    const to = clean(await getAppSetting("hire_packet_recipient", "").catch(() => ""))
      || clean(process.env.HR_TEAM_EMAIL || "")
      || clean(await getAppSetting("hr_notification_email", "").catch(() => ""));
    if (!to) {
      console.error("[hire-packet] no recipient configured -- nobody was told the packet is finished");
      return;
    }
    const list = rows.map((r) => {
      const spec = sectionSpec(r.section_key);
      const label = spec ? spec.label : r.section_key;
      const state = r.status === "awaiting" ? "outstanding" : (r.status === "received" ? "signed on paper, returned" : "signed on screen");
      return `<li><strong>${esc(label)}</strong> — ${esc(state)}</li>`;
    }).join("");
    const html = emailShell(
      `<p><strong>${esc(clean(applicant.full_name))}</strong> has completed their application packet. ✅</p>
       <p><a href="${APP_BASE_URL}/#/hr/applicants/${applicant.id}">Open the applicant in the CRM →</a></p>
       <ul style="font-size:14px;">${list}</ul>
       <p style="font-size:13px;color:#7a7796;">The signed Form 8850 and Nevada waiver are stored on the applicant record. They still need sending on.</p>`
    );
    for (const addr of to.split(/[;,]/).map((s) => s.trim()).filter(Boolean)) {
      await sendEmail({ to: addr, subject: `✅ Application packet completed — ${clean(applicant.full_name)}`, html, type: "hire_packet_completed" });
    }
  }

  // ======================= PUBLIC GUARD ======================
  // Every public route goes through this. One lookup, one check, so a route
  // added later cannot forget to ask who the token belongs to.
  async function openPacket(token) {
    const packet = await dbGet("SELECT * FROM hire_packets WHERE token = ?", [clean(token)]);
    if (!packet) return { error: { code: 404, message: PACKET_UNKNOWN } };
    const applicant = await applicantWithPosition(packet.applicant_id);
    if (applicationClosed(applicant)) return { error: { code: 403, message: PACKET_CLOSED } };
    return { packet, applicant };
  }

  // ======================= ROUTES ============================
  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/hire-packet/")) return false;

    // ---------------- public (the applicant, not signed in) -------------
    if (pathname.startsWith("/api/hire-packet/public/")) {
      const opened = await openPacket(query.token);
      if (opened.error) { json(res, opened.error.code, { error: opened.error.message }); return true; }
      const { packet, applicant } = opened;

      if (pathname === "/api/hire-packet/public/state" && method === "GET") {
        const rows = await sectionRows(packet.id);
        json(res, 200, {
          sections: packetSections(packet),
          answers: packetAnswers(packet),
          completed: rows.filter((r) => r.status !== "awaiting").map((r) => r.section_key),
          uploads: rows
            .filter((r) => r.status === "received")
            .map((r) => ({ key: r.section_key, filename: r.filename })),
          status: packet.status,
          // The name and the role only, so the page can greet somebody
          // properly. Nothing else about an applicant belongs on a page whose
          // only key is a link in an email.
          applicant: { name: clean(applicant.full_name), position: clean(applicant.position_title) },
        });
        return true;
      }

      // Saved as they type. The packet runs to a dozen screens and people fill
      // it in on a phone; losing it to a dropped connection would mean typing
      // four employers in again.
      if (pathname === "/api/hire-packet/public/save" && method === "POST") {
        let body;
        try { body = await readBody(req); } catch (e) { json(res, 400, { error: "Bad request" }); return true; }
        const answers = body && body.answers;
        if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
          json(res, 400, { error: "Nothing to save." });
          return true;
        }
        // A finished packet is a record. It stops taking edits, or the PDF in
        // the personnel file stops matching what was signed.
        if (packet.status === "completed") { json(res, 409, { error: "This packet is already completed." }); return true; }
        const kept = {};
        for (const key of Object.keys(answers)) {
          if (!/^[a-z0-9_]{1,60}$/.test(key)) continue;
          const v = answers[key];
          if (typeof v !== "string") continue;
          kept[key] = v.slice(0, 4000);
        }
        await dbRun(
          "UPDATE hire_packets SET answers = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?",
          [JSON.stringify(kept), nowISO(), nowISO(), packet.id]
        );
        json(res, 200, { ok: true, saved: Object.keys(kept).length });
        return true;
      }

      if (pathname === "/api/hire-packet/public/sign" && method === "POST") {
        let body;
        try { body = await readBody(req); } catch (e) { json(res, 400, { error: "Bad request" }); return true; }
        const key = clean(body && body.section);
        const spec = sectionSpec(key);
        if (!spec || !spec.sign) { json(res, 400, { error: "That isn't a form you sign here." }); return true; }
        if (packetSections(packet).indexOf(key) < 0) { json(res, 400, { error: "That form isn't part of your packet." }); return true; }
        if (packet.status === "completed") { json(res, 409, { error: "This packet is already completed." }); return true; }

        const typedName = clean(body.typed_name).slice(0, 160);
        if (!typedName) { json(res, 400, { error: "Please type your full name." }); return true; }
        const sig = decodeSignature(body.signature);
        if (!sig) { json(res, 400, { error: "Please sign in the box." }); return true; }

        // Every clause, or none. A half-initialled acknowledgement is not a
        // weaker acknowledgement, it is an unsigned one.
        let initialsJson = null;
        if (key === "acknowledgement") {
          const clauses = require("./hire-packet-content").packetClauses();
          const given = (body.initials && typeof body.initials === "object") ? body.initials : {};
          const missing = Object.keys(clauses).filter((c) => !clean(given[c]));
          if (missing.length) {
            json(res, 400, { error: `Please initial every paragraph — ${missing.length} still to go.` });
            return true;
          }
          const kept = {};
          for (const c of Object.keys(clauses)) kept[c] = clean(given[c]).slice(0, 8);
          initialsJson = JSON.stringify(kept);
        }

        await dbRun(
          `INSERT INTO hire_packet_sections (packet_id, section_key, status, typed_name, signature, sig_w, sig_h, initials, completed_at)
           VALUES (?, ?, 'signed', ?, ?, ?, ?, ?, ?)
           ON CONFLICT (packet_id, section_key) DO UPDATE SET
             status = 'signed', typed_name = EXCLUDED.typed_name, signature = EXCLUDED.signature,
             sig_w = EXCLUDED.sig_w, sig_h = EXCLUDED.sig_h, initials = EXCLUDED.initials,
             completed_at = EXCLUDED.completed_at`,
          [packet.id, key, typedName, String(body.signature).slice(0, 400000),
           Number(body.sig_w) || null, Number(body.sig_h) || null, initialsJson, nowISO()]
        );
        await dbRun("UPDATE hire_packets SET status = CASE WHEN status = 'sent' THEN 'in_progress' ELSE status END, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?",
          [nowISO(), nowISO(), packet.id]);
        json(res, 200, { ok: true, section: key });
        return true;
      }

      // The blank form, exactly as it was published. Served from disk with no
      // pass through any generator, because "unaltered" has to mean the bytes.
      if (pathname === "/api/hire-packet/public/form" && method === "GET") {
        const spec = sectionSpec(clean(query.key));
        if (!spec || !spec.upload || !spec.file) { json(res, 404, { error: "That form isn't part of this packet." }); return true; }
        if (packetSections(packet).indexOf(spec.key) < 0) { json(res, 404, { error: "That form isn't part of your packet." }); return true; }
        const full = path.join(BLANK_FORM_DIR, spec.file);
        if (!fs.existsSync(full)) { json(res, 500, { error: "That form is temporarily unavailable. Please let us know." }); return true; }
        sendFile(res, 200, fs.readFileSync(full), "application/pdf", spec.file);
        return true;
      }

      if (pathname === "/api/hire-packet/public/upload" && method === "POST") {
        const spec = sectionSpec(clean(query.key));
        if (!spec || !spec.upload) { json(res, 404, { error: "That isn't one of the forms we asked for." }); return true; }
        if (packetSections(packet).indexOf(spec.key) < 0) { json(res, 404, { error: "That form isn't part of your packet." }); return true; }
        if (packet.status === "completed") { json(res, 409, { error: "This packet is already completed." }); return true; }

        const chunks = [];
        let size = 0;
        const MAX = 15 * 1024 * 1024;
        const tooBig = await new Promise((resolve) => {
          req.on("data", (c) => { size += c.length; if (size > MAX) { resolve(true); req.destroy(); } else chunks.push(c); });
          req.on("end", () => resolve(false));
          req.on("error", () => resolve(true));
        });
        if (tooBig) { json(res, 413, { error: "That file is larger than 15 MB. A photo or a PDF of the signed page is plenty." }); return true; }
        const buffer = Buffer.concat(chunks);
        if (!buffer.length) { json(res, 400, { error: "That upload came through empty — please try again." }); return true; }

        const filename = clean(query.filename).slice(0, 160) || "signed-form";
        const mime = clean(query.mime) || "application/octet-stream";
        const ext = path.extname(filename).slice(0, 8);
        const storedName = `hp_${packet.id}_${spec.key}_${Date.now()}${ext}`;
        fs.writeFileSync(path.join(PACKET_DIR, storedName), buffer);

        await dbRun(
          `INSERT INTO hire_packet_sections (packet_id, section_key, status, stored_name, filename, mime_type, size, completed_at)
           VALUES (?, ?, 'received', ?, ?, ?, ?, ?)
           ON CONFLICT (packet_id, section_key) DO UPDATE SET
             status = 'received', stored_name = EXCLUDED.stored_name, filename = EXCLUDED.filename,
             mime_type = EXCLUDED.mime_type, size = EXCLUDED.size, completed_at = EXCLUDED.completed_at`,
          [packet.id, spec.key, storedName, filename, mime, buffer.length, nowISO()]
        );
        await dbRun("UPDATE hire_packets SET status = CASE WHEN status = 'sent' THEN 'in_progress' ELSE status END, updated_at = ? WHERE id = ?",
          [nowISO(), packet.id]);
        json(res, 200, { ok: true, message: "Received, thank you." });
        return true;
      }

      if (pathname === "/api/hire-packet/public/complete" && method === "POST") {
        if (packet.status === "completed") { json(res, 200, { ok: true, already: true }); return true; }
        if (!applicationStarted(packet)) {
          json(res, 400, { error: "The application itself is still blank — please go back and fill in your name to start with." });
          return true;
        }
        const ready = await isComplete(packet);
        if (!ready) { json(res, 400, { error: "There's still something outstanding — go back and check for a step that isn't ticked off." }); return true; }
        await finishPacket(packet, applicant);
        json(res, 200, { ok: true });
        return true;
      }

      json(res, 404, { error: "Not found" });
      return true;
    }

    // ---------------- staff (signed in) ----------------------------------
    if (!user) { json(res, 401, { error: "Not authenticated" }); return true; }

    const statusMatch = pathname.match(/^\/api\/hire-packet\/status\/(\d+)$/);
    if (statusMatch && method === "GET") {
      if (!canSee(user)) { json(res, 403, { error: "Not permitted" }); return true; }
      const st = await packetStatus(Number(statusMatch[1]));
      if (!st) { json(res, 404, { error: "Applicant not found" }); return true; }
      json(res, 200, st);
      return true;
    }

    const sendMatch = pathname.match(/^\/api\/hire-packet\/send\/(\d+)$/);
    if (sendMatch && method === "POST") {
      if (!canManage(user)) { json(res, 403, { error: "Not permitted to send the application packet." }); return true; }
      let body = {};
      try { body = (await readBody(req)) || {}; } catch (e) { body = {}; }
      const actor = clean(user.email || user.name) || "staff";
      const r = await sendManual(Number(sendMatch[1]), actor, body.force === true);
      if (!r.ok) { json(res, r.status || 400, { error: r.error, code: r.code || null, last_sent_at: r.last_sent_at || null }); return true; }
      console.log(`[hire-packet] sent for applicant ${sendMatch[1]} by ${actor}`);
      json(res, 200, { ok: true, sent_to: r.sent_to, sent_at: r.sent_at, resend: r.resend });
      return true;
    }

    // The answers. Pay expectations are stripped for everybody but the owner,
    // because the applicant record already treats them that way and a second
    // copy of a fact is not a different fact.
    const answersMatch = pathname.match(/^\/api\/hire-packet\/answers\/(\d+)$/);
    if (answersMatch && method === "GET") {
      if (!canManage(user)) { json(res, 403, { error: "Not permitted" }); return true; }
      const applicant = await applicantWithPosition(Number(answersMatch[1]));
      if (!applicant) { json(res, 404, { error: "Applicant not found" }); return true; }
      const packet = await dbGet("SELECT * FROM hire_packets WHERE applicant_id = ?", [applicant.id]);
      if (!packet) { json(res, 404, { error: "No packet has been sent to this applicant yet." }); return true; }
      const questions = require("./hire-packet-content").packetQuestions();
      const answers = packetAnswers(packet);
      const out = [];
      let withheld = 0;
      for (const key of Object.keys(questions)) {
        if (!(key in answers)) continue;
        const value = Array.isArray(answers[key]) ? answers[key].join(", ") : String(answers[key] == null ? "" : answers[key]);
        if (!value.trim()) continue;
        if (PAY_FIELDS.test(key) && !canSensitive(user)) { withheld++; continue; }
        out.push({ key, question: questions[key], answer: value });
      }
      json(res, 200, { applicant_id: applicant.id, answers: out, pay_answers_withheld: withheld });
      return true;
    }

    const pdfMatch = pathname.match(/^\/api\/hire-packet\/pdf\/(\d+)$/);
    if (pdfMatch && method === "GET") {
      if (!canManage(user)) { json(res, 403, { error: "Not permitted" }); return true; }
      const applicant = await applicantWithPosition(Number(pdfMatch[1]));
      if (!applicant) { json(res, 404, { error: "Applicant not found" }); return true; }
      const packet = await dbGet("SELECT * FROM hire_packets WHERE applicant_id = ?", [applicant.id]);
      if (!packet) { json(res, 404, { error: "No packet has been sent to this applicant yet." }); return true; }
      const rows = await sectionRows(packet.id);
      const pdf = buildPacketPdf(applicant, packet, rows, { includePay: canSensitive(user) });
      sendFile(res, 200, pdf, "application/pdf", `Application packet - ${clean(applicant.full_name) || "applicant"}.pdf`);
      return true;
    }

    // The signed government forms. These carry a social security number and,
    // on the Nevada waiver, a date of birth, race and physical description --
    // so they sit behind the HR-manage tier rather than being visible to
    // every interviewer who can open the applicant.
    const fileMatch = pathname.match(/^\/api\/hire-packet\/file\/(\d+)\/([a-z0-9_]+)$/);
    if (fileMatch && method === "GET") {
      if (!canManage(user)) { json(res, 403, { error: "Not permitted" }); return true; }
      const packet = await dbGet("SELECT * FROM hire_packets WHERE applicant_id = ?", [Number(fileMatch[1])]);
      if (!packet) { json(res, 404, { error: "No packet on file" }); return true; }
      const row = await dbGet("SELECT * FROM hire_packet_sections WHERE packet_id = ? AND section_key = ?", [packet.id, fileMatch[2]]);
      if (!row || row.status !== "received" || !row.stored_name) { json(res, 404, { error: "That form hasn't come back yet." }); return true; }
      const full = path.join(PACKET_DIR, row.stored_name);
      if (!fs.existsSync(full)) { json(res, 404, { error: "File missing" }); return true; }
      sendFile(res, 200, fs.readFileSync(full), row.mime_type || "application/octet-stream", row.filename || "signed-form");
      return true;
    }

    if (pathname === "/api/hire-packet/sweep" && method === "POST") {
      if (!canManage(user)) { json(res, 403, { error: "Not permitted" }); return true; }
      await sweep();
      json(res, 200, { ok: true });
      return true;
    }

    return false;
  }

  // ======================= STAFF HELPERS =====================
  async function packetStatus(applicantId) {
    const applicant = await applicantWithPosition(applicantId);
    if (!applicant) return null;
    const packet = await dbGet("SELECT * FROM hire_packets WHERE applicant_id = ?", [applicantId]);
    const rows = packet ? await sectionRows(packet.id) : [];
    const lastSentAt = packet ? (packet.last_manual_sent_at || packet.last_reminder_at || packet.sent_at) : null;
    const hoursSince = lastSentAt ? (Date.now() - new Date(lastSentAt).getTime()) / 3600000 : null;

    // Why has it not gone out on its own? Said plainly, rather than left for
    // somebody to work out from an empty screen.
    let autoBlockedReason = null;
    if (!clean(applicant.email)) autoBlockedReason = "No email address is on file for this applicant.";
    else if (applicationClosed(applicant)) autoBlockedReason = `This application is marked "${clean(applicant.stage)}", so the packet link is closed.`;
    else if (chasingPaused(applicant)) autoBlockedReason = "Automatic sending is paused for this applicant. You can still send it by hand.";
    else if (!packet && AUTO_SEND_STAGES.indexOf(clean(applicant.stage)) < 0) {
      autoBlockedReason = `The packet sends automatically once an applicant reaches Credentials & References. This one is at "${clean(applicant.stage) || "no stage"}".`;
    }

    return {
      applicant_id: Number(applicantId),
      has_email: !!clean(applicant.email),
      email: clean(applicant.email) || null,
      sent: !!packet,
      status: packet ? packet.status : null,
      sections: packet ? packetSections(packet) : sectionsFor({ title: applicant.position_title, role_type: applicant.position_role_type }),
      progress: (packet ? packetSections(packet) : []).map((key) => {
        const spec = sectionSpec(key);
        const row = rows.find((r) => r.section_key === key);
        return {
          key,
          label: spec ? spec.label : key,
          signed_on_paper: !!(spec && spec.upload),
          status: row ? row.status : (spec && !spec.sign && !spec.upload ? "n/a" : "awaiting"),
          completed_at: row ? row.completed_at : null,
          filename: row ? row.filename : null,
        };
      }),
      first_sent_at: packet ? packet.sent_at : null,
      last_sent_at: lastSentAt,
      last_manual_sent_by: packet ? packet.last_manual_sent_by || null : null,
      manual_send_count: packet ? Number(packet.manual_send_count || 0) : 0,
      reminder_count: packet ? Number(packet.reminder_count || 0) : 0,
      completed_at: packet ? packet.completed_at : null,
      document_id: packet ? packet.document_id : null,
      auto_blocked_reason: autoBlockedReason,
      resend_cooldown_hours: MANUAL_RESEND_COOLDOWN_HOURS,
      recently_sent: hoursSince != null && hoursSince < MANUAL_RESEND_COOLDOWN_HOURS,
    };
  }

  // force=false is the accident guard: a second press inside the cooldown, or
  // a press on a finished packet, comes back as a question rather than as a
  // duplicate email. force=true is the deliberate resend.
  async function sendManual(applicantId, actor, force) {
    const applicant = await applicantWithPosition(applicantId);
    if (!applicant) return { ok: false, status: 404, error: "Applicant not found." };
    if (!clean(applicant.email)) return { ok: false, status: 400, error: "This applicant has no email address on file, so the packet can't be sent." };
    if (applicationClosed(applicant)) {
      return { ok: false, status: 400, error: `This application is marked "${clean(applicant.stage)}". Move it back into the pipeline first if they are still being considered.` };
    }
    const existing = await dbGet("SELECT * FROM hire_packets WHERE applicant_id = ?", [applicantId]);
    if (existing && existing.status === "completed" && !force) {
      return { ok: false, status: 409, code: "already_completed", error: "This applicant has already completed their packet. Send it again anyway?" };
    }
    if (existing && !force) {
      const lastAt = existing.last_manual_sent_at || existing.last_reminder_at || existing.sent_at;
      const hours = lastAt ? (Date.now() - new Date(lastAt).getTime()) / 3600000 : Infinity;
      if (hours < MANUAL_RESEND_COOLDOWN_HOURS) {
        return {
          ok: false, status: 409, code: "recently_sent",
          error: `The packet was sent to this applicant ${hours < 1 ? "less than an hour" : Math.floor(hours) + " hours"} ago. Send it again anyway?`,
          last_sent_at: lastAt,
        };
      }
    }

    // Same token if one exists -- a hand-sent packet is the SAME packet, so
    // nobody ends up with two links and anything already filled in still counts.
    const packet = await ensurePacket(applicant);
    if (!packet) return { ok: false, status: 500, error: "Could not create the packet." };
    await sendPacketEmail(applicant, packet.token, !!existing);
    await dbRun(
      `UPDATE hire_packets SET last_manual_sent_at = ?, last_manual_sent_by = ?,
         manual_send_count = COALESCE(manual_send_count, 0) + 1, updated_at = ? WHERE id = ?`,
      [nowISO(), actor || "staff", nowISO(), packet.id]
    );
    return { ok: true, status: 200, sent_to: applicant.email, sent_at: nowISO(), resend: !!existing };
  }

  // ======================= PAGE ==============================
  // The token stays in the query string rather than the path, so it does not
  // travel in a referrer header when the page loads a font.
  async function servePage(req, res, pathname) {
    if (pathname !== "/hire-packet" && pathname !== "/hire-packet/") return false;
    let html;
    try { html = fs.readFileSync(FORM_FILE, "utf8"); }
    catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("The application packet is temporarily unavailable.");
      return true;
    }
    html = html
      .replace('var API_BASE = "";', 'var API_BASE = "/api/hire-packet";')
      .replace(
        'var PACKET_TOKEN = "";',
        'var PACKET_TOKEN = (function(){var m=/[?&]token=([^&#]+)/.exec(document.location.search);return m?decodeURIComponent(m[1]):"";})();'
      );
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "no-referrer" });
    res.end(html);
    return true;
  }

  return {
    initTables, handleApi, servePage, sweep,
    portalUrl, packetStatus, sendManual, sectionsFor,
    SECTIONS,
  };
};
