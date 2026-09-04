// Pre-authorization markers, and payer requirements the practice can change.
//
//   DATABASE_URL=... node server.js
//   DATABASE_URL=... BASE=http://127.0.0.1:3009 node test-bcba-requirements.js
//
// The overlay itself is unit-tested in test-bcba-cheatsheet-edits.js. This is
// about what only exists once there is a database and a permission model:
//
//   * WHO MAY CHANGE A PAYER REQUIREMENT. Editing one changes what every BCBA
//     is told to submit, and a mistake shows up as a denied claim. BCBAs read
//     it; owners and admins change it, enforced on the API rather than by
//     hiding a button.
//   * WHETHER THE MARKER SAYS WHERE IT CAME FROM. Three payers are answered by
//     the cheat sheet in words. Four are not, and are marked at the practice's
//     direction. Those two must not be presented identically -- when a claim is
//     denied over a pre-auth, "the document said so" and "we decided this" are
//     different conversations.
//   * WHETHER A REDEPLOY WIPES THE PRACTICE'S CORRECTIONS. The seed must never
//     overwrite a value somebody set, or every restart would quietly undo them.
"use strict";
const fs = require("fs");
const { Pool } = require("pg");

const BASE = process.env.BASE || "http://localhost:3009";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (d !== undefined ? "  -> " + JSON.stringify(d).slice(0, 300) : "")); }
};

function client() {
  let jar = "";
  return async (path, { method = "GET", body } = {}) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(jar ? { Cookie: jar } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) jar = sc.split(";")[0];
    let data = null;
    try { data = await res.json(); } catch (e) {}
    return { status: res.status, data };
  };
}

const textOf = (v) => (v && typeof v === "object" ? v.text : v);

(async () => {
  const owner = client(), bcba = client();
  check("owner signs in",
    (await owner("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);
  check("a BCBA signs in",
    (await bcba("/api/auth/login", { method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } })).status === 200);

  const sheet = async (who) => {
    const d = (await (who || owner)("/api/bcba/cheatsheet")).data;
    return Object.fromEntries((d.payers || []).map((p) => [p.key, p]));
  };

  console.log("\n== The pre-authorization marker ==");
  let by = await sheet();
  check("every payer carries one", Object.values(by).every((p) => p.preauth && p.preauth.required),
    Object.values(by).map((p) => [p.key, p.preauth && p.preauth.required]));
  for (const k of ["nv-medicaid", "caresource", "molina"]) {
    check(`${k} is marked as needing no pre-auth`, by[k].preauth.required === "not_required", by[k].preauth);
    check(`  and says the cheat sheet is where that comes from`, by[k].preauth.source === "document", by[k].preauth);
  }
  for (const k of ["aetna", "tricare", "anthem-bcbs", "silversummit"]) {
    check(`${k} is marked as needing a pre-auth`, by[k].preauth.required === "required", by[k].preauth);
    check(`  AND SAYS IT WAS SET AT SETUP, not quoted from the document`,
      by[k].preauth.source === "setup", by[k].preauth);
  }
  check("the quoted ones carry the sentence they came from",
    /97151/.test(by["molina"].preauth.note || ""), by["molina"].preauth.note);
  check("and the set ones say plainly that the document does not state it",
    /does not say this in words/i.test(by["aetna"].preauth.note || ""), by["aetna"].preauth.note);

  console.log("\n== Who may change any of it ==");
  const bcbaSheet = await sheet(bcba);
  check("A BCBA SEES THE MARKERS", !!bcbaSheet["aetna"].preauth.required);
  check("but is not offered the controls",
    (await bcba("/api/bcba/cheatsheet")).data.can_edit_requirements === false);
  check("and the API refuses them a pre-auth change",
    (await bcba("/api/bcba/payers/aetna/preauth", { method: "PUT", body: { required: "not_required" } })).status === 403);
  check("and refuses them a requirement change",
    (await bcba("/api/bcba/requirements", { method: "POST", body: {
      payer_key: "aetna", list_key: "required_documents", op: "add", text: "Sneaked in",
    } })).status === 403);
  check("NOTHING THEY TRIED TOOK EFFECT",
    (await sheet())["aetna"].preauth.required === "required" &&
    !(await sheet())["aetna"].required_documents.map(textOf).includes("Sneaked in"));

  console.log("\n== Changing the marker ==");
  const set = await owner("/api/bcba/payers/molina/preauth", {
    method: "PUT", body: { required: "required", note: "Molina told us this changed in July." },
  });
  check("an owner can change it", set.status === 200, set.data);
  by = await sheet();
  check("the marker moves", by["molina"].preauth.required === "required", by["molina"].preauth);
  check("the note goes with it", /July/.test(by["molina"].preauth.note || ""), by["molina"].preauth.note);
  check("AND IT IS NO LONGER PRESENTED AS THE DOCUMENT'S OWN STATEMENT",
    by["molina"].preauth.source === "edited", by["molina"].preauth);
  check("a value that is not one of the three is refused",
    (await owner("/api/bcba/payers/molina/preauth", { method: "PUT", body: { required: "maybe" } })).status === 400);
  check("and an unknown payer is refused",
    (await owner("/api/bcba/payers/not-a-payer/preauth", { method: "PUT", body: { required: "required" } })).status === 404);

  // The seed runs on every boot. If it overwrote, a redeploy would silently
  // undo the change just made above.
  const src = fs.readFileSync(require("path").join(__dirname, "bcba-hub.js"), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  check("THE SEED IS GUARDED so a redeploy cannot wipe that correction",
    /WHERE bcba_payer_meta\.preauth_required IS NULL/.test(src));

  console.log("\n== Correcting a requirement ==");
  const before = (await sheet())["aetna"].required_documents.map(textOf);
  const original = before[0];
  const edited = await owner("/api/bcba/requirements", { method: "POST", body: {
    payer_key: "aetna", list_key: "required_documents", op: "edit",
    original_text: original, text: "CHANGED: " + original,
  } });
  check("the change is accepted", edited.status === 200, edited.data);
  by = await sheet();
  const doc0 = by["aetna"].required_documents[0];
  check("the new wording is what a BCBA now reads", textOf(doc0) === "CHANGED: " + original, doc0);
  check("THE CHEAT SHEET'S OWN WORDING IS KEPT", doc0.original_text === original, doc0);
  check("the line is marked as changed, where it is read", doc0.edited === true, doc0);
  check("and says who changed it", /@/.test(doc0.edited_by || ""), doc0.edited_by);
  check("the list did not grow or shrink",
    by["aetna"].required_documents.length === before.length, by["aetna"].required_documents.length);

  console.log("\n== It reaches the BCBA, and no further ==");
  const asBcba = await sheet(bcba);
  check("a BCBA sees the corrected wording",
    textOf(asBcba["aetna"].required_documents[0]) === "CHANGED: " + original);
  check("AND NO OTHER PAYER WAS TOUCHED",
    !JSON.stringify(by["molina"].required_documents).includes("CHANGED:"), by["molina"].required_documents);

  console.log("\n== Refusing a change to a line that is not there ==");
  const stale = await owner("/api/bcba/requirements", { method: "POST", body: {
    payer_key: "aetna", list_key: "required_documents", op: "edit",
    original_text: "A line the cheat sheet has never contained", text: "x",
  } });
  check("it is refused rather than stored as an orphan", stale.status === 409, stale);
  check("and the message says what to do", /reload/i.test(stale.data.error || ""), stale.data);
  const badList = await owner("/api/bcba/requirements", { method: "POST", body: {
    payer_key: "aetna", list_key: "required_document", op: "add", text: "x",
  } });
  check("a misspelled list is refused", badList.status === 400, badList.data);
  const emptyText = await owner("/api/bcba/requirements", { method: "POST", body: {
    payer_key: "aetna", list_key: "required_documents", op: "add", text: "   ",
  } });
  check("an empty requirement is refused", emptyText.status === 400, emptyText.data);

  console.log("\n== Adding and removing ==");
  await owner("/api/bcba/requirements", { method: "POST", body: {
    payer_key: "tricare", list_key: "required_documents", op: "add", text: "New TRICARE attachment",
  } });
  by = await sheet();
  const addedRow = by["tricare"].required_documents.find((x) => textOf(x) === "New TRICARE attachment");
  check("an added requirement appears", !!addedRow, by["tricare"].required_documents.map(textOf));
  check("marked as an addition, not as the document's own text",
    !!addedRow && addedRow.added === true, addedRow);

  const toRemove = textOf(by["tricare"].required_documents[0]);
  await owner("/api/bcba/requirements", { method: "POST", body: {
    payer_key: "tricare", list_key: "required_documents", op: "remove", original_text: toRemove,
  } });
  by = await sheet();
  check("a removed requirement is gone",
    !by["tricare"].required_documents.map(textOf).includes(toRemove), by["tricare"].required_documents.map(textOf));
  check("and the addition is still there", by["tricare"].required_documents.some((x) => textOf(x) === "New TRICARE attachment"));

  console.log("\n== Putting it back ==");
  const list = (await owner("/api/bcba/requirements")).data.edits || [];
  check("every change is on file for review", list.length >= 3, list.length);
  const removal = list.find((e) => e.op === "remove" && e.payer_key === "tricare");
  const undo = await owner("/api/bcba/requirements/" + removal.id, { method: "DELETE" });
  check("a change can be reverted", undo.status === 200, undo.data);
  check("and it says what it went back to", undo.data.reverted_to === toRemove, undo.data);
  by = await sheet();
  check("THE CHEAT SHEET'S LINE IS BACK", by["tricare"].required_documents.map(textOf).includes(toRemove));
  const restored = by["tricare"].required_documents.find((x) => textOf(x) === toRemove);
  check("and carries no 'changed' mark, because it is the document's own line again",
    !restored.edited && !restored.added && !restored.original_text, restored);

  console.log("\n== Editing the same line twice ==");
  const twice = (await sheet())["aetna"].required_documents[0];
  await owner("/api/bcba/requirements", { method: "POST", body: {
    payer_key: "aetna", list_key: "required_documents", op: "edit",
    original_text: original, text: "CHANGED AGAIN: " + original,
  } });
  by = await sheet();
  check("the second change replaces the first rather than stacking",
    textOf(by["aetna"].required_documents[0]) === "CHANGED AGAIN: " + original,
    by["aetna"].required_documents[0]);
  check("AND THE ORIGINAL IS STILL THE DOCUMENT'S, not the first edit",
    by["aetna"].required_documents[0].original_text === original,
    by["aetna"].required_documents[0]);
  const rows = Number((await pool.query(
    "SELECT COUNT(*)::int AS n FROM bcba_cheatsheet_edits WHERE payer_key='aetna' AND list_key='required_documents' AND op='edit'"
  )).rows[0].n);
  check("one row on file for that line, not two", rows === 1, rows);
  void twice;

  console.log("\n== A change that changes nothing ==");
  const same = await owner("/api/bcba/requirements", { method: "POST", body: {
    payer_key: "silversummit", list_key: "assessment_units", op: "edit",
    original_text: textOf((await sheet())["silversummit"].assessment_units[0]),
    text: textOf((await sheet())["silversummit"].assessment_units[0]),
  } });
  check("is accepted but stored as nothing", same.status === 200 && same.data.unchanged === true, same.data);
  by = await sheet();
  check("SO THE LINE IS NOT MARKED AS EDITED when it still reads as written",
    typeof by["silversummit"].assessment_units[0] === "string", by["silversummit"].assessment_units[0]);

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
