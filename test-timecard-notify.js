// Verifies the owner is notified (in-app + email) when an employee ACCEPTS or
// REJECTS (requests changes to) their timecard from the public verification
// page. Runs against a live server + its Postgres.
//
//   DATABASE_URL=... node server.js
//   DATABASE_URL=... BASE=http://127.0.0.1:3009 node test-timecard-notify.js
//
// The public timecard endpoints need no session (they are token-gated), so this
// seeds a timecard + link straight into the DB, then drives the endpoints.
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3009";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : "")); }
}
async function post(path, body) {
  const res = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}
const now = new Date().toISOString();

(async () => {
  // Seed an employee, a timecard, and two link tokens (one for accept, one for reject).
  const emp = (await pool.query(
    "INSERT INTO hr_employees (name, email, status, created_at) VALUES ($1,$2,'active',$3) RETURNING id",
    ["Timecard Tester", "tester@example.test", now]
  )).rows[0];
  const tc1 = (await pool.query(
    "INSERT INTO hr_timecards (employee_id, pay_period_start, pay_period_end, status, created_at) VALUES ($1,$2,$3,'verified',$4) RETURNING id",
    [emp.id, "2026-08-01", "2026-08-15", now]
  )).rows[0];
  const tc2 = (await pool.query(
    "INSERT INTO hr_timecards (employee_id, pay_period_start, pay_period_end, status, created_at) VALUES ($1,$2,$3,'verified',$4) RETURNING id",
    [emp.id, "2026-08-16", "2026-08-31", now]
  )).rows[0];
  await pool.query("INSERT INTO hr_timecard_links (token, timecard_id, created_at) VALUES ($1,$2,$3)", ["tok-accept-1", tc1.id, now]);
  await pool.query("INSERT INTO hr_timecard_links (token, timecard_id, created_at) VALUES ($1,$2,$3)", ["tok-reject-1", tc2.id, now]);

  console.log("\n== employee ACCEPTS their timecard ==");
  const acc = await post("/api/hr/public/timecard/accept", { token: "tok-accept-1", signed_name: "Timecard Tester" });
  check("accept succeeds", acc.status === 200 && acc.data && acc.data.ok, acc);
  const accNotif = (await pool.query("SELECT * FROM hr_notifications WHERE type = 'timecard_accepted' ORDER BY id DESC LIMIT 1")).rows[0];
  check("an in-app HR notification was created for the acceptance", !!accNotif, accNotif);
  const accEmail = (await pool.query("SELECT * FROM notifications_log WHERE subject ILIKE '%Timecard accepted%' ORDER BY id DESC LIMIT 1")).rows[0];
  check("an email to the owner was logged for the acceptance", !!accEmail, accEmail && accEmail.subject);
  check("the acceptance email names the employee", accEmail && /Timecard Tester/.test(accEmail.body || ""), accEmail && accEmail.body);

  console.log("\n== employee REJECTS (requests changes to) their timecard ==");
  const rej = await post("/api/hr/public/timecard/edit", { token: "tok-reject-1", note: "My Tuesday hours are wrong", edited: [] });
  check("reject/edit succeeds", rej.status === 200 && rej.data && rej.data.ok, rej);
  const rejNotif = (await pool.query("SELECT * FROM hr_notifications WHERE type = 'timecard_edit_requested' ORDER BY id DESC LIMIT 1")).rows[0];
  check("an in-app HR notification was created for the rejection", !!rejNotif, rejNotif);
  check("the rejection notification is a warning", rejNotif && rejNotif.severity === "warning", rejNotif && rejNotif.severity);
  const rejEmail = (await pool.query("SELECT * FROM notifications_log WHERE subject ILIKE '%changes requested%' ORDER BY id DESC LIMIT 1")).rows[0];
  check("an email to the owner was logged for the rejection", !!rejEmail, rejEmail && rejEmail.subject);
  check("the rejection email carries the employee's note", rejEmail && /Tuesday hours are wrong/.test(rejEmail.body || ""), rejEmail && rejEmail.body);

  await pool.end();
  console.log("\n" + pass + " passed, " + fail + " failed\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\nCrashed:", e); process.exit(1); });
