// Report a Concern.
//
// The form is the easy half. Everything that matters here is about who can
// see what, and the suite is built around the failure that would make the
// whole feature worse than useless: an employee raises a concern about their
// supervisor, and the supervisor reads it.
//
// So the centre of this file is one scenario, run against a REAL manager
// account with real management permissions:
//
//   * they cannot open it
//   * it is not in their list
//   * they are not offered as a reviewer for it
//   * they cannot be assigned it even by a direct API call
//   * they are not emailed about it
//   * they cannot authorize themselves to see it
//   * and their attempt to open it is on the record
//
// The rest is the other ways the confidentiality could leak: the Message
// Outbox (which shows the whole notification log to every admin), the
// anonymity promise (does an anonymous report submitted from a logged-in
// browser really store nothing?), and the status endpoint a reference code
// opens (does it hand back the review?).
//
//   DATABASE_URL=... PORT=3011 node server.js
//   BASE=http://127.0.0.1:3011 node test-concerns.js
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
  const f = async (p, { method = "GET", body } = {}) => {
    const r = await fetch(BASE + p, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  };
  f.cookie = () => cookie;
  return f;
}
const login = async (c, email, password) =>
  (await c("/api/auth/login", { method: "POST", body: { email, password } })).status;

(async () => {
  const owner = client();        // owner -> reviewer and authorizer
  const manager = client();      // a REAL admin: broad operational access, no concern permission
  const hr = client();           // hr_admin, also no concern permission by title
  const staff = client();        // the person raising the concern
  const deputy = client();       // given concern_review by name

  check("owner signs in", await login(owner, "admin@spectrumsquadlv.com", "TestOwner123!") === 200);

  // A real manager, not an argument about role names. This account gets every
  // operational permission the CRM grants an admin -- which is exactly the
  // point: broad access elsewhere must not buy access here.
  await pool.query("UPDATE users SET role = 'admin' WHERE email = 'scheduling@spectrumsquadlv.com'");
  await pool.query("UPDATE users SET role = 'hr_admin' WHERE email = 'intake@spectrumsquadlv.com'");
  check("a manager with full admin rights signs in", await login(manager, "scheduling@spectrumsquadlv.com", "TestOwner123!") === 200);
  check("an HR admin signs in", await login(hr, "intake@spectrumsquadlv.com", "TestStaff123!") === 200);
  check("the reporting staff member signs in", await login(staff, "clinical@spectrumsquadlv.com", "TestStaff123!") === 200);

  const managerUser = (await pool.query("SELECT id, name FROM users WHERE email = 'scheduling@spectrumsquadlv.com'")).rows[0];
  const ownerUser = (await pool.query("SELECT id, name FROM users WHERE email = 'admin@spectrumsquadlv.com'")).rows[0];

  // The manager also has an employee record, which is what the staff picker
  // actually lists -- the exclusion has to survive that indirection.
  const emp = (await pool.query(
    `INSERT INTO hr_employees (name, email, role_title, employment_type, hire_date, status)
     VALUES ($1, 'scheduling@spectrumsquadlv.com', 'Clinical Director', 'full_time', '2024-01-08', 'active') RETURNING id`,
    [`Named Manager ${stamp}`])).rows[0];

  // ==================================================================
  section("BROAD OPERATIONAL ACCESS DOES NOT BUY CONCERN ACCESS");
  check("an admin cannot open the review dashboard", (await manager("/api/concerns")).status === 403);
  check("nor can an HR admin", (await hr("/api/concerns")).status === 403);
  check("nor can a BCBA", (await staff("/api/concerns")).status === 403);
  check("the owner can", (await owner("/api/concerns")).status === 200);
  check("and an admin is told as much on their own options", (await manager("/api/concerns/options")).data.can_review === false);

  // ==================================================================
  section("THE SCENARIO: a concern about the manager");
  // The permission is granted BEFORE the concern is raised, deliberately. If
  // it were granted afterwards, every "they cannot see it" assertion below
  // would pass for the wrong reason -- they would simply not be a reviewer --
  // and the exclusion itself would never be exercised. Here they genuinely
  // are a reviewer, and the exclusion has to beat the permission.
  await pool.query(
    "UPDATE users SET module_access = '{\"concern_review\":true}' WHERE email = 'scheduling@spectrumsquadlv.com'");
  check("the manager is given the concern permission by name, before any of this",
    (await manager("/api/concerns/options")).data.can_review === true);
  const raised = await staff("/api/concerns", { method: "POST", body: {
    reporting_mode: "confidential",
    concern_type: "Leadership or Supervisor Concern",
    incident_date: "2026-09-30", incident_time: "16:45", location: "Henderson clinic",
    people_involved: [{ employee_id: emp.id, name: `Named Manager ${stamp}` }],
    people_text: "A parent was in the room",
    description: "Overtime was approved for one RBT and refused for another on the same shift.",
    policy_text: "Overtime approval",
    witnesses_present: "Yes", witnesses_text: "Two other RBTs",
    reported_previously: false,
  } });
  check("a staff member can raise it", raised.status === 201, raised.data);
  const code = raised.data && raised.data.reference_code;
  check("and gets a reference code back", /^SQ-/.test(code || ""), code);
  const reportId = (await pool.query("SELECT id FROM concern_reports WHERE reference_code = $1", [code])).rows[0].id;

  // THE MANAGER WAS NOT EMAILED. An email is a route, and "must not
  // automatically route to that person" covers it. Asserted here, while this
  // is still the only report in the database: notifications_log carries no
  // report id, so a later check would count alerts legitimately sent to them
  // about concerns they are not named in.
  const toManager = (await pool.query(
    "SELECT id FROM notifications_log WHERE type = 'concern_review_alert' AND lower(recipient) = 'scheduling@spectrumsquadlv.com'")).rows;
  check("THE PERSON THE CONCERN IS ABOUT WAS NOT EMAILED ABOUT IT", toManager.length === 0, toManager.length);
  const toOwner = (await pool.query(
    "SELECT id FROM notifications_log WHERE type = 'concern_review_alert' AND lower(recipient) = 'admin@spectrumsquadlv.com'")).rows;
  check("while an unconflicted reviewer was", toOwner.length >= 1, toOwner.length);

  // The picker gave an employee_id; the exclusion needs a user id. This is the
  // resolution step, and if it silently failed the whole lock would be open.
  const linked = (await pool.query(
    "SELECT user_id FROM concern_report_people WHERE report_id = $1", [reportId])).rows;
  check("THE NAMED EMPLOYEE WAS RESOLVED TO THEIR LOGIN, which is what the exclusion matches on",
    linked.some((r) => Number(r.user_id) === Number(managerUser.id)), linked);

  const mList = await manager("/api/concerns");
  check("they can open the dashboard", mList.status === 200);
  check("THE CONCERN ABOUT THEM IS NOT IN THEIR LIST",
    !(mList.data.reports || []).some((r) => r.id === reportId),
    (mList.data.reports || []).map((r) => r.id));
  check("but they are told something is being withheld, without being told what",
    mList.data.hidden_from_you >= 1, mList.data.hidden_from_you);
  const mOne = await manager("/api/concerns/" + reportId);
  check("THEY CANNOT OPEN IT", mOne.status === 403, mOne);
  check("and the refusal explains why rather than reading as a bug",
    /named in this concern/i.test((mOne.data || {}).error || ""), mOne.data);

  check("they cannot change its status", (await manager("/api/concerns/" + reportId + "/status",
    { method: "POST", body: { status: "Closed", resolution: "Nothing happened." } })).status === 403);
  check("cannot write a review record", (await manager("/api/concerns/" + reportId + "/review",
    { method: "PATCH", body: { findings: "Unfounded." } })).status === 403);
  check("cannot reassign it", (await manager("/api/concerns/" + reportId + "/assign",
    { method: "POST", body: { user_id: managerUser.id } })).status === 403);
  check("cannot add evidence to it", (await manager("/api/concerns/" + reportId + "/files",
    { method: "POST", body: { data_base64: "eA==" } })).status === 403);
  check("cannot record an interview on it", (await manager("/api/concerns/" + reportId + "/interviews",
    { method: "POST", body: { name: "Someone" } })).status === 403);
  check("AND CANNOT AUTHORIZE THEMSELVES TO SEE IT", (await manager("/api/concerns/" + reportId + "/authorize",
    { method: "POST", body: { user_id: managerUser.id, reason: "I should see this." } })).status === 403);
  check("even the list of possible reviewers is refused to them",
    (await manager("/api/concerns/reviewers?report_id=" + reportId)).status === 403);

  // The owner is unconflicted, so the exclusion must not get in HER way.
  const oOne = await owner("/api/concerns/" + reportId);
  check("the owner, who is not named, CAN open it", oOne.status === 200, oOne.data);
  check("and sees who was named", (oOne.data.involved || []).some((p) => Number(p.user_id) === Number(managerUser.id)));
  check("the named person is flagged as matchable, so the lock is known to cover them",
    (oOne.data.involved || []).every((p) => p.matchable === true || !p.user_id), oOne.data.involved);

  const pick = await owner("/api/concerns/reviewers?report_id=" + reportId);
  check("THE REVIEWER PICKER DOES NOT OFFER THE PERSON THE CONCERN IS ABOUT",
    !(pick.data.reviewers || []).some((p) => p.id === managerUser.id),
    (pick.data.reviewers || []).map((p) => p.name));
  check("but does offer the owner", (pick.data.reviewers || []).some((p) => p.id === ownerUser.id));
  const badAssign = await owner("/api/concerns/" + reportId + "/assign", { method: "POST", body: { user_id: managerUser.id } });
  check("AND THEY CANNOT BE ASSIGNED IT EVEN BY A DIRECT CALL", badAssign.status === 400, badAssign);
  check("which says why", /named in this concern/i.test((badAssign.data || {}).error || ""), badAssign.data);

  // ==================================================================
  section("The refused attempt is on the record");
  const audit = (await pool.query(
    "SELECT action, actor_id, note FROM concern_report_history WHERE report_id = $1 ORDER BY id", [reportId])).rows;
  check("THE NAMED MANAGER'S ATTEMPT TO OPEN IT WAS LOGGED",
    audit.some((h) => h.action === "access_refused" && Number(h.actor_id) === Number(managerUser.id)), audit);
  check("and so was every successful read",
    audit.some((h) => h.action === "accessed" && Number(h.actor_id) === Number(ownerUser.id)), audit);
  check("the submission is on the record", audit.some((h) => h.action === "submitted"));

  // ==================================================================
  section("Authorization: the documented exception, and its limits");
  check("a reviewer who is not executive leadership cannot authorize anybody",
    (await staff("/api/concerns/" + reportId + "/authorize", { method: "POST", body: {
      user_id: managerUser.id, reason: "x" } })).status === 403);
  check("authorizing without a written reason is refused",
    (await owner("/api/concerns/" + reportId + "/authorize", { method: "POST", body: {
      user_id: managerUser.id } })).status === 400);
  const auth = await owner("/api/concerns/" + reportId + "/authorize", { method: "POST", body: {
    user_id: managerUser.id, reason: "Named only as the approver of record; needs to answer the overtime question." } });
  check("executive leadership can authorize a named person, with a reason", auth.status === 200, auth.data);
  check("AND ONLY THEN CAN THEY OPEN IT", (await manager("/api/concerns/" + reportId)).status === 200);
  check("the authorization is on the record, with its reason",
    (await owner("/api/concerns/" + reportId)).data.history.some(
      (h) => h.action === "access_authorized" && /overtime question/.test(h.note || "")));
  const revoked = await owner("/api/concerns/" + reportId + "/authorize", { method: "DELETE", body: { user_id: managerUser.id } });
  check("and it can be taken back", revoked.status === 200);
  check("after which they are excluded again", (await manager("/api/concerns/" + reportId)).status === 403);

  // ==================================================================
  section("A CONCERN NAMING THE OWNER");
  // The spec says this applies to everyone, leadership included, so the
  // hardest case is the one where the person named is the person who owns the
  // CRM. The exclusion has no special case for her, and the guard that stops a
  // named person choosing who may read a report about them is only exercised
  // here.
  const ownerEmp = (await pool.query(
    `INSERT INTO hr_employees (name, email, role_title, employment_type, hire_date, status)
     VALUES ($1, 'admin@spectrumsquadlv.com', 'Owner', 'full_time', '2023-01-02', 'active') RETURNING id`,
    [`Quiana Blake ${stamp}`])).rows[0];
  check("a deputy reviewer exists", await login(deputy, "billing@spectrumsquadlv.com", "TestStaff123!") === 200);
  await pool.query(
    "UPDATE users SET module_access = '{\"concern_review\":true}' WHERE email = 'billing@spectrumsquadlv.com'");

  const aboutOwner = await staff("/api/concerns", { method: "POST", body: {
    reporting_mode: "confidential",
    concern_type: "Unauthorized Policy Exception",
    people_involved: [{ employee_id: ownerEmp.id, name: `Quiana Blake ${stamp}` }],
    description: "A documentation deadline was waived for one person without it going on the exception log.",
  } });
  check("it can be raised", aboutOwner.status === 201, aboutOwner.data);
  const ownerReportId = (await pool.query(
    "SELECT id FROM concern_reports WHERE reference_code = $1", [aboutOwner.data.reference_code])).rows[0].id;

  check("THE OWNER CANNOT OPEN A CONCERN NAMING HER",
    (await owner("/api/concerns/" + ownerReportId)).status === 403);
  check("and it is not in her list",
    !((await owner("/api/concerns")).data.reports || []).some((r) => r.id === ownerReportId));
  check("SHE CANNOT AUTHORIZE HERSELF TO READ IT",
    (await owner("/api/concerns/" + ownerReportId + "/authorize", { method: "POST", body: {
      user_id: ownerUser.id, reason: "It is my CRM." } })).status === 403);
  check("nor authorize anybody else on it, since she is named",
    (await owner("/api/concerns/" + ownerReportId + "/authorize", { method: "POST", body: {
      user_id: managerUser.id, reason: "Please look at this." } })).status === 403);
  check("BUT A REVIEWER WHO IS NOT NAMED CAN HANDLE IT",
    (await deputy("/api/concerns/" + ownerReportId)).status === 200);
  check("and the report knows somebody is left to review it",
    (await deputy("/api/concerns/" + ownerReportId)).data.unconflicted_reviewers >= 1);

  // ==================================================================
  section("Nothing leaks through the Message Outbox");
  // notifications_log is shown WHOLE to every admin on the Message Outbox
  // screen. A concern alert sitting there would tell an admin -- who is
  // deliberately not a reviewer -- that a concern exists, when, and who was
  // told about it.
  await pool.query("UPDATE users SET module_access = NULL WHERE email = 'scheduling@spectrumsquadlv.com'");
  const outbox = await manager("/api/notifications");
  check("an admin can see the outbox at all", outbox.status === 200);
  check("BUT NO CONCERN ALERT IS IN IT",
    !(outbox.data || []).some((n) => String(n.type || "").startsWith("concern_")),
    (outbox.data || []).filter((n) => String(n.type || "").startsWith("concern_")).map((n) => n.type));
  const ownerOutbox = await owner("/api/notifications");
  check("while the owner, who can review concerns, does see them",
    (ownerOutbox.data || []).some((n) => String(n.type || "").startsWith("concern_")),
    (ownerOutbox.data || []).map((n) => n.type).slice(0, 8));
  // Defence in depth: even if the filter above were wrong, the body says
  // nothing.
  const alerts = (await pool.query(
    "SELECT subject, body FROM notifications_log WHERE type = 'concern_review_alert'")).rows;
  check("a concern alert was actually sent", alerts.length >= 1, alerts.length);
  check("AND ITS BODY CARRIES NO DETAIL — not the type, not the people, not the text",
    alerts.every((a) => !/Leadership or Supervisor|Named Manager|Overtime was approved/.test(String(a.body || "") + String(a.subject || ""))),
    alerts.map((a) => String(a.body || "").slice(0, 160)));

  // ==================================================================
  section("Anonymity, and whether it is real");
  // The decisive test: submit anonymously from a browser that is carrying a
  // perfectly good session cookie. If the session leaks into the row, the
  // promise is a lie.
  const anon = await staff("/api/concerns/public/submit", { method: "POST", body: {
    reporting_mode: "anonymous",
    concern_type: "Retaliation Concern",
    description: "Shifts were cut the week after I raised something.",
  } });
  check("an anonymous report can be submitted", anon.status === 201, anon.data);
  const anonRow = (await pool.query(
    "SELECT * FROM concern_reports WHERE reference_code = $1", [anon.data.reference_code])).rows[0];
  check("SUBMITTED FROM A SIGNED-IN BROWSER, IT STILL STORED NO USER ID", anonRow.reporter_user_id === null, anonRow.reporter_user_id);
  check("no name", anonRow.reporter_name === null, anonRow.reporter_name);
  check("no email", anonRow.reporter_email === null, anonRow.reporter_email);
  check("and the audit trail names nobody either",
    (await pool.query("SELECT actor_id, actor_name FROM concern_report_history WHERE report_id = $1", [anonRow.id]))
      .rows.every((h) => h.actor_id === null && h.actor_name === null));
  check("the reviewer is told it is anonymous rather than shown a blank name",
    (await owner("/api/concerns/" + anonRow.id)).data.reporter === null);

  check("ANONYMITY IS REFUSED FROM INSIDE THE CRM, where the session gives it the lie",
    (await staff("/api/concerns", { method: "POST", body: {
      reporting_mode: "anonymous", concern_type: "Client Safety", description: "x" } })).status === 400);
  const inApp = await staff("/api/concerns", { method: "POST", body: {
    reporting_mode: "anonymous", concern_type: "Client Safety", description: "x" } });
  check("and says plainly that it would be confidential, not anonymous",
    /confidential rather than anonymous/i.test((inApp.data || {}).error || ""), inApp.data);

  // ==================================================================
  section("The reference code is a receipt, not a back door");
  // Written into the report first, so that a handler which returned the row
  // would visibly hand these back. Asserting against an empty review would
  // pass whether the endpoint was careful or not.
  await owner("/api/concerns/" + reportId + "/review", { method: "PATCH", body: {
    review_notes: "Spoke to both RBTs.", findings: "The approval was inconsistent.",
    corrective_action: "Overtime goes through the scheduling queue." } });
  const st = await client()("/api/concerns/public/status", { method: "POST", body: { reference_code: code } });
  check("a code with no sign-in returns the status", st.status === 200 && !!st.data.status, st.data);
  check("AND NOTHING ELSE — the reply has exactly three keys",
    JSON.stringify(Object.keys(st.data).sort()) === JSON.stringify(["status", "submitted", "updated"]),
    Object.keys(st.data));
  const flat = JSON.stringify(st.data);
  check("so none of the review reaches it",
    !/Spoke to both RBTs|inconsistent|scheduling queue|Overtime was approved/.test(flat), flat.slice(0, 300));
  check("nor the reporter", !/clinical@spectrumsquadlv/.test(flat), flat.slice(0, 300));
  check("a wrong code gets nothing",
    (await client()("/api/concerns/public/status", { method: "POST", body: { reference_code: "SQ-AAAAA-AAAAA" } })).status === 404);

  // ==================================================================
  section("Reviewing");
  const assigned = await owner("/api/concerns/" + reportId + "/assign", { method: "POST", body: { user_id: ownerUser.id } });
  check("an unconflicted reviewer can be assigned", assigned.status === 200, assigned.data);
  check("closing with no resolution is refused — a closed concern has to say what happened",
    (await owner("/api/concerns/" + reportId + "/status", { method: "POST", body: { status: "Closed" } })).status === 400);
  const closed = await owner("/api/concerns/" + reportId + "/status", { method: "POST", body: {
    status: "Resolved", resolution: "Overtime approval now goes through the scheduling queue, applied to everyone." } });
  check("and with one, it closes", closed.status === 200 && closed.data.status === "Resolved", closed.data);
  check("recording when and by whom", !!closed.data.closed_at && !!closed.data.closed_by);
  check("an invented status is refused",
    (await owner("/api/concerns/" + reportId + "/status", { method: "POST", body: { status: "Dismissed" } })).status === 400);

  // Somebody interviewed about a concern is also somebody the concern touches.
  const iv = await owner("/api/concerns/" + anonRow.id + "/interviews", { method: "POST", body: { employee_id: emp.id } });
  check("an interview can be recorded", iv.status === 200, iv.data);
  await pool.query("UPDATE users SET module_access = '{\"concern_review\":true}' WHERE email = 'scheduling@spectrumsquadlv.com'");
  check("AND BEING INTERVIEWED ALSO EXCLUDES THEM FROM READING IT",
    (await manager("/api/concerns/" + anonRow.id)).status === 403);

  // ==================================================================
  section("Deleting, and the permission being a permission");
  check("there is no delete endpoint for a concern",
    (await owner("/api/concerns/" + reportId, { method: "DELETE" })).status === 404);
  await pool.query("UPDATE users SET module_access = NULL WHERE email = 'billing@spectrumsquadlv.com'");
  check("without the grant, a reviewer is refused", (await deputy("/api/concerns")).status === 403);
  await pool.query("UPDATE users SET module_access = '{\"concern_review\":true}' WHERE email = 'billing@spectrumsquadlv.com'");
  check("WITH IT, A NAMED GRANT IS ENOUGH — no title required", (await deputy("/api/concerns")).status === 200);
  // The deny beats everything, including being the owner. That is what makes
  // this a permission rather than a rank.
  await pool.query("UPDATE users SET module_access = '{\"concern_review\":false}' WHERE email = 'admin@spectrumsquadlv.com'");
  check("AN EXPLICIT DENY TAKES IT AWAY FROM THE OWNER HERSELF",
    (await owner("/api/concerns")).status === 403);
  await pool.query("UPDATE users SET module_access = NULL WHERE email = 'admin@spectrumsquadlv.com'");
  check("and removing the deny gives it back", (await owner("/api/concerns")).status === 200);

  // ==================================================================
  section("Nothing reaches the unauthenticated that should not");
  const anonC = client();
  check("the dashboard needs a session", (await anonC("/api/concerns")).status === 401);
  check("a report needs a session", (await anonC("/api/concerns/" + reportId)).status === 401);
  check("the reviewer list needs a session", (await anonC("/api/concerns/reviewers?report_id=" + reportId)).status === 401);
  const pub = await anonC("/api/concerns/public/options");
  check("the public form options are reachable", pub.status === 200);
  check("and carry staff names for the picker but NOT their email addresses",
    (pub.data.staff || []).length > 0 && (pub.data.staff || []).every((s) => !("email" in s)),
    (pub.data.staff || []).slice(0, 2));

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
