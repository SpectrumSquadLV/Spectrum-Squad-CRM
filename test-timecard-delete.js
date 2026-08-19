// Owner-only timecard deletion.
//   - The owner can delete a timecard; its flags + verification links go too.
//   - A manager (hr_admin) who can import/send timecards CANNOT delete one.
//   - The capability the UI keys off (caps.canDelete) is owner-only.
//
//   DATABASE_URL=... PORT=3011 node server.js
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-timecard-delete.js
const { Pool } = require("pg");
const crypto = require("crypto");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
let pass = 0, fail = 0;
function check(n, c, d) { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d !== undefined ? "  -> " + JSON.stringify(d).slice(0, 260) : "")); } }
function mkClient() {
  let cookie = "";
  return async (p, { method = "GET", body } = {}) => {
    const r = await fetch(BASE + p, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  };
}
function hp(pw) { const salt = crypto.randomBytes(16).toString("hex"); return { hash: crypto.scryptSync(pw, salt, 64).toString("hex"), salt }; }

(async () => {
  // A manager account (hr_admin: can manage HR, but is NOT the owner).
  const m = hp("TestMgr123!");
  await pool.query(
    `INSERT INTO users (name, email, password_hash, password_salt, role, department_id, created_at)
     VALUES ('HR Manager','mgr@spectrumsquadlv.com',$1,$2,'hr_admin',NULL,now())
     ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, password_salt=EXCLUDED.password_salt, role='hr_admin'`,
    [m.hash, m.salt]
  );

  const owner = mkClient(), mgr = mkClient();
  check("owner signs in", (await owner("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);
  check("manager signs in", (await mgr("/api/auth/login", { method: "POST", body: { email: "mgr@spectrumsquadlv.com", password: "TestMgr123!" } })).status === 200);

  const ownerMeta = (await owner("/api/hr/meta")).data;
  const mgrMeta = (await mgr("/api/hr/meta")).data;
  check("owner meta: canDelete is true", ownerMeta.caps && ownerMeta.caps.canDelete === true, ownerMeta.caps);
  check("manager meta: canManage true but canDelete false", mgrMeta.caps && mgrMeta.caps.canManage === true && mgrMeta.caps.canDelete === false, mgrMeta.caps);

  // A timecard with a flag and a verification link, to prove the cascade.
  const emp = (await pool.query("INSERT INTO hr_employees (name,email,status,created_at) VALUES ('Del Test','del@example.test','active',now()) RETURNING id")).rows[0];
  const tc = (await pool.query(
    "INSERT INTO hr_timecards (employee_id, source, pay_period_start, pay_period_end, entries, status, created_at) VALUES ($1,'import','2026-08-01','2026-08-14',$2,'imported',now()) RETURNING id",
    [emp.id, JSON.stringify([{ date: "2026-08-01", hours: 8 }])]
  )).rows[0].id;
  await pool.query("INSERT INTO hr_timecard_flags (timecard_id, flag_type, detail, status, created_at) VALUES ($1,'unusual','test',' open',now())", [tc]);
  await pool.query("INSERT INTO hr_timecard_links (timecard_id, token, created_at) VALUES ($1,$2,now())", [tc, crypto.randomBytes(8).toString("hex")]);

  console.log("\n== a manager cannot delete ==");
  const mgrDel = await mgr("/api/hr/timecards/" + tc, { method: "DELETE" });
  check("manager DELETE is refused (403)", mgrDel.status === 403, mgrDel);
  check("the timecard still exists after the refused delete", (await pool.query("SELECT 1 FROM hr_timecards WHERE id=$1", [tc])).rows.length === 1);

  console.log("\n== the owner can delete, and the flags + links go with it ==");
  const ownDel = await owner("/api/hr/timecards/" + tc, { method: "DELETE" });
  check("owner DELETE succeeds", ownDel.status === 200 && ownDel.data.ok, ownDel.data);
  check("the timecard row is gone", (await pool.query("SELECT 1 FROM hr_timecards WHERE id=$1", [tc])).rows.length === 0);
  check("its flags are gone", (await pool.query("SELECT 1 FROM hr_timecard_flags WHERE timecard_id=$1", [tc])).rows.length === 0);
  check("its verification links are gone", (await pool.query("SELECT 1 FROM hr_timecard_links WHERE timecard_id=$1", [tc])).rows.length === 0);

  const gone = await owner("/api/hr/timecards/" + tc, { method: "DELETE" });
  check("deleting an already-gone timecard is a clean 404", gone.status === 404, gone.status);

  await pool.end();
  console.log("\n" + pass + " passed, " + fail + " failed\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
