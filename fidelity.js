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
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    )`).catch((e) => console.error("fidelity_checks initTables:", e.message));

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

  async function finalizedChecks(employeeId) {
    return dbAll(
      `SELECT * FROM fidelity_checks
        WHERE employee_id = ? AND status IN ('finalized','sent','awaiting_ack','acknowledged','closed')
          AND COALESCE(voided, FALSE) = FALSE
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
    { key: "attendance", label: "Attendance", live: false,
      source: "Employee Attendance points (not yet wired in)" },
    { key: "reliability", label: "Reliability", live: false, source: "Not yet wired in" },
    { key: "note_timeliness", label: "Session Note Timeliness", live: false, source: "Not yet wired in" },
    { key: "supervision_compliance", label: "Supervision Compliance", live: false,
      source: "RBT Supervision monthly percentage (not yet wired in)" },
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
      const value = key === "fidelity" ? fid.value : null;
      if (value == null) { missing.push({ key, label: cat ? cat.label : key, weight: w }); continue; }
      parts.push({ key, label: cat ? cat.label : key, weight: w, value });
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
  const STATUSES = ["draft", "assigned", "in_progress", "awaiting_signature", "finalized",
    "sent", "awaiting_ack", "acknowledged", "action_required", "closed"];

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
         bcba_signed_name = ?, bcba_signed_at = ?, evaluator_credentials = ?,
         finalized_at = ?, status = 'finalized', ack_token = ?, updated_at = ?
       WHERE id = ?`,
      [JSON.stringify(scores), JSON.stringify(calc.section_scores), calc.total_score, MAX_SCORE, calc.percentage,
       calc.rating_key, calc.rating_label, !!unsafe, body.unsafe_practice_detail || check.unsafe_practice_detail || null,
       calc.critical_fail, JSON.stringify(calc.critical_fail_reasons),
       body.critical_fail_detail || check.critical_fail_detail || null,
       body.strengths != null ? body.strengths : check.strengths,
       body.areas_for_improvement != null ? body.areas_for_improvement : check.areas_for_improvement,
       planText || null, JSON.stringify(planTypes),
       signedName, now, body.evaluator_credentials || check.evaluator_credentials || null,
       now, ackToken, now, checkId]
    );
    await audit(checkId, "finalized", { actor, new: `${calc.total_score}/${MAX_SCORE} (${calc.percentage}%) ${calc.rating_label}` });
    await audit(checkId, "signed", { actor, field: "bcba_signed_name", new: signedName });

    const fresh = await dbGet("SELECT * FROM fidelity_checks WHERE id = ?", [checkId]);
    const emp = await dbGet("SELECT id, name, email, role_title FROM hr_employees WHERE id = ?", [check.employee_id]).catch(() => null);
    const result = { ok: true, check_id: checkId, calc, pdf_document_id: null, emailed: false, action_plan_id: null };

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
        ORDER BY assessment_date DESC, id DESC`
    ).catch(() => []);
    const byEmp = new Map();
    for (const c of allChecks) {
      if (!byEmp.has(c.employee_id)) byEmp.set(c.employee_id, []);
      byEmp.get(c.employee_id).push(c);
    }

    const openPlans = await dbAll(
      `SELECT * FROM fidelity_action_plans WHERE status IN ('not_started','in_progress','overdue')`
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
      const overdue = plans.filter((pl) => pl.due_date && pl.due_date < today && pl.status !== "completed");
      // Due = interval since the last check, or immediately if never checked.
      const dueDate = sum.last_check_date
        ? new Date(new Date(sum.last_check_date + "T00:00:00Z").getTime() + settings.check_interval_days * 86400000).toISOString().slice(0, 10)
        : null;
      return {
        employee_id: e.id, name: e.name, role_title: e.role_title || "", email: e.email || null,
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
      return json(res, 200, shapePublic(row, emp));
    }
    if (pathname === "/api/fidelity/public/acknowledge" && method === "POST") {
      const b = await readBody(req).catch(() => ({}));
      const row = await dbGet("SELECT * FROM fidelity_checks WHERE ack_token = ?", [String(b.token || "")]).catch(() => null);
      if (!row) return json(res, 404, { error: "That link is not valid." });
      if (row.employee_ack_at) return json(res, 200, { ok: true, already: true, acknowledged_at: row.employee_ack_at });
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
      });
    }

    // ---- everything below here is leadership, except the evaluator's own check ----
    if (pathname === "/api/fidelity/dashboard" && method === "GET") {
      if (!manage) return json(res, 403, { error: "Not permitted to view the Fidelity dashboard." });
      return json(res, 200, await dashboard(query));
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
      const emp = await dbGet("SELECT id, name, email, role_title, hire_date, annual_review_date, hourly_rate FROM hr_employees WHERE id = ?", [id]);
      if (!emp) return json(res, 404, { error: "That staff member is not on file." });
      const rows = await finalizedChecks(id);
      const sum = summarise(rows);
      const plans = await dbAll("SELECT * FROM fidelity_action_plans WHERE employee_id = ? ORDER BY id DESC", [id]).catch(() => []);
      return json(res, 200, {
        employee: emp, summary: sum,
        history: rows.map(shapeRow),
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

    if (pathname === "/api/fidelity/check" && method === "POST") {
      const b = await readBody(req);
      const employeeId = Number(b.employee_id);
      if (!employeeId) return json(res, 400, { error: "Choose which RBT is being observed." });
      const emp = await dbGet("SELECT id, name FROM hr_employees WHERE id = ?", [employeeId]);
      if (!emp) return json(res, 404, { error: "That staff member is not on file." });
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
      const fresh = await dbGet("SELECT * FROM fidelity_checks WHERE id = ?", [id]);
      const calc = scoreOf(parseJson(fresh.scores_json, {}),
        { unsafe_practice: fresh.unsafe_practice === true || fresh.unsafe_practice === "t" });
      // The live score comes back on every save, so the screen never adds up.
      return json(res, 200, { ok: true, calc, action_plan_required: actionPlanRequired(calc) });
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
      return json(res, 200, { ok: true });
    }

    const resendMatch = pathname.match(/^\/api\/fidelity\/check\/(\d+)\/resend$/);
    if (resendMatch && method === "POST") {
      if (!manage) return json(res, 403, { error: "Not permitted." });
      const id = Number(resendMatch[1]);
      const row = await dbGet("SELECT * FROM fidelity_checks WHERE id = ?", [id]);
      if (!row) return json(res, 404, { error: "Not found" });
      if (!row.finalized_at) return json(res, 400, { error: "This Fidelity Check has not been signed yet." });
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
      const fields = ["description", "responsible_supervisor", "due_date", "retraining_date",
        "followup_fidelity_date", "notes", "completed_date", "status"];
      const sets = [], vals = [];
      for (const f of fields) {
        if (b[f] === undefined) continue;
        sets.push(`${f} = ?`); vals.push(b[f]);
        await audit(row.check_id, "action_plan_edited", { actor, field: f, old: row[f], new: b[f] });
      }
      if (Array.isArray(b.plan_types)) { sets.push("plan_types = ?"); vals.push(JSON.stringify(b.plan_types)); }
      if (!sets.length) return json(res, 200, { ok: true, unchanged: true });
      sets.push("updated_at = ?"); vals.push(nowISO());
      await dbRun(`UPDATE fidelity_action_plans SET ${sets.join(", ")} WHERE id = ?`, [...vals, id]);
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: "Unknown Fidelity route." });
  }

  // Overdue is COMPUTED, never a stored status that can go stale: a plan whose
  // due date passed last night is overdue this morning without anybody running
  // anything.
  function shapePlan(p) {
    const today = nowISO().slice(0, 10);
    const overdue = p.status !== "completed" && p.due_date && String(p.due_date) < today;
    return {
      id: p.id, check_id: p.check_id, employee_id: p.employee_id,
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
    };
  }

  module.exports.__rubric = SECTIONS;

  return {
    SECTIONS, ALL_ITEMS, MAX_SCORE, RATINGS, ACTION_PLAN_OPTIONS,
    SESSION_TYPES, OBSERVATION_LENGTHS,
    scoreOf, ratingFor, actionPlanRequired,
    initTables, audit, canManageFidelity, canEvaluate,
    employeeSummary, summarise, trendOf, finalizedChecks,
    getSettings, computeRaise, weightsProblem, bandFor, fidelityFigure,
    buildPdf, parseJson, finalizeCheck, STATUSES, dashboard, randomPick, isRbt,
    handleApi, shapeRow, shapePlan, shapePublic,
    DEFAULT_BANDS, DEFAULT_WEIGHTS, CATEGORIES, FIDELITY_METHODS,
    _internal: { round1, round2, num },
  };
};
