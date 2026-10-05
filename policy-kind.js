// Telling a policy from an SOP, for records that were never asked which they
// were.
//
// The two-library split added doc_kind with a migration that set every
// existing record to 'policy', because that is what the column had always
// implicitly meant and inventing a classification during a migration would
// have been worse than admitting there wasn't one. The result is a library
// where a lot of SOPs are filed as policies -- which is exactly the
// undifferentiated list the split existed to end.
//
// This is the classifier that proposes a fix. It PROPOSES: nothing here writes
// anything, and every verdict carries the reason it reached, because a
// reclassification somebody cannot check is one they have to either trust
// blindly or redo by hand.
//
// The ordering of the signals is the whole design, and it is this:
//
//   1. THE LAST NOUN IN THE TITLE WINS. "Policy Change Request and Review SOP"
//      contains both words, and it is an SOP -- the trailing word is what the
//      document calls itself, and everything before it is the subject. A
//      naive keyword count gets this exactly backwards.
//   2. A CATEGORY THAT SAYS SOP IS NEARLY DEFINITIVE. Somebody filed it under
//      "Clinical SOPs" on purpose.
//   3. Then the rest of the title.
//   4. Then the shape of the body -- numbered steps read as a procedure.
//
// Where nothing fires, the answer is "leave it alone", not a guess. An
// unchanged record is a known state; a wrongly flipped one is not.
"use strict";

// The word a document uses for itself, when it is the last thing in the title.
const TRAILING = [
  { re: /\b(sop|s\.o\.p\.?)\s*$/i, kind: "sop", why: 'the title ends with "SOP"' },
  { re: /\b(procedure|procedures)\s*$/i, kind: "sop", why: 'the title ends with "Procedure"' },
  { re: /\b(process|workflow|checklist|instructions|steps)\s*$/i, kind: "sop", why: "the title ends with a word that names a process" },
  { re: /\b(policy|policies)\s*$/i, kind: "policy", why: 'the title ends with "Policy"' },
  { re: /\b(standard|standards|rules|code)\s*$/i, kind: "policy", why: "the title ends with a word that names a standard" },
];

// A category somebody chose deliberately.
const CATEGORY = [
  { re: /\bSOPs?\b/i, kind: "sop", why: "it is filed under a category that says SOP" },
];

// Anywhere in the title, once the trailing word has had its say.
const TITLE = [
  { re: /\bsop\b/i, kind: "sop", why: 'the title says "SOP"' },
  { re: /\bhow\s+to\b/i, kind: "sop", why: 'the title says "how to"' },
  { re: /\b(procedure|procedures|workflow|checklist)\b/i, kind: "sop", why: "the title names a procedure" },
  { re: /\b(step[\s-]?by[\s-]?step)\b/i, kind: "sop", why: "the title says step by step" },
  { re: /\b(policy|policies)\b/i, kind: "policy", why: 'the title says "policy"' },
];

// Three or more numbered lines near the top reads as a procedure rather than a
// statement of a rule. Checked over the opening only: a policy may well end
// with a numbered list of definitions, and that is not the same thing.
function looksLikeSteps(body) {
  const head = String(body || "").split("\n").slice(0, 40);
  let n = 0;
  for (const line of head) {
    if (/^\s*(\d+[.)]\s+\S|step\s+\d+\b)/i.test(line)) n++;
  }
  return n >= 3;
}

// Returns { kind, why, confidence } or null when nothing fires.
//
// confidence is "high" when the document named itself or was filed under a
// category that did, "medium" otherwise. The screen sorts by it so the
// obvious ones can be confirmed in a block and the arguable ones get read.
function classify({ title, category, body }) {
  const t = String(title || "").trim();
  const c = String(category || "").trim();

  for (const r of TRAILING) {
    if (r.re.test(t)) return { kind: r.kind, why: r.why, confidence: "high" };
  }
  for (const r of CATEGORY) {
    if (r.re.test(c)) return { kind: r.kind, why: r.why + ' ("' + c + '")', confidence: "high" };
  }
  for (const r of TITLE) {
    if (r.re.test(t)) return { kind: r.kind, why: r.why, confidence: "medium" };
  }
  if (looksLikeSteps(body)) {
    return { kind: "sop", why: "the text opens with numbered steps", confidence: "medium" };
  }
  return null;
}

module.exports = { classify, looksLikeSteps, TRAILING, CATEGORY, TITLE };
