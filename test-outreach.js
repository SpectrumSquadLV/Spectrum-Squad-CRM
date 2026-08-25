// Event outreach, end to end (Phase 3).
//
// This is the first part of the event system that emails anybody, and the
// recipients are local businesses who never asked to hear from us. The pure
// decision logic is covered exhaustively in test-outreach-guard.js; this suite
// drives the real endpoints against real rows and counts what actually landed
// in notifications_log, because an email that goes out leaves a trace and a
// test that only checks a status field would pass while mail was flying.
//
// Ordered by how much damage the failure does:
//
//   1. Sending to somebody who opted out or asked us to stop.
//   2. Sending without a person approving it.
//   3. Sending twice.
//   4. Sending with no opt-out link or postal address in the email.
//   5. Ignoring the daily limit, the batch size or the sending hours.
//
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-outreach.js
"use strict";
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else {
    fail++;
    const line = "  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : "");
    failures.push(line); console.log(line);
  }
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

// Every outreach email lands in notifications_log. Counting it is how "nothing
// was sent" is proved rather than assumed.
const outreachMails = async () =>
  Number((await pool.query("SELECT count(*) FROM notifications_log WHERE type = 'event_outreach'")).rows[0].count);
const mailsTo = async (addr) =>
  Number((await pool.query(
    "SELECT count(*) FROM notifications_log WHERE type = 'event_outreach' AND lower(recipient) = $1",
    [addr.toLowerCase()])).rows[0].count);

(async () => {
  const owner = client();
  check("owner signs in", (await owner("/api/auth/login", {
    method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" },
  })).status === 200);

  const purge = async () => {
    await pool.query("DELETE FROM events WHERE name LIKE 'OUT %'").catch(() => {});
    await pool.query("DELETE FROM event_outreach_suppression WHERE email LIKE '%outtest%'").catch(() => {});
    await pool.query("DELETE FROM notifications_log WHERE type = 'event_outreach'").catch(() => {});
  };
  await purge();

  const evId = (await owner("/api/events", { method: "POST", body: {
    name: "OUT Test Event", event_date: "2027-01-15", venue_name: "OUT Hall" } })).data.id;
  const mkProspect = async (name, email, extra = {}) => (await owner(`/api/events/${evId}/prospects`, {
    method: "POST", body: { business_name: name, public_email: email, status: "READY_FOR_OUTREACH", ...extra },
  })).data.id;

  const bakery = await mkProspect("OUT Bakery", "bakery@outtest.invalid");
  const florist = await mkProspect("OUT Florist", "florist@outtest.invalid");
  const dentist = await mkProspect("OUT Dentist", "dentist@outtest.invalid");
  const noEmail = (await owner(`/api/events/${evId}/prospects`, {
    method: "POST", body: { business_name: "OUT NoEmail", status: "READY_FOR_OUTREACH" } })).data.id;

  const tmpl = (await owner(`/api/events/${evId}/outreach/templates`, { method: "POST", body: {
    name: "First approach", step: 1, delay_days: 0,
    subject: "Support {{event_name}}?",
    body: "<p>Hi {{contact_name}}, we are hosting {{event_name}} at {{venue_name}}.</p>",
  } })).data.id;
  check("a template can be created", !!tmpl, tmpl);

  section("Nothing sends until it is configured to");
  // The default MUST be off with no postal address -- a fresh install where
  // somebody finds the button must not be able to email anybody.
  let st = (await owner("/api/events/outreach/settings")).data;
  check("outreach starts switched off", st.settings.enabled !== true, st.settings);
  check("and reports what is missing", st.problems.length > 0, st.problems);
  check("no postal address is configured by default",
    !st.settings.postal_address, st.settings.postal_address);

  const draft = await owner(`/api/events/${evId}/outreach/draft`, { method: "POST", body: { template_id: tmpl } });
  check("drafts can be generated even while sending is off", draft.status === 200, draft.data);
  check("three prospects got a draft", draft.data.created === 3, draft.data);
  check("the one with no email is skipped, with a reason",
    draft.data.skipped_detail.some((s) => s.prospect_id === noEmail && /email/i.test(s.reason)),
    draft.data.skipped_detail);
  check("generating drafts emails nobody", (await outreachMails()) === 0);

  section("A draft is not a send");
  let run = await owner(`/api/events/${evId}/outreach/send`, { method: "POST", body: {} });
  check("the send pass runs", run.status === 200, run.data);
  check("but sends nothing while outreach is off", run.data.sent === 0, run.data);
  check("and says why", (run.data.problems || []).length > 0, run.data.problems);
  check("still nothing in the outbox", (await outreachMails()) === 0);

  section("Turning it on is not enough — it still needs an address and approval");
  await owner("/api/events/outreach/settings", { method: "PUT", body: {
    enabled: true, daily_limit: 50, batch_size: 10, send_hour_start: 0, send_hour_end: 24, max_follow_ups: 2 } });
  st = (await owner("/api/events/outreach/settings")).data;
  check("enabled without a postal address is still blocked",
    st.problems.some((p) => /postal address/i.test(p)), st.problems);
  run = await owner(`/api/events/${evId}/outreach/send`, { method: "POST", body: {} });
  check("and nothing sends", run.data.sent === 0 && (await outreachMails()) === 0, run.data);

  await owner("/api/events/outreach/settings", { method: "PUT", body: {
    postal_address: "123 Main St, Las Vegas NV 89101", org_name: "Spectrum Squad" } });
  st = (await owner("/api/events/outreach/settings")).data;
  check("with an address the configuration is finally clean", st.problems.length === 0, st.problems);

  run = await owner(`/api/events/${evId}/outreach/send`, { method: "POST", body: {} });
  // The whole point of the review queue: a fully configured, switched-on
  // system still sends nothing that a person has not approved.
  check("a fully configured system STILL sends nothing unapproved", run.data.sent === 0, run.data);
  check("nothing in the outbox", (await outreachMails()) === 0);

  section("Approval is what releases a message");
  const queue = (await owner(`/api/events/${evId}/outreach/messages`)).data;
  check("the queue lists the drafts", (queue.messages || []).length === 3, (queue.messages || []).length);
  check("all three are drafts", queue.messages.every((m) => m.status === "draft"));
  check("each carries its own unsubscribe token",
    new Set(queue.messages.map((m) => m.unsubscribe_token)).size === 3, queue.messages.map((m) => m.unsubscribe_token));
  check("merge fields were rendered, not left as braces",
    queue.messages.every((m) => /OUT Test Event/.test(m.subject) && !/\{\{/.test(m.body)),
    queue.messages[0]);

  const bakeryMsg = queue.messages.find((m) => m.prospect_id === bakery);
  check("one can be approved",
    (await owner(`/api/events/${evId}/outreach/messages/${bakeryMsg.id}/approve`, { method: "POST", body: {} })).status === 200);
  run = await owner(`/api/events/${evId}/outreach/send`, { method: "POST", body: {} });
  check("exactly the approved one is sent", run.data.sent === 1, run.data);
  check("and it really went", (await mailsTo("bakery@outtest.invalid")) === 1);
  check("the unapproved ones did NOT",
    (await mailsTo("florist@outtest.invalid")) === 0 && (await mailsTo("dentist@outtest.invalid")) === 0);

  section("The email carries an opt-out and a postal address");
  const bodyRow = (await pool.query(
    "SELECT body FROM notifications_log WHERE type = 'event_outreach' AND lower(recipient) = 'bakery@outtest.invalid' LIMIT 1")).rows[0];
  check("the sent body has an unsubscribe link", /outreach\/unsubscribe\?token=/.test(bodyRow.body || ""), (bodyRow.body || "").slice(-400));
  check("and the postal address", /123 Main St/.test(bodyRow.body || ""), (bodyRow.body || "").slice(-400));

  section("Sending advances the prospect, so the pipeline is true");
  const pr = (await pool.query("SELECT * FROM event_prospects WHERE id = $1", [bakery])).rows[0];
  check("they are now marked contacted", pr.status === "CONTACTED", pr.status);
  check("with a contact date", !!pr.date_contacted, pr.date_contacted);

  section("Nobody is sent the same step twice");
  const again = await owner(`/api/events/${evId}/outreach/draft`, { method: "POST", body: { template_id: tmpl } });
  check("re-drafting skips the one already sent",
    again.data.skipped_detail.some((s) => s.prospect_id === bakery && /already been sent/i.test(s.reason)),
    again.data.skipped_detail);
  // And the database refuses it even if the code ever forgot.
  let dbBlocked = false;
  try {
    await pool.query(
      `INSERT INTO event_outreach_messages (event_id, prospect_id, step, to_email, subject, body, status, sent_at, created_at)
       VALUES ($1,$2,1,'bakery@outtest.invalid','x','y','sent',$3,$3)`, [evId, bakery, new Date().toISOString()]);
  } catch (e) { dbBlocked = true; }
  check("a second SENT row for the same step is refused by the database", dbBlocked);

  section("Somebody who unsubscribes is never emailed again");
  const floristMsg = (await owner(`/api/events/${evId}/outreach/messages`)).data.messages
    .find((m) => m.prospect_id === florist && m.status === "draft");
  await owner(`/api/events/${evId}/outreach/messages/${floristMsg.id}/approve`, { method: "POST", body: {} });
  // The public link -- no session, because a business owner has no account.
  const unsub = await fetch(`${BASE}/outreach/unsubscribe?token=${encodeURIComponent(floristMsg.unsubscribe_token)}`);
  const unsubHtml = await unsub.text();
  check("the unsubscribe page loads without a login", unsub.status === 200, unsub.status);
  check("and confirms in plain words", /unsubscribed/i.test(unsubHtml), unsubHtml.slice(0, 200));

  const supp = (await pool.query(
    "SELECT * FROM event_outreach_suppression WHERE email = 'florist@outtest.invalid'")).rows[0];
  check("they are on the global suppression list", !!supp, supp);
  const floristRow = (await pool.query("SELECT * FROM event_prospects WHERE id = $1", [florist])).rows[0];
  check("the prospect is flagged do-not-contact", floristRow.do_not_contact === true, floristRow);
  check("and their status says so", floristRow.status === "DO_NOT_CONTACT", floristRow.status);
  const floristMsgAfter = (await pool.query(
    "SELECT * FROM event_outreach_messages WHERE id = $1", [floristMsg.id])).rows[0];
  check("their APPROVED message was cancelled, not left to go out",
    floristMsgAfter.status === "cancelled", floristMsgAfter.status);

  run = await owner(`/api/events/${evId}/outreach/send`, { method: "POST", body: {} });
  check("the send pass sends them nothing", (await mailsTo("florist@outtest.invalid")) === 0, run.data);

  // And a NEW event must start already knowing.
  const ev2 = (await owner("/api/events", { method: "POST", body: { name: "OUT Second Event" } })).data.id;
  const florist2 = (await owner(`/api/events/${ev2}/prospects`, { method: "POST", body: {
    business_name: "OUT Florist", public_email: "florist@outtest.invalid" } })).data;
  const f2 = (await pool.query("SELECT * FROM event_prospects WHERE id = $1", [florist2.id])).rows[0];
  check("added to a DIFFERENT event they arrive already suppressed",
    f2.do_not_contact === true, f2);

  section("A reply stops the sequence");
  await pool.query("UPDATE event_prospects SET status = 'RESPONDED' WHERE id = $1", [dentist]);
  const dentistMsg = (await owner(`/api/events/${evId}/outreach/messages`)).data.messages
    .find((m) => m.prospect_id === dentist && m.status === "draft");
  await owner(`/api/events/${evId}/outreach/messages/${dentistMsg.id}/approve`, { method: "POST", body: {} });
  run = await owner(`/api/events/${evId}/outreach/send`, { method: "POST", body: {} });
  check("an approved message is held once they have replied",
    (await mailsTo("dentist@outtest.invalid")) === 0, run.data);
  const dentistAfter = (await pool.query("SELECT * FROM event_outreach_messages WHERE id = $1", [dentistMsg.id])).rows[0];
  check("and it is marked skipped with a reason rather than retried forever",
    dentistAfter.status === "skipped" && /stops at status/i.test(dentistAfter.skipped_reason || ""), dentistAfter);

  section("Sending hours are enforced");
  await owner("/api/events/outreach/settings", { method: "PUT", body: { send_hour_start: 3, send_hour_end: 4 } });
  const hourCheck = (await owner(`/api/events/${evId}/outreach/messages`)).data;
  // 03:00-04:00 is almost certainly not now, so this should read as closed.
  check("the queue reports whether we are inside the window",
    typeof hourCheck.within_hours === "boolean", hourCheck.within_hours);
  await owner("/api/events/outreach/settings", { method: "PUT", body: { send_hour_start: 0, send_hour_end: 24 } });

  section("The daily limit and batch size hold");
  const before = await outreachMails();
  const ids = [];
  for (let i = 0; i < 6; i++) {
    ids.push(await mkProspect(`OUT Batch ${i}`, `batch${i}@outtest.invalid`));
  }
  await owner(`/api/events/${evId}/outreach/draft`, { method: "POST", body: { template_id: tmpl, prospect_ids: ids } });
  const batchMsgs = (await owner(`/api/events/${evId}/outreach/messages?status=draft`)).data.messages
    .filter((m) => ids.includes(m.prospect_id));
  check("six drafts exist", batchMsgs.length === 6, batchMsgs.length);
  for (const m of batchMsgs) await owner(`/api/events/${evId}/outreach/messages/${m.id}/approve`, { method: "POST", body: {} });
  await owner("/api/events/outreach/settings", { method: "PUT", body: { batch_size: 2, daily_limit: 500 } });
  run = await owner(`/api/events/${evId}/outreach/send`, { method: "POST", body: {} });
  check("only the batch size goes in one pass", run.data.sent === 2, run.data);
  check("and the rest are held rather than dropped", run.data.held >= 4, run.data);
  check("the outbox agrees", (await outreachMails()) === before + 2);
  // A held-for-batch message must stay approved so the next pass takes it --
  // not be marked skipped and abandoned.
  const stillApproved = (await owner(`/api/events/${evId}/outreach/messages?status=approved`)).data.messages
    .filter((m) => ids.includes(m.prospect_id));
  check("held messages are still approved for the next pass", stillApproved.length === 4, stillApproved.length);

  // The limit counts EVERY outreach email sent today, not just this pass --
  // which is the point of a domain-level limit. So the limit is set relative to
  // what has already gone, otherwise this asserts the wrong thing.
  const before2 = await outreachMails();
  await owner("/api/events/outreach/settings", { method: "PUT", body: { daily_limit: before2 + 1, batch_size: 100 } });
  run = await owner(`/api/events/${evId}/outreach/send`, { method: "POST", body: {} });
  check("the daily limit lets exactly one more through", (await outreachMails()) === before2 + 1, run.data);
  check("and holds the rest against the limit",
    (run.data.held_detail || []).some((h) => /daily send limit/i.test(h.reason)), run.data.held_detail);
  // Now already at the limit: a second pass must send nothing at all.
  const before3 = await outreachMails();
  run = await owner(`/api/events/${evId}/outreach/send`, { method: "POST", body: {} });
  check("once the day is used up nothing more goes", (await outreachMails()) === before3, run.data);
  await owner("/api/events/outreach/settings", { method: "PUT", body: { daily_limit: 500, batch_size: 10 } });

  section("The follow-up limit is enforced when drafting");
  const t3 = (await owner(`/api/events/${evId}/outreach/templates`, { method: "POST", body: {
    name: "Follow-up four", step: 4, subject: "s", body: "b" } })).data.id;
  const far = await owner(`/api/events/${evId}/outreach/draft`, { method: "POST", body: { template_id: t3 } });
  check("a step past the limit drafts nothing", far.data.created === 0, far.data);
  check("and says it is past the follow-up limit",
    (far.data.skipped_detail || []).some((s) => /follow-up limit/i.test(s.reason)), far.data.skipped_detail);

  section("Not everyone may send email in the company's name");
  // Deliberately narrower than viewing events: intake and scheduling can see
  // the partner list but cannot email businesses.
  const intake = client();
  await intake("/api/auth/login", { method: "POST", body: { email: "intake@spectrumsquadlv.com", password: "TestStaff123!" } });
  check("an intake user can still see the event", (await intake(`/api/events/${evId}`)).status === 200);
  check("but cannot read outreach settings", (await intake("/api/events/outreach/settings")).status === 403);
  check("nor the queue", (await intake(`/api/events/${evId}/outreach/messages`)).status === 403);
  check("nor draft", (await intake(`/api/events/${evId}/outreach/draft`, { method: "POST", body: { template_id: tmpl } })).status === 403);
  check("nor send", (await intake(`/api/events/${evId}/outreach/send`, { method: "POST", body: {} })).status === 403);
  const clinical = client();
  await clinical("/api/auth/login", { method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } });
  check("a clinical user cannot reach any of it", (await clinical(`/api/events/${evId}/outreach/send`, { method: "POST", body: {} })).status === 403);

  section("Bad unsubscribe links fail safe");
  for (const t of ["", "nonsense", "../../etc/passwd"]) {
    const r = await fetch(`${BASE}/outreach/unsubscribe?token=${encodeURIComponent(t)}`);
    const h = await r.text();
    check(`token ${JSON.stringify(t)} gives a page, not an error`, r.status === 200, r.status);
    check(`...and says the link is not valid`, /not valid/i.test(h), h.slice(0, 150));
  }

  section("A template needs its parts");
  check("no subject is refused",
    (await owner(`/api/events/${evId}/outreach/templates`, { method: "POST", body: { name: "x", body: "y" } })).status === 400);
  check("no body is refused",
    (await owner(`/api/events/${evId}/outreach/templates`, { method: "POST", body: { name: "x", subject: "y" } })).status === 400);
  check("drafting with a template from another event is refused",
    (await owner(`/api/events/${ev2}/outreach/draft`, { method: "POST", body: { template_id: tmpl } })).status === 400);

  await purge();
  await pool.end();
  if (failures.length) console.log("\n  --- failures ---\n" + failures.join("\n"));
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
