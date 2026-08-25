// The follow-up sweep, end to end (Phase 4).
//
// The pure scheduling decision is covered exhaustively in
// test-followup-schedule.js. This drives the real endpoint against real rows,
// and its first job is to prove the property everything else rests on:
//
//   THE SWEEP CANNOT SEND. It writes drafts into the review queue and nothing
//   more. A person still reads and approves each one. This suite counts
//   notifications_log around every sweep, because a scheduler that quietly
//   started sending would leave a trace there and nowhere else.
//
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-followups.js
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
const outreachMails = async () =>
  Number((await pool.query("SELECT count(*) FROM notifications_log WHERE type = 'event_outreach'")).rows[0].count);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

(async () => {
  const owner = client();
  check("owner signs in", (await owner("/api/auth/login", {
    method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" },
  })).status === 200);

  const purge = async () => {
    await pool.query("DELETE FROM events WHERE name LIKE 'FU %'").catch(() => {});
    await pool.query("DELETE FROM event_outreach_suppression WHERE email LIKE '%futest%'").catch(() => {});
    await pool.query("DELETE FROM notifications_log WHERE type = 'event_outreach'").catch(() => {});
  };
  await purge();

  const evId = (await owner("/api/events", { method: "POST", body: { name: "FU Test Event" } })).data.id;
  await owner("/api/events/outreach/settings", { method: "PUT", body: {
    enabled: true, daily_limit: 50, batch_size: 10, send_hour_start: 0, send_hour_end: 24,
    max_follow_ups: 2, postal_address: "1 Test St, Las Vegas NV 89101", org_name: "Spectrum Squad" } });

  await owner(`/api/events/${evId}/outreach/templates`, { method: "POST", body: {
    name: "First", step: 1, delay_days: 0, subject: "Hello {{business_name}}", body: "<p>First</p>" } });
  await owner(`/api/events/${evId}/outreach/templates`, { method: "POST", body: {
    name: "Follow-up 1", step: 2, delay_days: 7, subject: "Following up, {{business_name}}", body: "<p>Second</p>" } });
  await owner(`/api/events/${evId}/outreach/templates`, { method: "POST", body: {
    name: "Follow-up 2", step: 3, delay_days: 14, subject: "One more, {{business_name}}", body: "<p>Third</p>" } });

  const mk = async (name, email) => (await owner(`/api/events/${evId}/prospects`, {
    method: "POST", body: { business_name: name, public_email: email, status: "READY_FOR_OUTREACH" } })).data.id;
  const ready = await mk("FU Ready", "ready@futest.invalid");
  const replied = await mk("FU Replied", "replied@futest.invalid");
  const optedOut = await mk("FU OptedOut", "optedout@futest.invalid");
  const fresh = await mk("FU Fresh", "fresh@futest.invalid");
  const never = await mk("FU NeverContacted", "never@futest.invalid");

  // Simulate step 1 having been sent: 8 days ago for most, 2 days ago for one.
  const sendStep1 = async (prospectId, email, days) => pool.query(
    `INSERT INTO event_outreach_messages (event_id, prospect_id, step, to_email, subject, body, status, sent_at, unsubscribe_token, created_at, updated_at)
     VALUES ($1,$2,1,$3,'s','b','sent',$4,$5,$4,$4)`,
    [evId, prospectId, email, daysAgo(days), "tok-fu-" + prospectId]);
  await sendStep1(ready, "ready@futest.invalid", 8);
  await sendStep1(replied, "replied@futest.invalid", 8);
  await sendStep1(optedOut, "optedout@futest.invalid", 8);
  await sendStep1(fresh, "fresh@futest.invalid", 2);
  await pool.query("UPDATE event_prospects SET status = 'RESPONDED' WHERE id = $1", [replied]);
  await pool.query(
    "INSERT INTO event_outreach_suppression (email, reason, created_at) VALUES ('optedout@futest.invalid','test',$1) ON CONFLICT (email) DO NOTHING",
    [new Date().toISOString()]);

  section("The preview shows what would happen, and changes nothing");
  const before = await outreachMails();
  const preview = await owner(`/api/events/${evId}/outreach/follow-ups`);
  check("the preview loads", preview.status === 200, preview.data);
  check("exactly the one due prospect is listed",
    preview.data.due.length === 1 && preview.data.due[0].prospect_id === ready, preview.data.due);
  check("it says which step", preview.data.due[0].step === 2, preview.data.due[0]);
  check("everybody else is listed with a reason", preview.data.skipped.length === 4, preview.data.skipped);
  check("the previewing wrote no messages",
    Number((await pool.query("SELECT count(*) FROM event_outreach_messages WHERE event_id = $1 AND status = 'draft'", [evId])).rows[0].count) === 0);
  check("and emailed nobody", (await outreachMails()) === before);

  section("The sweep drafts — and only drafts");
  const run1 = await owner(`/api/events/${evId}/outreach/follow-ups`, { method: "POST", body: {} });
  check("the sweep runs", run1.status === 200, run1.data);
  check("one follow-up was drafted", run1.data.drafted === 1, run1.data);
  // The property everything rests on.
  check("THE SWEEP SENT NOTHING", (await outreachMails()) === before, await outreachMails());
  const drafts = (await pool.query(
    "SELECT * FROM event_outreach_messages WHERE event_id = $1 AND step = 2", [evId])).rows;
  check("the draft exists", drafts.length === 1, drafts.length);
  check("its status is draft, not approved and not sent", drafts[0].status === "draft", drafts[0].status);
  check("nobody is recorded as having approved it", !drafts[0].approved_by, drafts[0].approved_by);
  check("it has its own unsubscribe token", !!drafts[0].unsubscribe_token);
  check("merge fields were rendered", /FU Ready/.test(drafts[0].subject), drafts[0].subject);
  check("it is addressed to the right business", drafts[0].to_email === "ready@futest.invalid", drafts[0].to_email);

  section("Who was left alone, and why");
  const reasons = {};
  for (const s of preview.data.skipped) reasons[s.prospect_id] = s.reason;
  check("the one who replied is skipped for that reason",
    /stops at status RESPONDED/i.test(reasons[replied] || ""), reasons[replied]);
  check("the one who opted out is skipped for that reason",
    /do-not-contact/i.test(reasons[optedOut] || ""), reasons[optedOut]);
  check("the recent one is skipped as not yet due",
    /not due for another/i.test(reasons[fresh] || ""), reasons[fresh]);
  check("the never-contacted one is skipped as having no first message",
    /no first message/i.test(reasons[never] || ""), reasons[never]);

  section("Running it twice does not draft twice");
  const run2 = await owner(`/api/events/${evId}/outreach/follow-ups`, { method: "POST", body: {} });
  check("the second sweep drafts nothing", run2.data.drafted === 0, run2.data);
  check("still exactly one step-2 message",
    Number((await pool.query("SELECT count(*) FROM event_outreach_messages WHERE event_id = $1 AND step = 2", [evId])).rows[0].count) === 1);
  check("and still nothing emailed", (await outreachMails()) === before);

  section("A decision a person made is not undone overnight");
  await owner(`/api/events/${evId}/outreach/messages/${drafts[0].id}/cancel`, { method: "POST", body: {} });
  const run3 = await owner(`/api/events/${evId}/outreach/follow-ups`, { method: "POST", body: {} });
  check("a cancelled follow-up is not re-drafted", run3.data.drafted === 0, run3.data);
  const still = (await pool.query(
    "SELECT status FROM event_outreach_messages WHERE event_id = $1 AND step = 2", [evId])).rows;
  check("it stays cancelled", still.length === 1 && still[0].status === "cancelled", still);

  section("The chain moves on once a follow-up really goes");
  // Step 2 sent 15 days ago -> step 3 (14-day delay) becomes due.
  await pool.query(
    "UPDATE event_outreach_messages SET status = 'sent', sent_at = $1 WHERE event_id = $2 AND step = 2",
    [daysAgo(15), evId]);
  const run4 = await owner(`/api/events/${evId}/outreach/follow-ups`, { method: "POST", body: {} });
  check("step 3 is drafted", run4.data.drafted === 1, run4.data);
  const step3 = (await pool.query(
    "SELECT * FROM event_outreach_messages WHERE event_id = $1 AND step = 3", [evId])).rows;
  check("as a draft", step3.length === 1 && step3[0].status === "draft", step3);
  check("and still nothing sent", (await outreachMails()) === before);

  section("The follow-up limit ends it");
  await pool.query(
    "UPDATE event_outreach_messages SET status = 'sent', sent_at = $1 WHERE event_id = $2 AND step = 3",
    [daysAgo(30), evId]);
  const run5 = await owner(`/api/events/${evId}/outreach/follow-ups`, { method: "POST", body: {} });
  check("no step 4 with a limit of 2", run5.data.drafted === 0, run5.data);

  section("Nothing is drafted while outreach is switched off");
  // Somebody who turned outreach off should not come back to a queue full of
  // messages waiting for them.
  await owner("/api/events/outreach/settings", { method: "PUT", body: { enabled: false } });
  const ev2 = (await owner("/api/events", { method: "POST", body: { name: "FU Off Event" } })).data.id;
  const offP = (await owner(`/api/events/${ev2}/prospects`, { method: "POST", body: {
    business_name: "FU Off", public_email: "off@futest.invalid" } })).data.id;
  await owner(`/api/events/${ev2}/outreach/templates`, { method: "POST", body: {
    name: "F1", step: 2, delay_days: 1, subject: "s", body: "b" } });
  await pool.query(
    `INSERT INTO event_outreach_messages (event_id, prospect_id, step, to_email, subject, body, status, sent_at, unsubscribe_token, created_at, updated_at)
     VALUES ($1,$2,1,'off@futest.invalid','s','b','sent',$3,'tok-fu-off',$3,$3)`, [ev2, offP, daysAgo(10)]);
  // The per-event route is a deliberate manual action and still works; the
  // ALL-events SCHEDULED sweep is what must stand down. Driven directly against
  // a stub, because the real one runs on a 24-hour timer.
  //
  // (An earlier version of this was `check("...", true)`, which asserts
  //  nothing and passes forever. A test that cannot fail is worse than no test,
  //  because it reads as coverage.)
  const initEvents = require("./events");
  const calls = [];
  const stubOff = initEvents({
    dbGet: async (sql) => (/event_outreach_settings/.test(sql) ? { id: 1, enabled: false } : null),
    dbAll: async (sql) => { calls.push(sql); return []; },
    dbRun: async () => ({ rows: [{ id: 1 }] }),
    nowISO: () => new Date().toISOString(), readBody: async () => ({}), json: () => {},
  });
  const offResult = await stubOff.followUpSweepAll();
  check("the scheduled sweep drafts nothing while outreach is off",
    offResult.drafted === 0, offResult);
  check("and says that is why", /switched off/i.test(offResult.reason || ""), offResult);
  check("it does not even look for events to sweep",
    !calls.some((c) => /FROM events/.test(c)), calls);

  const stubOn = initEvents({
    dbGet: async (sql) => (/event_outreach_settings/.test(sql)
      ? { id: 1, enabled: true, max_follow_ups: 2 } : null),
    dbAll: async () => [], dbRun: async () => ({ rows: [{ id: 1 }] }),
    nowISO: () => new Date().toISOString(), readBody: async () => ({}), json: () => {},
  });
  const onResult = await stubOn.followUpSweepAll();
  check("and with it on the sweep does run", onResult.reason === undefined, onResult);

  await owner("/api/events/outreach/settings", { method: "PUT", body: { enabled: true } });

  section("Permissions match the rest of outreach");
  const intake = client();
  await intake("/api/auth/login", { method: "POST", body: { email: "intake@spectrumsquadlv.com", password: "TestStaff123!" } });
  check("an intake user cannot preview follow-ups",
    (await intake(`/api/events/${evId}/outreach/follow-ups`)).status === 403);
  check("nor run the sweep",
    (await intake(`/api/events/${evId}/outreach/follow-ups`, { method: "POST", body: {} })).status === 403);
  const clinical = client();
  await clinical("/api/auth/login", { method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } });
  check("nor a clinical user",
    (await clinical(`/api/events/${evId}/outreach/follow-ups`, { method: "POST", body: {} })).status === 403);
  check("an unknown event is a 404",
    (await owner("/api/events/99999999/outreach/follow-ups", { method: "POST", body: {} })).status === 404);

  section("No route anywhere both drafts a follow-up and sends it");
  const src = require("fs").readFileSync(require("path").join(__dirname, "events.js"), "utf8");
  const sweepFn = (src.match(/async function followUpSweep\(eventId[\s\S]*?\n  \}/) || [""])[0];
  check("the sweep function exists", sweepFn.length > 0);
  check("it writes drafts", /VALUES \(\?,\?,\?,\?,\?,\?,\?,'draft'/.test(sweepFn), sweepFn.slice(0, 200));
  check("and never calls sendEmail", !/sendEmail/.test(sweepFn));
  check("nor sets a status of approved or sent", !/'approved'|'sent'/.test(sweepFn));

  await purge();
  await pool.end();
  if (failures.length) console.log("\n  --- failures ---\n" + failures.join("\n"));
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
