// growth.js -- Two additive sections:
//   1. Lead Management (School / Private / Other contracts + general leads)
//   2. Policies, SOPs & Procedures (with a public, QR-linkable viewer)
//
// Additive per RULE ZERO: new tables crm_leads / crm_policies, routes under
// /api/leads/* and /api/policies/*, and a PUBLIC page at /policies for the
// printable QR code. Reuses nothing existing.

module.exports = function initGrowth(ctx) {
  const { dbGet, dbAll, dbRun, nowISO, crypto, readBody, json, extractPdfLines, unzip } = ctx;
  // Optional deps for contract management (item 10/11). Fall back gracefully so
  // the module still loads if a host wires it the old way.
  const sendEmail = ctx.sendEmail || (async () => {});
  const getAppSetting = ctx.getAppSetting || (async (_k, d) => d);
  const APP_BASE_URL = ctx.APP_BASE_URL || "";
  const emailTemplates = ctx.emailTemplates || null;
  const createStaffTask = ctx.createStaffTask || null;
  const stripe = ctx.stripe || null;
  // Payment + financial info is owner-only, like the rest of the money features.
  const canPayments = (u) => !!u && ["owner", "super_admin"].includes(role(u));
  // The safe, display-only fields we ever return about a contract's payments.
  function shapePayment(lead) {
    return {
      configured: !!(stripe && stripe.configured()),
      payment_method_on_file: lead.payment_method_on_file === true || lead.payment_method_on_file === "t",
      payment_method_type: lead.payment_method_type || null,
      payment_method_brand: lead.payment_method_brand || null,
      payment_method_last4: lead.payment_method_last4 || null,
      payment_status: lead.payment_status || null,
      last_payment_at: lead.last_payment_at || null,
      last_payment_amount: lead.last_payment_amount != null ? Number(lead.last_payment_amount) : null,
      next_payment_at: lead.next_payment_at || null,
      failed_payment: lead.failed_payment === true || lead.failed_payment === "t",
      stripe_customer_ref: lead.stripe_customer_id || null,
      stripe_updated_at: lead.stripe_updated_at || null,
    };
  }

  const LEAD_TYPES = ["School", "Private Pay", "Insurance", "Community Partner", "Other"];
  const LEAD_STAGES = ["New", "Contacted", "Meeting Set", "Proposal Sent", "Won", "Lost"];
  const LEAD_SOURCES = ["Referral", "Website", "Event/Conference", "Cold Outreach", "Existing Relationship", "Community Partner", "Other"];
  const RELATIONSHIP_STATUSES = ["Prospect", "In Discussion", "Active Partner", "At Risk", "Dormant", "Former"];
  const CONTRACT_TYPES = ["none", "fixed_term", "month_to_month"];
  const CONTRACT_STATUSES = ["none", "pending", "active", "renewing", "expired", "ended"];

  // ---- contract math ----------------------------------------------------
  function daysBetween(fromISO, toISO) {
    const a = new Date(String(fromISO).slice(0, 10) + "T12:00:00");
    const b = new Date(String(toISO).slice(0, 10) + "T12:00:00");
    if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
    return Math.round((b - a) / 86400000);
  }
  // Everything the UI needs to describe a contract's timing, computed rather
  // than stored so it can never go stale.
  function computeContractView(lead, todayISO) {
    const today = (todayISO || new Date().toISOString()).slice(0, 10);
    const type = lead.contract_type || "none";
    const isMonthToMonth = type === "month_to_month";
    const end = lead.contract_end_date ? String(lead.contract_end_date).slice(0, 10) : null;
    let daysRemaining = null, expiresOn = null, expired = false, expiringSoon = false;
    if (type === "fixed_term" && end) {
      daysRemaining = daysBetween(today, end);
      expiresOn = end;
      expired = daysRemaining < 0;
      expiringSoon = daysRemaining >= 0 && daysRemaining <= (lead.notice_period_days || 30);
    }
    return { type, isMonthToMonth, hasExpiration: type === "fixed_term" && !!end, daysRemaining, expiresOn, expired, expiringSoon };
  }
  async function logEvent(leadId, eventType, body, actor) {
    await dbRun(
      "INSERT INTO crm_lead_events (lead_id, event_type, body, actor, created_at) VALUES (?, ?, ?, ?, ?)",
      [leadId, eventType, body, actor || "system", nowISO()]
    ).catch((e) => console.error("crm_lead_events insert:", e.message));
  }
  function fill(s, f) { return String(s || "").replace(/\{\{(\w+)\}\}/g, (_, k) => (f[k] != null ? String(f[k]) : "")); }
  function checkinFields(lead) {
    return {
      org_name: lead.name || "your organization",
      contact_name: lead.contact_name || "there",
      assigned_to: lead.assigned_to || "your Spectrum Squad contact",
      weekly_hours: lead.weekly_committed_hours != null ? String(lead.weekly_committed_hours) : "",
    };
  }
  // Fallback copy (used if the editable email templates aren't wired). These are
  // relationship check-ins, deliberately warm and specific -- not sales blasts.
  const DEFAULT_CHECKIN = {
    "7": { subject: "Checking in after your first week — {{org_name}}", body: "<p>Hi {{contact_name}},</p><p>It's been about a week since we started working together and I wanted to check in personally. How are the first few days going on your end? If anything came up or you have questions as {{org_name}} gets settled in, I'm just an email away.</p><p>Warmly,<br/>{{assigned_to}} · Spectrum Squad</p>" },
    "30": { subject: "Checking in on our first month together — {{org_name}}", body: "<p>Hi {{contact_name}},</p><p>We're about a month into working together and I wanted to check in personally. How are things going from your side? Is the current level of support meeting {{org_name}}'s needs, and is there anything we could be doing better?</p><p>Warmly,<br/>{{assigned_to}} · Spectrum Squad</p>" },
    "60": { subject: "Two months in — how are we doing, {{contact_name}}?", body: "<p>Hi {{contact_name}},</p><p>As we pass the two-month mark, I'd love your honest read on how the partnership is working. Are there upcoming needs, staffing changes, or additional services we should be planning for together?</p><p>Warmly,<br/>{{assigned_to}} · Spectrum Squad</p>" },
    "90": { subject: "Our first quarter together — a quick check-in", body: "<p>Hi {{contact_name}},</p><p>We've reached our first quarter with {{org_name}} and I'd love to hear how you feel it's going. This is a great moment to talk through satisfaction, any changes on the horizon, and whether it makes sense to revisit the scope of our work together.</p><p>Warmly,<br/>{{assigned_to}} · Spectrum Squad</p>" },
  };
  async function renderCheckin(lead, days) {
    const f = checkinFields(lead);
    let subject, html;
    if (emailTemplates && emailTemplates.getEmailTemplate) {
      const t = await emailTemplates.getEmailTemplate("lead_checkin_" + days).catch(() => null);
      if (t && t.subject_template) { subject = emailTemplates.renderMergeFields(t.subject_template, f); html = emailTemplates.renderMergeFields(t.body_template, f); }
    }
    if (!subject) { const d = DEFAULT_CHECKIN[days]; subject = fill(d.subject, f); html = fill(d.body, f); }
    return { ok: true, to: lead.contact_email || null, subject, html };
  }

  function markJson(current, value) {
    let arr = []; try { arr = JSON.parse(current || "[]"); } catch (e) { arr = []; }
    if (!arr.includes(value)) arr.push(value);
    return JSON.stringify(arr);
  }
  async function makeFollowupTask({ title, description, assignedName, dueDays }) {
    if (!createStaffTask) return;
    const due = new Date(); due.setDate(due.getDate() + (dueDays || 3));
    await createStaffTask({
      title, description,
      assigned_name: assignedName || null,
      due_date: due.toISOString().slice(0, 10),
      priority: "normal",
      created_by: "system",
    }).catch((e) => console.error("lead follow-up task failed:", e.message));
  }

  // 7 / 30 / 60 / 90-day relationship nurturing. For active partners/contracts, at
  // each milestone (once) it drops a follow-up task on the assigned team member
  // and notes it on the timeline, so no check-in is ever forgotten.
  async function nurtureSweep() {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await dbAll(
      `SELECT * FROM crm_leads
        WHERE (contract_status = 'active' OR relationship_status = 'Active Partner')
          AND stage NOT IN ('Lost')`
    ).catch(() => []);
    let n = 0;
    for (const lead of rows) {
      const anchor = (lead.contract_start_date || lead.created_at || "").slice(0, 10);
      if (!anchor) continue;
      const days = daysBetween(anchor, today);
      if (days == null || days < 0) continue;
      let sent; try { sent = JSON.parse(lead.nurture_sent || "[]"); } catch (e) { sent = []; }
      for (const m of [7, 30, 60, 90]) {
        if (days >= m && !sent.includes(String(m))) {
          await makeFollowupTask({
            title: `${m}-day check-in: ${lead.name}`,
            description: `Meaningful relationship check-in with ${lead.name}. Talk through satisfaction, current and upcoming needs, staffing, additional service opportunities, and any feedback. (Tip: the "Send check-in email" button on this lead has an editable template.)`,
            assignedName: lead.assigned_to,
            dueDays: 3,
          });
          await logEvent(lead.id, "task", `${m}-day check-in follow-up created for ${lead.assigned_to || "the team"}.`, "system");
          await dbRun("UPDATE crm_leads SET nurture_sent = ? WHERE id = ?", [markJson(lead.nurture_sent, String(m)), lead.id]);
          lead.nurture_sent = markJson(lead.nurture_sent, String(m));
          n++;
        }
      }
    }
    return n;
  }

  // Contract-expiry alerts for fixed-term contracts. As the end date approaches
  // (standard milestones plus the contract's own notice period), it creates one
  // alert task + timeline note per milestone and emails the assigned member.
  async function contractAlertSweep() {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await dbAll(
      `SELECT * FROM crm_leads
        WHERE contract_type = 'fixed_term' AND contract_end_date IS NOT NULL
          AND contract_status NOT IN ('ended','expired')`
    ).catch(() => []);
    let n = 0;
    for (const lead of rows) {
      const daysRemaining = daysBetween(today, String(lead.contract_end_date).slice(0, 10));
      if (daysRemaining == null) continue;
      const milestones = Array.from(new Set([60, 30, 14, 0, lead.notice_period_days].filter((x) => x != null))).sort((a, b) => b - a);
      let sent; try { sent = JSON.parse(lead.contract_alerts_sent || "[]"); } catch (e) { sent = []; }
      for (const mDay of milestones) {
        const key = "d" + mDay;
        if (daysRemaining <= mDay && !sent.includes(key)) {
          const label = daysRemaining < 0 ? `expired ${Math.abs(daysRemaining)} day(s) ago` : `expires in ${daysRemaining} day(s)`;
          await makeFollowupTask({
            title: `Contract ${daysRemaining < 0 ? "EXPIRED" : "expiring"}: ${lead.name}`,
            description: `${lead.name}'s fixed-term contract ${label} (ends ${String(lead.contract_end_date).slice(0, 10)}). Notice period: ${lead.notice_period_days || "—"} days. Renewal date: ${lead.renewal_date || "—"}. Reach out to renew, renegotiate, or wind down.`,
            assignedName: lead.assigned_to,
            dueDays: 1,
          });
          await logEvent(lead.id, "alert", `Contract ${label} — alert raised.`, "system");
          const to = await resolveAssignedEmail(lead.assigned_to);
          if (to) {
            await sendEmail({
              to,
              subject: `Contract ${daysRemaining < 0 ? "expired" : "expiring soon"}: ${lead.name}`,
              html: `<p>${lead.name}'s contract ${label} (ends ${String(lead.contract_end_date).slice(0, 10)}).</p><p>Notice period: ${lead.notice_period_days || "—"} days. Open the lead in the CRM to renew or renegotiate.</p>`,
              type: "contract_alert",
            }).catch(() => {});
          }
          await dbRun("UPDATE crm_leads SET contract_alerts_sent = ? WHERE id = ?", [markJson(lead.contract_alerts_sent, key), lead.id]);
          lead.contract_alerts_sent = markJson(lead.contract_alerts_sent, key);
          n++;
        }
      }
    }
    return n;
  }
  async function resolveAssignedEmail(name) {
    if (!name) return null;
    const u = await dbGet("SELECT email FROM users WHERE lower(name) = lower(?) AND email IS NOT NULL LIMIT 1", [name]).catch(() => null);
    if (u && u.email) return u.email;
    const e = await dbGet("SELECT email FROM hr_employees WHERE lower(name) = lower(?) AND email IS NOT NULL AND email <> '' LIMIT 1", [name]).catch(() => null);
    return e ? e.email : null;
  }
  // The policy library's categories. This replaced a seven-entry list, so the
  // old values are kept VALID rather than deleted -- policies filed under them
  // keep working and keep displaying, and are recategorised by hand rather than
  // guessed at by a migration. LEGACY_CATEGORIES is only offered in the picker
  // when something is still filed there.
  const POLICY_CATEGORIES = [
    "Employee Handbook",
    "Attendance & Timekeeping",
    "Scheduling & Call-Outs",
    "Payroll & Compensation",
    "Benefits",
    "Professional Conduct",
    "Dress Code & Appearance",
    "Client Care & Clinical",
    "Session Notes & Documentation",
    "HIPAA, Privacy & Confidentiality",
    "Safety & Emergency Procedures",
    "Mandated Reporting",
    "RBT / BCBA Compliance",
    "Supervision",
    "Technology & Company Equipment",
    "Communication",
    "Social Media",
    "Transportation / Community Services",
    "Training & Professional Development",
    "Leave & Time Off",
    "Corrective Action / Discipline",
    "Separation / Termination",
    "Administrative SOPs",
    "Clinical SOPs",
    "Other",
  ];
  const LEGACY_CATEGORIES = ["HR", "Clinical", "Safety", "Billing", "Operations", "Compliance"];
  const ALL_CATEGORIES = POLICY_CATEGORIES.concat(LEGACY_CATEGORIES);
  // One colour per category, so the cards read at a glance and stay consistent
  // between the staff view and the public QR page.
  const CATEGORY_COLORS = {
    "Employee Handbook": "#1b2a6b",
    "Attendance & Timekeeping": "#3f56b5",
    "Scheduling & Call-Outs": "#4a6fd4",
    "Payroll & Compensation": "#c98a1b",
    "Benefits": "#b8791f",
    "Professional Conduct": "#6a5acd",
    "Dress Code & Appearance": "#8b5cf6",
    "Client Care & Clinical": "#3f8f89",
    "Session Notes & Documentation": "#2f7d78",
    "HIPAA, Privacy & Confidentiality": "#217a5b",
    "Safety & Emergency Procedures": "#d94f4f",
    "Mandated Reporting": "#b91c1c",
    "RBT / BCBA Compliance": "#0f766e",
    "Supervision": "#0e7490",
    "Technology & Company Equipment": "#475569",
    "Communication": "#5b7bd5",
    "Social Media": "#7c3aed",
    "Transportation / Community Services": "#a16207",
    "Training & Professional Development": "#2563eb",
    "Leave & Time Off": "#0891b2",
    "Corrective Action / Discipline": "#9a3412",
    "Separation / Termination": "#7f1d1d",
    "Administrative SOPs": "#525252",
    "Clinical SOPs": "#166534",
    "Other": "#6b7280",
    // Retained so existing rows keep their colour until recategorised.
    HR: "#3f56b5",
    Clinical: "#3f8f89",
    Safety: "#d94f4f",
    Billing: "#c98a1b",
    Operations: "#6a5acd",
    Compliance: "#217a5b",
  };
  function colorFor(category, explicit) {
    if (explicit && /^#[0-9a-fA-F]{6}$/.test(explicit)) return explicit;
    return CATEGORY_COLORS[category] || CATEGORY_COLORS.Other;
  }
  // Guess a category from the document's own words, so an upload lands in a
  // sensible bucket instead of always "Other". The owner can change it after.
  const CATEGORY_HINTS = [
    ["Safety", /\bsafety|emergency|evacuat|fire drill|incident|injur|first aid|crisis|restraint|hazard/i],
    ["Clinical", /\bclinical|aba\b|bcba|rbt\b|treatment|behavior plan|session note|supervis|assessment|therapy protocol/i],
    ["Billing", /\bbilling|invoice|claim|authorization|insurance|copay|coding|cpt\b|reimburse/i],
    ["Compliance", /\bhipaa|compliance|confidential|privacy|mandated report|audit|regulat|consent/i],
    ["HR", /\bemployee|payroll|time off|pto\b|attendance|onboarding|dress code|conduct|hiring|benefits|disciplin/i],
    ["Operations", /\boperations|opening|closing|cleaning|supplies|scheduling|checklist|procedure for|daily/i],
  ];
  function guessCategory(text) {
    const t = String(text || "").slice(0, 4000);
    for (const [cat, re] of CATEGORY_HINTS) if (re.test(t)) return cat;
    return "Other";
  }

  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS crm_leads (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      lead_type TEXT,
      stage TEXT DEFAULT 'New',
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      est_value NUMERIC,
      next_follow_up TEXT,
      notes TEXT,
      owner_name TEXT,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("crm_leads:", e.message));
    // Relationship + contract management (Phase 5). All additive.
    for (const col of [
      "address TEXT", "lead_source TEXT", "relationship_status TEXT", "assigned_to TEXT",
      "contract_type TEXT",                 // fixed_term | month_to_month | none
      "contract_status TEXT",               // none | active | pending | renewing | expired | ended
      "contract_start_date TEXT", "contract_end_date TEXT", "renewal_date TEXT",
      "notice_period_days INTEGER", "payment_arrangement TEXT",
      "weekly_committed_hours NUMERIC", "assigned_bcbas TEXT", "other_staff TEXT",
      "special_requirements TEXT",
      "nurture_sent TEXT DEFAULT '[]'",     // which 30/60/90 check-ins have fired
      "contract_alerts_sent TEXT DEFAULT '[]'", // which expiry milestones have fired
      // Stripe payment identifiers ONLY -- never raw card/bank/CVV data.
      "stripe_customer_id TEXT",
      "payment_method_on_file BOOLEAN DEFAULT FALSE",
      "payment_method_type TEXT", "payment_method_brand TEXT", "payment_method_last4 TEXT",
      "payment_status TEXT", "last_payment_at TEXT", "last_payment_amount NUMERIC",
      "next_payment_at TEXT", "failed_payment BOOLEAN DEFAULT FALSE", "stripe_updated_at TEXT",
    ]) {
      await dbRun(`ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS ${col}`).catch((e) => console.error("crm_leads alter:", e.message));
    }
    // A lightweight interaction timeline for each lead/contract.
    await dbRun(`CREATE TABLE IF NOT EXISTS crm_lead_events (
      id SERIAL PRIMARY KEY,
      lead_id INTEGER NOT NULL,
      event_type TEXT DEFAULT 'note',       -- note | checkin | contract | alert | task | stage
      body TEXT,
      actor TEXT,
      created_at TEXT
    )`).catch((e) => console.error("crm_lead_events:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_crm_lead_events_lead ON crm_lead_events(lead_id)`).catch(() => {});
    await dbRun(`CREATE TABLE IF NOT EXISTS crm_policies (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT,
      body TEXT,
      slug TEXT UNIQUE,
      published BOOLEAN DEFAULT TRUE,
      updated_by TEXT,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("crm_policies:", e.message));
    // Colour-coded cards. Additive; existing rows fall back to their category colour.
    await dbRun(`ALTER TABLE crm_policies ADD COLUMN IF NOT EXISTS color TEXT`).catch(() => {});
    await dbRun(`ALTER TABLE crm_policies ADD COLUMN IF NOT EXISTS source_file TEXT`).catch(() => {});
    await dbRun(`ALTER TABLE crm_policies ADD COLUMN IF NOT EXISTS summary TEXT`).catch(() => {});

    // ---- Policy library ------------------------------------------------
    // A source document is uploaded ONCE and can contain many policy records.
    // The Employee Handbook is the case that forced this: it stays readable in
    // full, while the Attendance Policy, the Dress Code and everything else
    // inside it become separately searchable rows pointing back at it. Nobody
    // uploads the handbook twenty times.
    await dbRun(`CREATE TABLE IF NOT EXISTS crm_policy_documents (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      doc_type TEXT,                 -- Employee Handbook | Policy Document | SOP | Other
      filename TEXT,
      body TEXT,                     -- extracted full text, kept verbatim
      version TEXT,
      effective_date TEXT,
      status TEXT DEFAULT 'Active',  -- Active | Draft | Archived
      uploaded_by TEXT,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("crm_policy_documents:", e.message));

    // Policies become records within a library rather than standalone cards.
    // Every column is additive and nullable, so existing policy rows keep
    // working untouched and simply carry no document, no version and no
    // acknowledgment requirement until someone sets one.
    for (const [col, type] of [
      ["document_id", "INTEGER"],           // NULL = standalone policy, not from a source document
      ["section_ref", "TEXT"],              // where it sits in the source, e.g. "Section 4.2"
      ["status", "TEXT"],                   // Active | Draft | Archived
      ["version", "TEXT"],
      ["effective_date", "TEXT"],
      ["requires_acknowledgment", "BOOLEAN DEFAULT FALSE"],
      ["ack_required_since", "TEXT"],       // when the CURRENT version's requirement began
    ]) {
      await dbRun(`ALTER TABLE crm_policies ADD COLUMN IF NOT EXISTS ${col} ${type}`).catch(() => {});
    }
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_crm_policies_document ON crm_policies(document_id)`).catch(() => {});
    // Existing rows predate `status`; published/unpublished is the only signal
    // they carry, so it decides their starting status. Done once -- the guard
    // means a later edit to status is never overwritten.
    await dbRun(`UPDATE crm_policies SET status = CASE WHEN published = FALSE THEN 'Draft' ELSE 'Active' END WHERE status IS NULL`).catch(() => {});

    // Acknowledgments are tied to a POLICY VERSION, not just a policy. That is
    // the whole point: when a policy is materially updated and re-issued, the
    // old acknowledgment stays in the record as historical proof of what was
    // acknowledged and when, and the employee owes a fresh one. Nothing is ever
    // overwritten or deleted on re-issue.
    await dbRun(`CREATE TABLE IF NOT EXISTS crm_policy_acknowledgments (
      id SERIAL PRIMARY KEY,
      policy_id INTEGER NOT NULL,
      policy_version TEXT NOT NULL,
      employee_id INTEGER,
      employee_name TEXT,
      employee_email TEXT,
      acknowledged_at TEXT NOT NULL,
      UNIQUE (policy_id, policy_version, employee_id)
    )`).catch((e) => console.error("crm_policy_acknowledgments:", e.message));
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_policy_ack_policy ON crm_policy_acknowledgments(policy_id)`).catch(() => {});
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_policy_ack_employee ON crm_policy_acknowledgments(employee_id)`).catch(() => {});
  }

  // A policy's current version. Unversioned policies are treated as "v1" so an
  // acknowledgment can still be tied to something stable.
  const versionOf = (p) => String((p && p.version) || "1").trim() || "1";
  const POLICY_STATUSES = ["Active", "Draft", "Archived"];
  const DOC_TYPES = ["Employee Handbook", "Policy Document", "SOP", "Other"];
  // How long a pending acknowledgment may sit before it reads as overdue.
  const ACK_OVERDUE_DAYS = Number(process.env.POLICY_ACK_OVERDUE_DAYS || 14);

  function role(u) { return (u && (u.role || u.role_key || "")) || ""; }

  // A per-user grant from the Access editor unlocks this module's ordinary
  // access tier even when the role list wouldn't. Manage/sensitive tiers stay
  // role-gated.
  const granted = (u, k) => !!(ctx.moduleGranted && ctx.moduleGranted(u, k));
  function canLeads(u) { return ["owner", "super_admin", "admin", "intake", "scheduling"].includes(role(u)) || granted(u, "leads"); }
  function canPolicyManage(u) { return ["owner", "super_admin", "admin", "hr_admin"].includes(role(u)) || granted(u, "policies"); }
  function num(v) { const n = parseFloat(v); return isFinite(n) ? n : null; }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function slugify(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "policy"; }

  // ---- uploaded document readers -------------------------------------
  // .docx is a zip; the text lives in word/document.xml with one <w:p> per
  // paragraph. Tabs become spaces and paragraphs become newlines so the policy
  // body reads the way it did in Word.
  function docxToText(buffer) {
    let files;
    try { files = unzip(buffer); }
    catch (e) { throw new Error("That doesn't look like a Word .docx file."); }
    const xmlBuf = files["word/document.xml"];
    if (!xmlBuf) throw new Error("Couldn't find the text inside that Word file.");
    let xml = xmlBuf.toString("utf8");
    xml = xml
      .replace(/<w:tab[^>]*\/>/g, "\t")
      .replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, "");
    return xml
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  }

  // First non-trivial line makes a better title than the filename usually does.
  function firstHeading(text) {
    const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
    for (const l of lines.slice(0, 8)) {
      if (l.length >= 4 && l.length <= 90 && !/^page\s*\d/i.test(l)) return l;
    }
    return "";
  }

  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/leads") && !pathname.startsWith("/api/policies")) return false;
    try {
      // ---- PUBLIC: published policies (for the QR viewer). No auth. ----
      if (pathname === "/api/policies/public" && method === "GET") {
        const rows = await dbAll("SELECT id, title, category, slug, color, summary, updated_at FROM crm_policies WHERE published = TRUE ORDER BY category, title");
        return json(res, 200, rows);
      }
      const pubOne = pathname.match(/^\/api\/policies\/public\/([a-z0-9-]+)$/);
      if (pubOne && method === "GET") {
        const p = await dbGet("SELECT id, title, category, body, slug, color, updated_at FROM crm_policies WHERE slug = ? AND published = TRUE", [pubOne[1]]);
        if (!p) return json(res, 404, { error: "Not found" });
        return json(res, 200, p);
      }

      if (!user) return json(res, 401, { error: "Not authenticated" });

      // ================= LEADS =================
      if (pathname.startsWith("/api/leads")) {
        if (!canLeads(user)) return json(res, 403, { error: "Not permitted" });
        // All editable fields, and which ones are numeric.
        const TEXT_FIELDS = ["name", "lead_type", "stage", "contact_name", "contact_email", "contact_phone", "next_follow_up", "notes",
          "address", "lead_source", "relationship_status", "assigned_to", "contract_type", "contract_status",
          "contract_start_date", "contract_end_date", "renewal_date", "payment_arrangement", "assigned_bcbas", "other_staff", "special_requirements"];
        const NUM_FIELDS = ["est_value", "weekly_committed_hours", "notice_period_days"];
        const ALL_FIELDS = TEXT_FIELDS.concat(NUM_FIELDS);
        const meta = { types: LEAD_TYPES, stages: LEAD_STAGES, sources: LEAD_SOURCES, relationship_statuses: RELATIONSHIP_STATUSES, contract_types: CONTRACT_TYPES, contract_statuses: CONTRACT_STATUSES };

        if (pathname === "/api/leads" && method === "GET") {
          const rows = await dbAll("SELECT * FROM crm_leads ORDER BY (stage IN ('Won','Lost')), COALESCE(next_follow_up,'9999'), id DESC");
          const shaped = rows.map((r) => ({ ...r, contract: computeContractView(r) }));
          return json(res, 200, { leads: shaped, ...meta });
        }
        if (pathname === "/api/leads" && method === "POST") {
          const b = await readBody(req);
          if (!b.name) return json(res, 400, { error: "Name is required." });
          const row = await dbRun(
            `INSERT INTO crm_leads (name, lead_type, stage, contact_name, contact_email, contact_phone, est_value, next_follow_up, notes, owner_name, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            [b.name, b.lead_type || "Other", b.stage || "New", b.contact_name || null, b.contact_email || null, b.contact_phone || null, num(b.est_value), b.next_follow_up || null, b.notes || null, user.name || null, nowISO(), nowISO()]
          );
          await logEvent(row.rows[0].id, "note", `Lead created by ${user.name || user.email}`, user.name || user.email);
          return json(res, 201, { ok: true, id: row.rows[0].id });
        }

        // Lead detail + interaction timeline.
        const leadDetail = pathname.match(/^\/api\/leads\/(\d+)$/);
        if (leadDetail && method === "GET") {
          const lead = await dbGet("SELECT * FROM crm_leads WHERE id = ?", [Number(leadDetail[1])]);
          if (!lead) return json(res, 404, { error: "Not found" });
          const events = await dbAll("SELECT * FROM crm_lead_events WHERE lead_id = ? ORDER BY id DESC LIMIT 200", [lead.id]);
          return json(res, 200, { lead: { ...lead, contract: computeContractView(lead) }, events, ...meta });
        }

        const leadMatch = pathname.match(/^\/api\/leads\/(\d+)$/);
        if (leadMatch && method === "PATCH") {
          const id = Number(leadMatch[1]);
          const before = await dbGet("SELECT * FROM crm_leads WHERE id = ?", [id]);
          if (!before) return json(res, 404, { error: "Not found" });
          const b = await readBody(req);
          const fields = Object.keys(b).filter((k) => ALL_FIELDS.includes(k));
          if (!fields.length) return json(res, 400, { error: "Nothing to update." });
          const vals = fields.map((f) => (NUM_FIELDS.includes(f) ? num(b[f]) : (b[f] === "" ? null : b[f])));
          await dbRun(`UPDATE crm_leads SET ${fields.map((f) => `${f} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, [...vals, nowISO(), id]);
          // Never silently change an important contract status: record it.
          const watch = ["contract_status", "contract_type", "contract_start_date", "contract_end_date", "renewal_date", "relationship_status", "stage"];
          for (const f of watch) {
            if (fields.includes(f) && String(before[f] ?? "") !== String(b[f] ?? "")) {
              await logEvent(id, f.startsWith("contract") ? "contract" : "stage",
                `${f.replace(/_/g, " ")} changed from "${before[f] || "—"}" to "${b[f] || "—"}" by ${user.name || user.email}`, user.name || user.email);
            }
          }
          return json(res, 200, { ok: true });
        }
        if (leadMatch && method === "DELETE") { await dbRun("DELETE FROM crm_leads WHERE id = ?", [Number(leadMatch[1])]); await dbRun("DELETE FROM crm_lead_events WHERE lead_id = ?", [Number(leadMatch[1])]).catch(() => {}); return json(res, 200, { ok: true }); }

        // Add a free-text interaction to the timeline.
        const eventMatch = pathname.match(/^\/api\/leads\/(\d+)\/events$/);
        if (eventMatch && method === "POST") {
          const b = await readBody(req);
          const body = (b.body || "").trim();
          if (!body) return json(res, 400, { error: "Write something to log." });
          await logEvent(Number(eventMatch[1]), b.event_type || "note", body, user.name || user.email);
          return json(res, 201, { ok: true });
        }

        // Preview / send a relationship check-in email to the contact, using an
        // editable template. Logs the send to the timeline.
        const checkinPrev = pathname.match(/^\/api\/leads\/(\d+)\/checkin\/(7|30|60|90)\/preview$/);
        if (checkinPrev && method === "POST") {
          const lead = await dbGet("SELECT * FROM crm_leads WHERE id = ?", [Number(checkinPrev[1])]);
          if (!lead) return json(res, 404, { error: "Not found" });
          const r = await renderCheckin(lead, checkinPrev[2]);
          return json(res, r.ok ? 200 : 400, r);
        }
        const checkinSend = pathname.match(/^\/api\/leads\/(\d+)\/checkin\/(7|30|60|90)\/send$/);
        if (checkinSend && method === "POST") {
          const lead = await dbGet("SELECT * FROM crm_leads WHERE id = ?", [Number(checkinSend[1])]);
          if (!lead) return json(res, 404, { error: "Not found" });
          if (!lead.contact_email) return json(res, 400, { error: "This lead has no contact email on file." });
          const r = await renderCheckin(lead, checkinSend[2]);
          if (!r.ok) return json(res, 400, r);
          await sendEmail({ to: lead.contact_email, subject: r.subject, html: r.html, type: "lead_checkin" });
          await logEvent(lead.id, "checkin", `${checkinSend[2]}-day check-in email sent to ${lead.contact_email} by ${user.name || user.email}`, user.name || user.email);
          return json(res, 200, { ok: true, sent_to: lead.contact_email });
        }

        // ---- Stripe payments (safe identifiers only; owner-gated) ----
        const payGet = pathname.match(/^\/api\/leads\/(\d+)\/payment$/);
        if (payGet && method === "GET") {
          if (!canPayments(user)) return json(res, 403, { error: "Not permitted to view payment information." });
          const lead = await dbGet("SELECT * FROM crm_leads WHERE id = ?", [Number(payGet[1])]);
          if (!lead) return json(res, 404, { error: "Not found" });
          return json(res, 200, shapePayment(lead));
        }
        // Start (or update) the payment method via Stripe's hosted Checkout in
        // SETUP mode. We create/reuse a Customer, then hand back the hosted URL.
        // No card/bank data ever touches this server.
        const paySetup = pathname.match(/^\/api\/leads\/(\d+)\/payment\/setup$/);
        if (paySetup && method === "POST") {
          if (!canPayments(user)) return json(res, 403, { error: "Not permitted." });
          if (!stripe || !stripe.configured()) return json(res, 400, { error: "Stripe is not connected yet. Add STRIPE_SECRET_KEY in the server environment to enable payments." });
          const lead = await dbGet("SELECT * FROM crm_leads WHERE id = ?", [Number(paySetup[1])]);
          if (!lead) return json(res, 404, { error: "Not found" });
          try {
            let customerId = lead.stripe_customer_id;
            if (!customerId) {
              const cust = await stripe.createCustomer({ name: lead.name, email: lead.contact_email || undefined, metadata: { crm_lead_id: String(lead.id) } });
              customerId = cust.id;
              await dbRun("UPDATE crm_leads SET stripe_customer_id = ?, stripe_updated_at = ? WHERE id = ?", [customerId, nowISO(), lead.id]);
            }
            const base = APP_BASE_URL || "";
            const session = await stripe.createSetupCheckoutSession({
              customerId,
              successUrl: `${base}/#/leads?payment=success&lead=${lead.id}`,
              cancelUrl: `${base}/#/leads?payment=cancelled&lead=${lead.id}`,
            });
            await logEvent(lead.id, "note", `Payment setup started by ${user.name || user.email}.`, user.name || user.email);
            return json(res, 200, { url: session.url, customer_ref: customerId });
          } catch (e) {
            return json(res, 400, { error: e.message || "Could not start Stripe setup." });
          }
        }
        return false;
      }

      // ================= POLICIES (authed management) =================
      // ---- POLICY LIBRARY ------------------------------------------------
      // Search + filter over policy records, with each row carrying everything
      // the library needs to display: category, status, version, dates, its
      // source document, and this user's acknowledgment position.
      if (pathname === "/api/policies/library" && method === "GET") {
        const q = String((query && query.q) || "").trim().toLowerCase();
        const cat = String((query && query.category) || "").trim();
        const st = String((query && query.status) || "").trim();

        const policies = await dbAll(
          `SELECT p.*, d.title AS document_title, d.doc_type AS document_type, d.filename AS document_filename
             FROM crm_policies p LEFT JOIN crm_policy_documents d ON d.id = p.document_id
            ORDER BY p.category, p.title`
        ).catch(() => []);

        const myAcks = user ? await dbAll(
          "SELECT policy_id, policy_version, acknowledged_at FROM crm_policy_acknowledgments WHERE employee_id = ?",
          [user.id || null]
        ).catch(() => []) : [];
        const ackKey = (id, v) => `${id}::${v}`;
        const mine = new Map(myAcks.map((a) => [ackKey(a.policy_id, a.policy_version), a.acknowledged_at]));

        const filtered = policies.filter((p) => {
          const status = p.status || "Active";
          if (cat && p.category !== cat) return false;
          if (st && status !== st) return false;
          if (!q) return true;
          return [p.title, p.category, p.summary, p.body, p.document_title]
            .some((f) => String(f || "").toLowerCase().includes(q));
        }).map((p) => {
          const v = versionOf(p);
          const acknowledgedAt = mine.get(ackKey(p.id, v)) || null;
          return {
            id: p.id, title: p.title, category: p.category, slug: p.slug,
            summary: p.summary, color: colorFor(p.category, p.color),
            status: p.status || "Active", version: v,
            effective_date: p.effective_date, updated_at: p.updated_at, created_at: p.created_at,
            section_ref: p.section_ref,
            document: p.document_id
              ? { id: p.document_id, title: p.document_title, type: p.document_type, filename: p.document_filename }
              : null,
            requires_acknowledgment: p.requires_acknowledgment === true || p.requires_acknowledgment === "t",
            my_acknowledgment: acknowledgedAt ? { version: v, acknowledged_at: acknowledgedAt } : null,
          };
        });

        // Legacy categories are only offered once something is still filed
        // under them, so the picker does not carry dead options forever.
        const inUse = new Set(policies.map((p) => p.category).filter(Boolean));
        return json(res, 200, {
          policies: filtered,
          total: policies.length,
          categories: POLICY_CATEGORIES.concat(LEGACY_CATEGORIES.filter((c) => inUse.has(c))),
          statuses: POLICY_STATUSES,
          category_colors: CATEGORY_COLORS,
          can_manage: canPolicyManage(user),
        });
      }

      // ---- SOURCE DOCUMENTS ----------------------------------------------
      if (pathname === "/api/policies/documents" && method === "GET") {
        const rows = await dbAll(
          `SELECT d.id, d.title, d.doc_type, d.filename, d.version, d.effective_date, d.status,
                  d.uploaded_by, d.created_at, d.updated_at,
                  (SELECT COUNT(*) FROM crm_policies p WHERE p.document_id = d.id)::int AS policy_count
             FROM crm_policy_documents d ORDER BY d.created_at DESC`
        ).catch(() => []);
        return json(res, 200, { documents: rows, doc_types: DOC_TYPES });
      }

      const docOne = pathname.match(/^\/api\/policies\/documents\/(\d+)$/);
      if (docOne && method === "GET") {
        const d = await dbGet("SELECT * FROM crm_policy_documents WHERE id = ?", [Number(docOne[1])]);
        if (!d) return json(res, 404, { error: "Document not found." });
        const policies = await dbAll(
          "SELECT id, title, category, status, version, section_ref FROM crm_policies WHERE document_id = ? ORDER BY title",
          [d.id]
        ).catch(() => []);
        return json(res, 200, { document: d, policies });
      }

      // Upload a source document. Text is extracted and stored verbatim -- no
      // rewriting, no summarising, no AI touching the approved language. It is
      // the operator who later decides which policies live inside it.
      if (pathname === "/api/policies/documents" && method === "POST") {
        if (!canPolicyManage(user)) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        if (!b.content_base64) return json(res, 400, { error: "No file provided." });
        const name = String(b.filename || "document");
        let buf;
        try {
          let raw = String(b.content_base64);
          const ci = raw.indexOf(",");
          if (raw.startsWith("data:") && ci >= 0) raw = raw.slice(ci + 1);
          buf = Buffer.from(raw, "base64");
        } catch (e) { return json(res, 400, { error: "Could not read that file." }); }

        let text = "";
        try {
          if (/\.pdf$/i.test(name) || buf.slice(0, 5).toString("latin1") === "%PDF-") text = extractPdfLines(buf).join("\n");
          else if (/\.docx$/i.test(name)) text = docxToText(buf);
          else if (/\.(txt|md)$/i.test(name)) text = buf.toString("utf8");
          else return json(res, 400, { error: "Upload a PDF, a Word .docx, or a plain text file. (Old .doc files need to be saved as .docx first.)" });
        } catch (e) { return json(res, 400, { error: e.message || "Could not read that file." }); }

        text = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
        if (text.replace(/\s/g, "").length < 40) {
          return json(res, 400, { error: "That file didn't have readable text in it. If it's a scan or a photo, it needs to be a text document." });
        }

        const fileTitle = name.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim();
        const row = await dbGet(
          `INSERT INTO crm_policy_documents (title, doc_type, filename, body, version, effective_date, status, uploaded_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          [String(b.title || fileTitle || "Untitled document").slice(0, 200),
           DOC_TYPES.includes(b.doc_type) ? b.doc_type : "Policy Document",
           name, text, b.version ? String(b.version) : null, b.effective_date || null,
           POLICY_STATUSES.includes(b.status) ? b.status : "Active",
           (user && user.name) || null, nowISO(), nowISO()]
        );
        return json(res, 201, { ok: true, document: row, characters: text.length });
      }

      if (docOne && method === "PATCH") {
        if (!canPolicyManage(user)) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        const allowed = ["title", "doc_type", "version", "effective_date", "status"];
        const fields = Object.keys(b).filter((k) => allowed.includes(k));
        if (!fields.length) return json(res, 400, { error: "Nothing to update." });
        await dbRun(
          `UPDATE crm_policy_documents SET ${fields.map((f) => `${f} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
          [...fields.map((f) => b[f]), nowISO(), Number(docOne[1])]
        );
        return json(res, 200, { ok: true });
      }

      // ---- ACKNOWLEDGMENTS -----------------------------------------------
      const ackMatch = pathname.match(/^\/api\/policies\/(\d+)\/acknowledge$/);
      if (ackMatch && method === "POST") {
        if (!user) return json(res, 401, { error: "Sign in to acknowledge a policy." });
        const p = await dbGet("SELECT * FROM crm_policies WHERE id = ?", [Number(ackMatch[1])]);
        if (!p) return json(res, 404, { error: "Policy not found." });
        if (!(p.requires_acknowledgment === true || p.requires_acknowledgment === "t")) {
          return json(res, 400, { error: "This policy does not require acknowledgment." });
        }
        if ((p.status || "Active") !== "Active") {
          return json(res, 400, { error: "Only an active policy can be acknowledged." });
        }
        const v = versionOf(p);
        // Version is part of the key, so re-acknowledging the same version is a
        // no-op and a NEW version creates a new row beside the old one.
        await dbRun(
          `INSERT INTO crm_policy_acknowledgments (policy_id, policy_version, employee_id, employee_name, employee_email, acknowledged_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (policy_id, policy_version, employee_id) DO NOTHING`,
          [p.id, v, user.id || null, user.name || null, user.email || null, nowISO()]
        );
        return json(res, 200, { ok: true, policy_id: p.id, version: v });
      }

      // Admin report: acknowledged / pending / overdue, by policy and by person.
      if (pathname === "/api/policies/acknowledgments" && method === "GET") {
        if (!canPolicyManage(user)) return json(res, 403, { error: "Not permitted" });
        const policies = await dbAll(
          "SELECT * FROM crm_policies WHERE requires_acknowledgment = TRUE AND COALESCE(status,'Active') = 'Active' ORDER BY category, title"
        ).catch(() => []);
        const staff = await dbAll(
          "SELECT id, name, email FROM hr_employees WHERE COALESCE(status,'active') <> 'terminated' ORDER BY name"
        ).catch(() => []);
        const acks = await dbAll("SELECT * FROM crm_policy_acknowledgments").catch(() => []);

        const have = new Set(acks.map((a) => `${a.policy_id}::${a.policy_version}::${a.employee_id}`));
        const today = nowISO().slice(0, 10);
        const overdueAfter = (since) => {
          if (!since) return false;
          const d = new Date(String(since).slice(0, 10));
          if (isNaN(d.getTime())) return false;
          return (new Date(today) - d) / 86400000 > ACK_OVERDUE_DAYS;
        };

        const byPolicy = policies.map((p) => {
          const v = versionOf(p);
          const rows = staff.map((s) => {
            const done = have.has(`${p.id}::${v}::${s.id}`);
            return {
              employee_id: s.id, name: s.name,
              state: done ? "acknowledged" : (overdueAfter(p.ack_required_since || p.updated_at) ? "overdue" : "pending"),
            };
          });
          return {
            policy_id: p.id, title: p.title, category: p.category, version: v,
            effective_date: p.effective_date, ack_required_since: p.ack_required_since,
            acknowledged: rows.filter((r) => r.state === "acknowledged").length,
            pending: rows.filter((r) => r.state === "pending").length,
            overdue: rows.filter((r) => r.state === "overdue").length,
            staff_count: rows.length,
            employees: rows,
          };
        });

        // Superseded acknowledgments are kept and reported separately -- they
        // are the historical record of what was acknowledged and when.
        const currentKeys = new Set(policies.map((p) => `${p.id}::${versionOf(p)}`));
        const historical = acks
          .filter((a) => !currentKeys.has(`${a.policy_id}::${a.policy_version}`))
          .map((a) => ({
            policy_id: a.policy_id, version: a.policy_version,
            employee_id: a.employee_id, name: a.employee_name, acknowledged_at: a.acknowledged_at,
          }));

        return json(res, 200, { by_policy: byPolicy, historical, overdue_after_days: ACK_OVERDUE_DAYS });
      }

      if (pathname === "/api/policies" && method === "GET") {
        const rows = await dbAll("SELECT * FROM crm_policies ORDER BY category, title");
        return json(res, 200, { policies: rows, categories: POLICY_CATEGORIES, category_colors: CATEGORY_COLORS });
      }
      if (pathname === "/api/policies/upload" && method === "POST") {
        if (!canPolicyManage(user)) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        if (!b.content_base64) return json(res, 400, { error: "No file provided." });
        const name = String(b.filename || "policy");
        let buf;
        try {
          let raw = String(b.content_base64);
          const ci = raw.indexOf(",");
          if (raw.startsWith("data:") && ci >= 0) raw = raw.slice(ci + 1);
          buf = Buffer.from(raw, "base64");
        } catch (e) { return json(res, 400, { error: "Could not read that file." }); }

        let text = "";
        try {
          if (/\.pdf$/i.test(name) || buf.slice(0, 5).toString("latin1") === "%PDF-") {
            text = extractPdfLines(buf).join("\n");
          } else if (/\.docx$/i.test(name)) {
            text = docxToText(buf);
          } else if (/\.(txt|md)$/i.test(name)) {
            text = buf.toString("utf8");
          } else {
            return json(res, 400, { error: "Upload a PDF, a Word .docx, or a plain text file. (Old .doc files need to be saved as .docx first.)" });
          }
        } catch (e) { return json(res, 400, { error: e.message || "Could not read that file." }); }

        text = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
        if (text.replace(/\s/g, "").length < 40) {
          return json(res, 400, { error: "That file didn't have readable text in it. If it's a scan or a photo, it needs to be a text document to become a policy card." });
        }

        const fileTitle = name.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim();
        const title = String(b.title || firstHeading(text) || fileTitle || "Untitled policy").slice(0, 120);
        const category = POLICY_CATEGORIES.includes(b.category) ? b.category : guessCategory(title + "\n" + text);
        const summary = text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join(" ").slice(0, 220);

        let slug = slugify(title);
        if (await dbGet("SELECT id FROM crm_policies WHERE slug = ?", [slug])) {
          slug = slug + "-" + crypto.randomBytes(3).toString("hex");
        }
        const row = await dbGet(
          `INSERT INTO crm_policies (title, category, body, slug, published, color, source_file, summary, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          [title, category, text, slug, b.published === false ? false : true, colorFor(category, b.color), name,
           summary, (user && user.name) || null, nowISO(), nowISO()]
        );
        return json(res, 201, { ok: true, policy: row });
      }

      if (pathname === "/api/policies" && method === "POST") {
        if (!canPolicyManage(user)) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        if (!b.title) return json(res, 400, { error: "Title is required." });
        let slug = slugify(b.title);
        // Ensure unique slug.
        const exists = await dbGet("SELECT id FROM crm_policies WHERE slug = ?", [slug]);
        if (exists) slug = slug + "-" + crypto.randomBytes(2).toString("hex");
        if (b.category !== undefined && b.category && !ALL_CATEGORIES.includes(b.category)) {
          return json(res, 400, { error: "Unknown category." });
        }
        if (b.status !== undefined && !POLICY_STATUSES.includes(b.status)) {
          return json(res, 400, { error: "Status must be Active, Draft or Archived." });
        }
        // A policy record may point at a source document -- that is how one
        // uploaded handbook yields many separately findable policies.
        const requiresAck = b.requires_acknowledgment === true;
        const row = await dbRun(
          `INSERT INTO crm_policies
             (title, category, body, slug, published, updated_by, created_at, updated_at,
              document_id, section_ref, status, version, effective_date, requires_acknowledgment, ack_required_since)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          [b.title, b.category || "Other", b.body || "", slug, b.published === false ? false : true,
           user.name || null, nowISO(), nowISO(),
           b.document_id ? Number(b.document_id) : null, b.section_ref || null,
           POLICY_STATUSES.includes(b.status) ? b.status : "Active",
           b.version ? String(b.version) : "1", b.effective_date || null,
           requiresAck, requiresAck ? nowISO() : null]
        );
        return json(res, 201, { ok: true, id: row.rows[0].id, slug });
      }
      const polMatch = pathname.match(/^\/api\/policies\/(\d+)$/);
      if (polMatch && method === "PATCH") {
        if (!canPolicyManage(user)) return json(res, 403, { error: "Not permitted" });
        const b = await readBody(req);
        const allowed = [
          "title", "category", "body", "published", "color", "summary",
          "document_id", "section_ref", "status", "version", "effective_date", "requires_acknowledgment",
        ];
        const fields = Object.keys(b).filter((k) => allowed.includes(k));
        if (!fields.length) return json(res, 400, { error: "Nothing to update." });
        if (b.category !== undefined && !ALL_CATEGORIES.includes(b.category)) {
          return json(res, 400, { error: "Unknown category." });
        }
        if (b.status !== undefined && !POLICY_STATUSES.includes(b.status)) {
          return json(res, 400, { error: "Status must be Active, Draft or Archived." });
        }

        const id = Number(polMatch[1]);
        const before = await dbGet("SELECT * FROM crm_policies WHERE id = ?", [id]);
        if (!before) return json(res, 404, { error: "Policy not found." });

        // Re-issuing a policy: a new version, or switching acknowledgment on,
        // restarts the acknowledgment clock. Existing acknowledgments are NOT
        // touched -- they stay against the version they were given for, and
        // everyone owes a fresh one against the new version.
        const versionChanged = b.version !== undefined && String(b.version).trim() !== versionOf(before);
        const ackTurnedOn = b.requires_acknowledgment === true
          && !(before.requires_acknowledgment === true || before.requires_acknowledgment === "t");
        const extra = [];
        if (versionChanged || ackTurnedOn) extra.push(["ack_required_since", nowISO()]);

        await dbRun(
          `UPDATE crm_policies SET ${fields.map((f) => `${f} = ?`).join(", ")}${
            extra.map(([k]) => `, ${k} = ?`).join("")
          }, updated_by = ?, updated_at = ? WHERE id = ?`,
          [...fields.map((f) => b[f]), ...extra.map(([, v]) => v), user.name || null, nowISO(), id]
        );
        return json(res, 200, {
          ok: true,
          reissued: versionChanged || ackTurnedOn,
          previous_version: versionChanged ? versionOf(before) : null,
        });
      }
      if (polMatch && method === "DELETE") {
        if (!canPolicyManage(user)) return json(res, 403, { error: "Not permitted" });
        await dbRun("DELETE FROM crm_policies WHERE id = ?", [Number(polMatch[1])]);
        return json(res, 200, { ok: true });
      }
      return false;
    } catch (e) {
      console.error("growth handleApi error:", e);
      return json(res, 500, { error: "Error: " + e.message });
    }
  }

  // Public, printable policies viewer (the QR code target).
  function servePage(req, res, pathname) {
    if (pathname === "/policies" || pathname.startsWith("/policies/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(policiesHtml());
      return true;
    }
    return false;
  }

  function policiesHtml() {
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Policies & Procedures — Spectrum Squad</title>
<style>
  :root{--navy:#1b2a6b;--gold:#e0a430;--ink:#1e293b;--muted:#64748b;--line:#e2e8f0;--bg:#f5f6fb;}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:var(--bg);color:var(--ink);}
  .wrap{max-width:820px;margin:0 auto;padding:20px 16px 60px;}
  .logo{display:block;max-width:180px;margin:8px auto 6px;}
  h1{color:var(--navy);text-align:center;font-size:24px;margin:6px 0 2px;}
  .sub{text-align:center;color:var(--muted);margin:0 0 18px;}
  .search{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;font-size:15px;margin-bottom:16px;}
  .cat{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:18px 0 6px;font-weight:700;}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px;}
  .item{position:relative;background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px 16px 13px 20px;cursor:pointer;overflow:hidden;transition:transform .12s ease,box-shadow .12s ease;}
  .item:hover{border-color:var(--pc,var(--navy));transform:translateY(-2px);box-shadow:0 8px 20px rgba(27,42,107,.14);}
  .item .stripe{position:absolute;left:0;top:0;bottom:0;width:6px;background:var(--pc,var(--navy));}
  .item h3{margin:6px 0 0;font-size:15px;color:var(--navy);line-height:1.3;}
  .item .when{font-size:12px;color:var(--muted);margin-top:4px;}
  .item .snip{font-size:12px;color:var(--muted);margin-top:6px;line-height:1.45;}
  .pill{display:inline-block;border-radius:999px;padding:2px 9px;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;background:var(--pc,var(--navy));color:#fff;opacity:.92;}
  .dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:7px;vertical-align:middle;}
  .back{background:none;border:0;color:var(--navy);font-weight:700;cursor:pointer;font-size:14px;padding:0;margin-bottom:10px;}
  .body{background:#fff;border:1px solid var(--line);border-radius:12px;padding:20px;white-space:pre-wrap;line-height:1.6;}
  .body h2{color:var(--navy);margin-top:0;}
</style></head>
<body>
<div class="wrap" id="app"><p style="text-align:center;color:#64748b;">Loading…</p></div>
<script>
(function(){
  var app=document.getElementById("app");
  function esc(s){var d=document.createElement("div");d.textContent=s==null?"":String(s);return d.innerHTML;}
  function when(s){try{return "Updated "+new Date(s).toLocaleDateString();}catch(e){return "";}}
  var slug=(location.pathname.split("/policies/")[1]||"").replace(/\\/+$/,"");
  if(slug){ showOne(slug); } else { showList(); }
  function header(){return '<img class="logo" src="/logo.png" alt="Spectrum Squad"/><h1>Policies &amp; Procedures</h1><p class="sub">Spectrum Squad</p>';}
  function showList(){
    fetch("/api/policies/public").then(function(r){return r.json();}).then(function(rows){
      if(!rows.length){app.innerHTML=header()+'<p style="text-align:center;color:#64748b;">No policies published yet.</p>';return;}
      var byCat={};rows.forEach(function(p){(byCat[p.category||"Other"]=byCat[p.category||"Other"]||[]).push(p);});
      var html=header()+'<input class="search" id="q" placeholder="Search policies…"/>';
      html+='<div id="list">'+renderCats(byCat)+'</div>';
      app.innerHTML=html;
      document.getElementById("q").addEventListener("input",function(e){
        var t=e.target.value.toLowerCase();
        var filtered={};rows.filter(function(p){return p.title.toLowerCase().indexOf(t)>=0||(p.category||"").toLowerCase().indexOf(t)>=0;}).forEach(function(p){(filtered[p.category||"Other"]=filtered[p.category||"Other"]||[]).push(p);});
        document.getElementById("list").innerHTML=renderCats(filtered);
        wire();
      });
      wire();
    }).catch(function(){app.innerHTML=header()+'<p style="text-align:center;color:#b91c1c;">Could not load policies.</p>';});
  }
  var CATCOLORS=${JSON.stringify(CATEGORY_COLORS)};
  function colorOf(p){
    if(p.color&&/^#[0-9a-fA-F]{6}$/.test(p.color))return p.color;
    return CATCOLORS[p.category]||"#6b7280";
  }
  function renderCats(byCat){
    return Object.keys(byCat).sort().map(function(cat){
      var cc=CATCOLORS[cat]||"#6b7280";
      return '<div class="cat"><span class="dot" style="background:'+cc+'"></span>'+esc(cat)+'</div><div class="grid">'+byCat[cat].map(function(p){
        var c=colorOf(p);
        return '<div class="item" data-slug="'+esc(p.slug)+'" style="--pc:'+c+'"><span class="stripe"></span><span class="pill">'+esc(p.category||"Other")+'</span><h3>'+esc(p.title)+'</h3>'+(p.summary?'<div class="snip">'+esc(String(p.summary).slice(0,120))+'</div>':'')+'<div class="when">'+esc(when(p.updated_at))+'</div></div>';
      }).join("")+'</div>';
    }).join("")||'<p style="color:#64748b;">No matches.</p>';
  }
  function wire(){Array.prototype.forEach.call(document.querySelectorAll("[data-slug]"),function(el){el.addEventListener("click",function(){history.pushState({},"","/policies/"+el.getAttribute("data-slug"));showOne(el.getAttribute("data-slug"));});});}
  function showOne(s){
    fetch("/api/policies/public/"+encodeURIComponent(s)).then(function(r){return r.ok?r.json():Promise.reject();}).then(function(p){
      app.innerHTML=header()+'<button class="back" id="back">← All policies</button><div class="body" style="border-top:6px solid '+colorOf(p)+'"><h2><span class="dot" style="background:'+colorOf(p)+'"></span>'+esc(p.title)+'</h2><div style="color:#64748b;font-size:12px;margin-bottom:12px;">'+esc(p.category||"")+' · '+esc(when(p.updated_at))+'</div>'+esc(p.body)+'</div>';
      document.getElementById("back").addEventListener("click",function(){history.pushState({},"","/policies");showList();});
    }).catch(function(){app.innerHTML=header()+'<button class="back" id="back">← All policies</button><p style="text-align:center;color:#b91c1c;">Policy not found.</p>';var b=document.getElementById("back");if(b)b.addEventListener("click",function(){history.pushState({},"","/policies");showList();});});
  }
  window.addEventListener("popstate",function(){var s=(location.pathname.split("/policies/")[1]||"").replace(/\\/+$/,"");if(s)showOne(s);else showList();});
})();
</script>
</body></html>`;
  }

  // Apply a verified Stripe webhook event to the matching contract's SAFE
  // fields. Never stores anything sensitive -- only status, brand + last4, and
  // amounts. Matches the lead by its stored stripe_customer_id.
  async function applyStripeEvent(event) {
    const obj = (event && event.data && event.data.object) || {};
    const customerId = obj.customer || obj.customer_id || null;
    if (!customerId) return { ok: false, reason: "no_customer" };
    const lead = await dbGet("SELECT * FROM crm_leads WHERE stripe_customer_id = ?", [customerId]);
    if (!lead) return { ok: false, reason: "no_lead" };
    const type = event.type;
    const set = {};
    if (type === "checkout.session.completed" || type === "setup_intent.succeeded" || type === "payment_method.attached") {
      set.payment_method_on_file = true;
      set.payment_status = "active";
      set.failed_payment = false;
      let summary = null;
      if (obj.card || obj.us_bank_account || obj.type) summary = stripe ? stripe.safePaymentMethodSummary(obj) : null;
      else if (stripe && stripe.configured() && obj.payment_method) { try { summary = stripe.safePaymentMethodSummary(await stripe.retrievePaymentMethod(obj.payment_method)); } catch (e) {} }
      if (summary) { set.payment_method_type = summary.type; set.payment_method_brand = summary.brand; set.payment_method_last4 = summary.last4; }
    } else if (type === "payment_intent.succeeded" || type === "invoice.paid" || type === "invoice.payment_succeeded") {
      set.payment_status = "paid"; set.failed_payment = false; set.last_payment_at = nowISO();
      if (obj.amount_received != null) set.last_payment_amount = obj.amount_received / 100;
      else if (obj.amount_paid != null) set.last_payment_amount = obj.amount_paid / 100;
      if (obj.next_payment_attempt) set.next_payment_at = new Date(obj.next_payment_attempt * 1000).toISOString();
    } else if (type === "payment_intent.payment_failed" || type === "invoice.payment_failed") {
      set.payment_status = "failed"; set.failed_payment = true;
    } else {
      return { ok: true, ignored: type };
    }
    set.stripe_updated_at = nowISO();
    const keys = Object.keys(set);
    await dbRun(`UPDATE crm_leads SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, [...keys.map((k) => set[k]), lead.id]);
    await logEvent(lead.id, "contract", `Payment update from Stripe: ${type}.`, "stripe");
    return { ok: true, lead_id: lead.id, applied: type };
  }

  return { initTables, handleApi, servePage, nurtureSweep, contractAlertSweep, applyStripeEvent };
};
