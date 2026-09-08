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
  check("only Fidelity is wired in so far, and says so",
    r.data.categories.filter((c) => c.live).map((c) => c.key).join() === "fidelity",
    r.data.categories.filter((c) => c.live).map((c) => c.key));

  r = await owner("/api/fidelity/settings", { method: "PUT", body: { weights: { fidelity: 80, attendance: 30 } } });
  check("weights that do not total 100 are refused", r.status === 400, r.data);
  check("...and say what they total", /110/.test(r.data.error || ""), r.data.error);
  r = await owner("/api/fidelity/settings", { method: "PUT", body: { check_interval_days: 45 } });
  check("an interval can be changed", r.status === 200 && r.data.check_interval_days === 45, r.data);
  r = await evaluator.req("/api/fidelity/settings", { method: "PUT", body: { check_interval_days: 1 } });
  check("an evaluator cannot change the raise policy", r.status === 403, r.status);
  await owner("/api/fidelity/settings", { method: "PUT", body: { check_interval_days: 90 } });

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
