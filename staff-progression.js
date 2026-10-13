// staff-progression.js -- the Credentialing Tracker: where every new hire is in
// internal onboarding, where they are with each payer, and the 7 AM email that
// tells leadership who still needs something.
//
// It grew out of the Staff Progression widget and keeps that widget's rule:
// THE HR HUB IS THE SOURCE. What can be read from the records that own a fact
// -- the hire packet, the onboarding portal, the document tracker, the
// certifications, the employee record -- is read on every request and never
// copied. Only what had nowhere to live is stored here:
//
//   hr_onboarding_tracking            who is being tracked, their coordinator
//                                     and target completion date
//   hr_onboarding_milestones          a person's sign-off on one of the three
//                                     internal milestones (and its notes, owner,
//                                     due date); NULL status = follow the records
//   hr_onboarding_milestone_history   every change to the above: what, who, when
//   hr_payer_enrollments              group linking / credentialing per payer
//   hr_payer_linking_rules            which payers need individual linking, for
//                                     which positions, and whether only for
//                                     staff whose caseload includes that payer
//   credentialing_email_log           one row per (day, recipient) of the daily
//                                     email: sent, simulated, failed, skipped
//
// THREE MILESTONES, AND WHAT APPROVAL MEANS:
//
//   HR ONBOARDING, then REQUIRED DOCUMENTS & CREDENTIALS -- a document the
//   practice holds is a document it has verified, so there is no second
//   sign-off step over the same list. What a received document cannot tell us
//   is whether the credential is still in date, so that is checked here.
//
//   FINAL INTERNAL APPROVAL -- the two milestones above are done AND every
//   payer this position has to be individually linked with is confirmed
//   linked. The owner can still approve over an unconfirmed payer, but only
//   with a note on the record saying why, because an insurer sitting on a
//   submission is nobody here's fault and can run past 45 days.
//
//   READY FOR A PAYER'S CLIENTS -- approval plus a current credential, worked
//   out per payer. Payers that do not require individual linking are not
//   tracked per person at all.
//
// WHAT THE PAYLOAD NEVER CARRIES: pay, background-check results, files, notes
// on documents, Social Security or ID details, or HR's payer notes. Outstanding
// requirements are named ("Background check") and nothing more. Rows are built
// field by field from an allowlist, never by spreading a database row.
"use strict";

module.exports = function initStaffProgression(ctx) {
  const { dbGet, dbAll, dbRun, nowISO, readBody, json } = ctx;
  const hrCanManage = ctx.hrCanManage || ((u) => !!u && ["owner", "admin", "super_admin", "hr_admin"].includes(u.role));
  const isClinicalLead = ctx.isClinicalLead || (async (u) => !!u && ["owner", "super_admin"].includes(u.role));
  const leadership = ctx.leadership || (async () => ({ clinical_director: null, assistants: [], from_setting: null }));
  const leadershipEmails = ctx.leadershipEmails || (async () => []);
  // Configuration -- payer rules, onboarding deadlines, the daily email -- is
  // the practice owner's alone, not HR's and not an admin's. HR runs
  // onboarding; it does not set the rules or decide who gets the email.
  const canConfigure = ctx.canConfigure || ((u) => !!u && u.role === "owner");
  const getAppSetting = ctx.getAppSetting || (async (k, f) => f);
  const setAppSetting = ctx.setAppSetting || (async () => {});
  const sendEmail = ctx.sendEmail || null;
  const brandedEmail = ctx.brandedEmail || ((h) => h);
  const APP_BASE_URL = String(ctx.appBaseUrl || "").replace(/\/$/, "");

  const clean = (v) => (v == null ? "" : String(v).trim());
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(clean(v));
  const day = (v) => (v ? String(v).slice(0, 10) : null);
  const escH = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  function daysBetween(a, b) {
    const x = Date.parse(String(a).slice(0, 10) + "T00:00:00Z");
    const y = Date.parse(String(b).slice(0, 10) + "T00:00:00Z");
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return Math.round((y - x) / 86400000);
  }
  function addDays(iso, n) {
    const t = Date.parse(String(iso).slice(0, 10) + "T00:00:00Z");
    if (!Number.isFinite(t)) return null;
    return new Date(t + n * 86400000).toISOString().slice(0, 10);
  }

  // ---- Pacific time ---------------------------------------------------------
  // The office's day and the email's 7:00 are Pacific, through daylight saving.
  // The server runs in UTC, so this is computed rather than read off getHours().
  const PAC = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  function pacific(d) {
    const p = {};
    PAC.formatToParts(d || new Date()).forEach((x) => { p[x.type] = x.value; });
    const hour = p.hour === "24" ? "00" : p.hour;
    return { date: `${p.year}-${p.month}-${p.day}`, hm: `${hour}:${p.minute}` };
  }
  const today = () => pacific().date;
  // Is the daily email due at this instant? Pure, so the DST cases can be tested.
  function isDue(at, timeHM) {
    const t = /^\d{2}:\d{2}$/.test(clean(timeHM)) ? clean(timeHM) : "07:00";
    return pacific(at).hm >= t;
  }

  // ---- thresholds -----------------------------------------------------------
  const DOC_REQUEST_STALE_DAYS = 7;  // a document requested this long ago and not in
  const PAYER_SLOW_DAYS = 45;        // a payer submission unanswered this long
  const APPROVED_VISIBLE_DAYS = 90;  // approved hires stay on the dashboard this long
  const DEFAULT_DUE_DAYS = { hr_onboarding: 7, documents: 21, approval: 30 };

  // ---- the three internal milestones ---------------------------------------
  // Receiving a credential document IS verifying it -- the practice does not
  // run a second sign-off step over documents it already holds, so documents
  // and verification are one milestone. `auto`: completes on its own when
  // every requirement read from the records is met. Final approval is a
  // person's judgment and always needs a sign-off.
  const MILESTONES = [
    { key: "hr_onboarding", label: "HR Onboarding", owner: "HR", auto: true },
    { key: "documents", label: "Required Documents & Credentials", owner: "Credentialing (HR)", auto: true },
    { key: "approval", label: "Final Internal Approval", owner: "Owner / HR", auto: false },
  ];
  const MKEYS = MILESTONES.map((m) => m.key);
  const APPROVAL_KEY = "approval";
  // Everything that must be done before the owner can sign the final approval.
  const PRE_APPROVAL = MILESTONES.filter((m) => m.key !== APPROVAL_KEY);
  const STATUS_LABEL = { complete: "Complete", in_progress: "In progress", pending: "Pending", overdue: "Overdue" };
  const OVERALL = [
    { key: "approved", label: "Internally approved" },
    { key: "in_progress", label: "In progress" },
    { key: "action_needed", label: "Action needed" },
    { key: "overdue", label: "Overdue" },
  ];
  const OVERALL_LABEL = Object.fromEntries(OVERALL.map((o) => [o.key, o.label]));

  // ---- payer vocabulary -----------------------------------------------------
  const PAYER_KINDS = [
    { key: "group_link", label: "Group linking" },
    { key: "credentialing", label: "Credentialing" },
  ];
  const PAYER_STATUSES = [
    { key: "not_started", label: "Not started" },
    { key: "submitted", label: "Submitted" },
    { key: "pending", label: "Pending with payer" },
    { key: "approved", label: "Approved" },
    { key: "effective", label: "Effective" },
    { key: "denied", label: "Denied / returned" },
    { key: "not_required", label: "Not required" },
  ];
  const KIND_KEYS = PAYER_KINDS.map((k) => k.key);
  const STATUS_KEYS = PAYER_STATUSES.map((s) => s.key);
  const kindLabel = (k) => (PAYER_KINDS.find((x) => x.key === k) || {}).label || k;
  const statusLabel = (k) => (PAYER_STATUSES.find((x) => x.key === k) || {}).label || k;
  // The six states the dashboard shows for LINKING specifically.
  const LINK_STATES = {
    not_required: "Not required", not_started: "Not started", submitted: "Submitted",
    pending: "Pending", linked: "Linked", action_needed: "Action needed",
  };
  const DEFAULT_PAYERS = ["Nevada Medicaid", "Tricare/TriWest", "Aetna", "Anthem BCBS", "Molina", "SilverSummit", "CareSource"];

  // ---- positions ------------------------------------------------------------
  const POSITIONS = [
    { key: "bcba", label: "BCBA" },
    { key: "rbt", label: "RBT" },
    { key: "ot", label: "OT / COTA" },
    { key: "student_analyst", label: "Student Analyst" },
    { key: "other_clinical", label: "Other clinical" },
    { key: "admin", label: "Administration" },
    { key: "unset", label: "Position not set" },
  ];
  const POSITION_LABEL = Object.fromEntries(POSITIONS.map((p) => [p.key, p.label]));
  const CLINICAL = new Set(["bcba", "rbt", "ot", "student_analyst", "other_clinical"]);
  const NON_CLINICAL = /\b(admin|administrative|administration|office|front desk|reception|billing|biller|payroll|hr\b|human resources|recruit|intake coordinator|scheduler|scheduling|marketing|accountant|bookkeep|operations|janitor|custodian|driver|assistant to)/i;
  function positionGroup(title) {
    const t = clean(title);
    if (!t) return "unset";
    if (/\bstudent\b|\btrainee\b|in[-\s]training|practicum|\bintern\b/i.test(t)) return "student_analyst";
    if (/\bbcaba\b/i.test(t)) return "other_clinical";
    if (/\bbcba\b|board certified behavior analyst|behavior analyst|clinical director/i.test(t)) return "bcba";
    if (/\brbt\b|registered behavior|behavior tech|behavior therapist|behavioral tech/i.test(t)) return "rbt";
    if (/\bcota\b|\botr?\b|occupational/i.test(t)) return "ot";
    if (NON_CLINICAL.test(t)) return "admin";
    if (/speech|\bslp\b|\blba\b|squad lead|clinical|therap|case manager/i.test(t)) return "other_clinical";
    return "admin";
  }

  // ======================= SCHEMA ============================
  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS hr_payer_enrollments (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      payer TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'credentialing',
      status TEXT NOT NULL DEFAULT 'not_started',
      submitted_date TEXT,
      pending_date TEXT,
      approved_date TEXT,
      effective_date TEXT,
      next_action_owner TEXT,
      notes TEXT,
      created_by TEXT,
      created_at TEXT,
      updated_by TEXT,
      updated_at TEXT,
      UNIQUE (employee_id, payer, kind)
    )`);
    await dbRun("CREATE INDEX IF NOT EXISTS idx_hr_payer_enr_emp ON hr_payer_enrollments(employee_id)").catch(() => {});

    await dbRun(`CREATE TABLE IF NOT EXISTS hr_onboarding_tracking (
      employee_id INTEGER PRIMARY KEY,
      coordinator TEXT,
      target_completion_date TEXT,
      created_by TEXT,
      created_at TEXT,
      updated_by TEXT,
      updated_at TEXT
    )`);
    await dbRun(`CREATE TABLE IF NOT EXISTS hr_onboarding_milestones (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      milestone_key TEXT NOT NULL,
      status TEXT,
      completed_at TEXT,
      completed_by TEXT,
      responsible TEXT,
      notes TEXT,
      due_date TEXT,
      updated_by TEXT,
      updated_at TEXT,
      UNIQUE (employee_id, milestone_key)
    )`);
    await dbRun(`CREATE TABLE IF NOT EXISTS hr_onboarding_milestone_history (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      milestone_key TEXT NOT NULL,
      change TEXT NOT NULL,
      changed_by TEXT,
      changed_at TEXT
    )`);
    await dbRun("CREATE INDEX IF NOT EXISTS idx_hr_onb_hist_emp ON hr_onboarding_milestone_history(employee_id)").catch(() => {});
    await dbRun(`CREATE TABLE IF NOT EXISTS hr_payer_linking_rules (
      payer TEXT PRIMARY KEY,
      requires_linking BOOLEAN NOT NULL DEFAULT FALSE,
      positions TEXT,
      caseload_only BOOLEAN NOT NULL DEFAULT FALSE,
      updated_by TEXT,
      updated_at TEXT
    )`);
    await dbRun(`CREATE TABLE IF NOT EXISTS credentialing_email_log (
      id SERIAL PRIMARY KEY,
      report_date TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'daily',
      recipient TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      pending_count INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT,
      updated_at TEXT
    )`);
    // THE DUPLICATE GUARD. One daily row per (day, recipient), plus the run
    // row '*' that claims the day. A second sweep, a second server, or a
    // second click fails this insert instead of sending a second email.
    await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS uq_cred_email_daily
      ON credentialing_email_log (report_date, kind, recipient) WHERE kind = 'daily'`).catch(() => {});
    await mergeVerificationMilestone();
    console.log("Credentialing tracker schema ready.");
  }

  // ONE-TIME: 'verification' was its own milestone before documents and
  // verification became one. Someone who signed verification off while a
  // document was still outstanding did so for a reason, and that reason is in
  // the note -- dropping the row would re-block their approval and lose it.
  // So a completed verification sign-off carries over to documents, but only
  // where documents has no sign-off of its own to overwrite. The old rows and
  // the whole history table are left exactly as they are.
  async function mergeVerificationMilestone() {
    if (clean(await getAppSetting("credentialing_verification_merged", "")) === "1") return;
    let rows = [];
    try {
      rows = await dbAll(
        `SELECT v.* FROM hr_onboarding_milestones v
          WHERE v.milestone_key = 'verification' AND v.status = 'complete'
            AND NOT EXISTS (SELECT 1 FROM hr_onboarding_milestones d
                             WHERE d.employee_id = v.employee_id AND d.milestone_key = 'documents'
                               AND d.status IS NOT NULL AND d.status <> '')`);
    } catch (e) { return; }
    let carried = 0, failed = 0;
    for (const v of rows) {
      const note = [clean(v.notes), "(carried over from the former Credential Verification milestone)"].filter(Boolean).join(" ");
      try {
        await dbRun(
          `INSERT INTO hr_onboarding_milestones (employee_id, milestone_key, status, completed_at, completed_by, responsible, notes, due_date, updated_by, updated_at)
           VALUES (?,'documents','complete',?,?,?,?,?,?,?)
           ON CONFLICT (employee_id, milestone_key) DO UPDATE SET status = EXCLUDED.status, completed_at = EXCLUDED.completed_at,
             completed_by = EXCLUDED.completed_by, notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
          [v.employee_id, v.completed_at || null, v.completed_by || null, clean(v.responsible) || null, note || null,
           null, "Credentialing merge", nowISO()]);
        await recordHistory(v.employee_id, "documents",
          "Credential Verification merged into Required Documents & Credentials; its completed sign-off carried over",
          "Credentialing merge").catch(() => {});
        carried++;
      } catch (e) {
        failed++;
        console.error(`Credentialing: could not carry employee ${v.employee_id}'s verification sign-off onto documents: ${e.message}`);
      }
    }
    if (carried) console.log(`Credentialing: carried ${carried} verification sign-off(s) onto Required Documents & Credentials.`);
    // Only call it done if it IS done. A one-time migration that marks itself
    // finished after failing would take those sign-offs with it, and the next
    // restart would not try again.
    if (failed) { console.error(`Credentialing: ${failed} sign-off(s) did not carry over; will try again on the next restart.`); return; }
    await setAppSetting("credentialing_verification_merged", "1").catch(() => {});
  }

  async function logActivity(employeeId, text) {
    const emp = await dbGet("SELECT hr_activity FROM hr_employees WHERE id = ?", [employeeId]).catch(() => null);
    if (!emp) return;
    let arr = [];
    try { arr = JSON.parse(emp.hr_activity || "[]"); } catch (e) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    arr.unshift({ at: nowISO(), text });
    await dbRun("UPDATE hr_employees SET hr_activity = ? WHERE id = ?", [JSON.stringify(arr.slice(0, 200)), employeeId]).catch(() => {});
  }

  // ======================= SETTINGS ===========================
  async function dueDays() {
    let v = {};
    try { v = JSON.parse((await getAppSetting("credentialing_due_days", "")) || "{}") || {}; } catch (e) { v = {}; }
    const out = {};
    MKEYS.forEach((k) => { const n = Number(v[k]); out[k] = Number.isInteger(n) && n >= 0 && n <= 365 ? n : DEFAULT_DUE_DAYS[k]; });
    return out;
  }
  async function emailSettings() {
    const raw = clean(await getAppSetting("credentialing_email_recipients", ""));
    const time = clean(await getAppSetting("credentialing_email_time", "07:00"));
    return {
      enabled: clean(await getAppSetting("credentialing_email_enabled", "1")) !== "0",
      time: /^\d{2}:\d{2}$/.test(time) ? time : "07:00",
      recipients: raw ? raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : [],
    };
  }
  // Who actually receives it: the configured list, else the Clinical Director
  // and Assistants, else the owner notification address. Never nowhere quietly.
  async function effectiveRecipients() {
    const s = await emailSettings();
    if (s.recipients.length) return { list: s.recipients, source: "configured" };
    const lead = (await leadershipEmails().catch(() => [])).filter(Boolean);
    if (lead.length) return { list: lead, source: "clinical_leadership" };
    const owner = clean(await getAppSetting("owner_notification_email", ""));
    return owner ? { list: [owner], source: "owner_notification_email" } : { list: [], source: "none" };
  }

  // ======================= PAYERS ============================
  function payerState(r, now) {
    const st = STATUS_KEYS.includes(r.status) ? r.status : "not_started";
    const eff = day(r.effective_date);
    if (st === "effective" || (st === "approved" && eff && eff <= now)) return "effective";
    return st;
  }
  function linkState(r, now) {
    if (!r) return "not_started";
    const st = payerState(r, now);
    if (st === "effective" || st === "approved") return "linked";
    if (st === "denied") return "action_needed";
    return st; // not_started | submitted | pending | not_required
  }
  function publicPayer(r, now) {
    const state = payerState(r, now);
    const since = day(r.submitted_date);
    const age = since && ["submitted", "pending"].includes(state) ? daysBetween(since, now) : null;
    return {
      id: r.id, payer: r.payer, kind: r.kind, kind_label: kindLabel(r.kind),
      status: state, status_label: statusLabel(state),
      submitted_date: day(r.submitted_date), pending_date: day(r.pending_date),
      approved_date: day(r.approved_date), effective_date: day(r.effective_date),
      days_waiting: age, slow: age != null && age > PAYER_SLOW_DAYS,
      updated_at: r.updated_at || r.created_at || null,
    };
  }
  const norm = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  // Does a client's payer name refer to this payer? Names are free text on both
  // sides ("Anthem BCBS" vs "Anthem Blue Cross"), so: either contains the
  // other, or they share their first meaningful word.
  function samePayer(a, b) {
    const x = norm(a), y = norm(b);
    if (!x || !y) return false;
    if (x.includes(y) || y.includes(x)) return true;
    const words = (s) => s.split(" ").filter((w) => w.length >= 4 && !["health", "care", "plan", "insurance"].includes(w));
    const wy = new Set(words(y));
    return words(x).some((w) => wy.has(w));
  }
  async function linkingRules() {
    const rows = await dbAll("SELECT * FROM hr_payer_linking_rules ORDER BY payer").catch(() => []);
    return rows.map((r) => {
      let positions = [];
      try { positions = JSON.parse(r.positions || "[]"); } catch (e) { positions = []; }
      return {
        payer: r.payer, requires_linking: !!r.requires_linking,
        positions: Array.isArray(positions) ? positions.filter((p) => POSITION_LABEL[p]) : [],
        caseload_only: !!r.caseload_only, updated_by: r.updated_by || null, updated_at: r.updated_at || null,
      };
    });
  }

  // ======================= THE DERIVATION ====================
  async function loadInputs() {
    const safe = (p) => p.catch(() => []);
    const [emps, apps, offers, packets, onbRecs, onbDocs, tracker, certs, creds, payers, tracking, mrows, rules, clients] = await Promise.all([
      safe(dbAll(
        `SELECT id, applicant_id, name, email, role_title, employment_type, status,
                hr_hire_date, hire_date, rethink_id, hr_availability, created_at
           FROM hr_employees
          WHERE COALESCE(status,'active') NOT IN ('terminated','archived')`)),
      safe(dbAll(
        `SELECT a.id, a.full_name, a.stage, a.assigned_manager, a.earliest_start, a.updated_at, a.created_at,
                p.title AS position_title
           FROM hr_applicants a LEFT JOIN hr_positions p ON p.id = a.position_id
          WHERE a.stage IN ('interviewed','credentials_references','offer_approval','offer_sent')`)),
      // NO comp_amount, comp_unit or comp_notes. Ever.
      safe(dbAll("SELECT id, applicant_id, job_title, start_date, supervisor FROM hr_offers ORDER BY id DESC")),
      safe(dbAll("SELECT applicant_id, status, completed_at, updated_at FROM hire_packets")),
      safe(dbAll("SELECT id, employee_id, started_at, deadline_at, docs_complete_at, status FROM onboarding_records")),
      safe(dbAll("SELECT onboarding_id, label, status, received_at FROM onboarding_documents")),
      // Status and dates only. No notes, no file.
      safe(dbAll("SELECT employee_id, doc_key, status, date_requested, date_received, updated_at FROM hr_doc_tracker")),
      safe(dbAll("SELECT employee_id, name, expiration_date, status FROM staff_certifications WHERE COALESCE(status,'active') <> 'archived'")),
      safe(dbAll("SELECT employee_id, credential_type, expiration_date, status FROM hr_employee_credentials")),
      safe(dbAll("SELECT * FROM hr_payer_enrollments ORDER BY payer, kind")),
      safe(dbAll("SELECT * FROM hr_onboarding_tracking")),
      safe(dbAll("SELECT * FROM hr_onboarding_milestones")),
      linkingRules(),
      safe(dbAll(
        `SELECT COALESCE(NULLIF(TRIM(insurance_payer),''), insurance_provider) AS payer,
                LOWER(TRIM(COALESCE(assigned_bcba_email,''))) AS bcba_email,
                LOWER(TRIM(COALESCE(assigned_bcba_name,''))) AS bcba_name,
                LOWER(TRIM(COALESCE(assigned_rbt_name,''))) AS rbt_name
           FROM clients WHERE COALESCE(stage,'') <> 'discharged'`)),
    ]);
    const stageAt = await dbAll(
      "SELECT applicant_id, MAX(changed_at) AS at FROM hr_applicant_stage_history GROUP BY applicant_id"
    ).catch(() => []);
    return { emps, apps, offers, packets, onbRecs, onbDocs, tracker, certs, creds, payers, tracking, mrows, rules, clients, stageAt };
  }

  const DOC_LABELS = {
    headshot: "Headshot", social: "Social Security card (sighted)", id: "Photo ID (sighted)",
    rbt_state: "State RBT license", rbt_national: "National RBT certification", background_check: "Background check",
  };

  function credentialCurrent(group, certs, creds, tracker, now) {
    const current = (exp) => !exp || day(exp) >= now;
    if (group === "bcba") {
      return certs.some((c) => /bcba/i.test(c.name) && !/bcaba/i.test(c.name) && current(c.expiration_date))
        || creds.some((c) => c.credential_type === "bcba" && current(c.expiration_date) && c.status !== "expired");
    }
    if (group === "rbt") {
      return certs.some((c) => /\brbt\b/i.test(c.name) && current(c.expiration_date))
        || creds.some((c) => c.credential_type === "rbt" && current(c.expiration_date) && c.status !== "expired")
        // A national RBT certificate the practice holds is one it has verified.
        || tracker.some((t) => t.doc_key === "rbt_national" && ["Received", "Verified"].includes(t.status));
    }
    if (group === "ot") return certs.some((c) => /\b(ot|otr|cota)\b|occupational/i.test(c.name) && current(c.expiration_date));
    // Students and other clinical roles: a current certification of any kind
    // on file is the most the records can say.
    return certs.some((c) => current(c.expiration_date)) || creds.some((c) => current(c.expiration_date));
  }

  // Requirements read from the records, per milestone. Each one:
  // { label, done, owner, waiting: internal|external,
  //   kind?: missing_info|doc|stale|expired|payer, payer?: <name for kind payer> }
  function requirementsFor(emp, group, idx, now) {
    const req = { hr_onboarding: [], documents: [], approval: [] };
    const packet = emp.applicant_id ? idx.packetByApp.get(emp.applicant_id) : null;
    const offer = emp.applicant_id ? idx.offerByApp.get(emp.applicant_id) : null;
    const startDate = day(emp.hr_hire_date) || day(emp.hire_date) || (offer && day(offer.start_date)) || null;

    // 1. HR onboarding
    if (!startDate) req.hr_onboarding.push({ label: "Hire date not recorded", done: false, owner: "HR", waiting: "internal", kind: "missing_info" });
    if (group === "unset") req.hr_onboarding.push({ label: "Position not recorded", done: false, owner: "HR", waiting: "internal", kind: "missing_info" });
    if (packet) req.hr_onboarding.push({ label: "Employment application & policy packet signed", done: packet.status === "completed", owner: "New hire", waiting: "external", date: day(packet.completed_at) });
    if (CLINICAL.has(group)) req.hr_onboarding.push({ label: "Rethink account set up", done: !!clean(emp.rethink_id), owner: "HR", waiting: "internal" });
    req.hr_onboarding.push({ label: "Availability submitted", done: !!clean(emp.hr_availability), owner: "New hire", waiting: "external" });

    // 2. Documents
    const onb = idx.onbByEmp.get(emp.id);
    const docs = onb ? (idx.onbDocsByRec.get(onb.id) || []) : [];
    docs.forEach((d) => req.documents.push({
      label: d.status === "needs_dates" ? `${d.label} (dates needed)` : d.label,
      done: d.status === "received", owner: "New hire", waiting: "external", kind: "doc", date: day(d.received_at),
    }));
    const tracker = (idx.trackerByEmp.get(emp.id) || []).filter((t) => !(/^rbt_/.test(t.doc_key) && group !== "rbt"));
    tracker.forEach((t) => {
      const label = DOC_LABELS[t.doc_key] || t.doc_key;
      if (t.status === "Received" || t.status === "Verified") { req.documents.push({ label, done: true, owner: "New hire", waiting: "external", date: day(t.date_received) }); return; }
      if (t.status === "Expired") { req.documents.push({ label: `${label} (expired)`, done: false, owner: "HR", waiting: "internal", kind: "expired" }); return; }
      if (t.status === "Requested") {
        const age = t.date_requested ? daysBetween(day(t.date_requested), now) : null;
        req.documents.push({ label, done: false, owner: "New hire", waiting: "external", kind: age != null && age > DOC_REQUEST_STALE_DAYS ? "stale" : "doc",
          detail: age != null ? `requested ${age} day${age === 1 ? "" : "s"} ago` : null });
        return;
      }
      req.documents.push({ label: `${label} (not yet requested)`, done: false, owner: "HR", waiting: "internal", kind: "doc" });
    });
    if (!docs.length && !tracker.length) req.documents.push({ label: "No onboarding documents requested yet", done: false, owner: "HR", waiting: "internal", kind: "doc" });

    // A document on file counts as verified, so there is no separate
    // "verified" row per document -- that only restated the line above it.
    // What a received document cannot tell us is whether the credential is
    // still in date, so that check stays, here, in the same milestone.
    if (["bcba", "rbt", "ot"].includes(group)) {
      const ok = credentialCurrent(group, idx.certsByEmp.get(emp.id) || [], idx.credsByEmp.get(emp.id) || [], tracker, now);
      const name = group === "bcba" ? "BCBA certification" : group === "rbt" ? "RBT certification" : "OT / COTA license";
      req.documents.push({ label: ok ? `${name} on file and current` : `${name} missing or expired`,
        done: ok, owner: "Credentialing (HR)", waiting: "internal", kind: ok ? null : "expired" });
    }
    return { req, startDate, offer, onb, tracker };
  }

  function employeeRow(emp, idx, now, cfg) {
    const group = positionGroup(emp.role_title);
    const tracking = idx.trackingByEmp.get(emp.id) || null;
    const stored = idx.milestonesByEmp.get(emp.id) || {};
    const status = clean(emp.status || "active").toLowerCase();
    if (status === "leave") return null;
    // WHO IS A NEW HIRE: anyone the HR Hub has as onboarding, and anyone HR has
    // put on the tracker. An established active employee is not swept in.
    if (status !== "onboarding" && !tracking && !Object.keys(stored).length) return null;

    const { req, startDate, offer, onb } = requirementsFor(emp, group, idx, now);
    const base = startDate || day(tracking && tracking.created_at) || day(emp.created_at) || now;

    // ---- payer linking ------------------------------------------------------
    // Computed before the milestones because confirmed linking is part of what
    // final approval means: an unlinked clinician cannot be billed for.
    // Payers that do not require individual linking are not tracked here at
    // all -- they used to render a row per person saying so, which was noise.
    const enr = idx.payersByEmp.get(emp.id) || [];
    const caseloadPayers = idx.caseloadFor(emp);
    const linking = [];
    cfg.rules.filter((rule) => rule.requires_linking).forEach((rule) => {
      const row = enr.find((r) => r.kind === "group_link" && samePayer(r.payer, rule.payer));
      let applicable = !rule.positions.length || rule.positions.includes(group);
      if (applicable && rule.caseload_only) applicable = caseloadPayers.some((p) => samePayer(p, rule.payer));
      const st = applicable ? (row && payerState(row, now) === "not_required" ? "not_required" : linkState(row, now)) : "not_required";
      linking.push({
        payer: rule.payer, applicable, configured: true, state: st, state_label: LINK_STATES[st],
        why: applicable ? null
          : (rule.caseload_only && (!rule.positions.length || rule.positions.includes(group)) ? "No clients with this payer on their caseload" : "Not required for this position"),
        submitted_date: row ? day(row.submitted_date) : null, confirmation_date: row ? day(row.approved_date) : null,
        effective_date: row ? day(row.effective_date) : null,
        days_waiting: row ? publicPayer(row, now).days_waiting : null, enrollment_id: row ? row.id : null,
      });
    });
    // Linking recorded against a payer nobody has configured yet still shows.
    enr.filter((r) => r.kind === "group_link" && !cfg.rules.some((rule) => samePayer(r.payer, rule.payer))).forEach((r) => {
      const st = linkState(r, now);
      linking.push({ payer: r.payer, applicable: st !== "not_required", configured: false, state: st, state_label: LINK_STATES[st], why: "Payer not yet configured",
        submitted_date: day(r.submitted_date), confirmation_date: day(r.approved_date), effective_date: day(r.effective_date),
        days_waiting: publicPayer(r, now).days_waiting, enrollment_id: r.id });
    });
    const applicable = linking.filter((l) => l.applicable && l.state !== "not_required");
    const linked = applicable.filter((l) => l.state === "linked").length;
    // WHAT GATES APPROVAL is only a payer the owner has deliberately marked as
    // requiring individual linking. A link HR recorded against a payer nobody
    // has configured still shows on the record, but it does not hold up a
    // sign-off -- otherwise noting an exploratory enrolment would quietly
    // block a new hire nobody meant to block.
    const gating = applicable.filter((l) => l.configured);

    // ---- milestone statuses -------------------------------------------------
    const ms = [];
    for (const m of MILESTONES) {
      const s = stored[m.key] || {};
      let reqs = req[m.key];
      if (m.key === APPROVAL_KEY) {
        // Final approval is held by the internal milestones AND by any payer
        // linking this position actually needs. Payer items are tagged so the
        // rest of the module can tell an internal hold from an external one.
        reqs = ms.map((p) => ({ label: `${p.label} complete`, done: p.status === "complete", owner: p.responsible, waiting: "internal" }))
          .concat(gating.map((l) => ({
            label: `${l.payer} linking confirmed`, done: l.state === "linked",
            owner: "Credentialing (HR)", waiting: "external", kind: "payer", payer: l.payer,
            detail: l.state === "linked" ? null
              : l.days_waiting != null ? `${l.state_label.toLowerCase()}, ${l.days_waiting} day${l.days_waiting === 1 ? "" : "s"} waiting`
              : l.state_label.toLowerCase(),
          })));
      }
      const open = reqs.filter((r) => !r.done);
      const due = isDate(s.due_date) ? s.due_date : addDays(base, cfg.dueDays[m.key]);
      let st, completedAt = null, completedBy = null, auto = false;
      if (s.status === "complete") { st = "complete"; completedAt = s.completed_at || null; completedBy = s.completed_by || null; }
      else if (!s.status && m.auto && reqs.length && !open.length) {
        st = "complete"; auto = true;
        completedAt = reqs.map((r) => r.date).filter(Boolean).sort().pop() || null; completedBy = "HR records";
      } else if (due && due < now) st = "overdue";
      else if (s.status === "in_progress" || reqs.some((r) => r.done)) st = "in_progress";
      else st = "pending";
      // Approval is ready to sign the moment nothing is outstanding.
      if (m.key === APPROVAL_KEY && st === "pending" && !open.length) st = "in_progress";
      ms.push({
        key: m.key, label: m.label, status: st, status_label: STATUS_LABEL[st],
        auto_complete: auto, sign_off_required: !m.auto,
        completed_at: completedAt, completed_by: completedBy,
        responsible: clean(s.responsible) || (m.key === "hr_onboarding" || m.key === "documents" ? clean(tracking && tracking.coordinator) || m.owner : m.owner),
        notes: clean(s.notes) || null,
        due_date: due, due_overridden: isDate(s.due_date),
        requirements: reqs.map((r) => ({ label: r.label, done: !!r.done, owner: r.owner, waiting: r.waiting, kind: r.kind || null, payer: r.payer || null, detail: r.detail || null })),
        missing: open.map((r) => r.label + (r.detail ? ` (${r.detail})` : "")),
        updated_at: s.updated_at || null, updated_by: s.updated_by || null,
      });
    }
    const done = ms.filter((m) => m.status === "complete").length;
    const approval = ms.find((m) => m.key === APPROVAL_KEY);
    const approved = approval.status === "complete";
    if (approved && approval.completed_at && daysBetween(day(approval.completed_at), now) > APPROVED_VISIBLE_DAYS && status === "active") return null;

    // ---- overall status ------------------------------------------------------
    const target = isDate(tracking && tracking.target_completion_date) ? tracking.target_completion_date : approval.due_date;
    const allOpen = PRE_APPROVAL.flatMap((m) => req[m.key]).filter((r) => !r.done);
    const reasons = [];
    allOpen.forEach((r) => {
      if (r.kind === "missing_info") reasons.push(r.label);
      if (r.kind === "expired") reasons.push(r.label);
      if (r.kind === "stale") reasons.push(`${r.label} ${r.detail}`);
    });
    // A payer that has sat on a submission is worth chasing; a payer that was
    // submitted last week is not something anyone here can act on.
    gating.forEach((l) => {
      if (l.state !== "linked" && l.days_waiting != null && l.days_waiting > PAYER_SLOW_DAYS) {
        reasons.push(`${l.payer} linking still unconfirmed after ${l.days_waiting} days`);
      }
    });
    if (!approved && !approval.missing.length) reasons.push("Ready for final internal approval");
    let overall;
    if (approved) overall = "approved";
    else if (ms.some((m) => m.status === "overdue") || (target && target < now)) overall = "overdue";
    else if (reasons.length) overall = "action_needed";
    else overall = "in_progress";

    const current = ms.find((m) => m.status !== "complete") || null;
    const nextReq = current ? current.requirements.find((r) => !r.done) : null;
    const next = current ? {
      label: current.key === "approval" && !current.missing.length ? "Give final internal approval"
        : nextReq ? nextReq.label : `Sign off ${current.label.toLowerCase()}`,
      owner: nextReq && nextReq.owner && current.key !== "approval" ? nextReq.owner : current.responsible,
      milestone: current.label,
    } : null;

    // ---- readiness per payer ------------------------------------------------
    // Approval now covers documents, credentials and linking, so saying
    // "internal approval" next to "Aetna linking" when the only thing holding
    // approval IS the Aetna linking just states one fact twice. Each payer
    // reports the specific thing in its way and nothing more.
    const credOk = CLINICAL.has(group)
      ? credentialCurrent(group, idx.certsByEmp.get(emp.id) || [], idx.credsByEmp.get(emp.id) || [], idx.trackerByEmp.get(emp.id) || [], now)
      : false;
    const approvalOpen = approval.requirements.filter((r) => !r.done);
    const readiness = CLINICAL.has(group) ? cfg.rules.filter((rule) => rule.requires_linking).map((rule) => {
      const l = linking.find((x) => x.payer === rule.payer);
      const pending = !!(l && l.applicable && l.state !== "linked" && l.state !== "not_required");
      const otherHolds = approvalOpen.filter((r) => !(r.kind === "payer" && samePayer(r.payer, rule.payer)));
      const missing = [];
      if (pending) missing.push(`${rule.payer} linking`);
      if (!approved && (otherHolds.length || !pending)) missing.push("Internal approval");
      if (!credOk) missing.push("Current credential on file");
      return { payer: rule.payer, ready: !missing.length, missing };
    }) : [];

    const daysIn = daysBetween(base, now);
    return {
      key: "emp-" + emp.id, employee_id: emp.id, name: emp.name,
      position: clean(emp.role_title) || (offer && offer.job_title) || "Position not set",
      position_group: group, position_group_label: POSITION_LABEL[group], clinical: CLINICAL.has(group),
      employment_status: status,
      hire_date: startDate, expected_start_date: startDate, target_completion_date: target,
      target_overridden: isDate(tracking && tracking.target_completion_date),
      coordinator: clean(tracking && tracking.coordinator) || null,
      days_in_onboarding: daysIn != null && daysIn >= 0 ? daysIn : 0,
      milestones: ms, milestones_done: done, milestones_total: MILESTONES.length,
      progress: Math.round((done / MILESTONES.length) * 100),
      current_stage: current ? current.label : "Internally approved",
      status: overall, status_label: OVERALL_LABEL[overall], attention: reasons,
      approved, approved_at: approved ? approval.completed_at : null, approved_by: approved ? approval.completed_by : null,
      next_action: next,
      payer_linking: linking,
      payer_progress: applicable.length ? { linked, total: applicable.length, label: `${linked} of ${applicable.length} linked` } : { linked: 0, total: 0, label: "N/A" },
      readiness,
      onboarding_portal: onb ? { deadline: day(onb.deadline_at) } : null,
    };
  }

  const STAGE_LABELS = { interviewed: "Interviewed", credentials_references: "Credentials & references", offer_approval: "Offer approval", offer_sent: "Offer sent" };
  function candidateRow(a, idx, now) {
    const offer = idx.offerByApp.get(a.id) || null;
    const since = idx.stageAtByApp.get(a.id) || a.updated_at || a.created_at;
    const group = positionGroup(a.position_title);
    return {
      key: "app-" + a.id, applicant_id: a.id, name: a.full_name,
      position: clean(a.position_title) || (offer && offer.job_title) || "Position not set",
      position_group: group, position_group_label: POSITION_LABEL[group],
      stage: STAGE_LABELS[a.stage] || a.stage,
      days_in_stage: since ? daysBetween(day(since), now) : null,
      proposed_start: (offer && day(offer.start_date)) || (isDate(day(a.earliest_start)) ? day(a.earliest_start) : null),
      owner: clean(a.assigned_manager) || "HR",
    };
  }

  async function progression() {
    const now = today();
    const inp = await loadInputs();
    const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
    const idx = {
      offerByApp: new Map(), packetByApp: new Map(), onbByEmp: new Map(), onbDocsByRec: new Map(),
      trackerByEmp: new Map(), payersByEmp: new Map(), stageAtByApp: new Map(), certsByEmp: new Map(),
      credsByEmp: new Map(), trackingByEmp: new Map(), milestonesByEmp: new Map(),
    };
    inp.offers.forEach((o) => { if (!idx.offerByApp.has(o.applicant_id)) idx.offerByApp.set(o.applicant_id, o); });
    inp.packets.forEach((p) => idx.packetByApp.set(p.applicant_id, p));
    inp.onbRecs.forEach((r) => idx.onbByEmp.set(r.employee_id, r));
    inp.onbDocs.forEach((d) => push(idx.onbDocsByRec, d.onboarding_id, d));
    inp.tracker.forEach((t) => push(idx.trackerByEmp, t.employee_id, t));
    inp.payers.forEach((p) => push(idx.payersByEmp, p.employee_id, p));
    inp.certs.forEach((c) => push(idx.certsByEmp, c.employee_id, c));
    inp.creds.forEach((c) => push(idx.credsByEmp, c.employee_id, c));
    inp.tracking.forEach((t) => idx.trackingByEmp.set(t.employee_id, t));
    inp.mrows.forEach((m) => { if (!idx.milestonesByEmp.has(m.employee_id)) idx.milestonesByEmp.set(m.employee_id, {}); idx.milestonesByEmp.get(m.employee_id)[m.milestone_key] = m; });
    inp.stageAt.forEach((s) => idx.stageAtByApp.set(s.applicant_id, s.at));
    idx.caseloadFor = (emp) => {
      const em = clean(emp.email).toLowerCase(), nm = clean(emp.name).toLowerCase();
      return inp.clients.filter((c) => c.payer && ((em && c.bcba_email === em) || (nm && (c.bcba_name === nm || c.rbt_name === nm)))).map((c) => c.payer);
    };
    const cfg = { dueDays: await dueDays(), rules: inp.rules };

    const people = [];
    inp.emps.forEach((e) => { const r = employeeRow(e, idx, now, cfg); if (r) people.push(r); });
    const rank = { overdue: 0, action_needed: 1, in_progress: 2, approved: 3 };
    people.sort((a, b) => rank[a.status] - rank[b.status]
      || String(a.target_completion_date || "9999").localeCompare(String(b.target_completion_date || "9999"))
      || String(a.name).localeCompare(String(b.name)));
    const hired = new Set(inp.emps.map((e) => e.applicant_id).filter(Boolean));
    const candidates = inp.apps.filter((a) => !hired.has(a.id)).map((a) => candidateRow(a, idx, now));

    const count = (k) => people.filter((p) => p.status === k).length;
    const cutoff = Date.now() - 24 * 3600 * 1000;
    return {
      generated_at: nowISO(), today: now,
      summary: {
        total: people.length, approved: count("approved"), in_progress: count("in_progress"),
        action_needed: count("action_needed"), overdue: count("overdue"),
        pending_approval: people.filter((p) => !p.approved).length,
        approved_last_24h: people.filter((p) => p.approved && p.approved_at && Date.parse(p.approved_at) >= cutoff).length,
      },
      people, candidates,
      milestones: MILESTONES.map((m) => ({ key: m.key, label: m.label, sign_off_required: !m.auto })),
      statuses: OVERALL, positions: POSITIONS.filter((p) => people.some((x) => x.position_group === p.key)),
      coordinators: [...new Set(people.map((p) => p.coordinator).filter(Boolean))].sort(),
      payers_configured: inp.rules.filter((r) => r.requires_linking).length,
      due_days: cfg.dueDays,
    };
  }

  // ======================= MILESTONE WRITES ====================
  async function recordHistory(empId, key, change, who) {
    await dbRun("INSERT INTO hr_onboarding_milestone_history (employee_id, milestone_key, change, changed_by, changed_at) VALUES (?,?,?,?,?)",
      [empId, key, change, who, nowISO()]);
  }
  async function personRow(empId) {
    const d = await progression();
    return d.people.find((p) => p.employee_id === empId) || null;
  }

  async function updateMilestone(user, empId, key, b) {
    const who = user.name || user.email || "HR";
    const label = (MILESTONES.find((m) => m.key === key) || {}).label;
    const before = await dbGet("SELECT * FROM hr_onboarding_milestones WHERE employee_id = ? AND milestone_key = ?", [empId, key]);
    const person = await personRow(empId);
    if (!person) return { status: 404, error: "This employee is not on the credentialing tracker." };
    const cur = person.milestones.find((m) => m.key === key);
    const next = {
      status: before ? before.status : null, completed_at: before ? before.completed_at : null, completed_by: before ? before.completed_by : null,
      responsible: before ? before.responsible : null, notes: before ? before.notes : null, due_date: before ? before.due_date : null,
    };
    const changes = [];
    if (b.status !== undefined) {
      const st = b.status === "auto" || b.status === null || b.status === "" ? null : clean(b.status);
      if (st !== null && !["complete", "in_progress", "pending"].includes(st)) return { status: 400, error: "Status must be complete, in progress, pending, or follow the records." };
      if (st === "complete") {
        if (key === APPROVAL_KEY) {
          const blockers = person.milestones.filter((m) => m.key !== APPROVAL_KEY && m.status !== "complete");
          if (blockers.length) return { status: 400, error: `Final approval needs ${blockers.map((m) => m.label).join(", ")} complete first.` };
          // Payer linking holds approval too, but an insurer sitting on a
          // submission is not the new hire's fault and not something HR can
          // finish. The owner can still approve over it, on the record, with
          // a note saying why -- which the history keeps.
          const payerOpen = cur.requirements.filter((r) => !r.done && r.kind === "payer");
          if (payerOpen.length && !clean(b.notes !== undefined ? b.notes : next.notes)) {
            return { status: 400, error: `Payer linking is not confirmed yet: ${payerOpen.map((r) => r.label).join("; ")}. Add a note explaining why final approval is being given anyway.` };
          }
        } else if (cur.missing.length && !clean(b.notes !== undefined ? b.notes : next.notes)) {
          return { status: 400, error: `Still outstanding in the records: ${cur.missing.join("; ")}. Add a note explaining why it is complete anyway.` };
        }
        if (next.status !== "complete") { next.completed_at = nowISO(); next.completed_by = who; }
      } else { next.completed_at = null; next.completed_by = null; }
      if (st !== next.status) changes.push(`status ${next.status || "follow records"} → ${st || "follow records"}`);
      next.status = st;
    }
    if (b.responsible !== undefined) {
      const v = clean(b.responsible).slice(0, 120) || null;
      if (v !== next.responsible) changes.push(`responsible → ${v || "default"}`);
      next.responsible = v;
    }
    if (b.notes !== undefined) {
      const v = clean(b.notes).slice(0, 2000) || null;
      if (v !== next.notes) changes.push("notes updated");
      next.notes = v;
    }
    if (b.due_date !== undefined) {
      const v = clean(b.due_date) || null;
      if (v && !isDate(v)) return { status: 400, error: "Due date must be a calendar date (YYYY-MM-DD)." };
      if (v !== next.due_date) changes.push(`due date → ${v || "default"}`);
      next.due_date = v;
    }
    if (!changes.length) return { status: 200, ok: true, unchanged: true };
    await dbRun(
      `INSERT INTO hr_onboarding_milestones (employee_id, milestone_key, status, completed_at, completed_by, responsible, notes, due_date, updated_by, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (employee_id, milestone_key) DO UPDATE SET status = EXCLUDED.status, completed_at = EXCLUDED.completed_at,
         completed_by = EXCLUDED.completed_by, responsible = EXCLUDED.responsible, notes = EXCLUDED.notes,
         due_date = EXCLUDED.due_date, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      [empId, key, next.status, next.completed_at, next.completed_by, next.responsible, next.notes, next.due_date, who, nowISO()]);
    await ensureTracked(empId, who);
    await recordHistory(empId, key, changes.join("; "), who);
    await logActivity(empId, `Credentialing — ${label}: ${changes.join("; ")} (by ${who}).`);
    return { status: 200, ok: true };
  }

  async function ensureTracked(empId, who) {
    await dbRun(
      `INSERT INTO hr_onboarding_tracking (employee_id, created_by, created_at, updated_by, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT (employee_id) DO NOTHING`, [empId, who, nowISO(), who, nowISO()]);
  }

  // ======================= THE DAILY EMAIL =====================
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const longDate = (iso) => { const p = String(iso).split("-"); return `${MONTHS[+p[1] - 1]} ${+p[2]}, ${p[0]}`; };
  const shortD = (iso) => { if (!iso) return "—"; const p = String(iso).slice(0, 10).split("-"); return `${MONTHS[+p[1] - 1].slice(0, 3)} ${+p[2]}, ${p[0]}`; };
  const TONE = {
    complete: ["#dcfce7", "#166534"], approved: ["#dcfce7", "#166534"], in_progress: ["#dbeafe", "#1e40af"],
    pending: ["#fef3c7", "#92400e"], action_needed: ["#fef3c7", "#92400e"], overdue: ["#fee2e2", "#991b1b"],
  };
  const pill = (k, label) => { const t = TONE[k] || TONE.pending; return `<span style="display:inline-block;padding:2px 9px;border-radius:999px;background:${t[0]};color:${t[1]};font-size:12px;font-weight:700;white-space:nowrap;">${escH(label)}</span>`; };

  // The pending list: active new hires who are not internally approved yet.
  const pendingPeople = (data) => data.people.filter((p) => !p.approved);

  function actionGroups(pending) {
    const g = { docs: [], payer: [], approval: [], overdue: [], info: [] };
    pending.forEach((p) => {
      const byKey = (k) => p.milestones.find((m) => m.key === k) || { status: "pending", requirements: [], missing: [] };
      const hr = byKey("hr_onboarding"), docs = byKey("documents"), appr = byKey(APPROVAL_KEY);
      const info = [...hr.requirements, ...docs.requirements].filter((r) => !r.done && /not recorded/.test(r.label));
      if (info.length) g.info.push({ p, what: info.map((r) => r.label).join("; "), who: "HR" });
      if (p.status === "overdue") g.overdue.push({ p, what: `Target ${shortD(p.target_completion_date)} — ${p.next_action ? p.next_action.label : "finish onboarding"}`, who: p.next_action ? p.next_action.owner : "HR" });
      const payerOpen = appr.requirements.filter((r) => !r.done && r.kind === "payer");
      if (docs.status !== "complete") g.docs.push({ p, what: docs.missing.join("; ") || "Sign off required documents", who: docs.responsible });
      else if (payerOpen.length) g.payer.push({ p, what: payerOpen.map((r) => r.label + (r.detail ? ` (${r.detail})` : "")).join("; "), who: appr.responsible });
      else if (appr.status !== "complete" && hr.status === "complete") g.approval.push({ p, what: "Give final internal approval", who: appr.responsible });
    });
    return g;
  }

  // What is actually outstanding for one person. Final approval's own
  // requirements restate the milestones above it -- listing "Required
  // Documents & Credentials complete" as an outstanding item next to the
  // document that is actually missing says the same thing twice and reads
  // like a contradiction. So approval contributes only what is new: the
  // payer linking nobody here can finish.
  const outstanding = (p) => p.milestones
    .filter((m) => m.status !== "complete")
    .flatMap((m) => (m.key !== APPROVAL_KEY ? m.missing
      : m.requirements.filter((r) => !r.done && r.kind === "payer").map((r) => r.label + (r.detail ? ` (${r.detail})` : ""))));

  function buildEmail(data, reportDate) {
    const pending = pendingPeople(data);
    const s = data.summary;
    const recent = data.people.filter((p) => p.approved && p.approved_at && Date.parse(p.approved_at) >= Date.now() - 24 * 3600 * 1000);
    const card = (n, label, color) => `<td style="padding:4px;" width="20%"><div style="background:#f7f8fb;border-radius:12px;padding:12px 6px;text-align:center;">
      <div style="font-size:24px;font-weight:800;color:${color};line-height:1.1;">${n}</div>
      <div style="font-size:11px;color:#6b6a86;margin-top:4px;">${label}</div></div></td>`;
    const th = (t) => `<th align="left" style="padding:7px 8px;font-size:11px;color:#6b6a86;text-transform:uppercase;letter-spacing:.03em;border-bottom:1px solid #e5e7eb;">${t}</th>`;
    const td = (t) => `<td style="padding:8px;font-size:13px;border-bottom:1px solid #f0f0f4;vertical-align:top;">${t}</td>`;
    const rows = pending.map((p) => `<tr>
      ${td(`<strong>${escH(p.name)}</strong><br><span style="color:#6b6a86;font-size:12px;">${escH(p.position)}</span>`)}
      ${td(`${escH(shortD(p.hire_date))}<br><span style="color:#6b6a86;font-size:12px;">${p.days_in_onboarding} day${p.days_in_onboarding === 1 ? "" : "s"} pending</span>`)}
      ${td(`${escH(p.current_stage)}<br><span style="color:#6b6a86;font-size:12px;">${p.milestones_done} of ${p.milestones_total} milestones</span>`)}
      ${td(escH(outstanding(p).slice(0, 4).join("; ") || (p.next_action ? p.next_action.label : "—")))}
      ${td(escH(p.next_action ? p.next_action.owner : "HR"))}
      ${td(`${escH(shortD(p.target_completion_date))}<br>${pill(p.status, p.status === "overdue" ? "Overdue" : p.status_label)}`)}
    </tr>`).join("");
    const g = actionGroups(pending);
    const groupHtml = (title, list, tone) => list.length ? `<div style="margin:12px 0 4px;font-weight:700;color:${tone};font-size:14px;">${title} (${list.length})</div>
      <ul style="margin:0 0 6px 18px;padding:0;">${list.map((x) => `<li style="margin:3px 0;font-size:13px;"><strong>${escH(x.p.name)}</strong> — ${escH(x.what)} <span style="color:#6b6a86;">· ${escH(x.who)}</span></li>`).join("")}</ul>` : "";
    const link = `${APP_BASE_URL}/#/credentialing`;
    return `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#1b2a6b;">
        <div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#6b6a86;">Daily new hire onboarding status</div>
        <div style="font-size:21px;font-weight:800;margin:2px 0 12px;">${escH(longDate(reportDate))}</div>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-bottom:14px;"><tr>
          ${card(s.total, "Active new hires", "#1b2a6b")}${card(s.pending_approval, "Pending approval", "#1e40af")}
          ${card(s.action_needed, "Needing action", "#b45309")}${card(s.overdue, "Overdue", "#b91c1c")}
          ${card(s.approved_last_24h, "Approved (24h)", "#15803d")}
        </tr></table>
        <div style="font-size:16px;font-weight:800;margin:18px 0 6px;">Pending internal onboarding</div>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
          <tr>${th("Employee")}${th("Hire date")}${th("Stage")}${th("Outstanding")}${th("Responsible")}${th("Target")}</tr>${rows}
        </table>
        <div style="font-size:16px;font-weight:800;margin:20px 0 2px;">Action required</div>
        ${groupHtml("Past their target completion date", g.overdue, "#b91c1c")}
        ${groupHtml("Missing required documentation", g.docs, "#b45309")}
        ${groupHtml("Waiting on insurance payer linking", g.payer, "#1e40af")}
        ${groupHtml("Waiting for final internal approval", g.approval, "#1e40af")}
        ${groupHtml("Missing information needed to move forward", g.info, "#b45309")}
        ${recent.length ? `<div style="font-size:16px;font-weight:800;margin:20px 0 6px;">Approved in the last 24 hours</div>
          <ul style="margin:0 0 6px 18px;padding:0;">${recent.map((p) => `<li style="font-size:13px;margin:3px 0;">${pill("approved", "Approved")} <strong>${escH(p.name)}</strong> — ${escH(p.position)}</li>`).join("")}</ul>` : ""}
        <p style="text-align:center;margin:26px 0 8px;">
          <a href="${escH(link)}" style="background:#1b2a6b;color:#ffffff;font-weight:700;text-decoration:none;padding:12px 24px;border-radius:999px;font-size:14px;display:inline-block;">View Credentialing Dashboard</a>
        </p>
        <p style="font-size:11px;color:#6b6a86;text-align:center;margin:0;">Sign-in required. Confirmed payer linking is part of final internal approval.</p>
      </div>`;
  }
  const subjectFor = (date) => `Spectrum Squad | Daily New Hire Onboarding Status — ${longDate(date)}`;

  async function claimDaily(date, recipient, status, extra) {
    const row = await dbGet(
      `INSERT INTO credentialing_email_log (report_date, kind, recipient, status, reason, pending_count, attempts, created_at, updated_at)
       VALUES (?, 'daily', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (report_date, kind, recipient) WHERE kind = 'daily' DO NOTHING RETURNING id`,
      [date, recipient, status, (extra && extra.reason) || null, (extra && extra.pending) != null ? extra.pending : null,
       recipient === "*" ? 0 : 1, nowISO(), nowISO()]);
    return row ? row.id : null;
  }
  async function setLog(id, fields) {
    const keys = Object.keys(fields);
    await dbRun(`UPDATE credentialing_email_log SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
      [...keys.map((k) => fields[k]), nowISO(), id]);
  }
  async function deliver(id, to, subject, html) {
    if (!sendEmail) { await setLog(id, { status: "failed", error: "No email sender configured" }); return "failed"; }
    let r;
    try { r = await sendEmail({ to, subject, html, type: "credentialing_daily", clientId: null }); }
    catch (e) { r = { delivered: "failed", errorMsg: e.message }; }
    const st = r.delivered === "sent" ? "sent" : r.delivered === "simulated" ? "simulated" : "failed";
    await setLog(id, { status: st, error: r.errorMsg ? String(r.errorMsg).slice(0, 500) : null });
    return st;
  }

  // Run the day's report. The '*' row claims the day: whoever inserts it runs,
  // everybody else (another sweep, another instance) stops.
  async function runDaily(trigger) {
    const date = today();
    const data = await progression();
    const pending = pendingPeople(data);
    const runId = await claimDaily(date, "*", "running", { reason: `trigger: ${trigger || "schedule"}`, pending: pending.length });
    if (!runId) return { ran: false, reason: "already_ran_today", date };
    if (!pending.length) {
      await setLog(runId, { status: "skipped", reason: "No active new hire has incomplete internal onboarding." });
      return { ran: true, sent: 0, status: "skipped", date };
    }
    const { list } = await effectiveRecipients();
    if (!list.length) {
      await setLog(runId, { status: "failed", reason: "No recipients configured.", error: "No recipients configured" });
      console.error("[credentialing] daily email has no recipients -- set them in Credentialing > Settings.");
      return { ran: true, sent: 0, status: "failed", date, error: "no_recipients" };
    }
    const subject = subjectFor(date), html = buildEmail(data, date);
    const results = [];
    for (const to of list) {
      const id = await claimDaily(date, to.toLowerCase(), "sending", { pending: pending.length });
      if (!id) continue;
      results.push(await deliver(id, to, subject, html));
    }
    const failed = results.filter((r) => r === "failed").length;
    const status = failed ? (failed === results.length ? "failed" : "partial") : results.every((r) => r === "simulated") ? "simulated" : "sent";
    await setLog(runId, { status, reason: `${results.length - failed} of ${results.length} delivered` });
    return { ran: true, sent: results.length - failed, failed, status, date };
  }

  // Retry: only recipients with no successful row today. A delivered email is
  // never sent again; a failed one is claimed (failed -> sending) before resending.
  async function retryDaily() {
    const date = today();
    const run = await dbGet("SELECT * FROM credentialing_email_log WHERE report_date = ? AND kind = 'daily' AND recipient = '*'", [date]);
    if (!run) return { status: 400, error: "Today's report has not run yet." };
    if (run.status === "skipped") return { status: 400, error: "Today's report was skipped: nobody had pending onboarding." };
    const data = await progression();
    const subject = subjectFor(date), html = buildEmail(data, date);
    const { list } = await effectiveRecipients();
    const out = [];
    for (const to of list.map((x) => x.toLowerCase())) {
      const row = await dbGet("SELECT * FROM credentialing_email_log WHERE report_date = ? AND kind = 'daily' AND recipient = ?", [date, to]);
      let id = null;
      if (!row) id = await claimDaily(date, to, "sending", { pending: pendingPeople(data).length });
      else if (row.status === "failed") {
        const c = await dbGet("UPDATE credentialing_email_log SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'failed' RETURNING id", [nowISO(), row.id]);
        id = c ? c.id : null;
      }
      if (id) out.push({ to, status: await deliver(id, to, subject, html) });
    }
    const rows = await dbAll("SELECT status FROM credentialing_email_log WHERE report_date = ? AND kind = 'daily' AND recipient <> '*'", [date]);
    const failed = rows.filter((r) => r.status === "failed").length;
    await setLog(run.id, { status: failed ? "partial" : rows.every((r) => r.status === "simulated") ? "simulated" : "sent", reason: `${rows.length - failed} of ${rows.length} delivered (after retry)` });
    return { status: 200, ok: true, retried: out };
  }

  // Called every few minutes by the server. Cheap when not due.
  async function dailySweep(at) {
    const s = await emailSettings();
    if (!s.enabled) return { ran: false, reason: "disabled" };
    if (!isDue(at || new Date(), s.time)) return { ran: false, reason: "not_yet" };
    const done = await dbGet("SELECT id FROM credentialing_email_log WHERE report_date = ? AND kind = 'daily' AND recipient = '*'", [pacific(at || new Date()).date]);
    if (done) return { ran: false, reason: "already_ran_today" };
    return await runDaily("schedule");
  }

  // ======================= ROUTES ============================
  async function canSee(user) {
    if (!user) return false;
    if (hrCanManage(user)) return true;
    return await isClinicalLead(user);
  }
  async function isDesignatedLead(user) {
    if (!user || !user.email) return false;
    const mine = clean(user.email).toLowerCase();
    const l = await leadership().catch(() => null);
    if (!l) return false;
    if (l.clinical_director && clean(l.clinical_director.email).toLowerCase() === mine) return true;
    if ((l.assistants || []).some((a) => clean(a.email).toLowerCase() === mine)) return true;
    if (l.from_setting && clean(l.from_setting).toLowerCase() === mine) return true;
    return false;
  }

  function cleanPayerBody(b, partial) {
    const out = {};
    const err = (m) => ({ error: m });
    if (!partial || b.payer !== undefined) {
      const payer = clean(b.payer).slice(0, 120);
      if (!payer) return err("Payer is required.");
      out.payer = payer;
    }
    if (!partial || b.kind !== undefined) {
      const kind = clean(b.kind || "credentialing");
      if (!KIND_KEYS.includes(kind)) return err("Type must be group linking or credentialing.");
      out.kind = kind;
    }
    if (!partial || b.status !== undefined) {
      const st = clean(b.status || "not_started");
      if (!STATUS_KEYS.includes(st)) return err("That is not a payer enrollment status.");
      out.status = st;
    }
    for (const f of ["submitted_date", "pending_date", "approved_date", "effective_date"]) {
      if (b[f] === undefined) continue;
      const v = clean(b[f]);
      if (v && !isDate(v)) return err("Dates must be calendar dates (YYYY-MM-DD).");
      out[f] = v || null;
    }
    if (b.next_action_owner !== undefined) out.next_action_owner = clean(b.next_action_owner).slice(0, 120) || null;
    if (b.notes !== undefined) out.notes = clean(b.notes).slice(0, 2000) || null;
    const st = out.status, eff = out.effective_date;
    if (st === "effective" && b.effective_date !== undefined && !eff) return err("An effective enrollment needs its effective date.");
    return out;
  }

  // The dashboard payload for a viewer. Milestone notes are written for this
  // tracker and are shown to clinical leadership; everything else is allowlisted
  // in employeeRow already.
  async function viewFor(user) {
    const out = await progression();
    out.visible = true;
    out.can_edit = hrCanManage(user);
    out.can_configure = canConfigure(user);
    return out;
  }

  async function handleApi(req, res, pathname, method, query, user) {
    const mine = pathname.startsWith("/api/staff-progression") || pathname.startsWith("/api/payer-enrollments") || pathname.startsWith("/api/credentialing");
    if (!mine) return false;
    if (!user) { json(res, 401, { error: "Not signed in" }); return true; }
    const who = user.name || user.email || "HR";

    // ---- the dashboard widget (compact) and the full dashboard -------------
    if ((pathname === "/api/staff-progression" || pathname === "/api/credentialing") && method === "GET") {
      if (!(await canSee(user))) { json(res, 403, { error: "Not permitted", visible: false }); return true; }
      if (query && query.surface === "admin" && !(await isDesignatedLead(user))) { json(res, 200, { visible: false }); return true; }
      json(res, 200, await viewFor(user));
      return true;
    }

    // ---- one employee: detail with the change history ----------------------
    let m = pathname.match(/^\/api\/credentialing\/employees\/(\d+)$/);
    if (m && method === "GET") {
      if (!(await canSee(user))) { json(res, 403, { error: "Not permitted" }); return true; }
      const empId = Number(m[1]);
      const p = await personRow(empId);
      if (!p) { json(res, 404, { error: "Not on the credentialing tracker." }); return true; }
      const hist = await dbAll("SELECT milestone_key, change, changed_by, changed_at FROM hr_onboarding_milestone_history WHERE employee_id = ? ORDER BY id DESC LIMIT 100", [empId]).catch(() => []);
      json(res, 200, { person: p, history: hist, can_edit: hrCanManage(user) });
      return true;
    }
    if (m && method === "PATCH") {
      if (!hrCanManage(user)) { json(res, 403, { error: "Only HR can change onboarding records." }); return true; }
      const empId = Number(m[1]);
      const emp = await dbGet("SELECT id FROM hr_employees WHERE id = ?", [empId]);
      if (!emp) { json(res, 404, { error: "Employee not found." }); return true; }
      const b = await readBody(req);
      await ensureTracked(empId, who);
      const sets = [], vals = [], changes = [];
      if (b.coordinator !== undefined) { const v = clean(b.coordinator).slice(0, 120) || null; sets.push("coordinator = ?"); vals.push(v); changes.push(`coordinator → ${v || "none"}`); }
      if (b.target_completion_date !== undefined) {
        const v = clean(b.target_completion_date) || null;
        if (v && !isDate(v)) { json(res, 400, { error: "Target date must be YYYY-MM-DD." }); return true; }
        sets.push("target_completion_date = ?"); vals.push(v); changes.push(`target date → ${v || "default"}`);
      }
      if (sets.length) {
        await dbRun(`UPDATE hr_onboarding_tracking SET ${sets.join(", ")}, updated_by = ?, updated_at = ? WHERE employee_id = ?`, [...vals, who, nowISO(), empId]);
        await recordHistory(empId, "tracking", changes.join("; "), who);
        await logActivity(empId, `Credentialing: ${changes.join("; ")} (by ${who}).`);
      }
      json(res, 200, { ok: true, person: await personRow(empId) });
      return true;
    }

    // ---- put an employee on the tracker -------------------------------------
    if (pathname === "/api/credentialing/track" && method === "POST") {
      if (!hrCanManage(user)) { json(res, 403, { error: "Only HR can change onboarding records." }); return true; }
      const b = await readBody(req);
      const empId = Number(b.employee_id);
      const emp = Number.isInteger(empId) && empId > 0 ? await dbGet("SELECT id, name FROM hr_employees WHERE id = ? AND COALESCE(status,'active') NOT IN ('terminated','archived')", [empId]) : null;
      if (!emp) { json(res, 404, { error: "Employee not found." }); return true; }
      await ensureTracked(empId, who);
      await recordHistory(empId, "tracking", "added to the credentialing tracker", who);
      json(res, 200, { ok: true, person: await personRow(empId) });
      return true;
    }
    if (pathname === "/api/credentialing/trackable" && method === "GET") {
      if (!hrCanManage(user)) { json(res, 403, { error: "Not permitted" }); return true; }
      const rows = await dbAll(
        `SELECT e.id, e.name, e.role_title, COALESCE(NULLIF(e.hr_hire_date,''), NULLIF(e.hire_date,'')) AS hire_date
           FROM hr_employees e LEFT JOIN hr_onboarding_tracking t ON t.employee_id = e.id
          WHERE t.employee_id IS NULL AND COALESCE(e.status,'active') NOT IN ('terminated','archived','onboarding','leave')
          ORDER BY COALESCE(NULLIF(e.hr_hire_date,''), NULLIF(e.hire_date,''), e.created_at) DESC NULLS LAST LIMIT 200`).catch(() => []);
      json(res, 200, { employees: rows.map((r) => ({ id: r.id, name: r.name, position: r.role_title || null, hire_date: day(r.hire_date) })) });
      return true;
    }

    // ---- milestone updates ---------------------------------------------------
    m = pathname.match(/^\/api\/credentialing\/employees\/(\d+)\/milestones\/([a-z_]+)$/);
    if (m && method === "PATCH") {
      if (!hrCanManage(user)) { json(res, 403, { error: "Only HR can change onboarding milestones." }); return true; }
      if (!MKEYS.includes(m[2])) { json(res, 404, { error: "Unknown milestone." }); return true; }
      const r = await updateMilestone(user, Number(m[1]), m[2], await readBody(req));
      if (r.error) { json(res, r.status, { error: r.error }); return true; }
      json(res, 200, { ok: true, person: await personRow(Number(m[1])) });
      return true;
    }

    // ---- configuration: payer rules, due dates, email -------------------------
    if (pathname === "/api/credentialing/config" && method === "GET") {
      if (!(await canSee(user))) { json(res, 403, { error: "Not permitted" }); return true; }
      const rules = await linkingRules();
      const names = [...new Set([...DEFAULT_PAYERS, ...rules.map((r) => r.payer)])];
      const s = await emailSettings();
      const eff = await effectiveRecipients();
      json(res, 200, {
        can_configure: canConfigure(user),
        payers: names.map((n) => rules.find((r) => r.payer === n) || { payer: n, requires_linking: false, positions: [], caseload_only: false, configured: false }),
        positions: POSITIONS.filter((p) => p.key !== "unset"),
        due_days: await dueDays(), default_due_days: DEFAULT_DUE_DAYS,
        email: canConfigure(user) ? { ...s, timezone: "America/Los_Angeles", effective_recipients: eff.list, recipient_source: eff.source } : undefined,
      });
      return true;
    }
    if (pathname === "/api/credentialing/config" && method === "PUT") {
      if (!canConfigure(user)) { json(res, 403, { error: "Only the practice owner can change credentialing settings." }); return true; }
      const b = await readBody(req);
      if (Array.isArray(b.payers)) {
        for (const p of b.payers) {
          const payer = clean(p && p.payer).slice(0, 120);
          if (!payer) continue;
          const positions = (Array.isArray(p.positions) ? p.positions : []).filter((x) => POSITION_LABEL[x] && x !== "unset");
          await dbRun(
            `INSERT INTO hr_payer_linking_rules (payer, requires_linking, positions, caseload_only, updated_by, updated_at) VALUES (?,?,?,?,?,?)
             ON CONFLICT (payer) DO UPDATE SET requires_linking = EXCLUDED.requires_linking, positions = EXCLUDED.positions,
               caseload_only = EXCLUDED.caseload_only, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
            [payer, !!p.requires_linking, JSON.stringify(positions), !!p.caseload_only, who, nowISO()]);
        }
      }
      if (b.due_days && typeof b.due_days === "object") {
        const out = {};
        for (const k of MKEYS) {
          const n = Number(b.due_days[k]);
          if (!Number.isInteger(n) || n < 0 || n > 365) { json(res, 400, { error: "Due days must be whole numbers from 0 to 365." }); return true; }
          out[k] = n;
        }
        await setAppSetting("credentialing_due_days", JSON.stringify(out));
      }
      if (b.email && typeof b.email === "object") {
        const e = b.email;
        if (e.time !== undefined) {
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(clean(e.time))) { json(res, 400, { error: "Send time must be HH:MM (24-hour, Pacific)." }); return true; }
          await setAppSetting("credentialing_email_time", clean(e.time));
        }
        if (e.enabled !== undefined) await setAppSetting("credentialing_email_enabled", e.enabled ? "1" : "0");
        if (e.recipients !== undefined) {
          const list = (Array.isArray(e.recipients) ? e.recipients : String(e.recipients || "").split(/[,;\n]/)).map((x) => clean(x)).filter(Boolean);
          const bad = list.filter((x) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
          if (bad.length) { json(res, 400, { error: `Not a valid email address: ${bad.join(", ")}` }); return true; }
          await setAppSetting("credentialing_email_recipients", [...new Set(list.map((x) => x.toLowerCase()))].join(", "));
        }
      }
      json(res, 200, { ok: true });
      return true;
    }

    // ---- email: preview, test, run now, retry, log ---------------------------
    if (pathname.startsWith("/api/credentialing/email") && !canConfigure(user)) {
      json(res, 403, { error: "Only the practice owner can manage the daily email." }); return true;
    }
    if (pathname === "/api/credentialing/email/preview" && method === "GET") {
      const date = today();
      const data = await progression();
      const pending = pendingPeople(data);
      const eff = await effectiveRecipients();
      json(res, 200, {
        would_send: pending.length > 0, reason: pending.length ? `${pending.length} new hire(s) with incomplete internal onboarding` : "Nobody has pending internal onboarding — no email would be sent today.",
        subject: subjectFor(date), html: brandedEmail(buildEmail(data, date)), recipients: eff.list, recipient_source: eff.source,
      });
      return true;
    }
    if (pathname === "/api/credentialing/email/test" && method === "POST") {
      const b = await readBody(req);
      const to = clean(b.to) || clean(user.email);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) { json(res, 400, { error: "Enter a valid email address for the test." }); return true; }
      const date = today();
      const data = await progression();
      const row = await dbGet(
        `INSERT INTO credentialing_email_log (report_date, kind, recipient, status, reason, pending_count, attempts, created_at, updated_at)
         VALUES (?, 'test', ?, 'sending', ?, ?, 1, ?, ?) RETURNING id`, [date, to, `test by ${who}`, pendingPeople(data).length, nowISO(), nowISO()]);
      const st = await deliver(row.id, to, "[TEST] " + subjectFor(date), buildEmail(data, date));
      json(res, 200, { ok: st !== "failed", status: st, to });
      return true;
    }
    if (pathname === "/api/credentialing/email/run" && method === "POST") {
      json(res, 200, await runDaily("manual"));
      return true;
    }
    if (pathname === "/api/credentialing/email/retry" && method === "POST") {
      const r = await retryDaily();
      json(res, r.status || 200, r);
      return true;
    }
    if (pathname === "/api/credentialing/email/log" && method === "GET") {
      const rows = await dbAll("SELECT report_date, kind, recipient, status, reason, pending_count, attempts, error, created_at, updated_at FROM credentialing_email_log ORDER BY id DESC LIMIT 120").catch(() => []);
      json(res, 200, { log: rows });
      return true;
    }

    // ---- payer enrollments (HR Hub staff card) ---------------------------------
    if (pathname === "/api/payer-enrollments" && method === "GET") {
      if (!(await canSee(user))) { json(res, 403, { error: "Not permitted" }); return true; }
      const empId = Number(query && query.employee_id);
      if (!Number.isInteger(empId) || empId <= 0) { json(res, 400, { error: "employee_id is required" }); return true; }
      const rows = await dbAll("SELECT * FROM hr_payer_enrollments WHERE employee_id = ? ORDER BY payer, kind", [empId]);
      const manage = hrCanManage(user);
      const known = await dbAll(
        `SELECT DISTINCT payer FROM (
           SELECT payer FROM hr_payer_enrollments UNION SELECT payer FROM hr_payer_linking_rules
           UNION SELECT payer FROM auth_payer_requirements
         ) x WHERE payer IS NOT NULL AND payer <> '' ORDER BY payer`
      ).catch(async () => dbAll("SELECT DISTINCT payer FROM hr_payer_enrollments ORDER BY payer").catch(() => []));
      const suggestions = [...new Set([...DEFAULT_PAYERS, ...known.map((k) => k.payer)])].sort((a, b) => a.localeCompare(b));
      const now = today();
      json(res, 200, {
        enrollments: rows.map((r) => ({ ...publicPayer(r, now), stored_status: r.status,
          next_action_owner: r.next_action_owner || null,
          notes: manage ? r.notes || null : undefined })),
        can_manage: manage, kinds: PAYER_KINDS, statuses: PAYER_STATUSES, payer_suggestions: suggestions,
      });
      return true;
    }
    if (pathname === "/api/payer-enrollments" && method === "POST") {
      if (!hrCanManage(user)) { json(res, 403, { error: "Only HR can change payer enrollment." }); return true; }
      const b = await readBody(req);
      const empId = Number(b.employee_id);
      const emp = Number.isInteger(empId) && empId > 0 ? await dbGet("SELECT id, name FROM hr_employees WHERE id = ?", [empId]) : null;
      if (!emp) { json(res, 404, { error: "Employee not found." }); return true; }
      const v = cleanPayerBody(b, false);
      if (v.error) { json(res, 400, v); return true; }
      const dup = await dbGet("SELECT id FROM hr_payer_enrollments WHERE employee_id = ? AND LOWER(payer) = LOWER(?) AND kind = ?", [empId, v.payer, v.kind]);
      if (dup) { json(res, 409, { error: `${v.payer} ${kindLabel(v.kind).toLowerCase()} is already on this record. Update that row instead.`, id: dup.id }); return true; }
      const row = await dbGet(
        `INSERT INTO hr_payer_enrollments
           (employee_id, payer, kind, status, submitted_date, pending_date, approved_date, effective_date,
            next_action_owner, notes, created_by, created_at, updated_by, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
        [empId, v.payer, v.kind, v.status, v.submitted_date || null, v.pending_date || null, v.approved_date || null,
         v.effective_date || null, v.next_action_owner || null, v.notes || null, who, nowISO(), who, nowISO()]);
      await logActivity(empId, `${v.payer} ${kindLabel(v.kind).toLowerCase()} added (${statusLabel(v.status)}) by ${who}.`);
      json(res, 200, { ok: true, enrollment: publicPayer(row, today()) });
      return true;
    }
    const one = pathname.match(/^\/api\/payer-enrollments\/(\d+)$/);
    if (one && method === "PATCH") {
      if (!hrCanManage(user)) { json(res, 403, { error: "Only HR can change payer enrollment." }); return true; }
      const before = await dbGet("SELECT * FROM hr_payer_enrollments WHERE id = ?", [Number(one[1])]);
      if (!before) { json(res, 404, { error: "Not found" }); return true; }
      const v = cleanPayerBody(await readBody(req), true);
      if (v.error) { json(res, 400, v); return true; }
      const finalStatus = v.status || before.status;
      const finalEff = v.effective_date !== undefined ? v.effective_date : before.effective_date;
      if (finalStatus === "effective" && !finalEff) { json(res, 400, { error: "An effective enrollment needs its effective date." }); return true; }
      const fields = Object.keys(v);
      if (!fields.length) { json(res, 400, { error: "Nothing to update" }); return true; }
      await dbRun(
        `UPDATE hr_payer_enrollments SET ${fields.map((f) => `${f} = ?`).join(", ")}, updated_by = ?, updated_at = ? WHERE id = ?`,
        [...fields.map((f) => v[f]), who, nowISO(), before.id]);
      const after = await dbGet("SELECT * FROM hr_payer_enrollments WHERE id = ?", [before.id]);
      const changes = [];
      if (after.status !== before.status) changes.push(`${statusLabel(before.status)} → ${statusLabel(after.status)}`);
      for (const f of ["submitted_date", "pending_date", "approved_date", "effective_date"]) {
        if ((after[f] || null) !== (before[f] || null)) changes.push(`${f.replace("_date", "").replace("_", " ")} ${after[f] || "cleared"}`);
      }
      if (changes.length) await logActivity(before.employee_id, `${after.payer} ${kindLabel(after.kind).toLowerCase()}: ${changes.join("; ")} (by ${who}).`);
      json(res, 200, { ok: true, enrollment: publicPayer(after, today()) });
      return true;
    }
    if (one && method === "DELETE") {
      if (!hrCanManage(user)) { json(res, 403, { error: "Only HR can change payer enrollment." }); return true; }
      const before = await dbGet("SELECT * FROM hr_payer_enrollments WHERE id = ?", [Number(one[1])]);
      if (!before) { json(res, 404, { error: "Not found" }); return true; }
      await dbRun("DELETE FROM hr_payer_enrollments WHERE id = ?", [before.id]);
      await logActivity(before.employee_id, `${before.payer} ${kindLabel(before.kind).toLowerCase()} removed (was ${statusLabel(before.status)}) by ${who}.`);
      json(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  return {
    initTables, handleApi, progression, canSee, dailySweep, runDaily,
    _internal: { positionGroup, payerState, linkState, samePayer, pacific, isDue, MILESTONES, PAYER_STATUSES, PAYER_KINDS,
                 DOC_REQUEST_STALE_DAYS, PAYER_SLOW_DAYS, APPROVED_VISIBLE_DAYS, DEFAULT_DUE_DAYS, buildEmail, subjectFor,
                 mergeVerificationMilestone },
  };
};
