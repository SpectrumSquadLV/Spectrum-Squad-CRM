// test-fidelity.js -- the RBT Fidelity, performance and raise module.
//
// The module's whole justification is that nobody has to do the arithmetic, so
// the arithmetic is what this file checks hardest: the rating boundaries, the
// critical-fail rule that is deliberately NOT arithmetic, the refusals that
// stop a half-finished observation becoming a signed record, the permission
// split between somebody who scores an RBT and somebody who sees what that
// score does to their pay, and the raise recommendation end to end.
//
// Two halves, on purpose:
//   1. The calculations, called directly. A boundary is best tested at the
//      boundary, and 90.0% vs 89.9% is a difference of one point out of sixty
//      that no amount of clicking would reliably reproduce.
//   2. The routes, over HTTP against a running server, because a permission
//      that is only enforced in a function nobody calls is not enforced.
//
//   DATABASE_URL=... node server.js
//   node test-fidelity.js
"use strict";

const crypto = require("crypto");
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3009";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const OWNER_PW = process.env.OWNER_PASSWORD || "TestOwner123!";

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else {
    fail++;
    const d = detail === undefined ? "" : "\n          -> " +
      String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400);
    console.log("  FAIL  " + name + d);
  }
};
const section = (t) => console.log("\n== " + t + " ==");

// ---------------------------------------------------------------- the module,
// loaded with a context that touches nothing. Only the pure calculations are
// exercised from here; anything that reads or writes is left to the HTTP half.
const fid = require("./fidelity")({
  dbGet: async () => null, dbAll: async () => [], dbRun: async () => ({}),
  sendEmail: async () => ({}), nowISO: () => new Date().toISOString(),
  crypto, APP_BASE_URL: "http://localhost", readBody: async () => ({}),
  json: () => true, moduleGranted: () => false,
});

// A score map totalling exactly `total`, keeping every critical competency at 2
// unless it is explicitly listed in `zero`. Without that rule a low total would
// drag a critical item to 0 and every "low score" test would accidentally be
// testing critical fail as well.
function scoresTotalling(total, opts = {}) {
  const forcedZero = new Set(opts.zero || []);
  const s = {};
  for (const k of forcedZero) s[k] = 0;
  const order = [...fid.ALL_ITEMS].sort((a, b) => (a.critical ? 0 : 1) - (b.critical ? 0 : 1));
  let remaining = total;
  for (const item of order) {
    if (s[item.key] !== undefined) continue;
    const give = Math.max(0, Math.min(2, remaining));
    s[item.key] = give;
    remaining -= give;
  }
  return s;
}

(async () => {
  // ================================================================
  section("The rubric is the paper form, as data");

  check("there are five sections", fid.SECTIONS.length === 5, fid.SECTIONS.map((s) => s.key));
  check("thirty competencies", fid.ALL_ITEMS.length === 30, fid.ALL_ITEMS.length);
  check("out of sixty", fid.MAX_SCORE === 60, fid.MAX_SCORE);
  check("the section maxima add up to the total",
    fid.SECTIONS.reduce((a, s) => a + s.max, 0) === 60);
  check("every section's max is twice its item count",
    fid.SECTIONS.every((s) => s.max === s.items.length * 2),
    fid.SECTIONS.map((s) => `${s.key}:${s.items.length}x2=${s.max}`));
  check("every competency key is unique",
    new Set(fid.ALL_ITEMS.map((i) => i.key)).size === 30);
  check("four competencies are also critical-fail conditions",
    fid.ALL_ITEMS.filter((i) => i.critical).length === 4,
    fid.ALL_ITEMS.filter((i) => i.critical).map((i) => i.key));

  // ================================================================
  section("A half-finished check reports nothing rather than something wrong");

  const partial = fid.scoreOf({ prep_1: 2, prep_2: 2, dtt_1: 2 });
  check("it counts what has been answered", partial.answered === 3, partial.answered);
  check("it is not complete", partial.complete === false, partial.complete);
  check("the percentage is null, NOT a number", partial.percentage === null, partial.percentage);
  check("there is no rating yet", partial.rating_key === null && partial.rating_label === null, partial);
  check("24 of 60 does not appear as 'CRITICAL' half-way through scoring",
    partial.rating_label === null, partial.rating_label);
  check("an empty check answers nothing", fid.scoreOf({}).answered === 0);
  check("a null score map does not throw", fid.scoreOf(null).answered === 0);

  const stray = fid.scoreOf({ ...scoresTotalling(60), prep_1: 7 });
  check("a value that is not 0, 1 or 2 is not counted",
    stray.answered === 29 && stray.complete === false, { a: stray.answered, c: stray.complete });

  // ================================================================
  section("The rating bands, at their exact boundaries");

  // The paper form gives point ranges AND percentages. They are the same
  // boundaries, so each one is checked from the point side and read back as a
  // percentage: 54/60 is 90%, 48/60 is 80%, 36/60 is 60%.
  const at = (t) => fid.scoreOf(scoresTotalling(t));
  const band = (t) => { const c = at(t); return `${c.total_score}=${c.percentage}%:${c.rating_key}`; };

  const b60 = at(60);
  check("60/60 is 100% and Exceptional",
    b60.percentage === 100 && b60.rating_key === "exceptional", band(60));
  const b54 = at(54);
  check("54/60 is exactly 90% — Exceptional starts here",
    b54.percentage === 90 && b54.rating_key === "exceptional", band(54));
  const b53 = at(53);
  check("53/60 is 88.3% — one point below is Meets Standard, not Exceptional",
    b53.percentage === 88.3 && b53.rating_key === "meets", band(53));
  const b48 = at(48);
  check("48/60 is exactly 80% — Meets Standard starts here",
    b48.percentage === 80 && b48.rating_key === "meets", band(48));
  const b47 = at(47);
  check("47/60 is 78.3% — one point below is Needs Improvement",
    b47.percentage === 78.3 && b47.rating_key === "needs_improvement", band(47));
  const b36 = at(36);
  check("36/60 is exactly 60% — Needs Improvement starts here",
    b36.percentage === 60 && b36.rating_key === "needs_improvement", band(36));
  const b35 = at(35);
  check("35/60 is 58.3% — one point below is Critical",
    b35.percentage === 58.3 && b35.rating_key === "critical", band(35));
  const b0 = at(0);
  check("0/60 is 0% and Critical", b0.percentage === 0 && b0.rating_key === "critical", band(0));

  check("each rating carries the action the form prescribes",
    at(54).rating_action && at(35).rating_action &&
    /Action Plan/i.test(at(35).rating_action), { hi: at(54).rating_action, lo: at(35).rating_action });

  // Section subtotals are computed too, not just the grand total.
  const secCalc = fid.scoreOf(scoresTotalling(60));
  check("every section subtotal is filled in",
    fid.SECTIONS.every((s) => secCalc.section_scores[s.key].score === s.max),
    secCalc.section_scores);
  check("the section subtotals add up to the total",
    Object.values(secCalc.section_scores).reduce((a, s) => a + s.score, 0) === secCalc.total_score);

  // ================================================================
  section("Critical Fail is separate from the score, and a high score cannot bury it");

  const highButCritical = fid.scoreOf(scoresTotalling(58, { zero: ["beh_5"] }));
  check("58/60 is still 96.7% and still rated Exceptional",
    highButCritical.percentage === 96.7 && highButCritical.rating_key === "exceptional", highButCritical);
  check("...and it is ALSO a critical fail", highButCritical.critical_fail === true, highButCritical);
  check("the reason names the competency, not the number",
    highButCritical.critical_fail_reasons.includes("Incorrect reinforcement of maladaptive behavior"),
    highButCritical.critical_fail_reasons);

  for (const [key, reason] of [
    ["dtt_10", "Not implementing program as written"],
    ["beh_2", "Not following behavior intervention plan"],
    ["beh_5", "Incorrect reinforcement of maladaptive behavior"],
    ["data_4", "No data collection"],
  ]) {
    const c = fid.scoreOf(scoresTotalling(58, { zero: [key] }));
    check(`a zero on ${key} is a critical fail`, c.critical_fail === true && c.critical_fail_reasons.includes(reason), c.critical_fail_reasons);
  }

  const scoredOneNotZero = fid.scoreOf({ ...scoresTotalling(60), beh_5: 1 });
  check("a 1 on a critical competency is NOT a critical fail — only a 0 is",
    scoredOneNotZero.critical_fail === false, scoredOneNotZero.critical_fail_reasons);

  const nonCriticalZero = fid.scoreOf(scoresTotalling(58, { zero: ["prep_1"] }));
  check("a zero on an ordinary competency is not a critical fail",
    nonCriticalZero.critical_fail === false, nonCriticalZero.critical_fail_reasons);

  const unsafe = fid.scoreOf(scoresTotalling(60), { unsafe_practice: true });
  check("unsafe practice is a critical fail on a PERFECT score",
    unsafe.total_score === 60 && unsafe.percentage === 100 && unsafe.critical_fail === true, unsafe);
  check("...and it does not alter the score", unsafe.total_score === 60, unsafe.total_score);
  check("...and says so in its own words",
    unsafe.critical_fail_reasons.includes("Unsafe or unethical practice"), unsafe.critical_fail_reasons);
  check("two critical conditions give two reasons",
    fid.scoreOf(scoresTotalling(58, { zero: ["data_4"] }), { unsafe_practice: true }).critical_fail_reasons.length === 2);
  check("an incomplete check still reports a critical fail it can already see",
    fid.scoreOf({ beh_5: 0 }).critical_fail === true);

  // ================================================================
  section("When an Action Plan is required");

  check("Exceptional and clean needs no plan",
    fid.actionPlanRequired(at(60)) === false);
  check("Meets Standard needs no plan", fid.actionPlanRequired(at(48)) === false);
  check("Needs Improvement requires one", fid.actionPlanRequired(at(47)) === true);
  check("Critical requires one", fid.actionPlanRequired(at(35)) === true);
  check("a critical fail requires one EVEN AT 96.7%",
    fid.actionPlanRequired(highButCritical) === true);
  check("an incomplete check does not demand a plan yet",
    fid.actionPlanRequired(partial) === false);

  // ================================================================
  section("What the filed PDF says about itself");

  // A PDF in a personnel file is read on its own, a year later, with no
  // dashboard beside it. If an assessment was amended or voided, the paper has
  // to say so — two PDFs of one observation with nothing to tell them apart is
  // worse than no PDF at all.
  //
  // pdfkit subsets its fonts, so the text inside a generated PDF is glyph ids
  // rather than words and cannot be asserted on. The wording and the branch
  // therefore live outside the PDF writer, and this is where they are checked.
  const plainCheck = { id: 1, assessment_date: "2026-06-01", total_score: 54, max_score: 60, percentage: 90 };
  const replaced = { id: 2, assessment_date: "2026-05-01", total_score: 36, max_score: 60, percentage: 60, rating_label: "Needs Improvement" };

  check("an ordinary signed assessment gets no banner",
    fid.statusBannerFor(plainCheck, null) === null, fid.statusBannerFor(plainCheck, null));

  const voidBanner = fid.statusBannerFor({ ...plainCheck, voided: true, void_reason: "Recorded against the wrong RBT." }, null);
  check("a voided assessment says so", voidBanner && voidBanner.key === "voided", voidBanner);
  check("...carrying the reason", voidBanner && /wrong RBT/.test(voidBanner.body), voidBanner);
  check("...and saying it is kept but does not count",
    voidBanner && /retained as part of the record and does not count/i.test(voidBanner.body), voidBanner);

  const supBanner = fid.statusBannerFor({ ...plainCheck, superseded_by_check_id: 7 },
    { id: 7, assessment_date: "2026-07-01", total_score: 54, max_score: 60, percentage: 90, rating_label: "Exceptional" });
  check("a superseded assessment says it was amended", supBanner && supBanner.key === "superseded", supBanner);
  check("...and points at the one that stands, with its date and score",
    supBanner && /2026-07-01/.test(supBanner.body) && /54\/60/.test(supBanner.body), supBanner);
  check("...and says it is kept exactly as signed",
    supBanner && /retained exactly as it was signed/i.test(supBanner.body), supBanner);

  const amendBanner = fid.statusBannerFor(
    { ...plainCheck, amends_check_id: 2, amend_reason: "Section totals transposed." }, replaced);
  check("an amendment says what it replaces", amendBanner && amendBanner.key === "amendment", amendBanner);
  check("...naming the assessment it replaces", amendBanner && /2026-05-01/.test(amendBanner.body) && /36\/60/.test(amendBanner.body), amendBanner);
  check("...and why the correction was made", amendBanner && /transposed/.test(amendBanner.body), amendBanner);

  check("a voided amendment reads as voided first — that is the fact that matters",
    fid.statusBannerFor({ ...plainCheck, voided: true, amends_check_id: 2 }, replaced).key === "voided");
  check("a missing counterpart does not produce a broken sentence",
    /another assessment/.test(fid.statusBannerFor({ ...plainCheck, amends_check_id: 999 }, null).body),
    fid.statusBannerFor({ ...plainCheck, amends_check_id: 999 }, null));

  // ================================================================
  section("Trend: a wobble is not a direction");

  check("+1.5 points exactly reads as Stable", fid.trendOf(91.5, 90).key === "stable", fid.trendOf(91.5, 90));
  check("+1.6 points reads as Improving", fid.trendOf(91.6, 90).key === "improving", fid.trendOf(91.6, 90));
  check("-1.5 points exactly reads as Stable", fid.trendOf(88.5, 90).key === "stable", fid.trendOf(88.5, 90));
  check("-1.6 points reads as Declining", fid.trendOf(88.4, 90).key === "declining", fid.trendOf(88.4, 90));
  check("the change is reported either way", fid.trendOf(88.4, 90).change === -1.6, fid.trendOf(88.4, 90));
  check("a first check has no trend", fid.trendOf(90, null).key === "none", fid.trendOf(90, null));

  // ================================================================
  section("Only finalized, non-void checks form the history");

  const rows = (list) => list.map((r, i) => ({
    id: i + 1, assessment_date: r.d, percentage: r.p, total_score: Math.round(r.p * 0.6),
    max_score: 60, rating_key: r.k || "exceptional", rating_label: r.l || "Exceptional",
    evaluator_name: "A BCBA", critical_fail: !!r.cf,
  }));
  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

  const hist = fid.summarise(rows([
    { d: daysAgo(10), p: 95 }, { d: daysAgo(100), p: 90 }, { d: daysAgo(200), p: 85 },
  ]));
  check("the newest check is 'current'", hist.current.percentage === 95, hist.current);
  check("the one before it is 'previous'", hist.previous.percentage === 90, hist.previous);
  check("the change is worked out", hist.change === 5, hist.change);
  check("the average is worked out", hist.average === 90, hist.average);
  check("the highest and lowest are reported",
    hist.highest === 95 && hist.lowest === 85, { h: hist.highest, l: hist.lowest });
  check("the trend reads Improving", hist.trend.key === "improving", hist.trend);
  check("no checks at all is an honest blank, not a zero",
    fid.summarise([]).current === null && fid.summarise([]).average === null, fid.summarise([]));
  check("a check with no percentage is not averaged in",
    fid.summarise([{ id: 1, percentage: null }]).checks === 0);
  const cf = fid.summarise(rows([{ d: daysAgo(5), p: 96, cf: true }, { d: daysAgo(400), p: 50, cf: true }]));
  check("critical fails are counted for the last 12 months only",
    cf.critical_fails_12mo === 1, cf.critical_fails_12mo);

  // ================================================================
  section("The raise weights must total 100, exactly");

  check("100 is accepted", fid.weightsProblem({ fidelity: 100 }) === null);
  check("60 + 40 is accepted", fid.weightsProblem({ fidelity: 60, attendance: 40 }) === null);
  check("90 is refused, and says what it totals",
    /90/.test(fid.weightsProblem({ fidelity: 90 }) || ""), fid.weightsProblem({ fidelity: 90 }));
  check("110 is refused", !!fid.weightsProblem({ fidelity: 60, attendance: 50 }));
  check("nothing weighted is refused", !!fid.weightsProblem({}));
  check("an unknown category is refused by name",
    /invented/.test(fid.weightsProblem({ fidelity: 50, invented: 50 }) || ""),
    fid.weightsProblem({ fidelity: 50, invented: 50 }));

  // ================================================================
  section("The raise calculator does the maths");

  const settings = () => ({
    bands: fid.DEFAULT_BANDS, weights: { fidelity: 100 },
    fidelity_method: "review_period_average", critical_fail_policy: "flag_for_review",
    pip_policy: "flag_for_review", min_checks_required: 1, max_raise_percent: 10,
    min_performance_percent: 0, assumed_weekly_hours: 40, check_interval_days: 90,
  });
  const reviewRows = rows([{ d: daysAgo(30), p: 92 }]);
  const raise = fid.computeRaise({
    settings: settings(), summary: fid.summarise(reviewRows), rows: reviewRows,
    current_rate: 22, period_start: daysAgo(365), period_end: today,
  });

  check("the Fidelity figure is 92%", raise.fidelity.value === 92, raise.fidelity);
  check("it says WHICH figure it used", /review period/i.test(raise.fidelity.method_label), raise.fidelity.method_label);
  check("the performance score is 92%", raise.performance_score === 92, raise.performance_score);
  check("92% lands in the 90–94.99% band", raise.band && raise.band.percent === 4, raise.band);
  check("the recommended raise is 4%", raise.recommended_percent === 4, raise.recommended_percent);
  check("4% of $22.00 is $0.88 an hour", raise.recommended_increase === 0.88, raise.recommended_increase);
  check("the new rate is $22.88", raise.recommended_new_rate === 22.88, raise.recommended_new_rate);
  check("that is $35.20 a week at 40 hours", raise.estimated_weekly_increase === 35.2, raise.estimated_weekly_increase);
  check("and $1,830.40 a year", raise.estimated_annual_increase === 1830.4, raise.estimated_annual_increase);

  const why = raise.explanation;
  check("the explanation is plain English, in sentences", /\. /.test(why) && why.length > 80, why);
  check("it names the Fidelity figure", why.includes("92%"), why);
  check("it names the raise percentage", /4% raise/.test(why), why);
  check("it names the hourly amounts", why.includes("$0.88") && why.includes("$22.88"), why);
  check("it names the weekly and annual amounts",
    why.includes("$35.20") && why.includes("$1830.40"), why);
  check("it says the decision is not the CRM's", /decision is leadership/i.test(why), why);

  // ---- no pay rate on file ----
  const noRate = fid.computeRaise({
    settings: settings(), summary: fid.summarise(reviewRows), rows: reviewRows,
    current_rate: null, period_start: daysAgo(365), period_end: today,
  });
  check("with no hourly rate the percentage still computes", noRate.recommended_percent === 4, noRate.recommended_percent);
  check("...but the dollar amounts are null, not zero",
    noRate.recommended_increase === null && noRate.recommended_new_rate === null &&
    noRate.estimated_annual_increase === null, noRate);
  check("...and it says why", /no hourly rate is on file/i.test(noRate.explanation), noRate.explanation);

  // ---- below the matrix ----
  const lowRows = rows([{ d: daysAgo(30), p: 74, k: "needs_improvement", l: "Needs Improvement" }]);
  const low = fid.computeRaise({
    settings: settings(), summary: fid.summarise(lowRows), rows: lowRows,
    current_rate: 22, period_start: daysAgo(365), period_end: today,
  });
  check("below 80% there is no automatic percentage", low.recommended_percent === null, low.recommended_percent);
  check("...and it goes to leadership review", low.needs_leadership_review === true, low.needs_leadership_review);
  check("...and the explanation says so, with the number",
    /74%/.test(low.explanation) && /leadership review/i.test(low.explanation), low.explanation);

  // ---- the cap ----
  const capped = fid.computeRaise({
    settings: { ...settings(), max_raise_percent: 3 },
    summary: fid.summarise(reviewRows), rows: reviewRows, current_rate: 22,
    period_start: daysAgo(365), period_end: today,
  });
  check("a 4% band is capped to the 3% policy maximum", capped.recommended_percent === 3, capped.recommended_percent);

  // ---- a critical fail, under each policy ----
  const cfRows = rows([{ d: daysAgo(30), p: 92, cf: true }]);
  const flagged = fid.computeRaise({
    settings: settings(), summary: fid.summarise(cfRows), rows: cfRows, current_rate: 22,
    period_start: daysAgo(365), period_end: today,
  });
  check("under 'flag for review' a critical fail still computes a figure",
    flagged.recommended_percent === 4, flagged.recommended_percent);
  check("...but it is flagged", flagged.flags.some((f) => /Critical Fail/i.test(f)), flagged.flags);
  check("...and marked for leadership", flagged.needs_leadership_review === true);

  const ineligible = fid.computeRaise({
    settings: { ...settings(), critical_fail_policy: "ineligible" },
    summary: fid.summarise(cfRows), rows: cfRows, current_rate: 22,
    period_start: daysAgo(365), period_end: today,
  });
  check("under 'ineligible' no percentage is recommended at all",
    ineligible.recommended_percent === null && ineligible.recommended_increase === null, ineligible);
  check("...and it says a person decides",
    /leadership decides/i.test(ineligible.explanation), ineligible.explanation);

  // ---- a weighted category with no data ----
  const mixed = fid.computeRaise({
    settings: { ...settings(), weights: { fidelity: 60, attendance: 40 } },
    summary: fid.summarise(reviewRows), rows: reviewRows, current_rate: 22,
    period_start: daysAgo(365), period_end: today,
  });
  check("a weighted category with no data is NOT treated as zero",
    mixed.performance_score === 92, mixed.performance_score);
  check("...it is reported as missing",
    mixed.missing_components.some((m) => m.key === "attendance"), mixed.missing_components);
  check("...and flagged so nobody reads 92% as complete",
    mixed.flags.some((f) => /No data for/i.test(f)), mixed.flags);

  // ---- no checks at all ----
  const none = fid.computeRaise({
    settings: settings(), summary: fid.summarise([]), rows: [], current_rate: 22,
    period_start: daysAgo(365), period_end: today,
  });
  check("with no Fidelity Checks there is no performance score",
    none.performance_score === null && none.recommended_percent === null, none);
  check("...and the explanation says there were none",
    /no Fidelity Checks/i.test(none.explanation), none.explanation);

  // ---- the method actually changes the number ----
  const three = rows([{ d: daysAgo(10), p: 96 }, { d: daysAgo(100), p: 90 }, { d: daysAgo(200), p: 84 }]);
  const recent = fid.computeRaise({
    settings: { ...settings(), fidelity_method: "most_recent" },
    summary: fid.summarise(three), rows: three, current_rate: 22,
    period_start: daysAgo(365), period_end: today,
  });
  const avg3 = fid.computeRaise({
    settings: { ...settings(), fidelity_method: "last3_average" },
    summary: fid.summarise(three), rows: three, current_rate: 22,
    period_start: daysAgo(365), period_end: today,
  });
  check("'most recent' uses the newest check (96%)", recent.fidelity.value === 96, recent.fidelity);
  check("'average of the last 3' averages them (90%)", avg3.fidelity.value === 90, avg3.fidelity);
  check("...which is a different raise: 5% against 4%",
    recent.recommended_percent === 5 && avg3.recommended_percent === 4,
    { recent: recent.recommended_percent, avg: avg3.recommended_percent });

  // ================================================================
  //                            THE ROUTES
  // ================================================================
  async function login(email, password) {
    const res = await fetch(BASE + "/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error("login failed for " + email + ": " + res.status);
    const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
    return async (path, opts = {}) => {
      const r = await fetch(BASE + path, {
        method: opts.method || "GET",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const ct = r.headers.get("content-type") || "";
      return { status: r.status, ct, data: ct.includes("json") ? await r.json().catch(() => ({})) : await r.text() };
    };
  }
  const anon = async (path, opts = {}) => {
    const r = await fetch(BASE + path, {
      method: opts.method || "GET", headers: { "Content-Type": "application/json" },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, ct, data: ct.includes("json") ? await r.json().catch(() => ({})) : await r.text() };
  };

  const owner = await login("admin@spectrumsquadlv.com", OWNER_PW);
  const stamp = Date.now().toString().slice(-6);
  const PW = "FidelityTest123!";

  // Three accounts that differ ONLY in their module grants.
  const mkUser = async (label, role, access) => {
    const email = `fid.${label}.${stamp}@example.invalid`;
    const c = await owner("/api/admin/users", {
      method: "POST", body: { name: `Fid ${label} ${stamp}`, email, password: PW, role },
    });
    if (c.status !== 201) throw new Error(`could not create ${label}: ${JSON.stringify(c.data)}`);
    if (access) {
      const p = await owner(`/api/admin/users/${c.data.id}`, { method: "PATCH", body: { module_access: access } });
      if (p.status !== 200) throw new Error(`could not grant ${label}: ${JSON.stringify(p.data)}`);
    }
    return { id: c.data.id, email, req: await login(email, PW) };
  };

  const plainAdmin = await mkUser("admin", "admin", null);
  const evaluator  = await mkUser("eval", "clinical", { "fidelity-evaluator": true });
  const manager    = await mkUser("mgr", "clinical", { fidelity: true });

  // ================================================================
  section("Neither permission comes with a general CRM role");

  let r = await anon("/api/fidelity/dashboard");
  check("signed out, the dashboard is refused", r.status === 401, r.status);

  r = await plainAdmin.req("/api/fidelity/rubric");
  check("an ADMIN with no grant cannot even open the blank form", r.status === 403, { s: r.status, d: r.data });
  r = await plainAdmin.req("/api/fidelity/dashboard");
  check("an admin with no grant cannot see the dashboard", r.status === 403, r.status);
  r = await plainAdmin.req("/api/fidelity/settings");
  check("an admin with no grant cannot see the raise settings", r.status === 403, r.status);

  r = await owner("/api/fidelity/dashboard");
  check("the owner can, without any grant", r.status === 200, r.data);

  r = await manager.req("/api/fidelity/dashboard");
  check("the Fidelity Management grant opens the dashboard", r.status === 200, r.data && r.data.error);

  // ================================================================
  section("An evaluator scores; an evaluator does not see pay or rankings");

  r = await evaluator.req("/api/fidelity/rubric");
  check("an evaluator gets the blank rubric", r.status === 200, r.data && r.data.error);
  const rubricStatuses = (r.data && r.data.statuses) || [];
  check("...with all thirty competencies",
    r.status === 200 && r.data.sections.reduce((a, s) => a + s.items.length, 0) === 30);
  check("...and the rating bands, so the screen shows the same ones the server uses",
    r.status === 200 && r.data.ratings.length === 4 && r.data.max_score === 60);

  for (const [label, path, opts] of [
    ["the dashboard", "/api/fidelity/dashboard", null],
    ["the raise settings", "/api/fidelity/settings", null],
    ["the list of action plans", "/api/fidelity/action-plans", null],
    ["past raise decisions", "/api/fidelity/raise-reviews", null],
    ["the random picker", "/api/fidelity/random", { method: "POST", body: {} }],
  ]) {
    const res = await evaluator.req(path, opts || {});
    check(`an evaluator is refused ${label}`, res.status === 403, { s: res.status, d: res.data });
  }

  // ================================================================
  section("An observation, scored and signed");

  const mkEmp = async (label, extra = {}) => {
    const e = await owner("/api/hr/employees", {
      method: "POST",
      body: {
        name: `Fidelity ${label} ${stamp}`, email: `fidemp.${label}.${stamp}@example.invalid`,
        role_title: "RBT", status: "active", hire_date: daysAgo(400), ...extra,
      },
    });
    const id = e.data && (e.data.id || (e.data.employee && e.data.employee.id));
    if (!id) throw new Error("could not create employee: " + JSON.stringify(e.data));
    return id;
  };

  const doCheckFor = async (empId, total) => {
    const c = await owner("/api/fidelity/check", { method: "POST", body: { employee_id: empId, assessment_date: today } });
    await owner(`/api/fidelity/check/${c.data.id}`, { method: "PATCH", body: { scores: scoresTotalling(total) } });
    const f = await owner(`/api/fidelity/check/${c.data.id}/finalize`, {
      method: "POST",
      body: { bcba_signed_name: "Jane Doe, BCBA", action_plan_narrative: "Retraining scheduled.", action_plan_options: ["Modeling"] },
    });
    return f;
  };

  const lastMailIdEarly = async () => {
    const q = await pool.query("SELECT COALESCE(MAX(id), 0) AS n FROM notifications_log");
    return Number(q.rows[0].n);
  };

  const empA = await mkEmp("Alpha");
  r = await evaluator.req("/api/fidelity/check", {
    method: "POST",
    body: { employee_id: empA, assessment_date: today, client_initials: "J.D.", session_type: "In-Clinic", observation_minutes: 30 },
  });
  check("an evaluator can start a check", r.status === 201 && r.data.id, r.data);
  const checkA = r.data.id;

  r = await evaluator.req("/api/fidelity/check", { method: "POST", body: {} });
  check("a check with no RBT named is refused", r.status === 400, r.data);
  r = await evaluator.req("/api/fidelity/check", { method: "POST", body: { employee_id: 99999999 } });
  check("a check on somebody who is not on file is refused", r.status === 404, r.data);

  // ---- live scoring ----
  r = await evaluator.req(`/api/fidelity/check/${checkA}`, {
    method: "PATCH", body: { scores: { prep_1: 2, prep_2: 2, prep_3: 1 } },
  });
  check("saving scores returns the running total", r.status === 200 && r.data.calc.total_score === 5, r.data);
  check("...and refuses to show a percentage yet", r.data.calc.percentage === null, r.data.calc);

  r = await evaluator.req(`/api/fidelity/check/${checkA}/finalize`, {
    method: "POST", body: { bcba_signed_name: "A BCBA" },
  });
  check("finalizing an unfinished check is refused", r.status === 400, r.data);
  check("...and it says how many competencies are missing",
    /27 competencies have not been scored/.test(r.data.error || ""), r.data.error);
  check("...and names them, so the screen can jump to one",
    Array.isArray(r.data.missing) && r.data.missing.length === 27, r.data.missing && r.data.missing.length);

  // ---- score the lot ----
  r = await evaluator.req(`/api/fidelity/check/${checkA}`, {
    method: "PATCH",
    body: { scores: scoresTotalling(60), strengths: "Excellent pacing.", areas_for_improvement: "None noted." },
  });
  check("a fully scored check reports 60/60 and 100%",
    r.data.calc.total_score === 60 && r.data.calc.percentage === 100, r.data.calc);
  check("...rated Exceptional", r.data.calc.rating_key === "exceptional", r.data.calc);
  check("...with no Action Plan required", r.data.action_plan_required === false, r.data);

  r = await evaluator.req(`/api/fidelity/check/${checkA}/finalize`, { method: "POST", body: {} });
  check("finalizing without a signature is refused", r.status === 400, r.data);
  check("...and says a signature is what is missing", /signature/i.test(r.data.error || ""), r.data.error);

  r = await evaluator.req(`/api/fidelity/check/${checkA}/finalize`, {
    method: "POST", body: { bcba_signed_name: "Jane Doe, BCBA" },
  });
  check("a complete, signed check finalizes", r.status === 200 && r.data.ok === true, r.data);
  check("...and reports the score it locked in",
    r.data.calc.total_score === 60 && r.data.calc.rating_label === "Exceptional", r.data.calc);
  check("...and files a PDF in the personnel record", !!r.data.pdf_document_id, r.data);
  check("...and no Action Plan was created for a perfect score", r.data.action_plan_id === null, r.data);
  const pdfDocA = r.data.pdf_document_id;

  if (pdfDocA) {
    // The personnel file is where it has to be readable from, so that is where
    // it is fetched: the ordinary employee-document download, as leadership.
    const doc = await owner(`/api/hr/employee-documents/${pdfDocA}`);
    check("the filed PDF downloads from the personnel file", doc.status === 200, doc.status);
    check("...and is a PDF", /pdf/i.test(doc.ct || ""), doc.ct);
  }

  r = await evaluator.req(`/api/fidelity/check/${checkA}/finalize`, {
    method: "POST", body: { bcba_signed_name: "Jane Doe, BCBA" },
  });
  check("a signed check cannot be finalized twice", r.status === 409, { s: r.status, d: r.data });
  check("...and it says to amend instead", /amendment/i.test(r.data.error || ""), r.data.error);

  r = await evaluator.req(`/api/fidelity/check/${checkA}`, { method: "PATCH", body: { scores: { prep_1: 0 } } });
  check("a signed check cannot be edited", r.status === 409, { s: r.status, d: r.data });

  const after = await owner(`/api/fidelity/check/${checkA}`);
  check("...and the score is exactly what was signed",
    after.data.check.total_score === 60, after.data.check && after.data.check.total_score);

  // ---- one evaluator, one check ----
  const otherEval = await mkUser("eval2", "clinical", { "fidelity-evaluator": true });
  r = await otherEval.req(`/api/fidelity/check/${checkA}`);
  check("another evaluator cannot open a check that is not theirs", r.status === 403, { s: r.status, d: r.data });
  r = await otherEval.req(`/api/fidelity/check/${checkA}`, { method: "PATCH", body: { scores: { prep_1: 0 } } });
  check("...nor score it", r.status === 403, r.status);
  r = await evaluator.req(`/api/fidelity/employee/${empA}`);
  check("an evaluator cannot browse the RBT's history either", r.status === 403, r.status);

  // ================================================================
  section("The audit trail");

  const audited = await owner(`/api/fidelity/check/${checkA}`);
  const actions = (audited.data.audit || []).map((a) => a.action);
  check("the trail records the check being created", actions.includes("created"), actions);
  check("...being finalized", actions.includes("finalized"), actions);
  check("...being signed", actions.includes("signed"), actions);
  check("...and the PDF being generated", actions.includes("pdf_generated"), actions);
  check("the trail is not shown to an evaluator",
    (await evaluator.req(`/api/fidelity/check/${checkA}`)).data.audit.length === 0);

  // ================================================================
  section("A critical concern must be described before it can be signed");

  const empB = await mkEmp("Bravo");
  r = await owner("/api/fidelity/check", { method: "POST", body: { employee_id: empB, assessment_date: today } });
  const checkB = r.data.id;
  r = await owner(`/api/fidelity/check/${checkB}`, {
    method: "PATCH", body: { scores: scoresTotalling(58, { zero: ["beh_5"] }) },
  });
  check("58/60 with a zero on a critical competency is still 96.7%",
    r.data.calc.percentage === 96.7 && r.data.calc.rating_key === "exceptional", r.data.calc);
  check("...and is flagged as a critical fail", r.data.calc.critical_fail === true, r.data.calc);
  check("...and now requires an Action Plan despite the score",
    r.data.action_plan_required === true, r.data);

  r = await owner(`/api/fidelity/check/${checkB}/finalize`, { method: "POST", body: { bcba_signed_name: "Jane Doe, BCBA" } });
  check("it will not sign without the concern being described", r.status === 400, r.data);
  check("...and says exactly that", /Critical Fidelity Concern must be described/i.test(r.data.error || ""), r.data.error);

  r = await owner(`/api/fidelity/check/${checkB}/finalize`, {
    method: "POST", body: { bcba_signed_name: "Jane Doe, BCBA", critical_fail_detail: "Attention delivered after screaming." },
  });
  check("with the concern described, it still will not sign without a plan", r.status === 400, r.data);
  check("...and says an Action Plan is required", /Action Plan/i.test(r.data.error || ""), r.data.error);

  r = await owner(`/api/fidelity/check/${checkB}/finalize`, {
    method: "POST",
    body: {
      bcba_signed_name: "Jane Doe, BCBA",
      critical_fail_detail: "Attention delivered after screaming.",
      action_plan_options: ["Modeling", "Additional Supervision"],
      action_plan_narrative: "Model differential reinforcement across three sessions.",
      action_plan_due_date: daysAgo(-14),
    },
  });
  check("with both, it signs", r.status === 200 && r.data.ok === true, r.data);
  check("...and an Action Plan row is created automatically", !!r.data.action_plan_id, r.data);

  const plans = await owner("/api/fidelity/action-plans");
  const planB = (plans.data.action_plans || []).find((p) => p.id === r.data.action_plan_id);
  check("the plan carries the types that were chosen",
    planB && planB.plan_types.includes("Additional Supervision"), planB);
  check("the plan starts as not started", planB && planB.status === "not_started", planB && planB.status);

  // ================================================================
  section("Needs Improvement cannot be signed without a plan either");

  const empC = await mkEmp("Charlie");
  r = await owner("/api/fidelity/check", { method: "POST", body: { employee_id: empC, assessment_date: today } });
  const checkC = r.data.id;
  await owner(`/api/fidelity/check/${checkC}`, { method: "PATCH", body: { scores: scoresTotalling(42) } });
  r = await owner(`/api/fidelity/check/${checkC}/finalize`, { method: "POST", body: { bcba_signed_name: "Jane Doe, BCBA" } });
  check("42/60 is 70% — Needs Improvement — and is refused without a plan",
    r.status === 400 && /Needs Improvement/i.test(r.data.error || ""), r.data);
  r = await owner(`/api/fidelity/check/${checkC}/finalize`, {
    method: "POST", body: { bcba_signed_name: "Jane Doe, BCBA", action_plan_narrative: "Retraining on prompt fading." },
  });
  check("with a plan it signs", r.status === 200 && r.data.calc.percentage === 70, r.data);
  check("...and no critical fail was invented from a low score",
    r.data.calc.critical_fail === false, r.data.calc);

  // ================================================================
  section("A withdrawn check is voided, never deleted, and stops counting");

  const empD = await mkEmp("Delta");
  r = await owner("/api/fidelity/check", { method: "POST", body: { employee_id: empD, assessment_date: today } });
  const checkD = r.data.id;
  await owner(`/api/fidelity/check/${checkD}`, { method: "PATCH", body: { scores: scoresTotalling(60) } });
  await owner(`/api/fidelity/check/${checkD}/finalize`, { method: "POST", body: { bcba_signed_name: "Jane Doe, BCBA" } });

  let hist2 = await owner(`/api/fidelity/employee/${empD}`);
  check("the finalized check is in the history", hist2.data.summary.checks === 1, hist2.data.summary);

  r = await owner(`/api/fidelity/check/${checkD}/void`, { method: "POST", body: {} });
  check("voiding without a reason is refused", r.status === 400, r.data);
  r = await evaluator.req(`/api/fidelity/check/${checkD}/void`, { method: "POST", body: { reason: "wrong RBT" } });
  check("an evaluator cannot void a check", r.status === 403, r.status);
  r = await owner(`/api/fidelity/check/${checkD}/void`, { method: "POST", body: { reason: "Recorded against the wrong RBT." } });
  check("with a reason, leadership can void it", r.status === 200, r.data);

  hist2 = await owner(`/api/fidelity/employee/${empD}`);
  check("a voided check no longer counts towards the average", hist2.data.summary.checks === 0, hist2.data.summary);
  const stillThere = await owner(`/api/fidelity/check/${checkD}`);
  check("...but the record still exists", stillThere.status === 200, stillThere.status);
  check("...marked, with the reason kept",
    /wrong RBT/i.test(String(stillThere.data.check.void_reason || "")), stillThere.data.check.void_reason);

  // ================================================================
  section("The RBT's own copy: a token that shows and acknowledges, and nothing else");

  // The token is a link that acts AS the employee, so it is read here from the
  // database rather than from the API -- which is the point of the first
  // assertion: leadership's own view of a check must not hand it out.
  const pub = await owner(`/api/fidelity/check/${checkA}`);
  check("the acknowledgment token is NOT returned by the API",
    !("ack_token" in pub.data.check) && !JSON.stringify(pub.data).includes("ack_token"),
    Object.keys(pub.data.check));
  const tokRow = await pool.query("SELECT ack_token FROM fidelity_checks WHERE id = $1", [checkA]);
  const token = tokRow.rows[0] && tokRow.rows[0].ack_token;
  check("a finalized check has an acknowledgment token", !!token, tokRow.rows[0]);
  check("...and it is long enough not to be guessed", (token || "").length >= 32, (token || "").length);

  r = await anon(`/api/fidelity/public/check?token=${token}`);
  check("the RBT can open it with no CRM account", r.status === 200, r.status);
  check("...and sees their whole assessment, every item",
    r.data.sections && r.data.sections.reduce((a, s) => a + s.items.length, 0) === 30);
  check("...including the items that scored full marks",
    r.data.sections[0].items.every((i) => i.score === 2), r.data.sections[0].items);
  check("...and who signed it", r.data.bcba_signed_name === "Jane Doe, BCBA", r.data.bcba_signed_name);

  r = await anon(`/api/fidelity/public/check?token=notarealtoken`);
  check("a wrong token shows nothing", r.status === 404, r.status);
  r = await anon(`/api/fidelity/public/check`);
  check("no token shows nothing", r.status === 404, r.status);

  r = await anon("/api/fidelity/public/acknowledge", { method: "POST", body: { token } });
  check("acknowledging without typing a name is refused", r.status === 400, r.data);
  r = await anon("/api/fidelity/public/acknowledge", { method: "POST", body: { token, signed_name: "Alpha RBT" } });
  check("acknowledging works", r.status === 200 && r.data.ok === true, r.data);
  r = await anon("/api/fidelity/public/acknowledge", { method: "POST", body: { token, signed_name: "Someone Else" } });
  check("acknowledging twice does not overwrite the first", r.status === 200 && r.data.already === true, r.data);

  const acked = await owner(`/api/fidelity/check/${checkA}`);
  check("the acknowledgment is stored against the check",
    acked.data.check.employee_ack_name === "Alpha RBT", acked.data.check.employee_ack_name);
  check("the token holder could not change a single score",
    acked.data.check.total_score === 60, acked.data.check.total_score);
  check("the page itself is served to a signed-out browser",
    (await anon(`/fidelity-ack/${token}`)).status === 200);

  // ================================================================
  section("Pay is leadership's, and the raise is computed from the checks");

  r = await evaluator.req(`/api/fidelity/employee/${empA}/pay`, { method: "PUT", body: { hourly_rate: 22 } });
  check("an evaluator cannot set an hourly rate", r.status === 403, r.status);
  r = await evaluator.req(`/api/fidelity/raise/${empA}`);
  check("...nor see what a raise would be", r.status === 403, r.status);

  r = await owner(`/api/fidelity/employee/${empA}/pay`, { method: "PUT", body: { hourly_rate: 22, annual_review_date: today } });
  check("leadership can set the hourly rate", r.status === 200, r.data);
  r = await owner(`/api/fidelity/employee/${empA}/pay`, { method: "PUT", body: { hourly_rate: -5 } });
  check("a negative hourly rate is refused", r.status === 400, r.data);

  r = await owner(`/api/fidelity/raise/${empA}`);
  check("the raise view loads", r.status === 200, r.data);
  check("it read the rate that was just set", r.data.current_rate === 22, r.data.current_rate);
  check("it used the finalized 100% check", r.data.fidelity.value === 100, r.data.fidelity);
  check("100% is the top band, a 5% raise", r.data.recommended_percent === 5, r.data.recommended_percent);
  check("5% of $22.00 is $1.10", r.data.recommended_increase === 1.1, r.data.recommended_increase);
  check("the new rate is $23.10", r.data.recommended_new_rate === 23.1, r.data.recommended_new_rate);
  check("the explanation spells it out", /\$23\.10/.test(r.data.explanation || ""), r.data.explanation);

  // ---- the decision ----
  r = await owner(`/api/fidelity/raise/${empA}/decide`, { method: "POST", body: { final_percent: 8 } });
  check("changing the recommended raise without a reason is refused", r.status === 400, r.data);
  check("...and says the reason is stored with the decision", /reason/i.test(r.data.error || ""), r.data.error);

  r = await owner(`/api/fidelity/raise/${empA}/decide`, {
    method: "POST", body: { final_percent: 8, override_reason: "Took on the training caseload in March." },
  });
  check("with a reason, leadership can award something different", r.status === 201, r.data);
  check("...it is recorded as an override", r.data.overridden === true, r.data);
  check("...and the new rate is worked out from the FINAL figure",
    r.data.final_new_rate === 23.76, r.data.final_new_rate);

  const reviews = await owner("/api/fidelity/raise-reviews");
  const rec = (reviews.data.reviews || []).find((x) => x.id === r.data.id);
  check("the recommendation is stored beside the decision",
    rec && Number(rec.recommended_percent) === 5 && Number(rec.final_percent) === 8, rec);
  check("...with the explanation it was given at the time",
    rec && /\$23\.10/.test(String(rec.explanation || "")), rec && String(rec.explanation || "").slice(0, 120));
  check("an evaluator cannot read past raise decisions",
    (await evaluator.req("/api/fidelity/raise-reviews")).status === 403);

  // ================================================================
  section("The dashboard, and who is due");

  const dash = await owner("/api/fidelity/dashboard");
  check("the dashboard loads", dash.status === 200, dash.status);
  const rowA = (dash.data.employees || []).find((e) => e.employee_id === empA);
  check("the RBT appears on it", !!rowA, (dash.data.employees || []).length);
  check("with the score computed, not stored on the row", rowA && rowA.current_percentage === 100, rowA);
  check("and the next check date worked out from the interval",
    rowA && !!rowA.next_due, rowA && rowA.next_due);
  const empNever = await mkEmp("Echo");
  const dash2 = await owner("/api/fidelity/dashboard");
  const rowE = (dash2.data.employees || []).find((e) => e.employee_id === empNever);
  check("an RBT nobody has ever observed still appears", !!rowE, rowE);
  check("...with a blank score rather than a zero",
    rowE && rowE.current_percentage === null && rowE.checks === 0, rowE);
  check("...and is counted as never checked, which is its own number",
    dash2.data.cards.never_checked >= 1, dash2.data.cards);
  check("...and as due a check", rowE && rowE.overdue_check === true, rowE);

  const nonRbt = await mkEmp("Foxtrot", { role_title: "Office Manager" });
  const dash3 = await owner("/api/fidelity/dashboard");
  check("somebody who is not an RBT is not on the RBT dashboard",
    !(dash3.data.employees || []).some((e) => e.employee_id === nonRbt), nonRbt);

  const pick = await owner("/api/fidelity/random", { method: "POST", body: {} });
  check("the random picker returns somebody", pick.status === 200 && pick.data.ok === true, pick.data);
  check("...from a pool it names", !!pick.data.drawn_from && pick.data.pool_size > 0, pick.data);
  check("...who is an RBT on the dashboard",
    (dash3.data.employees || []).some((e) => e.employee_id === pick.data.picked.employee_id), pick.data.picked);
  check("...and it shows the queue it drew from, longest wait first",
    Array.isArray(pick.data.longest_waiting) && pick.data.longest_waiting.length > 0, pick.data.longest_waiting);

  // ================================================================
  section("The raise settings are configurable, and validated");

  r = await owner("/api/fidelity/settings");
  check("the settings load", r.status === 200 && Array.isArray(r.data.bands), r.status);
  check("every performance category is offered, with where its number comes from",
    (r.data.categories || []).length >= 5 && r.data.categories.every((c) => !!c.source), r.data.categories);
  check("the categories that can actually produce a number are marked live",
    r.data.categories.filter((c) => c.live).map((c) => c.key).sort().join() === "fidelity,supervision_compliance",
    r.data.categories.filter((c) => c.live).map((c) => c.key));
  check("...and the ones that cannot are not, so a weight cannot be given to a blank",
    r.data.categories.filter((c) => !c.live).length >= 6,
    r.data.categories.filter((c) => !c.live).map((c) => c.key));

  r = await owner("/api/fidelity/settings", { method: "PUT", body: { weights: { fidelity: 80, attendance: 30 } } });
  check("weights that do not total 100 are refused", r.status === 400, r.data);
  check("...and say what they total", /110/.test(r.data.error || ""), r.data.error);
  r = await owner("/api/fidelity/settings", { method: "PUT", body: { check_interval_days: 45 } });
  check("an interval can be changed", r.status === 200 && r.data.check_interval_days === 45, r.data);
  r = await evaluator.req("/api/fidelity/settings", { method: "PUT", body: { check_interval_days: 1 } });
  check("an evaluator cannot change the raise policy", r.status === 403, r.status);
  await owner("/api/fidelity/settings", { method: "PUT", body: { check_interval_days: 90 } });

  // ================================================================
  section("Asking somebody to do an observation");

  // The random picker named who was due and then stopped: nothing could be
  // handed to anybody, so "select a random RBT" ended in whoever pressed the
  // button doing it themselves, or nobody doing it.
  const empAssign = await mkEmp("Papa");

  r = await evaluator.req("/api/fidelity/assign", { method: "POST", body: { employee_id: empAssign, evaluator_user_id: evaluator.id } });
  check("an evaluator cannot hand work to themselves or anybody else", r.status === 403, r.status);

  r = await owner("/api/fidelity/assign", { method: "POST", body: { evaluator_user_id: evaluator.id } });
  check("an assignment with no RBT is refused", r.status === 400, r.data);
  r = await owner("/api/fidelity/assign", { method: "POST", body: { employee_id: empAssign } });
  check("an assignment with nobody to do it is refused", r.status === 400, r.data);

  // The failure that would otherwise produce an email leading to a 403.
  r = await owner("/api/fidelity/assign", {
    method: "POST", body: { employee_id: empAssign, evaluator_user_id: plainAdmin.id },
  });
  check("assigning to somebody without Fidelity access is refused", r.status === 400, r.data);
  check("...and says what to grant them first",
    /Grant Fidelity Evaluator first/i.test(r.data.error || ""), r.data.error);

  // The list the assignment form reads. Served here rather than from the admin
  // users API, which a Clinical Director holding only a Fidelity grant cannot
  // call — they would have seen an empty list saying nobody has access.
  r = await manager.req("/api/fidelity/evaluators");
  check("a Fidelity manager who is NOT an account admin can list evaluators",
    r.status === 200 && Array.isArray(r.data.evaluators), { s: r.status, d: r.data });
  const evalIds = (r.data.evaluators || []).map((e) => e.id);
  check("...and the list holds the evaluator", evalIds.includes(evaluator.id), evalIds);
  check("...and not the admin with no Fidelity access", !evalIds.includes(plainAdmin.id), evalIds);
  check("...saying which of them manage Fidelity rather than only evaluate",
    (r.data.evaluators || []).some((e) => e.manages === true) &&
    (r.data.evaluators || []).some((e) => e.manages === false),
    (r.data.evaluators || []).map((e) => `${e.id}:${e.manages}`));
  r = await evaluator.req("/api/fidelity/evaluators");
  check("an evaluator cannot list who else could be given work", r.status === 403, r.status);

  const assignMark = await lastMailIdEarly();
  r = await owner("/api/fidelity/assign", {
    method: "POST",
    body: { employee_id: empAssign, evaluator_user_id: evaluator.id, due_date: daysAgo(-7),
            session_type: "In-Clinic", note: "Focus on prompt fading." },
  });
  check("leadership can assign an observation", r.status === 201 && r.data.id, r.data);
  const assignedId = r.data.id;
  check("...naming who it went to", r.data.assigned_to && /Fid eval/.test(r.data.assigned_to), r.data);

  const assignMail = await pool.query(
    "SELECT recipient, subject, body FROM notifications_log WHERE id > $1 AND type = 'fidelity_assigned'", [assignMark]);
  check("the evaluator is told, rather than left to notice", assignMail.rows.length === 1, assignMail.rows.length);
  check("...by name, with the RBT and the date",
    assignMail.rows.length === 1 && assignMail.rows[0].subject.includes("Papa") && assignMail.rows[0].body.includes(daysAgo(-7)),
    assignMail.rows[0] && assignMail.rows[0].subject);
  check("...and the note comes with it",
    assignMail.rows.length === 1 && /prompt fading/i.test(assignMail.rows[0].body), (assignMail.rows[0] || {}).body);

  const tasksAssign = await owner("/api/staff-tasks");
  const taskListAssign = Array.isArray(tasksAssign.data) ? tasksAssign.data : (tasksAssign.data.tasks || []);
  check("...and it becomes a task too, because an email can be missed",
    taskListAssign.some((t) => /Fidelity Check to complete/.test(String(t.title || ""))),
    taskListAssign.slice(0, 4).map((t) => t.title));

  // The evaluator's own view.
  r = await evaluator.req("/api/fidelity/my-assignments");
  check("the evaluator can see what they have been asked to do", r.status === 200, r.data);
  const mine = (r.data.assignments || []).find((a) => a.id === assignedId);
  check("...including this one", !!mine, r.data.assignments);
  check("...naming the RBT", mine && /Papa/.test(String(mine.employee_name || "")), mine);
  check("...with nothing scored yet", mine && mine.scored === 0 && mine.complete === false, mine);
  check("...and who asked", mine && !!mine.assigned_by, mine);

  r = await otherEval.req("/api/fidelity/my-assignments");
  check("another evaluator does not see somebody else's assignment",
    !(r.data.assignments || []).some((a) => a.id === assignedId), r.data.assignments);

  // The status follows the work rather than waiting to be set.
  const preScore = await owner(`/api/fidelity/check/${assignedId}`);
  check("an assignment starts as assigned", preScore.data.check.status === "assigned", preScore.data.check.status);

  r = await evaluator.req(`/api/fidelity/check/${assignedId}`, { method: "PATCH", body: { scores: { prep_1: 2 } } });
  check("scoring it moves it to in progress", r.data.status === "in_progress", r.data);

  r = await evaluator.req(`/api/fidelity/check/${assignedId}`, { method: "PATCH", body: { scores: scoresTotalling(54) } });
  check("scoring every item moves it to awaiting signature — the state where an observation gets lost",
    r.data.status === "awaiting_signature", r.data);

  r = await evaluator.req(`/api/fidelity/check/${assignedId}`, { method: "PATCH", body: { scores: { prep_1: null } } });
  check("...and un-scoring one puts it back to in progress", r.data.status === "in_progress", r.data);
  await evaluator.req(`/api/fidelity/check/${assignedId}`, { method: "PATCH", body: { scores: scoresTotalling(54) } });

  // An assignment has no date, because the observation had not happened.
  r = await evaluator.req(`/api/fidelity/check/${assignedId}/finalize`, { method: "POST", body: { bcba_signed_name: "Fid eval" } });
  check("signing an assessment with no date is refused", r.status === 400, r.data);
  check("...and asks for the date the observation took place",
    /date the observation took place/i.test(r.data.error || ""), r.data.error);

  r = await evaluator.req(`/api/fidelity/check/${assignedId}/finalize`, {
    method: "POST", body: { bcba_signed_name: "Fid eval", assessment_date: today },
  });
  check("with the date, it signs", r.status === 200 && r.data.ok === true, r.data);

  const signedAssign = await owner(`/api/fidelity/check/${assignedId}`);
  check("...and the date given at signing is the one recorded",
    String(signedAssign.data.check.assessment_date).slice(0, 10) === today, signedAssign.data.check.assessment_date);

  r = await evaluator.req("/api/fidelity/my-assignments");
  check("a finished assignment drops off the evaluator's list",
    !(r.data.assignments || []).some((a) => a.id === assignedId), r.data.assignments);

  // ================================================================
  section("Where the team is weak — training need, or one person");

  // The finding that matters is not "this competency scores badly" but whether
  // it is ONE RBT or SEVERAL. Six zeros from one person is a coaching
  // conversation; six zeros from six people is a training session, and writing
  // six Action Plans instead would treat a training gap as six failures.
  const insTeam = [];
  for (const label of ["Nov1", "Nov2", "Nov3", "Nov4", "Nov5", "Nov6"]) {
    insTeam.push(await mkEmp("Ins" + label));
  }

  // Everybody scores full marks except: dtt_3 (prompt fading), which every one
  // of the six loses, and pro_4, which only the first one loses -- repeatedly.
  // dtt_3 and prep_2 are both scored 2 by every other fixture in this suite,
  // so a zero on either can only have come from this section. Choosing items
  // the rest of the file cannot touch is what keeps these assertions about the
  // report rather than about the order the tests happen to run in.
  const insScores = (opts = {}) => {
    const sc = {};
    for (const it of Object.keys(scoresTotalling(60))) sc[it] = 2;
    sc.dtt_3 = 0;
    if (opts.alsoOne) sc.prep_2 = 0;
    return sc;
  };
  for (let i = 0; i < insTeam.length; i++) {
    for (let n = 0; n < (i === 0 ? 3 : 1); n++) {
      const c = await owner("/api/fidelity/check", { method: "POST", body: { employee_id: insTeam[i], assessment_date: today } });
      await owner(`/api/fidelity/check/${c.data.id}`, { method: "PATCH", body: { scores: insScores({ alsoOne: i === 0 }) } });
      await owner(`/api/fidelity/check/${c.data.id}/finalize`, {
        method: "POST", body: { bcba_signed_name: "Jane Doe, BCBA" },
      });
    }
  }

  r = await evaluator.req("/api/fidelity/insights");
  check("an evaluator cannot see a view across everybody", r.status === 403, r.status);

  r = await owner("/api/fidelity/insights");
  check("the report loads", r.status === 200, r.data);
  const byKey = Object.fromEntries((r.data.items || []).map((i) => [i.key, i]));

  check("every competency on the rubric is reported, not only the failing ones",
    (r.data.items || []).length === 30, (r.data.items || []).length);

  const fading = byKey.dtt_3;
  check("the competency the whole team loses is counted", fading && fading.zeros >= 8, fading);
  check("...and reported as SIX different people, which is the training signal",
    fading && fading.people_scoring_zero === 6, fading);
  check("...and scores far below a competency nobody loses",
    fading && byKey.prep_1 && fading.percentage < byKey.prep_1.percentage,
    { weak: fading && fading.percentage, clean: byKey.prep_1 && byKey.prep_1.percentage });

  const single = byKey.prep_2;
  check("a competency only one person loses is counted too", single && single.zeros === 3, single);
  check("...but reported as ONE person, which is a coaching conversation",
    single && single.people_scoring_zero === 1, single);

  check("the report names the ones concentrated in a single person",
    (r.data.concentrated || []).some((c) => c.key === "prep_2"), r.data.concentrated);
  check("...with who it is, since that is the whole point of separating them",
    (r.data.concentrated || []).some((c) => c.key === "prep_2" && /InsNov1/.test(String(c.name || ""))),
    r.data.concentrated);
  check("...and does NOT name a person for the team-wide one",
    !(r.data.concentrated || []).some((c) => c.key === "dtt_3"), r.data.concentrated);

  check("the weakest competencies are ranked first",
    (r.data.ranked || [])[0] && (r.data.ranked[0].key === "dtt_3" || r.data.ranked[0].key === "pro_4"),
    (r.data.ranked || []).slice(0, 3).map((i) => `${i.key}:${i.percentage}%`));
  check("a strong competency is not in the weakest list",
    !(r.data.weakest || []).some((i) => i.key === "prep_1"), (r.data.weakest || []).map((i) => i.key));

  check("each section gets a team percentage",
    (r.data.sections || []).length === 5 && r.data.sections.every((sc) => sc.percentage != null), r.data.sections);
  const dttSec = (r.data.sections || []).find((sc) => sc.key === "dtt");
  check("...and the section carrying the weak competency scores below a clean one",
    dttSec && dttSec.percentage < 100, r.data.sections);

  check("how many checks and how many RBTs it read is stated",
    r.data.checks >= 8 && r.data.rbts_observed >= 6, { checks: r.data.checks, rbts: r.data.rbts_observed });

  // Sample size, said as loudly as the finding.
  check("every row says whether there is enough behind it",
    (r.data.items || []).every((i) => typeof i.enough_evidence === "boolean"));
  check("the threshold is reported rather than hidden in the code",
    r.data.min_observations === 5, r.data.min_observations);
  check("a competency with enough observations is marked as such",
    fading && fading.enough_evidence === true, fading);
  check("nothing thin is ranked above something well evidenced",
    (r.data.ranked || []).findIndex((i) => !i.enough_evidence) === -1 ||
    (r.data.ranked || []).findIndex((i) => !i.enough_evidence) >
      (r.data.ranked || []).map((i) => i.enough_evidence).lastIndexOf(true),
    (r.data.ranked || []).map((i) => `${i.key}:${i.enough_evidence}`).slice(0, 6));

  // A period with nothing in it says so instead of reporting zeros as findings.
  const emptyPeriod = await owner("/api/fidelity/insights?period_start=2019-01-01&period_end=2019-01-31");
  check("a period with no checks reports none", emptyPeriod.data.checks === 0, emptyPeriod.data.checks);
  check("...and says plainly that it is too few to read as a pattern",
    /too few to read anything here as a pattern/i.test(emptyPeriod.data.caveat || ""), emptyPeriod.data.caveat);
  check("...with no competency claiming a 0% failure finding",
    (emptyPeriod.data.items || []).every((i) => i.percentage === null), (emptyPeriod.data.items || []).slice(0, 2));
  check("...and nothing in the weakest list", (emptyPeriod.data.weakest || []).length === 0, emptyPeriod.data.weakest);

  // ================================================================
  section("Closing an Action Plan — the loop that had no end");

  // A plan could never be closed. The dashboard counted it forever, the daily
  // sweep emailed about it forever, and an open Performance Improvement Plan
  // flagged somebody's raise for the rest of their employment.
  const empPlan = await mkEmp("Kilo");
  const planChk = await owner("/api/fidelity/check", { method: "POST", body: { employee_id: empPlan, assessment_date: today } });
  await owner(`/api/fidelity/check/${planChk.data.id}`, { method: "PATCH", body: { scores: scoresTotalling(42) } });
  const planFin = await owner(`/api/fidelity/check/${planChk.data.id}/finalize`, {
    method: "POST",
    body: { bcba_signed_name: "Jane Doe, BCBA", action_plan_narrative: "Retraining on prompt fading.",
            action_plan_options: ["Performance Improvement Plan"], action_plan_due_date: daysAgo(2) },
  });
  const planId = planFin.data.action_plan_id;
  check("a Needs Improvement result opened a plan", !!planId, planFin.data);

  let empView = await owner(`/api/fidelity/employee/${empPlan}`);
  let thePlan = (empView.data.action_plans || []).find((p) => p.id === planId);
  check("the plan reports itself as open", thePlan && thePlan.open === true, thePlan);
  check("...and overdue, because its date has passed", thePlan && thePlan.overdue === true, thePlan);
  check("...with a status a human can read", thePlan && thePlan.status_label === "Not started", thePlan && thePlan.status_label);

  // An open PIP flags the raise. This is the state somebody could never leave.
  await owner(`/api/fidelity/employee/${empPlan}/pay`, { method: "PUT", body: { hourly_rate: 21 } });
  let raiseWithPip = await owner(`/api/fidelity/raise/${empPlan}`);
  check("an open Performance Improvement Plan flags the raise",
    (raiseWithPip.data.flags || []).some((f) => /Performance Improvement Plan/i.test(f)), raiseWithPip.data.flags);

  // ---- the refusals ----
  r = await owner(`/api/fidelity/action-plan/${planId}`, { method: "PATCH", body: { status: "compelted" } });
  check("a status the module does not recognise is refused, not stored",
    r.status === 400 && /is not a status/i.test(r.data.error || ""), r.data);
  check("...and it says which statuses exist",
    Array.isArray(r.data.statuses) && r.data.statuses.includes("completed"), r.data.statuses);

  r = await owner(`/api/fidelity/action-plan/${planId}`, { method: "PATCH", body: { status: "completed" } });
  check("completing with no record of what was done is refused", r.status === 400, r.data);
  check("...and says the date passing is not the retraining happening",
    /Say what was done, or give the date the retraining happened/i.test(r.data.error || ""), r.data.error);

  r = await owner(`/api/fidelity/action-plan/${planId}`, { method: "PATCH", body: { status: "cancelled" } });
  check("cancelling without a reason is refused too", r.status === 400 && /Say why/i.test(r.data.error || ""), r.data);

  // ---- and the ways through ----
  r = await owner(`/api/fidelity/action-plan/${planId}`, {
    method: "PATCH", body: { status: "in_progress", notes: "Modelling booked for Thursday." },
  });
  check("moving a plan along works", r.status === 200, r.data);
  check("...and it stays open", r.data.action_plan.open === true, r.data.action_plan);

  r = await owner(`/api/fidelity/action-plan/${planId}`, {
    method: "PATCH", body: { status: "completed", retraining_date: daysAgo(1) },
  });
  check("a retraining date is enough to close it — the evidence is the point",
    r.status === 200, r.data);
  check("...it is no longer open", r.data.action_plan.open === false, r.data.action_plan);
  check("...and a completion date was recorded without being asked for",
    !!r.data.action_plan.completed_date, r.data.action_plan);

  empView = await owner(`/api/fidelity/employee/${empPlan}`);
  thePlan = (empView.data.action_plans || []).find((p) => p.id === planId);
  check("the closed plan is KEPT on the record, not deleted", !!thePlan, (empView.data.action_plans || []).map((p) => p.id));
  check("...marked closed", thePlan && thePlan.open === false && thePlan.status_label === "Completed", thePlan);
  check("...and no longer counted as overdue", thePlan && thePlan.overdue === false, thePlan);

  raiseWithPip = await owner(`/api/fidelity/raise/${empPlan}`);
  check("closing the plan clears the raise flag it was causing",
    !(raiseWithPip.data.flags || []).some((f) => /Performance Improvement Plan/i.test(f)), raiseWithPip.data.flags);

  const dashAfterPlan = await owner("/api/fidelity/dashboard");
  const rowPlan = (dashAfterPlan.data.employees || []).find((e) => e.employee_id === empPlan);
  check("the dashboard stops counting it as an open plan",
    rowPlan && rowPlan.open_action_plans === 0, rowPlan);
  check("...and stops counting it as overdue", rowPlan && rowPlan.overdue_action_plans === 0, rowPlan);

  // ---- cancelled behaves the same everywhere ----
  // This is the case the three different definitions of "open" disagreed on.
  const empCancel = await mkEmp("Lima");
  const cChk = await owner("/api/fidelity/check", { method: "POST", body: { employee_id: empCancel, assessment_date: today } });
  await owner(`/api/fidelity/check/${cChk.data.id}`, { method: "PATCH", body: { scores: scoresTotalling(42) } });
  const cFin = await owner(`/api/fidelity/check/${cChk.data.id}/finalize`, {
    method: "POST",
    body: { bcba_signed_name: "Jane Doe, BCBA", action_plan_narrative: "Retraining.",
            action_plan_options: ["Performance Improvement Plan"], action_plan_due_date: daysAgo(5) },
  });
  await owner(`/api/fidelity/action-plan/${cFin.data.action_plan_id}`, {
    method: "PATCH", body: { status: "cancelled", notes: "Raised against the wrong RBT." },
  });
  const dashCancel = await owner("/api/fidelity/dashboard");
  const rowCancel = (dashCancel.data.employees || []).find((e) => e.employee_id === empCancel);
  check("a cancelled plan is closed on the dashboard", rowCancel && rowCancel.open_action_plans === 0, rowCancel);
  check("...and is not overdue", rowCancel && rowCancel.overdue_action_plans === 0, rowCancel);
  await owner(`/api/fidelity/employee/${empCancel}/pay`, { method: "PUT", body: { hourly_rate: 20 } });
  const cancelRaise = await owner(`/api/fidelity/raise/${empCancel}`);
  check("...and does not flag the raise as an open PIP",
    !(cancelRaise.data.flags || []).some((f) => /Performance Improvement Plan/i.test(f)), cancelRaise.data.flags);

  // A recipient has to exist first, or the sweep sends nothing to anybody and
  // "it did not email about this plan" would be true for the wrong reason.
  await owner("/api/admin/settings", {
    method: "PATCH", body: { clinical_director_email: `fid.director.${stamp}@example.invalid` },
  });
  const swMark = await pool.query("SELECT COALESCE(MAX(id),0) AS n FROM notifications_log");
  const swRun = await owner("/api/fidelity/sweep", { method: "POST", body: {} });
  // The precondition that makes the next assertion mean anything: the sweep
  // had a recipient and actually sent something. Without this, "it did not
  // email about this plan" would be true simply because it emailed nobody.
  check("the sweep had somebody to write to, and did write",
    swRun.data.skipped_no_recipient === 0 && (swRun.data.check_due + swRun.data.plan_overdue + swRun.data.review_due) >= 1,
    swRun.data);
  const swAfter = await pool.query(
    "SELECT body FROM notifications_log WHERE id > $1 AND type = 'fidelity_plans_overdue'", [Number(swMark.rows[0].n)]);
  const nagged = swAfter.rows.map((x) => x.body).join(" ");
  check("...and the daily sweep stops emailing about it",
    !nagged.includes(`Lima ${stamp}`), nagged.slice(0, 300));

  // ================================================================
  section("Amending a signed check — the correction the CRM kept promising");

  // Two refusal messages tell somebody to "create an amendment". Until now
  // there was no way to do that, so the only remedy for a mistyped score was
  // voiding -- which withdraws the assessment entirely, and the observation
  // still happened.
  const empAmend = await mkEmp("Juliet");
  await doCheckFor(empAmend, 48);                       // 80%, Meets Standard
  const wrongOne = await owner("/api/fidelity/check", { method: "POST", body: { employee_id: empAmend, assessment_date: today } });
  const wrongId = wrongOne.data.id;
  await owner(`/api/fidelity/check/${wrongId}`, { method: "PATCH", body: { scores: scoresTotalling(36) } });
  await owner(`/api/fidelity/check/${wrongId}/finalize`, {
    method: "POST", body: { bcba_signed_name: "Jane Doe, BCBA", action_plan_narrative: "Retraining." },
  });

  let beforeAmend = await owner(`/api/fidelity/employee/${empAmend}`);
  check("both checks count before anything is amended", beforeAmend.data.summary.checks === 2, beforeAmend.data.summary);
  check("the average is 70% — 80 and 60", beforeAmend.data.summary.average === 70, beforeAmend.data.summary.average);

  r = await owner(`/api/fidelity/check/${wrongId}/amend`, { method: "POST", body: {} });
  check("an amendment without a reason is refused", r.status === 400, r.data);
  check("...and says the reason is kept on both records", /kept on both/i.test(r.data.error || ""), r.data.error);

  r = await owner(`/api/fidelity/check/${wrongId}/amend`, {
    method: "POST", body: { reason: "Section totals transposed when entering from the paper form." },
  });
  check("with a reason, an amendment is created", r.status === 201 && r.data.id, r.data);
  const amendId = r.data.id;
  check("...as a NEW check, not an edit of the signed one", amendId !== wrongId, { amendId, wrongId });

  const draft = await owner(`/api/fidelity/check/${amendId}`);
  check("the amendment starts as a copy of the original's scores",
    draft.data.check.calc.total_score === 36, draft.data.check.calc);
  check("...and records what it amends", draft.data.check.amends_check_id === wrongId, draft.data.check);
  check("...and why", /transposed/i.test(draft.data.check.amend_reason || ""), draft.data.check.amend_reason);

  r = await owner(`/api/fidelity/check/${wrongId}/amend`, { method: "POST", body: { reason: "again" } });
  check("a second amendment does not fork the record — the open one is handed back",
    r.status === 200 && r.data.id === amendId && r.data.already_open === true, r.data);

  // Nothing has changed yet: an unfinished amendment must not drop the
  // original out of the average.
  let during = await owner(`/api/fidelity/employee/${empAmend}`);
  check("while the amendment is unsigned the original still counts",
    during.data.summary.checks === 2 && during.data.summary.average === 70, during.data.summary);

  const origPdfBefore = (await owner(`/api/fidelity/check/${wrongId}`)).data.check.pdf_document_id;
  check("the original had a PDF filed when it was signed", !!origPdfBefore, origPdfBefore);

  await owner(`/api/fidelity/check/${amendId}`, { method: "PATCH", body: { scores: scoresTotalling(54) } });
  r = await owner(`/api/fidelity/check/${amendId}/finalize`, { method: "POST", body: { bcba_signed_name: "Jane Doe, BCBA" } });
  check("the amendment signs", r.status === 200 && r.data.ok === true, r.data);
  check("...and reports which check it superseded", r.data.superseded_check_id === wrongId, r.data);

  const afterAmend = await owner(`/api/fidelity/employee/${empAmend}`);
  check("the corrected score replaces the wrong one in the average",
    afterAmend.data.summary.average === 85, afterAmend.data.summary.average);
  check("...and the count is still 2, not 3 — one observation is counted once",
    afterAmend.data.summary.checks === 2, afterAmend.data.summary.checks);
  check("the current score is the amendment", afterAmend.data.summary.current.percentage === 90, afterAmend.data.summary.current);

  // The original is kept, in full.
  const orig = await owner(`/api/fidelity/check/${wrongId}`);
  check("the original still exists", orig.status === 200, orig.status);
  check("...with the score that was actually signed, unedited",
    orig.data.check.total_score === 36, orig.data.check.total_score);
  check("...still carrying its signature", orig.data.check.bcba_signed_name === "Jane Doe, BCBA", orig.data.check.bcba_signed_name);
  check("...marked as superseded, by which check",
    orig.data.check.superseded_by_check_id === amendId, orig.data.check);
  check("...and no longer counting towards the history",
    orig.data.check.counts_towards_history === false, orig.data.check.counts_towards_history);
  check("...and its status is one the module actually declares",
    (rubricStatuses || []).includes(orig.data.check.status),
    { status: orig.data.check.status, declared: rubricStatuses });
  check("...with the supersession in its audit trail",
    (orig.data.audit || []).some((a) => a.action === "superseded"), (orig.data.audit || []).map((a) => a.action));

  // The personnel file has to be refreshed, not just the database row.
  check("the original's filed PDF was replaced, so the paper says it was amended",
    orig.data.check.pdf_document_id && orig.data.check.pdf_document_id !== origPdfBefore,
    { before: origPdfBefore, after: orig.data.check.pdf_document_id });
  check("...and the refiling is in the audit trail",
    (orig.data.audit || []).some((a) => a.action === "pdf_refiled"), (orig.data.audit || []).map((a) => a.action));
  const refiled = await owner(`/api/hr/employee-documents/${orig.data.check.pdf_document_id}`);
  check("...and the replacement downloads as a PDF",
    refiled.status === 200 && /pdf/i.test(refiled.ct || ""), { s: refiled.status, ct: refiled.ct });

  const histIds = (afterAmend.data.history || []).map((h) => h.id);
  check("the history still SHOWS the superseded check — nothing is hidden",
    histIds.includes(wrongId) && histIds.includes(amendId), histIds);
  check("...but the graph only plots what counts",
    (afterAmend.data.trend_points || []).length === 2, afterAmend.data.trend_points);

  r = await owner(`/api/fidelity/check/${wrongId}/amend`, { method: "POST", body: { reason: "third try" } });
  check("an already-amended check cannot be amended again", r.status === 409, r.data);

  // The two states an amendment does not apply to.
  const freshDraft = await owner("/api/fidelity/check", { method: "POST", body: { employee_id: empAmend, assessment_date: today } });
  r = await owner(`/api/fidelity/check/${freshDraft.data.id}/amend`, { method: "POST", body: { reason: "x" } });
  check("an unsigned check is edited, not amended", r.status === 400 && /has not been signed/i.test(r.data.error || ""), r.data);

  const toVoid = await owner("/api/fidelity/check", { method: "POST", body: { employee_id: empAmend, assessment_date: today } });
  await owner(`/api/fidelity/check/${toVoid.data.id}`, { method: "PATCH", body: { scores: scoresTotalling(54) } });
  await owner(`/api/fidelity/check/${toVoid.data.id}/finalize`, { method: "POST", body: { bcba_signed_name: "Jane Doe, BCBA" } });
  await owner(`/api/fidelity/check/${toVoid.data.id}/void`, { method: "POST", body: { reason: "Wrong RBT." } });
  r = await owner(`/api/fidelity/check/${toVoid.data.id}/amend`, { method: "POST", body: { reason: "x" } });
  check("a voided check is withdrawn, not corrected",
    r.status === 400 && /withdrawn, not corrected/i.test(r.data.error || ""), r.data);

  r = await evaluator.req(`/api/fidelity/check/${wrongId}/amend`, { method: "POST", body: { reason: "x" } });
  check("an evaluator cannot amend a check that is not theirs", r.status === 403, r.status);

  // ================================================================
  section("Supervision Compliance as a raise component");

  // The trap this section exists for: supervision's monthly figure is
  // supervision hours as a SHARE OF HOURS WORKED, where 5% is compliant.
  // Feeding that straight into a weighted performance score would read as 5%
  // performance. What gets weighted is the compliant/not-compliant judgement.
  const empSup = await mkEmp("Sierra");
  const monthOf = (n) => {
    const d = new Date();
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - n);
    return d.toISOString().slice(0, 7);
  };
  const supMonth = async (month, supHours, workedHours) => {
    const res = await owner(`/api/supervision/employee/${empSup}`, {
      method: "POST",
      body: {
        month,
        hours_worked: workedHours,
        entries: supHours > 0 ? [{ date: month + "-15", activity: "Observation", duration: supHours,
                                   face_to_face: true, supervisor: "A BCBA", observed: true }] : [],
      },
    });
    return res;
  };

  // Three compliant months, one that misses the 5% minimum, and one with no
  // worked hours at all.
  let supOk = await supMonth(monthOf(1), 6, 100);   // 6%  -> meets
  check("a supervision month can be recorded", supOk.status === 200, supOk.data);
  await supMonth(monthOf(2), 8, 100);               // 8%  -> meets
  await supMonth(monthOf(3), 5, 100);               // 5%  -> exactly the minimum, meets
  await supMonth(monthOf(4), 2, 100);               // 2%  -> misses
  await supMonth(monthOf(5), 4, 0);                 // no hours worked -> no denominator

  await owner("/api/fidelity/settings", {
    method: "PUT", body: { weights: { fidelity: 70, supervision_compliance: 30 } },
  });
  r = await owner("/api/fidelity/settings");
  check("Supervision Compliance is offered as a live category now",
    (r.data.categories || []).some((c) => c.key === "supervision_compliance" && c.live === true),
    (r.data.categories || []).filter((c) => c.live).map((c) => c.key));
  check("Attendance still says it is not wired, and why",
    (r.data.categories || []).some((c) => c.key === "attendance" && c.live === false && /bands rather than a score/i.test(c.source)),
    (r.data.categories || []).find((c) => c.key === "attendance"));

  await doCheckFor(empSup, 54);
  await owner(`/api/fidelity/employee/${empSup}/pay`, { method: "PUT", body: { hourly_rate: 20 } });

  r = await owner(`/api/fidelity/raise/${empSup}`);
  check("the raise view loads with two weighted components", r.status === 200, r.data);
  const supPart = (r.data.components || []).find((c) => c.key === "supervision_compliance");
  check("Supervision Compliance is one of them", !!supPart, r.data.components);
  check("...scored 75%: three of the four judgeable months met the minimum",
    supPart && supPart.value === 75, supPart);
  check("...NOT 5-point-something — the monthly percentage is not the score",
    supPart && supPart.value > 50, supPart);
  check("a month with no worked hours was left out rather than failed",
    supPart && supPart.value === 75, supPart);

  // 90 at 70% + 75 at 30% = 85.5
  check("the weighted performance score combines both",
    r.data.performance_score === 85.5, { got: r.data.performance_score, parts: r.data.components });
  check("...landing in the 85–89.99% band, a 3% raise", r.data.recommended_percent === 3, r.data.band);
  check("...which is $0.60 on $20.00", r.data.recommended_increase === 0.6, r.data.recommended_increase);

  const supWhy = r.data.explanation || "";
  check("the explanation names both components and their weights",
    /RBT Fidelity at 70%/.test(supWhy) && /Supervision Compliance at 30%/.test(supWhy), supWhy);
  check("...and says where the supervision figure came from",
    /3 of 4 months meeting the BACB 5% minimum/.test(supWhy), supWhy);
  check("...including the month it could not judge, and why",
    /1 further month was left out because no worked hours are on file/.test(supWhy), supWhy);

  // Somebody with no supervision months at all is missing data, not 0%.
  const empNoSup = await mkEmp("Tango");
  await doCheckFor(empNoSup, 54);
  r = await owner(`/api/fidelity/raise/${empNoSup}`);
  check("no supervision months on file is reported as missing, never as 0%",
    (r.data.missing_components || []).some((m) => m.key === "supervision_compliance"), r.data.missing_components);
  check("...so the performance score is the Fidelity figure alone, not 63%",
    r.data.performance_score === 90, r.data.performance_score);
  check("...and it is flagged rather than quietly used",
    (r.data.flags || []).some((f) => /No data for/.test(f)), r.data.flags);

  // Put the weights back so the sections below read the default install.
  await owner("/api/fidelity/settings", { method: "PUT", body: { weights: { fidelity: 100 } } });

  // ================================================================
  section("Notices: what the CRM tells people without being asked");

  // The sweep reads notifications_log to prove what was actually sent, rather
  // than trusting its own return value.
  const mailSince = async (since, like) => {
    const q = await pool.query(
      "SELECT subject, body, recipient, type FROM notifications_log WHERE id > $1 AND type LIKE $2 ORDER BY id",
      [since, like]
    );
    return q.rows;
  };
  const lastMailId = async () => {
    const q = await pool.query("SELECT COALESCE(MAX(id), 0) AS n FROM notifications_log");
    return Number(q.rows[0].n);
  };

  r = await evaluator.req("/api/fidelity/sweep", { method: "POST", body: {} });
  check("an evaluator cannot run the notice sweep", r.status === 403, r.status);

  // Somebody has to receive it. Configured the way every other module reads it.
  const setCd = await owner("/api/admin/settings", {
    method: "PATCH", body: { clinical_director_email: `fid.director.${stamp}@example.invalid` },
  });
  check("a Clinical Director address is configured, the way every module reads it", setCd.status === 200, setCd.data);

  // An RBT nobody has ever observed, and an overdue Action Plan, both already
  // exist from the sections above (empNever-equivalent: empC has a plan, and
  // several RBTs have never been checked).
  const empOverdue = await mkEmp("Golf");
  const planCheck = await owner("/api/fidelity/check", { method: "POST", body: { employee_id: empOverdue, assessment_date: today } });
  await owner(`/api/fidelity/check/${planCheck.data.id}`, { method: "PATCH", body: { scores: scoresTotalling(42) } });
  await owner(`/api/fidelity/check/${planCheck.data.id}/finalize`, {
    method: "POST",
    body: { bcba_signed_name: "Jane Doe, BCBA", action_plan_narrative: "Retraining on prompt fading.",
            action_plan_options: ["Written Retraining"], action_plan_due_date: daysAgo(3) },
  });

  // A never-checked RBT created here, so this section has its own unsent
  // notice to look at: an earlier section already ran a sweep, and every
  // notice it sent is claimed and will never be sent again.
  const empFresh = await mkEmp("Mike");

  let mark = await lastMailId();
  r = await owner("/api/fidelity/sweep", { method: "POST", body: {} });
  check("the sweep runs", r.status === 200 && r.data.ok === true, r.data);
  check("it reports how many of each notice it sent",
    ["check_due", "plan_overdue", "ack_outstanding", "review_due"].every((k) => typeof r.data[k] === "number"), r.data);

  const dueMail = await mailSince(mark, "fidelity_checks_due");
  check("one digest goes out for the RBTs who are due, not one email each",
    dueMail.length === 1, dueMail.map((m) => m.subject));
  check("...addressed to the configured Clinical Director",
    dueMail.length === 1 && dueMail[0].recipient.includes(`fid.director.${stamp}`), dueMail[0] && dueMail[0].recipient);
  check("...naming the RBTs and how long it has been",
    dueMail.length === 1 && /never observed/.test(dueMail[0].body), (dueMail[0] || {}).body ? dueMail[0].body.slice(0, 300) : null);
  check("...including the one nobody has ever observed",
    dueMail.length === 1 && dueMail[0].body.includes(`Mike ${stamp}`), (dueMail[0] || {}).body ? dueMail[0].body.slice(0, 400) : null);
  void empFresh;
  check("...and saying which interval made them due",
    dueMail.length === 1 && /90-day interval/.test(dueMail[0].body), (dueMail[0] || {}).body ? dueMail[0].body.slice(0, 300) : null);

  const planMail = await mailSince(mark, "fidelity_plans_overdue");
  check("an overdue Action Plan raises its own digest", planMail.length === 1, planMail.map((m) => m.subject));
  check("...naming the plan's due date and who it sits with",
    planMail.length === 1 && planMail[0].body.includes(daysAgo(3)), (planMail[0] || {}).body ? planMail[0].body.slice(0, 400) : null);
  check("...and saying an Action Plan closes when the retraining happened, not when the date passed",
    planMail.length === 1 && /retraining happened, not that the date passed/i.test(planMail[0].body),
    (planMail[0] || {}).body ? planMail[0].body.slice(-300) : null);

  const tasks = await owner("/api/staff-tasks").catch(() => ({ data: [] }));
  const taskList = Array.isArray(tasks.data) ? tasks.data : (tasks.data.tasks || []);
  check("...and it becomes a task, because it is somebody's unfinished work",
    taskList.some((t) => /Overdue Fidelity Action Plan/.test(String(t.title || ""))),
    taskList.slice(0, 4).map((t) => t.title));

  const taskCount = (list) => list.filter((t) => /Overdue Fidelity Action Plan/.test(String(t.title || ""))).length;
  const tasksAfterFirst = taskCount(taskList);

  // ---- the whole point: running it again sends nothing ----
  mark = await lastMailId();
  r = await owner("/api/fidelity/sweep", { method: "POST", body: {} });
  check("running the sweep again sends nothing at all",
    r.data.check_due === 0 && r.data.plan_overdue === 0 && r.data.review_due === 0, r.data);
  const again = await mailSince(mark, "fidelity_%");
  check("...and no second copy reaches anybody", again.length === 0, again.map((m) => m.subject));

  await owner("/api/fidelity/sweep", { method: "POST", body: {} });
  const tasks2 = await owner("/api/staff-tasks").catch(() => ({ data: [] }));
  const taskList2 = Array.isArray(tasks2.data) ? tasks2.data : (tasks2.data.tasks || []);
  check("...and an overdue plan does not grow a new task on every sweep",
    taskCount(taskList2) === tasksAfterFirst, { first: tasksAfterFirst, now: taskCount(taskList2) });

  // ---- an acknowledgment that never came ----
  // Back-dated past the grace period, which is the only way to reach the case
  // without waiting a week.
  const ackless = await pool.query(
    "SELECT id, employee_id FROM fidelity_checks WHERE employee_ack_at IS NULL AND finalized_at IS NOT NULL AND ack_token IS NOT NULL ORDER BY id LIMIT 1"
  );
  check("there is a finalized check nobody acknowledged", ackless.rows.length === 1, ackless.rows);
  if (ackless.rows.length) {
    const cid = ackless.rows[0].id;
    await pool.query("UPDATE fidelity_checks SET emailed_at = $1 WHERE id = $2",
      [new Date(Date.now() - 20 * 86400000).toISOString(), cid]);
    mark = await lastMailId();
    r = await owner("/api/fidelity/sweep", { method: "POST", body: {} });
    check("an assessment unacknowledged for over a week is chased", r.data.ack_outstanding >= 1, r.data);
    const ackMail = await mailSince(mark, "fidelity_ack_reminder");
    check("...to the employee, who is the only person who can acknowledge it",
      ackMail.length >= 1 && !ackMail.some((m) => m.recipient.includes("director")), ackMail.map((m) => m.recipient));
    check("...carrying the same link their original email had",
      ackMail.length >= 1 && /fidelity-ack\//.test(ackMail[0].body), (ackMail[0] || {}).body ? ackMail[0].body.slice(0, 400) : null);
    mark = await lastMailId();
    await owner("/api/fidelity/sweep", { method: "POST", body: {} });
    check("...once, not every day until they act",
      (await mailSince(mark, "fidelity_ack_reminder")).length === 0);
  }

  // ---- an annual review coming up ----
  const empReview = await mkEmp("Hotel");
  await owner(`/api/fidelity/employee/${empReview}/pay`, {
    method: "PUT", body: { annual_review_date: daysAgo(-14) },
  });
  mark = await lastMailId();
  r = await owner("/api/fidelity/sweep", { method: "POST", body: {} });
  check("a review inside the next 30 days is flagged in advance", r.data.review_due >= 1, r.data);
  const revMail = await mailSince(mark, "fidelity_reviews_due");
  check("...as a digest to leadership", revMail.length === 1, revMail.map((m) => m.subject));
  check("...saying plainly that there are no Fidelity Checks to calculate from",
    revMail.length === 1 && /no Fidelity Checks on file/.test(revMail[0].body),
    (revMail[0] || {}).body ? revMail[0].body.slice(0, 400) : null);
  check("...and that there is no hourly rate either",
    revMail.length === 1 && /no hourly rate on file/.test(revMail[0].body),
    (revMail[0] || {}).body ? revMail[0].body.slice(0, 400) : null);

  // A review far out is not chased yet.
  const empFar = await mkEmp("India");
  await owner(`/api/fidelity/employee/${empFar}/pay`, { method: "PUT", body: { annual_review_date: daysAgo(-200) } });
  mark = await lastMailId();
  await owner("/api/fidelity/sweep", { method: "POST", body: {} });
  check("a review 200 days out is not chased today",
    !(await mailSince(mark, "fidelity_reviews_due")).some((m) => m.body.includes("India")),
    (await mailSince(mark, "fidelity_reviews_due")).map((m) => m.subject));

  // ================================================================
  await pool.end().catch(() => {});
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness error:", e && e.stack || e); process.exit(1); });
