// What kind of clinical document is this, decided from a title.
//
// The whole value of answering at import is that a BCBA does not have to
// confirm a document later. The whole RISK of answering at import is that a
// wrong answer auto-attaches silently and can reach a payer as the wrong
// document. So the tests here are mostly about the answers it refuses to give.
//
//   node test-clinical-type.js
const ct = require("./clinical-type.js");
const fs = require("fs");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 300) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

section("A title that plainly says what it is");
[
  ["Vineland-3", "vineland"],
  ["VABS-3 Report", "vineland"],
  ["SRS-2", "srs"],
  ["Social Responsiveness Scale", "srs"],
  ["PDDBI", "pddbi"],
  ["PDD-BI Parent Form", "pddbi"],
  ["Parenting Stress Index", "parent_stress_index"],
  ["Treatment Plan", "treatment_plan"],
  ["Tx Plan 2026", "treatment_plan"],
  ["Diagnostic Evaluation", "diagnostic_evaluation"],
].forEach(([title, want]) => {
  check(`"${title}" is a ${want}`, ct.classifyTitle(title) === want, ct.classifyTitle(title));
});

section("A title that says nothing is left alone");
["Timecard July 2026", "Offer Letter", "Attendance & Punctuality", "New Hire Packet",
 "Financial Responsibility Form", "", "   ", null, undefined].forEach((title) => {
  check(`${JSON.stringify(title)} stays untyped`, ct.classifyTitle(title) === null, ct.classifyTitle(title));
});

section("THE SIGNED PLAN TIE-BREAK, which is a safety rule not a preference");
{
  // "Signed Treatment Plan" matches two patterns. It must resolve to the
  // UNSIGNED one: a requirement for a treatment plan is satisfied by
  // treatment_plan and then held for the parent's signature, while
  // signed_treatment_plan is a different key that satisfies nothing -- so the
  // requirement would sit unmet beside a document that looks like the answer.
  ["Signed Treatment Plan", "Treatment Plan (signed)", "Treatment Plan - Signed by Parent"].forEach((t) => {
    check(`"${t}" resolves to treatment_plan`, ct.classifyTitle(t) === "treatment_plan", ct.classifyTitle(t));
    check(`..."${t}" is NEVER signed_treatment_plan`, ct.classifyTitle(t) !== "signed_treatment_plan");
  });
}

section("A PAYER'S ANSWER IS NEVER READ OFF A TITLE");
{
  // Approval and denial decide whether a child starts services. Which one it
  // is gets recorded by somebody who has read the letter.
  ["Authorization Approval", "Auth Approved 2026", "Authorization Denial Letter",
   "Auth Denied - Tricare"].forEach((t) => {
    check(`"${t}" is not typed from its title alone`, ct.classifyTitle(t) === null, ct.classifyTitle(t));
  });
  check("both are on the refusal list explicitly",
    ct.NEVER_FROM_TITLE.has("authorization_approval") && ct.NEVER_FROM_TITLE.has("authorization_denial"));
}

section("Two meanings in one title is no answer");
{
  // Matching two unrelated types is exactly when a guess is most likely wrong.
  const two = ct.classifyTitle("Diagnosis and Diagnostic Evaluation");
  check("a title naming two different documents stays untyped", two === null, two);
  const vineSrs = ct.classifyTitle("Vineland and SRS scoring summary");
  check("...and so does one naming two instruments", vineSrs === null, vineSrs);
}

section("One vocabulary, not two");
{
  // The importer and the matcher must agree. If somebody re-introduces a local
  // copy of these patterns in either file, a document one calls a Vineland the
  // other may not, and nobody would see it until a request went out short.
  const auth = fs.readFileSync("./authorization-requests.js", "utf8");
  const imp = fs.readFileSync("./signnow-import.js", "utf8");
  check("the Authorization Request takes its patterns from the shared module",
    /require\("\.\/clinical-type\.js"\)/.test(auth) && !/const NAME_HINTS\s*=\s*\{/.test(auth));
  check("THE IMPORTER USES THE SAME MODULE, not a second copy",
    /require\("\.\/clinical-type\.js"\)/.test(imp) && !/const NAME_HINTS\s*=\s*\{/.test(imp));
  check("every type the matcher knows is a type the classifier can name",
    Object.keys(ct.NAME_HINTS).every((k) => /^[a-z_]+$/.test(k)) && Object.keys(ct.NAME_HINTS).length >= 10,
    Object.keys(ct.NAME_HINTS).length);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
