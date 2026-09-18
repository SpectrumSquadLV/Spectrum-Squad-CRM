// Changing the address somebody signs in with.
//
// The CRM had no way to do this at all, and the owner account was seeded as a
// mailbox that hard-bounced -- so every task reminder addressed to it was
// discarded. The risk in adding it is not the UPDATE on users.email. It is that
// this codebase identifies staff by their email address in a dozen other
// tables: their employee record, the clients they are assigned to, the tasks
// they own, the supply requests they raised. A bare rename leaves a person
// signing in perfectly well while their own work quietly stops being theirs.
//
// So most of what is asserted here is that the references MOVE, that the things
// which are somebody else's address DON'T, and that a rejected change leaves
// nothing half-done.
//
//   DATABASE_URL=... PORT=3011 node server.js
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-user-email-change.js
const { Pool } = require("pg");
const crypto = require("crypto");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
let pass = 0, fail = 0;
function check(n, c, d) { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d !== undefined ? "  -> " + JSON.stringify(d).slice(0, 300) : "")); } }
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
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];

(async () => {
  const OLD = "mover@spectrumsquadlv.com";
  const NEW = "moved@spectrumsquadlv.com";
  const PW = "TestMover123!";

  const h = hp(PW);
  const subject = await one(
    `INSERT INTO users (name, email, password_hash, password_salt, role, department_id, created_at)
     VALUES ('Mover Person',$1,$2,$3,'clinical',NULL,now())
     ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, password_salt=EXCLUDED.password_salt, role='clinical'
     RETURNING id`, [OLD, h.hash, h.salt]);

  // Everything that points at this person by address, plus one thing that
  // points at somebody else and must be left alone.
  const emp = await one("INSERT INTO hr_employees (name,email,status,created_at) VALUES ('Mover Person',$1,'active',now()) RETURNING id", [OLD]);
  const client = await one(
    `INSERT INTO clients (child_name, parent_email, assigned_bcba_email, assigned_billing_email)
     VALUES ('Ref Kid', $1, $2, $2) RETURNING id`, ["a.parent@example.test", OLD]);
  const task = await one(
    `INSERT INTO staff_tasks (title, assigned_email, created_by, status, created_at)
     VALUES ('Owned task', $1, $1, 'open', now()) RETURNING id`, [OLD]);
  const supply = await one(
    "INSERT INTO supply_requests (token, item_name, requester_email, status, created_at) VALUES ($2,'Pens',$1,'Submitted',now()) RETURNING id",
    [OLD, crypto.randomBytes(8).toString("hex")]);

  const owner = mkClient(), mover = mkClient();
  check("owner signs in", (await owner("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);
  check("the subject signs in with the OLD address", (await mover("/api/auth/login", { method: "POST", body: { email: OLD, password: PW } })).status === 200);

  console.log("\n== bad requests are refused, and change nothing ==");
  const bad = await owner(`/api/admin/users/${subject.id}`, { method: "PATCH", body: { email: "not-an-email" } });
  check("a malformed address is refused (400)", bad.status === 400, bad.data);
  const same = await owner(`/api/admin/users/${subject.id}`, { method: "PATCH", body: { email: OLD.toUpperCase() } });
  check("their current address, in different case, is refused rather than churned", same.status === 400, same.data);
  const taken = await owner(`/api/admin/users/${subject.id}`, { method: "PATCH", body: { email: "admin@spectrumsquadlv.com" } });
  check("an address another account already uses is refused (409)", taken.status === 409, taken.data);
  check("after all three refusals the address is untouched",
    (await one("SELECT email FROM users WHERE id=$1", [subject.id])).email === OLD);
  check("and the references are untouched too",
    (await one("SELECT assigned_bcba_email FROM clients WHERE id=$1", [client.id])).assigned_bcba_email === OLD);

  console.log("\n== the change, and everything that moves with it ==");
  const out = await owner(`/api/admin/users/${subject.id}`, { method: "PATCH", body: { email: NEW } });
  check("the change succeeds", out.status === 200, out.data);
  check("the login address is the new one", out.data && out.data.email === NEW, out.data);
  check("the response says what moved", !!(out.data && out.data.email_change && out.data.email_change.moved.length), out.data && out.data.email_change);

  check("their staff record moved", (await one("SELECT email FROM hr_employees WHERE id=$1", [emp.id])).email === NEW);
  const c = await one("SELECT assigned_bcba_email, assigned_billing_email, parent_email FROM clients WHERE id=$1", [client.id]);
  check("clients where they are the BCBA moved", c.assigned_bcba_email === NEW, c);
  check("clients where they handle billing moved", c.assigned_billing_email === NEW, c);
  check("THE PARENT'S address was not touched", c.parent_email === "a.parent@example.test", c);
  const t = await one("SELECT assigned_email, created_by FROM staff_tasks WHERE id=$1", [task.id]);
  check("tasks assigned to them moved", t.assigned_email === NEW, t);
  check("tasks they created moved", t.created_by === NEW, t);
  check("their supply requests moved",
    (await one("SELECT requester_email FROM supply_requests WHERE id=$1", [supply.id])).requester_email === NEW);

  console.log("\n== what it means for signing in ==");
  check("the OLD address no longer signs in",
    (await mkClient()("/api/auth/login", { method: "POST", body: { email: OLD, password: PW } })).status !== 200);
  check("the NEW address signs in, with the SAME password",
    (await mkClient()("/api/auth/login", { method: "POST", body: { email: NEW, password: PW } })).status === 200);
  // Sessions key on users.id, so the change must not sign anybody out -- least
  // of all the owner, mid-edit, on the screen she is standing on.
  check("the session opened before the change still works", (await mover("/api/auth/me")).status === 200);

  console.log("\n== it is recorded ==");
  const audit = await one("SELECT * FROM user_email_changes WHERE user_id=$1 ORDER BY id DESC LIMIT 1", [subject.id]);
  check("the change is written to the audit table", !!audit && audit.old_email === OLD && audit.new_email === NEW, audit);
  check("the audit records who did it", !!audit && audit.actor === "admin@spectrumsquadlv.com", audit && audit.actor);

  console.log("\n== permission ==");
  const m = hp("TestMgr123!");
  await pool.query(
    `INSERT INTO users (name, email, password_hash, password_salt, role, created_at)
     VALUES ('HR Manager','emailmgr@spectrumsquadlv.com',$1,$2,'hr_admin',now())
     ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, password_salt=EXCLUDED.password_salt, role='hr_admin'`,
    [m.hash, m.salt]);
  const mgr = mkClient();
  check("a user manager signs in", (await mgr("/api/auth/login", { method: "POST", body: { email: "emailmgr@spectrumsquadlv.com", password: "TestMgr123!" } })).status === 200);
  const ownerRow = await one("SELECT id FROM users WHERE role='owner' ORDER BY id LIMIT 1");
  const esc = await mgr(`/api/admin/users/${ownerRow.id}`, { method: "PATCH", body: { email: "hijack@spectrumsquadlv.com" } });
  check("a non-owner cannot change an OWNER's sign-in address (403)", esc.status === 403, esc.data);
  check("and the owner's address is unchanged",
    (await one("SELECT email FROM users WHERE id=$1", [ownerRow.id])).email === "admin@spectrumsquadlv.com");
  const anon = mkClient();
  check("a signed-out request is refused",
    [401, 403].includes((await anon(`/api/admin/users/${subject.id}`, { method: "PATCH", body: { email: "x@y.test" } })).status));

  console.log("\n== every email column in the schema was considered ==");
  {
    // The guard that matters most over time. A column added next year that
    // identifies staff by address, and is not carried, would silently detach
    // people again -- exactly the bug this feature exists to avoid. This fails
    // the build until somebody decides which list it belongs in.
    const mod = require("./user-email")({});
    const carried = new Set(mod.REFERENCES.map((r) => `${r.table}.${r.column}`));
    const excluded = new Set(mod.NOT_IDENTITY);
    const cols = (await pool.query(
      `SELECT table_name || '.' || column_name AS c FROM information_schema.columns
        WHERE table_schema='public' AND column_name LIKE '%email%' ORDER BY 1`
    )).rows.map((r) => r.c);
    check("the schema actually has email columns to check", cols.length > 20, cols.length);
    const unconsidered = cols.filter((c) => !carried.has(c) && !excluded.has(c));
    check("no email column is unaccounted for (carry it, or list it as NOT_IDENTITY)",
      unconsidered.length === 0, unconsidered);
    const bothLists = [...carried].filter((c) => excluded.has(c));
    check("no column is in both lists", bothLists.length === 0, bothLists);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
