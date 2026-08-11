// Exercises the treatment-plan / authorization parent-email flow end to end
// against a live local server, the way test-people.js does.
//
//   DATABASE_URL=... node server.js         # in one shell
//   node test-treatment-plan-auth.js        # in another
//
// Emails are asserted by reading notifications_log through the API rather than
// by trusting the console, so a template that renders but never sends fails.
const BASE = process.env.BASE || "http://localhost:3009";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "admin@spectrumsquadlv.com";
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || "TestOwner123!";
let cookie = "";
let pass = 0, fail = 0;

async function req(path, { method = "GET", body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data };
}
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 400) : "")); }
}
const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

// GET /api/clients/:id answers { client, tasks, notifications }.
async function getClient(clientId) {
  const r = await req(`/api/clients/${clientId}`);
  return (r.data && r.data.client) || {};
}
// Parent-facing emails, newest FIRST -- that is the order the API returns.
async function parentEmails(clientId) {
  const r = await req(`/api/clients/${clientId}`);
  const log = (r.data && r.data.notifications) || [];
  return log.filter((n) => n.type === "parent_milestone");
}
const newest = (mails) => mails[0];
// Jump a fresh client to the Authorization stage. enterStage() creates that
// stage's tasks, which is what we actually want to exercise.
async function advanceToAuthorization(clientId) {
  await req(`/api/clients/${clientId}/advance`, { method: "POST", body: { stage: "authorization" } });
  const r = await req(`/api/clients/${clientId}`);
  return { ...(r.data.client || {}), tasks: r.data.tasks || [] };
}

(async () => {
  console.log("\n== auth ==");
  let r = await req("/api/auth/login", { method: "POST", body: { email: OWNER_EMAIL, password: OWNER_PASSWORD } });
  check("owner can sign in", r.status === 200, r.data);
  if (r.status !== 200) { console.log("\nCannot continue without a session.\n"); process.exit(1); }

  console.log("\n== email templates are registered ==");
  r = await req("/api/email-templates");
  const list = (r.data && (r.data.templates || r.data)) || [];
  const keys = list.map((t) => t.template_key);
  check("milestone_treatment_plan_submitted exists", keys.includes("milestone_treatment_plan_submitted"), keys);
  check("milestone_authorization_approved exists", keys.includes("milestone_authorization_approved"), keys);
  check("the old first-day template is still there for history", keys.includes("milestone_first_day_scheduled"));
  const retired = list.find((t) => t.template_key === "milestone_first_day_scheduled");
  check("the old template is relabelled as retired", retired && /retired/i.test(retired.label), retired && retired.label);

  r = await req("/api/email-templates/milestone_treatment_plan_submitted");
  const submittedTpl = r.data || {};
  check("submitted email offers the submitted-date merge field",
    /\{\{\s*treatment_plan_submitted_date\s*\}\}/.test(submittedTpl.body_template || ""), submittedTpl.body_template);
  check("submitted email mentions the clinical director",
    /clinical director/i.test(submittedTpl.body_template || ""), submittedTpl.body_template);
  check("submitted email does NOT claim they're approved",
    !/\bis approved\b|\bhas been approved\b|authorization is in/i.test(submittedTpl.body_template || ""), submittedTpl.body_template);

  r = await req("/api/email-templates/milestone_authorization_approved");
  const approvedTpl = r.data || {};
  check("approval email says approved", /approved/i.test(approvedTpl.body_template || ""), approvedTpl.body_template);
  check("approval email is the one that talks about the first day",
    /first day/i.test(approvedTpl.body_template || ""), approvedTpl.body_template);

  r = await req("/api/email-templates/milestone_treatment_plan_submitted/preview", { method: "POST", body: {} });
  check("submitted email previews without leaving raw {{tokens}}",
    r.status === 200 && !/\{\{/.test(JSON.stringify(r.data || {})), r.data);

  console.log("\n== a client reaches the authorization stage ==");
  const stamp = Date.now();
  r = await req("/api/clients", { method: "POST", body: {
    child_name: `TP Test ${stamp}`, parent_name: "Dana Parent", parent_email: `tp${stamp}@example.test`,
    parent_phone: "702-555-0100", insurance_payer: "Aetna",
  } });
  check("client created", r.status === 201 || r.status === 200, r.data);
  const clientId = r.data && r.data.id;
  if (!clientId) { console.log("\nNo client id; stopping.\n"); process.exit(1); }

  const atAuth = await advanceToAuthorization(clientId);
  check("client is sitting in the authorization stage", atAuth && atAuth.stage === "authorization", atAuth && atAuth.stage);
  const before = await parentEmails(clientId);
  check("no first-day email has been sent yet",
    !before.some((n) => /schedule/i.test(n.subject || "") && /first day/i.test(n.subject || "")), before.map((n) => n.subject));

  console.log("\n== marking the authorization task done ==");
  const authTask = (atAuth.tasks || []).find((t) => t.stage_key === "authorization" && t.status !== "completed");
  check("the client modal exposes the task's stage so the UI can prompt for a date", !!(authTask && authTask.stage_key), atAuth.tasks);
  const submittedDate = "2026-07-15";
  r = await req(`/api/tasks/${authTask.id}/complete`, { method: "POST", body: { treatment_plan_submitted_date: submittedDate } });
  check("task completes", r.status === 200 && r.data.ok, r.data);

  let client = await getClient(clientId);
  check("the submitted date is stored on the client", client.treatment_plan_submitted_date === submittedDate, client.treatment_plan_submitted_date);
  check("the authorization_submitted flag is set too", client.authorization_submitted === true, client.authorization_submitted);
  check("approval date is NOT set by submitting", !client.authorization_approved_date, client.authorization_approved_date);
  check("status is not silently flipped to Approved", client.authorization_status !== "Approved", client.authorization_status);

  let mails = await parentEmails(clientId);
  const submittedMail = newest(mails);
  check("a parent email went out on submit", !!submittedMail, mails.map((m) => m.subject));
  check("it is the treatment-plan email, not the first-day one",
    submittedMail && /treatment plan/i.test(submittedMail.subject || ""), submittedMail && submittedMail.subject);
  check("it names the clinical director's follow-up",
    submittedMail && /clinical director/i.test(submittedMail.body || ""), submittedMail && (submittedMail.body || "").slice(0, 300));
  check("it quotes the date the office entered, written out for a parent",
    submittedMail && /July 15, 2026/.test(submittedMail.body || ""), submittedMail && (submittedMail.body || "").slice(0, 400));
  check("it does not leak an unrendered merge token",
    submittedMail && !/\{\{/.test(submittedMail.body || ""), submittedMail && (submittedMail.body || "").slice(0, 400));
  check("it does not tell the parent they are approved",
    submittedMail && !/authorization is in|has been approved/i.test(submittedMail.body || ""), submittedMail && (submittedMail.body || "").slice(0, 400));
  check("no approval email has been sent yet",
    !mails.some((m) => /approved/i.test(m.subject || "")), mails.map((m) => m.subject));

  console.log("\n== approving the authorization ==");
  r = await req(`/api/clients/${clientId}/authorization`, { method: "PATCH", body: { authorization_status: "Approved" } });
  check("status saves", r.status === 200, r.data);
  check("the response reports that the parent was emailed", r.data && r.data.approval_email && r.data.approval_email.sent === true, r.data && r.data.approval_email);

  client = await getClient(clientId);
  check("approval date is stamped automatically", client.authorization_approved_date === today, { got: client.authorization_approved_date, today });
  check("the submitted date is left alone", client.treatment_plan_submitted_date === submittedDate, client.treatment_plan_submitted_date);

  mails = await parentEmails(clientId);
  const approvedMail = newest(mails);
  check("an approval email went out", approvedMail && /approved/i.test(approvedMail.subject || ""), approvedMail && approvedMail.subject);
  check("it invites them to schedule the first day",
    approvedMail && /first day/i.test(approvedMail.body || ""), approvedMail && (approvedMail.body || "").slice(0, 300));
  check("it renders every token", approvedMail && !/\{\{/.test(approvedMail.body || ""), approvedMail && (approvedMail.body || "").slice(0, 300));
  const approvedCount = mails.filter((m) => /approved/i.test(m.subject || "")).length;
  check("exactly one approval email so far", approvedCount === 1, approvedCount);

  console.log("\n== re-saving must not spam the family ==");
  r = await req(`/api/clients/${clientId}/authorization`, { method: "PATCH", body: { authorization_status: "Approved", auth_notes: "touched again" } });
  check("re-saving while already Approved reports no email", !(r.data && r.data.approval_email), r.data && r.data.approval_email);
  mails = await parentEmails(clientId);
  check("still exactly one approval email", mails.filter((m) => /approved/i.test(m.subject || "")).length === 1,
    mails.map((m) => m.subject));

  r = await req(`/api/clients/${clientId}/authorization`, { method: "PATCH", body: { authorization_status: "Active" } });
  r = await req(`/api/clients/${clientId}/authorization`, { method: "PATCH", body: { authorization_status: "Approved" } });
  mails = await parentEmails(clientId);
  check("moving away from Approved and back does re-send (a real second approval)",
    mails.filter((m) => /approved/i.test(m.subject || "")).length === 2, mails.map((m) => m.subject));
  client = await getClient(clientId);
  check("the original approval date is not overwritten on re-approval", client.authorization_approved_date === today, client.authorization_approved_date);

  console.log("\n== the milestone checklist can finally see an approval ==");
  check("Approved is a real, reachable status", client.authorization_status === "Approved", client.authorization_status);

  console.log("\n== completing the task without a date still works ==");
  const stamp2 = Date.now();
  r = await req("/api/clients", { method: "POST", body: {
    child_name: `TP NoDate ${stamp2}`, parent_name: "Sam Parent", parent_email: `tp2${stamp2}@example.test`, insurance_payer: "Cigna",
  } });
  const id2 = r.data && r.data.id;
  const atAuth2 = await advanceToAuthorization(id2);
  const task2 = (atAuth2.tasks || []).find((t) => t.stage_key === "authorization" && t.status !== "completed");
  r = await req(`/api/tasks/${task2.id}/complete`, { method: "POST" });
  check("bulk-style completion with no body succeeds", r.status === 200, r.data);
  const c2 = await getClient(id2);
  check("it falls back to today rather than storing nothing", c2.treatment_plan_submitted_date === today, c2.treatment_plan_submitted_date);
  const m2 = await parentEmails(id2);
  const last2 = newest(m2);
  check("the email still reads properly with the fallback date",
    last2 && !/on \./.test(last2.body || "") && !/\{\{/.test(last2.body || ""), last2 && (last2.body || "").slice(0, 300));

  console.log("\n== a client with no parent email must not break the flow ==");
  const stamp3 = Date.now();
  r = await req("/api/clients", { method: "POST", body: { child_name: `TP NoEmail ${stamp3}`, parent_name: "No Email" } });
  const id3 = r.data && r.data.id;
  const atAuth3 = await advanceToAuthorization(id3);
  const task3 = (atAuth3.tasks || []).find((t) => t.stage_key === "authorization" && t.status !== "completed");
  r = await req(`/api/tasks/${task3.id}/complete`, { method: "POST", body: { treatment_plan_submitted_date: "2026-07-01" } });
  check("completing succeeds with no parent email", r.status === 200 && r.data.ok, r.data);
  const c3 = await getClient(id3);
  check("the date is still recorded", c3.treatment_plan_submitted_date === "2026-07-01", c3.treatment_plan_submitted_date);
  r = await req(`/api/clients/${id3}/authorization`, { method: "PATCH", body: { authorization_status: "Approved" } });
  check("approving succeeds and says nothing was emailed",
    r.status === 200 && r.data.approval_email && r.data.approval_email.sent === false, r.data && r.data.approval_email);

  console.log("\n== bad input is rejected, not stored ==");
  const stamp4 = Date.now();
  r = await req("/api/clients", { method: "POST", body: { child_name: `TP Bad ${stamp4}`, parent_name: "Bad Date", parent_email: `tp4${stamp4}@example.test` } });
  const id4 = r.data && r.data.id;
  const atAuth4 = await advanceToAuthorization(id4);
  const task4 = (atAuth4.tasks || []).find((t) => t.stage_key === "authorization" && t.status !== "completed");
  r = await req(`/api/tasks/${task4.id}/complete`, { method: "POST", body: { treatment_plan_submitted_date: "not-a-date" } });
  check("a junk date does not blow up the request", r.status === 200, r.data);
  const c4 = await getClient(id4);
  check("a junk date is ignored in favour of today", c4.treatment_plan_submitted_date === today, c4.treatment_plan_submitted_date);

  console.log("\n== the date stays editable afterwards ==");
  r = await req(`/api/clients/${clientId}/authorization`, { method: "PATCH", body: { treatment_plan_submitted_date: "2026-06-30" } });
  check("the office can correct the submitted date later", r.status === 200, r.data);
  client = await getClient(clientId);
  check("the correction sticks", client.treatment_plan_submitted_date === "2026-06-30", client.treatment_plan_submitted_date);
  check("correcting the date does not re-email anyone", !(r.data && r.data.approval_email), r.data && r.data.approval_email);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\nTest run crashed:", e); process.exit(1); });
