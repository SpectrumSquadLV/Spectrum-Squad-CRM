// Phase 5 (lead & contract management, items 10 / 11) integration test.
//
//   DATABASE_URL=... node server.js
//   DATABASE_URL=... BASE=http://127.0.0.1:3009 node test-phase5-contracts.js
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
function isoDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

(async () => {
  let r = await req("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
  check("owner signs in", r.status === 200, r.data);
  if (r.status !== 200) process.exit(1);
  const me = (await req("/api/auth/me")).data.user; // name "Quiana Blake"

  console.log("\n== item 10: lead + contract fields ==");
  const created = await req("/api/leads", { method: "POST", body: { name: "Sunrise Elementary", contact_name: "Jordan Lee", contact_email: "jordan@sunrise.test" } });
  check("a lead can be created", created.status === 201 && created.data.id, created.data);
  const id = created.data.id;
  const meta = (await req("/api/leads")).data;
  check("the API exposes contract types + relationship statuses", Array.isArray(meta.contract_types) && Array.isArray(meta.relationship_statuses), Object.keys(meta));

  // Fixed-term contract ending in 10 days, 30-day notice, assigned to the owner.
  await req("/api/leads/" + id, { method: "PATCH", body: {
    relationship_status: "Active Partner", lead_source: "Referral", address: "1 Sun Rd",
    contract_type: "fixed_term", contract_status: "active", contract_start_date: isoDays(-35),
    contract_end_date: isoDays(10), notice_period_days: 30, renewal_date: isoDays(10),
    weekly_committed_hours: 20, payment_arrangement: "Monthly invoice", assigned_bcbas: "Allie R.",
    assigned_to: me.name, special_requirements: "On-site only",
  } });
  const detail = (await req("/api/leads/" + id)).data;
  check("all contract fields persist", detail.lead.contract_end_date && Number(detail.lead.weekly_committed_hours) === 20 && detail.lead.notice_period_days === 30, detail.lead);
  check("fixed-term remaining time is computed", detail.lead.contract.type === "fixed_term" && detail.lead.contract.daysRemaining === 10, detail.lead.contract);
  check("a contract ending within the notice period is flagged expiring soon", detail.lead.contract.expiringSoon === true, detail.lead.contract);

  console.log("\n== month-to-month has no expiration ==");
  await req("/api/leads/" + id, { method: "PATCH", body: { contract_type: "month_to_month" } });
  const m2m = (await req("/api/leads/" + id)).data.lead.contract;
  check("month-to-month is recognized", m2m.isMonthToMonth === true, m2m);
  check("month-to-month has no fixed expiration", m2m.hasExpiration === false && m2m.daysRemaining === null, m2m);
  // put it back to fixed-term for the alert sweep
  await req("/api/leads/" + id, { method: "PATCH", body: { contract_type: "fixed_term" } });

  console.log("\n== timeline (item 11) ==");
  const events1 = (await req("/api/leads/" + id)).data.events;
  check("contract-status changes are logged on the timeline", events1.some((e) => e.event_type === "contract"), events1.map((e) => e.event_type));
  const noteRes = await req("/api/leads/" + id + "/events", { method: "POST", body: { body: "Called Jordan, great chat" } });
  check("a manual interaction can be logged", noteRes.status === 201, noteRes.data);
  const events2 = (await req("/api/leads/" + id)).data.events;
  check("the logged note shows on the timeline", events2.some((e) => /great chat/.test(e.body || "")), events2.slice(0, 3));

  console.log("\n== editable check-in email (item 11) ==");
  const prev = await req("/api/leads/" + id + "/checkin/30/preview", { method: "POST" });
  check("a 30-day check-in previews with the org's details", prev.status === 200 && /Sunrise Elementary/.test(prev.data.html || ""), prev.data && prev.data.subject);
  const sent = await req("/api/leads/" + id + "/checkin/30/send", { method: "POST" });
  check("the check-in can be sent to the contact", sent.status === 200 && sent.data.ok, sent.data);
  const checkinEvent = (await pool.query("SELECT * FROM crm_lead_events WHERE lead_id=$1 AND event_type='checkin' ORDER BY id DESC LIMIT 1", [id])).rows[0];
  check("sending the check-in is recorded on the timeline", !!checkinEvent, checkinEvent && checkinEvent.body);

  console.log("\n== nurturing sweep creates follow-up tasks (item 11) ==");
  const sweep = await req("/api/admin/run-lead-sweeps", { method: "POST" });
  check("the sweep runs", sweep.status === 200, sweep.data);
  const nurtureTask = (await pool.query("SELECT * FROM staff_tasks WHERE title ILIKE '%30-day check-in: Sunrise%' ORDER BY id DESC LIMIT 1")).rows[0];
  check("a 30-day nurture follow-up task was created for the assignee", !!nurtureTask, nurtureTask && nurtureTask.title);
  check("the follow-up task is assigned to the lead's team member", nurtureTask && (nurtureTask.assigned_name === me.name || nurtureTask.assigned_user_id === me.id), nurtureTask);
  // idempotent
  const before = (await pool.query("SELECT COUNT(*)::int AS n FROM staff_tasks WHERE title ILIKE '%30-day check-in: Sunrise%'")).rows[0].n;
  await req("/api/admin/run-lead-sweeps", { method: "POST" });
  const after = (await pool.query("SELECT COUNT(*)::int AS n FROM staff_tasks WHERE title ILIKE '%30-day check-in: Sunrise%'")).rows[0].n;
  check("the nurture step does not fire twice", after === before, { before, after });

  console.log("\n== contract-expiry alert sweep (item 10) ==");
  const alertTask = (await pool.query("SELECT * FROM staff_tasks WHERE title ILIKE '%Contract expiring: Sunrise%' ORDER BY id DESC LIMIT 1")).rows[0];
  check("a contract-expiry alert task was created", !!alertTask, alertTask && alertTask.title);
  const alertEmail = (await pool.query("SELECT * FROM notifications_log WHERE type='contract_alert' AND subject ILIKE '%Sunrise%' ORDER BY id DESC LIMIT 1")).rows[0];
  check("the assigned member was emailed about the expiring contract", !!alertEmail, alertEmail && alertEmail.subject);
  const alertEvent = (await pool.query("SELECT * FROM crm_lead_events WHERE lead_id=$1 AND event_type='alert' ORDER BY id DESC LIMIT 1", [id])).rows[0];
  check("the alert is noted on the timeline", !!alertEvent, alertEvent && alertEvent.body);

  await pool.end();
  console.log("\n" + pass + " passed, " + fail + " failed\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\nCrashed:", e); process.exit(1); });
