// What KIND of clinical document is this? One vocabulary, one set of patterns,
// used by everything that needs to answer that question.
//
// It lives on its own because two callers need it and neither should own it:
// the Authorization Request matches documents already in a client's file, and
// the SignNow import decides what a document IS as it arrives. A second copy of
// these patterns in the importer would drift from the one the matcher uses, and
// the drift would show up as a document that the importer called a Vineland and
// the matcher would not accept as one.
//
// THE PATTERNS ARE A GUESS ABOUT A NAME, AND THE CALLER MUST KNOW THAT. Nothing
// here promises a document is what its title says. `classifyTitle` returns the
// single type a title unambiguously indicates, or null -- and null is a perfectly
// good answer that costs somebody one confirming click, which is far cheaper
// than a wrong document going to a payer.

const NAME_HINTS = {
  diagnosis: /\b(diagnosis|dx)\b/i,
  diagnostic_evaluation: /diagnostic|psych(ological)?\s*eval|eval(uation)?\b/i,
  vineland: /vineland|vabs/i,
  srs: /\bsrs\b|social responsiveness/i,
  pddbi: /\bpddbi\b|pdd[-\s]?bi/i,
  parent_stress_index: /parent(ing)?\s*stress|\bpsi\b/i,
  treatment_plan: /treatment\s*plan|\btx\s*plan\b/i,
  signed_treatment_plan: /signed.*treatment\s*plan|treatment\s*plan.*signed/i,
  authorization_approval: /auth.*approv|approv.*auth/i,
  authorization_denial: /auth.*deni|deni.*auth/i,
};

// A title that lands on two types is normally no answer at all. This pair is
// the exception, and deliberately so: "Signed Treatment Plan" matches both.
//
// It resolves to the UNSIGNED type, which looks wrong until you follow what
// each choice does. A requirement for a treatment plan is satisfied by
// `treatment_plan` and then held for the parent's signature; `signed_treatment_plan`
// is a different key and satisfies nothing, so the requirement would sit there
// unmet while a document that looks like the answer sat beside it.
//
// The asymmetry is the point. Choosing the unsigned type can cost a parent a
// signature they may have already given elsewhere. Choosing the signed one can
// let a request go out with a requirement quietly unmet. One of those is an
// inconvenience and the other reaches a payer, so the tie breaks toward the
// inconvenience every time.
const AMBIGUITY_RESOLUTIONS = {
  "signed_treatment_plan|treatment_plan": "treatment_plan",
};

// Types this never assigns from a title alone, whatever the words say.
// An approval or a denial is the payer's ANSWER, and which one it is decides
// whether a child starts services. That is recorded by a person who has read
// it, never inferred from a subject line.
const NEVER_FROM_TITLE = new Set(["authorization_approval", "authorization_denial"]);

function classifyTitle(title) {
  const t = String(title == null ? "" : title);
  if (!t.trim()) return null;
  const hits = Object.keys(NAME_HINTS)
    .filter((k) => !NEVER_FROM_TITLE.has(k))
    .filter((k) => NAME_HINTS[k].test(t))
    .sort();
  if (!hits.length) return null;
  if (hits.length === 1) return hits[0];
  const resolved = AMBIGUITY_RESOLUTIONS[hits.join("|")];
  return resolved || null;
}

module.exports = { NAME_HINTS, classifyTitle, NEVER_FROM_TITLE, AMBIGUITY_RESOLUTIONS };
