// Policy change requests, and the exception log.
//
// Almost everything here is about one sentence: SUBMITTING A REQUEST DOES NOT
// CHANGE THE POLICY. That is easy to say and easy to lose, because every
// obvious convenience breaks it -- a status dropdown that happens to contain
// "Approved", a PATCH that takes any field, a request that writes back to the
// policy it names. So the suite goes looking for those specifically:
//
//   * the policy's own text, version and status are read before and after a
//     request is raised, approved and implemented, and compared
//   * "Approved" cannot be reached through the status editor at all -- only
//     through the decision endpoint, which refuses to save without a written
//     response
//   * DECIDING is proved to be a narrower permission than REVIEWING, using a
//     real 'admin' account rather than an argument about role names
//   * an emergency cannot be declared by the person filling in the form, and
//     cannot be declared without naming grounds
//   * "Implemented" cannot be reached from a declined request, because that
//     would assert the rule changed when it did not
//
// The exception log is the other half of the same question. What is asserted
// there is completeness and permanence: a reason and an authorising person are
// mandatory, expiry is computed rather than swept, and an exception can be
// withdrawn but never deleted.
//
//   DATABASE_URL=... PORT=3011 node server.js
//   BASE=http://127.0.0.1:3011 node test-policy-change-requests.js
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
  const owner = client();      // owner -> can decide
  const staff = client();      // clinical -> can only submit
  const reviewer = client();   // promoted to 'admin' -> can review, must NOT decide
  const other = client();      // a second ordinary staffer

  check("owner signs in", await login(owner, "admin@spectrumsquadlv.com", "TestOwner123!") === 200);
  check("staff signs in", await login(staff, "clinical@spectrumsquadlv.com", "TestStaff123!") === 200);
  check("a second staffer signs in", await login(other, "intake@spectrumsquadlv.com", "TestStaff123!") === 200);

  // A real operational admin, not an argument about what 'admin' means. The
  // whole point of the decide/review split is that this account is trusted to
  // run the queue and is still not allowed to change a rule.
  await pool.query("UPDATE users SET role = 'admin' WHERE email = 'scheduling@spectrumsquadlv.com'");
  check("an operational admin signs in", await login(reviewer, "scheduling@spectrumsquadlv.com", "TestOwner123!") === 200);

  // The policy everything will be aimed at.
  const pol = (await owner("/api/policies", { method: "POST", body: {
    title: `Session Note Timeliness ${stamp}`, doc_kind: "policy", category: "Session Notes & Documentation",
    doc_number: `POL-T-${stamp}`, department: "Clinical",
    body: "Session notes must be submitted within 24 hours of the session.",
  } })).data;
  check("a policy exists to aim requests at", !!pol.id, pol);

  // Body, version, status and the count of amendment memos: the four ways the
  // rule in force could have moved. All read straight from the table rather
  // than through the API, so a shaping bug cannot hide a real change.
  const policySnapshot = async () => {
    const r = await pool.query("SELECT body, version, status FROM crm_policies WHERE id = $1", [pol.id]);
    const a = await pool.query("SELECT COUNT(*)::int AS n FROM crm_policy_amendments WHERE policy_id = $1", [pol.id]);
    return { ...r.rows[0], amendments: a.rows[0].n };
  };
  const before = await policySnapshot();

  // ==================================================================
  section("Anyone can ask, and asking lands in the monthly queue");
  const mine = await staff("/api/policy-changes", { method: "POST", body: {
    policy_id: pol.id, request_type: "modify",
    requested_change: "Allow 48 hours instead of 24.",
    reason: "In-home sessions often end after the clinic closes.",
    problem_solved: "Notes are late through no fault of the clinician.",
    impact_areas: ["Clinical Operations", "Compliance"],
    impact_other: "Payer audit sampling",
    department: "Clinical",
  } });
  check("a staff member can raise a request", mine.status === 201, mine.data);
  const reqId = mine.data && mine.data.id;
  check("IT AUTOMATICALLY ENTERS PENDING MONTHLY REVIEW",
    mine.data.status === "Pending Monthly Review", mine.data.status);
  const thisCycle = new Date().toISOString().slice(0, 7);
  check("stamped with the review cycle it belongs to", mine.data.review_cycle === thisCycle,
    { got: mine.data.review_cycle, want: thisCycle });
  check("the impact areas are kept", (mine.data.impact_areas || []).length === 2, mine.data.impact_areas);
  check("and the free-text 'other' impact alongside them", mine.data.impact_other === "Payer audit sampling");
  check("the submission is in the audit trail",
    (mine.data.history || []).some((h) => h.action === "submitted"), mine.data.history);

  check("a request with no reason is refused",
    (await staff("/api/policy-changes", { method: "POST", body: {
      policy_id: pol.id, request_type: "modify", requested_change: "x" } })).status === 400);
  check("a modify request with no policy is refused",
    (await staff("/api/policy-changes", { method: "POST", body: {
      request_type: "modify", requested_change: "x", reason: "y" } })).status === 400);
  check("a create request with no proposed name is refused",
    (await staff("/api/policy-changes", { method: "POST", body: {
      request_type: "create", requested_change: "x", reason: "y" } })).status === 400);
  const newPolReq = await staff("/api/policy-changes", { method: "POST", body: {
    request_type: "create", proposed_title: `Remote Supervision Policy ${stamp}`,
    requested_change: "Set out when supervision may be remote.", reason: "Nothing covers it today." } });
  check("asking for a policy that does not exist yet needs no policy_id", newPolReq.status === 201, newPolReq.data);

  // ==================================================================
  section("THE POLICY ITSELF HAS NOT MOVED");
  const afterSubmit = await policySnapshot();
  check("THE POLICY TEXT IS UNCHANGED BY A REQUEST", afterSubmit.body === before.body);
  check("its version is unchanged", String(afterSubmit.version) === String(before.version),
    { before: before.version, after: afterSubmit.version });
  check("its status is unchanged", afterSubmit.status === before.status);
  check("no amendment memo appeared", afterSubmit.amendments === before.amendments,
    { before: before.amendments, after: afterSubmit.amendments });
  const readBack = await staff("/api/policies/library");
  const livePol = (readBack.data.policies || []).filter((p) => p.id === pol.id)[0];
  check("and staff reading the library still see the original rule",
    /within 24 hours/.test(livePol.body || ""), (livePol.body || "").slice(0, 120));

  // ==================================================================
  section("Who sees what");
  const staffList = await staff("/api/policy-changes");
  check("a staff member sees their own requests", (staffList.data.requests || []).some((r) => r.id === reqId));
  check("and is told they may not review", staffList.data.can_review === false, staffList.data.can_review);
  const otherList = await other("/api/policy-changes");
  check("ANOTHER STAFF MEMBER DOES NOT SEE SOMEBODY ELSE'S REQUEST",
    !(otherList.data.requests || []).some((r) => r.id === reqId),
    (otherList.data.requests || []).map((r) => r.id));
  check("nor can they open it directly", (await other("/api/policy-changes/" + reqId)).status === 403);
  check("the requester can open their own", (await staff("/api/policy-changes/" + reqId)).status === 200);
  const revList = await reviewer("/api/policy-changes");
  check("a reviewer sees everything", (revList.data.requests || []).some((r) => r.id === reqId));
  check("with the queue counts the review needs", (revList.data.counts || {}).awaiting >= 2, revList.data.counts);
  check("counted for the current cycle", (revList.data.counts || {}).this_cycle >= 2, revList.data.counts);

  // ==================================================================
  section("Reviewing is not deciding");
  const assign = await reviewer("/api/policy-changes/" + reqId, { method: "PATCH", body: {
    assigned_reviewer: "Quiana Blake", status: "Under Review" } });
  check("a reviewer can assign and move a request along", assign.status === 200, assign.data);
  check("the assignment is recorded", assign.data.assigned_reviewer === "Quiana Blake");
  check("and both acts are in the audit trail",
    (assign.data.history || []).some((h) => h.action === "assigned") &&
    (assign.data.history || []).some((h) => h.action === "status_change"), assign.data.history);

  // THE central permission assertion of the module.
  const sneak = await reviewer("/api/policy-changes/" + reqId, { method: "PATCH", body: { status: "Approved" } });
  check("AN APPROVAL CANNOT BE SET THROUGH THE STATUS EDITOR", sneak.status === 400, sneak);
  check("and it says to record a decision instead", /decision/i.test((sneak.data || {}).error || ""), sneak.data);
  const sneak2 = await owner("/api/policy-changes/" + reqId, { method: "PATCH", body: { status: "Approved" } });
  check("not even by the owner — the decision endpoint is the only door", sneak2.status === 400, sneak2);

  const revDecide = await reviewer("/api/policy-changes/" + reqId + "/decide", { method: "POST", body: {
    decision: "Approve", decision_notes: "Fine by me." } });
  check("AN OPERATIONAL ADMIN CANNOT DECIDE A POLICY CHANGE", revDecide.status === 403, revDecide);
  check("nor can a staff member", (await staff("/api/policy-changes/" + reqId + "/decide",
    { method: "POST", body: { decision: "Approve", decision_notes: "yes" } })).status === 403);
  check("a reviewer is told they cannot decide",
    (await reviewer("/api/policy-changes/options")).data.can_decide === false);
  check("the owner is told they can", (await owner("/api/policy-changes/options")).data.can_decide === true);

  // A deferral that keeps its original cycle stamp drops out of every later
  // month's list, which is exactly what a deferral must not mean.
  await pool.query("UPDATE policy_change_requests SET review_cycle = '2020-01' WHERE id = $1", [reqId]);
  const requeued = await reviewer("/api/policy-changes/" + reqId, { method: "PATCH", body: { status: "Pending Monthly Review" } });
  check("PUTTING A REQUEST BACK IN THE QUEUE RE-STAMPS THE CYCLE, so a deferral does not bury it",
    requeued.data.review_cycle === thisCycle, { got: requeued.data.review_cycle, want: thisCycle });
  // The other half, and it has to be set up the same way or it proves nothing:
  // moving a request along inside the queue must NOT re-stamp it, otherwise
  // every request looks like it arrived this month.
  await pool.query("UPDATE policy_change_requests SET review_cycle = '2020-01' WHERE id = $1", [reqId]);
  await reviewer("/api/policy-changes/" + reqId, { method: "PATCH", body: { status: "Under Review" } });
  check("while merely moving it along leaves the cycle alone",
    (await reviewer("/api/policy-changes/" + reqId)).data.review_cycle === "2020-01",
    (await reviewer("/api/policy-changes/" + reqId)).data.review_cycle);
  await pool.query("UPDATE policy_change_requests SET review_cycle = $2 WHERE id = $1", [reqId, thisCycle]);

  // ==================================================================
  section("A decision has to say something");
  check("a decision with no written response is refused",
    (await owner("/api/policy-changes/" + reqId + "/decide", { method: "POST", body: {
      decision: "Approve", decision_notes: "   " } })).status === 400);
  check("and a response with no decision is refused",
    (await owner("/api/policy-changes/" + reqId + "/decide", { method: "POST", body: {
      decision_notes: "Sounds good" } })).status === 400);
  const decided = await owner("/api/policy-changes/" + reqId + "/decide", { method: "POST", body: {
    decision: "Approve With Modification",
    decision_notes: "Approved at 36 hours, not 48, to stay inside the payer's audit window.",
    effective_date: "2026-11-01", requires_acknowledgment: true, requires_training: false } });
  check("the owner can decide", decided.status === 200, decided.data);
  check("the decision maps to its own status", decided.data.status === "Approved With Modification", decided.data.status);
  check("the written response is stored", /36 hours/.test(decided.data.decision_notes || ""));
  check("with an effective date", decided.data.effective_date === "2026-11-01");
  check("and the acknowledgment requirement", decided.data.requires_acknowledgment === true);
  check("and who decided it, and when", !!decided.data.decided_by && !!decided.data.decision_date, decided.data);
  check("the decision is in the audit trail",
    (decided.data.history || []).some((h) => h.action === "decided" && /36 hours/.test(h.note || "")), decided.data.history);

  // ==================================================================
  section("APPROVED IS NOT PUBLISHED");
  const afterApprove = await policySnapshot();
  check("THE POLICY TEXT IS STILL UNCHANGED AFTER AN APPROVAL", afterApprove.body === before.body,
    { before: before.body, after: afterApprove.body });
  check("its version is still unchanged", String(afterApprove.version) === String(before.version));
  check("and no amendment memo was published", afterApprove.amendments === before.amendments,
    { before: before.amendments, after: afterApprove.amendments });
  const staffRead = await staff("/api/policies/library");
  const stillLive = (staffRead.data.policies || []).filter((p) => p.id === pol.id)[0];
  check("STAFF READING THE POLICY STILL GET THE 24-HOUR RULE",
    /within 24 hours/.test(stillLive.body || "") && !/36 hours/.test(stillLive.body || ""),
    (stillLive.body || "").slice(0, 160));
  check("the request still reports itself as awaiting publication",
    decided.data.status === "Approved With Modification" && decided.data.implemented_at == null);

  // ==================================================================
  section("Implementing is a separate, deliberate act");
  check("a reviewer cannot mark a change implemented",
    (await reviewer("/api/policy-changes/" + reqId + "/implement", { method: "POST", body: {} })).status === 403);
  const impl = await owner("/api/policy-changes/" + reqId + "/implement", { method: "POST", body: {} });
  check("the owner can", impl.status === 200 && impl.data.status === "Implemented", impl.data);
  check("recording when and by whom", !!impl.data.implemented_at && !!impl.data.implemented_by);

  const declined = await staff("/api/policy-changes", { method: "POST", body: {
    policy_id: pol.id, request_type: "discontinue", requested_change: "Drop the rule entirely.",
    reason: "I do not like it." } });
  await owner("/api/policy-changes/" + declined.data.id + "/decide", { method: "POST", body: {
    decision: "Decline", decision_notes: "The payer requires a documented timeliness standard." } });
  const badImpl = await owner("/api/policy-changes/" + declined.data.id + "/implement", { method: "POST", body: {} });
  check("A DECLINED REQUEST CANNOT BE MARKED IMPLEMENTED", badImpl.status === 400, badImpl);
  check("and it says why", /approved/i.test((badImpl.data || {}).error || ""), badImpl.data);

  const undecided = await staff("/api/policy-changes", { method: "POST", body: {
    policy_id: pol.id, request_type: "modify", requested_change: "Clarify weekend sessions.",
    reason: "Weekends are ambiguous." } });
  check("nor can an undecided one",
    (await owner("/api/policy-changes/" + undecided.data.id + "/implement", { method: "POST", body: {} })).status === 400);

  // ==================================================================
  section("The emergency route is a door, not a shortcut");
  const emReq = undecided.data;
  check("a requester cannot declare their own request an emergency",
    (await staff("/api/policy-changes/" + emReq.id + "/emergency", { method: "POST", body: {
      grounds: "Safety", reason: "It is urgent to me." } })).status === 403);
  check("neither can an operational admin",
    (await reviewer("/api/policy-changes/" + emReq.id + "/emergency", { method: "POST", body: {
      grounds: "Safety", reason: "Needed now." } })).status === 403);
  check("a form cannot smuggle one in on submission",
    (await staff("/api/policy-changes", { method: "POST", body: {
      policy_id: pol.id, request_type: "modify", requested_change: "x", reason: "y",
      is_emergency: true, status: "Approved" } })).data.is_emergency === false);
  check("an emergency with no named grounds is refused",
    (await owner("/api/policy-changes/" + emReq.id + "/emergency", { method: "POST", body: {
      reason: "Cannot wait." } })).status === 400);
  check("an invented ground is refused",
    (await owner("/api/policy-changes/" + emReq.id + "/emergency", { method: "POST", body: {
      grounds: "Because I said so", reason: "Cannot wait." } })).status === 400);
  check("and one with grounds but no reason is refused",
    (await owner("/api/policy-changes/" + emReq.id + "/emergency", { method: "POST", body: {
      grounds: "Compliance" } })).status === 400);
  const em = await owner("/api/policy-changes/" + emReq.id + "/emergency", { method: "POST", body: {
    grounds: "Payer requirement", reason: "Silver Summit changed the note deadline effective immediately." } });
  check("executive leadership can start one", em.status === 200, em.data);
  check("it is flagged", em.data.is_emergency === true);
  check("the grounds and the reason are both kept",
    em.data.emergency_grounds === "Payer requirement" && /Silver Summit/.test(em.data.emergency_reason || ""));
  check("and who declared it", !!em.data.emergency_by && !!em.data.emergency_at);
  check("LOGGED AS ITS OWN ACT, so bypasses of the monthly cycle can be counted",
    (em.data.history || []).some((h) => h.action === "emergency_declared" && /Payer requirement/.test(h.note || "")),
    em.data.history);
  check("an emergency STILL does not change the policy", (await policySnapshot()).body === before.body);
  check("and it is counted separately in the queue",
    ((await owner("/api/policy-changes")).data.counts || {}).emergency >= 1);

  // ==================================================================
  section("Supporting documentation reuses the policy document library");
  // The importer refuses a file that does not read as prose -- that is the
  // guard that keeps garbled PDFs out of the library -- so the fixture is real
  // prose rather than four headline lines.
  const bulletin = [
    "Silver Summit Health Plan provider bulletin for the network.",
    "Effective immediately, the submission deadline for session documentation is changing for all of the providers in the network, and this notice is the record of that change.",
    "Any provider that delivers a service to a member will be expected to submit the completed session note for that service within thirty-six hours of the end of the session, and the note is not considered submitted until it is in the portal.",
    "The previous guidance that was issued to the network is superseded by this notice, and any employee of a provider agency that is not able to meet the deadline will need to contact the plan for a review of the account.",
    "Questions about this notice and about the deadline that is set out in it can be directed to the provider relations team, and the team will respond to any question that is sent in with the account number for the agency.",
  ].join("\n\n");
  const docRes = await owner("/api/policies/documents", { method: "POST", body: {
    title: `Silver Summit bulletin ${stamp}`, filename: "bulletin.txt",
    content_base64: Buffer.from(bulletin, "utf8").toString("base64") } });
  const doc = (docRes.data || {}).document || {};
  check("a reference document is in the policy document library", !!doc.id, docRes.data);
  const attach = await staff("/api/policy-changes/" + emReq.id + "/documents", { method: "POST", body: { document_id: doc.id } });
  check("the requester can cite a document on their own open request", attach.status === 200, attach.data);
  check("and it comes back on the request", (attach.data.documents || []).some((d) => d.id === doc.id), attach.data.documents);
  check("a document that is not in the library is refused",
    (await staff("/api/policy-changes/" + emReq.id + "/documents", { method: "POST", body: { document_id: 999999 } })).status === 404);
  // Rejected rather than passed through: a non-numeric id reaches Postgres as
  // NaN, whose rejection lands outside the dispatch chain and kills the
  // process. One bad request should not take the CRM down.
  const junkDoc = await staff("/api/policy-changes/" + emReq.id + "/documents", { method: "POST", body: { document_id: "../../etc/passwd" } });
  check("A NON-NUMERIC DOCUMENT ID IS REFUSED, NOT HANDED TO THE DATABASE", junkDoc.status === 400, junkDoc);
  check("and the server is still up afterwards", (await staff("/api/policy-changes")).status === 200);
  check("somebody else's request cannot be attached to",
    (await other("/api/policy-changes/" + emReq.id + "/documents", { method: "POST", body: { document_id: doc.id } })).status === 403);
  check("ONCE DECIDED, THE REQUESTER CAN NO LONGER CHANGE WHAT IT WAS DECIDED ON",
    (await staff("/api/policy-changes/" + reqId + "/documents", { method: "POST", body: { document_id: doc.id } })).status === 403);
  check("but a reviewer still can",
    (await reviewer("/api/policy-changes/" + reqId + "/documents", { method: "POST", body: { document_id: doc.id } })).status === 200);

  // ==================================================================
  section("The exception log: complete, or not recorded");
  check("a staff member cannot record an exception",
    (await staff("/api/policy-exceptions", { method: "POST", body: {
      policy_id: pol.id, reason: "r", authorized_by: "me" } })).status === 403);
  check("an exception with no reason is refused",
    (await owner("/api/policy-exceptions", { method: "POST", body: {
      policy_id: pol.id, authorized_by: "Quiana Blake", employee_names: ["Ada Reyes"] } })).status === 400);
  check("an exception with nobody authorising it is refused",
    (await owner("/api/policy-exceptions", { method: "POST", body: {
      policy_id: pol.id, reason: "Because", employee_names: ["Ada Reyes"] } })).status === 400);
  check("an exception that covers nobody and no situation is refused",
    (await owner("/api/policy-exceptions", { method: "POST", body: {
      policy_id: pol.id, reason: "Because", authorized_by: "Quiana Blake" } })).status === 400);
  check("a request naming a non-numeric policy is refused rather than crashing",
    (await staff("/api/policy-changes", { method: "POST", body: {
      policy_id: "abc", request_type: "modify", requested_change: "x", reason: "y" } })).status === 400);
  check("an exception to a policy that does not exist is refused",
    (await owner("/api/policy-exceptions", { method: "POST", body: {
      policy_id: 999999, reason: "Because", authorized_by: "Q", employee_names: ["X"] } })).status === 404);

  const ex = await owner("/api/policy-exceptions", { method: "POST", body: {
    policy_id: pol.id, employee_names: ["Ada Reyes"],
    reason: "Ada covers the late in-home block and the clinic portal is closed by the time she finishes.",
    authorized_by: "Quiana Blake", start_date: "2026-10-01", end_date: "2026-12-31" } });
  check("a complete exception is recorded", ex.status === 201, ex.data);
  check("naming the policy it departs from", ex.data.policy && ex.data.policy.id === pol.id);
  check("who it covers", (ex.data.employee_names || [])[0] === "Ada Reyes");
  check("who authorized it", ex.data.authorized_by === "Quiana Blake");
  check("and it starts Active", ex.data.status === "Active", ex.data.status);
  check("recorded in its own audit trail", (ex.data.history || []).some((h) => h.action === "recorded"));

  check("AN EXCEPTION DOES NOT CHANGE THE POLICY EITHER", (await policySnapshot()).body === before.body);

  const openEnded = await owner("/api/policy-exceptions", { method: "POST", body: {
    policy_id: pol.id, situation: "After-hours coverage at the Henderson clinic",
    reason: "No admin on site after 7pm.", authorized_by: "Quiana Blake" } });
  check("an exception with no end date is allowed", openEnded.status === 201);
  check("BUT FLAGGED AS OPEN-ENDED, because a permanent exception is a policy by another name",
    openEnded.data.open_ended === true, openEnded.data);
  check("and counted as such", ((await owner("/api/policy-exceptions")).data.counts || {}).open_ended >= 1);

  // Expiry is computed on read. Written directly to the past so the assertion
  // does not depend on a sweep having run.
  await pool.query("UPDATE policy_exceptions SET end_date = '2020-01-01' WHERE id = $1", [ex.data.id]);
  const expired = await owner("/api/policy-exceptions/" + ex.data.id);
  check("AN EXCEPTION PAST ITS END DATE READS AS EXPIRED WITHOUT ANY JOB RUNNING",
    expired.data.status === "Expired", expired.data.status);
  check("while the row itself still says what was stored", expired.data.stored_status === "Active", expired.data);

  // ==================================================================
  section("Executive approval, and withdrawal that leaves a record");
  const needsExec = await reviewer("/api/policy-exceptions", { method: "POST", body: {
    policy_id: pol.id, employee_names: ["Ben Okafor"], reason: "Standing arrangement for the overnight block.",
    authorized_by: "Scheduling Staff", executive_approval_required: true } });
  check("an operational admin can record an exception", needsExec.status === 201, needsExec.data);
  check("flagged as needing executive approval", needsExec.data.executive_approval_required === true);
  check("which it does not yet have", !needsExec.data.executive_approved_at);
  check("and is counted as awaiting it",
    ((await owner("/api/policy-exceptions")).data.counts || {}).awaiting_exec >= 1);
  check("AN OPERATIONAL ADMIN CANNOT GIVE THEIR OWN EXCEPTION EXECUTIVE APPROVAL",
    (await reviewer("/api/policy-exceptions/" + needsExec.data.id + "/executive-approval",
      { method: "POST", body: {} })).status === 403);
  const execOk = await owner("/api/policy-exceptions/" + needsExec.data.id + "/executive-approval",
    { method: "POST", body: {} });
  check("executive leadership can", execOk.status === 200 && !!execOk.data.executive_approved_at, execOk.data);
  check("and it is on the record", (execOk.data.history || []).some((h) => h.action === "executive_approved"));

  check("withdrawing with no reason is refused",
    (await owner("/api/policy-exceptions/" + openEnded.data.id + "/revoke", { method: "POST", body: {} })).status === 400);
  const revoked = await owner("/api/policy-exceptions/" + openEnded.data.id + "/revoke",
    { method: "POST", body: { reason: "An admin now covers the evening block." } });
  check("an exception can be withdrawn", revoked.status === 200 && revoked.data.status === "Revoked", revoked.data);
  check("WITHDRAWN, NOT DELETED — the row is still readable",
    (await owner("/api/policy-exceptions/" + openEnded.data.id)).status === 200);
  check("with the reason it was withdrawn", /evening block/.test(revoked.data.revoke_reason || ""));
  check("and who withdrew it", !!revoked.data.revoked_by && !!revoked.data.revoked_at);
  check("THERE IS NO DELETE ENDPOINT AT ALL",
    (await owner("/api/policy-exceptions/" + openEnded.data.id, { method: "DELETE" })).status === 404);
  check("and none for a change request either",
    (await owner("/api/policy-changes/" + reqId, { method: "DELETE" })).status === 404);

  // ==================================================================
  section("Editing an exception is logged, and cannot empty it");
  check("the reason cannot be emptied",
    (await owner("/api/policy-exceptions/" + needsExec.data.id, { method: "PATCH", body: { reason: "  " } })).status === 400);
  const edited = await owner("/api/policy-exceptions/" + needsExec.data.id, { method: "PATCH", body: {
    end_date: "2027-03-31" } });
  check("an end date can be added later", edited.status === 200 && edited.data.end_date === "2027-03-31", edited.data);
  check("no longer open-ended", edited.data.open_ended === false);
  check("and the edit names what changed",
    (edited.data.history || []).some((h) => h.action === "edited" && /2027-03-31/.test(h.note || "")), edited.data.history);

  // ==================================================================
  section("Nothing leaks to the unauthenticated");
  const anon = client();
  check("the request list needs a session", (await anon("/api/policy-changes")).status === 401);
  check("the exception list needs a session", (await anon("/api/policy-exceptions")).status === 401);
  check("submitting needs a session", (await anon("/api/policy-changes", { method: "POST", body: {
    policy_id: pol.id, request_type: "modify", requested_change: "x", reason: "y" } })).status === 401);

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
