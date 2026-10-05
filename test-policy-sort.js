// Sorting an existing library into policies and SOPs.
//
// The two-library split set every record already in the database to 'policy',
// because that is what the column had always implicitly meant. For a library
// built before the split that leaves SOPs filed as policies -- which is the
// undifferentiated list the split existed to end.
//
// What matters about the fix is that it is a PROPOSAL. So the assertions are
// mostly about restraint:
//
//   * the proposal writes nothing
//   * a record nobody ticked keeps the kind it has
//   * a kind the server does not recognise is refused, NOT defaulted -- the
//     existing normalizeKind falls back to "policy", and using it here would
//     flip an SOP the wrong way on a typo
//   * every verdict carries its reason, because a reclassification nobody can
//     check has to be either trusted blindly or redone by hand
//
// And one classification rule gets its own attention: THE LAST NOUN IN THE
// TITLE WINS. "Policy Change Request and Review SOP" contains both words and
// is an SOP. A keyword count gets that exactly backwards.
//
//   DATABASE_URL=... PORT=3011 node server.js
//   BASE=http://127.0.0.1:3011 node test-policy-sort.js
const { Pool } = require("pg");
const { classify } = require("./policy-kind");

const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const stamp = Date.now().toString(36);

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 320) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

function client() {
  let cookie = "";
  return async (p, { method = "GET", body } = {}) => {
    const r = await fetch(BASE + p, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  };
}

(async () => {
  // ==================================================================
  section("The classifier, in isolation");
  const k = (title, category, body) => {
    const v = classify({ title, category, body: body || "" });
    return v ? v.kind : null;
  };
  check("THE LAST NOUN WINS: 'Policy Change Request and Review SOP' is an SOP",
    k("Policy Change Request and Review SOP", "Administrative SOPs") === "sop");
  check("and 'SOP Compliance Policy' is a policy, by the same rule",
    k("SOP Compliance Policy", "Other") === "policy",
    classify({ title: "SOP Compliance Policy", category: "Other", body: "" }));
  check("a category that says SOP decides it when the title does not",
    k("Session Note Submission", "Clinical SOPs") === "sop");
  check("a plain policy stays a policy", k("Attendance Policy", "Attendance & Timekeeping") === "policy");
  check("'Procedure' at the end reads as an SOP", k("Intake & Referral Procedure", "Clinical") === "sop");
  check("'how to' in the title reads as an SOP", k("How to Run a Fidelity Check", "Other") === "sop");
  check("numbered steps in the body read as an SOP",
    k("Evacuating the Henderson Clinic", "Other", "1. Sound the alarm.\n2. Clear the therapy rooms.\n3. Meet at the far kerb.") === "sop");
  check("A TITLE AND CATEGORY THAT SAY NOTHING GET NO VERDICT, rather than a guess",
    classify({ title: "Henderson Clinic", category: "Other", body: "Some text about the clinic." }) === null,
    classify({ title: "Henderson Clinic", category: "Other", body: "Some text about the clinic." }));
  const withReason = classify({ title: "Intake Procedure", category: "Clinical", body: "" });
  check("EVERY VERDICT CARRIES ITS REASON", !!withReason.why && withReason.why.length > 5, withReason);
  check("and how sure it is", ["high", "medium"].includes(withReason.confidence), withReason);

  // ==================================================================
  const owner = client();
  const staff = client();
  check("owner signs in", (await owner("/api/auth/login", { method: "POST",
    body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);
  check("a BCBA signs in", (await staff("/api/auth/login", { method: "POST",
    body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } })).status === 200);

  // A library the way it looks after the migration: everything filed as a
  // policy, including the things that plainly are not.
  const mk = async (title, category, body) => (await owner("/api/policies", { method: "POST",
    body: { title, category, body: body || "A body long enough to be stored without complaint." } })).data;
  const sopByTitle = await mk(`Policy Change Request and Review SOP ${stamp}`, "Administrative SOPs");
  const sopByCat = await mk(`Session Note Submission ${stamp}`, "Clinical SOPs");
  const realPolicy = await mk(`Attendance Policy ${stamp}`, "Attendance & Timekeeping");
  const quiet = await mk(`Henderson Clinic ${stamp}`, "Other", "Some notes about the building and the neighbours.");
  check("four records exist, all filed as policies",
    [sopByTitle, sopByCat, realPolicy, quiet].every((r) => r && r.id), [sopByTitle, sopByCat, realPolicy, quiet]);
  const kindsBefore = (await pool.query(
    "SELECT id, doc_kind FROM crm_policies WHERE id = ANY($1::int[])",
    [[sopByTitle.id, sopByCat.id, realPolicy.id, quiet.id]])).rows;
  check("and the database agrees they all start as policies",
    kindsBefore.every((r) => (r.doc_kind || "policy") === "policy"), kindsBefore);

  // ==================================================================
  section("The proposal changes nothing");
  check("a BCBA cannot ask for one", (await staff("/api/policies/sort-proposal")).status === 403);
  const prop = await owner("/api/policies/sort-proposal");
  check("the owner can", prop.status === 200, prop.data);
  const find = (id) => (prop.data.records || []).filter((r) => r.id === id)[0] || {};
  check("the SOP named in its title is spotted", find(sopByTitle.id).proposed_kind === "sop", find(sopByTitle.id));
  check("so is the one filed under an SOP category", find(sopByCat.id).proposed_kind === "sop", find(sopByCat.id));
  check("the real policy is left where it is", find(realPolicy.id).changes === false, find(realPolicy.id));
  check("and the one that gave no signal is too", find(quiet.id).changes === false, find(quiet.id));
  check("each row says why", !!find(sopByTitle.id).why, find(sopByTitle.id));
  check("and how sure it is", find(sopByTitle.id).confidence === "high", find(sopByTitle.id));

  const after = (await pool.query(
    "SELECT id, doc_kind FROM crm_policies WHERE id = ANY($1::int[])",
    [[sopByTitle.id, sopByCat.id, realPolicy.id, quiet.id]])).rows;
  check("ASKING FOR THE PROPOSAL WROTE NOTHING", after.every((r) => (r.doc_kind || "policy") === "policy"), after);

  // ==================================================================
  section("Applying only what was ticked");
  check("a BCBA cannot apply one", (await staff("/api/policies/sort-apply", { method: "POST",
    body: { changes: [{ id: sopByTitle.id, kind: "sop" }] } })).status === 403);
  check("an empty list is refused rather than reported as a success",
    (await owner("/api/policies/sort-apply", { method: "POST", body: { changes: [] } })).status === 400);

  // Only ONE of the two proposed moves is sent. The other must stay put --
  // this is the whole point of it being a proposal.
  const applied = await owner("/api/policies/sort-apply", { method: "POST",
    body: { changes: [{ id: sopByTitle.id, kind: "sop" }] } });
  check("the ticked one moves", applied.status === 200 && applied.data.moved === 1, applied.data);
  const sorted = (await pool.query(
    "SELECT id, doc_kind FROM crm_policies WHERE id = ANY($1::int[])",
    [[sopByTitle.id, sopByCat.id]])).rows;
  const kindOf = (id) => (sorted.filter((r) => r.id === id)[0] || {}).doc_kind;
  check("it really is an SOP now", kindOf(sopByTitle.id) === "sop", sorted);
  check("AND THE ONE THAT WAS NOT TICKED DID NOT MOVE, even though it was proposed",
    (kindOf(sopByCat.id) || "policy") === "policy", sorted);

  check("the move is on the record's own revision history",
    (await pool.query("SELECT summary FROM crm_policy_revisions WHERE policy_id = $1", [sopByTitle.id]))
      .rows.some((r) => /Sorted from policy into SOPs/i.test(r.summary || "")),
    (await pool.query("SELECT summary FROM crm_policy_revisions WHERE policy_id = $1", [sopByTitle.id])).rows);

  // ==================================================================
  section("A kind the server does not know is refused, not defaulted");
  // normalizeKind() elsewhere in this module falls back to "policy" for
  // anything unrecognised, which is right for a form with a dropdown and
  // badly wrong here: in a bulk sort it would flip an SOP back on a typo.
  const junk = await owner("/api/policies/sort-apply", { method: "POST",
    body: { changes: [{ id: sopByTitle.id, kind: "procedure" }] } });
  check("a bad kind is counted as failed", junk.status === 200 && junk.data.failed === 1, junk.data);
  check("AND THE RECORD WAS NOT QUIETLY TURNED BACK INTO A POLICY",
    (await pool.query("SELECT doc_kind FROM crm_policies WHERE id = $1", [sopByTitle.id])).rows[0].doc_kind === "sop");
  check("a record that does not exist is counted as failed, not crashed",
    (await owner("/api/policies/sort-apply", { method: "POST",
      body: { changes: [{ id: 999999, kind: "sop" }] } })).data.failed === 1);
  check("and the server is still up", (await owner("/api/policies/sort-proposal")).status === 200);

  // ==================================================================
  section("The library actually splits");
  const lib = await owner("/api/policies/library");
  const row = (id) => (lib.data.policies || []).filter((p) => p.id === id)[0] || {};
  check("the sorted record reads as an SOP in the library", row(sopByTitle.id).kind === "sop", row(sopByTitle.id));
  check("and the untouched policy still reads as a policy", row(realPolicy.id).kind === "policy");
  const sopLib = await owner("/api/policies/library?kind=sop");
  check("IT NOW APPEARS IN THE SOP LIBRARY",
    (sopLib.data.policies || []).some((p) => p.id === sopByTitle.id));
  check("and no longer in the policy one",
    !((await owner("/api/policies/library?kind=policy")).data.policies || []).some((p) => p.id === sopByTitle.id));

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
