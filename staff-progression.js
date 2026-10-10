// staff-progression.js -- where every incoming clinician is, for the Clinical
// Director, without her having to ask.
//
// TWO HALVES, AND ONLY ONE OF THEM STORES ANYTHING.
//
//   1. PAYER ENROLLMENT, an HR Hub record. Group linking and individual
//      credentialing with each payer were not recorded anywhere in the CRM, so
//      there was nothing to read. They are now a section of the HR Hub staff
//      card, edited by the people who already edit that card, and they live
//      beside the employee the way the document tracker and the
//      certifications do. That is HR data with an HR owner -- not a status
//      table kept for a widget.
//
//   2. PROGRESSION, which is DERIVED ON EVERY REQUEST and never written down.
//      The phase somebody is in, what is outstanding, who has to move next and
//      whether they are late are all worked out from the records that own
//      those facts: the applicant pipeline, the offer, the hire packet, the
//      onboarding portal, the document tracker, the employee record and the
//      payer enrollments above. Change any of those in the HR Hub and the
//      widget says so the next time it loads, because there is no second copy
//      to fall out of step. There is no "progression status" column, on
//      purpose: the moment one exists, somebody has to remember to update it.
//
// WHAT THE WIDGET NEVER CARRIES. Compensation (the offer's pay is never
// selected), background check results, files, notes on documents, Social
// Security or ID details. A requirement that is outstanding is named --
// "Background check" -- and that is all: no status beyond outstanding, no
// file, no notes. The payload is built field by field from an allowlist rather
// than by spreading rows, so a column added to hr_employees tomorrow does not
// arrive on the Clinical Director's screen by accident.
//
// READ-ONLY. Nothing under /api/staff-progression writes. Editing happens in
// the HR Hub, behind the HR Hub's own permission (hrCanManage), and the widget
// only offers the way there to somebody that permission already covers.
"use strict";

module.exports = function initStaffProgression(ctx) {
  const { dbGet, dbAll, dbRun, nowISO, readBody, json } = ctx;
  const hrCanManage = ctx.hrCanManage || ((u) => !!u && ["owner", "admin", "super_admin", "hr_admin"].includes(u.role));
  const isClinicalLead = ctx.isClinicalLead || (async (u) => !!u && ["owner", "super_admin"].includes(u.role));
  const leadership = ctx.leadership || (async () => ({ clinical_director: null, assistants: [], from_setting: null }));

  const clean = (v) => (v == null ? "" : String(v).trim());
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(clean(v));
  const day = (v) => (v ? String(v).slice(0, 10) : null);
  const today = () => new Date().toISOString().slice(0, 10);
  function daysBetween(a, b) {
    const x = Date.parse(String(a).slice(0, 10) + "T00:00:00Z");
    const y = Date.parse(String(b).slice(0, 10) + "T00:00:00Z");
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return Math.round((y - x) / 86400000);
  }

  // ---- thresholds ---------------------------------------------------------
  // Named and exported so the tests and the screen use the same numbers.
  const START_SOON_DAYS = 14;      // a start date this close, with work left, is flagged
  const STAGE_STALE_DAYS = 7;      // a candidate sitting in one pipeline stage this long
  const DOC_REQUEST_STALE_DAYS = 7;// a document requested this long ago and not in
  const PAYER_SLOW_DAYS = 45;      // a payer submission still unanswered after this long

  // ---- the phases, in order ----------------------------------------------
  const PHASES = [
    { key: "recruitment", label: "Recruitment" },
    { key: "preboarding", label: "Preboarding" },
    { key: "onboarding", label: "Onboarding" },
    { key: "credentialing", label: "Credentialing" },
    { key: "partial_clearance", label: "Partial payer clearance" },
    { key: "active", label: "Active" },
  ];
  const PHASE_INDEX = Object.fromEntries(PHASES.map((p, i) => [p.key, i]));

  // ---- payer enrollment vocabulary --------------------------------------
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

  // Suggestions only. Payer names are free text because the list of payers a
  // clinician needs linking with is not the same list the authorization
  // module happens to know, and refusing a payer nobody configured yet would
  // stop HR recording the thing that actually happened.
  const DEFAULT_PAYERS = ["Nevada Medicaid", "Anthem BCBS", "SilverSummit", "Molina", "CareSource", "Aetna", "Tricare", "TriWest"];

  // ---- who is clinical, and which kind ------------------------------------
  // Student first: "Student Analyst" contains "Analyst". Then the clinical
  // titles. A title that is plainly NOT clinical is left out of the widget; a
  // BLANK title is kept and labelled, because hiding an RBT whose title
  // nobody filled in is the worse mistake.
  const NON_CLINICAL = /\b(admin|administrative|office|front desk|reception|billing|biller|payroll|hr\b|human resources|recruit|intake coordinator|scheduler|scheduling|marketing|accountant|bookkeep|operations manager|janitor|custodian)/i;
  function roleGroup(title, positionRoleType) {
    const t = clean(title);
    if (/\bstudent\b|\btrainee\b|in[-\s]training|practicum|\bintern\b/i.test(t)) return "student_analyst";
    if (/\bbcaba\b/i.test(t)) return "other";
    if (/\bbcba\b|board certified behavior analyst|behavior analyst|clinical director/i.test(t)) return "bcba";
    if (/\brbt\b|registered behavior|behavior tech|behavior therapist|behavioral tech/i.test(t)) return "rbt";
    if (/cota|occupational|\bot\b|speech|\bslp\b|lba|squad lead|clinical|therap|case manager/i.test(t)) return "other";
    const rt = clean(positionRoleType).toLowerCase();
    if (rt === "bcba") return "bcba";
    if (rt === "rbt") return "rbt";
    if (!t) return "other";
    if (NON_CLINICAL.test(t)) return null;
    return null;
  }
  const ROLE_GROUPS = [
    { key: "bcba", label: "BCBAs" },
    { key: "rbt", label: "RBTs" },
    { key: "student_analyst", label: "Student Analysts" },
    { key: "other", label: "Other clinical" },
  ];

  // ======================= SCHEMA ============================
  async function initTables() {
    // HR Hub data: one row per (employee, payer, kind). Group linking and
    // individual credentialing are separate rows because they move
    // separately -- a clinician can be linked to the group and still waiting
    // on their own credentialing, and that is exactly the "partial clearance"
    // the Clinical Director needs to see.
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
    console.log("Staff progression / payer enrollment schema ready.");
  }

  // The employee activity log is the HR Hub's history, and a payer change is
  // history: it goes where every other change to the staff card already goes.
  async function logActivity(employeeId, text) {
    const emp = await dbGet("SELECT hr_activity FROM hr_employees WHERE id = ?", [employeeId]).catch(() => null);
    if (!emp) return;
    let arr = [];
    try { arr = JSON.parse(emp.hr_activity || "[]"); } catch (e) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    arr.unshift({ at: nowISO(), text });
    await dbRun("UPDATE hr_employees SET hr_activity = ? WHERE id = ?", [JSON.stringify(arr.slice(0, 200)), employeeId]).catch(() => {});
  }

  // ======================= PAYER ROW INTERPRETATION ===========
  // An approval with an effective date that has arrived IS effective; nobody
  // should have to come back and flip the status on the day.
  function payerState(r, now) {
    const st = STATUS_KEYS.includes(r.status) ? r.status : "not_started";
    const eff = day(r.effective_date);
    if (st === "effective" || (st === "approved" && eff && eff <= now)) return "effective";
    return st;
  }
  function payerDone(state) { return state === "effective" || state === "not_required"; }

  // What a payer row needs next, and from whom. Internal means somebody at
  // Spectrum Squad has to act; external means the payer does.
  function payerNext(r, state, now) {
    const owner = clean(r.next_action_owner) || "Credentialing (HR)";
    const what = `${r.payer} ${kindLabel(r.kind).toLowerCase()}`;
    switch (state) {
      case "not_started": return { label: `Submit ${what}`, owner, waiting: "internal" };
      case "denied": return { label: `Resubmit ${what} (returned by payer)`, owner, waiting: "internal" };
      case "submitted":
      case "pending": return { label: `${what} awaiting payer decision`, owner: r.payer, waiting: "external" };
      case "approved":
        return day(r.effective_date)
          ? { label: `${what} approved, effective ${day(r.effective_date)}`, owner: r.payer, waiting: "external" }
          : { label: `Confirm effective date for ${what}`, owner, waiting: "internal" };
      default: return null;
    }
  }

  function publicPayer(r, now) {
    const state = payerState(r, now);
    const since = day(r.submitted_date);
    const age = since && ["submitted", "pending"].includes(state) ? daysBetween(since, now) : null;
    // notes, created_by and updated_by are deliberately absent: notes can hold
    // anything HR typed, and the widget is not where HR's notes go.
    return {
      id: r.id, payer: r.payer, kind: r.kind, kind_label: kindLabel(r.kind),
      status: state, status_label: statusLabel(state),
      submitted_date: day(r.submitted_date), pending_date: day(r.pending_date),
      approved_date: day(r.approved_date), effective_date: day(r.effective_date),
      days_waiting: age,
      slow: age != null && age > PAYER_SLOW_DAYS,
      updated_at: r.updated_at || r.created_at || null,
    };
  }

  // ======================= THE DERIVATION ====================
  async function loadInputs() {
    const safe = (p) => p.catch(() => []);
    const [emps, apps, offers, packets, onbRecs, onbDocs, tracker, payers] = await Promise.all([
      safe(dbAll(
        `SELECT id, applicant_id, name, email, role_title, employment_type, status, hr_stage,
                hr_hire_date, hire_date, hr_offer_accepted_date, rethink_id, hr_availability,
                hr_activity, created_at
           FROM hr_employees
          WHERE COALESCE(status,'active') NOT IN ('terminated','archived')`)),
      // Candidates only from the interview onward: the widget is about people
      // who are coming, not everybody who ever applied.
      safe(dbAll(
        `SELECT a.id, a.full_name, a.stage, a.assigned_manager, a.earliest_start, a.updated_at, a.created_at,
                a.applied_at, p.title AS position_title, p.role_type AS position_role_type
           FROM hr_applicants a LEFT JOIN hr_positions p ON p.id = a.position_id
          WHERE a.stage IN ('interviewed','credentials_references','offer_approval','offer_sent')`)),
      // NO comp_amount, comp_unit or comp_notes. Ever.
      safe(dbAll(
        `SELECT id, applicant_id, job_title, employment_type, start_date, supervisor, location, status, sent_at
           FROM hr_offers ORDER BY id DESC`)),
      safe(dbAll("SELECT applicant_id, status, sent_at, completed_at, updated_at FROM hire_packets")),
      safe(dbAll(
        `SELECT id, employee_id, started_at, deadline_at, docs_complete_at, status, updated_at
           FROM onboarding_records`)),
      safe(dbAll("SELECT onboarding_id, label, status, received_at FROM onboarding_documents")),
      // Status and dates only. No notes, no file.
      safe(dbAll(
        `SELECT employee_id, doc_key, status, date_requested, date_received, updated_at
           FROM hr_doc_tracker WHERE status IN ('Requested','Expired')`)),
      safe(dbAll("SELECT * FROM hr_payer_enrollments ORDER BY payer, kind")),
    ]);
    // Stage history tells us how long a candidate has sat where they are.
    const stageAt = await dbAll(
      `SELECT applicant_id, MAX(changed_at) AS at FROM hr_applicant_stage_history GROUP BY applicant_id`
    ).catch(() => []);
    return { emps, apps, offers, packets, onbRecs, onbDocs, tracker, payers, stageAt };
  }

  const DOC_TRACKER_LABELS = {
    headshot: "Headshot", social: "Social Security card (sighted)", id: "Photo ID (sighted)",
    rbt_state: "State RBT license", rbt_national: "National RBT certification", background_check: "Background check",
  };

  function lastActivityAt(emp) {
    try {
      const arr = JSON.parse(emp.hr_activity || "[]");
      return Array.isArray(arr) && arr[0] && arr[0].at ? arr[0].at : null;
    } catch (e) { return null; }
  }
  function maxStamp(list) {
    return list.filter(Boolean).map(String).sort().pop() || null;
  }

  // Builds the row for one employee, or null when they are not incoming.
  function employeeRow(emp, idx, now) {
    const group = roleGroup(emp.role_title, null);
    if (!group) return null;
    const status = clean(emp.status || "active").toLowerCase();
    if (status === "leave") return null;

    const offer = emp.applicant_id ? idx.offerByApp.get(emp.applicant_id) : null;
    const startDate = day(emp.hr_hire_date) || day(emp.hire_date) || (offer && day(offer.start_date)) || null;
    const reqs = [];          // { phase, label, done, waiting, owner }
    const delayed = [];
    const timeline = [];

    if (emp.hr_offer_accepted_date) timeline.push({ label: "Offer accepted", date: day(emp.hr_offer_accepted_date) });

    // ---- preboarding: hire packet, onboarding portal, requested documents
    const packet = emp.applicant_id ? idx.packetByApp.get(emp.applicant_id) : null;
    if (packet) {
      const done = packet.status === "completed";
      reqs.push({ phase: "preboarding", label: "Employment application & policy packet", done,
        waiting: "external", owner: "New hire" });
      if (packet.completed_at) timeline.push({ label: "Hire packet signed", date: day(packet.completed_at) });
    }
    const onb = idx.onbByEmp.get(emp.id);
    if (onb) {
      if (onb.started_at) timeline.push({ label: "Onboarding portal opened", date: day(onb.started_at) });
      const docs = idx.onbDocsByRec.get(onb.id) || [];
      docs.forEach((d) => {
        const done = d.status === "received";
        reqs.push({ phase: "preboarding",
          label: d.status === "needs_dates" ? `${d.label} (dates needed)` : d.label,
          done, waiting: "external", owner: "New hire" });
      });
      if (onb.docs_complete_at) timeline.push({ label: "Onboarding documents complete", date: day(onb.docs_complete_at) });
      const incomplete = docs.some((d) => d.status !== "received");
      if (incomplete && (onb.status === "past_deadline" || (onb.deadline_at && String(onb.deadline_at) < new Date().toISOString()))) {
        delayed.push("Onboarding documents are past their deadline");
      }
    }
    (idx.trackerByEmp.get(emp.id) || []).forEach((t) => {
      // RBT licences are not a BCBA's requirement, whatever a stray row says.
      if (/^rbt_/.test(t.doc_key) && group !== "rbt") return;
      const label = DOC_TRACKER_LABELS[t.doc_key] || t.doc_key;
      if (t.status === "Expired") {
        reqs.push({ phase: "preboarding", label: `${label} (expired)`, done: false, waiting: "internal", owner: "HR" });
        return;
      }
      reqs.push({ phase: "preboarding", label, done: false, waiting: "external", owner: "New hire" });
      const asked = day(t.date_requested);
      const age = asked ? daysBetween(asked, now) : null;
      if (age != null && age > DOC_REQUEST_STALE_DAYS) delayed.push(`${label} requested ${age} days ago`);
    });

    // ---- onboarding: the internal set-up the clinic owes them -------------
    reqs.push({ phase: "onboarding", label: "Rethink account set up", done: !!clean(emp.rethink_id),
      waiting: "internal", owner: "HR" });
    reqs.push({ phase: "onboarding", label: "Availability submitted", done: !!clean(emp.hr_availability),
      waiting: "external", owner: "New hire" });

    // ---- credentialing ------------------------------------------------------
    const payerRows = (idx.payersByEmp.get(emp.id) || []);
    const payers = payerRows.map((r) => publicPayer(r, now));
    payerRows.forEach((r, i) => {
      const p = payers[i];
      const nx = payerNext(r, p.status, now);
      reqs.push({ phase: "credentialing", label: `${r.payer} ${kindLabel(r.kind).toLowerCase()}`,
        done: payerDone(p.status), waiting: nx ? nx.waiting : "external", owner: nx ? nx.owner : r.payer,
        next_label: nx ? nx.label : null, payer: true });
      if (p.status === "denied") delayed.push(`${r.payer} ${kindLabel(r.kind).toLowerCase()} was returned by the payer`);
      if (p.slow) delayed.push(`${r.payer} ${kindLabel(r.kind).toLowerCase()} pending ${p.days_waiting} days`);
    });
    // Somebody still onboarding with nothing recorded is not "cleared" -- it
    // means nobody has started, and that is the thing worth saying.
    if (!payerRows.length && status !== "active") {
      reqs.push({ phase: "credentialing", label: "Payer enrollment not started", done: false,
        waiting: "internal", owner: "Credentialing (HR)", payer: true });
    }
    const effectiveCount = payers.filter((p) => p.status === "effective").length;
    const payerOutstanding = reqs.filter((r) => r.payer && !r.done).length;

    // WHO IS INCOMING. The employment status in the HR Hub is the authority.
    //
    //   * Not yet active: incoming, whatever else is true.
    //   * Active, with payer enrollment still open: incoming -- they can work,
    //     but not yet bill every payer, which is the partial clearance the
    //     Clinical Director plans around.
    //   * Active with nothing open with any payer: fully onboarded. They leave
    //     the widget; their record and its history stay in the HR Hub.
    //
    // For somebody already active, the preboarding and onboarding checklist is
    // behind them by definition. A long-serving RBT with no availability form
    // on file is not "incoming", so those items are not counted for them.
    if (status === "active") {
      if (!payerOutstanding) return null;
      for (let i = reqs.length - 1; i >= 0; i--) if (!reqs[i].payer) reqs.splice(i, 1);
      delayed.splice(0, delayed.length, ...delayed.filter((d) => !/document|requested|deadline/i.test(d)));
    }

    // The employment record decides the last step. Fully set up but still
    // marked onboarding in the HR Hub is one action away -- say which.
    if (!reqs.some((r) => !r.done) && status !== "active") {
      reqs.push({ phase: "onboarding", label: "Mark as active in HR Hub", done: false, waiting: "internal", owner: "HR" });
    }
    const open = reqs.filter((r) => !r.done);

    // Phase: the earliest one that still has something open, with credentialing
    // split by whether any payer has cleared yet.
    let phase;
    const openIn = (ph) => open.some((r) => r.phase === ph);
    if (openIn("preboarding")) phase = "preboarding";
    else if (openIn("onboarding")) phase = "onboarding";
    else if (payerOutstanding) phase = effectiveCount ? "partial_clearance" : "credentialing";
    else phase = "onboarding";

    const inPhase = reqs.filter((r) => r.phase === (phase === "partial_clearance" ? "credentialing" : phase));
    const frac = inPhase.length ? inPhase.filter((r) => r.done).length / inPhase.length : 0;
    const progress = Math.min(97, Math.round(((PHASE_INDEX[phase] + frac) / (PHASES.length - 1)) * 100));

    const daysToStart = startDate ? daysBetween(now, startDate) : null;
    if (startDate && daysToStart < 0 && status !== "active") delayed.push(`Start date ${startDate} has passed`);
    const approaching = daysToStart != null && daysToStart >= 0 && daysToStart <= START_SOON_DAYS && open.length > 0;

    // The next action: the first open item in the current phase, else the
    // first open item at all.
    const pick = open.find((r) => r.phase === (phase === "partial_clearance" ? "credentialing" : phase)) || open[0] || null;
    const next = pick ? {
      label: pick.next_label || (pick.waiting === "external" && pick.owner === "New hire" ? `${pick.label} from new hire` : pick.label),
      owner: pick.owner, waiting: pick.waiting,
    } : null;

    payers.forEach((p) => {
      if (p.effective_date && p.status === "effective") timeline.push({ label: `${p.payer} ${p.kind_label.toLowerCase()} effective`, date: p.effective_date });
    });
    timeline.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));

    return {
      key: "emp-" + emp.id, source: "employee", employee_id: emp.id, applicant_id: emp.applicant_id || null,
      name: emp.name, position: clean(emp.role_title) || (offer && offer.job_title) || "Role not set",
      role_group: group, employment_type: emp.employment_type || (offer && offer.employment_type) || null,
      supervisor: offer ? offer.supervisor || null : null, location: offer ? offer.location || null : null,
      phase, phase_label: PHASES[PHASE_INDEX[phase]].label, phase_index: PHASE_INDEX[phase], progress,
      start_date: startDate, days_to_start: daysToStart,
      outstanding: open.map((r) => ({ label: r.next_label || r.label, waiting: r.waiting, owner: r.owner, phase: r.phase })),
      completed: reqs.filter((r) => r.done).map((r) => ({ label: r.label, phase: r.phase })),
      next_action: next,
      payers,
      flags: { delayed, approaching },
      timeline,
      last_updated: maxStamp([
        lastActivityAt(emp), emp.created_at, onb && onb.updated_at, packet && packet.updated_at,
        ...(idx.trackerByEmp.get(emp.id) || []).map((t) => t.updated_at),
        ...payerRows.map((r) => r.updated_at || r.created_at),
      ]),
    };
  }

  const STAGE_LABELS = {
    interviewed: "Interviewed", credentials_references: "Credentials & references",
    offer_approval: "Offer approval", offer_sent: "Offer sent",
  };

  function applicantRow(a, idx, now) {
    const group = roleGroup(a.position_title, a.position_role_type);
    if (!group) return null;
    const offer = idx.offerByApp.get(a.id) || null;
    const packet = idx.packetByApp.get(a.id) || null;
    const manager = clean(a.assigned_manager) || "HR";
    const open = [];
    if (a.stage === "interviewed") open.push({ label: "Hiring decision after interview", waiting: "internal", owner: manager });
    if (a.stage === "credentials_references") {
      open.push({ label: "Verify credentials & references", waiting: "internal", owner: manager });
      if (packet && packet.status !== "completed") open.push({ label: "Employment application & policy packet", waiting: "external", owner: "Candidate" });
    }
    if (a.stage === "offer_approval") open.push({ label: "Approve offer", waiting: "internal", owner: "Owner" });
    if (a.stage === "offer_sent") open.push({ label: "Candidate to accept or decline offer", waiting: "external", owner: "Candidate" });

    const startDate = (offer && day(offer.start_date)) || (isDate(day(a.earliest_start)) ? day(a.earliest_start) : null);
    const daysToStart = startDate ? daysBetween(now, startDate) : null;
    const stageSince = idx.stageAtByApp.get(a.id) || a.updated_at || a.created_at;
    const inStage = stageSince ? daysBetween(day(stageSince), now) : null;
    const delayed = [];
    if (inStage != null && inStage > STAGE_STALE_DAYS) delayed.push(`In "${STAGE_LABELS[a.stage] || a.stage}" for ${inStage} days`);
    if (startDate && daysToStart < 0) delayed.push(`Proposed start date ${startDate} has passed`);
    const order = ["interviewed", "credentials_references", "offer_approval", "offer_sent"];
    const frac = (order.indexOf(a.stage) + 1) / (order.length + 1);
    const timeline = [];
    if (a.applied_at) timeline.push({ label: "Applied", date: day(a.applied_at) });
    if (offer && offer.sent_at) timeline.push({ label: "Offer sent", date: day(offer.sent_at) });
    return {
      key: "app-" + a.id, source: "applicant", employee_id: null, applicant_id: a.id,
      name: a.full_name, position: clean(a.position_title) || (offer && offer.job_title) || "Role not set",
      role_group: group, employment_type: offer ? offer.employment_type || null : null,
      supervisor: offer ? offer.supervisor || null : null, location: offer ? offer.location || null : null,
      phase: "recruitment", phase_label: "Recruitment", phase_index: 0,
      stage_label: STAGE_LABELS[a.stage] || a.stage,
      progress: Math.round((frac / (PHASES.length - 1)) * 100),
      start_date: startDate, days_to_start: daysToStart,
      outstanding: open.map((r) => ({ ...r, phase: "recruitment" })),
      completed: [],
      next_action: open[0] || null,
      payers: [],
      flags: { delayed, approaching: daysToStart != null && daysToStart >= 0 && daysToStart <= START_SOON_DAYS },
      timeline,
      last_updated: maxStamp([a.updated_at, stageSince, packet && packet.updated_at]),
    };
  }

  async function progression() {
    const now = today();
    const inp = await loadInputs();
    const idx = {
      offerByApp: new Map(), packetByApp: new Map(), onbByEmp: new Map(), onbDocsByRec: new Map(),
      trackerByEmp: new Map(), payersByEmp: new Map(), stageAtByApp: new Map(),
    };
    // Offers come newest first: the first seen per applicant is the current one.
    inp.offers.forEach((o) => { if (!idx.offerByApp.has(o.applicant_id)) idx.offerByApp.set(o.applicant_id, o); });
    inp.packets.forEach((p) => idx.packetByApp.set(p.applicant_id, p));
    inp.onbRecs.forEach((r) => idx.onbByEmp.set(r.employee_id, r));
    const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
    inp.onbDocs.forEach((d) => push(idx.onbDocsByRec, d.onboarding_id, d));
    inp.tracker.forEach((t) => push(idx.trackerByEmp, t.employee_id, t));
    inp.payers.forEach((p) => push(idx.payersByEmp, p.employee_id, p));
    inp.stageAt.forEach((s) => idx.stageAtByApp.set(s.applicant_id, s.at));

    const hiredApplicants = new Set(inp.emps.map((e) => e.applicant_id).filter(Boolean));
    const people = [];
    inp.emps.forEach((e) => { const r = employeeRow(e, idx, now); if (r) people.push(r); });
    inp.apps.forEach((a) => {
      if (hiredApplicants.has(a.id)) return;   // already a staff record; that row speaks for them
      const r = applicantRow(a, idx, now); if (r) people.push(r);
    });

    // Most urgent first: delayed, then starting soon, then nearest start date.
    const rank = (p) => (p.flags.delayed.length ? 0 : p.flags.approaching ? 1 : 2);
    people.sort((a, b) => rank(a) - rank(b)
      || (a.start_date || "9999").localeCompare(b.start_date || "9999")
      || String(a.name).localeCompare(String(b.name)));

    const counts = { all: people.length };
    ROLE_GROUPS.forEach((g) => { counts[g.key] = people.filter((p) => p.role_group === g.key).length; });
    const byPhase = {};
    PHASES.forEach((p) => { byPhase[p.key] = people.filter((x) => x.phase === p.key).length; });
    return {
      generated_at: nowISO(), today: now, people, counts, by_phase: byPhase,
      delayed: people.filter((p) => p.flags.delayed.length).length,
      approaching: people.filter((p) => p.flags.approaching).length,
      phases: PHASES, role_groups: ROLE_GROUPS,
      thresholds: { START_SOON_DAYS, STAGE_STALE_DAYS, DOC_REQUEST_STALE_DAYS, PAYER_SLOW_DAYS },
    };
  }

  // ======================= ROUTES ============================
  async function canSee(user) {
    if (!user) return false;
    if (hrCanManage(user)) return true;
    return await isClinicalLead(user);
  }

  // The person NAMED as Clinical Director or Assistant -- not the owner by
  // virtue of being the owner. Used for the main dashboard, where showing the
  // widget to every owner and admin would change dashboards nobody asked to
  // change.
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
    // An effective status with no effective date is a claim nobody can check.
    const st = out.status, eff = out.effective_date;
    if (st === "effective" && b.effective_date !== undefined && !eff) return err("An effective enrollment needs its effective date.");
    return out;
  }

  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/staff-progression") && !pathname.startsWith("/api/payer-enrollments")) return false;
    if (!user) { json(res, 401, { error: "Not signed in" }); return true; }

    // ---- the widget -------------------------------------------------------
    if (pathname === "/api/staff-progression" && method === "GET") {
      if (!(await canSee(user))) { json(res, 403, { error: "Not permitted", visible: false }); return true; }
      if (query && query.surface === "admin" && !(await isDesignatedLead(user))) {
        json(res, 200, { visible: false });
        return true;
      }
      const out = await progression();
      out.visible = true;
      // The only "edit" the widget offers is a way into the HR Hub, and only
      // to someone the HR Hub would already let in.
      out.can_edit = hrCanManage(user);
      json(res, 200, out);
      return true;
    }

    // ---- payer enrollments (HR Hub) -----------------------------------------
    if (pathname === "/api/payer-enrollments" && method === "GET") {
      if (!(await canSee(user))) { json(res, 403, { error: "Not permitted" }); return true; }
      const empId = Number(query && query.employee_id);
      if (!Number.isInteger(empId) || empId <= 0) { json(res, 400, { error: "employee_id is required" }); return true; }
      const rows = await dbAll("SELECT * FROM hr_payer_enrollments WHERE employee_id = ? ORDER BY payer, kind", [empId]);
      const manage = hrCanManage(user);
      const known = await dbAll(
        `SELECT DISTINCT payer FROM (
           SELECT payer FROM hr_payer_enrollments
           UNION SELECT payer FROM auth_payer_requirements
         ) x WHERE payer IS NOT NULL AND payer <> '' ORDER BY payer`
      ).catch(async () => dbAll("SELECT DISTINCT payer FROM hr_payer_enrollments ORDER BY payer").catch(() => []));
      const suggestions = [...new Set([...DEFAULT_PAYERS, ...known.map((k) => k.payer)])].sort((a, b) => a.localeCompare(b));
      const now = today();
      json(res, 200, {
        enrollments: rows.map((r) => ({ ...publicPayer(r, now), stored_status: r.status,
          next_action_owner: r.next_action_owner || null,
          // HR's notes are for HR.
          notes: manage ? r.notes || null : undefined })),
        can_manage: manage, kinds: PAYER_KINDS, statuses: PAYER_STATUSES, payer_suggestions: suggestions,
      });
      return true;
    }

    if (pathname === "/api/payer-enrollments" && method === "POST") {
      if (!hrCanManage(user)) { json(res, 403, { error: "Only HR can change payer enrollment." }); return true; }
      const b = await readBody(req);
      const empId = Number(b.employee_id);
      const emp = Number.isInteger(empId) && empId > 0
        ? await dbGet("SELECT id, name FROM hr_employees WHERE id = ?", [empId]) : null;
      if (!emp) { json(res, 404, { error: "Employee not found." }); return true; }
      const v = cleanPayerBody(b, false);
      if (v.error) { json(res, 400, v); return true; }
      const dup = await dbGet("SELECT id FROM hr_payer_enrollments WHERE employee_id = ? AND LOWER(payer) = LOWER(?) AND kind = ?",
        [empId, v.payer, v.kind]);
      if (dup) { json(res, 409, { error: `${v.payer} ${kindLabel(v.kind).toLowerCase()} is already on this record. Update that row instead.`, id: dup.id }); return true; }
      const who = user.name || user.email || "HR";
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
      const b = await readBody(req);
      const v = cleanPayerBody(b, true);
      if (v.error) { json(res, 400, v); return true; }
      const finalStatus = v.status || before.status;
      const finalEff = v.effective_date !== undefined ? v.effective_date : before.effective_date;
      if (finalStatus === "effective" && !finalEff) { json(res, 400, { error: "An effective enrollment needs its effective date." }); return true; }
      const fields = Object.keys(v);
      if (!fields.length) { json(res, 400, { error: "Nothing to update" }); return true; }
      const who = user.name || user.email || "HR";
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
      const who = user.name || user.email || "HR";
      await logActivity(before.employee_id, `${before.payer} ${kindLabel(before.kind).toLowerCase()} removed (was ${statusLabel(before.status)}) by ${who}.`);
      json(res, 200, { ok: true });
      return true;
    }

    return false;
  }

  return {
    initTables, handleApi, progression,
    _internal: { roleGroup, payerState, PHASES, PAYER_STATUSES, PAYER_KINDS,
                 START_SOON_DAYS, STAGE_STALE_DAYS, DOC_REQUEST_STALE_DAYS, PAYER_SLOW_DAYS },
  };
};
