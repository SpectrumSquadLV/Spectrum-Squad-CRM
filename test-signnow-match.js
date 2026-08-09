// The matcher, tested in isolation against the real title patterns.
//
// This is the part that can hurt someone. Everything else in the import is
// plumbing; this decides whose record a signed enrollment packet -- SSN,
// insurance card and all -- gets attached to. The bar is not "matches often",
// it is "never confidently matches the wrong person". A document that ends up
// in the needs-a-human pile costs a minute. One filed on the wrong child is a
// HIPAA incident.
//
// Titles below are taken verbatim from Quiana's SignNow account.
"use strict";

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + String(detail).slice(0, 300) : "")); }
};

const noop = async () => {};
const mod = require("./signnow-import")({
  dbGet: noop, dbAll: noop, dbRun: noop,
  nowISO: () => "2026-08-09T00:00:00.000Z",
  crypto: require("crypto"), json: noop, readBody: noop,
  signNowRequest: noop, signNowConfigured: () => true, signNowFetchRaw: noop,
  DOCS_DIR: "/tmp", RESUME_DIR: "/tmp", logAudit: noop,
});
const { matchOne, docKind, looksLikeTest, initialsOf, buildIndex } = mod._internal;

const clients = [
  { id: 1, child_name: "Hudson Holland",   parent_email: "hudson.mom@example.com" },
  { id: 2, child_name: "Jayden Barnes",    parent_email: "jbarnes@example.com" },
  { id: 3, child_name: "Sol McAtee",       parent_email: "somc@example.com" },
  { id: 4, child_name: "Giovanni Ramos",   parent_email: "gramos@example.com" },
  { id: 5, child_name: "Alexander Borja",  parent_email: "aborja@example.com" },
  { id: 6, child_name: "Link McAtee",      parent_email: "link.mcatee@example.com" },
  { id: 7, child_name: "Lola Young",       parent_email: "lyoung@example.com" },
];
const employees = [
  { id: 11, name: "Dora Gomm",        email: "dgomm@spectrumsquadlv.com",     role_title: "RBT" },
  { id: 12, name: "Fatisha Corbin",   email: "fcorbin@spectrumsquadlv.com",   role_title: "RBT" },
  { id: 13, name: "Marissa Gauthier", email: "mgaut@spectrumsquadlv.com",     role_title: "RBT" },
  { id: 14, name: "Lexie Gilbert",    email: "lgilbert@spectrumsquadlv.com",  role_title: "BCBA" },
  { id: 15, name: "Martha Vera",      email: "mvera@spectrumsquadlv.com",     role_title: "RBT" },
  { id: 16, name: "Mariah Beach",     email: "mbeach@spectrumsquadlv.com",    role_title: "RBT" },
];
const index = buildIndex(clients, employees);
const m = (name, emails = []) => matchOne({ name, signer_emails: JSON.stringify(emails) }, clients, employees, index);

// ---------------- what kind of document is this ----------------
console.log("\n== document kinds ==");
check("an enrollment packet is a client document", docKind("Spectrum Squad New Patient Enrollment Packet") === "enrollment");
check("a timecard is a staff document", docKind("Fatisha_Corbin_Timecard_07-13-2026") === "timecard");
check("'Dora's Hours' is a timecard", docKind("Dora's Hours") === "timecard");
check("an FA-11E is an authorization", docKind("GrJo June 2026 FA-11E-3") === "authorization");
check("a treatment plan is clinical", docKind("LoYu Initial Assesment & Treatment Plan") === "clinical");
check("an offer letter is a staff document", docKind("Job Offer Letter Newest RBT") === "offer");
check("a consent form is a client document", docKind("Ja Ba Authorized Representative Consent Form") === "consent");

// ---------------- signer email beats everything ----------------
console.log("\n== signer email ==");
let r = m("Spectrum Squad New Patient Enrollment Packet", ["hudson.mom@example.com"]);
check("a bare template title still matches on the signer", r.type === "client" && r.id === 1 && r.confidence === "exact", JSON.stringify(r));
r = m("New Hire Employee Packet", ["dgomm@spectrumsquadlv.com"]);
check("a staff packet matches its signer", r.type === "employee" && r.id === 11 && r.confidence === "exact", JSON.stringify(r));
r = m("Enrollment Packet - Giovanni Ramos", ["hudson.mom@example.com"]);
check("the signer wins over a name in the title", r.type === "client" && r.id === 1, JSON.stringify(r));

// ---------------- names in the title ----------------
console.log("\n== names in the title ==");
r = m("Spectrum Squad New Patient Enrollment Packet - Alexander Borja");
check("a client's full name matches", r.type === "client" && r.id === 5 && r.confidence === "strong", JSON.stringify(r));
r = m("Spectrum Squad New Patient Enrollment Packet - Link McAtee");
check("Link McAtee is not confused with Sol McAtee", r.type === "client" && r.id === 6, JSON.stringify(r));
r = m("Fatisha_Corbin_Timecard_07-13-2026_to_07-24-2026");
check("an underscored staff name matches", r.type === "employee" && r.id === 12 && r.confidence === "strong", JSON.stringify(r));

// ---------------- the initials convention ----------------
console.log("\n== four-letter initials ==");
r = m("HuHo Treatment Plan");
check("HuHo finds Hudson Holland", r.type === "client" && r.id === 1 && r.confidence === "strong", JSON.stringify(r));
r = m("Ja Ba Authorized Representative Consent Form");
check("the spaced variant 'Ja Ba' finds Jayden Barnes", r.type === "client" && r.id === 2, JSON.stringify(r));
r = m("SoMc May 2026 Progress Report_052520261542");
check("SoMc finds Sol McAtee", r.type === "client" && r.id === 3, JSON.stringify(r));
check("initialsOf builds the convention correctly", initialsOf("Hudson Holland") === "huho" && initialsOf("Lola Young") === "loyo");

// ---------------- email local-part in the title ----------------
console.log("\n== email prefix in the title ==");
r = m("Spectrum Squad Attendance & Punctuality Policy_1_dgomm");
check("a title ending in an email prefix finds the staff member", r.type === "employee" && r.id === 11, JSON.stringify(r));
r = m("BCBA CREDENTIALING PACKET_2_lgilbert");
check("so does a credentialing packet", r.type === "employee" && r.id === 14, JSON.stringify(r));

// ---------------- the refusals: what must NOT happen ----------------
console.log("\n== refusing to guess ==");
r = m("Job Offer Letter");
check("a bare 'Job Offer Letter' matches nobody", !r.type && r.confidence === "none", JSON.stringify(r));
r = m("Spectrum Squad New Patient Enrollment Packet");
check("a bare enrollment packet matches nobody", !r.type, JSON.stringify(r));
r = m("Mariah Hours");
check("a first name alone is weak, never strong", r.confidence === "weak" && r.type === "employee", JSON.stringify(r));
r = m("Martha Timecard");
check("Martha is weak too", r.confidence === "weak", JSON.stringify(r));

// The one that matters most: a staff first name must never land on a client's
// clinical record, and a client name must never land on a timecard.
r = m("Marissa's Hours");
check("a staff hours sheet never matches a client", r.type !== "client", JSON.stringify(r));
r = m("HuHo Initial Assessment");
check("a clinical document never matches a staff member", r.type !== "employee", JSON.stringify(r));

// Two people, one name fragment.
const twoMarthas = [...employees, { id: 17, name: "Martha Quinn", email: "mquinn@spectrumsquadlv.com" }];
const idx2 = buildIndex(clients, twoMarthas);
r = matchOne({ name: "Martha Timecard", signer_emails: "[]" }, clients, twoMarthas, idx2);
check("two Marthas produce an ambiguous match, not a coin flip", r.confidence === "ambiguous" && !r.type, JSON.stringify(r));

// Two clients whose initials collide.
const twoHu = [...clients, { id: 8, child_name: "Hunter Hoffman", parent_email: "hh@example.com" }];
const idx3 = buildIndex(twoHu, employees);
r = matchOne({ name: "HuHo Treatment Plan", signer_emails: "[]" }, twoHu, employees, idx3);
check("colliding initials are ambiguous, not a guess", r.confidence === "ambiguous" && !r.type, JSON.stringify(r));

// ---------------- test documents ----------------
console.log("\n== test documents ==");
check("ZZTEST is a test", looksLikeTest("Enrollment Packet - ZZTEST PipelineV2Verify"));
check("'Enrollment Packet - Test' is a test", looksLikeTest("Enrollment Packet - Test"));
check("DeleteVerify is a test", looksLikeTest("Enrollment Packet - ZZTEST DeleteVerify"));
check("a real family called Testa is NOT a test", !looksLikeTest("Enrollment Packet - Maria Testa"));
check("'Latest Offer Letter' is NOT a test", !looksLikeTest("Latest Offer Letter"));
check("a normal enrollment packet is not a test", !looksLikeTest("Spectrum Squad New Patient Enrollment Packet - Link McAtee"));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
