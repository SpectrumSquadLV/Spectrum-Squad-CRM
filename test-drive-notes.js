// Importing a client's Google Drive folder into Programming.
//
//   DATABASE_URL=... node server.js
//   DATABASE_URL=... BASE=http://127.0.0.1:3009 node test-drive-notes.js
//
// The parser suite proves the archive is read correctly. This proves the things
// that only go wrong once a database and a permission model are involved:
//
//   * A FOLDER IS NEVER GUESSED AT. Initials matching two children, or none, is
//     the mistake that puts one child's notes on another child's record, and it
//     is the one a person reading the screen would not catch -- the notes look
//     entirely plausible under the wrong name.
//   * PREVIEW WRITES NOTHING, and apply does not trust the preview: it re-reads
//     the archive server-side, so the matching rules are enforced rather than
//     advisory.
//   * RE-IMPORTING UPDATES IN PLACE. A second run must not double every note.
//   * NOTHING ELSE IN THE CLIENT'S RECORD IS TOUCHED -- not client_notes, not
//     the plan.
//   * Reading a child's notes is gated on the API, not by hiding a panel.
//
// Every fixture is invented; see drive-notes-test-fixtures.js.
"use strict";
const { Pool } = require("pg");
const { makeZip, docx, xlsx } = require("./drive-notes-test-fixtures");

const BASE = process.env.BASE || "http://localhost:3009";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (d !== undefined ? "  -> " + JSON.stringify(d).slice(0, 400) : "")); }
};

function client() {
  let jar = "";
  return async (path, { method = "GET", body, raw } = {}) => {
    const headers = { ...(jar ? { Cookie: jar } : {}) };
    if (raw) headers["Content-Type"] = "application/zip";
    else if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(BASE + path, {
      method, headers, body: raw ? raw : body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) jar = sc.split(";")[0];
    let data = null;
    try { data = await res.json(); } catch (e) {}
    return { status: res.status, data };
  };
}

const countNotes = async (clientId) =>
  Number((await pool.query("SELECT COUNT(*)::int AS n FROM client_drive_notes WHERE client_id = $1", [clientId])).rows[0].n);

(async () => {
  const owner = client(), staff = client(), intake = client();
  let r = await owner("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
  check("owner signs in", r.status === 200, r.data);
  check("a clinical user signs in",
    (await staff("/api/auth/login", { method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } })).status === 200);
  check("a billing user signs in",
    (await intake("/api/auth/login", { method: "POST", body: { email: "billing@spectrumsquadlv.com", password: "TestStaff123!" } })).status === 200);

  // Two children whose initials do not collide, and two who do -- built here so
  // the ambiguous case is a real pair of rows rather than a mocked answer.
  const names = ["Alejandro Quiroz", "Jaxon Barlew", "Sofia Mendez", "Sasha Mendoza"];
  const ids = {};
  for (const n of names) {
    const existing = (await pool.query("SELECT id FROM clients WHERE child_name = $1", [n])).rows[0];
    ids[n] = existing ? existing.id
      : (await pool.query("INSERT INTO clients (child_name, stage, submitted_at) VALUES ($1,'active',now()::text) RETURNING id", [n])).rows[0].id;
  }
  // SoMe and SoMe: Sofia Mendez and Sasha Mendoza both reduce to "some"? They
  // do not -- SoMe and SaMe. The genuine collision is built explicitly.
  const twinA = (await pool.query(
    "INSERT INTO clients (child_name, stage, submitted_at) VALUES ('Dana Estrada','active',now()::text) RETURNING id")).rows[0].id;
  const twinB = (await pool.query(
    "INSERT INTO clients (child_name, stage, submitted_at) VALUES ('Daniel Escobar','active',now()::text) RETURNING id")).rows[0].id;

  const supSheet = xlsx({
    "Supervision Notes": [
      ["Date", "Supervisor", "Minutes", "Note"],
      ["2026-05-04", "A. Analyst", 45, "Reviewed pairing procedure"],
    ],
  });
  const archive = makeZip({
    "Clients/AlQu/toilet toleration.docx": docx(["Sat for 4 minutes on 3 May."]),
    "Clients/AlQu/AlQu Supervision Notes.xlsx": supSheet,
    "Clients/AlQu/token board.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    "Clients/JaBa/Materials.docx": docx(["Two more token boards"]),
    "Clients/DaEs/BIP.docx": docx(["A plan for a child whose initials are ambiguous"]),
    "Clients/ZzZz/orphan.docx": docx(["Belongs to nobody in the CRM"]),
  });

  console.log("\n== Who may do this ==");
  const staffPreview = await staff("/api/drive-notes/import/preview", { method: "POST", raw: archive });
  check("A CLINICAL USER CANNOT IMPORT, even though they can read notes",
    staffPreview.status === 403, staffPreview);
  const staffReview = await staff("/api/drive-notes/review");
  check("nor read the whole-caseload review list", staffReview.status === 403, staffReview);

  console.log("\n== Preview writes nothing ==");
  const before = await countNotes(ids["Alejandro Quiroz"]);
  const preview = await owner("/api/drive-notes/import/preview", { method: "POST", raw: archive });
  check("the preview succeeds", preview.status === 200, preview.data && preview.data.error);
  check("NOT ONE ROW WAS WRITTEN by previewing",
    (await countNotes(ids["Alejandro Quiroz"])) === before, { before, after: await countNotes(ids["Alejandro Quiroz"]) });

  const p = preview.data;
  const byInitials = Object.fromEntries((p.folders || []).map((f) => [f.initials, f]));
  check("every client folder is reported", Object.keys(byInitials).sort().join(",") === "AlQu,DaEs,JaBa,ZzZz",
    Object.keys(byInitials));
  check("an unambiguous folder is matched to the right child",
    byInitials.AlQu.matched === true && byInitials.AlQu.client_id === ids["Alejandro Quiroz"], byInitials.AlQu);
  check("A FOLDER MATCHING TWO CHILDREN IS REFUSED, not picked between",
    byInitials.DaEs.matched === false && /more than one/i.test(byInitials.DaEs.reason), byInitials.DaEs);
  check("and both children are named so a person can choose",
    byInitials.DaEs.candidates.length === 2, byInitials.DaEs.candidates);
  check("a folder matching nobody is refused too",
    byInitials.ZzZz.matched === false && /no client/i.test(byInitials.ZzZz.reason), byInitials.ZzZz);
  check("the image is listed as a file with no text",
    byInitials.AlQu.files.some((f) => f.filename === "token board.png" && f.readable === false), byInitials.AlQu.files);

  check("THE PREVIEW DOES NOT SHIP THE CLINICAL TEXT -- the decision is which child, not what it says",
    byInitials.AlQu.files.every((f) => !("text" in f)), byInitials.AlQu.files[0]);
  check("but it says how much text there is, which is what tells you it read the file",
    byInitials.AlQu.files.some((f) => f.characters > 0), byInitials.AlQu.files.map((f) => f.characters));

  console.log("\n== Importing ==");
  const applied = await owner("/api/drive-notes/import/apply", { method: "POST", raw: archive });
  check("the import succeeds", applied.status === 200, applied.data);
  check("it reports what it wrote", applied.data.inserted === 6, applied.data);

  const alquNotes = await owner("/api/drive-notes/client/" + ids["Alejandro Quiroz"]);
  check("the matched client has their files", alquNotes.data.rows.length === 3, alquNotes.data.rows.map((x) => x.filename));
  const toilet = alquNotes.data.rows.find((x) => x.filename === "toilet toleration.docx");
  check("THE ACTUAL TEXT CAME THROUGH", /Sat for 4 minutes/.test(toilet.body), toilet && toilet.body);
  check("it is classified as a note, not as a plan", toilet.kind === "note", toilet.kind);
  const sheet = alquNotes.data.rows.find((x) => /Supervision/.test(x.filename));
  check("a spreadsheet's words came through, not its shared-string indices",
    /Reviewed pairing procedure/.test(sheet.body), sheet && sheet.body.slice(0, 120));
  check("and it is classified as supervision", sheet.kind === "supervision", sheet.kind);
  check("the snapshot is dated, because it does not update itself",
    !!alquNotes.data.imported_at, alquNotes.data);

  console.log("\n== Nothing else on the record was touched ==");
  const otherTables = await pool.query(
    "SELECT (SELECT COUNT(*) FROM client_notes WHERE client_id = $1) AS notes, (SELECT COUNT(*) FROM client_tasks WHERE client_id = $1) AS tasks",
    [ids["Alejandro Quiroz"]]
  );
  check("no client_notes row was created by the import",
    Number(otherTables.rows[0].notes) === 0, otherTables.rows[0]);
  const clientRow = (await pool.query("SELECT * FROM clients WHERE id = $1", [ids["Alejandro Quiroz"]])).rows[0];
  check("and the client record itself is unchanged",
    clientRow.child_name === "Alejandro Quiroz" && clientRow.stage === "active", clientRow.stage);

  console.log("\n== The ambiguous and orphan folders ==");
  check("neither ambiguous child got the file",
    (await countNotes(twinA)) === 0 && (await countNotes(twinB)) === 0, { twinA, twinB });
  const review = await owner("/api/drive-notes/review");
  const folders = (review.data.rows || []).map((x) => x.source_folder).sort();
  check("both are waiting on the review list", folders.join(",") === "DaEs,ZzZz", folders);
  check("THE FILES WERE NOT THROWN AWAY while they wait",
    Number((await pool.query("SELECT COUNT(*)::int AS n FROM client_drive_notes WHERE client_id IS NULL")).rows[0].n) === 2);
  check("the review list says why each one is stuck",
    (review.data.rows || []).every((x) => !!x.unmatched_reason), review.data.rows);
  check("and offers the client list to choose from", (review.data.clients || []).length > 0);

  console.log("\n== Filing one by hand ==");
  const noChoice = await owner("/api/drive-notes/review/DaEs/assign", { method: "POST", body: {} });
  check("assigning with no client chosen is refused", noChoice.status === 400, noChoice);
  const assigned = await owner("/api/drive-notes/review/DaEs/assign", { method: "POST", body: { client_id: twinA } });
  check("a person can file it under the child they know it is", assigned.status === 200 && assigned.data.moved === 1, assigned.data);
  check("and it appears on that child's record", (await countNotes(twinA)) === 1);
  check("and NOT on the other child with the same initials", (await countNotes(twinB)) === 0);
  const afterAssign = (await owner("/api/drive-notes/review")).data.rows.map((x) => x.source_folder);
  check("it leaves the review list", !afterAssign.includes("DaEs"), afterAssign);

  console.log("\n== Importing the same archive again ==");
  const second = await owner("/api/drive-notes/import/apply", { method: "POST", raw: archive });
  check("a second run succeeds", second.status === 200, second.data);
  check("IT UPDATES RATHER THAN DUPLICATING", second.data.inserted === 0 && second.data.updated === 6, second.data);
  check("the matched client still has exactly three files",
    (await countNotes(ids["Alejandro Quiroz"])) === 3, await countNotes(ids["Alejandro Quiroz"]));
  check("and the folder filed by hand was not dragged back to unmatched",
    (await countNotes(twinA)) === 1, await countNotes(twinA));
  check("nor filed a SECOND, unmatched copy of it",
    Number((await pool.query("SELECT COUNT(*)::int AS n FROM client_drive_notes WHERE source_folder = 'DaEs' AND client_id IS NULL")).rows[0].n) === 0);
  const stillWaiting = (await owner("/api/drive-notes/review")).data.rows.map((x) => x.source_folder);
  check("THE HUMAN DECISION STICKS -- the folder does not come back to the review list",
    !stillWaiting.includes("DaEs"), stillWaiting);
  const replan = (await owner("/api/drive-notes/import/preview", { method: "POST", raw: archive })).data.folders
    .find((f) => f.initials === "DaEs");
  check("and the preview says the match came from that earlier decision, not the matcher",
    replan.matched === true && replan.decided_earlier === true && replan.client_id === twinA, replan);

  console.log("\n== A changed document ==");
  const changed = makeZip({
    "Clients/AlQu/toilet toleration.docx": docx(["Sat for 11 minutes on 20 June."]),
  });
  await owner("/api/drive-notes/import/apply", { method: "POST", raw: changed });
  const reread = await owner("/api/drive-notes/client/" + ids["Alejandro Quiroz"]);
  const updated = reread.data.rows.find((x) => x.filename === "toilet toleration.docx");
  check("re-importing brings the newer text through", /11 minutes/.test(updated.body), updated.body);
  check("and does not leave the old copy beside it",
    reread.data.rows.filter((x) => x.filename === "toilet toleration.docx").length === 1,
    reread.data.rows.map((x) => x.filename));
  check("the other files were left alone by a partial archive",
    reread.data.rows.length === 3, reread.data.rows.map((x) => x.filename));

  console.log("\n== Reading is gated on the API ==");
  const staffRead = await staff("/api/drive-notes/client/" + ids["Alejandro Quiroz"]);
  check("a clinical user CAN read a client's notes", staffRead.status === 200, staffRead.status);
  const billingRead = await intake("/api/drive-notes/client/" + ids["Alejandro Quiroz"]);
  check("and so can billing, who has client access", billingRead.status === 200, billingRead.status);
  const anon = client();
  const anonRead = await anon("/api/drive-notes/client/" + ids["Alejandro Quiroz"]);
  check("A SIGNED-OUT CALLER GETS NOTHING", anonRead.status === 401 || anonRead.status === 403, anonRead.status);

  console.log("\n== Rubbish in ==");
  const notZip = await owner("/api/drive-notes/import/preview", { method: "POST", raw: Buffer.from("this is not a zip") });
  check("something that is not a zip is refused with an explanation",
    notZip.status === 400 && /not a zip/i.test(notZip.data.error || ""), notZip.data);
  const empty = await owner("/api/drive-notes/import/preview", { method: "POST", raw: Buffer.alloc(0) });
  check("an empty upload is refused", empty.status === 400, empty.data);
  const noFolders = await owner("/api/drive-notes/import/preview", { method: "POST", raw: makeZip({ "loose.docx": docx(["nope"]) }) });
  check("an archive with no client folders says so rather than importing nothing quietly",
    noFolders.status === 400 && /client folders/i.test(noFolders.data.error || ""), noFolders.data);

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
