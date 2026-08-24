// The clinical screener as a document a BCBA can read.
//
// The on-screen viewer prints field names — "Aba: Yes" — which is no use to
// anyone reading a child's history. The PDF prints the questions as the parent
// read them, and gets them by parsing the form rather than from a copied map,
// because a copied map is correct exactly once.
//
// That parsing is the risk, so most of this suite is aimed at it. The failure
// that matters is not a crash: it is a question resolving to the WRONG wording,
// which on a clinical record reads as true and is worse than printing the raw
// field name. An earlier version of the parser did exactly that twice — it
// labelled aggression frequency with a language question, and silently dropped
// the behaviours-of-concern answer entirely.
//
//   node test-screener-pdf.js
"use strict";
const path = require("path");
const fs = require("fs");
const { screenerQuestions, parseQuestions } = require(path.join(__dirname, "screener-questions.js"));
const { buildPdf, asciiSafe, wrapText } = require(path.join(__dirname, "pdf-doc.js"));

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

const HTML = fs.readFileSync(path.join(__dirname, "clinical-screener.html"), "utf8");
const Q = screenerQuestions();

section("Every field on the form resolves to a question");
// The guard against drift: add a question to the form and forget it here, and
// this fails rather than the PDF quietly printing a field name at a clinician.
const inputRe = /<(input|textarea|select)\b[^>]*\bname="([a-zA-Z0-9_]+)"[^>]*>/g;
const fields = new Set();
let m;
while ((m = inputRe.exec(HTML)) !== null) fields.add(m[2]);
check("the form has the fields we expect to find", fields.size > 60, fields.size);
const missing = [...fields].filter((f) => !Q[f]);
check("no field is missing a question", missing.length === 0, missing);
const rawNames = Object.keys(Q).filter((k) => Q[k] === k);
check("no question fell back to the raw field name", rawNames.length === 0, rawNames);

section("The questions are the right ones, not merely present");
// Spot-checks on the cases the parser gets wrong if the logic is naive. Each
// of these was actually wrong at some point while building it.
const expectations = [
  ["aba", /ABA services/i],
  ["aba_current_provider", /which provider/i],
  ["child_name", /child.*full name/i],
  ["behavior", /behaviors of concern/i],          // a group with no label of its own
  ["beh_aggression_freq", /^Aggression/],          // must NOT borrow a neighbour's label
  ["beh_aggression_desc", /^Aggression/],
  ["beh_tantrum_sev", /^Tantrums/],
  ["understanding", /understand language/i],
  ["sleep_hours", /hours of sleep/i],
];
for (const [field, re] of expectations) {
  check(`"${field}" reads as a real question`, re.test(Q[field] || ""), { field, got: Q[field] });
}

section("A behaviour follow-up never borrows another section's question");
// The specific bug: the behaviour matrix nests its inputs with no label, and
// reaching for the nearest label walks out of the section entirely.
for (const f of Object.keys(Q).filter((k) => k.startsWith("beh_"))) {
  check(`"${f}" is labelled with its own behaviour`,
    /^(Aggression|Tantrums|Elopement|Property|Toileting|Other|Self)/i.test(Q[f]), { field: f, got: Q[f] });
}

section("The behaviours-of-concern answer is not dropped");
// It was, by a skip-list that mistook it for a section name. It is the single
// most clinically important answer on the form.
check("'behavior' is a question, not an exclusion", !!Q.behavior && Q.behavior !== "behavior", Q.behavior);

section("Parsing is resilient to a form that changes");
check("an empty form yields nothing rather than throwing",
  Object.keys(parseQuestions("")).length === 0);
check("markup with no labels still names its fields",
  parseQuestions('<input name="foo">').foo === "foo");
check("a placeholder alone is enough to be a question",
  parseQuestions('<input name="bar" placeholder="How old are they?">').bar === "How old are they?");

section("The PDF carries the questions and the answers");
const data = {
  child_name: "Jordan Pierce", aba: "Yes", aba_current_provider: "Desert Sky Behavioral",
  behavior: ["Aggression", "Tantrums"],
  beh_aggression_freq: "3-4 times a week",
  success_vision: "To tell us what he needs without getting upset.",
};
const blocks = Object.keys(Q).filter((k) => k in data).map((k) => ({
  type: "row",
  label: Q[k],
  value: Array.isArray(data[k]) ? data[k].join(", ") : data[k],
}));
const pdf = buildPdf({ title: "Clinical Screener — Jordan Pierce", subtitle: "Submitted today", blocks });
const text = pdf.toString("latin1");
check("it is a PDF", text.startsWith("%PDF-"), text.slice(0, 8));
check("it ends properly so a reader will open it", text.trimEnd().endsWith("%%EOF"));
check("the questions are in it", text.includes("ABA services?"), false);
check("so are the answers", text.includes("Desert Sky Behavioral"), false);
check("including the multi-select behaviours", text.includes("Aggression, Tantrums"), false);
check("and the free-text answer", text.includes("without getting upset"), false);
check("it declares the pages it contains", /\/Count \d+/.test(text));

section("A parent's own typing does not corrupt the document");
// Curly quotes, dashes and emoji come from real submissions. The base-14 fonts
// are WinAnsi, so passing these through produces mojibake in a clinical record.
check("curly quotes become straight", asciiSafe("it’s fine") === "it's fine");
check("en and em dashes become hyphens", asciiSafe("3–4 — often") === "3-4 - often");
check("ellipsis is spelled out", asciiSafe("wait…") === "wait...");
check("emoji are dropped rather than mangled", asciiSafe("great 🌟 job") === "great  job");
const emojiPdf = buildPdf({ title: "T", blocks: [{ type: "row", label: "Q 🌟", value: "A — B’s" }] });
check("a PDF built from that is still well-formed",
  emojiPdf.toString("latin1").startsWith("%PDF-") && emojiPdf.toString("latin1").trimEnd().endsWith("%%EOF"));

section("Parentheses and backslashes do not break the file");
// Unescaped, these end a PDF string early and corrupt everything after.
const trickyPdf = buildPdf({
  title: "T",
  blocks: [{ type: "row", label: "Meds (current)", value: "risperidone (0.5mg) \\ twice daily" }],
});
const tricky = trickyPdf.toString("latin1");
check("escaped and intact", tricky.includes("Meds \\(current\\)") && tricky.trimEnd().endsWith("%%EOF"));

section("A long screener runs to several pages");
const many = [];
for (let i = 0; i < 90; i++) {
  many.push({ type: "row", label: `Question number ${i} which is reasonably long`, value: `Answer ${i}` });
}
const bigText = buildPdf({ title: "Long", blocks: many }).toString("latin1");
const count = (bigText.match(/\/Count (\d+)/) || [])[1];
check("it paginates rather than running off the page", Number(count) > 1, count);
check("every page is numbered", bigText.includes("Page 1 of"), false);

section("Long words do not overrun the margin");
check("wrapping keeps lines within the column",
  wrapText("supercalifragilistic expialidocious antidisestablishmentarianism", 300, 10)
    .every((l) => l.length <= 61), wrapText("supercalifragilistic expialidocious antidisestablishmentarianism", 300, 10));

section("Nothing is served without a login");
const screener = fs.readFileSync(path.join(__dirname, "screener.js"), "utf8");
const route = screener.slice(screener.indexOf("const pdfMatch"), screener.indexOf("const pdfMatch") + 1200);
check("the PDF route checks authentication", /if \(!user\)/.test(route));
check("and checks permission", /canSendScreener\(user\)/.test(route));
check("it 404s when there is no submission rather than sending a blank",
  /has not completed their clinical screener/.test(route));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
