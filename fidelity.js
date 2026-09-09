// fidelity.js -- RBT Fidelity Checks, performance history, and the raise
// calculator that reads from them.
//
// WHAT THIS IS NOT: a digital copy of the paper checklist. The paper form's job
// ends when it is signed. This one's job starts there -- the scores become
// structured rows that a trend, an action plan, an annual review and a raise
// recommendation are all computed from, so nobody has to average percentages by
// hand or compare two PDFs to see whether somebody is improving.
//
// EVERY NUMBER ON EVERY SCREEN IS COMPUTED HERE. Section totals, the total out
// of 60, the percentage, the rating, the change since last time, the trend, the
// historical average, the performance score, the raise percentage, the hourly
// increase and the new rate. That is the whole point of the module: the person
// reading it should never be doing arithmetic.
//
// Owns /api/fidelity/*.
"use strict";

module.exports = function initFidelity(ctx) {
  const {
    dbGet, dbAll, dbRun, sendEmail, nowISO, crypto, APP_BASE_URL,
    readBody, json, moduleGranted,
  } = ctx;
  const createStaffTask = ctx.createStaffTask || (async () => null);
  const getAppSetting = ctx.getAppSetting || (async (k, fb) => fb);
  // Supervision compliance, asked of the module that owns it. Fidelity does
  // not read supervision's tables directly -- the rule for what counts as a
  // compliant month lives in one place, and it is not this one.
  const supervisionCompliance = ctx.supervisionCompliance || null;
  const HR_DOCS_DIR = ctx.HR_DOCS_DIR || null;
  const fs = require("fs");
  const path = require("path");

  // ======================= THE RUBRIC =======================
  // The five sections and thirty competencies of the Spectrum Squad checklist,
  // verbatim. They are DATA, not markup: the PDF, the scoring screen, the
  // section totals and the "most common 0 scores" report all read this one
  // list, so a wording change happens once and a competency cannot exist on the
  // form but not in the score.
  //
  // `critical` marks the competencies that are also Critical Fail conditions.
  // A zero on one of those is a critical fail REGARDLESS of the total score --
  // an RBT can score 55/60 and still have reinforced a maladaptive behaviour,
  // and a high total must never bury that.
  const SECTIONS = [
    {
      key: "prep", label: "Session Preparation", max: 10,
      items: [
        { key: "prep_1", label: "Materials prepared and organized before session" },
        { key: "prep_2", label: "Data collection system ready and accessible" },
        { key: "prep_3", label: "Program targets clearly identified prior to teaching" },
        { key: "prep_4", label: "Environment arranged to minimize distractions" },
        { key: "prep_5", label: "Reinforcers identified and readily available" },
      ],
    },
    {
      key: "dtt", label: "DTT Implementation (Core)", max: 20,
      items: [
        { key: "dtt_1", label: "Clear and concise SD delivered" },
        { key: "dtt_2", label: "Appropriate prompting used (per plan)" },
        { key: "dtt_3", label: "Prompt fading implemented correctly" },
        { key: "dtt_4", label: "Correct response reinforced immediately" },
        { key: "dtt_5", label: "Reinforcement is meaningful and appropriate" },
        { key: "dtt_6", label: "Error correction implemented correctly" },
        { key: "dtt_7", label: "Intertrial interval appropriate (no lag, no rushing)" },
        { key: "dtt_8", label: "Trials are run at appropriate pace" },
        { key: "dtt_9", label: "Mastery criteria followed correctly" },
        { key: "dtt_10", label: "Program procedures followed as written",
          critical: "Not implementing program as written" },
      ],
    },
    {
      key: "behavior", label: "Behavior Management", max: 10,
      items: [
        { key: "beh_1", label: "Antecedent strategies used appropriately" },
        { key: "beh_2", label: "Behavior plan followed correctly",
          critical: "Not following behavior intervention plan" },
        { key: "beh_3", label: "Maintains neutral affect during maladaptive behavior" },
        { key: "beh_4", label: "Reinforces appropriate replacement behaviors" },
        { key: "beh_5", label: "Does not reinforce maladaptive behavior",
          critical: "Incorrect reinforcement of maladaptive behavior" },
      ],
    },
    {
      key: "professionalism", label: "Professionalism & Engagement", max: 10,
      items: [
        { key: "pro_1", label: "Engaged and attentive with client (not distracted)" },
        { key: "pro_2", label: "Uses appropriate tone and affect" },
        { key: "pro_3", label: "Maintains professional boundaries" },
        { key: "pro_4", label: "Session runs smoothly with minimal downtime" },
        { key: "pro_5", label: "Builds rapport while maintaining instructional control" },
      ],
    },
    {
      key: "data", label: "Data Collection", max: 10,
      items: [
        { key: "data_1", label: "Data recorded in real time" },
        { key: "data_2", label: "Data is accurate and matches performance" },
        { key: "data_3", label: "Correct measurement system used" },
        { key: "data_4", label: "No missing or fabricated data",
          critical: "No data collection" },
        { key: "data_5", label: "Session notes align with observed session" },
      ],
    },
  ];

  const ALL_ITEMS = SECTIONS.flatMap((s) => s.items.map((i) => ({ ...i, section: s.key })));
  const MAX_SCORE = SECTIONS.reduce((a, s) => a + s.max, 0); // 60

  const ACTION_PLAN_OPTIONS = [
    "Modeling", "Role Play", "Additional Supervision",
    "Written Retraining", "Performance Improvement Plan",
  ];
  const SESSION_TYPES = ["In-Clinic", "In-Home", "School"];
  const OBSERVATION_LENGTHS = [15, 30, 60];

  // ======================= SCORING =======================
  // Ratings are bands on the PERCENTAGE, and the point ranges in the paper form
  // are the same bands: 54/60 is 90%, 48/60 is 80%, 36/60 is 60%. Deriving from
  // one of the two rather than checking both means they can never disagree.
  const RATINGS = [
    { key: "exceptional", label: "Exceptional", min: 90, action: "Independent, no follow-up needed." },
    { key: "meets", label: "Meets Standard", min: 80, action: "Minor feedback." },
    { key: "needs_improvement", label: "Needs Improvement", min: 60, action: "Retraining required." },
    { key: "critical", label: "Critical", min: 0, action: "Immediate supervision + Action Plan." },
  ];
  function ratingFor(pct) {
    if (pct == null || !isFinite(pct)) return null;
    return RATINGS.find((r) => pct >= r.min) || RATINGS[RATINGS.length - 1];
  }

  const round1 = (n) => Math.round(Number(n) * 10) / 10;
  const round2 = (n) => Math.round(Number(n) * 100) / 100;
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

  // The whole calculation, in one place, from the raw item scores.
  //
  // Returns nulls rather than zeroes when the rubric is incomplete: a
  // half-finished check showing "24/60, 40%, CRITICAL" would be alarming and
  // wrong, and somebody would act on it.
  function scoreOf(scores, opts = {}) {
    const s = scores && typeof scores === "object" ? scores : {};
    const sectionScores = {};
    let total = 0, answered = 0;
    for (const sec of SECTIONS) {
      let secTotal = 0, secAnswered = 0;
      for (const item of sec.items) {
        const v = s[item.key];
        if (v === 0 || v === 1 || v === 2) { secTotal += v; secAnswered++; answered++; }
      }
      sectionScores[sec.key] = { score: secTotal, max: sec.max, answered: secAnswered, items: sec.items.length };
      total += secTotal;
    }
    const complete = answered === ALL_ITEMS.length;
    const pct = complete ? round1((total / MAX_SCORE) * 100) : null;
    const rating = complete ? ratingFor(pct) : null;

    // ---- critical fail, which is SEPARATE from the number ----
    const reasons = [];
    for (const item of ALL_ITEMS) {
      if (item.critical && s[item.key] === 0) reasons.push(item.critical);
    }
    // Unsafe/unethical practice is not a scored competency on the rubric, so it
    // is asked directly rather than inferred from a score that cannot carry it.
    if (opts.unsafe_practice === true) reasons.push("Unsafe or unethical practice");

    return {
      section_scores: sectionScores,
      total_score: total,
      max_score: MAX_SCORE,
      answered, items_total: ALL_ITEMS.length,
      complete,
      percentage: pct,
      rating_key: rating ? rating.key : null,
      rating_label: rating ? rating.label : null,
      rating_action: rating ? rating.action : null,
      critical_fail: reasons.length > 0,
      critical_fail_reasons: reasons,
    };
  }

  // An action plan is REQUIRED, not merely suggested, when the result says the
  // person needs help. Returned as a computed fact so the screen, the finalize
  // guard and the tests all read the same rule.
  function actionPlanRequired(calc) {
    if (!calc) return false;
    return calc.critical_fail
      || calc.rating_key === "needs_improvement"
      || calc.rating_key === "critical";
  }

  // ======================= DATA MODEL =======================
  // STRUCTURED, not a blob. Every item score is its own column-addressable
  // value inside scores_json, and every derived figure is stored ALONGSIDE the
  // raw scores rather than only being computed on read.
  //
  // Storing the derived numbers looks redundant until the rubric changes. A
  // finalized check is a signed record of what somebody was told on a date; if
  // the percentage were recomputed on every read, editing the rubric later
  // would silently rewrite history that people signed.
  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS fidelity_checks (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      evaluator_user_id INTEGER,
      evaluator_name TEXT,
      evaluator_credentials TEXT,
      assessment_date TEXT,
      client_initials TEXT,
      session_type TEXT,
      observation_minutes INTEGER,
      scores_json TEXT NOT NULL DEFAULT '{}',
      section_scores_json TEXT,
      total_score INTEGER,
      max_score INTEGER DEFAULT 60,
      percentage NUMERIC,
      rating_key TEXT,
      rating_label TEXT,
      unsafe_practice BOOLEAN DEFAULT FALSE,
      unsafe_practice_detail TEXT,
      critical_fail BOOLEAN DEFAULT FALSE,
      critical_fail_reasons TEXT,
      critical_fail_detail TEXT,
      strengths TEXT,
      areas_for_improvement TEXT,
      action_plan_narrative TEXT,
      action_plan_options TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      bcba_signed_name TEXT,
      bcba_signed_at TEXT,
      finalized_at TEXT,
      pdf_document_id INTEGER,
      pdf_generated_at TEXT,
      emailed_at TEXT,
      email_status TEXT,
      ack_token TEXT,
      employee_ack_name TEXT,
      employee_ack_at TEXT,
      voided BOOLEAN DEFAULT FALSE,
      void_reason TEXT,
      voided_by TEXT,
      voided_at TEXT,
      amends_check_id INTEGER,
      amend_reason TEXT,
      superseded_by_check_id INTEGER,
      assigned_by TEXT,
      assigned_at TEXT,
      assignment_due_date TEXT,
      assignment_note TEXT,
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("fidelity_checks initTables:", e.message));

    // Every notice this module has already sent, so a redeploy cannot re-send
    // one. The UNIQUE key is the whole mechanism: a notice is CLAIMED before it
    // is sent, and the claim is released again only if the send throws. Timing
    // an interval is not a substitute -- an interval resets on every restart,
    // and a restart on a Tuesday would otherwise mean a second copy of
    // Tuesday's email.
    await dbRun(`CREATE TABLE IF NOT EXISTS fidelity_notices (
      id SERIAL PRIMARY KEY,
      notice_key TEXT UNIQUE,
      kind TEXT,
      employee_id INTEGER,
      ref_id INTEGER,
      sent_to TEXT,
      sent_at TEXT
    )`).catch((e) => console.error("fidelity_notices initTables:", e.message));

    // Action plans are their own rows, not a text field on the check. They have
    // their own dates, owner, status and completion, and they outlive the
    // observation that caused them -- a plan assigned in March is still open in
    // May regardless of what the next check says.
    await dbRun(`CREATE TABLE IF NOT EXISTS fidelity_action_plans (
      id SERIAL PRIMARY KEY,
      check_id INTEGER,
      employee_id INTEGER NOT NULL,
      plan_types TEXT,
      description TEXT,
      responsible_supervisor TEXT,
      date_assigned TEXT,
      due_date TEXT,
      retraining_date TEXT,
      followup_fidelity_date TEXT,
      notes TEXT,
      completed_date TEXT,
      status TEXT NOT NULL DEFAULT 'not_started',
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("fidelity_action_plans initTables:", e.message));

    // EVERY state change, with the value before and after. A performance record
    // that can be edited without trace is not evidence of anything.
    await dbRun(`CREATE TABLE IF NOT EXISTS fidelity_audit (
      id SERIAL PRIMARY KEY,
      check_id INTEGER,
      action TEXT NOT NULL,
      field TEXT,
      old_value TEXT,
      new_value TEXT,
      actor TEXT,
      at TEXT
    )`).catch((e) => console.error("fidelity_audit initTables:", e.message));

    // The raise matrix and weights are CONFIGURATION, kept in the database
    // rather than in code, because leadership changes them and a code change
    // for a percentage band is not something anybody should have to wait for.
    await dbRun(`CREATE TABLE IF NOT EXISTS fidelity_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      raise_bands_json TEXT,
      weights_json TEXT,
      fidelity_method TEXT DEFAULT 'review_period_average',
      critical_fail_policy TEXT DEFAULT 'flag_for_review',
      min_checks_required INTEGER DEFAULT 1,
      max_raise_percent NUMERIC DEFAULT 10,
      min_performance_percent NUMERIC DEFAULT 0,
      pip_policy TEXT DEFAULT 'flag_for_review',
      assumed_weekly_hours NUMERIC DEFAULT 40,
      check_interval_days INTEGER DEFAULT 90,
      updated_by TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("fidelity_settings initTables:", e.message));

    // THE CRM HAS NEVER STORED WHAT ANYBODY IS PAID. There is a wage simulator
    // in the financial centre, but it models hypothetical roles -- no
    // per-employee rate exists anywhere. The raise calculator needs one, so it
    // is added here rather than silently returning nulls and leaving somebody
    // wondering why the dollar amounts are blank.
    //
    // Until a rate is entered the recommendation still works: it gives the
    // percentage and says plainly that no rate is on file, rather than
    // inventing one.
    await dbRun("ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC")
      .catch((e) => console.error("hourly_rate column:", e.message));
    await dbRun("ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS annual_review_date TEXT")
      .catch((e) => console.error("annual_review_date column:", e.message));

    // Amendment columns, added by ALTER as well as by the CREATE above: the
    // table already exists everywhere this module has ever run, and
    // CREATE TABLE IF NOT EXISTS adds nothing to a table that is already there.
    for (const [col, type] of [
      ["amends_check_id", "INTEGER"], ["amend_reason", "TEXT"], ["superseded_by_check_id", "INTEGER"],
      // An observation somebody has been ASKED to do, before it happens.
      ["assigned_by", "TEXT"], ["assigned_at", "TEXT"],
      ["assignment_due_date", "TEXT"], ["assignment_note", "TEXT"],
    ]) {
      await dbRun(`ALTER TABLE fidelity_checks ADD COLUMN IF NOT EXISTS ${col} ${type}`)
        .catch((e) => console.error(`fidelity_checks.${col}:`, e.message));
    }

    // An annual review keeps the INPUTS it was calculated from, not just the
    // answer. Changing the matrix next year must not silently rewrite what
    // somebody was awarded this year.
    await dbRun(`CREATE TABLE IF NOT EXISTS fidelity_raise_reviews (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      review_period_start TEXT,
      review_period_end TEXT,
      inputs_json TEXT,
      performance_score NUMERIC,
      recommended_percent NUMERIC,
      current_rate NUMERIC,
      recommended_increase NUMERIC,
      recommended_new_rate NUMERIC,
      explanation TEXT,
      final_percent NUMERIC,
      final_new_rate NUMERIC,
      overridden BOOLEAN DEFAULT FALSE,
      override_reason TEXT,
      decided_by TEXT,
      decided_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_by TEXT,
      created_at TEXT
    )`).catch((e) => console.error("fidelity_raise_reviews initTables:", e.message));
  }

  async function audit(checkId, action, opts = {}) {
    await dbRun(
      `INSERT INTO fidelity_audit (check_id, action, field, old_value, new_value, actor, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [checkId || null, action, opts.field || null,
       opts.old == null ? null : String(opts.old).slice(0, 2000),
       opts.new == null ? null : String(opts.new).slice(0, 2000),
       opts.actor || "system", nowISO()]
    ).catch((e) => console.error("fidelity audit:", e.message));
  }

  // ======================= PERMISSIONS =======================
  // TWO permissions, deliberately separate, because they answer different
  // questions.
  //
  // "RBT Fidelity Management" is leadership: every employee, every history,
  // rankings, raise information and the settings. "Fidelity Evaluator" is the
  // BCBA doing an observation: their own assigned check and nothing else. A
  // BCBA who can score an RBT has no business seeing that RBT's raise, or
  // comparing them against colleagues.
  //
  // NEITHER is granted by CRM role alone, except the owner. There is no
  // "Clinical Director" role in this CRM -- it is a job title -- so the
  // Clinical Director receives management access through the grant, which is
  // exactly what "do not grant based solely on someone's general CRM role"
  // requires.
  function canManageFidelity(user) {
    if (!user) return false;
    if (user.role === "owner" || user.role === "super_admin") return true;
    return moduleGranted(user, "fidelity");
  }
  function canEvaluate(user) {
    if (!user) return false;
    if (canManageFidelity(user)) return true;
    return moduleGranted(user, "fidelity-evaluator");
  }

  // ======================= PERFORMANCE HISTORY =======================
  // Everything leadership would otherwise work out by hand, computed from the
  // finalized checks: current, previous, the change between them, the trend,
  // the averages, the highs and lows, and the twelve-month counts.
  //
  // ONLY FINALIZED, NON-VOID CHECKS COUNT. A draft is somebody's unfinished
  // opinion and must never move an average; a voided check is a record that was
  // withdrawn, and leaving it in a mean would keep punishing or flattering
  // somebody for an assessment that no longer stands.
  //
  // Nothing here overwrites anything. "Current" is simply the newest row.
  const TREND_POINTS = 1.5; // percentage points; smaller moves read as stable

  function trendOf(current, previous) {
    if (current == null || previous == null) return { key: "none", label: "—", change: null };
    const change = round1(current - previous);
    if (change > TREND_POINTS) return { key: "improving", label: "Improving", change };
    if (change < -TREND_POINTS) return { key: "declining", label: "Declining", change };
    // A one-point wobble between two observations of a human being is noise,
    // not a direction, and calling it "declining" would start conversations
    // that the data does not support.
    return { key: "stable", label: "Stable", change };
  }

  // The checks that COUNT: finalized, not voided, and not superseded by an
  // amendment. A superseded check is not deleted and not hidden -- it is
  // still on the record and still shown -- but it must not sit in an average
  // next to the corrected version of itself, or one observation would be
  // counted twice and the wrong one of the two would drag the mean.
  async function finalizedChecks(employeeId) {
    return dbAll(
      `SELECT * FROM fidelity_checks
        WHERE employee_id = ? AND status IN ('finalized','sent','awaiting_ack','acknowledged','closed')
          AND COALESCE(voided, FALSE) = FALSE
          AND superseded_by_check_id IS NULL
        ORDER BY assessment_date DESC, id DESC`,
      [employeeId]
    ).catch(() => []);
  }

  // The whole record, including the ones that no longer count. This is what a
  // history list reads: leaving a superseded or voided check out of the list
  // entirely would be quietly rewriting what happened.
  async function allChecksFor(employeeId) {
    return dbAll(
      `SELECT * FROM fidelity_checks
        WHERE employee_id = ? AND finalized_at IS NOT NULL
        ORDER BY assessment_date DESC, id DESC`,
      [employeeId]
    ).catch(() => []);
  }

  function summarise(rows) {
    const list = (rows || []).filter((r) => r.percentage != null);
    if (!list.length) {
      return {
        checks: 0, current: null, previous: null, change: null,
        trend: { key: "none", label: "—", change: null },
        average: null, average_last3: null, average_12mo: null,
        highest: null, lowest: null,
        critical_fails_12mo: 0, needs_improvement_count: 0, critical_count: 0,
        last_check_date: null, days_since_last: null, last_evaluator: null,
      };
    }
    const pcts = list.map((r) => Number(r.percentage));
    const cur = list[0], prev = list[1] || null;
    const mean = (a) => (a.length ? round1(a.reduce((x, y) => x + y, 0) / a.length) : null);

    const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const within12 = list.filter((r) => String(r.assessment_date || "") >= yearAgo);

    const lastDate = cur.assessment_date || null;
    const days = lastDate
      ? Math.max(0, Math.floor((Date.now() - new Date(lastDate + "T00:00:00Z").getTime()) / 86400000))
      : null;

    return {
      checks: list.length,
      current: {
        id: cur.id, score: cur.total_score, max: cur.max_score || MAX_SCORE,
        percentage: Number(cur.percentage), rating_key: cur.rating_key, rating_label: cur.rating_label,
        date: cur.assessment_date, evaluator: cur.evaluator_name,
        critical_fail: cur.critical_fail === true || cur.critical_fail === "t",
      },
      previous: prev ? {
        id: prev.id, score: prev.total_score, max: prev.max_score || MAX_SCORE,
        percentage: Number(prev.percentage), rating_key: prev.rating_key, rating_label: prev.rating_label,
        date: prev.assessment_date, evaluator: prev.evaluator_name,
      } : null,
      change: prev ? round1(Number(cur.percentage) - Number(prev.percentage)) : null,
      trend: trendOf(Number(cur.percentage), prev ? Number(prev.percentage) : null),
      average: mean(pcts),
      average_last3: mean(pcts.slice(0, 3)),
      average_12mo: mean(within12.map((r) => Number(r.percentage))),
      highest: round1(Math.max(...pcts)),
      lowest: round1(Math.min(...pcts)),
      critical_fails_12mo: within12.filter((r) => r.critical_fail === true || r.critical_fail === "t").length,
      needs_improvement_count: list.filter((r) => r.rating_key === "needs_improvement").length,
      critical_count: list.filter((r) => r.rating_key === "critical").length,
      last_check_date: lastDate,
      days_since_last: days,
      last_evaluator: cur.evaluator_name || null,
    };
  }

  async function employeeSummary(employeeId) {
    return summarise(await finalizedChecks(employeeId));
  }

  // ======================= RAISE CALCULATION =======================
  // "I HAVE A HARD TIME WITH MATH" is the requirement this section exists for.
  // Nobody using it should average a percentage, work out a weighted score,
  // convert performance into a raise band, multiply an hourly rate, or subtract
  // two numbers to find the difference. All of it happens here, and the result
  // is handed over with a plain-English explanation of how it was reached.
  //
  // IT RECOMMENDS. IT DOES NOT DECIDE. A raise is an employment decision about
  // a person's livelihood, and a formula must not make one silently -- the
  // recommendation is stored beside a leadership decision, and an override
  // requires a reason.
  const DEFAULT_BANDS = [
    { min: 95, max: 100, percent: 5, label: "95–100%" },
    { min: 90, max: 94.99, percent: 4, label: "90–94.99%" },
    { min: 85, max: 89.99, percent: 3, label: "85–89.99%" },
    { min: 80, max: 84.99, percent: 2, label: "80–84.99%" },
    { min: 0, max: 79.99, percent: null, label: "Below 80%", review: true },
  ];

  // Fidelity is ONE component, never hard-coded as the whole answer. The other
  // categories are declared here so the weighting screen can offer them, and
  // each says where its number would come from -- an unweighted category with
  // no source is an honest blank rather than a fabricated score.
  const CATEGORIES = [
    { key: "fidelity", label: "RBT Fidelity", live: true,
      source: "Finalized Fidelity Checks in the review period" },
    // Attendance is deliberately still unwired. It is measured in POINTS,
    // where fewer is better, and the attendance policy defines named bands
    // ("Coaching Conversation", "Attendance Improvement Plan") rather than
    // scores. Turning those into a percentage means choosing a number that
    // changes what somebody is paid, and that is a decision for leadership to
    // make explicitly rather than for this file to assume.
    { key: "attendance", label: "Attendance", live: false,
      source: "Attendance points exist, but the policy defines bands rather than a score — leadership has to say what a band is worth before this can be weighted" },
    { key: "reliability", label: "Reliability", live: false, source: "Not yet wired in" },
    { key: "note_timeliness", label: "Session Note Timeliness", live: false, source: "Not yet wired in" },
    { key: "supervision_compliance", label: "Supervision Compliance", live: true,
      source: "The share of supervision months in the review period that met the BACB 5% minimum" },
    { key: "training", label: "Training Completion", live: false, source: "Not yet wired in" },
    { key: "professionalism", label: "Professionalism", live: false, source: "Not yet wired in" },
    { key: "performance_review", label: "Performance Reviews", live: false, source: "Not yet wired in" },
  ];
  const DEFAULT_WEIGHTS = { fidelity: 100 };

  const FIDELITY_METHODS = [
    { key: "most_recent", label: "Most recent Fidelity Check" },
    { key: "last3_average", label: "Average of the last 3 Fidelity Checks" },
    { key: "review_period_average", label: "Average of Fidelity Checks during the review period" },
    { key: "twelve_month_average", label: "12-month Fidelity average" },
  ];

  async function getSettings() {
    let row = await dbGet("SELECT * FROM fidelity_settings WHERE id = 1").catch(() => null);
    if (!row) {
      await dbRun(
        `INSERT INTO fidelity_settings (id, raise_bands_json, weights_json, updated_at)
         VALUES (1, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
        [JSON.stringify(DEFAULT_BANDS), JSON.stringify(DEFAULT_WEIGHTS), nowISO()]
      ).catch(() => {});
      row = await dbGet("SELECT * FROM fidelity_settings WHERE id = 1").catch(() => null);
    }
    const parse = (v, fb) => { try { const p = JSON.parse(v); return p == null ? fb : p; } catch (e) { return fb; } };
    return {
      bands: parse(row && row.raise_bands_json, DEFAULT_BANDS),
      weights: parse(row && row.weights_json, DEFAULT_WEIGHTS),
      fidelity_method: (row && row.fidelity_method) || "review_period_average",
      critical_fail_policy: (row && row.critical_fail_policy) || "flag_for_review",
      pip_policy: (row && row.pip_policy) || "flag_for_review",
      min_checks_required: Number(row && row.min_checks_required) || 1,
      max_raise_percent: row && row.max_raise_percent != null ? Number(row.max_raise_percent) : 10,
      min_performance_percent: row && row.min_performance_percent != null ? Number(row.min_performance_percent) : 0,
      assumed_weekly_hours: row && row.assumed_weekly_hours != null ? Number(row.assumed_weekly_hours) : 40,
      check_interval_days: Number(row && row.check_interval_days) || 90,
    };
  }

  // Weights must total exactly 100. Not "roughly" -- a set summing to 90 would
  // quietly scale everybody's score down by a tenth and nobody would see it in
  // the output.
  function weightsProblem(weights) {
    const entries = Object.entries(weights || {}).filter(([, v]) => Number(v) > 0);
    if (!entries.length) return "Set at least one performance weight.";
    const total = entries.reduce((a, [, v]) => a + Number(v), 0);
    if (Math.round(total * 100) / 100 !== 100) {
      return `Performance weights must equal 100%. They currently total ${round1(total)}%.`;
    }
    for (const [k] of entries) {
      if (!CATEGORIES.some((c) => c.key === k)) return `Unknown performance category "${k}".`;
    }
    return null;
  }

  function bandFor(bands, pct) {
    if (pct == null) return null;
    return (bands || []).find((b) => pct >= Number(b.min) && pct <= Number(b.max)) || null;
  }

  // The Fidelity number that feeds the review, by whichever method is
  // configured -- and it REPORTS which one it used, because "92%" means
  // different things depending on whether it is one observation or a year of
  // them.
  function fidelityFigure(summary, rows, method, periodStart, periodEnd) {
    const inPeriod = (rows || []).filter((r) => {
      const d = String(r.assessment_date || "");
      return (!periodStart || d >= periodStart) && (!periodEnd || d <= periodEnd);
    }).map((r) => Number(r.percentage)).filter((n) => isFinite(n));
    const mean = (a) => (a.length ? round1(a.reduce((x, y) => x + y, 0) / a.length) : null);

    switch (method) {
      case "most_recent":
        return { value: summary.current ? summary.current.percentage : null,
                 method_label: "the most recent Fidelity Check", checks_used: summary.current ? 1 : 0 };
      case "last3_average":
        return { value: summary.average_last3, method_label: "the average of the last 3 Fidelity Checks",
                 checks_used: Math.min(3, summary.checks) };
      case "twelve_month_average":
        return { value: summary.average_12mo, method_label: "the 12-month Fidelity average",
                 checks_used: summary.checks };
      case "review_period_average":
      default:
        return { value: mean(inPeriod), method_label: "the average of Fidelity Checks during the review period",
                 checks_used: inPeriod.length };
    }
  }

  const money = (n) => (n == null ? null : Math.round(Number(n) * 100) / 100);

  // Everything the raise reads that is NOT Fidelity. Only categories that
  // actually carry a weight are fetched, so an install that weights Fidelity
  // at 100% -- the default -- does no extra work at all.
  //
  // A category that is weighted but cannot produce a number returns nothing
  // rather than a zero, and computeRaise reports it as missing. That is the
  // difference between "we have no attendance data" and "their attendance is
  // 0%", and only one of those is true.
  async function gatherCategories(settings, employeeId, periodStart, periodEnd) {
    const values = {}, details = {};
    const weights = settings.weights || {};

    if (Number(weights.supervision_compliance) > 0 && supervisionCompliance) {
      try {
        const c = await supervisionCompliance(employeeId, periodStart, periodEnd);
        if (c && c.percentage != null) {
          values.supervision_compliance = c.percentage;
          details.supervision_compliance =
            `Supervision Compliance is ${c.percentage}%, from ${c.months_meeting} of ${c.months_counted} `
            + `month${c.months_counted === 1 ? "" : "s"} meeting the BACB ${c.min_pct}% minimum during the review period`
            + (c.months_without_hours
                ? `; ${c.months_without_hours} further month${c.months_without_hours === 1 ? " was" : "s were"} left out because no worked hours are on file for ${c.months_without_hours === 1 ? "it" : "them"}.`
                : ".");
        }
      } catch (e) { /* a category that cannot be read is reported as missing, not as zero */ }
    }
    return { values, details };
  }

  // The whole recommendation, including the sentence that explains it.
  function computeRaise(input) {
    const { settings, summary, rows, current_rate, period_start, period_end, open_pip } = input;
    const fid = fidelityFigure(summary, rows, settings.fidelity_method, period_start, period_end);

    // Weighted performance score across whatever categories carry a weight and
    // actually have a number. A category with a weight but no data is reported
    // rather than silently treated as zero, which would tank the score.
    const parts = [];
    const missing = [];
    for (const [key, weight] of Object.entries(settings.weights || {})) {
      const w = Number(weight);
      if (!(w > 0)) continue;
      const cat = CATEGORIES.find((c) => c.key === key);
      const supplied = (input.category_values || {})[key];
      const value = key === "fidelity" ? fid.value : (supplied == null ? null : Number(supplied));
      if (value == null || !isFinite(value)) { missing.push({ key, label: cat ? cat.label : key, weight: w }); continue; }
      parts.push({ key, label: cat ? cat.label : key, weight: w, value,
                   detail: (input.category_details || {})[key] || null });
    }
    const usableWeight = parts.reduce((a, p) => a + p.weight, 0);
    const performance = usableWeight > 0
      ? round1(parts.reduce((a, p) => a + p.value * p.weight, 0) / usableWeight)
      : null;

    const band = bandFor(settings.bands, performance);
    let recommended = band && band.percent != null ? Number(band.percent) : null;
    if (recommended != null && recommended > settings.max_raise_percent) recommended = settings.max_raise_percent;

    // ---- the blocks, which are FLAGS, not automatic refusals ----
    const flags = [];
    if (summary.checks < settings.min_checks_required) {
      flags.push(`Only ${summary.checks} Fidelity Check${summary.checks === 1 ? "" : "s"} on file; the policy asks for ${settings.min_checks_required}.`);
    }
    if (summary.critical_fails_12mo > 0 && settings.critical_fail_policy !== "ignore") {
      flags.push(`${summary.critical_fails_12mo} Critical Fail${summary.critical_fails_12mo === 1 ? "" : "s"} in the last 12 months.`);
    }
    if (open_pip && settings.pip_policy !== "ignore") flags.push("An open Performance Improvement Plan.");
    if (performance != null && performance < settings.min_performance_percent) {
      flags.push(`Performance score is below the ${settings.min_performance_percent}% minimum in the raise policy.`);
    }
    if (missing.length) {
      flags.push("No data for: " + missing.map((m) => `${m.label} (${m.weight}%)`).join(", ") + ".");
    }

    const blocking = settings.critical_fail_policy === "ineligible" && summary.critical_fails_12mo > 0;
    const needsReview = band ? !!band.review : true;

    const rate = current_rate == null ? null : Number(current_rate);
    const increase = (recommended != null && rate != null) ? money(rate * (recommended / 100)) : null;
    const newRate = (increase != null && rate != null) ? money(rate + increase) : null;
    const hours = settings.assumed_weekly_hours;
    const weekly = increase == null ? null : money(increase * hours);
    const annual = weekly == null ? null : money(weekly * 52);

    return {
      fidelity: { value: fid.value, method: settings.fidelity_method, method_label: fid.method_label, checks_used: fid.checks_used },
      components: parts, missing_components: missing,
      performance_score: performance,
      band: band ? { label: band.label, percent: band.percent, review: !!band.review } : null,
      recommended_percent: blocking ? null : recommended,
      current_rate: rate,
      recommended_increase: blocking ? null : increase,
      recommended_new_rate: blocking ? null : newRate,
      assumed_weekly_hours: hours,
      estimated_weekly_increase: blocking ? null : weekly,
      estimated_annual_increase: blocking ? null : annual,
      trend: summary.trend,
      critical_fails_12mo: summary.critical_fails_12mo,
      flags,
      needs_leadership_review: needsReview || flags.length > 0 || blocking,
      explanation: explainRaise({
        performance, band, recommended, rate, increase, newRate,
        fid, summary, flags, blocking, settings, weekly, annual, hours, parts,
      }),
    };
  }

  // Plain English, in whole sentences, naming the actual numbers. Somebody who
  // does not want to read a formula should be able to read this and know
  // exactly why the figure is what it is.
  function explainRaise(x) {
    const pieces = [];
    if (x.fid.value == null) {
      pieces.push("There are no Fidelity Checks in the chosen period, so a Fidelity figure could not be calculated.");
    } else {
      const many = x.fid.checks_used === 1 ? "1 Fidelity Check" : `${x.fid.checks_used} Fidelity Checks`;
      pieces.push(`Fidelity is ${x.fid.value}%, taken from ${x.fid.method_label} (${many}).`);
    }
    if (x.parts.length > 1) {
      pieces.push("The overall performance score combines " +
        x.parts.map((p) => `${p.label} at ${p.weight}% (${p.value}%)`).join(", ") + ".");
      // A weighted figure that arrived from somewhere else says where. "96%"
      // is not a number anybody should have to go and look up the meaning of.
      for (const p of x.parts) if (p.detail) pieces.push(p.detail);
    }
    if (x.performance != null) pieces.push(`The overall performance score is ${x.performance}%.`);

    if (x.blocking) {
      pieces.push("A Critical Fail in the last 12 months makes this employee temporarily ineligible under the current policy, so no raise percentage is recommended. Leadership decides.");
    } else if (x.band && x.band.percent != null) {
      pieces.push(`Under the current raise matrix, ${x.band.label} qualifies for a recommended ${x.band.percent}% raise.`);
      if (x.rate != null) {
        pieces.push(`At $${x.rate.toFixed(2)}/hour, ${x.band.percent}% is $${x.increase.toFixed(2)}/hour, giving a recommended new rate of $${x.newRate.toFixed(2)}/hour.`);
        pieces.push(`On an assumed ${x.hours}-hour week that is about $${x.weekly.toFixed(2)} more a week, or about $${x.annual.toFixed(2)} a year.`);
      } else {
        pieces.push("No hourly rate is on file for this employee, so the dollar amounts could not be calculated.");
      }
    } else if (x.band && x.band.review) {
      pieces.push(`A performance score of ${x.performance}% falls in the ${x.band.label} band, which the raise matrix sends to leadership review rather than assigning a percentage.`);
    } else {
      pieces.push("The performance score did not fall into any configured raise band, so there is no automatic recommendation.");
    }

    if (x.flags.length) pieces.push("Flagged for leadership review: " + x.flags.join(" "));
    pieces.push("This is a recommendation. The final decision is leadership's.");
    return pieces.join(" ");
  }

  // ======================= THE PDF =======================
  // Everything on the paper form, in the order somebody reading the paper form
  // expects, including the items that scored full marks. A PDF that only listed
  // the problems would be a different document from the one that was signed.
  //
  // pdfkit is required lazily, so a missing dependency cannot crash finalizing
  // an assessment -- the scores are already saved by then and losing them
  // because a library is absent would be the worst possible trade.
  async function buildPdf(check, employee) {
    if (!HR_DOCS_DIR) return null;
    let PDFDocument;
    try { PDFDocument = require("pdfkit"); }
    catch (e) { console.error("[fidelity] pdfkit unavailable:", e.message); return null; }

    const scores = parseJson(check.scores_json, {});
    const calc = scoreOf(scores, { unsafe_practice: check.unsafe_practice === true || check.unsafe_practice === "t" });

    // A PDF in a personnel file has to be readable on its own. Somebody opening
    // it a year from now has the paper and nothing else -- no dashboard, no
    // history -- so if this assessment was amended, superseded or voided, the
    // page has to say so. Two PDFs for one observation with nothing to
    // distinguish them is worse than no PDF at all.
    const other = check.superseded_by_check_id || check.amends_check_id
      ? await dbGet("SELECT id, assessment_date, total_score, max_score, percentage, rating_label FROM fidelity_checks WHERE id = ?",
          [check.superseded_by_check_id || check.amends_check_id]).catch(() => null)
      : null;
    const statusBanner = statusBannerFor(check, other);

    const storedName = `${crypto.randomBytes(10).toString("hex")}.pdf`;
    const full = path.join(HR_DOCS_DIR, storedName);
    const NAVY = "#1b2a6b", MUTED = "#6b6a86", WARN = "#b45309", BAD = "#a3282e", GOOD = "#166534";

    await new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: "LETTER", margin: 48 });
        const stream = fs.createWriteStream(full);
        stream.on("finish", resolve);
        stream.on("error", reject);
        doc.pipe(stream);

        doc.fillColor(NAVY).fontSize(19).text("Spectrum Squad", { continued: false });
        doc.fillColor("#201a4d").fontSize(15).text("Session Fidelity Checklist");
        doc.moveDown(0.5);

        // ---- the status banner, before anything somebody might act on ----
        if (statusBanner) {
          const colour = statusBanner.key === "voided" ? BAD : statusBanner.key === "superseded" ? WARN : NAVY;
          doc.fillColor(colour).fontSize(11).text(statusBanner.title);
          doc.fillColor(MUTED).fontSize(9).text(statusBanner.body, { width: 500 });
          doc.moveDown(0.6);
        }

        const line = (label, value) => {
          doc.fillColor(MUTED).fontSize(9.5).text(label, { continued: true })
             .fillColor("#201a4d").fontSize(10.5).text("   " + (value == null || value === "" ? "—" : String(value)));
        };
        line("RBT", employee ? employee.name : "—");
        line("Client initials", check.client_initials);   // initials only, never a full name
        line("Session type", check.session_type);
        line("Date", check.assessment_date);
        line("Observation length", check.observation_minutes ? check.observation_minutes + " minutes" : null);
        line("Completed by", (check.evaluator_name || "—") + (check.evaluator_credentials ? ", " + check.evaluator_credentials : ""));
        doc.moveDown(0.6);

        // ---- headline ----
        const pct = check.percentage != null ? Number(check.percentage) : calc.percentage;
        const ratingColor = check.rating_key === "exceptional" || check.rating_key === "meets" ? GOOD
          : check.rating_key === "needs_improvement" ? WARN : BAD;
        doc.fillColor(NAVY).fontSize(13).text(
          `TOTAL SCORE  ${check.total_score}/${check.max_score || MAX_SCORE}      ${pct}%`);
        doc.fillColor(ratingColor).fontSize(12).text(String(check.rating_label || "").toUpperCase());
        doc.moveDown(0.4);

        const criticalFail = check.critical_fail === true || check.critical_fail === "t";
        if (criticalFail) {
          const reasons = parseJson(check.critical_fail_reasons, []);
          doc.fillColor(BAD).fontSize(11).text("CRITICAL FIDELITY CONCERN — IMMEDIATE REVIEW REQUIRED");
          doc.fillColor("#201a4d").fontSize(9.5).text(reasons.join("; "));
          if (check.critical_fail_detail) doc.fillColor("#201a4d").fontSize(9.5).text(check.critical_fail_detail);
          doc.moveDown(0.4);
        }

        // ---- every item, including the ones that scored 2 ----
        for (const sec of SECTIONS) {
          const ss = calc.section_scores[sec.key];
          doc.moveDown(0.35);
          doc.fillColor(NAVY).fontSize(11).text(`${sec.label}: ${ss.score} / ${sec.max}`);
          for (const item of sec.items) {
            const v = scores[item.key];
            const shown = v === 0 || v === 1 || v === 2 ? String(v) : "—";
            const col = v === 0 ? BAD : v === 1 ? WARN : "#201a4d";
            doc.fillColor(col).fontSize(9.5).text(`   ${shown}   ${item.label}` +
              (item.critical && v === 0 ? "   ** CRITICAL **" : ""));
          }
        }
        doc.moveDown(0.6);

        const narrative = (title, body) => {
          doc.fillColor(NAVY).fontSize(11).text(title);
          doc.fillColor("#201a4d").fontSize(9.5).text(body && String(body).trim() ? String(body) : "—");
          doc.moveDown(0.3);
        };
        narrative("Strengths Observed", check.strengths);
        narrative("Areas for Improvement", check.areas_for_improvement);
        narrative("Action Plan", check.action_plan_narrative);
        const opts = parseJson(check.action_plan_options, []);
        if (opts.length) narrative("Action Plan interventions", opts.join(", "));

        doc.moveDown(0.5);
        doc.fillColor(NAVY).fontSize(11).text("Signatures");
        doc.fillColor("#201a4d").fontSize(9.5).text(
          `BCBA / Supervising Clinician: ${check.bcba_signed_name || "—"}` +
          (check.evaluator_credentials ? `, ${check.evaluator_credentials}` : "") +
          `    Signed: ${check.bcba_signed_at || "—"}`);
        doc.fillColor("#201a4d").fontSize(9.5).text(
          check.employee_ack_at
            ? `RBT acknowledgment: ${check.employee_ack_name}    ${check.employee_ack_at}`
            : "RBT acknowledgment: awaiting employee");
        doc.moveDown(0.4);
        doc.fillColor(MUTED).fontSize(8).text(
          "Acknowledgment confirms receipt of this assessment. It does not necessarily indicate agreement with every part of the evaluation.");

        doc.end();
      } catch (e) { reject(e); }
    });

    const safeName = String(employee && employee.name ? employee.name : "Employee").replace(/[^A-Za-z0-9]+/g, " ").trim();
    const filename = `RBT Fidelity - ${safeName} - ${check.assessment_date || ""}.pdf`.replace(/\s+/g, " ");
    const row = await dbRun(
      `INSERT INTO hr_documents (employee_id, kind, filename, stored_name, mime_type, created_at)
       VALUES (?, 'fidelity', ?, ?, 'application/pdf', ?) RETURNING id`,
      [check.employee_id, filename, storedName, nowISO()]
    );
    return row && row.rows && row.rows[0] ? row.rows[0].id : null;
  }

  // What the paper has to say about itself, decided here rather than inside the
  // PDF writer. pdfkit subsets its fonts, so the text in a generated PDF is
  // glyph ids rather than words and cannot be asserted on; keeping the wording
  // and the branch out here means the thing that matters -- WHICH banner a
  // given check gets, and what it says -- is testable directly.
  function statusBannerFor(check, other) {
    const describe = (c) => c
      ? `${c.assessment_date || "—"} (${c.total_score}/${c.max_score || MAX_SCORE}, ${c.percentage}%${c.rating_label ? ", " + c.rating_label : ""})`
      : "another assessment";
    if (check.voided === true || check.voided === "t") {
      return { key: "voided", title: "THIS ASSESSMENT WAS VOIDED",
        body: (check.void_reason ? "Reason: " + check.void_reason + " " : "")
          + "It is retained as part of the record and does not count towards this employee's Fidelity history." };
    }
    if (check.superseded_by_check_id) {
      return { key: "superseded", title: "THIS ASSESSMENT WAS AMENDED",
        body: "It is retained exactly as it was signed and no longer counts towards this employee's Fidelity history. "
          + `The assessment that stands for this observation is dated ${describe(other)}.` };
    }
    if (check.amends_check_id) {
      return { key: "amendment", title: "THIS IS AN AMENDED ASSESSMENT",
        body: `It replaces the assessment of ${describe(other)}, which is retained on the record and no longer counts.`
          + (check.amend_reason ? ` Reason for the correction: ${check.amend_reason}` : "") };
    }
    return null;
  }

  // Re-file an employee's copy after its status changed. The signature and the
  // scores are stored data and are never touched; the PDF is a rendering of
  // them, which is why regenerating it on acknowledgment was already the
  // behaviour. A stale PDF saying nothing about a void is a document that
  // misleads whoever opens the folder.
  async function refilePdf(checkId, why) {
    try {
      const fresh = await dbGet("SELECT * FROM fidelity_checks WHERE id = ?", [checkId]);
      if (!fresh) return null;
      const emp = await dbGet("SELECT id, name, role_title FROM hr_employees WHERE id = ?", [fresh.employee_id]).catch(() => null);
      const docId = await buildPdf(fresh, emp);
      if (!docId) return null;
      await dbRun("UPDATE fidelity_checks SET pdf_document_id = ?, pdf_generated_at = ? WHERE id = ?", [docId, nowISO(), checkId]);
      await audit(checkId, "pdf_refiled", { actor: "system", new: why });
      return docId;
    } catch (e) {
      await audit(checkId, "pdf_failed", { actor: "system", new: e.message });
      return null;
    }
  }

  // An observation cannot have happened in the future, and a date that is not
  // a date is not one either. Unguarded, a fat-fingered year is worse than it
  // looks: history is ordered by assessment_date, so a check dated 2027
  // becomes that RBT's CURRENT score until 2027 arrives, every trend is
  // measured against it, and it simultaneously falls outside every review
  // period so it counts towards no raise. All of that while looking fine.
  function assessmentDateProblem(value, todayStr) {
    const d = String(value == null ? "" : value).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      return "Give the date of the observation as a real date.";
    }
    const t = new Date(d + "T00:00:00Z");
    if (isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d) {
      return `${d} is not a date that exists.`;
    }
    if (d > todayStr) {
      return `An observation cannot be dated in the future — ${d} has not happened yet.`;
    }
    return null;
  }

  // "Initials only, never a full name" has been the rule since the module was
  // written, stated in a comment and enforced by maxlength="6" on one input.
  // That is not enforcement: it is a suggestion any API client, paste or
  // script ignores. The field is printed into a PDF that is FILED IN AN RBT'S
  // PERSONNEL RECORD and shown on the employee's own page, so a client's full
  // name here puts a child's identity into somebody's employment file.
  //
  // Separators are allowed because people write J.D. and J-D; what is counted
  // is the letters underneath, and four is more than any set of initials needs.
  function clientInitialsProblem(value) {
    const raw = String(value == null ? "" : value).trim();
    if (!raw) return null;                       // optional, and blank is fine
    if (!/^[A-Za-z][A-Za-z.\-\s]*$/.test(raw)) {
      return "Client initials should be letters only — no numbers or punctuation beyond . and -";
    }
    const letters = raw.replace(/[^A-Za-z]/g, "");
    if (letters.length > 4) {
      return "Initials only — a client's full name must never go on this document. It is filed in the RBT's personnel record.";
    }
    return null;
  }

  // Nobody observes themselves. The CRM links a login to a staff record by
  // email, and in a small clinic a senior RBT can plausibly hold Fidelity
  // Evaluator access — at which point nothing stopped them creating, scoring,
  // signing and filing an assessment of themselves that then counted towards
  // their own history and fed their own raise recommendation.
  //
  // Refused rather than flagged. A self-assessment in a performance record is
  // not something leadership reviews and accepts; it is something somebody
  // else has to do.
  function sameHuman(aEmail, bEmail) {
    const a = String(aEmail || "").trim().toLowerCase();
    const b = String(bEmail || "").trim().toLowerCase();
    return !!a && a === b;
  }
  async function selfObservationProblem(evaluatorEmail, employeeId) {
    if (!evaluatorEmail) return null;
    const emp = await dbGet("SELECT name, email FROM hr_employees WHERE id = ?", [employeeId]).catch(() => null);
    if (!emp || !sameHuman(evaluatorEmail, emp.email)) return null;
    return `A Fidelity Check cannot be completed by the person being observed. ${emp.name || "This RBT"} needs somebody else to do it.`;
  }

  function parseJson(v, fb) {
    if (v == null) return fb;
    if (typeof v === "object") return v;
    try { const p = JSON.parse(v); return p == null ? fb : p; } catch (e) { return fb; }
  }

  // ======================= FINALIZE =======================
  // ONE action, everything downstream. The BCBA presses Sign & Finalize and the
  // CRM locks the record, generates the PDF, files it in the personnel record,
  // emails the employee, raises the follow-up work and writes the audit trail.
  // Nobody is asked to download a PDF and upload it somewhere.
  //
  // The ORDER matters. The scores are locked FIRST and everything else is
  // best-effort after: if the PDF library is missing or the mail provider is
  // down, the assessment is still signed and saved. Losing a completed
  // observation because an email failed would be the worst possible trade, and
  // each step records its own success or failure in the audit trail so a
  // half-finished automation is visible rather than assumed.
  // An assignment that is still somebody's work. Declared once: the Action
  // Plan statuses taught this lesson the hard way, where three places each had
  // their own idea of "open" and adding one value split them apart.
  const CHECK_LIVE = ["assigned", "in_progress", "awaiting_signature"];
  const CHECK_UNSTARTED = ["assigned", "in_progress"];

  // What an Action Plan can be, and which of those mean it is still somebody's
  // work. ONE definition, because there were three: the dashboard listed
  // specific open statuses, while the notice sweep and the raise's
  // Performance-Improvement-Plan check both used "anything that is not
  // completed". Adding a status the two disagreed about -- cancelled -- would
  // have meant a plan that the dashboard treated as closed while the sweep
  // kept emailing about it and the raise calculator kept flagging the person.
  const PLAN_STATUSES = ["not_started", "in_progress", "overdue", "completed", "cancelled"];
  const PLAN_OPEN = ["not_started", "in_progress", "overdue"];
  const PLAN_STATUS_LABEL = {
    not_started: "Not started", in_progress: "In progress", overdue: "Overdue",
    completed: "Completed", cancelled: "Cancelled",
  };

  const STATUSES = ["draft", "assigned", "in_progress", "awaiting_signature", "finalized",
    "sent", "awaiting_ack", "acknowledged", "closed",
    // An observation that will not happen. `declined` is the evaluator saying
    // they cannot do it; `cancelled` is leadership withdrawing the request.
    // The two are recorded separately because "I could not" and "we changed
    // our minds" are different facts about why an RBT went unobserved.
    "declined", "cancelled",
    // A check that an amendment has replaced. It keeps its scores, its
    // signature and its trail; it simply no longer counts. The screens read
    // this list to label a status, so a value the module writes and the list
    // does not contain would render as a raw word nobody chose.
    "amended"];

  async function finalizeCheck(checkId, user, body = {}) {
    const check = await dbGet("SELECT * FROM fidelity_checks WHERE id = ?", [checkId]);
    if (!check) return { ok: false, code: 404, error: "That Fidelity Check no longer exists." };
    if (check.voided === true || check.voided === "t") {
      return { ok: false, code: 400, error: "This Fidelity Check has been voided." };
    }
    if (check.finalized_at) {
      // Signed means signed. A correction goes through an amendment so the
      // original stays exactly as the person signed it.
      return { ok: false, code: 409, code_key: "already_finalized",
        error: "This Fidelity Check was already signed and finalized. Create an amendment to correct it." };
    }

    const scores = parseJson(check.scores_json, {});
    const unsafe = body.unsafe_practice === true || check.unsafe_practice === true || check.unsafe_practice === "t";
    const calc = scoreOf(scores, { unsafe_practice: unsafe });

    // ---- refusals, each naming what is missing ----
    if (!calc.complete) {
      const missing = ALL_ITEMS.filter((i) => ![0, 1, 2].includes(scores[i.key]));
      return { ok: false, code: 400, error:
        `${missing.length} competenc${missing.length === 1 ? "y has" : "ies have"} not been scored yet.`,
        missing: missing.map((i) => i.key) };
    }
    const signedName = String(body.bcba_signed_name || "").trim();
    if (!signedName) return { ok: false, code: 400, error: "An electronic signature is required to finalize." };

    // An assessment with no date cannot be placed in a history, compared with
    // the one before it, or counted in a review period. Assignments start
    // without one on purpose -- the observation has not happened yet -- so this
    // is where it has to be filled in.
    const whenRaw = String(body.assessment_date || check.assessment_date || "").trim();
    if (!whenRaw) {
      return { ok: false, code: 400, code_key: "assessment_date_required",
        error: "Give the date the observation took place before signing." };
    }
    const whenProblem = assessmentDateProblem(whenRaw, nowISO().slice(0, 10));
    if (whenProblem) return { ok: false, code: 400, code_key: "assessment_date_invalid", error: whenProblem };

    // Checked again here, not only when the check was created: a login can be
    // linked to a staff record at any time, so a check that was legitimate on
    // Monday can be a self-assessment by Friday.
    const selfAtSigning = await selfObservationProblem(user && user.email, check.employee_id);
    if (selfAtSigning) return { ok: false, code: 400, code_key: "self_observation", error: selfAtSigning };

    if (unsafe && !String(body.unsafe_practice_detail || check.unsafe_practice_detail || "").trim()) {
      return { ok: false, code: 400, error: "Unsafe or unethical practice must be documented before finalizing." };
    }
    if (calc.critical_fail && !String(body.critical_fail_detail || check.critical_fail_detail || "").trim()) {
      return { ok: false, code: 400, error: "A Critical Fidelity Concern must be described before finalizing." };
    }
    // An action plan is required when the result says somebody needs help.
    // Refusing here rather than warning is deliberate: "Needs Improvement" with
    // no plan is how a retraining never happens.
    const planTypes = Array.isArray(body.action_plan_options) ? body.action_plan_options : parseJson(check.action_plan_options, []);
    const planText = String(body.action_plan_narrative || check.action_plan_narrative || "").trim();
    if (actionPlanRequired(calc) && !planText && !planTypes.length) {
      return { ok: false, code: 400, code_key: "action_plan_required", error:
        `A ${calc.critical_fail ? "Critical Fidelity Concern" : calc.rating_label} result requires an Action Plan before it can be finalized.` };
    }

    const actor = (user && (user.email || user.name)) || "unknown";
    const now = nowISO();
    const ackToken = crypto.randomBytes(24).toString("hex");

    // ---- 1. LOCK. Everything else is best-effort after this line. ----
    await dbRun(
      `UPDATE fidelity_checks SET
         scores_json = ?, section_scores_json = ?, total_score = ?, max_score = ?, percentage = ?,
         rating_key = ?, rating_label = ?, unsafe_practice = ?, unsafe_practice_detail = ?,
         critical_fail = ?, critical_fail_reasons = ?, critical_fail_detail = ?,
         strengths = ?, areas_for_improvement = ?, action_plan_narrative = ?, action_plan_options = ?,
         assessment_date = ?, bcba_signed_name = ?, bcba_signed_at = ?, evaluator_credentials = ?,
         finalized_at = ?, status = 'finalized', ack_token = ?, updated_at = ?
       WHERE id = ?`,
      [JSON.stringify(scores), JSON.stringify(calc.section_scores), calc.total_score, MAX_SCORE, calc.percentage,
       calc.rating_key, calc.rating_label, !!unsafe, body.unsafe_practice_detail || check.unsafe_practice_detail || null,
       calc.critical_fail, JSON.stringify(calc.critical_fail_reasons),
       body.critical_fail_detail || check.critical_fail_detail || null,
       body.strengths != null ? body.strengths : check.strengths,
       body.areas_for_improvement != null ? body.areas_for_improvement : check.areas_for_improvement,
       planText || null, JSON.stringify(planTypes),
       body.assessment_date || check.assessment_date,
       signedName, now, body.evaluator_credentials || check.evaluator_credentials || null,
       now, ackToken, now, checkId]
    );
    await audit(checkId, "finalized", { actor, new: `${calc.total_score}/${MAX_SCORE} (${calc.percentage}%) ${calc.rating_label}` });
    await audit(checkId, "signed", { actor, field: "bcba_signed_name", new: signedName });

    // ---- an amendment supersedes its original, at SIGNING, not before ----
    // Marking the original the moment an amendment is started would drop it
    // out of every average while somebody is still half-way through deciding
    // whether to change anything -- and an abandoned amendment would leave
    // the record permanently short of an assessment that really happened.
    let supersededId = null;
    if (check.amends_check_id) {
      const orig = await dbGet("SELECT id, total_score, percentage FROM fidelity_checks WHERE id = ?", [check.amends_check_id]).catch(() => null);
      if (orig) {
        await dbRun("UPDATE fidelity_checks SET superseded_by_check_id = ?, status = 'amended', updated_at = ? WHERE id = ?",
          [checkId, now, orig.id]);
        await audit(orig.id, "superseded", { actor,
          old: `${orig.total_score}/${MAX_SCORE} (${orig.percentage}%)`,
          new: `amended by check ${checkId}: ${calc.total_score}/${MAX_SCORE} (${calc.percentage}%)` });
        await audit(checkId, "amends", { actor, new: `supersedes check ${orig.id}` });
        // The original's filed copy now has to say it was amended, or the
        // personnel file holds two assessments of one observation and nothing
        // to tell them apart.
        await refilePdf(orig.id, "superseded by an amendment");
        supersededId = orig.id;
      }
    }

    const fresh = await dbGet("SELECT * FROM fidelity_checks WHERE id = ?", [checkId]);
    const emp = await dbGet("SELECT id, name, email, role_title FROM hr_employees WHERE id = ?", [check.employee_id]).catch(() => null);
    const result = { ok: true, check_id: checkId, calc, pdf_document_id: null, emailed: false, action_plan_id: null,
                     superseded_check_id: supersededId };

    // ---- 2. PDF ----
    try {
      const docId = await buildPdf(fresh, emp);
      if (docId) {
        await dbRun("UPDATE fidelity_checks SET pdf_document_id = ?, pdf_generated_at = ? WHERE id = ?", [docId, nowISO(), checkId]);
        await audit(checkId, "pdf_generated", { actor: "system", new: String(docId) });
        result.pdf_document_id = docId;
      } else {
        await audit(checkId, "pdf_failed", { actor: "system", new: "PDF could not be generated; the assessment is still signed and saved." });
      }
    } catch (e) {
      await audit(checkId, "pdf_failed", { actor: "system", new: e.message });
    }

    // ---- 3. an action plan row, when one is required ----
    if (actionPlanRequired(calc)) {
      try {
        const row = await dbGet(
          `INSERT INTO fidelity_action_plans
             (check_id, employee_id, plan_types, description, responsible_supervisor,
              date_assigned, due_date, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'not_started', ?, ?, ?) RETURNING id`,
          [checkId, check.employee_id, JSON.stringify(planTypes), planText || null,
           signedName, now.slice(0, 10), body.action_plan_due_date || null, actor, now, now]
        );
        result.action_plan_id = row ? row.id : null;
        await audit(checkId, "action_plan_created", { actor, new: planTypes.join(", ") || planText });
      } catch (e) {
        await audit(checkId, "action_plan_failed", { actor: "system", new: e.message });
      }
    }

    // ---- 4. email the employee, with the acknowledgment link ----
    if (emp && emp.email) {
      const url = `${APP_BASE_URL}/fidelity-ack/${ackToken}`;
      try {
        await sendEmail({
          to: emp.email,
          subject: "Your Spectrum Squad RBT Fidelity Check",
          html: fidelityEmailHtml(emp, fresh, calc, url),
          type: "fidelity_check",
          refType: "fidelity_check", refId: checkId,
        });
        await dbRun("UPDATE fidelity_checks SET emailed_at = ?, email_status = 'sent', status = 'awaiting_ack' WHERE id = ?", [nowISO(), checkId]);
        await audit(checkId, "emailed", { actor: "system", new: emp.email });
        result.emailed = true;
      } catch (e) {
        await dbRun("UPDATE fidelity_checks SET email_status = ? WHERE id = ?", ["failed: " + e.message, checkId]);
        await audit(checkId, "email_failed", { actor: "system", new: e.message });
      }
    } else {
      await dbRun("UPDATE fidelity_checks SET email_status = 'no_email_on_file' WHERE id = ?", [checkId]);
      await audit(checkId, "email_skipped", { actor: "system", new: "No email address on the employee record." });
    }

    // ---- 5. follow-up work, for the results that need a human ----
    if (calc.critical_fail || calc.rating_key === "critical" || calc.rating_key === "needs_improvement") {
      try {
        await createStaffTask({
          title: calc.critical_fail
            ? `CRITICAL Fidelity concern — ${emp ? emp.name : "RBT"}`
            : `Fidelity follow-up (${calc.rating_label}) — ${emp ? emp.name : "RBT"}`,
          notes: `Fidelity Check on ${check.assessment_date}: ${calc.total_score}/${MAX_SCORE} (${calc.percentage}%), ${calc.rating_label}.`
               + (calc.critical_fail ? ` Critical: ${calc.critical_fail_reasons.join("; ")}.` : ""),
          created_by: actor,
        });
        await audit(checkId, "followup_task_created", { actor: "system" });
      } catch (e) {
        await audit(checkId, "followup_task_failed", { actor: "system", new: e.message });
      }
    }

    return result;
  }

  function fidelityEmailHtml(emp, check, calc, ackUrl) {
    const first = String(emp.name || "there").split(/\s+/)[0];
    return `
      <p>Hi ${esc(first)},</p>
      <p>Your Fidelity Check from <strong>${esc(check.assessment_date || "")}</strong> has been completed and signed by ${esc(check.bcba_signed_name || "your supervisor")}.</p>
      <table style="border-collapse:collapse;font-size:15px;margin:14px 0;">
        <tr><td style="padding:5px 14px 5px 0;color:#5b6472;">Score</td><td style="padding:5px 0;font-weight:700;">${calc.total_score} / ${MAX_SCORE}</td></tr>
        <tr><td style="padding:5px 14px 5px 0;color:#5b6472;">Percentage</td><td style="padding:5px 0;font-weight:700;">${calc.percentage}%</td></tr>
        <tr><td style="padding:5px 14px 5px 0;color:#5b6472;">Rating</td><td style="padding:5px 0;font-weight:700;">${esc(calc.rating_label)}</td></tr>
      </table>
      ${calc.critical_fail ? `<p style="color:#a3282e;"><strong>This assessment recorded a critical fidelity concern.</strong> Your supervisor will follow up with you directly.</p>` : ""}
      <p style="text-align:center;margin:24px 0;">
        <a href="${ackUrl}" style="background:#e0a430;color:#1b2a6b;font-weight:700;text-decoration:none;padding:12px 26px;border-radius:999px;font-size:15px;display:inline-block;">Read it and acknowledge</a>
      </p>
      <p style="font-size:12.5px;color:#6b7280;">Acknowledging confirms you received this assessment. It does not mean you agree with every part of it — if something looks wrong, tell your supervisor.</p>`;
  }
  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ======================= THE DASHBOARD =======================
  // Everything the summary cards and the employee table need, computed here.
  // The screen renders numbers; it never works any of them out.
  //
  // "Active RBT" is read from the job title the same way the supervision
  // tracker does, so the two modules cannot disagree about who is an RBT.
  const RBT_TITLE = /\bRBT\b|registered behavior technician|behavior tech|\bBT\b|student|in[- ]training|trainee/i;
  function isRbt(emp) {
    if (!emp) return false;
    if (String(emp.status || "active") === "terminated") return false;
    return RBT_TITLE.test(String(emp.role_title || ""));
  }

  async function dashboard(query = {}) {
    const settings = await getSettings();
    const emps = await dbAll(
      `SELECT id, name, email, role_title, hire_date, status, annual_review_date, hourly_rate
         FROM hr_employees WHERE COALESCE(status,'active') <> 'terminated' ORDER BY name`
    ).catch(() => []);
    const rbts = emps.filter(isRbt);

    const allChecks = await dbAll(
      `SELECT * FROM fidelity_checks
        WHERE status IN ('finalized','sent','awaiting_ack','acknowledged','closed')
          AND COALESCE(voided, FALSE) = FALSE
          AND superseded_by_check_id IS NULL
        ORDER BY assessment_date DESC, id DESC`
    ).catch(() => []);
    const byEmp = new Map();
    for (const c of allChecks) {
      if (!byEmp.has(c.employee_id)) byEmp.set(c.employee_id, []);
      byEmp.get(c.employee_id).push(c);
    }

    // Work in flight: asked for and not done, and done but not signed. Neither
    // is visible in the finalized figures by definition, which is exactly why
    // they need counting -- an observation that was scored and never signed is
    // an observation that happened and is on nobody's record.
    const inFlight = await dbAll(
      `SELECT id, employee_id, evaluator_name, status, assignment_due_date, updated_at
         FROM fidelity_checks
        WHERE finalized_at IS NULL AND COALESCE(voided, FALSE) = FALSE
          AND status IN (${CHECK_LIVE.map(() => "?").join(",")})`, CHECK_LIVE
    ).catch(() => []);

    const openPlans = await dbAll(
      `SELECT * FROM fidelity_action_plans WHERE status IN (${PLAN_OPEN.map(() => "?").join(",")})`,
      PLAN_OPEN
    ).catch(() => []);
    const plansByEmp = new Map();
    for (const pl of openPlans) {
      if (!plansByEmp.has(pl.employee_id)) plansByEmp.set(pl.employee_id, []);
      plansByEmp.get(pl.employee_id).push(pl);
    }

    const today = nowISO().slice(0, 10);
    const monthStart = today.slice(0, 7) + "-01";
    const rows = rbts.map((e) => {
      const sum = summarise(byEmp.get(e.id) || []);
      const plans = plansByEmp.get(e.id) || [];
      const overdue = plans.filter((pl) => pl.due_date && pl.due_date < today && PLAN_OPEN.includes(pl.status));
      // Due = interval since the last check, or immediately if never checked.
      const dueDate = sum.last_check_date
        ? new Date(new Date(sum.last_check_date + "T00:00:00Z").getTime() + settings.check_interval_days * 86400000).toISOString().slice(0, 10)
        : null;
      // Somebody has already been asked. Without this the roster says "due
      // now" for an RBT whose observation is booked, and a second person gets
      // asked to do the same one.
      const pending = inFlight.find((c) => Number(c.employee_id) === Number(e.id)) || null;
      return {
        employee_id: e.id, name: e.name, role_title: e.role_title || "", email: e.email || null,
        pending_check: pending ? {
          id: pending.id, status: pending.status, evaluator: pending.evaluator_name || null,
          due_date: pending.assignment_due_date || null,
          overdue: !!(pending.assignment_due_date && pending.assignment_due_date < today),
        } : null,
        hire_date: e.hire_date || null,
        annual_review_date: e.annual_review_date || null,
        hourly_rate: e.hourly_rate == null ? null : Number(e.hourly_rate),
        checks: sum.checks,
        current_score: sum.current ? sum.current.score : null,
        current_max: sum.current ? sum.current.max : MAX_SCORE,
        current_percentage: sum.current ? sum.current.percentage : null,
        current_rating: sum.current ? sum.current.rating_label : null,
        current_rating_key: sum.current ? sum.current.rating_key : null,
        previous_score: sum.previous ? sum.previous.score : null,
        previous_percentage: sum.previous ? sum.previous.percentage : null,
        change: sum.change,
        trend: sum.trend,
        average: sum.average,
        last_check_date: sum.last_check_date,
        days_since_last: sum.days_since_last,
        last_evaluator: sum.last_evaluator,
        critical_fail: sum.current ? sum.current.critical_fail : false,
        critical_fails_12mo: sum.critical_fails_12mo,
        open_action_plans: plans.length,
        overdue_action_plans: overdue.length,
        next_due: dueDate,
        overdue_check: !dueDate || dueDate <= today,
      };
    });

    const withScore = rows.filter((r) => r.current_percentage != null);
    const avg = withScore.length
      ? round1(withScore.reduce((a, r) => a + r.current_percentage, 0) / withScore.length)
      : null;
    const soon = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);

    return {
      settings_summary: { check_interval_days: settings.check_interval_days },
      cards: {
        active_rbts: rows.length,
        checks_this_month: allChecks.filter((c) => String(c.assessment_date || "") >= monthStart).length,
        checks_due: rows.filter((r) => r.overdue_check).length,
        // Never checked at all is a DIFFERENT problem from overdue, and gets
        // its own number: nobody has ever watched these people work.
        never_checked: rows.filter((r) => r.checks === 0).length,
        average_score: avg,
        below_standard: withScore.filter((r) => r.current_percentage < 80).length,
        critical_concerns: rows.filter((r) => r.critical_fail || r.current_rating_key === "critical").length,
        open_action_plans: rows.reduce((a, r) => a + r.open_action_plans, 0),
        overdue_action_plans: rows.reduce((a, r) => a + r.overdue_action_plans, 0),
        trending_down: rows.filter((r) => r.trend && r.trend.key === "declining").length,
        assigned_open: inFlight.filter((c) => c.status === "assigned" || c.status === "in_progress").length,
        assignments_overdue: inFlight.filter((c) => c.assignment_due_date && c.assignment_due_date < today
          && (c.status === "assigned" || c.status === "in_progress")).length,
        // Scored, unsigned. The most losable thing in the module.
        awaiting_signature: inFlight.filter((c) => c.status === "awaiting_signature").length,
        upcoming_reviews: rows.filter((r) => r.annual_review_date && r.annual_review_date <= soon && r.annual_review_date >= today).length,
      },
      employees: rows,
    };
  }

  // Who has waited longest, and a random pick among those actually eligible.
  //
  // Random means random, but never among people who were checked last week --
  // the point of the feature is that nobody is unintentionally evaluated far
  // more or far less than their colleagues, and a uniform draw over everybody
  // would keep landing on the same names.
  async function randomPick() {
    const d = await dashboard();
    const eligible = d.employees.filter((r) => r.overdue_check);
    const pool = eligible.length ? eligible : d.employees;
    if (!pool.length) return { ok: false, error: "There are no active RBTs to choose from." };
    // Longest-waiting first, so the caller can see the queue it was drawn from.
    const queue = [...pool].sort((a, b) => {
      const A = a.days_since_last == null ? Infinity : a.days_since_last;
      const B = b.days_since_last == null ? Infinity : b.days_since_last;
      return B - A;
    });
    const pick = pool[crypto.randomBytes(4).readUInt32BE(0) % pool.length];
    return {
      ok: true,
      picked: pick,
      drawn_from: eligible.length ? "RBTs who are due a check" : "all active RBTs (nobody is currently due)",
      pool_size: pool.length,
      longest_waiting: queue.slice(0, 5).map((r) => ({
        employee_id: r.employee_id, name: r.name,
        days_since_last: r.days_since_last, last_check_date: r.last_check_date, checks: r.checks,
      })),
    };
  }

  // ======================= WHERE THE TEAM IS WEAK =======================
  // The rubric is held as data partly so this could exist: which competencies
  // the team actually loses points on, across every finalized check.
  //
  // The distinction that makes it worth reading is ONE PERSON vs THE TEAM.
  // Six zeros on prompt fading from one RBT is a coaching conversation. Six
  // zeros from six RBTs is a training session, and writing six Action Plans
  // instead would be treating a training gap as six individual failures. So
  // every row reports the number of DISTINCT PEOPLE as well as the number of
  // occurrences, and nothing here decides which it is -- it shows both.
  //
  // Sample size is reported as loudly as the finding. "100% of RBTs fail this"
  // from two observations is not a pattern, and a report that ranked it top
  // would send somebody to run a training day on noise.
  const INSIGHT_MIN_OBSERVATIONS = 5;

  async function insights(query = {}) {
    const settings = await getSettings();
    const end = query.period_end || nowISO().slice(0, 10);
    const start = query.period_start ||
      new Date(new Date(end + "T00:00:00Z").getTime() - 365 * 86400000).toISOString().slice(0, 10);

    const rows = await dbAll(
      `SELECT id, employee_id, assessment_date, scores_json, critical_fail, critical_fail_reasons, percentage
         FROM fidelity_checks
        WHERE status IN ('finalized','sent','awaiting_ack','acknowledged','closed')
          AND COALESCE(voided, FALSE) = FALSE
          AND superseded_by_check_id IS NULL
          AND assessment_date >= ? AND assessment_date <= ?
        ORDER BY assessment_date`,
      [start, end]
    ).catch(() => []);

    // Only RBTs who are still here. A competency the team was weak on two
    // years ago, by people who have since left, is not a training need now.
    const staff = await dbAll(
      "SELECT id, name FROM hr_employees WHERE COALESCE(status,'active') <> 'terminated'"
    ).catch(() => []);
    const nameOf = new Map(staff.map((e) => [Number(e.id), e.name]));

    const perItem = new Map();
    for (const item of ALL_ITEMS) {
      perItem.set(item.key, {
        key: item.key, label: item.label, section: item.section,
        critical: item.critical || null,
        scored: 0, zeros: 0, ones: 0, twos: 0, points: 0,
        people_zero: new Set(), people_scored: new Set(),
      });
    }

    for (const r of rows) {
      const sc = parseJson(r.scores_json, {});
      for (const item of ALL_ITEMS) {
        const v = sc[item.key];
        if (v !== 0 && v !== 1 && v !== 2) continue;
        const cell = perItem.get(item.key);
        cell.scored++; cell.points += v;
        cell.people_scored.add(Number(r.employee_id));
        if (v === 0) { cell.zeros++; cell.people_zero.add(Number(r.employee_id)); }
        else if (v === 1) cell.ones++;
        else cell.twos++;
      }
    }

    const items = [...perItem.values()].map((c) => {
      const mean = c.scored ? round2(c.points / c.scored) : null;
      return {
        key: c.key, label: c.label, section: c.section, critical: c.critical,
        observations: c.scored,
        zeros: c.zeros, ones: c.ones, twos: c.twos,
        // Out of a possible 2 per observation, expressed the way every other
        // figure in this module is: a percentage somebody can compare.
        mean_score: mean,
        percentage: c.scored ? round1((c.points / (c.scored * 2)) * 100) : null,
        // The number that decides training vs coaching.
        people_scoring_zero: c.people_zero.size,
        people_observed: c.people_scored.size,
        // Stated rather than implied. A row below the threshold is shown, and
        // shown as thin evidence, instead of being hidden or ranked as fact.
        enough_evidence: c.scored >= INSIGHT_MIN_OBSERVATIONS,
      };
    });

    // Weakest first, but only among rows with enough behind them; the thin
    // ones follow, so nothing disappears and nothing thin outranks the rest.
    const ranked = [...items].sort((a, b) => {
      if (a.enough_evidence !== b.enough_evidence) return a.enough_evidence ? -1 : 1;
      if (a.percentage == null) return 1;
      if (b.percentage == null) return -1;
      return a.percentage - b.percentage;
    });

    const sections = SECTIONS.map((sec) => {
      const mine = items.filter((i) => i.section === sec.key && i.observations);
      const obs = mine.reduce((a, i) => a + i.observations, 0);
      const pts = mine.reduce((a, i) => a + i.mean_score * i.observations, 0);
      return {
        key: sec.key, label: sec.label,
        observations: obs,
        percentage: obs ? round1((pts / (obs * 2)) * 100) : null,
      };
    });

    // Critical fails by reason, which is a different question from a low score.
    const criticalCounts = new Map();
    let criticalChecks = 0;
    for (const r of rows) {
      if (!(r.critical_fail === true || r.critical_fail === "t")) continue;
      criticalChecks++;
      for (const reason of parseJson(r.critical_fail_reasons, [])) {
        criticalCounts.set(reason, (criticalCounts.get(reason) || 0) + 1);
      }
    }

    return {
      period: { start, end },
      checks: rows.length,
      rbts_observed: new Set(rows.map((r) => Number(r.employee_id))).size,
      min_observations: INSIGHT_MIN_OBSERVATIONS,
      // Said in the payload, not left to each screen to remember.
      caveat: rows.length < INSIGHT_MIN_OBSERVATIONS
        ? `Only ${rows.length} Fidelity Check${rows.length === 1 ? "" : "s"} in this period. That is too few to read anything here as a pattern.`
        : null,
      items, ranked,
      sections,
      weakest: ranked.filter((i) => i.enough_evidence).slice(0, 5),
      critical: {
        checks_with_a_critical_fail: criticalChecks,
        by_reason: [...criticalCounts.entries()]
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count),
      },
      // Nothing above is per-person; this is the one place a name appears, and
      // only for the rows where one person accounts for the whole finding.
      concentrated: ranked
        .filter((i) => i.enough_evidence && i.zeros >= 2 && i.people_scoring_zero === 1)
        .map((i) => {
          const owner = rows.find((r) => {
            const sc = parseJson(r.scores_json, {});
            return sc[i.key] === 0;
          });
          return { key: i.key, label: i.label, zeros: i.zeros,
                   employee_id: owner ? Number(owner.employee_id) : null,
                   name: owner ? (nameOf.get(Number(owner.employee_id)) || null) : null };
        }),
      check_interval_days: settings.check_interval_days,
    };
  }

  // ======================= NOTICES =======================
  // A Fidelity Check that is overdue, an Action Plan that has passed its date,
  // an assessment nobody acknowledged and a raise review coming up are all
  // things the CRM already knows and nobody was being told. The dashboard
  // counts them, but a count only helps somebody who opens the dashboard.
  //
  // Digests, not one email per person. "Four RBTs are due a Fidelity Check"
  // gets read; four separate emails on the same morning get filtered.
  //
  // Nothing here decides anything or changes a record. It reports.

  // Who hears about it. The same chain the rest of the CRM uses -- the
  // Clinical Director address if one is configured, the owner notification
  // address otherwise, and failing both the highest-privilege real account --
  // so a fresh install does not send leadership's post into a void, and no
  // address is hard-coded in this file.
  async function leadershipRecipients() {
    const clean = (v) => String(v == null ? "" : v).trim();
    const cd = clean(await getAppSetting("clinical_director_email", ""));
    if (cd) return [cd.toLowerCase()];
    const owner = clean(await getAppSetting("owner_notification_email", ""));
    if (owner) return [owner.toLowerCase()];
    const rows = await dbAll(
      `SELECT email FROM users WHERE role IN ('owner','super_admin') AND email <> 'admin@spectrumsquadlv.com'
        ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END`
    ).catch(() => []);
    return rows.length ? [String(rows[0].email).toLowerCase()] : [];
  }

  // Claim a notice, or find out somebody already sent it. Returns false when
  // the key is taken, which is the whole restart-safety story.
  async function claimNotice(key, kind, employeeId, refId, to) {
    const row = await dbGet(
      `INSERT INTO fidelity_notices (notice_key, kind, employee_id, ref_id, sent_to, sent_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (notice_key) DO NOTHING RETURNING id`,
      [key, kind, employeeId || null, refId || null, to || null, nowISO()]
    ).catch(() => null);
    return row && row.id ? row.id : null;
  }
  async function releaseNotice(id) {
    if (id) await dbRun("DELETE FROM fidelity_notices WHERE id = ?", [id]).catch(() => {});
  }

  const noticeShell = (title, intro, body, footer) => `
    <p style="font-size:15px;">${esc(intro)}</p>
    <div style="font-size:13.5px;">${body}</div>
    ${footer ? `<p style="font-size:12.5px;color:#6b7280;">${esc(footer)}</p>` : ""}
    <p style="font-size:12px;color:#9ca3af;">${esc(title)} — Spectrum Squad CRM</p>`;

  const noticeList = (items) =>
    `<ul style="padding-left:18px;margin:10px 0;">${items.map((t) => `<li style="margin:4px 0;">${t}</li>`).join("")}</ul>`;

  // A day count that reads as a sentence rather than a number to interpret.
  function agoPhrase(days) {
    if (days == null) return "never";
    if (days === 0) return "today";
    if (days === 1) return "1 day ago";
    return `${days} days ago`;
  }

  async function sweep() {
    const out = { check_due: 0, plan_overdue: 0, assignment_overdue: 0, unsigned_complete: 0,
                  ack_outstanding: 0, review_due: 0, skipped_no_recipient: 0 };
    const settings = await getSettings();
    const today = nowISO().slice(0, 10);
    const to = await leadershipRecipients();
    const dash = await dashboard().catch(() => null);
    if (!dash) return out;

    // ---- 1. Fidelity Checks that are due ----
    // Re-raised every 30 days while they stay overdue, rather than once and
    // then silence: an RBT nobody has observed for six months is a bigger
    // problem in month six than in month one, and one email in January is how
    // that becomes invisible.
    const dueNow = [];
    for (const r of dash.employees) {
      if (!r.overdue_check) continue;
      const stale = r.days_since_last == null
        ? `never observed`
        : `last observed ${agoPhrase(r.days_since_last)}`;
      const period = r.days_since_last == null
        ? "never:" + today.slice(0, 7)
        : `${r.next_due || "due"}:${Math.floor(Math.max(0, r.days_since_last - settings.check_interval_days) / 30)}`;
      const id = to.length ? await claimNotice(`check_due:${r.employee_id}:${period}`, "check_due", r.employee_id, null, to.join(", ")) : null;
      if (!to.length) { out.skipped_no_recipient++; continue; }
      if (!id) continue;
      dueNow.push({ claim: id, row: r, stale });
    }
    if (dueNow.length && to.length) {
      const body = noticeList(dueNow.map((d) =>
        `<strong>${esc(d.row.name)}</strong> — ${esc(d.stale)}${d.row.checks ? `, ${d.row.checks} check${d.row.checks === 1 ? "" : "s"} on file` : ""}`));
      try {
        await sendEmail({
          to: to.join(", "),
          subject: `${dueNow.length} RBT${dueNow.length === 1 ? " is" : "s are"} due a Fidelity Check`,
          html: noticeShell("Fidelity Checks due", 
            `${dueNow.length === 1 ? "One RBT is" : dueNow.length + " RBTs are"} due a Fidelity Check under the current ${settings.check_interval_days}-day interval.`,
            body,
            "Open RBT Fidelity in the CRM to schedule one, or use the random picker to choose fairly among everybody who is due."),
          type: "fidelity_checks_due",
        });
        out.check_due = dueNow.length;
      } catch (e) {
        for (const d of dueNow) await releaseNotice(d.claim);
      }
    }

    // ---- 2. Action Plans past their date ----
    // These get a task as well as an email, because unlike the rest of this
    // sweep an overdue plan is somebody's unfinished work rather than a
    // reminder to look at something.
    const plans = await dbAll(
      `SELECT * FROM fidelity_action_plans
        WHERE status IN (${PLAN_OPEN.map(() => "?").join(",")}) AND due_date IS NOT NULL AND due_date < ?`,
      [...PLAN_OPEN, today]
    ).catch(() => []);
    const lateplans = [];
    for (const pl of plans) {
      if (!to.length) { out.skipped_no_recipient++; continue; }
      const id = await claimNotice(`plan_overdue:${pl.id}:${pl.due_date}`, "plan_overdue", pl.employee_id, pl.id, to.join(", "));
      if (!id) continue;
      const emp = await dbGet("SELECT name FROM hr_employees WHERE id = ?", [pl.employee_id]).catch(() => null);
      lateplans.push({ claim: id, plan: pl, name: emp ? emp.name : `Employee ${pl.employee_id}` });
    }
    if (lateplans.length) {
      const body = noticeList(lateplans.map((d) =>
        `<strong>${esc(d.name)}</strong> — due ${esc(d.plan.due_date)}, ${esc(d.plan.status || "not started")}`
        + (d.plan.responsible_supervisor ? `, with ${esc(d.plan.responsible_supervisor)}` : "")
        + (d.plan.description ? `<br><span style="color:#6b7280;">${esc(d.plan.description)}</span>` : "")));
      try {
        await sendEmail({
          to: to.join(", "),
          subject: `${lateplans.length} Fidelity Action Plan${lateplans.length === 1 ? " is" : "s are"} overdue`,
          html: noticeShell("Action Plans overdue",
            "These Action Plans have passed the date they were due and are not marked complete.",
            body,
            "An Action Plan exists because somebody needed retraining. Closing it means the retraining happened, not that the date passed."),
          type: "fidelity_plans_overdue",
        });
        out.plan_overdue = lateplans.length;
        // The tasks are raised only once the digest is away. A failed send
        // releases the claims so the whole notice is retried tomorrow, and
        // raising the tasks before that point would mean a second task for
        // the same plan on every retry.
        for (const d of lateplans) {
          await createStaffTask({
            title: `Overdue Fidelity Action Plan — ${d.name}`,
            notes: `Assigned ${d.plan.date_assigned || "—"}, due ${d.plan.due_date}. ${d.plan.description || ""}`.trim(),
            created_by: "system",
          }).catch(() => {});
        }
      } catch (e) {
        for (const d of lateplans) await releaseNotice(d.claim);
      }
    }

    // ---- 2b. observations that were asked for and have not happened ----
    // Chased to the person who was ASKED, not to leadership: they are the one
    // who can do something about it. Once per due date, so moving the date is
    // what re-arms it rather than the passage of another day.
    const lateAssignments = await dbAll(
      `SELECT * FROM fidelity_checks
        WHERE finalized_at IS NULL AND COALESCE(voided, FALSE) = FALSE
          AND status IN (${CHECK_UNSTARTED.map(() => "?").join(",")})
          AND assignment_due_date IS NOT NULL AND assignment_due_date < ?`,
      [...CHECK_UNSTARTED, today]
    ).catch(() => []);
    for (const c of lateAssignments) {
      const ev = c.evaluator_user_id
        ? await dbGet("SELECT id, name, email FROM users WHERE id = ?", [c.evaluator_user_id]).catch(() => null)
        : null;
      if (!ev || !ev.email) continue;
      const id = await claimNotice(`assignment_overdue:${c.id}:${c.assignment_due_date}`, "assignment_overdue", c.employee_id, c.id, ev.email);
      if (!id) continue;
      const emp = await dbGet("SELECT name FROM hr_employees WHERE id = ?", [c.employee_id]).catch(() => null);
      try {
        await sendEmail({
          to: ev.email,
          subject: `Fidelity Check overdue: ${emp ? emp.name : "an RBT"}`,
          html: `<p>Hi ${esc(String(ev.name || "there").split(/\s+/)[0])},</p>
            <p>The Fidelity Check for <strong>${esc(emp ? emp.name : "an RBT")}</strong> was due
            <strong>${esc(c.assignment_due_date)}</strong> and has not been signed yet.</p>
            ${c.status === "in_progress" ? "<p>It is part-scored — opening it will pick up where you left off.</p>" : ""}
            <p>If it can no longer be done, say so rather than leaving it: an observation nobody does is invisible.</p>`,
          type: "fidelity_assignment_overdue", refType: "fidelity_check", refId: c.id,
        });
        await audit(c.id, "assignment_chased", { actor: "system", new: ev.email });
        out.assignment_overdue = (out.assignment_overdue || 0) + 1;
      } catch (e) {
        await releaseNotice(id);
        await audit(c.id, "assignment_chase_failed", { actor: "system", new: e.message });
      }
    }

    // ---- 2c. scored, and never signed ----
    // The most losable thing in the module: the observation happened, the
    // rubric is complete, and it is on nobody's record because one button was
    // not pressed. Chased after a couple of days, to the evaluator.
    const SIGN_GRACE_DAYS = 2;
    const signCutoff = new Date(Date.now() - SIGN_GRACE_DAYS * 86400000).toISOString();
    const unsigned = await dbAll(
      `SELECT * FROM fidelity_checks
        WHERE finalized_at IS NULL AND COALESCE(voided, FALSE) = FALSE
          AND status = 'awaiting_signature' AND updated_at < ?`,
      [signCutoff]
    ).catch(() => []);
    for (const c of unsigned) {
      const ev = c.evaluator_user_id
        ? await dbGet("SELECT id, name, email FROM users WHERE id = ?", [c.evaluator_user_id]).catch(() => null)
        : null;
      if (!ev || !ev.email) continue;
      const id = await claimNotice(`unsigned_complete:${c.id}`, "unsigned_complete", c.employee_id, c.id, ev.email);
      if (!id) continue;
      const emp = await dbGet("SELECT name FROM hr_employees WHERE id = ?", [c.employee_id]).catch(() => null);
      const calc = scoreOf(parseJson(c.scores_json, {}));
      try {
        await sendEmail({
          to: ev.email,
          subject: `Fidelity Check scored but not signed: ${emp ? emp.name : "an RBT"}`,
          html: `<p>Hi ${esc(String(ev.name || "there").split(/\s+/)[0])},</p>
            <p>You scored every item of the Fidelity Check for <strong>${esc(emp ? emp.name : "an RBT")}</strong>
            (${calc.total_score}/${MAX_SCORE}, ${calc.percentage}%) and it has not been signed.</p>
            <p>Until it is signed it counts towards nothing and the RBT has not been told. Nothing is lost — the scores are
            saved exactly as you left them.</p>`,
          type: "fidelity_unsigned", refType: "fidelity_check", refId: c.id,
        });
        await audit(c.id, "unsigned_chased", { actor: "system", new: ev.email });
        out.unsigned_complete = (out.unsigned_complete || 0) + 1;
      } catch (e) {
        await releaseNotice(id);
        await audit(c.id, "unsigned_chase_failed", { actor: "system", new: e.message });
      }
    }

    // ---- 3. assessments nobody acknowledged ----
    // To the employee, not to leadership: they are the one who has to act, and
    // a manager cannot acknowledge on their behalf. Once, then it stays on the
    // dashboard rather than becoming a weekly nag.
    const ACK_GRACE_DAYS = 7;
    const graceCutoff = new Date(Date.now() - ACK_GRACE_DAYS * 86400000).toISOString();
    const unacked = await dbAll(
      `SELECT * FROM fidelity_checks
        WHERE finalized_at IS NOT NULL AND employee_ack_at IS NULL
          AND emailed_at IS NOT NULL AND emailed_at < ?
          AND COALESCE(voided, FALSE) = FALSE
          -- An assessment corrected before it was acknowledged does not need
          -- acknowledging: the acknowledgment page refuses it, so chasing
          -- somebody for it would send them to a dead end.
          AND superseded_by_check_id IS NULL`,
      [graceCutoff]
    ).catch(() => []);
    for (const c of unacked) {
      const emp = await dbGet("SELECT id, name, email FROM hr_employees WHERE id = ?", [c.employee_id]).catch(() => null);
      if (!emp || !emp.email) continue;
      const id = await claimNotice(`ack_outstanding:${c.id}`, "ack_outstanding", c.employee_id, c.id, emp.email);
      if (!id) continue;
      const calc = scoreOf(parseJson(c.scores_json, {}),
        { unsafe_practice: c.unsafe_practice === true || c.unsafe_practice === "t" });
      try {
        await sendEmail({
          to: emp.email,
          subject: "Reminder: your Fidelity Check is waiting for you",
          html: fidelityEmailHtml(emp, c, calc, `${APP_BASE_URL}/fidelity-ack/${c.ack_token}`),
          type: "fidelity_ack_reminder", refType: "fidelity_check", refId: c.id,
        });
        await audit(c.id, "ack_reminder_sent", { actor: "system", new: emp.email });
        out.ack_outstanding++;
      } catch (e) {
        await releaseNotice(id);
        await audit(c.id, "ack_reminder_failed", { actor: "system", new: e.message });
      }
    }

    // ---- 4. annual reviews coming up ----
    // Thirty days' notice, because a raise review needs the Fidelity Checks to
    // already exist -- being told on the day is being told too late.
    const REVIEW_NOTICE_DAYS = 30;
    const horizon = new Date(Date.now() + REVIEW_NOTICE_DAYS * 86400000).toISOString().slice(0, 10);
    const upcoming = dash.employees.filter((r) =>
      r.annual_review_date && r.annual_review_date >= today && r.annual_review_date <= horizon);
    const claimed = [];
    for (const r of upcoming) {
      if (!to.length) { out.skipped_no_recipient++; continue; }
      const id = await claimNotice(`review_due:${r.employee_id}:${r.annual_review_date}`, "review_due", r.employee_id, null, to.join(", "));
      if (id) claimed.push({ claim: id, row: r });
    }
    if (claimed.length) {
      const body = noticeList(claimed.map((d) =>
        `<strong>${esc(d.row.name)}</strong> — review ${esc(d.row.annual_review_date)}`
        + (d.row.checks ? `, ${d.row.checks} Fidelity Check${d.row.checks === 1 ? "" : "s"} on file`
                        : `, <span style="color:#b45309;">no Fidelity Checks on file</span>`)
        + (d.row.hourly_rate == null ? `, <span style="color:#b45309;">no hourly rate on file</span>` : "")));
      try {
        await sendEmail({
          to: to.join(", "),
          subject: `${claimed.length} annual review${claimed.length === 1 ? "" : "s"} coming up`,
          html: noticeShell("Annual reviews",
            `${claimed.length === 1 ? "An annual review is" : claimed.length + " annual reviews are"} due within the next ${REVIEW_NOTICE_DAYS} days.`,
            body,
            "The CRM will calculate the recommended raise from the Fidelity Checks on file and show the working. Anyone without checks or without an hourly rate on file is flagged above, because those are the two things it cannot work around."),
          type: "fidelity_reviews_due",
        });
        out.review_due = claimed.length;
      } catch (e) {
        for (const d of claimed) await releaseNotice(d.claim);
      }
    }

    return out;
  }

  // ======================= ROUTES =======================
  // Two gates, checked per route rather than once at the top, because the two
  // permissions genuinely differ: an evaluator may open and score a check but
  // must not browse anybody's history, see rankings, or go near a raise.
  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/fidelity")) return false;

    // ---- the acknowledgment page is PUBLIC, by token ----
    // The employee is not necessarily a CRM user; a token in their email is how
    // they reach their own assessment. It shows and acknowledges. It can change
    // no score.
    if (pathname === "/api/fidelity/public/check" && method === "GET") {
      const row = await dbGet("SELECT * FROM fidelity_checks WHERE ack_token = ?", [String(query.token || "")]).catch(() => null);
      if (!row || !String(query.token || "")) return json(res, 404, { error: "That link is not valid." });
      const emp = await dbGet("SELECT name FROM hr_employees WHERE id = ?", [row.employee_id]).catch(() => null);
      const out = shapePublic(row, emp);
      if (row.superseded_by_check_id) {
        const nu = await dbGet(
          "SELECT assessment_date, total_score, max_score, percentage, rating_label FROM fidelity_checks WHERE id = ?",
          [row.superseded_by_check_id]).catch(() => null);
        // The figures of the assessment that stands, but NOT its token: this
        // link belongs to the old one, and the new one was emailed separately.
        if (nu) out.replacement = { assessment_date: nu.assessment_date, total_score: nu.total_score,
          max_score: nu.max_score, percentage: nu.percentage == null ? null : Number(nu.percentage),
          rating_label: nu.rating_label };
      }
      return json(res, 200, out);
    }
    if (pathname === "/api/fidelity/public/acknowledge" && method === "POST") {
      const b = await readBody(req).catch(() => ({}));
      const row = await dbGet("SELECT * FROM fidelity_checks WHERE ack_token = ?", [String(b.token || "")]).catch(() => null);
      if (!row) return json(res, 404, { error: "That link is not valid." });
      if (row.employee_ack_at) return json(res, 200, { ok: true, already: true, acknowledged_at: row.employee_ack_at });
      // Acknowledging a result that has been corrected or withdrawn would have
      // somebody sign for a score that does not stand.
      if (row.superseded_by_check_id) {
        return json(res, 409, { code_key: "superseded", error:
          "This assessment was corrected after it was sent to you. There is nothing to acknowledge here — a newer one was emailed to you, and that is the one that counts." });
      }
      if (row.voided === true || row.voided === "t") {
        return json(res, 409, { code_key: "voided", error:
          "This assessment was withdrawn and does not count. There is nothing to acknowledge." });
      }
      const name = String(b.signed_name || "").trim();
      if (!name) return json(res, 400, { error: "Type your name to acknowledge." });
      const at = nowISO();
      await dbRun("UPDATE fidelity_checks SET employee_ack_name = ?, employee_ack_at = ?, status = 'acknowledged', updated_at = ? WHERE id = ?",
        [name, at, at, row.id]);
      await audit(row.id, "employee_acknowledged", { actor: name, new: at });
      // The filed PDF is regenerated so the copy in the personnel record shows
      // the acknowledgment too, rather than the version signed before it.
      try {
        const fresh = await dbGet("SELECT * FROM fidelity_checks WHERE id = ?", [row.id]);
        const emp = await dbGet("SELECT id, name FROM hr_employees WHERE id = ?", [row.employee_id]).catch(() => null);
        const docId = await buildPdf(fresh, emp);
        if (docId) {
          await dbRun("UPDATE fidelity_checks SET pdf_document_id = ?, pdf_generated_at = ? WHERE id = ?", [docId, nowISO(), row.id]);
          await audit(row.id, "pdf_regenerated_with_acknowledgment", { actor: "system", new: String(docId) });
        }
      } catch (e) { await audit(row.id, "pdf_failed", { actor: "system", new: e.message }); }
      return json(res, 200, { ok: true, acknowledged_at: at });
    }

    if (!user) return json(res, 401, { error: "Please sign in." });
    const actor = (user && (user.email || user.name)) || "unknown";
    const manage = canManageFidelity(user);
    const evaluate = canEvaluate(user);
    if (!evaluate) return json(res, 403, { error: "Not permitted to use RBT Fidelity." });

    // What the rubric IS -- needed by the scoring screen, and safe for an
    // evaluator: it is the blank form, not anybody's results.
    if (pathname === "/api/fidelity/rubric" && method === "GET") {
      return json(res, 200, {
        sections: SECTIONS, max_score: MAX_SCORE, ratings: RATINGS,
        action_plan_options: ACTION_PLAN_OPTIONS,
        session_types: SESSION_TYPES, observation_lengths: OBSERVATION_LENGTHS,
        statuses: STATUSES,
        plan_statuses: PLAN_STATUSES,
        plan_open_statuses: PLAN_OPEN,
        plan_status_labels: PLAN_STATUS_LABEL,
      });
    }

    // ---- everything below here is leadership, except the evaluator's own check ----
    if (pathname === "/api/fidelity/dashboard" && method === "GET") {
      if (!manage) return json(res, 403, { error: "Not permitted to view the Fidelity dashboard." });
      return json(res, 200, await dashboard(query));
    }
    // Run the notice sweep now. It runs itself daily; this is for somebody who
    // has just fixed an email address, or changed the interval, and wants to
    // know what it would send rather than waiting until tomorrow. It reports
    // exactly what it sent, and cannot send the same notice twice.
    if (pathname === "/api/fidelity/sweep" && method === "POST") {
      if (!manage) return json(res, 403, { error: "Not permitted." });
      const result = await sweep();
      await audit(null, "sweep_run", { actor, new: JSON.stringify(result) });
      return json(res, 200, { ok: true, ...result });
    }
    // Where the team as a whole loses points. Leadership only: it is a view
    // across everybody, which is exactly what an evaluator must not have.
    if (pathname === "/api/fidelity/insights" && method === "GET") {
      if (!manage) return json(res, 403, { error: "Not permitted." });
      return json(res, 200, await insights(query));
    }
    if (pathname === "/api/fidelity/random" && method === "POST") {
      if (!manage) return json(res, 403, { error: "Not permitted." });
      return json(res, 200, await randomPick());
    }
    if (pathname === "/api/fidelity/settings" && method === "GET") {
      if (!manage) return json(res, 403, { error: "Not permitted." });
      return json(res, 200, { ...(await getSettings()), categories: CATEGORIES, methods: FIDELITY_METHODS });
    }
    if (pathname === "/api/fidelity/settings" && method === "PUT") {
      if (!manage) return json(res, 403, { error: "Not permitted." });
      const b = await readBody(req);
      if (b.weights) {
        const problem = weightsProblem(b.weights);
        if (problem) return json(res, 400, { error: problem });
      }
      const cur = await getSettings();
      await dbRun(
        `INSERT INTO fidelity_settings (id, raise_bands_json, weights_json, fidelity_method, critical_fail_policy,
           pip_policy, min_checks_required, max_raise_percent, min_performance_percent, assumed_weekly_hours,
           check_interval_days, updated_by, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           raise_bands_json = EXCLUDED.raise_bands_json, weights_json = EXCLUDED.weights_json,
           fidelity_method = EXCLUDED.fidelity_method, critical_fail_policy = EXCLUDED.critical_fail_policy,
           pip_policy = EXCLUDED.pip_policy, min_checks_required = EXCLUDED.min_checks_required,
           max_raise_percent = EXCLUDED.max_raise_percent, min_performance_percent = EXCLUDED.min_performance_percent,
           assumed_weekly_hours = EXCLUDED.assumed_weekly_hours, check_interval_days = EXCLUDED.check_interval_days,
           updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [JSON.stringify(b.bands || cur.bands), JSON.stringify(b.weights || cur.weights),
         b.fidelity_method || cur.fidelity_method, b.critical_fail_policy || cur.critical_fail_policy,
         b.pip_policy || cur.pip_policy,
         b.min_checks_required != null ? Number(b.min_checks_required) : cur.min_checks_required,
         b.max_raise_percent != null ? Number(b.max_raise_percent) : cur.max_raise_percent,
         b.min_performance_percent != null ? Number(b.min_performance_percent) : cur.min_performance_percent,
         b.assumed_weekly_hours != null ? Number(b.assumed_weekly_hours) : cur.assumed_weekly_hours,
         b.check_interval_days != null ? Number(b.check_interval_days) : cur.check_interval_days,
         actor, nowISO()]
      );
      await audit(null, "settings_updated", { actor });
      return json(res, 200, { ok: true, ...(await getSettings()) });
    }

    // One employee's whole Fidelity picture: snapshot, history, trend points.
    const empMatch = pathname.match(/^\/api\/fidelity\/employee\/(\d+)$/);
    if (empMatch && method === "GET") {
      if (!manage) return json(res, 403, { error: "Not permitted to view an employee's Fidelity history." });
      const id = Number(empMatch[1]);
      const emp = await dbGet("SELECT id, name, email, role_title, status, hire_date, annual_review_date, hourly_rate FROM hr_employees WHERE id = ?", [id]);
      if (!emp) return json(res, 404, { error: "That staff member is not on file." });
      const rows = await finalizedChecks(id);
      const sum = summarise(rows);
      // The history shows everything that was ever signed, including the
      // superseded and the voided, each marked. The summary and the graph
      // read `rows` -- only the checks that still count.
      const everything = await allChecksFor(id);
      const plans = await dbAll("SELECT * FROM fidelity_action_plans WHERE employee_id = ? ORDER BY id DESC", [id]).catch(() => []);
      // When the next check is due, worked out here rather than on whichever
      // screen happens to be showing it -- the dashboard and the personnel
      // record must not be able to disagree about whether somebody is overdue.
      const settings = await getSettings();
      const todayStr = nowISO().slice(0, 10);
      // The same fact the roster shows: somebody has already been asked. A
      // personnel record saying "due now" for an RBT whose observation is
      // booked is the same wrong answer in a different place.
      const pendingRow = await dbGet(
        `SELECT id, status, evaluator_name, assignment_due_date FROM fidelity_checks
          WHERE employee_id = ? AND finalized_at IS NULL AND COALESCE(voided, FALSE) = FALSE
            AND status IN (${CHECK_LIVE.map(() => "?").join(",")})
          ORDER BY id DESC LIMIT 1`,
        [id, ...CHECK_LIVE]
      ).catch(() => null);
      const nextDue = sum.last_check_date
        ? new Date(new Date(sum.last_check_date + "T00:00:00Z").getTime() + settings.check_interval_days * 86400000).toISOString().slice(0, 10)
        : null;
      return json(res, 200, {
        employee: emp, summary: sum,
        // Whether this person is somebody Fidelity applies to at all, decided
        // by the same rule the dashboard uses rather than by the screen
        // guessing from a job title.
        is_rbt: isRbt(emp),
        pending_check: pendingRow ? {
          id: pendingRow.id, status: pendingRow.status, evaluator: pendingRow.evaluator_name || null,
          due_date: pendingRow.assignment_due_date || null,
          overdue: !!(pendingRow.assignment_due_date && pendingRow.assignment_due_date < todayStr),
        } : null,
        next_due: nextDue,
        overdue_check: !nextDue || nextDue <= todayStr,
        check_interval_days: settings.check_interval_days,
        history: everything.map(shapeRow),
        // Oldest first, which is the direction a graph reads.
        trend_points: rows.slice().reverse().map((r) => ({
          date: r.assessment_date, percentage: Number(r.percentage), score: r.total_score,
          rating: r.rating_label, evaluator: r.evaluator_name, id: r.id,
        })),
        action_plans: plans.map(shapePlan),
      });
    }

    // ---- a single check ----
    const oneMatch = pathname.match(/^\/api\/fidelity\/check\/(\d+)$/);
    if (oneMatch && method === "GET") {
      const row = await dbGet("SELECT * FROM fidelity_checks WHERE id = ?", [Number(oneMatch[1])]);
      if (!row) return json(res, 404, { error: "Not found" });
      // An evaluator may open the check they are conducting, and no other.
      if (!manage && Number(row.evaluator_user_id) !== Number(user.id)) {
        return json(res, 403, { error: "This Fidelity Check is not assigned to you." });
      }
      const emp = await dbGet("SELECT id, name, email, role_title, hire_date FROM hr_employees WHERE id = ?", [row.employee_id]).catch(() => null);
      const trail = manage
        ? await dbAll("SELECT * FROM fidelity_audit WHERE check_id = ? ORDER BY id", [row.id]).catch(() => [])
        : [];
      // The evaluator sees the RBT's previous result for context, and nothing
      // resembling a comparison against colleagues.
      const prior = manage || Number(row.evaluator_user_id) === Number(user.id)
        ? summarise((await finalizedChecks(row.employee_id)).filter((r) => r.id !== row.id))
        : null;
      return json(res, 200, { check: shapeRow(row, true), employee: emp, audit: trail, prior });
    }

    // ---- ask somebody to do an observation ----
    // The random picker names who is due and then stopped: there was no way to
    // hand that to anybody, so "select a random RBT" ended in whoever pressed
    // the button doing it themselves or nobody doing it at all. An assignment
    // is a check that exists before the observation, addressed to an evaluator
    // and dated.
    if (pathname === "/api/fidelity/assign" && method === "POST") {
      if (!manage) return json(res, 403, { error: "Not permitted to assign Fidelity Checks." });
      const b = await readBody(req);
      const employeeId = Number(b.employee_id);
      if (!employeeId) return json(res, 400, { error: "Choose which RBT is to be observed." });
      const emp = await dbGet("SELECT id, name FROM hr_employees WHERE id = ?", [employeeId]);
      if (!emp) return json(res, 404, { error: "That staff member is not on file." });

      const evaluatorId = Number(b.evaluator_user_id);
      if (!evaluatorId) return json(res, 400, { error: "Choose who is being asked to do the observation." });
      const ev = await dbGet("SELECT id, name, email, role, module_access FROM users WHERE id = ?", [evaluatorId]);
      if (!ev) return json(res, 404, { error: "That user does not exist." });
      // Assigning to somebody who cannot open the check would produce an
      // assignment nobody can act on and an email that leads to a 403.
      if (!canEvaluate(ev)) {
        return json(res, 400, { error: `${ev.name || "That user"} does not have Fidelity access, so they could not open the check. Grant Fidelity Evaluator first.` });
      }
      const assignSelf = await selfObservationProblem(ev.email, employeeId);
      if (assignSelf) return json(res, 400, { error: assignSelf, code_key: "self_observation" });

      const due = String(b.due_date || "").trim() || null;
      const now = nowISO();
      const row = await dbGet(
        `INSERT INTO fidelity_checks
           (employee_id, evaluator_user_id, evaluator_name, assessment_date, session_type,
            observation_minutes, scores_json, status, assigned_by, assigned_at,
            assignment_due_date, assignment_note, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '{}', 'assigned', ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [employeeId, evaluatorId, ev.name || ev.email || null,
         // NO assessment date. The observation has not happened, and seeding
         // it with the due date would let a future date become the signed date
         // of an assessment nobody has done yet -- which is precisely what the
         // guard at signing exists to prevent. The expected date lives in
         // assignment_due_date, where it cannot be mistaken for a fact.
         null, b.session_type || null,
         b.observation_minutes != null ? Number(b.observation_minutes) : null,
         actor, now, due, String(b.note || "").trim() || null, actor, now, now]
      );
      await audit(row.id, "assigned", { actor, new: `${emp.name} to ${ev.name || ev.email}${due ? ", due " + due : ""}` });

      // Told, not left to be noticed. Both, because an email can be missed and
      // a task list can be ignored, and an observation that never happens is
      // the failure this whole module exists to prevent.
      if (ev.email) {
        try {
          await sendEmail({
            to: ev.email,
            subject: `Fidelity Check to complete: ${emp.name}`,
            html: `<p>Hi ${esc(String(ev.name || "there").split(/\s+/)[0])},</p>
              <p>You have been asked to complete a Fidelity Check for <strong>${esc(emp.name)}</strong>${due ? ` by <strong>${esc(due)}</strong>` : ""}.</p>
              ${b.note ? `<p>${esc(String(b.note))}</p>` : ""}
              <p>Open RBT Fidelity in the CRM to score it. The form adds up as you go; you will not need to total anything.</p>`,
            type: "fidelity_assigned", refType: "fidelity_check", refId: row.id,
          });
          await audit(row.id, "assignment_emailed", { actor: "system", new: ev.email });
        } catch (e) { await audit(row.id, "assignment_email_failed", { actor: "system", new: e.message }); }
      }
      await createStaffTask({
        title: `Fidelity Check to complete — ${emp.name}`,
        notes: `Assigned by ${actor}${due ? `, due ${due}` : ""}.` + (b.note ? ` ${b.note}` : ""),
        created_by: actor,
      }).catch(() => {});

      return json(res, 201, { ok: true, id: row.id, assigned_to: ev.name || ev.email, due_date: due });
    }

    // Who could actually be asked to do an observation. Served by this module
    // rather than read from the admin users API, for two reasons: that API is
    // restricted to account administrators, so a Clinical Director holding a
    // Fidelity grant would have got an empty list and been told nobody has
    // access -- and the rule for who can evaluate is canEvaluate(), which
    // lives here. Asking the admin API meant a screen re-deciding a permission
    // question it does not own.
    if (pathname === "/api/fidelity/evaluators" && method === "GET") {
      if (!manage) return json(res, 403, { error: "Not permitted." });
      const rows = await dbAll("SELECT id, name, email, role, module_access FROM users ORDER BY name").catch(() => []);
      return json(res, 200, {
        evaluators: rows.filter(canEvaluate).map((u) => ({
          id: u.id, name: u.name || u.email, email: u.email,
          // Says which of the two grants they hold, so somebody choosing can
          // see they are handing work to a manager rather than an evaluator.
          manages: canManageFidelity(u),
        })),
      });
    }

    // What this evaluator has been asked to do. Available to anybody who can
    // evaluate, because it is their own work and nobody else's.
    if (pathname === "/api/fidelity/my-assignments" && method === "GET") {
      const rows = await dbAll(
        `SELECT * FROM fidelity_checks
          WHERE evaluator_user_id = ? AND finalized_at IS NULL AND COALESCE(voided, FALSE) = FALSE
            AND status IN (${CHECK_LIVE.map(() => "?").join(",")})
          ORDER BY COALESCE(assignment_due_date, '9999-12-31'), id`,
        [user.id, ...CHECK_LIVE]
      ).catch(() => []);
      const today = nowISO().slice(0, 10);
      const out = [];
      for (const r of rows) {
        const emp = await dbGet("SELECT id, name, role_title FROM hr_employees WHERE id = ?", [r.employee_id]).catch(() => null);
        const calc = scoreOf(parseJson(r.scores_json, {}));
        out.push({
          id: r.id, employee_id: r.employee_id, employee_name: emp ? emp.name : null,
          status: r.status, assigned_by: r.assigned_by, assigned_at: r.assigned_at,
          due_date: r.assignment_due_date, note: r.assignment_note,
          overdue: !!(r.assignment_due_date && r.assignment_due_date < today),
          scored: calc.answered, items_total: calc.items_total, complete: calc.complete,
        });
      }
      return json(res, 200, { assignments: out });
    }

    if (pathname === "/api/fidelity/check" && method === "POST") {
      const b = await readBody(req);
      const employeeId = Number(b.employee_id);
      if (!employeeId) return json(res, 400, { error: "Choose which RBT is being observed." });
      const emp = await dbGet("SELECT id, name FROM hr_employees WHERE id = ?", [employeeId]);
      if (!emp) return json(res, 404, { error: "That staff member is not on file." });
      const initialsProblem = clientInitialsProblem(b.client_initials);
      if (initialsProblem) return json(res, 400, { error: initialsProblem });
      const selfProblem = await selfObservationProblem(
        b.evaluator_user_id != null && Number(b.evaluator_user_id) !== Number(user.id)
          ? ((await dbGet("SELECT email FROM users WHERE id = ?", [Number(b.evaluator_user_id)]).catch(() => null)) || {}).email
          : user.email,
        employeeId);
      if (selfProblem) return json(res, 400, { error: selfProblem, code_key: "self_observation" });
      const now = nowISO();
      const row = await dbGet(
        `INSERT INTO fidelity_checks
           (employee_id, evaluator_user_id, evaluator_name, evaluator_credentials, assessment_date,
            client_initials, session_type, observation_minutes, scores_json, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', 'in_progress', ?, ?, ?) RETURNING id`,
        [employeeId, b.evaluator_user_id != null ? Number(b.evaluator_user_id) : (user.id || null),
         b.evaluator_name || user.name || user.email || null, b.evaluator_credentials || null,
         b.assessment_date || now.slice(0, 10), b.client_initials || null,
         b.session_type || null, b.observation_minutes != null ? Number(b.observation_minutes) : null,
         actor, now, now]
      );
      await audit(row.id, "created", { actor, new: `for ${emp.name}` });
      return json(res, 201, { ok: true, id: row.id });
    }

    if (oneMatch && method === "PATCH") {
      const id = Number(oneMatch[1]);
      const row = await dbGet("SELECT * FROM fidelity_checks WHERE id = ?", [id]);
      if (!row) return json(res, 404, { error: "Not found" });
      if (!manage && Number(row.evaluator_user_id) !== Number(user.id)) {
        return json(res, 403, { error: "This Fidelity Check is not assigned to you." });
      }
      if (row.finalized_at) {
        return json(res, 409, { error: "This Fidelity Check is signed and can no longer be edited. Create an amendment instead." });
      }
      const b = await readBody(req);
      if (b.assessment_date !== undefined && b.assessment_date !== null && String(b.assessment_date).trim() !== "") {
        const p = assessmentDateProblem(b.assessment_date, nowISO().slice(0, 10));
        if (p) return json(res, 400, { error: p });
      }
      if (b.client_initials !== undefined) {
        const p = clientInitialsProblem(b.client_initials);
        if (p) return json(res, 400, { error: p });
      }
      const fields = ["assessment_date", "client_initials", "session_type", "observation_minutes",
        "strengths", "areas_for_improvement", "action_plan_narrative", "unsafe_practice",
        "unsafe_practice_detail", "critical_fail_detail", "evaluator_credentials"];
      const sets = [], vals = [];
      for (const f of fields) {
        if (b[f] === undefined) continue;
        sets.push(`${f} = ?`); vals.push(b[f]);
        if (String(row[f] == null ? "" : row[f]) !== String(b[f] == null ? "" : b[f])) {
          await audit(id, "edited", { actor, field: f, old: row[f], new: b[f] });
        }
      }
      if (b.scores && typeof b.scores === "object") {
        const merged = { ...parseJson(row.scores_json, {}), ...b.scores };
        // Only 0, 1 and 2 are scores. Anything else is dropped rather than
        // stored, so a stray value cannot end up in a total.
        for (const k of Object.keys(merged)) {
          if (![0, 1, 2].includes(merged[k])) delete merged[k];
        }
        sets.push("scores_json = ?"); vals.push(JSON.stringify(merged));
      }
      if (Array.isArray(b.action_plan_options)) {
        sets.push("action_plan_options = ?"); vals.push(JSON.stringify(b.action_plan_options));
      }
      if (!sets.length) return json(res, 200, { ok: true, unchanged: true });
      sets.push("updated_at = ?"); vals.push(nowISO());
      await dbRun(`UPDATE fidelity_checks SET ${sets.join(", ")} WHERE id = ?`, [...vals, id]);
      let fresh = await dbGet("SELECT * FROM fidelity_checks WHERE id = ?", [id]);
      const calc = scoreOf(parseJson(fresh.scores_json, {}),
        { unsafe_practice: fresh.unsafe_practice === true || fresh.unsafe_practice === "t" });

      // The status follows the work rather than being a field somebody has to
      // remember to change. A fully scored, unsigned check is the state worth
      // seeing: the observation HAPPENED and is not yet on anybody's record,
      // which is how a completed observation gets lost.
      const want = calc.complete ? "awaiting_signature" : "in_progress";
      if (fresh.status !== want && [...CHECK_LIVE, "draft"].includes(fresh.status)) {
        await dbRun("UPDATE fidelity_checks SET status = ? WHERE id = ?", [want, id]);
        fresh = await dbGet("SELECT * FROM fidelity_checks WHERE id = ?", [id]);
      }
      // The live score comes back on every save, so the screen never adds up.
      return json(res, 200, { ok: true, calc, status: fresh.status, action_plan_required: actionPlanRequired(calc) });
    }

    const finalMatch = pathname.match(/^\/api\/fidelity\/check\/(\d+)\/finalize$/);
    if (finalMatch && method === "POST") {
      const id = Number(finalMatch[1]);
      const row = await dbGet("SELECT * FROM fidelity_checks WHERE id = ?", [id]);
      if (!row) return json(res, 404, { error: "Not found" });
      if (!manage && Number(row.evaluator_user_id) !== Number(user.id)) {
        return json(res, 403, { error: "This Fidelity Check is not assigned to you." });
      }
      const b = await readBody(req);
      const out = await finalizeCheck(id, user, b);
      return json(res, out.ok ? 200 : (out.code || 400), out);
    }

    // ---- amend a signed check ----
    // The CRM tells people to do this in two different refusal messages, so it
    // has to exist. Voiding is the wrong tool for a mistyped score: it
    // withdraws the assessment entirely, and the observation still happened.
    //
    // An amendment is a NEW check that starts as a copy of the original and
    // supersedes it when it is signed. The original is never edited, never
    // deleted and never hidden -- it stays on the record, marked, with its
    // signature and its audit trail intact, because it is what somebody was
    // actually told on a date.
    const amendMatch = pathname.match(/^\/api\/fidelity\/check\/(\d+)\/amend$/);
    if (amendMatch && method === "POST") {
      const id = Number(amendMatch[1]);
      const row = await dbGet("SELECT * FROM fidelity_checks WHERE id = ?", [id]);
      if (!row) return json(res, 404, { error: "Not found" });
      if (!manage && Number(row.evaluator_user_id) !== Number(user.id)) {
        return json(res, 403, { error: "This Fidelity Check is not assigned to you." });
      }
      if (!row.finalized_at) {
        return json(res, 400, { error: "This Fidelity Check has not been signed yet — edit it directly instead of amending it." });
      }
      if (row.voided === true || row.voided === "t") {
        return json(res, 400, { error: "This Fidelity Check was voided. A voided assessment is withdrawn, not corrected." });
      }
      if (row.superseded_by_check_id) {
        return json(res, 409, { error: "This Fidelity Check has already been amended.", amendment_id: row.superseded_by_check_id });
      }
      const b = await readBody(req);
      const reason = String(b.reason || "").trim();
      // A correction to a signed assessment is a change to somebody's record.
      // It is allowed, and it is never anonymous or unexplained.
      if (!reason) return json(res, 400, { error: "Say what is being corrected — the reason is kept on both the original and the amendment." });

      // An amendment already in progress is offered back rather than
      // duplicated, so two half-finished corrections of one check cannot exist.
      const open = await dbGet(
        "SELECT id FROM fidelity_checks WHERE amends_check_id = ? AND finalized_at IS NULL AND COALESCE(voided, FALSE) = FALSE ORDER BY id DESC LIMIT 1",
        [id]
      ).catch(() => null);
      if (open) return json(res, 200, { ok: true, id: open.id, already_open: true });

      const now = nowISO();
      const created = await dbGet(
        `INSERT INTO fidelity_checks
           (employee_id, evaluator_user_id, evaluator_name, evaluator_credentials, assessment_date,
            client_initials, session_type, observation_minutes, scores_json,
            strengths, areas_for_improvement, action_plan_narrative, action_plan_options,
            unsafe_practice, unsafe_practice_detail, critical_fail_detail,
            status, amends_check_id, amend_reason, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?, ?) RETURNING id`,
        [row.employee_id, user.id || row.evaluator_user_id, user.name || user.email || row.evaluator_name,
         row.evaluator_credentials, row.assessment_date, row.client_initials, row.session_type,
         row.observation_minutes, row.scores_json || "{}",
         row.strengths, row.areas_for_improvement, row.action_plan_narrative, row.action_plan_options,
         row.unsafe_practice === true || row.unsafe_practice === "t", row.unsafe_practice_detail, row.critical_fail_detail,
         id, reason, actor, now, now]
      );
      await audit(id, "amendment_started", { actor, new: reason });
      await audit(created.id, "created_as_amendment", { actor, old: `copy of check ${id}`, new: reason });
      return json(res, 201, { ok: true, id: created.id, amends: id });
    }

    // ---- an assignment that will not be completed ----
    // The overdue-assignment email says "if it can no longer be done, say so
    // rather than leaving it". Until now there was no way to say so, which
    // made that sentence the same empty instruction "create an amendment" used
    // to be. An unobserved RBT is invisible; a declined assignment is a fact
    // somebody can act on.
    const releaseMatch = pathname.match(/^\/api\/fidelity\/check\/(\d+)\/release$/);
    if (releaseMatch && method === "POST") {
      const id = Number(releaseMatch[1]);
      const row = await dbGet("SELECT * FROM fidelity_checks WHERE id = ?", [id]);
      if (!row) return json(res, 404, { error: "Not found" });
      const isAssignee = Number(row.evaluator_user_id) === Number(user.id);
      if (!manage && !isAssignee) return json(res, 403, { error: "This Fidelity Check is not assigned to you." });
      if (row.finalized_at) {
        return json(res, 400, { error: "This Fidelity Check is signed. Void it if it should not stand." });
      }
      if (!CHECK_LIVE.includes(row.status)) {
        return json(res, 409, { error: "This Fidelity Check is not an open assignment.", status: row.status });
      }
      const b = await readBody(req);
      const reason = String(b.reason || "").trim();
      if (!reason) return json(res, 400, { error: "Say why it will not be done — it is kept on the record and is how the RBT gets rescheduled." });

      // WHO let it go decides what it is called. "I could not" and "we changed
      // our minds" are different facts about why an RBT went unobserved, and
      // flattening them would lose the one that says the team is short-handed.
      const declined = isAssignee && !(manage && !isAssignee);
      const status = declined ? "declined" : "cancelled";
      const now = nowISO();
      await dbRun("UPDATE fidelity_checks SET status = ?, assignment_note = ?, updated_at = ? WHERE id = ?",
        [status, (row.assignment_note ? row.assignment_note + " — " : "") + `${declined ? "Declined" : "Cancelled"} by ${actor}: ${reason}`, now, id]);
      await audit(id, status, { actor, old: row.status, new: reason });

      const emp = await dbGet("SELECT name FROM hr_employees WHERE id = ?", [row.employee_id]).catch(() => null);
      // Tell the other side. A declined assignment that leadership never hears
      // about is the same as an assignment nobody did.
      const tell = declined
        ? await leadershipRecipients()
        : (row.evaluator_user_id
            ? [(await dbGet("SELECT email FROM users WHERE id = ?", [row.evaluator_user_id]).catch(() => null) || {}).email]
            : []).filter(Boolean);
      if (tell.length) {
        try {
          await sendEmail({
            to: tell.join(", "),
            subject: `Fidelity Check ${declined ? "declined" : "cancelled"}: ${emp ? emp.name : "an RBT"}`,
            html: `<p>The Fidelity Check for <strong>${esc(emp ? emp.name : "an RBT")}</strong>`
              + `${row.assignment_due_date ? `, due ${esc(row.assignment_due_date)},` : ""} will not be completed.</p>`
              + `<p>${declined ? esc(row.evaluator_name || "The evaluator") + " said" : esc(actor) + " withdrew the request"}: ${esc(reason)}</p>`
              + (declined ? `<p>${esc(emp ? emp.name : "This RBT")} is still due an observation — they are back on the list of RBTs who need one.</p>` : ""),
            type: declined ? "fidelity_declined" : "fidelity_cancelled", refType: "fidelity_check", refId: id,
          });
          await audit(id, "release_notified", { actor: "system", new: tell.join(", ") });
        } catch (e) { await audit(id, "release_notify_failed", { actor: "system", new: e.message }); }
      }
      return json(res, 200, { ok: true, status, employee_still_due: true });
    }

    const voidMatch = pathname.match(/^\/api\/fidelity\/check\/(\d+)\/void$/);
    if (voidMatch && method === "POST") {
      if (!manage) return json(res, 403, { error: "Not permitted." });
      const b = await readBody(req);
      const reason = String(b.reason || "").trim();
      if (!reason) return json(res, 400, { error: "Say why this Fidelity Check is being voided — it is kept in the record." });
      const id = Number(voidMatch[1]);
      const row = await dbGet("SELECT * FROM fidelity_checks WHERE id = ?", [id]);
      if (!row) return json(res, 404, { error: "Not found" });
      // VOID, never delete. The record stays, marked, with its audit trail.
      await dbRun("UPDATE fidelity_checks SET voided = TRUE, void_reason = ?, voided_by = ?, voided_at = ?, updated_at = ? WHERE id = ?",
        [reason, actor, nowISO(), nowISO(), id]);
      await audit(id, "voided", { actor, new: reason });
      if (row.pdf_document_id) await refilePdf(id, "voided");
      return json(res, 200, { ok: true });
    }

    const resendMatch = pathname.match(/^\/api\/fidelity\/check\/(\d+)\/resend$/);
    if (resendMatch && method === "POST") {
      if (!manage) return json(res, 403, { error: "Not permitted." });
      const id = Number(resendMatch[1]);
      const row = await dbGet("SELECT * FROM fidelity_checks WHERE id = ?", [id]);
      if (!row) return json(res, 404, { error: "Not found" });
      if (!row.finalized_at) return json(res, 400, { error: "This Fidelity Check has not been signed yet." });
      // Sending somebody an assessment that has been corrected or withdrawn
      // presents a score that does not stand as though it were their result.
      if (row.superseded_by_check_id) {
        return json(res, 409, { error: "This Fidelity Check was amended. Send the corrected one instead.",
                                amendment_id: row.superseded_by_check_id });
      }
      if (row.voided === true || row.voided === "t") {
        return json(res, 400, { error: "This Fidelity Check was voided and does not stand. There is nothing to send." });
      }
      const emp = await dbGet("SELECT id, name, email FROM hr_employees WHERE id = ?", [row.employee_id]).catch(() => null);
      if (!emp || !emp.email) return json(res, 400, { error: "There is no email address on that staff record." });
      const calc = scoreOf(parseJson(row.scores_json, {}),
        { unsafe_practice: row.unsafe_practice === true || row.unsafe_practice === "t" });
      try {
        await sendEmail({
          to: emp.email, subject: "Your Spectrum Squad RBT Fidelity Check",
          html: fidelityEmailHtml(emp, row, calc, `${APP_BASE_URL}/fidelity-ack/${row.ack_token}`),
          type: "fidelity_check", refType: "fidelity_check", refId: id,
        });
        await dbRun("UPDATE fidelity_checks SET emailed_at = ?, email_status = 'sent' WHERE id = ?", [nowISO(), id]);
        await audit(id, "resent", { actor, new: emp.email });
        return json(res, 200, { ok: true, to: emp.email });
      } catch (e) {
        await dbRun("UPDATE fidelity_checks SET email_status = ? WHERE id = ?", ["failed: " + e.message, id]);
        await audit(id, "email_failed", { actor, new: e.message });
        return json(res, 502, { ok: false, error: e.message });
      }
    }

    // ---- the raise recommendation ----
    // Leadership only, and separate from the evaluator's world entirely: a BCBA
    // who scores an RBT must not be able to see what that score does to their
    // pay.
    const raiseMatch = pathname.match(/^\/api\/fidelity\/raise\/(\d+)$/);
    if (raiseMatch && method === "GET") {
      if (!manage) return json(res, 403, { error: "Not permitted to view raise information." });
      const id = Number(raiseMatch[1]);
      const emp = await dbGet("SELECT id, name, hourly_rate, annual_review_date, hire_date FROM hr_employees WHERE id = ?", [id]);
      if (!emp) return json(res, 404, { error: "That staff member is not on file." });
      const settings = await getSettings();
      const rows = await finalizedChecks(id);
      const sum = summarise(rows);
      // The review period defaults to the twelve months ending today, which is
      // what "this year's review" means when nobody has said otherwise.
      const end = query.period_end || nowISO().slice(0, 10);
      const start = query.period_start ||
        new Date(new Date(end + "T00:00:00Z").getTime() - 365 * 86400000).toISOString().slice(0, 10);
      const openPlans = await dbAll(
        `SELECT id, plan_types FROM fidelity_action_plans
          WHERE employee_id = ? AND status IN (${PLAN_OPEN.map(() => "?").join(",")})`, [id, ...PLAN_OPEN]
      ).catch(() => []);
      const openPip = openPlans.some((p) => (parseJson(p.plan_types, []) || []).includes("Performance Improvement Plan"));

      const extra = await gatherCategories(settings, id, start, end);
      const out = computeRaise({
        settings, summary: sum, rows,
        current_rate: emp.hourly_rate == null ? null : Number(emp.hourly_rate),
        period_start: start, period_end: end, open_pip: openPip,
        category_values: extra.values, category_details: extra.details,
      });
      return json(res, 200, {
        employee: { id: emp.id, name: emp.name, hourly_rate: emp.hourly_rate == null ? null : Number(emp.hourly_rate),
                    annual_review_date: emp.annual_review_date },
        review_period: { start, end },
        ...out,
      });
    }

    // Record the decision. The RECOMMENDATION and the FINAL figure are stored
    // separately, alongside the inputs they were computed from, so changing the
    // matrix next year cannot rewrite what somebody was awarded this year.
    const decideMatch = pathname.match(/^\/api\/fidelity\/raise\/(\d+)\/decide$/);
    if (decideMatch && method === "POST") {
      if (!manage) return json(res, 403, { error: "Not permitted." });
      const id = Number(decideMatch[1]);
      const b = await readBody(req);
      const emp = await dbGet("SELECT id, name, hourly_rate FROM hr_employees WHERE id = ?", [id]);
      if (!emp) return json(res, 404, { error: "That staff member is not on file." });
      const settings = await getSettings();
      const rows = await finalizedChecks(id);
      const sum = summarise(rows);
      const end = b.period_end || nowISO().slice(0, 10);
      const start = b.period_start ||
        new Date(new Date(end + "T00:00:00Z").getTime() - 365 * 86400000).toISOString().slice(0, 10);
      const extraD = await gatherCategories(settings, id, start, end);
      const rec = computeRaise({ settings, summary: sum, rows,
        current_rate: emp.hourly_rate == null ? null : Number(emp.hourly_rate),
        period_start: start, period_end: end, open_pip: !!b.open_pip,
        category_values: extraD.values, category_details: extraD.details });

      const finalPercent = b.final_percent == null ? rec.recommended_percent : Number(b.final_percent);
      const overridden = rec.recommended_percent == null
        ? finalPercent != null
        : Number(finalPercent) !== Number(rec.recommended_percent);
      // An override is a person disagreeing with the formula about somebody's
      // pay. It is allowed, and it is never silent.
      if (overridden && !String(b.override_reason || "").trim()) {
        return json(res, 400, { error: "Give a reason for changing the recommended raise — it is stored with the decision." });
      }
      const rate = emp.hourly_rate == null ? null : Number(emp.hourly_rate);
      const newRate = (finalPercent != null && rate != null)
        ? Math.round(rate * (1 + finalPercent / 100) * 100) / 100 : null;

      const row = await dbGet(
        `INSERT INTO fidelity_raise_reviews
           (employee_id, review_period_start, review_period_end, inputs_json, performance_score,
            recommended_percent, current_rate, recommended_increase, recommended_new_rate, explanation,
            final_percent, final_new_rate, overridden, override_reason, decided_by, decided_at, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'decided', ?, ?) RETURNING id`,
        [id, start, end, JSON.stringify({ settings, summary: sum, fidelity: rec.fidelity, components: rec.components }),
         rec.performance_score, rec.recommended_percent, rate, rec.recommended_increase, rec.recommended_new_rate,
         rec.explanation, finalPercent, newRate, overridden, b.override_reason || null,
         actor, nowISO(), actor, nowISO()]
      );
      await audit(null, "raise_decided", { actor,
        old: rec.recommended_percent == null ? "leadership review" : rec.recommended_percent + "%",
        new: (finalPercent == null ? "none" : finalPercent + "%") + " for employee " + id });
      return json(res, 201, { ok: true, id: row.id, final_percent: finalPercent, final_new_rate: newRate, overridden });
    }

    // Pay and the review date. Leadership only -- an evaluator must never see,
    // let alone set, what somebody earns.
    const payMatch = pathname.match(/^\/api\/fidelity\/employee\/(\d+)\/pay$/);
    if (payMatch && method === "PUT") {
      if (!manage) return json(res, 403, { error: "Not permitted." });
      const id = Number(payMatch[1]);
      const emp = await dbGet("SELECT id, name, hourly_rate, annual_review_date FROM hr_employees WHERE id = ?", [id]);
      if (!emp) return json(res, 404, { error: "That staff member is not on file." });
      const b = await readBody(req);
      const sets = [], vals = [];
      if (b.hourly_rate !== undefined) {
        const rate = b.hourly_rate === "" || b.hourly_rate == null ? null : Number(b.hourly_rate);
        if (rate != null && (!isFinite(rate) || rate < 0)) {
          return json(res, 400, { error: "An hourly rate must be a number, or blank to clear it." });
        }
        sets.push("hourly_rate = ?"); vals.push(rate);
        await audit(null, "pay_rate_set", { actor, field: "hourly_rate", old: emp.hourly_rate, new: rate });
      }
      if (b.annual_review_date !== undefined) {
        sets.push("annual_review_date = ?"); vals.push(b.annual_review_date || null);
        await audit(null, "annual_review_date_set", { actor, field: "annual_review_date", old: emp.annual_review_date, new: b.annual_review_date });
      }
      if (!sets.length) return json(res, 200, { ok: true, unchanged: true });
      await dbRun(`UPDATE hr_employees SET ${sets.join(", ")} WHERE id = ?`, [...vals, id]);
      return json(res, 200, { ok: true });
    }

    if (pathname === "/api/fidelity/raise-reviews" && method === "GET") {
      if (!manage) return json(res, 403, { error: "Not permitted." });
      const rows = await dbAll("SELECT * FROM fidelity_raise_reviews ORDER BY id DESC LIMIT 300").catch(() => []);
      return json(res, 200, { reviews: rows });
    }

    // ---- action plans ----
    if (pathname === "/api/fidelity/action-plans" && method === "GET") {
      if (!manage) return json(res, 403, { error: "Not permitted." });
      const rows = await dbAll("SELECT * FROM fidelity_action_plans ORDER BY id DESC LIMIT 500").catch(() => []);
      return json(res, 200, { action_plans: rows.map(shapePlan) });
    }
    const planMatch = pathname.match(/^\/api\/fidelity\/action-plan\/(\d+)$/);
    if (planMatch && method === "PATCH") {
      if (!manage) return json(res, 403, { error: "Not permitted." });
      const id = Number(planMatch[1]);
      const row = await dbGet("SELECT * FROM fidelity_action_plans WHERE id = ?", [id]);
      if (!row) return json(res, 404, { error: "Not found" });
      const b = await readBody(req);

      // A status the module does not recognise is refused rather than stored.
      // "compelted" would leave the plan open forever while looking closed on
      // the screen that typed it, and the sweep would email about it weekly.
      if (b.status !== undefined && !PLAN_STATUSES.includes(String(b.status))) {
        return json(res, 400, { error: `"${String(b.status).slice(0, 40)}" is not a status an Action Plan can have.`,
                                statuses: PLAN_STATUSES });
      }

      const closing = b.status !== undefined && !PLAN_OPEN.includes(String(b.status));
      const nowCompleted = String(b.status) === "completed";

      // Closing a plan as COMPLETED has to say what was actually done. An
      // Action Plan exists because somebody needed retraining, and a plan
      // closed with no record of it is exactly the failure the plan was raised
      // to prevent -- the date passing is not the retraining happening.
      if (nowCompleted) {
        const evidence = String(b.notes != null ? b.notes : (row.notes || "")).trim();
        const retrained = String(b.retraining_date != null ? b.retraining_date : (row.retraining_date || "")).trim();
        if (!evidence && !retrained) {
          return json(res, 400, { code_key: "completion_evidence_required", error:
            "Say what was done, or give the date the retraining happened, before marking this Action Plan complete." });
        }
      }
      // Cancelling is allowed -- a plan can be raised in error -- but never
      // silently, for the same reason voiding a check needs a reason.
      if (String(b.status) === "cancelled" && !String(b.notes || row.notes || "").trim()) {
        return json(res, 400, { error: "Say why this Action Plan is being cancelled — it stays on the record." });
      }

      const fields = ["description", "responsible_supervisor", "due_date", "retraining_date",
        "followup_fidelity_date", "notes", "completed_date", "status"];
      const sets = [], vals = [];
      for (const f of fields) {
        if (b[f] === undefined) continue;
        sets.push(`${f} = ?`); vals.push(b[f]);
        if (String(row[f] == null ? "" : row[f]) !== String(b[f] == null ? "" : b[f])) {
          await audit(row.check_id, "action_plan_edited", { actor, field: f, old: row[f], new: b[f] });
        }
      }
      // A plan closed without a date is a plan nobody can tell you the date of.
      if (closing && b.completed_date === undefined && !row.completed_date) {
        sets.push("completed_date = ?"); vals.push(nowISO().slice(0, 10));
      }
      if (Array.isArray(b.plan_types)) { sets.push("plan_types = ?"); vals.push(JSON.stringify(b.plan_types)); }
      if (!sets.length) return json(res, 200, { ok: true, unchanged: true });
      sets.push("updated_at = ?"); vals.push(nowISO());
      await dbRun(`UPDATE fidelity_action_plans SET ${sets.join(", ")} WHERE id = ?`, [...vals, id]);
      if (closing) await audit(row.check_id, "action_plan_" + String(b.status), { actor, new: `plan ${id}` });
      const fresh = await dbGet("SELECT * FROM fidelity_action_plans WHERE id = ?", [id]);
      return json(res, 200, { ok: true, action_plan: shapePlan(fresh) });
    }

    return json(res, 404, { error: "Unknown Fidelity route." });
  }

  // Overdue is COMPUTED, never a stored status that can go stale: a plan whose
  // due date passed last night is overdue this morning without anybody running
  // anything.
  function shapePlan(p) {
    const today = nowISO().slice(0, 10);
    const overdue = PLAN_OPEN.includes(p.status) && p.due_date && String(p.due_date) < today;
    return {
      id: p.id, check_id: p.check_id, employee_id: p.employee_id,
      status_label: PLAN_STATUS_LABEL[p.status] || p.status,
      open: PLAN_OPEN.includes(p.status),
      plan_types: parseJson(p.plan_types, []),
      description: p.description, responsible_supervisor: p.responsible_supervisor,
      date_assigned: p.date_assigned, due_date: p.due_date, retraining_date: p.retraining_date,
      followup_fidelity_date: p.followup_fidelity_date, notes: p.notes,
      completed_date: p.completed_date,
      status: overdue ? "overdue" : p.status,
      stored_status: p.status, overdue,
    };
  }

  function shapeRow(r, withScores) {
    const out = {
      id: r.id, employee_id: r.employee_id, assessment_date: r.assessment_date,
      client_initials: r.client_initials, session_type: r.session_type,
      observation_minutes: r.observation_minutes,
      evaluator_name: r.evaluator_name, evaluator_credentials: r.evaluator_credentials,
      total_score: r.total_score, max_score: r.max_score || MAX_SCORE,
      percentage: r.percentage == null ? null : Number(r.percentage),
      rating_key: r.rating_key, rating_label: r.rating_label,
      critical_fail: r.critical_fail === true || r.critical_fail === "t",
      critical_fail_reasons: parseJson(r.critical_fail_reasons, []),
      critical_fail_detail: r.critical_fail_detail,
      unsafe_practice: r.unsafe_practice === true || r.unsafe_practice === "t",
      unsafe_practice_detail: r.unsafe_practice_detail,
      strengths: r.strengths, areas_for_improvement: r.areas_for_improvement,
      action_plan_narrative: r.action_plan_narrative,
      action_plan_options: parseJson(r.action_plan_options, []),
      status: r.status,
      bcba_signed_name: r.bcba_signed_name, bcba_signed_at: r.bcba_signed_at,
      finalized_at: r.finalized_at, pdf_document_id: r.pdf_document_id,
      emailed_at: r.emailed_at, email_status: r.email_status,
      employee_ack_name: r.employee_ack_name, employee_ack_at: r.employee_ack_at,
      voided: r.voided === true || r.voided === "t", void_reason: r.void_reason,
      amends_check_id: r.amends_check_id || null,
      amend_reason: r.amend_reason || null,
      superseded_by_check_id: r.superseded_by_check_id || null,
      // Computed rather than stored, so a screen cannot decide for itself what
      // "counts" and disagree with the average.
      counts_towards_history: !!r.finalized_at
        && !(r.voided === true || r.voided === "t")
        && !r.superseded_by_check_id,
      created_at: r.created_at, updated_at: r.updated_at,
    };
    if (withScores) {
      out.scores = parseJson(r.scores_json, {});
      out.section_scores = parseJson(r.section_scores_json, null);
      // Recomputed alongside the stored figures so a screen can show live
      // totals on a draft, where nothing has been stored yet.
      out.calc = scoreOf(out.scores, { unsafe_practice: out.unsafe_practice });
      out.action_plan_required = actionPlanRequired(out.calc);
    }
    return out;
  }

  // What the employee sees on the acknowledgment page. Their own result in
  // full -- there is nothing here they should be shielded from -- and no token,
  // no audit trail, no other employee.
  function shapePublic(r, emp) {
    const scores = parseJson(r.scores_json, {});
    return {
      employee_name: emp ? emp.name : null,
      assessment_date: r.assessment_date, session_type: r.session_type,
      client_initials: r.client_initials, observation_minutes: r.observation_minutes,
      evaluator_name: r.evaluator_name, evaluator_credentials: r.evaluator_credentials,
      total_score: r.total_score, max_score: r.max_score || MAX_SCORE,
      percentage: r.percentage == null ? null : Number(r.percentage),
      rating_label: r.rating_label, rating_key: r.rating_key,
      critical_fail: r.critical_fail === true || r.critical_fail === "t",
      critical_fail_reasons: parseJson(r.critical_fail_reasons, []),
      critical_fail_detail: r.critical_fail_detail,
      strengths: r.strengths, areas_for_improvement: r.areas_for_improvement,
      action_plan_narrative: r.action_plan_narrative,
      action_plan_options: parseJson(r.action_plan_options, []),
      sections: SECTIONS.map((sec) => ({
        key: sec.key, label: sec.label, max: sec.max,
        items: sec.items.map((i) => ({ key: i.key, label: i.label, score: scores[i.key] == null ? null : scores[i.key] })),
      })),
      bcba_signed_name: r.bcba_signed_name, bcba_signed_at: r.bcba_signed_at,
      acknowledged_at: r.employee_ack_at, acknowledged_name: r.employee_ack_name,
      finalized: !!r.finalized_at,
      // Whether what they are looking at still stands. An RBT opening a link
      // from an old email must not be shown a score that has since been
      // corrected as though it were their result -- they are the person this
      // record is about, and they are the last to find out.
      superseded: !!r.superseded_by_check_id,
      voided: r.voided === true || r.voided === "t",
      void_reason: r.void_reason || null,
      replacement: null,
    };
  }

  // ======================= THE ACKNOWLEDGMENT PAGE =======================
  // Served at /fidelity-ack/<token>, which is where the email points. Standalone
  // HTML with no CRM session, because the RBT being assessed is not necessarily
  // a CRM user -- and the whole assessment is shown, every item and every score,
  // because it is about them and there is nothing here to withhold.
  //
  // It can acknowledge. It can change no score.
  function ackPageHtml() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Your Fidelity Check — Spectrum Squad</title>
<style>
  :root { --navy:#1b2a6b; --ink:#201a4d; --muted:#6b6a86; --line:#e6e1d4; --bg:#faf8f2; }
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);
    font:15px/1.55 "Outfit",system-ui,-apple-system,"Segoe UI",sans-serif;}
  .wrap{max-width:760px;margin:0 auto;padding:22px 16px 60px}
  .card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:14px}
  h1{font-size:21px;margin:0 0 4px;color:var(--navy)} h2{font-size:15px;margin:0 0 9px;color:var(--navy)}
  .muted{color:var(--muted);font-size:13px}
  .big{font-size:31px;font-weight:800;color:var(--navy)}
  .chip{display:inline-block;font-size:12px;font-weight:700;padding:3px 11px;border-radius:20px}
  .item{display:flex;gap:10px;padding:5px 0;border-top:1px solid #f1f1f4;font-size:13.5px}
  .sc{min-width:26px;height:26px;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;color:#fff;font-size:13px}
  .crit{background:#fee2e2;color:#991b1b;border-radius:9px;padding:11px 14px;margin-top:10px}
  input[type=text]{width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:9px;font-size:15px}
  button{background:#e0a430;color:var(--navy);font-weight:700;border:0;border-radius:999px;
    padding:13px 26px;font-size:15px;cursor:pointer;width:100%}
  button[disabled]{opacity:.55;cursor:default}
  .ok{background:#dcfce7;color:#166534;border-radius:9px;padding:13px 15px;font-weight:600}
  .err{color:#a3282e}
</style></head><body><div class="wrap" id="root">
  <div class="card"><p class="muted">Loading your Fidelity Check…</p></div>
</div>
<script>
(function(){
  var token = location.pathname.split("/").filter(Boolean).pop();
  var root = document.getElementById("root");
  function esc(s){var d=document.createElement("div");d.textContent=s==null?"":String(s);return d.innerHTML;}
  function chipFor(k){
    var m={exceptional:["#dcfce7","#166534"],meets:["#e0e7ff","#3730a3"],
           needs_improvement:["#fef3c7","#92400e"],critical:["#fee2e2","#991b1b"]};
    return m[k]||["#e5e7eb","#374151"];
  }
  function scoreColour(v){ return v===0?"#b91c1c":v===1?"#b45309":v===2?"#166534":"#9ca3af"; }
  function render(d){
    var c = chipFor(d.rating_key);
    var sections = d.sections.map(function(sec){
      return '<div class="card"><h2>'+esc(sec.label)+'</h2>'+
        sec.items.map(function(i){
          return '<div class="item"><span class="sc" style="background:'+scoreColour(i.score)+'">'+
            (i.score==null?"—":i.score)+'</span><span>'+esc(i.label)+'</span></div>';
        }).join("")+'</div>';
    }).join("");
    var narrative = [["Strengths observed",d.strengths],["Areas for improvement",d.areas_for_improvement],
                     ["Action plan",d.action_plan_narrative]]
      .filter(function(x){return x[1] && String(x[1]).trim();})
      .map(function(x){return '<div class="card"><h2>'+esc(x[0])+'</h2><div style="white-space:pre-wrap">'+esc(x[1])+'</div></div>';})
      .join("");
    var already = !!d.acknowledged_at;
    // If this assessment no longer stands, that is the first thing on the page.
    // Being shown a corrected score as though it were your result, and asked to
    // sign for it, is the sort of thing somebody only finds out at a review.
    var stale = d.superseded || d.voided;
    var staleBanner = !stale ? "" :
      '<div class="card" style="background:#fef3c7;color:#92400e">'+
        '<strong>' + (d.superseded
          ? 'This assessment was corrected after it was sent to you.'
          : 'This assessment was withdrawn.') + '</strong>'+
        '<div style="font-size:14px;margin-top:6px">' + (d.superseded
          ? ('What you see below is kept as it was signed, and no longer counts. The one that counts is dated '+
             esc((d.replacement && d.replacement.assessment_date) || "—") +
             (d.replacement ? ' — ' + d.replacement.total_score + ' / ' + d.replacement.max_score +
               ', ' + d.replacement.percentage + '%' + (d.replacement.rating_label ? ', ' + esc(d.replacement.rating_label) : "") : "") +
             '. It was emailed to you separately.')
          : ('It does not count towards your record.' + (d.void_reason ? ' Reason: ' + esc(d.void_reason) : ""))) +
        '</div>'+
      '</div>';
    root.innerHTML =
      staleBanner +
      '<div class="card">'+
        '<h1>Your Fidelity Check</h1>'+
        '<div class="muted">'+esc(d.assessment_date||"")+' · '+esc(d.session_type||"")+
          ' · '+(d.observation_minutes?esc(d.observation_minutes)+" minutes":"")+
          ' · completed by '+esc(d.evaluator_name||"your supervisor")+'</div>'+
        '<div style="margin-top:14px"><span class="big">'+d.total_score+' / '+d.max_score+'</span>'+
          '<span style="font-size:20px;font-weight:700;margin-left:9px">'+d.percentage+'%</span>'+
          '<span class="chip" style="background:'+c[0]+';color:'+c[1]+';margin-left:9px">'+esc(d.rating_label||"")+'</span></div>'+
        (d.critical_fail ? '<div class="crit"><strong>A critical fidelity concern was recorded.</strong><div style="font-size:13px;margin-top:4px">'+
            esc((d.critical_fail_reasons||[]).join("; "))+(d.critical_fail_detail?'<br>'+esc(d.critical_fail_detail):"")+
            '</div><div style="font-size:13px;margin-top:6px">Your supervisor will follow up with you directly.</div></div>' : "")+
      '</div>'+
      narrative + sections +
      '<div class="card">'+
        '<h2>Acknowledgment</h2>'+
        '<p class="muted">Acknowledging confirms you have received and read this assessment. '+
          'It does <strong>not</strong> mean you agree with every part of it. If something looks wrong, tell your supervisor — '+
          'this page cannot change any score.</p>'+
        (stale
          ? '<div class="muted">There is nothing to acknowledge here — this assessment no longer stands.</div>'
          : already
          ? '<div class="ok">Acknowledged by '+esc(d.acknowledged_name)+' on '+esc(String(d.acknowledged_at).slice(0,10))+'.</div>'
          : '<label class="muted" for="nm">Type your full name to sign</label>'+
            '<input id="nm" type="text" autocomplete="name" placeholder="Your full name" value="'+esc(d.employee_name||"")+'"/>'+
            '<div id="msg" class="muted" style="margin:8px 0"></div>'+
            '<button id="go">I acknowledge receipt</button>')+
      '</div>'+
      '<p class="muted" style="text-align:center">Signed by '+esc(d.bcba_signed_name||"—")+
        (d.bcba_signed_at?' on '+esc(String(d.bcba_signed_at).slice(0,10)):"")+'.</p>';

    var go = document.getElementById("go");
    if (go) go.addEventListener("click", function(){
      var nm = document.getElementById("nm").value.trim();
      var msg = document.getElementById("msg");
      if (!nm) { msg.className="err"; msg.textContent="Type your name to acknowledge."; return; }
      go.disabled = true; go.textContent = "Saving…";
      fetch("/api/fidelity/public/acknowledge",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({token:token,signed_name:nm})})
        .then(function(r){return r.json();})
        .then(function(j){
          if (j.error) throw new Error(j.error);
          load();
        })
        .catch(function(e){ go.disabled=false; go.textContent="I acknowledge receipt";
          msg.className="err"; msg.textContent=e.message||"Could not save that."; });
    });
  }
  function load(){
    fetch("/api/fidelity/public/check?token="+encodeURIComponent(token))
      .then(function(r){return r.json();})
      .then(function(d){
        if (d.error) { root.innerHTML='<div class="card"><p class="err">'+esc(d.error)+'</p></div>'; return; }
        render(d);
      })
      .catch(function(){ root.innerHTML='<div class="card"><p class="err">This page could not be loaded.</p></div>'; });
  }
  load();
})();
</script></body></html>`;
  }

  // Served without a session, like the other token pages in this CRM.
  async function servePage(req, res, pathname) {
    if (pathname.startsWith("/fidelity-ack/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(ackPageHtml());
      return true;
    }
    return false;
  }

  module.exports.__rubric = SECTIONS;

  return {
    SECTIONS, ALL_ITEMS, MAX_SCORE, RATINGS, ACTION_PLAN_OPTIONS,
    SESSION_TYPES, OBSERVATION_LENGTHS,
    scoreOf, ratingFor, actionPlanRequired,
    initTables, audit, canManageFidelity, canEvaluate,
    employeeSummary, summarise, trendOf, finalizedChecks, allChecksFor,
    getSettings, computeRaise, weightsProblem, bandFor, fidelityFigure, gatherCategories,
    buildPdf, refilePdf, statusBannerFor, assessmentDateProblem, clientInitialsProblem,
    sameHuman, selfObservationProblem, parseJson, finalizeCheck, STATUSES, dashboard, randomPick, isRbt,
    handleApi, shapeRow, shapePlan, shapePublic, servePage, ackPageHtml,
    insights,
    PLAN_STATUSES, PLAN_OPEN,
    sweep, leadershipRecipients,
    DEFAULT_BANDS, DEFAULT_WEIGHTS, CATEGORIES, FIDELITY_METHODS,
    _internal: { round1, round2, num },
  };
};
