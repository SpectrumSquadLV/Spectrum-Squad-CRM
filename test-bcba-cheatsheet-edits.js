// The payer-requirement overlay.
//
//   node test-bcba-cheatsheet-edits.js
//
// The converted cheat sheet is never modified; changes are stored on top of it
// and applied on the way out. What is worth testing is not that an edit shows
// up -- it is the four ways an overlay quietly corrupts a payer's requirements:
//
//   * APPLYING A STALE EDIT TO THE WRONG LINE. If edits were keyed by position,
//     reconverting the document would attach last year's correction to whatever
//     now sits at index 3. Keyed by the hash of the replaced text, it attaches
//     to nothing and is reported.
//   * LOSING THE ORIGINAL. A correction that overwrites the document's own
//     wording cannot be undone without a database restore.
//   * BLEEDING BETWEEN PAYERS. An edit to Aetna appearing on Molina is exactly
//     the failure the whole Hub is built to avoid, and it looks entirely
//     plausible on screen.
//   * STACKING. Two edits of one line, applied in whichever order the rows come
//     back, means the requirement depends on the query plan.
"use strict";
const { itemHash, applyEdits, listExists, findByHash, normalize } = require("./bcba-cheatsheet-edits");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : "")); }
};

// Shaped like the real converted data -- top-level string lists, sections whose
// items are objects, hot buttons nested inside an object -- with invented text.
const payer = () => ({
  key: "testpayer",
  name: "Test Payer",
  assessment_authorization: ["Auth is not required for 97151", "Vineland"],
  assessment_units: ["16 Units / 4 hours"],
  required_documents: ["Form TP-1", "IEP if applicable"],
  hot_buttons: { title: "Hot Buttons", lead: "Reviewers look for:", points: ["Objective baselines", "Parent training"] },
  sections: [
    { key: "plan", title: "Components Required in Treatment Plan", group: "plan", items: [
      { text: "DSM-5 Autism diagnosis", depth: 0, kind: "item", reauth_only: false },
      { text: "Each behavior should include:", depth: 0, kind: "lead", reauth_only: false },
      { text: "Operational definition", depth: 1, kind: "item", reauth_only: false },
    ] },
  ],
});
const other = () => ({ ...payer(), key: "otherpayer", name: "Other Payer" });

const edit = (o) => ({ id: 1, payer_key: "testpayer", updated_by: "someone@test", updated_at: "2026-09-04", ...o });

console.log("\n== Nothing on file changes nothing ==");
const untouched = applyEdits(payer(), []);
check("with no edits the payer comes back as it was",
  JSON.stringify(untouched.payer) === JSON.stringify(payer()));
check("and nothing is reported orphaned", untouched.orphaned.length === 0);

console.log("\n== Correcting a line ==");
const changed = applyEdits(payer(), [edit({
  list_key: "required_documents", op: "edit",
  original_hash: itemHash("Form TP-1"), original_text: "Form TP-1",
  text: "Form TP-1a (replaced June 2026)",
})]);
const docs = changed.payer.required_documents;
check("the new wording is what shows", docs[0].text === "Form TP-1a (replaced June 2026)", docs);
check("THE ORIGINAL IS KEPT, so it can be put back", docs[0].original_text === "Form TP-1", docs[0]);
check("and the line is marked as changed", docs[0].edited === true, docs[0]);
check("with who changed it", docs[0].edited_by === "someone@test", docs[0]);
check("A LINE NOBODY TOUCHED IS STILL A PLAIN STRING, exactly as converted",
  docs[1] === "IEP if applicable", docs[1]);
check("the other lists are untouched",
  JSON.stringify(changed.payer.assessment_units) === JSON.stringify(["16 Units / 4 hours"]));

console.log("\n== Removing a line ==");
const removed = applyEdits(payer(), [edit({
  list_key: "assessment_authorization", op: "remove",
  original_hash: itemHash("Vineland"), original_text: "Vineland",
})]);
check("the line is gone", removed.payer.assessment_authorization.length === 1, removed.payer.assessment_authorization);
check("and the one beside it survives",
  removed.payer.assessment_authorization[0] === "Auth is not required for 97151");

console.log("\n== Adding one ==");
const added = applyEdits(payer(), [edit({ id: 7, list_key: "required_documents", op: "add", text: "Prior auth number" })]);
check("it appears at the end of that list", added.payer.required_documents.length === 3, added.payer.required_documents);
check("marked as an addition rather than as the document's own text",
  added.payer.required_documents[2].added === true, added.payer.required_documents[2]);
check("and it carries its edit id, so it can be taken back off",
  added.payer.required_documents[2].edit_id === 7);

console.log("\n== Inside a treatment plan section ==");
const inSection = applyEdits(payer(), [edit({
  list_key: "section:plan", op: "edit",
  original_hash: itemHash("Operational definition"), original_text: "Operational definition",
  text: "Operational definition, observable and measurable",
})]);
const items = inSection.payer.sections[0].items;
check("the section item is rewritten", /observable and measurable/.test(items[2].text), items[2]);
check("ITS DEPTH AND KIND SURVIVE -- an edit must not flatten the outline",
  items[2].depth === 1 && items[2].kind === "item", items[2]);
check("the lead-in line beside it is untouched",
  items[1].kind === "lead" && items[1].text === "Each behavior should include:", items[1]);

console.log("\n== Inside the hot buttons ==");
const hb = applyEdits(payer(), [edit({
  list_key: "hot_buttons_points", op: "edit",
  original_hash: itemHash("Parent training"), original_text: "Parent training",
  text: "Parent training, with attendance recorded",
})]);
check("a hot button can be corrected too",
  hb.payer.hot_buttons.points[1].text === "Parent training, with attendance recorded", hb.payer.hot_buttons.points);
check("and the wrapper keeps its title and lead",
  hb.payer.hot_buttons.title === "Hot Buttons" && /Reviewers look for/.test(hb.payer.hot_buttons.lead));

console.log("\n== An edit cannot reach another payer ==");
const cross = applyEdits(other(), [edit({
  list_key: "required_documents", op: "remove",
  original_hash: itemHash("Form TP-1"), original_text: "Form TP-1",
})]);
check("AN EDIT FILED AGAINST ONE PAYER DOES NOT TOUCH ANOTHER WITH THE SAME TEXT",
  JSON.stringify(cross.payer.required_documents) === JSON.stringify(["Form TP-1", "IEP if applicable"]),
  cross.payer.required_documents);
check("and it is not reported as an orphan of the payer it does not belong to",
  cross.orphaned.length === 0, cross.orphaned);

console.log("\n== When the document is reconverted underneath an edit ==");
const moved = payer();
moved.required_documents = ["Form TP-2", "IEP if applicable"];   // the line it edited is gone
const stale = applyEdits(moved, [edit({
  list_key: "required_documents", op: "edit",
  original_hash: itemHash("Form TP-1"), original_text: "Form TP-1", text: "Form TP-1a",
})]);
check("THE STALE EDIT IS NOT APPLIED TO WHATEVER TOOK THAT POSITION",
  stale.payer.required_documents[0] === "Form TP-2", stale.payer.required_documents);
check("it is reported as orphaned rather than dropped in silence",
  stale.orphaned.length === 1 && stale.orphaned[0].id === 1, stale.orphaned);
check("and the report says what it was going to change",
  stale.orphaned[0].original_text === "Form TP-1" && stale.orphaned[0].text === "Form TP-1a", stale.orphaned[0]);

console.log("\n== Addressing a line ==");
const p = payer();
check("a list that exists is accepted", listExists(p, "required_documents") === true);
check("a section is addressable by its key", listExists(p, "section:plan") === true);
check("the hot buttons are addressable", listExists(p, "hot_buttons_points") === true);
check("A MISSPELLED LIST IS REFUSED rather than becoming an orphan later",
  listExists(p, "required_document") === false);
check("and so is a section this payer does not have", listExists(p, "section:nope") === false);
check("a line can be found by its hash", findByHash(p, "required_documents", itemHash("Form TP-1")) === "Form TP-1");
check("a hash matching nothing returns null, not the first line",
  findByHash(p, "required_documents", itemHash("Nothing like this")) === null);

console.log("\n== Hashing ==");
check("whitespace does not change a line's identity",
  itemHash("Form  TP-1 ") === itemHash("Form TP-1"));
check("BUT WORDING DOES -- two requirements differing by a word are two requirements",
  itemHash("Form TP-1") !== itemHash("Form TP-2"));
check("normalize collapses runs of whitespace and trims",
  normalize("  a   b \n c ") === "a b c", normalize("  a   b \n c "));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
