// Policies and SOPs: one library, two doors.
//
// "What is the rule?" and "How do I do this?" are different questions asked by
// different people at different moments. The split exists so that neither
// answer is buried in the other, and most of what is asserted here is about
// the ways that separation could quietly stop holding:
//
//   * a record that does not say which it is
//   * a library that shows the other library's records
//   * a link stored twice, in opposite directions, so the two sides disagree
//   * a filter that hides a record which applies to everybody
//
// It also asserts the things that were ALREADY working and must survive the
// refactor: acknowledgments, amendment memos and the question box.
//
//   DATABASE_URL=... PORT=3011 node server.js
//   BASE=http://127.0.0.1:3011 node test-policies-sops.js
const { Pool } = require("pg");

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
  const owner = client();
  check("owner signs in", (await owner("/api/auth/login", {
    method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);

  const mk = async (b) => (await owner("/api/policies", { method: "POST", body: b })).data;

  // ==================================================================
  section("Two kinds, and every record says which it is");
  const pol = await mk({ title: `Documentation Policy ${stamp}`, doc_kind: "policy",
    category: "Session Notes & Documentation", doc_number: `POL-${stamp}`, department: "Clinical",
    owner_name: "Quiana Blake", applicable_roles: ["RBT", "BCBA"],
    purpose: "Documentation must be complete and timely.",
    body: "All session documentation must be completed within 24 hours." });
  const sop = await mk({ title: `Session Verification SOP ${stamp}`, doc_kind: "sop",
    category: "Session Notes & Documentation", doc_number: `SOP-${stamp}`, department: "Clinical",
    body: "1. Open Rethink.\n2. Verify the session." });
  check("a policy and an SOP can both be created", !!pol.id && !!sop.id, { pol: pol.id, sop: sop.id });

  const lib = await owner("/api/policies/library");
  const find = (d, id) => (d.policies || []).filter((x) => x.id === id)[0];
  check("EVERY RECORD CARRIES ITS KIND", (lib.data.policies || []).every((p) => p.kind === "policy" || p.kind === "sop"),
    (lib.data.policies || []).filter((p) => !p.kind).slice(0, 2));
  check("the policy reads as a policy", find(lib.data, pol.id).kind === "policy");
  check("the SOP reads as an SOP", find(lib.data, sop.id).kind === "sop");
  check("both libraries are counted, and counted separately",
    lib.data.counts && lib.data.counts.policy >= 1 && lib.data.counts.sop >= 1, lib.data.counts);

  // ==================================================================
  section("A library shows its own records and nobody else's");
  {
    const p = await owner("/api/policies/library?kind=policy");
    const s = await owner("/api/policies/library?kind=sop");
    check("THE POLICY LIBRARY CONTAINS NO SOPs", p.data.policies.every((x) => x.kind === "policy"),
      p.data.policies.filter((x) => x.kind !== "policy").slice(0, 2));
    check("THE SOP LIBRARY CONTAINS NO POLICIES", s.data.policies.every((x) => x.kind === "sop"),
      s.data.policies.filter((x) => x.kind !== "sop").slice(0, 2));
    check("...and between them they hold everything", p.data.policies.length + s.data.policies.length === lib.data.total,
      { policy: p.data.policies.length, sop: s.data.policies.length, total: lib.data.total });
    // The counts a landing page prints must not move when a door is opened.
    check("the counts do not change depending on which door was opened",
      JSON.stringify(p.data.counts) === JSON.stringify(lib.data.counts), { door: p.data.counts, landing: lib.data.counts });
  }

  // ==================================================================
  section("A rule and the procedure that carries it out");
  {
    const link = await owner(`/api/policies/${pol.id}/links`, { method: "POST", body: { other_id: sop.id } });
    check("a policy links to an SOP", link.status === 200, link.data);
    const d2 = (await owner("/api/policies/library")).data;
    check("the policy shows the SOP", (find(d2, pol.id).related || []).some((r) => r.id === sop.id && r.kind === "sop"),
      find(d2, pol.id).related);
    check("AND THE SOP SHOWS THE POLICY, from the same single row",
      (find(d2, sop.id).related || []).some((r) => r.id === pol.id && r.kind === "policy"),
      find(d2, sop.id).related);
    const rows = (await pool.query("SELECT COUNT(*)::int AS n FROM crm_policy_links WHERE policy_id=$1 AND sop_id=$2", [pol.id, sop.id])).rows[0].n;
    check("...stored once, not once per direction", rows === 1, rows);

    // Linking the same pair again must not make a second row.
    await owner(`/api/policies/${sop.id}/links`, { method: "POST", body: { other_id: pol.id } });
    const again = (await pool.query("SELECT COUNT(*)::int AS n FROM crm_policy_links WHERE policy_id=$1 AND sop_id=$2", [pol.id, sop.id])).rows[0].n;
    check("linking the pair from the other side changes nothing", again === 1, again);

    const pol2 = await mk({ title: `Dress Code ${stamp}`, doc_kind: "policy", body: "Scrubs." });
    const bad = await owner(`/api/policies/${pol.id}/links`, { method: "POST", body: { other_id: pol2.id } });
    check("TWO POLICIES CANNOT BE LINKED — a link means 'this is how that rule is done'",
      bad.status === 400, bad.data);
    check("...and the refusal says so in words, not in jargon",
      /policy to an SOP/i.test((bad.data && bad.data.error) || "") && !/policys/.test((bad.data && bad.data.error) || ""),
      bad.data && bad.data.error);

    await owner(`/api/policies/${pol.id}/links`, { method: "DELETE", body: { other_id: sop.id } });
    const d3 = (await owner("/api/policies/library")).data;
    check("unlinking clears it from both sides",
      !(find(d3, pol.id).related || []).length && !(find(d3, sop.id).related || []).length,
      { pol: find(d3, pol.id).related, sop: find(d3, sop.id).related });
    await owner(`/api/policies/${pol.id}/links`, { method: "POST", body: { other_id: sop.id } });
  }

  // ==================================================================
  section("Filters, including the one that must not hide anybody");
  {
    const byDept = await owner("/api/policies/library?department=Clinical");
    check("department narrows the library", byDept.data.policies.every((x) => x.department === "Clinical"),
      byDept.data.policies.filter((x) => x.department !== "Clinical").slice(0, 2));

    // The SOP above has no roles set, which means it applies to EVERYONE. A
    // role filter that drops it would be telling an RBT a procedure is not
    // theirs when it is.
    const byRole = await owner("/api/policies/library?role=RBT");
    const ids = byRole.data.policies.map((x) => x.id);
    check("a record naming the role is included", ids.includes(pol.id));
    check("A RECORD THAT NAMES NO ROLES APPLIES TO EVERYONE, so the filter keeps it",
      ids.includes(sop.id), { looked_for: sop.id, got: ids.slice(0, 8) });
    const byOther = await owner("/api/policies/library?role=Office%20Manager");
    check("...while a record naming OTHER roles is excluded",
      !byOther.data.policies.map((x) => x.id).includes(pol.id));

    const future = await owner("/api/policies/library?updated_since=2099-01-01");
    check("updated-since excludes everything older", future.data.policies.length === 0, future.data.policies.length);

    const vocab = await owner("/api/policies/library");
    check("departments are offered from what the practice actually has",
      Array.isArray(vocab.data.departments) && vocab.data.departments.includes("Clinical"), vocab.data.departments);
    check("roles are offered from the staff on file",
      Array.isArray(vocab.data.roles) && vocab.data.roles.length > 0, vocab.data.roles);
  }

  // ==================================================================
  section("The record keeps what it was given");
  {
    const p = find((await owner("/api/policies/library")).data, pol.id);
    check("number, department and owner survive the round trip",
      p.doc_number === `POL-${stamp}` && p.department === "Clinical" && p.owner_name === "Quiana Blake", p);
    check("applicable roles come back as a list, not a string",
      Array.isArray(p.applicable_roles) && p.applicable_roles.join(",") === "RBT,BCBA", p.applicable_roles);
    check("purpose is kept apart from the body", /complete and timely/.test(p.purpose || "") && !/complete and timely/.test(p.body || ""), p.purpose);
    const search = await owner("/api/policies/library?q=" + encodeURIComponent(`POL-${stamp}`));
    check("SEARCHING BY NUMBER FINDS IT", search.data.policies.some((x) => x.id === pol.id),
      search.data.policies.map((x) => x.doc_number));
  }

  // ==================================================================
  section("A record cannot be mis-filed by a typo");
  {
    const bad = await owner("/api/policies", { method: "POST", body: { title: `Typo ${stamp}`, doc_kind: "SOPP" } });
    check("CREATING WITH AN UNKNOWN KIND IS REFUSED, not quietly filed as a policy", bad.status === 400, bad.data);
    const badPatch = await owner(`/api/policies/${pol.id}`, { method: "PATCH", body: { doc_kind: "procedure" } });
    check("...and so is re-filing one into a kind that does not exist", badPatch.status === 400, badPatch.data);
    const still = find((await owner("/api/policies/library")).data, pol.id);
    check("the record is untouched by the refusal", still.kind === "policy", still.kind);
  }

  // ==================================================================
  section("What changed, and who changed it");
  {
    await owner(`/api/policies/${pol.id}`, { method: "PATCH", body: { body: "Within 12 hours.", version: "2" } });
    const p = find((await owner("/api/policies/library")).data, pol.id);
    check("a revision is recorded", (p.revisions || []).length >= 1, p.revisions);
    check("IT NAMES THE FIELDS THAT MOVED, not merely that something did",
      /body/.test(p.revisions[0].summary) && /version/.test(p.revisions[0].summary), p.revisions[0]);
    check("...and says it was a re-issue", /Re-issued/.test(p.revisions[0].summary), p.revisions[0].summary);
    check("and who did it", !!p.revisions[0].changed_by, p.revisions[0]);

    const before = (p.revisions || []).length;
    await owner(`/api/policies/${pol.id}`, { method: "PATCH", body: { body: "Within 12 hours." } });
    const p2 = find((await owner("/api/policies/library")).data, pol.id);
    check("SAVING WITHOUT CHANGING ANYTHING WRITES NO REVISION", (p2.revisions || []).length === before,
      { before, after: (p2.revisions || []).length });
  }

  // ==================================================================
  section("Records written before any of this existed");
  {
    // The column did not exist when these were written. They must land in a
    // library rather than in neither.
    const legacy = (await pool.query(
      `INSERT INTO crm_policies (title, category, body, slug, published, created_at, updated_at)
       VALUES ($1,'Other','Old text',$2,TRUE,now()::text,now()::text) RETURNING id`,
      [`Legacy ${stamp}`, `legacy-${stamp}`])).rows[0].id;
    await pool.query("UPDATE crm_policies SET doc_kind = NULL WHERE id = $1", [legacy]);
    const d = (await owner("/api/policies/library?kind=policy")).data;
    check("AN UNCLASSIFIED RECORD IS READ AS A POLICY, never as neither",
      d.policies.some((x) => x.id === legacy), { legacy, got: d.policies.length });
  }

  // ==================================================================
  section("Who may write, and who may only read");
  {
    const staff = client();
    await staff("/api/auth/login", { method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } });
    const read = await staff("/api/policies/library");
    check("a clinical user can read the library", read.status === 200 && read.data.policies.length > 0);
    check("...and is told they cannot manage it", read.data.can_manage === false, read.data.can_manage);
    const w = await staff("/api/policies", { method: "POST", body: { title: "Nope", doc_kind: "sop" } });
    check("THEY CANNOT CREATE ONE", w.status === 403, w.status);
    const l = await staff(`/api/policies/${pol.id}/links`, { method: "POST", body: { other_id: sop.id } });
    check("...nor link one", l.status === 403, l.status);
    const a = await staff(`/api/policies/${pol.id}/attachments`, { method: "POST", body: { document_id: 1 } });
    check("...nor attach to one", a.status === 403, a.status);
  }

  // ==================================================================
  section("What already worked still works");
  {
    const d = (await owner("/api/policies/library")).data;
    check("the question box still answers", (await owner("/api/policies/ask?q=documentation")).status === 200);
    check("acknowledgments still report", (await owner("/api/policies/acknowledgments")).status === 200);
    check("amendment memos still load", (await owner(`/api/policies/${pol.id}/amendments`)).status === 200);
    check("categories and their colours are still offered", (d.categories || []).length > 5 && !!d.category_colors);
    check("source documents are still offered", Array.isArray(d.documents));
    const pub = await fetch(BASE + "/policies").then((r) => r.status);
    check("the public QR page still serves", pub === 200, pub);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
