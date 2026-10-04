// Who may change a rule, and who may only run the library.
//
// The owner asked for one thing: nobody edits policies but her. The naive way
// to do that is to narrow the single permission the policy library already
// had -- and that would also take the acknowledgment report away from HR,
// whose job it is to know who has signed what. So there are two permissions
// now, and this suite is mostly about the line between them holding in both
// directions:
//
//   * an operational admin and an HR admin can no longer write, edit, delete,
//     upload, import, link, attach, or write an amendment memo
//   * they CAN still read the acknowledgment report, announce an active
//     policy to staff, and preview how a document would split
//   * the amendment memo gets its own attention, because it is the fastest
//     way to change the rule in force without touching the policy's text
//
// The second half is the send-to-staff path, which had an endpoint and no
// button. What is asserted there is that it names its recipients before it
// sends, and that it does not quietly skip the people it cannot reach.
//
//   DATABASE_URL=... PORT=3011 node server.js
//   BASE=http://127.0.0.1:3011 node test-policy-edit-lockdown.js
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
const login = async (c, email, password) =>
  (await c("/api/auth/login", { method: "POST", body: { email, password } })).status;

(async () => {
  const owner = client();
  const admin = client();     // promoted to 'admin'  -- the operational tier
  const hr = client();        // promoted to 'hr_admin'
  const staff = client();     // a BCBA, no policy permissions at all

  check("owner signs in", await login(owner, "admin@spectrumsquadlv.com", "TestOwner123!") === 200);
  await pool.query("UPDATE users SET role = 'admin' WHERE email = 'scheduling@spectrumsquadlv.com'");
  await pool.query("UPDATE users SET role = 'hr_admin' WHERE email = 'intake@spectrumsquadlv.com'");
  check("an operational admin signs in", await login(admin, "scheduling@spectrumsquadlv.com", "TestOwner123!") === 200);
  check("an HR admin signs in", await login(hr, "intake@spectrumsquadlv.com", "TestStaff123!") === 200);
  check("a BCBA signs in", await login(staff, "clinical@spectrumsquadlv.com", "TestStaff123!") === 200);

  const pol = (await owner("/api/policies", { method: "POST", body: {
    title: `Mileage Reimbursement ${stamp}`, doc_kind: "policy", category: "Billing",
    body: "Mileage is reimbursed at the federal rate, submitted monthly." } })).data;
  check("the owner can still create a policy", !!pol.id, pol);

  // ==================================================================
  section("NOBODY BUT EXECUTIVE LEADERSHIP CAN CHANGE A RULE");
  const writes = [
    ["create a policy", "/api/policies", "POST", { title: `Sneaky ${stamp}`, body: "x".repeat(50), category: "Billing" }],
    ["edit a policy", `/api/policies/${pol.id}`, "PATCH", { body: "Mileage is no longer reimbursed." }],
    ["delete a policy", `/api/policies/${pol.id}`, "DELETE", null],
    ["write an amendment memo", `/api/policies/${pol.id}/amendments`, "POST", { title: "New rate", body: "The rate is now doubled." }],
    ["upload a source document", "/api/policies/documents", "POST", { filename: "x.txt", content_base64: Buffer.from("x".repeat(400)).toString("base64") }],
    ["import sections into policies", "/api/policies/documents/1/import", "POST", { sections: [] }],
    ["link a policy to an SOP", `/api/policies/${pol.id}/links`, "POST", { sop_id: 1 }],
    ["attach a document", `/api/policies/${pol.id}/attachments`, "POST", { document_id: 1 }],
  ];
  for (const [label, path, method, body] of writes) {
    const a = await admin(path, { method, body: body || undefined });
    const h = await hr(path, { method, body: body || undefined });
    const s = await staff(path, { method, body: body || undefined });
    check(`an operational admin cannot ${label}`, a.status === 403, { got: a.status, body: a.data });
    check(`an HR admin cannot ${label}`, h.status === 403, { got: h.status, body: h.data });
    check(`a BCBA cannot ${label}`, s.status === 403, { got: s.status, body: s.data });
  }

  // The memo gets its own section because it is the fastest route to changing
  // the rule in force: the policy's own text is untouched, so a memo written
  // by the wrong person would not look like an edit at all.
  section("The amendment memo, specifically");
  const memo = await owner(`/api/policies/${pol.id}/amendments`, { method: "POST", body: {
    title: "Rate updated", body: "Mileage is reimbursed at 70 cents per mile from November." } });
  check("the owner can write one", memo.status === 200 || memo.status === 201, memo.data);
  const memoId = (memo.data && (memo.data.id || (memo.data.amendment && memo.data.amendment.id))) || null;
  if (memoId) {
    check("an operational admin cannot edit it",
      (await admin(`/api/policies/amendments/${memoId}`, { method: "PATCH", body: { body: "Actually, nothing is reimbursed." } })).status === 403);
    check("nor rescind it",
      (await admin(`/api/policies/amendments/${memoId}/rescind`, { method: "POST", body: {} })).status === 403);
    check("nor delete it",
      (await admin(`/api/policies/amendments/${memoId}`, { method: "DELETE" })).status === 403);
  }

  // ==================================================================
  section("BUT THE LIBRARY STILL WORKS FOR THE PEOPLE WHO RUN IT");
  check("an HR admin can still read the acknowledgment report",
    (await hr("/api/policies/acknowledgments")).status === 200);
  check("so can an operational admin",
    (await admin("/api/policies/acknowledgments")).status === 200);
  check("A BCBA STILL CANNOT — this is not a general loosening",
    (await staff("/api/policies/acknowledgments")).status === 403);
  check("everybody can still read the library itself",
    (await staff("/api/policies/library")).status === 200);
  check("and a BCBA can still acknowledge a policy they are asked to sign",
    (await staff(`/api/policies/${pol.id}/acknowledge`, { method: "POST", body: {} })).status !== 403);

  // ==================================================================
  section("The screen is told the difference, so nobody is offered a dead button");
  const ownerLib = await owner("/api/policies/library");
  const adminLib = await admin("/api/policies/library");
  const hrLib = await hr("/api/policies/library");
  const staffLib = await staff("/api/policies/library");
  check("the owner may edit", ownerLib.data.can_edit === true, ownerLib.data.can_edit);
  check("AN OPERATIONAL ADMIN IS TOLD THEY MAY NOT EDIT", adminLib.data.can_edit === false, adminLib.data.can_edit);
  check("an HR admin likewise", hrLib.data.can_edit === false, hrLib.data.can_edit);
  check("and a BCBA likewise", staffLib.data.can_edit === false, staffLib.data.can_edit);
  check("BUT AN ADMIN IS STILL TOLD THEY MAY RUN THE LIBRARY", adminLib.data.can_manage === true, adminLib.data.can_manage);
  check("and an HR admin too", hrLib.data.can_manage === true, hrLib.data.can_manage);
  check("while a BCBA is not", staffLib.data.can_manage === false, staffLib.data.can_manage);
  // Draft memos are proposed rule changes, so they follow editing, not running.
  const findP = (d, id) => (d.policies || []).filter((x) => x.id === id)[0] || {};
  check("DRAFT MEMOS ARE HIDDEN FROM SOMEBODY WHO CANNOT WRITE ONE",
    Array.isArray(findP(adminLib.data, pol.id).amendments_drafts) && findP(adminLib.data, pol.id).amendments_drafts.length === 0,
    findP(adminLib.data, pol.id).amendments_drafts);

  // ==================================================================
  section("Delegating editing by name, without handing over everything else");
  await pool.query(
    "UPDATE users SET module_access = '{\"policy_edit\":true}' WHERE email = 'billing@spectrumsquadlv.com'");
  const named = client();
  check("the named person signs in", await login(named, "billing@spectrumsquadlv.com", "TestStaff123!") === 200);
  check("A NAMED GRANT RESTORES EDITING TO ONE PERSON",
    (await named(`/api/policies/${pol.id}`, { method: "PATCH", body: { body: "Mileage is reimbursed at 70 cents per mile." } })).status === 200);
  check("and the screen agrees", (await named("/api/policies/library")).data.can_edit === true);
  check("while the grant does NOT hand them the rest of the operational tier",
    (await named("/api/policies/acknowledgments")).status === 403);

  // ==================================================================
  section("Sending a policy to every employee");
  // Somebody with no address on file, so the preview has something to warn
  // about rather than asserting against an empty list.
  await pool.query(
    `INSERT INTO hr_employees (name, email, role_title, employment_type, hire_date, status)
     VALUES ($1, $2, 'RBT', 'full_time', '2025-01-06', 'active'),
            ($3, NULL,  'RBT', 'full_time', '2025-01-06', 'active')`,
    [`Sendable Person ${stamp}`, `sendable.${stamp}@spectrumsquadlv.com`, `Unreachable Person ${stamp}`]);

  const preview = await owner(`/api/policies/${pol.id}/distribute`);
  check("the screen can ask who a send would reach, before sending", preview.status === 200, preview.data);
  check("NAMING EVERY RECIPIENT, not just counting them",
    (preview.data.targets || []).some((t) => t.email === `sendable.${stamp}@spectrumsquadlv.com`),
    (preview.data.targets || []).length);
  check("AND NAMING THE PEOPLE IT WILL MISS for having no address on file",
    (preview.data.no_email || []).some((t) => /Unreachable Person/.test(t.name || "")),
    preview.data.no_email);
  check("somebody with no address is not quietly counted as a recipient",
    !(preview.data.targets || []).some((t) => /Unreachable Person/.test(t.name || "")));
  check("it says whether the policy asks for acknowledgment",
    preview.data.policy && typeof preview.data.policy.requires_acknowledgment === "boolean", preview.data.policy);

  const sendable = (preview.data.targets || []).filter((t) => t.email === `sendable.${stamp}@spectrumsquadlv.com`)[0];
  const sent = await owner(`/api/policies/${pol.id}/distribute`, { method: "POST", body: {
    employee_ids: [sendable.id], message: "Please read before your next in-home." } });
  check("the owner can send it", sent.status === 200 && sent.data.sent === 1, sent.data);
  check("and it is recorded on the policy, so a second send is a choice",
    !!(await owner(`/api/policies/${pol.id}/distribute`)).data.last_distributed_at);

  check("an operational admin can still announce an active policy",
    (await admin(`/api/policies/${pol.id}/distribute`, { method: "POST", body: { employee_ids: [sendable.id] } })).status === 200);
  check("A BCBA CANNOT MAIL THE WHOLE COMPANY",
    (await staff(`/api/policies/${pol.id}/distribute`, { method: "POST", body: {} })).status === 403);
  check("nor look up everyone's address through the preview",
    (await staff(`/api/policies/${pol.id}/distribute`)).status === 403);

  await pool.query("UPDATE crm_policies SET status = 'Archived' WHERE id = $1", [pol.id]);
  const archived = await owner(`/api/policies/${pol.id}/distribute`, { method: "POST", body: { employee_ids: [sendable.id] } });
  check("AN ARCHIVED POLICY CANNOT BE MAILED OUT as though it were in force",
    archived.status === 400, archived);

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
