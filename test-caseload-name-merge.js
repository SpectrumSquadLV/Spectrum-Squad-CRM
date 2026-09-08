// One person filed under two spellings.
//
//   DATABASE_URL=... node server.js
//   DATABASE_URL=... BASE=http://127.0.0.1:3009 node test-caseload-name-merge.js
//
// The BCBA, Student Analyst and Squad Leader on a client are FREE TEXT, typed
// by whoever filed the record. So the same person arrives as "Marissa" on some
// clients and "Marissa Gaut" on others, and the caseload list -- which groups
// by that string -- shows her twice with her clients split between the halves.
// That is how it was reported.
//
// THE FAILURE THAT MATTERS HERE IS THE OPPOSITE ONE. Merging two people who
// merely share a first name moves one clinician's whole caseload onto another
// clinician's name, silently, and the screen afterwards looks entirely normal.
// So most of this suite is about what the tool REFUSES to offer.
"use strict";
const { Pool } = require("pg");

const BASE = process.env.BASE || "http://localhost:3009";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (d !== undefined ? "  -> " + JSON.stringify(d).slice(0, 320) : "")); }
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

// Invented staff and children, in the shape the real records have: a name typed
// two ways, sometimes with an email and sometimes without.
async function addClient(name, bcba, email) {
  return (await pool.query(
    `INSERT INTO clients (child_name, stage, submitted_at, assigned_bcba_name, assigned_bcba_email)
     VALUES ($1,'active',now()::text,$2,$3) RETURNING id`,
    [name, bcba, email || null]
  )).rows[0].id;
}
const countBy = async (name) => Number((await pool.query(
  "SELECT COUNT(*)::int AS n FROM clients WHERE TRIM(assigned_bcba_name) = $1", [name])).rows[0].n);

(async () => {
  const owner = client(), bcba = client();
  check("owner signs in",
    (await owner("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);
  check("a BCBA signs in",
    (await bcba("/api/auth/login", { method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } })).status === 200);

  // The reported case: one person, two spellings, only one half carrying an
  // email -- which is also why the picker used to split her in two.
  await addClient("Zz Child One", "Marissa Gaut", "marissa@example.test");
  await addClient("Zz Child Two", "Marissa Gaut", "marissa@example.test");
  await addClient("Zz Child Three", "Marissa", null);
  // Two different people who happen to share a first name. This pair must
  // never be offered as a merge.
  await addClient("Zz Child Four", "Chris Adams", null);
  await addClient("Zz Child Five", "Chris Taylor", null);
  await addClient("Zz Child Six", "Chris", null);
  // Differing only by spacing and capitalisation.
  await addClient("Zz Child Seven", "dora  ", null);
  await addClient("Zz Child Eight", "Dora", null);

  console.log("\n== The caseload list shows one row per person ==");
  const list = (await owner("/api/caseload/bcbas")).data.bcbas || [];
  const marissas = list.filter((b) => /marissa/i.test(b.name));
  check("MARISSA IS NOT SPLIT ACROSS HER BLANK-EMAIL RECORDS",
    marissas.every((m) => list.filter((x) => x.name === m.name).length === 1), marissas);
  const gaut = list.find((b) => b.name === "Marissa Gaut");
  check("her email is reported even though only some of her clients carry one",
    !!gaut && gaut.email === "marissa@example.test", gaut);
  check("and the count is the clients under that spelling", !!gaut && gaut.clients === 2, gaut);

  console.log("\n== What it offers to merge ==");
  const dupes = (await owner("/api/caseload/name-duplicates")).data.duplicates || [];
  const marissa = dupes.find((d) => d.from === "Marissa" && d.to === "Marissa Gaut");
  check("THE REPORTED CASE IS FOUND", !!marissa, dupes.map((d) => [d.from, d.to]));
  check("and it is offered with confidence", !!marissa && marissa.confident === true, marissa);
  check("naming the field it is on", !!marissa && marissa.field === "assigned_bcba_name", marissa);
  check("with both caseload sizes, so you can see what moves where",
    !!marissa && marissa.from_clients === 1 && marissa.to_clients === 2, marissa);

  const dora = dupes.find((d) => /dora/i.test(d.from) && /dora/i.test(d.to));
  check("a name differing only in spacing or case is found too", !!dora, dupes.map((d) => [d.from, d.to]));

  console.log("\n== What it refuses ==");
  const chris = dupes.find((d) => d.from === "Chris");
  check("A FIRST NAME MATCHING TWO PEOPLE IS NOT OFFERED AS A MERGE",
    !!chris && chris.to === null && chris.confident === false, chris);
  check("and both candidates are named so a person can decide",
    !!chris && (chris.candidates || []).length === 2, chris && chris.candidates);
  check("CHRIS ADAMS AND CHRIS TAYLOR ARE NEVER PAIRED WITH EACH OTHER",
    !dupes.some((d) => /Chris (Adams|Taylor)/.test(d.from) && /Chris (Adams|Taylor)/.test(d.to || "")),
    dupes.filter((d) => /Chris/.test(d.from)).map((d) => [d.from, d.to]));

  console.log("\n== Who may do it ==");
  check("a BCBA cannot see the duplicate list",
    (await bcba("/api/caseload/name-duplicates")).status === 403);
  const refused = await bcba("/api/caseload/merge-name", {
    method: "POST", body: { field: "assigned_bcba_name", from: "Marissa", to: "Marissa Gaut" },
  });
  check("nor merge anything", refused.status === 403, refused);
  check("AND NOTHING THEY TRIED TOOK EFFECT", (await countBy("Marissa")) === 1);

  console.log("\n== Merging ==");
  const merged = await owner("/api/caseload/merge-name", {
    method: "POST", body: { field: "assigned_bcba_name", from: "Marissa", to: "Marissa Gaut" },
  });
  check("the merge succeeds", merged.status === 200, merged.data);
  check("it says how many clients moved", merged.data.moved === 1, merged.data);
  check("and how many are now on that name", merged.data.now_on === 3, merged.data);
  check("NOBODY IS LEFT UNDER THE OLD SPELLING", (await countBy("Marissa")) === 0);
  check("and her clients are all on the one name", (await countBy("Marissa Gaut")) === 3);
  check("THE EMAIL WAS CARRIED ACROSS, so matching by email finds them too",
    merged.data.email_applied === "marissa@example.test", merged.data);
  const stillBlank = Number((await pool.query(
    `SELECT COUNT(*)::int AS n FROM clients WHERE TRIM(assigned_bcba_name) = 'Marissa Gaut'
       AND (assigned_bcba_email IS NULL OR TRIM(assigned_bcba_email) = '')`)).rows[0].n);
  check("no client of hers is left without it", stillBlank === 0, stillBlank);

  console.log("\n== The list afterwards ==");
  const after = (await owner("/api/caseload/bcbas")).data.bcbas || [];
  check("SHE APPEARS ONCE", after.filter((b) => /marissa/i.test(b.name)).length === 1,
    after.filter((b) => /marissa/i.test(b.name)));
  check("with the whole caseload on that one row",
    (after.find((b) => b.name === "Marissa Gaut") || {}).clients === 3,
    after.find((b) => /marissa/i.test(b.name)));
  const dupes2 = (await owner("/api/caseload/name-duplicates")).data.duplicates || [];
  check("and she is off the duplicate list", !dupes2.some((d) => d.from === "Marissa"), dupes2.map((d) => d.from));
  check("while Chris is still there, unresolved, as he should be",
    dupes2.some((d) => d.from === "Chris" && d.to === null), dupes2.map((d) => [d.from, d.to]));

  console.log("\n== Rubbish in ==");
  const badField = await owner("/api/caseload/merge-name", {
    method: "POST", body: { field: "child_name", from: "a", to: "b" },
  });
  check("A FIELD THAT IS NOT ON THE ALLOWLIST IS REFUSED -- it lands in an UPDATE",
    badField.status === 400, badField.data);
  check("nothing was renamed by that attempt",
    Number((await pool.query("SELECT COUNT(*)::int AS n FROM clients WHERE child_name = 'b'")).rows[0].n) === 0);
  const missing = await owner("/api/caseload/merge-name", {
    method: "POST", body: { field: "assigned_bcba_name", from: "Nobody At All", to: "Marissa Gaut" },
  });
  check("merging from a name nobody is filed under is refused", missing.status === 404, missing.data);
  const same = await owner("/api/caseload/merge-name", {
    method: "POST", body: { field: "assigned_bcba_name", from: "Marissa Gaut", to: "Marissa Gaut" },
  });
  check("merging a name into itself is refused", same.status === 400, same.data);

  // =========================================================================
  console.log("\n== The shapes the matcher does NOT recognise ==");
  // Reported straight from the practice: two Marissas on the caseload board,
  // and this panel answering "nothing looks duplicated".
  //
  // It only ever recognised a name that is another one SHORTENED ("Marissa"
  // inside "Marissa Gaut") or the same name spaced differently. A surname typed
  // two ways, a middle initial, an initialled surname or a slip in the spelling
  // all read as two separate people -- and the panel then said so, which is
  // worse than saying nothing to somebody looking straight at the duplicate.
  //
  // These stay UNMATCHED on purpose: guessing that "Marissa Gaut" and "Marissa
  // Gauthier" are one person would, when they are not, move an entire caseload
  // onto the wrong clinician. What is checked here is that the tool STOPS
  // BEING A DEAD END -- it raises the pair and shows what is on file.
  await addClient("Roster Child A", "Nadia Okonkwo", "nadia@example.invalid");
  await addClient("Roster Child B", "Nadia Okonkow", "nadia@example.invalid");
  await addClient("Roster Child C", "Nadia A Okonkwo", null);

  const d3 = (await owner("/api/caseload/name-duplicates")).data;
  const bcbaRoster = (d3.rosters || []).find((r) => r.field === "assigned_bcba_name");
  check("THE PANEL NOW REPORTS EVERY NAME ON FILE, matched or not", !!bcbaRoster, (d3.rosters || []).map((r) => r.field));
  const rosterNames = (bcbaRoster.names || []).map((n) => n.name);
  check("including the surname typed two ways", rosterNames.includes("Nadia Okonkwo") && rosterNames.includes("Nadia Okonkow"), rosterNames);
  check("and the one with a middle initial", rosterNames.includes("Nadia A Okonkwo"), rosterNames);
  check("each carrying its caseload count, which is what makes the split visible",
    (bcbaRoster.names || []).every((n) => typeof n.clients === "number" && n.clients > 0),
    bcbaRoster.names);

  const nadia = (d3.duplicates || []).filter((x) => (x.candidates || []).some((c) => /^Nadia/.test(c)));
  check("A GROUP SHARING A FIRST NAME IS RAISED rather than passed over in silence",
    nadia.length === 1, d3.duplicates);
  check("but NEVER as a merge -- two people can share a first name",
    nadia.length === 1 && nadia[0].confident === false && nadia[0].to === null, nadia[0]);
  check("it names all three so a person can see what they are choosing between",
    nadia.length === 1 && (nadia[0].group || []).length === 3, nadia[0] && nadia[0].group);

  console.log("\n== The manual merge is the escape hatch, and it is still guarded ==");
  // The same endpoint the automatic suggestions use, so every rule already
  // proved above still applies to it -- it is only the CHOICE that moves to a
  // person. Worth stating: this is why the manual path needed no new endpoint,
  // and why it cannot be used to reach a field that is not on the allowlist.
  const manual = await owner("/api/caseload/merge-name", {
    method: "POST", body: { field: "assigned_bcba_name", from: "Nadia Okonkow", to: "Nadia Okonkwo" },
  });
  check("an admin can merge a pair the matcher would not touch", manual.status === 200, manual.data);
  check("and the clients move", (await countBy("Nadia Okonkwo")) === 2, await countBy("Nadia Okonkwo"));
  check("leaving nobody behind on the old spelling", (await countBy("Nadia Okonkow")) === 0);
  const stillThere = (await owner("/api/caseload/name-duplicates")).data;
  check("the middle-initial one is untouched, because nobody said to merge it",
    ((stillThere.rosters || []).find((r) => r.field === "assigned_bcba_name").names || [])
      .some((n) => n.name === "Nadia A Okonkwo"));

  const asBcba = await bcba("/api/caseload/merge-name", {
    method: "POST", body: { field: "assigned_bcba_name", from: "Nadia A Okonkwo", to: "Nadia Okonkwo" },
  });
  check("A BCBA CANNOT DRIVE THE MANUAL MERGE EITHER -- refused on the route", asBcba.status === 403, asBcba.status);
  check("and nothing moved on that attempt", (await countBy("Nadia A Okonkwo")) === 1);
  check("a BCBA cannot even read the roster of names", (await bcba("/api/caseload/name-duplicates")).status === 403);

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
