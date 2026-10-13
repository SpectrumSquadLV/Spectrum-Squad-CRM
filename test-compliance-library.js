// The company-wide course library, and who each course is required of.
//
// The brief this is built from is explicit that compliance training is NOT a
// BCBA onboarding feature: HIPAA is required of an RBT, a BCBA, the front
// desk and the Clinical Director alike. So there is one library, and the
// onboarding programmes reference it rather than carrying copies.
//
// THREE PROPERTIES THESE TESTS DEFEND.
//
// 1. SEEDING A LIBRARY IS NOT ASSIGNING TRAINING. The seven courses the brief
//    names arrive as library entries with NO rules, so they are required of
//    nobody until somebody decides otherwise and their name goes in the audit
//    trail. Software does not get to assign company-wide training.
//
// 2. NO RENEWAL INTERVAL IS INVENTED. The brief says intervals follow
//    "applicable laws, contracts, and company policies". A number shipped
//    here would be read as that law, and a wrong renewal period on mandatory
//    reporter training is worse than an empty field visibly waiting for one.
//
// 3. A COURSE IS NEVER DELETED, and changing what COMPLETING it means forks a
//    version rather than rewriting what people have already earned.
//
//   DATABASE_URL=... node run-tests.js test-compliance-library.js
"use strict";

const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3009";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const q = (sql, p) => pool.query(sql, p || []);

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else {
    fail++; failures.push(name);
    console.log("  FAIL  " + name + (detail !== undefined
      ? "  -> " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 300) : ""));
  }
};
const section = (t) => console.log("\n== " + t + " ==");

function client() {
  let jar = "";
  return async (path, opts = {}) => {
    const r = await fetch(BASE + path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", ...(jar ? { Cookie: jar } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      redirect: "manual",
    });
    const setC = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (setC && setC.length) jar = setC.map((c) => c.split(";")[0]).join("; ");
    let data = null; try { data = await r.json(); } catch (e) {}
    return { status: r.status, data };
  };
}
const login = async (email, password) => {
  const c = client();
  const r = await c("/api/auth/login", { method: "POST", body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status}`);
  return c;
};

const COURSES = "/api/compliance/courses";

(async () => {
  const owner = await login("admin@spectrumsquadlv.com", "TestOwner123!");
  const lib = async (c, qs) => (await (c || owner)(COURSES + (qs || ""))).data;

  // ==================================================================
  section("The library the brief names, required of nobody");
  const d0 = await lib();
  const byKey = Object.fromEntries((d0.courses || []).map((c) => [c.key, c]));
  const WANT = ["hipaa", "harassment_prevention", "mandatory_reporter", "ethics_conduct",
                "client_rights", "infection_control", "emergency_safety"];
  WANT.forEach((k) => check(`${k} is in the library`, !!byKey[k], Object.keys(byKey)));
  check("all seven, and nothing invented beyond them", (d0.courses || []).length === 7, (d0.courses || []).map((c) => c.key));
  check("every one says what it covers", WANT.every((k) => byKey[k].summary && byKey[k].summary.length > 20));

  check("NONE of them is required of anybody yet",
    WANT.every((k) => byKey[k].rules.length === 0 && /Nobody yet/.test(byKey[k].required_of)),
    WANT.filter((k) => byKey[k].rules.length));
  check("NO renewal interval was invented for any of them",
    WANT.every((k) => byKey[k].renews === null), WANT.map((k) => [k, byKey[k].renews]));
  check("seeding is on the record, so the library did not appear from nowhere",
    (await owner(`/api/compliance/courses/${byKey.hipaa.id}/history`)).data.history.some((h) => /required of nobody/i.test(h.change)));

  check("Nevada mandatory reporter is marked as taken elsewhere, not delivered here",
    byKey.mandatory_reporter.delivery === "external_link", byKey.mandatory_reporter.delivery);
  check("the vocabulary offers the four ways a course can be required",
    (d0.vocabulary.scopes || []).map((s) => s.key).join() === "all,position,department,optional", d0.vocabulary.scopes);
  check("...and the departments to choose from are the real ones",
    (d0.vocabulary.departments || []).some((x) => x.key === "rbt") && (d0.vocabulary.departments || []).some((x) => x.key === "clinical"),
    (d0.vocabulary.departments || []).map((x) => x.key));
  check("...and the positions, without the 'not set' placeholder",
    (d0.vocabulary.positions || []).some((p) => p.key === "rbt") && !(d0.vocabulary.positions || []).some((p) => p.key === "unset"),
    (d0.vocabulary.positions || []).map((p) => p.key));

  // ==================================================================
  section("Who may change the library");
  check("the owner may", d0.can_manage === true);
  const cd = await login("clinical@spectrumsquadlv.com", "TestStaff123!");
  const cdEmp = (await owner("/api/hr/employees", { method: "POST", body: { name: "Dana Director", email: "clinical@spectrumsquadlv.com", role_title: "Clinical Director" } })).data.id;
  const asLead = () => owner(`/api/academy/leadership/${cdEmp}`, { method: "PUT", body: { leadership: "clinical_director" } });
  await asLead();
  const cdView = await cd(COURSES);
  check("the Clinical Director can read the library", cdView.status === 200, cdView.status);
  check("...but cannot change it", cdView.data.can_manage === false, cdView.data.can_manage);
  check("...and is refused if she tries",
    (await cd(COURSES, { method: "POST", body: { title: "Something" } })).status === 403);

  // ASKED FOR IN THESE WORDS: nobody but the owner edits the training or adds
  // the documents. HR runs onboarding and reads the picture; an admin runs the
  // CRM. Neither writes the curriculum, and neither of them is the owner.
  const hrRole = (await q("SELECT role FROM users WHERE LOWER(email) = 'intake@spectrumsquadlv.com'")).rows[0].role;
  await q("UPDATE users SET role = 'hr_admin' WHERE LOWER(email) = 'intake@spectrumsquadlv.com'");
  const hr = await login("intake@spectrumsquadlv.com", "TestStaff123!");
  const hrView = await hr(COURSES);
  check("HR can READ the library", hrView.status === 200, hrView.status);
  check("...and is told it is not theirs to change", hrView.data.can_manage === false, hrView.data.can_manage);
  check("HR cannot add a course", (await hr(COURSES, { method: "POST", body: { title: "HR's own course" } })).status === 403);
  check("HR cannot change one",
    (await hr(`/api/compliance/courses/${byKey.hipaa.id}`, { method: "PATCH", body: { title: "Renamed by HR" } })).status === 403);
  check("HR cannot decide who training is required of",
    (await hr(`/api/compliance/courses/${byKey.hipaa.id}/rules`, { method: "PUT", body: { rules: [{ scope: "all" }] } })).status === 403);
  check("HR cannot retire a course",
    (await hr(`/api/compliance/courses/${byKey.hipaa.id}/retire`, { method: "POST", body: {} })).status === 403);
  check("...and the refusals say whose it is",
    /practice owner/i.test(((await hr(COURSES, { method: "POST", body: { title: "x" } })).data || {}).error || ""));
  await q("UPDATE users SET role = 'admin' WHERE LOWER(email) = 'intake@spectrumsquadlv.com'");
  const adm = await login("intake@spectrumsquadlv.com", "TestStaff123!");
  check("an admin cannot either", (await adm(COURSES, { method: "POST", body: { title: "Admin's own course" } })).status === 403);
  check("...though an admin can still read it", (await adm(COURSES)).status === 200);
  await q("UPDATE users SET role = $1 WHERE LOWER(email) = 'intake@spectrumsquadlv.com'", [hrRole]);

  // THE HOLE WORTH CLOSING: the API floor lets the training-only role reach
  // /api/compliance/* at all, because its OWN training lives under that
  // prefix. The library behind it is not theirs.
  const EMAIL = "zz.compliance.employee@spectrumsquadlv.com";
  await q("DELETE FROM users WHERE lower(email) = lower($1)", [EMAIL]);
  await owner("/api/admin/users", { method: "POST", body: { name: "Zz Trainee", email: EMAIL, password: "Trainee123!", role: "employee" } });
  const emp = await login(EMAIL, "Trainee123!");
  check("a training-only account CANNOT read the course library", (await emp(COURSES)).status === 403);
  check("...nor create a course", (await emp(COURSES, { method: "POST", body: { title: "Mine" } })).status === 403);
  check("...nor decide who training is required of",
    (await emp(`/api/compliance/courses/${byKey.hipaa.id}/rules`, { method: "PUT", body: { rules: [{ scope: "all" }] } })).status === 403);
  check("...nor read a course's change history", (await emp(`/api/compliance/courses/${byKey.hipaa.id}/history`)).status === 403);

  // AND NOT BY THE SIDE DOOR. Clinical-lead status is decided by EMAIL, not
  // by role: whoever is designated Clinical Director passes isClinicalLead
  // whatever their login is. So a training-only account whose address carries
  // that designation would read the whole library on the strength of it. The
  // role is refused on its own terms, ahead of the designation.
  const empEmp = (await owner("/api/hr/employees", { method: "POST", body: { name: "Zz Trainee", email: EMAIL, role_title: "RBT" } })).data.id;
  const desig = await owner(`/api/academy/leadership/${empEmp}`, { method: "PUT", body: { leadership: "clinical_director" } });
  check("the designation was actually applied, so this is a real test", desig.status === 200, desig.data);
  const empAfter = await login(EMAIL, "Trainee123!");
  check("STILL refused even when that address is the designated Clinical Director",
    (await empAfter(COURSES)).status === 403, (await empAfter(COURSES)).status);
  // Put the designation back where the rest of the suite expects it.
  await asLead();

  // ==================================================================
  section("Adding a course");
  const made = await owner(COURSES, { method: "POST", body: {
    title: "CPR & First Aid", delivery: "external_certificate", provider: "American Red Cross",
    summary: "Current CPR/First Aid certification from an approved provider.",
  } });
  check("a course can be added", made.status === 201, made.data);
  const cpr = (await lib()).courses.find((c) => c.id === made.data.id);
  check("...with a key derived from its title", cpr.key === "cpr_first_aid", cpr.key);
  check("...starting at version 1", cpr.version === 1);
  check("...required of nobody until a rule is set", /Nobody yet/.test(cpr.required_of), cpr.required_of);
  const dup = await owner(COURSES, { method: "POST", body: { title: "CPR & First Aid", delivery: "internal" } });
  check("a second course of the same name gets its own key, not a collision",
    dup.status === 201 && (await lib()).courses.find((c) => c.id === dup.data.id).key === "cpr_first_aid_2",
    (await lib()).courses.find((c) => c.id === dup.data.id).key);

  check("a course with no title is refused", (await owner(COURSES, { method: "POST", body: { title: "  " } })).status === 400);
  check("a delivery kind that does not exist is refused",
    (await owner(COURSES, { method: "POST", body: { title: "X", delivery: "telepathy" } })).status === 400);
  check("a policy acknowledgment course must say which policy",
    (await owner(COURSES, { method: "POST", body: { title: "Y", delivery: "policy_ack" } })).status === 400);
  check("a training link that is not a link is refused",
    (await owner(COURSES, { method: "POST", body: { title: "Z", external_url: "javascript:alert(1)" } })).status === 400);
  check("a passing score outside 1-100 is refused",
    (await owner(COURSES, { method: "POST", body: { title: "W", passing_score: 140 } })).status === 400);

  // ==================================================================
  section("Changing a course: what forks a version and what does not");
  const before = (await lib()).courses.find((c) => c.id === made.data.id);
  const rename = await owner(`/api/compliance/courses/${made.data.id}`, { method: "PATCH", body: { title: "CPR & First Aid (AHA or Red Cross)" } });
  check("a title can be corrected", rename.status === 200, rename.data);
  const renamed = (await lib()).courses.find((c) => c.id === made.data.id);
  check("...WITHOUT forking a version -- nothing about completing it changed",
    renamed.version === before.version && rename.data.forked === false, { was: before.version, now: renamed.version });
  check("...and the key does not move, so nobody's record is orphaned", renamed.key === before.key, renamed.key);

  const score = await owner(`/api/compliance/courses/${made.data.id}`, { method: "PATCH", body: { passing_score: 80 } });
  check("adding a passing score DOES fork a version", score.data.forked === true && score.data.version === before.version + 1, score.data);
  const kind = await owner(`/api/compliance/courses/${made.data.id}`, { method: "PATCH", body: { delivery: "internal" } });
  check("changing how it is delivered forks again", kind.data.forked === true && kind.data.version === before.version + 2, kind.data);
  check("the fork is explained on the record, not just numbered",
    (await owner(`/api/compliance/courses/${made.data.id}/history`)).data.history.some((h) => /what completing the course means/i.test(h.change)));
  const nothing = await owner(`/api/compliance/courses/${made.data.id}`, { method: "PATCH", body: { passing_score: 80 } });
  check("re-saving the same value changes nothing", nothing.data.unchanged === true, nothing.data);

  // ==================================================================
  section("Who a course is required of");
  const rulesFor = (id, rules) => owner(`/api/compliance/courses/${id}/rules`, { method: "PUT", body: { rules } });
  const r1 = await rulesFor(byKey.hipaa.id, [{ scope: "all", renewal_months: 12, due_days: 30 }]);
  check("HIPAA can be required of everybody, yearly", r1.status === 200, r1.data);
  const hipaa = (await lib()).courses.find((c) => c.key === "hipaa");
  check("...and it says so in words", hipaa.required_of === "Everybody" && hipaa.renews === "Every 12 months", { r: hipaa.required_of, n: hipaa.renews });

  const r2 = await rulesFor(byKey.client_rights.id, [
    { scope: "position", position_group: "rbt", renewal_months: 24 },
    { scope: "department", department_key: "clinical", renewal_months: 12 },
  ]);
  check("a course can be required of a position and a department at once", r2.status === 200, r2.data);
  const cr = (await lib()).courses.find((c) => c.key === "client_rights");
  check("...and both are listed", /RBT/.test(cr.required_of) && /clinical/.test(cr.required_of), cr.required_of);
  check("...with the range of renewal intervals, not one of them", /12–24 months/.test(cr.renews), cr.renews);

  const r3 = await rulesFor(byKey.ethics_conduct.id, [{ scope: "optional" }]);
  check("a course can be optional professional development", r3.status === 200, r3.data);
  const eth = (await lib()).courses.find((c) => c.key === "ethics_conduct");
  check("...and optional does not make it required of anybody", /Nobody yet/.test(eth.required_of), eth.required_of);

  check("a position that does not exist is refused",
    (await rulesFor(byKey.hipaa.id, [{ scope: "position", position_group: "wizard" }])).status === 400);
  check("a department that does not exist is refused",
    (await rulesFor(byKey.hipaa.id, [{ scope: "department", department_key: "not-a-dept" }])).status === 400);
  check("a department rule with no department is refused",
    (await rulesFor(byKey.hipaa.id, [{ scope: "department" }])).status === 400);
  check("a renewal interval that is not a number of months is refused",
    (await rulesFor(byKey.hipaa.id, [{ scope: "all", renewal_months: "soon" }])).status === 400);
  check("the same rule twice is refused rather than silently deduplicated",
    (await rulesFor(byKey.hipaa.id, [{ scope: "all" }, { scope: "all" }])).status === 400);
  check("a bad rule leaves the old rules alone",
    (await lib()).courses.find((c) => c.key === "hipaa").rules.length === 1);
  check("changing who it is required of is on the record with who changed it",
    (await owner(`/api/compliance/courses/${byKey.hipaa.id}/history`)).data.history.some((h) => /required of/i.test(h.change) && h.changed_by));

  // ==================================================================
  section("A course is retired, never deleted");
  const retire = await owner(`/api/compliance/courses/${dup.data.id}/retire`, { method: "POST", body: {} });
  check("a course can be retired", retire.status === 200, retire.data);
  check("...and leaves the library", !(await lib()).courses.some((c) => c.id === dup.data.id));
  check("...but is still there to be looked up, so a transcript still resolves",
    (await lib(null, "?retired=1")).courses.some((c) => c.id === dup.data.id && c.active === false));
  check("...and the row was not deleted",
    Number((await q("SELECT COUNT(*)::int AS n FROM compliance_courses WHERE id = $1", [dup.data.id])).rows[0].n) === 1);
  check("it can be brought back",
    (await owner(`/api/compliance/courses/${dup.data.id}/retire`, { method: "POST", body: { retire: false } })).status === 200
    && (await lib()).courses.some((c) => c.id === dup.data.id));

  // ==================================================================
  section("Nothing is assigned to anybody yet");
  check("there is no assignment table pretending training has been handed out",
    Number((await q("SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_name = 'compliance_assignments'")).rows[0].n) === 0);

  await q("DELETE FROM users WHERE lower(email) = lower($1)", [EMAIL]).catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("\nFailures:"); failures.forEach((f) => console.log("  - " + f)); }
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await pool.end(); } catch (x) {} process.exit(1); });
