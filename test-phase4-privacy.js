// Phase 4 (privacy & permissions, items 6 / 16 / 17) integration test.
//
//   DATABASE_URL=... node server.js
//   DATABASE_URL=... BASE=http://127.0.0.1:3009 node test-phase4-privacy.js
//
// Verifies the Message Outbox + per-client email history are scoped to a
// staffer's assigned clients at the API layer, while owner/admin see everything.
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3009";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
let pass = 0, fail = 0;
function client() { let jar = ""; return async (path, { method = "GET", body } = {}) => {
  const res = await fetch(BASE + path, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(jar ? { Cookie: jar } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get("set-cookie"); if (sc) jar = sc.split(";")[0];
  let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}; }
function check(n, c, d) { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d !== undefined ? "  -> " + JSON.stringify(d).slice(0, 300) : "")); } }
const now = new Date().toISOString();

(async () => {
  const owner = client(), staff = client();
  let r = await owner("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
  check("owner signs in", r.status === 200, r.data);
  let rs = await staff("/api/auth/login", { method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } });
  check("a non-supervisory staffer signs in", rs.status === 200, rs.data);
  if (r.status !== 200 || rs.status !== 200) process.exit(1);
  const staffUser = (await staff("/api/auth/me")).data.user;

  // Two clients: A assigned to the staffer, B not. Clear B's assignments so it
  // can't accidentally match, then log one message per client + one org-wide.
  const cs = (await pool.query("SELECT id FROM clients ORDER BY id LIMIT 2")).rows;
  const A = cs[0].id, B = cs[1].id;
  await pool.query("UPDATE clients SET assigned_bcba_email=$2, assigned_bcba_name='Assigned BCBA' WHERE id=$1", [A, staffUser.email]);
  await pool.query("UPDATE clients SET assigned_bcba_email='someone.else@example.test', assigned_bcba_name='Someone Else', assigned_rbt_name='X', assigned_billing_name='Y', assigned_billing_email='y@example.test', assigned_intake_coordinator_name='Z' WHERE id=$1", [B]);
  await pool.query("INSERT INTO notifications_log (client_id, type, recipient, subject, body, sent_at, delivered) VALUES ($1,'parent_milestone','pa@example.test','MSG-FOR-A','hi',$2,'simulated')", [A, now]);
  await pool.query("INSERT INTO notifications_log (client_id, type, recipient, subject, body, sent_at, delivered) VALUES ($1,'parent_milestone','pb@example.test','MSG-FOR-B','hi',$2,'simulated')", [B, now]);
  await pool.query("INSERT INTO notifications_log (client_id, type, recipient, subject, body, sent_at, delivered) VALUES (NULL,'department_alert','dept@example.test','ORG-WIDE-MSG','hi',$1,'simulated')", [now]);

  console.log("\n== Message Outbox scoping (items 6 / 16) ==");
  const ownerOut = (await owner("/api/notifications")).data || [];
  const ownerSubs = ownerOut.map((n) => n.subject);
  check("owner sees the assigned-client message", ownerSubs.includes("MSG-FOR-A"), ownerSubs.slice(0, 5));
  check("owner sees the OTHER client's message", ownerSubs.includes("MSG-FOR-B"), ownerSubs.slice(0, 5));
  check("owner sees org-wide (no-client) messages", ownerSubs.includes("ORG-WIDE-MSG"), ownerSubs.slice(0, 5));

  const staffOutRes = await staff("/api/notifications");
  check("staffer can open the outbox (scoped, not 403)", staffOutRes.status === 200, staffOutRes.status);
  const staffSubs = (staffOutRes.data || []).map((n) => n.subject);
  check("staffer SEES their assigned client's message", staffSubs.includes("MSG-FOR-A"), staffSubs);
  check("staffer does NOT see another client's message", !staffSubs.includes("MSG-FOR-B"), staffSubs);
  check("staffer does NOT see org-wide messages", !staffSubs.includes("ORG-WIDE-MSG"), staffSubs);

  console.log("\n== per-client communication history scoping ==");
  const staffA = await staff("/api/clients/" + A);
  check("staffer sees comms for their assigned client", (staffA.data.notifications || []).some((n) => n.subject === "MSG-FOR-A"), (staffA.data.notifications || []).map((n) => n.subject));
  check("assigned client is not marked restricted", staffA.data.communications_restricted === false, staffA.data.communications_restricted);
  const staffB = await staff("/api/clients/" + B);
  check("staffer gets NO comms for an unassigned client", (staffB.data.notifications || []).length === 0, staffB.data.notifications);
  check("unassigned client is marked restricted", staffB.data.communications_restricted === true, staffB.data.communications_restricted);
  const ownerB = await owner("/api/clients/" + B);
  check("owner still sees comms for any client", (ownerB.data.notifications || []).some((n) => n.subject === "MSG-FOR-B"), ownerB.data.communications_restricted);

  console.log("\n== resend stays admin-only ==");
  const anyId = (await pool.query("SELECT id FROM notifications_log WHERE subject='MSG-FOR-A' LIMIT 1")).rows[0].id;
  const staffResend = await staff("/api/notifications/" + anyId + "/resend", { method: "POST" });
  check("a scoped staffer cannot resend messages (403)", staffResend.status === 403, staffResend.status);

  await pool.end();
  console.log("\n" + pass + " passed, " + fail + " failed\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\nCrashed:", e); process.exit(1); });
