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
  const saveEmployeeDocument = ctx.saveEmployeeDocument || (async () => null);

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

  module.exports.__rubric = SECTIONS;

  return {
    SECTIONS, ALL_ITEMS, MAX_SCORE, RATINGS, ACTION_PLAN_OPTIONS,
    SESSION_TYPES, OBSERVATION_LENGTHS,
    scoreOf, ratingFor, actionPlanRequired,
    initTables, audit, canManageFidelity, canEvaluate,
    employeeSummary, summarise, trendOf, finalizedChecks,
    getSettings, computeRaise, weightsProblem, bandFor, fidelityFigure,
    DEFAULT_BANDS, DEFAULT_WEIGHTS, CATEGORIES, FIDELITY_METHODS,
    _internal: { round1, round2, num },
  };
};
