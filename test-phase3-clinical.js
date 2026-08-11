// Phase 3 (clinical automation) integration test — run against a live server + DB.
//
//   DATABASE_URL=... node server.js
//   DATABASE_URL=... BASE=http://127.0.0.1:3009 node test-phase3-clinical.js
//
// Covers: item 1 (post-assessment email preview/send + logging), item 5
// (treatment-plan 14-day deadline + escalation ladder + stop-on-submit),
// item 4 (Authorization -> Scheduling move), item 3 (schedule-request routing).
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3009";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
let cookie = "", pass = 0, fail = 0;
async function req(path, { method = "GET", body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}
function check(n, c, d) { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d !== undefined ? "  -> " + JSON.stringify(d).slice(0, 300) : "")); } }
function isoDaysFromToday(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

(async () => {
  let r = await req("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
  check("owner signs in", r.status === 200, r.data);
  if (r.status !== 200) { process.exit(1); }

  const clients = (await req("/api/clients")).data || [];
  // Pick a client with a parent email for the email tests.
  const withEmail = clients.find((c) => c.parent_email) || clients[0];
  const cid = withEmail.id;

  console.log("\n== item 1: post-assessment / next-steps email ==");
  const badKey = await req(`/api/clients/${cid}/preview-template`, { method: "POST", body: { key: "milestone_active" } });
  check("only whitelisted templates can be previewed (others 400)", badKey.status === 400, badKey.status);
  const prev = await req(`/api/clients/${cid}/preview-template`, { method: "POST", body: { key: "post_assessment_next_steps" } });
  check("preview renders with the client's real fields", prev.status === 200 && /here's what happens next/i.test(prev.data.html || ""), prev.data && prev.data.subject);
  check("preview subject carries the child's name", prev.data && new RegExp(withEmail.child_name).test(prev.data.subject || ""), prev.data && prev.data.subject);
  const send = await req(`/api/clients/${cid}/send-template`, { method: "POST", body: { key: "post_assessment_next_steps" } });
  check("send succeeds and reports who + when", send.status === 200 && send.data.ok && send.data.sent_by && send.data.sent_at, send.data);
  const logged = (await pool.query("SELECT * FROM notifications_log WHERE client_id=$1 AND subject ILIKE '%what happens next%' ORDER BY id DESC LIMIT 1", [cid])).rows[0];
  check("the send is logged to the client's communication history", !!logged, logged && logged.subject);

  console.log("\n== item 5: treatment-plan 14-day deadline + escalation ==");
  // Put the client in the Authorization stage so it's eligible for the
  // escalation sweep (which skips active/closed) and for the move below.
  await pool.query("UPDATE clients SET stage='authorization', treatment_plan_submitted_date=NULL, treatment_plan_due_date=NULL, tp_reminders_sent='[]' WHERE id=$1", [cid]);
  // Give this client a BCBA + a fresh assessment date 12 days ago (=> due in 2 days).
  await req(`/api/clients/${cid}/authorization`, { method: "PATCH", body: { assigned_bcba_name: "Dr. BCBA", assigned_bcba_email: "bcba@example.test", auth_start_date: isoDaysFromToday(0) } });
  await req(`/api/clients/${cid}`, { method: "PATCH", body: { in_clinic_assessment_date: isoDaysFromToday(-12) } });
  const afterAsmt = (await req(`/api/clients/${cid}`)).data.client;
  check("treatment_plan_due_date = assessment + 14 calendar days", afterAsmt.treatment_plan_due_date && String(afterAsmt.treatment_plan_due_date).slice(0, 10) === isoDaysFromToday(2), afterAsmt.treatment_plan_due_date);
  const assignEmail = (await pool.query("SELECT * FROM notifications_log WHERE recipient='bcba@example.test' AND subject ILIKE '%Treatment plan assigned%' ORDER BY id DESC LIMIT 1")).rows[0];
  check("the assigned BCBA got the assignment notification", !!assignEmail, assignEmail && assignEmail.subject);
  // Escalation: 2 days left -> the "3 days" step should fire on the sweep.
  const sweep1 = await req("/api/admin/run-tp-reminders", { method: "POST" });
  check("the escalation sweep sends at least one reminder", sweep1.data && sweep1.data.sent >= 1, sweep1.data);
  const threeDay = (await pool.query("SELECT COUNT(*)::int AS n FROM notifications_log WHERE recipient='bcba@example.test' AND subject ILIKE '%3 days left%'")).rows[0].n;
  check("a '3 days left' reminder was emailed to the BCBA", threeDay >= 1, threeDay);
  // Idempotent: running again must not re-send the same step.
  await req("/api/admin/run-tp-reminders", { method: "POST" });
  const threeDay2 = (await pool.query("SELECT COUNT(*)::int AS n FROM notifications_log WHERE recipient='bcba@example.test' AND subject ILIKE '%3 days left%'")).rows[0].n;
  check("the same reminder step does not fire twice", threeDay2 === threeDay, { first: threeDay, second: threeDay2 });
  // Submitting the plan stops the ladder.
  await req(`/api/clients/${cid}/authorization`, { method: "PATCH", body: { treatment_plan_submitted_date: isoDaysFromToday(0) } });
  const before = (await pool.query("SELECT COUNT(*)::int AS n FROM notifications_log WHERE recipient='bcba@example.test' AND type='treatment_plan_reminder'")).rows[0].n;
  await req("/api/admin/run-tp-reminders", { method: "POST" });
  const after = (await pool.query("SELECT COUNT(*)::int AS n FROM notifications_log WHERE recipient='bcba@example.test' AND type='treatment_plan_reminder'")).rows[0].n;
  check("once the plan is submitted, reminders stop", after === before, { before, after });

  console.log("\n== item 4: Authorization -> Scheduling ==");
  // The client above has an auth_start_date, so it can move.
  const move = await req(`/api/clients/${cid}/move-to-scheduling`, { method: "POST" });
  check("move-to-scheduling succeeds", move.status === 200, move.data);
  check("the client is now in First Day Scheduling", move.data && move.data.stage === "first_day_scheduled", move.data && move.data.stage);
  const schedTask = (await pool.query("SELECT COUNT(*)::int AS n FROM client_tasks ct JOIN stage_tasks st ON st.id=ct.stage_task_id WHERE ct.client_id=$1 AND st.stage_key='first_day_scheduled'", [cid])).rows[0].n;
  check("a First Day Scheduling task was created", schedTask >= 1, schedTask);
  // A client with no auth cannot be moved.
  const noAuth = clients.find((c) => c.id !== cid);
  if (noAuth) {
    await pool.query("UPDATE clients SET auth_start_date=NULL WHERE id=$1", [noAuth.id]);
    const blocked = await req(`/api/clients/${noAuth.id}/move-to-scheduling`, { method: "POST" });
    check("a client with no authorization cannot be moved (400)", blocked.status === 400, blocked.status);
  }

  console.log("\n== item 3: schedule-request recipient routing ==");
  const setR = await req("/api/admin/settings", { method: "PATCH", body: { schedule_request_recipients: "sched@example.test" } });
  check("recipients can be configured", setR.status === 200, setR.data);
  const gotR = await req("/api/admin/settings");
  check("the configured recipients persist", gotR.data && gotR.data.schedule_request_recipients === "sched@example.test", gotR.data && gotR.data.schedule_request_recipients);
  // Seed a schedule request and submit it via the public endpoint.
  const target = clients.find((c) => c.parent_email) || clients[0];
  await pool.query("INSERT INTO client_schedule_requests (client_id, token, status, sent_at, created_at) VALUES ($1,'p3-sched-tok','sent',$2,$2)", [target.id, new Date().toISOString()]);
  // 4 hours/day across Mon-Fri = 20 slots (>= the 15-hour minimum, <= 8/day).
  const slots = [];
  for (let day = 1; day <= 5; day++) for (const h of [8, 9, 10, 11]) slots.push(`${day}-${h}`);
  const sub = await req("/api/client-forms/public/schedule/submit", { method: "POST", body: { token: "p3-sched-tok", slots } });
  check("the parent can submit their schedule", sub.status === 200 && sub.data.ok, sub.data);
  const staffNote = (await pool.query("SELECT * FROM notifications_log WHERE recipient='sched@example.test' AND type='schedule_request_staff' ORDER BY id DESC LIMIT 1")).rows[0];
  check("the configured staff recipient was notified of the submission", !!staffNote, staffNote && staffNote.subject);
  const stillAttached = (await pool.query("SELECT status FROM client_schedule_requests WHERE token='p3-sched-tok'")).rows[0];
  check("the request stays attached to the client (marked submitted)", stillAttached && stillAttached.status === "submitted", stillAttached);

  await pool.end();
  console.log("\n" + pass + " passed, " + fail + " failed\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\nCrashed:", e); process.exit(1); });
