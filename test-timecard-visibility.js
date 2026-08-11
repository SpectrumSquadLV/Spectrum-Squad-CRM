// Timecard acceptance visibility test: an employee ACCEPTS (signs) one timecard
// and requests EDITS on another, and the office-side detail + list endpoints
// surface exactly what's needed to key the hours into payroll -- who signed and
// when, the accepted hours, the signed PDF, and (for edits) the employee's
// proposed hours + note.
//
//   DATABASE_URL=... PORT=3011 APP_BASE_URL=http://127.0.0.1:3011 node server.js
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-timecard-visibility.js
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
let cookie = "", pass = 0, fail = 0;
async function req(p, { method = "GET", body } = {}) {
  const r = await fetch(BASE + p, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  let d = null; try { d = await r.json(); } catch (e) {}
  return { status: r.status, data: d };
}
function check(n, c, d) { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d !== undefined ? "  -> " + JSON.stringify(d).slice(0, 260) : "")); } }
const tokenOf = (url) => {
  const s = String(url || "");
  const q = s.match(/[?&]token=([^&]+)/i);
  if (q) return q[1];
  return s.split("?")[0].split("/").filter(Boolean).pop() || ""; // path form: /verify-timecard/<token>
};

(async () => {
  const login = await req("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
  check("owner signs in", login.status === 200, login.data);

  // An employee with an email so verification links can be created.
  const emp = (await pool.query(
    "INSERT INTO hr_employees (name, email, role_title, status, created_at) VALUES ($1,$2,$3,'active',now()) RETURNING id",
    ["Casey Clockwork", "casey.clock@example.test", "RBT"]
  )).rows[0];
  const entries = [
    { date: "2026-08-01", clock_in: "09:00", clock_out: "17:00", hours: 8 },
    { date: "2026-08-02", clock_in: "09:00", clock_out: "15:00", hours: 6 },
  ];
  const mkTc = async () => (await pool.query(
    "INSERT INTO hr_timecards (employee_id, source, pay_period_start, pay_period_end, entries, status, created_at) VALUES ($1,'import','2026-08-01','2026-08-14',$2,'imported',now()) RETURNING id",
    [emp.id, JSON.stringify(entries)]
  )).rows[0].id;
  const tcAccept = await mkTc();
  const tcEdit = await mkTc();

  console.log("\n== employee ACCEPTS -> office sees the signature + hours + PDF ==");
  const v1 = await req("/api/hr/timecards/" + tcAccept + "/request-verification", { method: "POST" });
  check("a verification link is created", v1.status === 200 && !!tokenOf(v1.data.url), v1.data);
  const acc = await req("/api/hr/public/timecard/accept", { method: "POST", body: { token: tokenOf(v1.data.url), signed_name: "Casey Clockwork" } });
  check("the employee can accept & sign", acc.status === 200 && acc.data.ok, acc.data);

  const d1 = (await req("/api/hr/timecards/" + tcAccept)).data;
  check("detail shows status accepted", d1.status === "accepted", d1.status);
  check("detail shows who signed", d1.signed_name === "Casey Clockwork", d1.signed_name);
  check("detail shows when it was accepted", !!d1.accepted_at, d1.accepted_at);
  check("detail exposes the accepted hours to key into payroll", Array.isArray(d1.entries) && d1.entries.length === 2, d1.entries);
  check("detail links the signed PDF", d1.pdf_doc_id != null, d1.pdf_doc_id);

  console.log("\n== employee requests EDITS -> office sees their note + proposed hours ==");
  const v2 = await req("/api/hr/timecards/" + tcEdit + "/request-verification", { method: "POST" });
  const edited = [
    { date: "2026-08-01", clock_in: "08:30", clock_out: "17:00", hours: 8.5 },
    { date: "2026-08-02", clock_in: "09:00", clock_out: "16:00", hours: 7 },
  ];
  const ed = await req("/api/hr/public/timecard/edit", { method: "POST", body: { token: tokenOf(v2.data.url), edited, note: "I stayed late Monday and worked an extra hour Tuesday." } });
  check("the employee can request edits", ed.status === 200 && ed.data.ok, ed.data);

  const d2 = (await req("/api/hr/timecards/" + tcEdit)).data;
  check("detail shows status edit_requested", d2.status === "edit_requested", d2.status);
  check("detail carries the employee's note", /stayed late/i.test(d2.employee_note || ""), d2.employee_note);
  check("detail carries the employee's proposed hours", Array.isArray(d2.edited_entries) && d2.edited_entries.length === 2 && Number(d2.edited_entries[0].hours) === 8.5, d2.edited_entries);

  console.log("\n== the Timecards list distinguishes the two at a glance ==");
  const list = (await req("/api/hr/timecards")).data;
  const rowA = list.find((t) => t.id === tcAccept);
  const rowE = list.find((t) => t.id === tcEdit);
  check("accepted row reports accepted + signer", rowA && rowA.status === "accepted" && rowA.signed_name === "Casey Clockwork", rowA && { s: rowA.status, n: rowA.signed_name });
  check("edited row reports edit_requested", rowE && rowE.status === "edit_requested", rowE && rowE.status);

  await pool.end();
  console.log("\n" + pass + " passed, " + fail + " failed\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
