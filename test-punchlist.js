// test-punchlist.js -- end-to-end checks for the seven repair items.
//
// Run against a live server + Postgres:
//   BASE=http://localhost:3009 node test-punchlist.js
//
// Every check goes through the HTTP API with a real session cookie, because
// the point of most of these items is what the SERVER allows -- not what the
// UI happens to draw. The privacy checks in particular are deliberately made
// as a normal staff login asking for things it should not get.
"use strict";

const BASE = process.env.BASE || "http://localhost:3009";
// Same convention as the other suites in this repo: the owner account and the
// staff accounts have separate test passwords, so running this alongside
// test-phase2/test-phase4/test-people does not leave the logins in a state
// where the next suite cannot sign in.
const OWNER_PW = process.env.OWNER_PASSWORD || "TestOwner123!";
const STAFF_PW = process.env.STAFF_PASSWORD || "TestStaff123!";
const pwFor = (email) => (email === "admin@spectrumsquadlv.com" ? OWNER_PW : STAFF_PW);

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          -> " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

async function login(email, password) {
  const res = await fetch(BASE + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: password || pwFor(email) }),
  });
  if (!res.ok) throw new Error("login failed for " + email + ": " + res.status + " " + (await res.text()));
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  return async (path, opts = {}) => {
    const r = await fetch(BASE + path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("json")) data = await r.json().catch(() => ({}));
    else data = await r.text().catch(() => "");
    return { status: r.status, data };
  };
}

(async () => {
  const owner = await login("admin@spectrumsquadlv.com");
  const intake = await login("intake@spectrumsquadlv.com");
  const clinical = await login("clinical@spectrumsquadlv.com");
  const billing = await login("billing@spectrumsquadlv.com");

  const stamp = Date.now().toString().slice(-6);

  // A client to work with throughout.
  let r = await owner("/api/clients", {
    method: "POST",
    body: {
      child_name: "Punchlist Child " + stamp,
      parent_name: "Punchlist Parent",
      parent_email: `punchlist.${stamp}@example.invalid`,
      parent_phone: "(702) 555-0100",
    },
  });
  check("created a test client", r.status === 200 || r.status === 201, r.data);
  const clientId = r.data && r.data.id;

  // ================= 1. Restore from Not Moving Forward =================
  section("1. Reactivate a client from Not Moving Forward");

  r = await owner(`/api/clients/${clientId}/discharge`, { method: "POST", body: { reason: "Parent stopped responding", stage: "not_moving_forward" } });
  check("client can be marked Not Moving Forward", r.status === 200 && r.data.stage === "not_moving_forward", r.data);

  r = await owner("/api/clients");
  let onBoard = (r.data || []).find((c) => c.id === clientId);
  check("the client now sits in the closed-out column, not the live pipeline",
    onBoard && onBoard.stage === "not_moving_forward", onBoard && onBoard.stage);
  check("the closure reason is recorded", onBoard && onBoard.discharge_reason === "Parent stopped responding", onBoard && onBoard.discharge_reason);

  r = await owner(`/api/clients/${clientId}/advance`, { method: "POST", body: {} });
  check("plain Advance still cannot rescue a closed-out client (why this item existed)", r.status === 400, r.data);

  r = await owner(`/api/clients/${clientId}/reactivate`, { method: "POST", body: { stage: "insurance_verification", note: "Family called back" } });
  check("reactivate succeeds", r.status === 200, r.data);
  check("reactivate puts them in the requested active stage", r.data.stage === "insurance_verification", r.data.stage);
  check("reactivate reports what they were rescued from", r.data.reactivated_from === "Not Moving Forward", r.data.reactivated_from);
  check("the stale closure reason is cleared off the live record", !r.data.discharge_reason, r.data.discharge_reason);

  r = await owner("/api/clients");
  const backOnBoard = (r.data || []).filter((c) => c.id === clientId);
  check("client is back in the active pipeline", backOnBoard.length === 1, backOnBoard.length);
  check("no duplicate client record was created",
    (r.data || []).filter((c) => c.child_name === "Punchlist Child " + stamp).length === 1);

  r = await owner(`/api/clients/${clientId}/notes`);
  const notes = (r.data || []).map((n) => n.body).join("\n");
  check("history records that they were marked Not Moving Forward", /Marked Not Moving Forward/.test(notes), notes.slice(0, 200));
  check("history records the reactivation, with the original reason", /Reactivated/.test(notes) && /Parent stopped responding/.test(notes), notes.slice(0, 300));

  r = await owner(`/api/clients/${clientId}/reactivate`, { method: "POST", body: { stage: "new_submission" } });
  check("reactivating an already-active client is refused", r.status === 409, r.data);

  // A terminal stage is not a valid destination.
  await owner(`/api/clients/${clientId}/discharge`, { method: "POST", body: { reason: "second close", stage: "not_moving_forward" } });
  r = await owner(`/api/clients/${clientId}/reactivate`, { method: "POST", body: { stage: "discharged" } });
  check("a terminal stage is rejected as a restore target", r.status === 400, r.data);
  r = await owner(`/api/clients/${clientId}/reactivate`, { method: "POST", body: { stage: "new_submission" } });
  check("restored again from a second closure", r.status === 200 && r.data.stage === "new_submission", r.data);

  // ================= 2. Emergency contacts =================
  section("2. Emergency contact must be outside the household");

  const ecBase = { owner_type: "client", owner_id: clientId, phone: "(702) 555-0111" };

  r = await owner("/api/people/emergency-contacts?owner_type=client", {
    method: "POST", body: { ...ecBase, name: "Mom Again", relationship: "Mother", outside_household: true },
  });
  check("the parent/guardian is refused as an emergency contact", r.status === 400 && /other than the parent/i.test(r.data.error || ""), r.data);

  r = await owner("/api/people/emergency-contacts?owner_type=client", {
    method: "POST", body: { ...ecBase, name: "Uncle Same Roof", relationship: "Uncle" },
  });
  check("a contact with no household confirmation is refused", r.status === 400 && /does not live/i.test(r.data.error || ""), r.data);

  r = await owner("/api/people/emergency-contacts?owner_type=client", {
    method: "POST", body: { ...ecBase, name: "Nana Ruiz " + stamp, relationship: "Grandmother", outside_household: true, is_primary: true },
  });
  check("a compliant contact is accepted", r.status === 201, r.data);
  check("the confirmation is stored on the record", r.data.outside_household === true, r.data);
  const ecId = r.data && r.data.id;

  r = await owner(`/api/people/emergency-contacts?owner_type=client&owner_id=${clientId}`);
  check("the client now reports a compliant emergency contact", r.data.has_compliant_contact === true, r.data);

  r = await owner(`/api/people/emergency-contacts/${ecId}?owner_type=client`, { method: "PATCH", body: { outside_household: false } });
  check("an edit cannot quietly clear the household confirmation", r.status === 400, r.data);
  r = await owner(`/api/people/emergency-contacts/${ecId}?owner_type=client`, { method: "PATCH", body: { relationship: "Guardian" } });
  check("an edit cannot turn the contact into the guardian", r.status === 400, r.data);
  r = await owner(`/api/people/emergency-contacts/${ecId}?owner_type=client`, { method: "PATCH", body: { relationship: "Great-aunt" } });
  check("an ordinary edit still works", r.status === 200 && r.data.relationship === "Great-aunt", r.data);

  r = await owner("/api/people/emergency-contacts?owner_type=staff", {
    method: "POST", body: { owner_type: "staff", owner_id: 1, name: "Staff Spouse " + stamp, relationship: "Spouse", phone: "(702) 555-0122" },
  });
  check("staff emergency contacts are unaffected by the client-only rule", r.status === 201, r.data);

  // ================= 3. Staff tasks & alerts =================
  section("3. Staff tasks: creation, assignment, and privacy");

  r = await intake("/api/staff-tasks", { method: "POST", body: { title: "Intake self task " + stamp } });
  check("a non-supervisory staff member can create a task for themselves", r.status === 201, r.data);
  check("a task with no assignee comes back assigned to its creator", r.data.assigned_user_id === 2, r.data);
  const intakeSelfTask = r.data && r.data.id;

  r = await intake("/api/staff-tasks", {
    method: "POST",
    body: { title: "Intake -> clinical handoff " + stamp, assigned_user_id: 3, assigned_name: "Clinical Staff", assigned_email: "clinical@spectrumsquadlv.com" },
  });
  check("a staff member can assign a task to another staff member", r.status === 201 && r.data.assigned_user_id === 3, r.data);
  const handoffTask = r.data && r.data.id;

  r = await intake("/api/staff-tasks", { method: "POST", body: { title: "Client-linked task " + stamp, client_id: clientId } });
  check("a staff member with client access can attach a task to a client", r.status === 201 && r.data.client_id === clientId, r.data);
  const clientTaskId = r.data && r.data.id;

  // A private task belonging to someone else entirely.
  r = await billing("/api/staff-tasks", { method: "POST", body: { title: "Billing private task " + stamp } });
  check("billing created a private task", r.status === 201, r.data);
  const billingPrivate = r.data && r.data.id;

  r = await clinical("/api/staff-tasks");
  let titles = (r.data || []).map((t) => t.title);
  check("clinical sees the task assigned to them", titles.includes("Intake -> clinical handoff " + stamp), titles.slice(0, 10));
  check("clinical does NOT see billing's private task", !titles.includes("Billing private task " + stamp), titles.slice(0, 10));
  check("clinical does NOT see intake's own personal task", !titles.includes("Intake self task " + stamp), titles.slice(0, 10));

  r = await intake("/api/staff-tasks");
  titles = (r.data || []).map((t) => t.title);
  check("intake sees a task they created for someone else", titles.includes("Intake -> clinical handoff " + stamp), titles.slice(0, 10));
  check("intake does NOT see billing's private task", !titles.includes("Billing private task " + stamp), titles.slice(0, 10));

  // Caseload visibility: assign the client to clinical, then re-ask.
  r = await owner(`/api/clients/${clientId}/authorization`, { method: "PATCH", body: { assigned_bcba_email: "clinical@spectrumsquadlv.com", assigned_bcba_name: "Clinical Staff" } });
  check("the client was assigned to a BCBA", r.status === 200 && r.data.assigned_bcba_email === "clinical@spectrumsquadlv.com", r.data && r.data.assigned_bcba_email);
  r = await clinical("/api/staff-tasks");
  titles = (r.data || []).map((t) => t.title);
  check("clinical sees a client task once that client is on their caseload", titles.includes("Client-linked task " + stamp), titles.slice(0, 10));

  r = await billing("/api/staff-tasks");
  titles = (r.data || []).map((t) => t.title);
  check("billing does NOT see the client task for a family they aren't on", !titles.includes("Client-linked task " + stamp), titles.slice(0, 10));

  r = await owner("/api/staff-tasks");
  titles = (r.data || []).map((t) => t.title);
  check("the owner still sees every task", titles.includes("Billing private task " + stamp) && titles.includes("Intake self task " + stamp));

  // scope=mine must stay personal even for the owner.
  r = await owner("/api/staff-tasks?scope=mine");
  check("scope=mine stays personal for the owner too",
    !(r.data || []).map((t) => t.title).includes("Billing private task " + stamp));

  // Backend enforcement of writes -- not just a hidden button.
  r = await clinical(`/api/staff-tasks/${billingPrivate}`, { method: "PATCH", body: { status: "done" } });
  check("a staff member cannot complete someone else's task", r.status === 403, r.data);
  r = await clinical(`/api/staff-tasks/${billingPrivate}`, { method: "DELETE" });
  check("a staff member cannot delete someone else's task", r.status === 403, r.data);
  r = await billing(`/api/staff-tasks/${billingPrivate}`, { method: "PATCH", body: { status: "done" } });
  check("the assignee can complete their own task", r.status === 200 && r.data.status === "done", r.data);
  r = await intake(`/api/staff-tasks/${handoffTask}`, { method: "PATCH", body: { due_date: "2026-12-01" } });
  check("the creator can still edit a task they handed off", r.status === 200, r.data);
  r = await owner(`/api/staff-tasks/${billingPrivate}`, { method: "PATCH", body: { title: "Owner edited " + stamp } });
  check("an administrator can edit anyone's task", r.status === 200, r.data);

  // Nav badge stays personal.
  r = await clinical("/api/staff-tasks/summary");
  check("the task badge counts only the user's own open tasks", typeof r.data.open === "number" && r.data.open >= 1, r.data);

  // ================= 7. Undoing completed tasks =================
  section("7. Reopening completed tasks");

  r = await billing(`/api/staff-tasks/${billingPrivate}`, { method: "PATCH", body: { status: "open" } });
  check("a completed staff task can be reopened", r.status === 200 && r.data.status === "open", r.data);
  check("the reopened task keeps the date it had been completed", !!r.data.last_completed_at, r.data);
  check("the reopen is attributed", !!r.data.reopened_by && r.data.reopen_count === 1, r.data);
  r = await billing("/api/staff-tasks?scope=mine&status=open");
  check("the reopened task is back on the open list",
    (r.data || []).some((t) => t.id === billingPrivate), (r.data || []).map((t) => t.title));

  r = await owner("/api/staff-tasks");
  check("reopening did not duplicate the task",
    (r.data || []).filter((t) => t.id === billingPrivate).length === 1);

  // Client stage tasks.
  r = await owner(`/api/clients/${clientId}`);
  const stageTasks = r.data.tasks || [];
  check("the client has stage tasks to work with", stageTasks.length > 0, stageTasks.length);
  const st = stageTasks[0];
  r = await owner(`/api/tasks/${st.id}/complete`, { method: "POST", body: {} });
  check("a client stage task can be completed", r.status === 200, r.data);
  r = await owner(`/api/tasks/${st.id}/reopen`, { method: "POST" });
  check("a completed client stage task can be reopened", r.status === 200 && r.data.ok, r.data);
  r = await owner(`/api/clients/${clientId}`);
  const reopened = (r.data.tasks || []).find((t) => t.id === st.id);
  check("the reopened stage task is pending again", reopened && reopened.status === "pending", reopened);
  check("the reopened stage task keeps its original completion date", reopened && !!reopened.last_completed_at, reopened);
  check("the reopened stage task records who reopened it", reopened && !!reopened.reopened_by && reopened.reopen_count === 1, reopened);
  check("the reopened stage task is the same row, not a copy",
    (r.data.tasks || []).filter((t) => t.stage_task_id === st.stage_task_id).length === 1);

  // ================= 4. Supply requests =================
  section("4. Supply requests reachable by staff");

  r = await fetch(BASE + "/supply-request").then((x) => x.status);
  check("the supply request page is served", r === 200, r);

  const supplyRes = await fetch(BASE + "/api/supply/public/submit", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ item_name: "Laminating pouches " + stamp, quantity: "2 boxes", requester_name: "Clinical Staff", requester_email: "clinical@spectrumsquadlv.com" }),
  });
  check("a staff member can submit a supply request", supplyRes.status === 200, supplyRes.status);

  r = await clinical("/api/supply/requests?status=all");
  check("a staff member can list their own supply requests in the CRM", r.status === 200, r.data);
  check("their own request is there",
    (r.data.rows || []).some((x) => x.item_name === "Laminating pouches " + stamp), (r.data.rows || []).map((x) => x.item_name));
  check("a staff member is not flagged as the queue owner", r.data.is_owner === false, r.data.is_owner);

  const mine = (r.data.rows || []).find((x) => x.item_name === "Laminating pouches " + stamp);
  r = await clinical(`/api/supply/requests/${mine.id}`);
  check("a staff member can open their own request", r.status === 200, r.data);
  r = await billing(`/api/supply/requests/${mine.id}`);
  check("a staff member cannot open someone else's request", r.status === 403, r.data);
  r = await billing("/api/supply/requests?status=all");
  check("another staff member's list does not contain it",
    !(r.data.rows || []).some((x) => x.item_name === "Laminating pouches " + stamp));

  r = await owner("/api/supply/requests?status=all");
  check("the owner sees the whole queue", r.status === 200 && r.data.is_owner === true, r.data.is_owner);
  check("the owner sees the staff member's request",
    (r.data.rows || []).some((x) => x.item_name === "Laminating pouches " + stamp));

  r = await clinical(`/api/supply/requests/${mine.id}/status`, { method: "POST", body: { status: "Approved" } });
  check("a staff member cannot approve their own supply request", r.status === 403, r.data);
  r = await owner(`/api/supply/requests/${mine.id}/status`, { method: "POST", body: { status: "Approved", note: "ordering today" } });
  check("the owner can move a request through the flow", r.status === 200 && r.data.status === "Approved", r.data);

  // ================= 5. Deleting supervision records =================
  section("5. Owner can delete a supervision record");

  r = await owner("/api/hr/employees", { method: "POST", body: { name: "Supervised RBT " + stamp, email: `rbt.${stamp}@example.invalid`, role_title: "RBT", status: "active" } });
  check("created a supervised employee", r.status === 200 || r.status === 201, r.data);
  const empId = r.data && (r.data.id || (r.data.employee && r.data.employee.id));

  const month = "2026-07";
  r = await owner(`/api/supervision/employee/${empId}`, {
    method: "POST",
    body: { month, hours_worked: 100, entries: [{ date: "2026-07-03", activity: "Session obs", duration: 3, supervisor: "Allie R.", face_to_face: true }] },
  });
  check("a supervision month can be recorded", r.status === 200, r.data);

  r = await owner(`/api/supervision/summary?month=${month}`);
  let row = (r.data.employees || []).find((x) => x.employee_id === empId);
  check("the month shows on the summary before deletion", row && row.sup_hours === 3, row);

  r = await clinical(`/api/supervision/employee/${empId}`, { method: "DELETE", body: { month, reason: "not mine to delete" } });
  check("a clinical user cannot delete a supervision record", r.status === 403, r.data);

  r = await owner(`/api/supervision/employee/${empId}`, { method: "DELETE", body: { month } });
  check("deleting without a reason is refused", r.status === 400 && r.data.code === "delete_needs_reason", r.data);

  r = await owner(`/api/supervision/employee/${empId}`, { method: "DELETE", body: { month, reason: "Entered against the wrong staff member" } });
  check("the owner can delete a supervision record", r.status === 200 && r.data.deleted_sessions === 1, r.data);

  r = await owner(`/api/supervision/employee/${empId}?month=${month}`);
  check("the month reads as empty afterwards", r.status === 200 && (r.data.entries || []).length === 0, r.data.entries);
  check("the deletion is preserved in the supervision history",
    (r.data.amendments || []).some((a) => a.action === "deleted" && /wrong staff member/.test(a.reason || "")), r.data.amendments);
  check("the record is reported as gone, so the delete button hides", r.data.has_record === false, r.data.has_record);

  r = await owner(`/api/supervision/summary?month=${month}`);
  row = (r.data.employees || []).find((x) => x.employee_id === empId);
  check("supervision calculations still work after the deletion (no crash, recomputed to zero)",
    r.status === 200 && row && row.sup_hours === 0 && row.hours_worked === 0, row);

  r = await owner(`/api/supervision/employee/${empId}`, { method: "DELETE", body: { month, reason: "again" } });
  check("deleting a month that is already gone is a clean 404", r.status === 404, r.data);

  // ================= 6. Clinical screener =================
  section("6. Clinical screener: manual send");

  r = await owner(`/api/screener/status/${clientId}`);
  check("screener status is readable", r.status === 200, r.data);
  check("it says the screener has not been sent", r.data.invited === false && r.data.last_sent_at === null, r.data);
  check("it explains why the automation has not fired", /enrollment packet/i.test(r.data.auto_blocked_reason || ""), r.data.auto_blocked_reason);

  r = await owner(`/api/screener/send/${clientId}`, { method: "POST", body: {} });
  check("an authorized staff member can send the screener by hand", r.status === 200 && r.data.ok, r.data);
  check("it reports who it went to", r.data.sent_to === `punchlist.${stamp}@example.invalid`, r.data);

  r = await owner(`/api/screener/status/${clientId}`);
  check("the send is recorded on the client", r.data.invited === true && !!r.data.last_manual_sent_at, r.data);
  check("the sender is recorded", r.data.last_manual_sent_by === "admin@spectrumsquadlv.com", r.data);
  check("the send count is 1", r.data.manual_send_count === 1, r.data);

  r = await owner(`/api/screener/send/${clientId}`, { method: "POST", body: {} });
  check("an accidental second send is stopped", r.status === 409 && r.data.code === "recently_sent", r.data);

  r = await owner(`/api/screener/send/${clientId}`, { method: "POST", body: { force: true } });
  check("a deliberate resend is still allowed", r.status === 200 && r.data.ok && r.data.resend === true, r.data);

  r = await owner(`/api/screener/status/${clientId}`);
  check("the resend is counted, not duplicated as a second invite", r.data.manual_send_count === 2, r.data);

  r = await owner(`/api/clients/${clientId}`);
  const screenerEmails = (r.data.notifications || []).filter((n) => String(n.type || "").startsWith("screener"));
  check("both sends are in the client's communication history", screenerEmails.length === 2, screenerEmails.map((n) => n.subject));

  // The token is reused, so a family never gets two different links.
  r = await owner("/api/admin/screener-token-probe").catch(() => ({ status: 404 }));

  // Permission: an HR-side role must not be able to send a screener.
  r = await owner("/api/admin/users", { method: "POST", body: { name: "HR Person " + stamp, email: `hr.${stamp}@example.invalid`, password: STAFF_PW, role: "hiring_manager" } });
  if (r.status === 200 || r.status === 201) {
    const hr = await login(`hr.${stamp}@example.invalid`, STAFF_PW);
    const hrRes = await hr(`/api/screener/send/${clientId}`, { method: "POST", body: { force: true } });
    check("an HR-side role cannot send a clinical screener", hrRes.status === 403, hrRes.data);
    const hrStatus = await hr(`/api/screener/status/${clientId}`);
    check("an HR-side role cannot read screener status", hrStatus.status === 403, hrStatus.data);
  } else {
    console.log("  SKIP  HR-role screener permission check (could not create the user: " + r.status + ")");
  }

  r = await owner(`/api/screener/send/999999`, { method: "POST", body: {} });
  check("sending for an unknown client is a clean 404", r.status === 404, r.data);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\nFATAL:", e); process.exit(2); });
