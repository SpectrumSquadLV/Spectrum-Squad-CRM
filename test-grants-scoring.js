// The Grant Finder scoring and eligibility engine.
//
// This is the part of the module a human actually acts on: somebody reads
// "84% — strong match" and spends a week writing an application. So the
// engine is pure on purpose and tested directly, with the awkward grants
// rather than the flattering ones.
//
// The properties that matter most, and the ones this suite is built around:
//
//   1. Eligibility is not the score. A perfect thematic match that is
//      501(c)(3)-only must come back likely ineligible, and must never be
//      recommended, however high it scores.
//   2. Unknown is not no, and it is certainly not yes. A blank "for-profit
//      allowed" earns no points and produces "needs review" with the reason
//      attached.
//   3. Every point is explainable. Whatever the number is, there is a sentence
//      naming what earned it.
//
// Pure functions only -- no server, no database, no network.
//   Run with: node test-grants-scoring.js
"use strict";
const path = require("path");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 400) : "")); }
}
const section = (t) => console.log("\n== " + t + " ==");

// initGrants only destructures its ctx at construction time, and the scoring
// functions never touch any of it.
const grants = require(path.join(__dirname, "grants.js"))({
  dbGet: async () => null,
  dbAll: async () => [],
  dbRun: async () => ({ rows: [] }),
  nowISO: () => "2026-08-22T00:00:00.000Z",
  readBody: async () => ({}),
  json: () => {},
});
const { scoreGrant, analyzeEligibility, assess } = grants;

// Spectrum Squad as the profile describes it.
const US = {
  for_profit: true, state: "Nevada", county: "Clark County",
  woman_owned: true, veteran_owned: true, small_business: true,
  year_founded: 2019, employee_count: 40, sam_registered: false, uei: "",
};

const grant = (over = {}) => ({
  name: "Test grant", tags: JSON.stringify([]), geographic_eligibility: "",
  ...over,
  tags: JSON.stringify(over.tags || []),
});

// ---------------------------------------------------------------- scoring
section("A grant aimed squarely at us scores high");
const ideal = grant({
  name: "Nevada Behavioral Health Workforce",
  tags: ["nevada", "behavioral_health", "autism", "children_youth", "healthcare_workforce", "rbt_training"],
  geographic_eligibility: "Nevada",
  for_profit_allowed: true, small_business_eligible: true,
  woman_preference: true, veteran_preference: true,
});
const idealScore = scoreGrant(ideal, US, ["train_rbts"]);
check("scores 75 or better", idealScore.score >= 75, idealScore.score);
check("and says why in plain words", /Nevada/i.test(idealScore.explanation), idealScore.explanation);
check("naming the woman-owned preference", idealScore.reasons.some((r) => /woman-led/i.test(r)), idealScore.reasons);
check("naming the veteran-owned preference", idealScore.reasons.some((r) => /veteran-owned/i.test(r)), idealScore.reasons);
check("and the funding priority it matches", idealScore.reasons.some((r) => /priority/i.test(r)), idealScore.reasons);

section("An unrelated grant scores low");
const unrelated = grant({
  name: "Coastal Fisheries Modernisation",
  tags: ["technology"], geographic_eligibility: "Maine",
  for_profit_allowed: true,
});
const unrelatedScore = scoreGrant(unrelated, US, []);
check("scores under 40", unrelatedScore.score < 40, unrelatedScore.score);
check("and does not claim a geography match",
  !unrelatedScore.reasons.some((r) => /Nevada/i.test(r)), unrelatedScore.reasons);

section("Every score is explainable");
for (const g of [ideal, unrelated, grant({ tags: ["autism"] })]) {
  const s = scoreGrant(g, US, []);
  check(`${JSON.parse(g.tags).join("/") || "bare"} grant: score is backed by at least one reason`,
    s.score === 0 || s.reasons.length > 0, s);
  check(`${JSON.parse(g.tags).join("/") || "bare"} grant: score stays within 0-100`,
    s.score >= 0 && s.score <= 100, s.score);
}

section("Funding priorities move the ranking");
const rbt = grant({ tags: ["rbt_training", "healthcare_workforce"], for_profit_allowed: true, geographic_eligibility: "National" });
const without = scoreGrant(rbt, US, []).score;
const withPri = scoreGrant(rbt, US, ["train_rbts"]).score;
check("selecting a matching priority raises the score", withPri > without, { without, withPri });
check("an unrelated priority does not", scoreGrant(rbt, US, ["vehicles"]).score === without);

// ------------------------------------------------------------ eligibility
section("Nonprofit-only is a blocker, however good the match");
const nonprofitOnly = grant({
  name: "Autism Family Support Fund",
  tags: ["autism", "behavioral_health", "children_youth", "nevada"],
  geographic_eligibility: "Nevada",
  nonprofit_required: true,
});
const npScore = scoreGrant(nonprofitOnly, US, []);
const npElig = analyzeEligibility(nonprofitOnly, US);
check("it still scores as thematically relevant", npScore.score >= 40, npScore.score);
check("but eligibility is likely_ineligible", npElig.status === "likely_ineligible", npElig);
check("the flag is raised for the card", npElig.flags.includes("Nonprofit only"), npElig.flags);
check("and the explanation names the reason",
  /501\(c\)\(3\)|nonprofit/i.test(npElig.explanation), npElig.explanation);

section("Other applicant-type restrictions");
for (const [field, flag] of [
  ["government_only", "Government only"],
  ["university_only", "University only"],
  ["school_district_only", "School district only"],
  ["tribal_only", "Tribal organization only"],
  ["research_institution_only", "Research institution only"],
]) {
  const e = analyzeEligibility(grant({ [field]: true, tags: ["autism"] }), US);
  check(`${field} is a blocker`, e.status === "likely_ineligible", e.status);
  check(`${field} raises "${flag}"`, e.flags.includes(flag), e.flags);
}

section("An explicit no to for-profits is a blocker");
const noForProfit = analyzeEligibility(grant({ for_profit_allowed: false, tags: ["autism"] }), US);
check("likely ineligible", noForProfit.status === "likely_ineligible", noForProfit.status);
check("flagged", noForProfit.flags.includes("For-profit companies excluded"), noForProfit.flags);

section("Unknown is not yes");
const unknown = analyzeEligibility(grant({ tags: ["autism"], geographic_eligibility: "National" }), US);
check("comes back needs_review, not eligible", unknown.status === "needs_review", unknown.status);
check("and says what has to be read", /for-profit/i.test(unknown.explanation), unknown.explanation);
check("scoring gives unknown no credit",
  scoreGrant(grant({ tags: [] }), US, []).score === 0);

section("A clean fit reads as eligible");
const clean = analyzeEligibility(grant({
  for_profit_allowed: true, small_business_eligible: true,
  geographic_eligibility: "Nevada", tags: ["nevada", "behavioral_health"],
}), US);
check("eligible", clean.status === "eligible", clean);
check("with no blockers", clean.blockers.length === 0, clean.blockers);
check("and says so in plain words", /Strong eligibility/i.test(clean.explanation), clean.explanation);

section("Geography that excludes Nevada");
const elsewhere = analyzeEligibility(grant({
  for_profit_allowed: true, geographic_eligibility: "California and Oregon only", tags: ["autism"],
}), US);
check("is a blocker", elsewhere.status === "likely_ineligible", elsewhere.status);
check("flagged as a geographic restriction", elsewhere.flags.includes("Geographic restriction"), elsewhere.flags);

section("Requirements that cost time but do not disqualify");
const samNeeded = analyzeEligibility(grant({
  for_profit_allowed: true, geographic_eligibility: "National", sam_required: true, uei_required: true, tags: ["healthcare"],
}), US);
check("SAM and UEI are flagged", samNeeded.flags.includes("SAM.gov registration required")
  && samNeeded.flags.includes("UEI required"), samNeeded.flags);
check("but we are still possibly eligible", samNeeded.status === "possibly_eligible", samNeeded.status);
check("and told what is missing", /SAM\.gov/i.test(samNeeded.explanation), samNeeded.explanation);

const registered = analyzeEligibility(
  grant({ for_profit_allowed: true, geographic_eligibility: "National", sam_required: true, tags: ["healthcare"] }),
  { ...US, sam_registered: true }
);
check("once SAM is active it stops being an open question", registered.status === "eligible", registered.status);

section("Thresholds are checked against the profile");
const tooYoung = analyzeEligibility(grant({ for_profit_allowed: true, min_years_in_business: 25, tags: ["healthcare"] }), US);
check("a years-in-business rule we fail is a blocker", tooYoung.status === "likely_ineligible", tooYoung.status);
check("and states the gap", /25 years/.test(tooYoung.explanation), tooYoung.explanation);

const tooBig = analyzeEligibility(grant({ for_profit_allowed: true, max_employees: 10, tags: ["healthcare"] }), US);
check("an employee cap we exceed is a blocker", tooBig.status === "likely_ineligible", tooBig.status);

const okSize = analyzeEligibility(grant({ for_profit_allowed: true, max_employees: 500, tags: ["healthcare"] }), US);
check("a cap we sit under is not", okSize.status !== "likely_ineligible", okSize.status);

// ----------------------------------------------------------------- assess
section("assess() carries both answers together");
const a = assess(ideal, US, ["train_rbts"]);
check("returns a score", typeof a.match_score === "number");
check("returns an eligibility status", !!a.eligibility_status);
check("returns a human label", a.eligibility_label === "Eligible", a.eligibility_label);
check("returns the flags for the card", Array.isArray(a.disqualification_flags));
const b = assess(nonprofitOnly, US, []);
check("a high-scoring blocked grant keeps both facts",
  b.match_score >= 40 && b.eligibility_status === "likely_ineligible", b);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
