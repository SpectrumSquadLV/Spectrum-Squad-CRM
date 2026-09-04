// Looking at the CRM as somebody else, to troubleshoot.
//
//   DATABASE_URL=... node server.js
//   DATABASE_URL=... BASE=http://127.0.0.1:3009 node test-view-as.js
//
// Owner only, and read only. Both halves of that are load-bearing, and the
// ways this goes wrong are all silent:
//
//   * AN ADMIN USING IT ON THE OWNER would read the financial pages their own
//     role is deliberately blocked from. That is privilege escalation with a
//     friendly button on it, so the capability belongs to one role.
//   * A WRITE GETTING THROUGH means something happened in another person's
//     name. Enforced by one gate above every route rather than per-handler,
//     because a per-handler rule is one somebody forgets in the next module.
//   * NO WAY BACK. If stopping were blocked along with everything else, the
//     owner would be stuck inside another account.
//   * NOT BEING ABLE TO TELL. The screens are genuinely theirs, so the only
//     thing separating "troubleshooting" from "confused about whose data this
//     is" is the banner and /api/auth/me saying so.
"use strict";
const { Pool } = require("pg");

const BASE = process.env.BASE || "http://localhost:3009";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
let pass = 0, fail = 0;
const failures = [];
const check = (n, c, d) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else {
    fail++;
    const line = "  FAIL  " + n + (d !== undefined ? "  -> " + JSON.stringify(d).slice(0, 320) : "");
    failures.push(line);
    console.log(line);
  }
};
// Repeated at the end because the runner only keeps the tail of a suite's
// output, and a failure forty assertions up would otherwise be invisible.
const replayFailures = () => { if (failures.length) { console.log("\n--- failures ---"); failures.forEach((f) => console.log(f)); } };

function client() {
  let jar = "";
  return async (path, { method = "GET", body } = {}) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(jar ? { Cookie: jar } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) jar = sc.split(";")[0];
    let data = null;
    try { data = await res.json(); } catch (e) {}
    return { status: res.status, data };
  };
}

const idOf = async (email) =>
  (await pool.query("SELECT id, role FROM users WHERE lower(email) = lower($1)", [email])).rows[0];

(async () => {
  const owner = client(), admin = client(), bcba = client();
  check("owner signs in",
    (await owner("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);
  check("a clinical user signs in",
    (await bcba("/api/auth/login", { method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } })).status === 200);

  const me = (await owner("/api/auth/me")).data.user;
  check("the seeded account really is the owner role", me.role === "owner", me.role);
  const clinical = await idOf("clinical@spectrumsquadlv.com");
  const intake = await idOf("intake@spectrumsquadlv.com");

  // A real admin account, to prove the capability is not theirs.
  await pool.query(
    "UPDATE users SET role = 'admin' WHERE lower(email) = lower('scheduling@spectrumsquadlv.com')");
  check("an admin signs in",
    (await admin("/api/auth/login", { method: "POST", body: { email: "scheduling@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);

  console.log("\n== Who holds it ==");
  const adminTry = await admin("/api/auth/view-as", { method: "POST", body: { user_id: clinical.id } });
  check("AN ADMIN CANNOT VIEW AS ANYONE -- it would hand them the owner's screens",
    adminTry.status === 403, adminTry);
  check("nor can a BCBA",
    (await bcba("/api/auth/view-as", { method: "POST", body: { user_id: intake.id } })).status === 403);
  check("and the admin is still themselves afterwards",
    (await admin("/api/auth/me")).data.user.role === "admin");
  check("neither can read the log of who looked at whom",
    (await admin("/api/auth/view-as/log")).status === 403);

  console.log("\n== Starting ==");
  const nobody = await owner("/api/auth/view-as", { method: "POST", body: { user_id: 999999 } });
  check("viewing as an account that does not exist is refused", nobody.status === 404, nobody.data);
  const self = await owner("/api/auth/view-as", { method: "POST", body: { user_id: me.id } });
  check("viewing as yourself is refused rather than doing nothing quietly", self.status === 400, self.data);
  const junk = await owner("/api/auth/view-as", { method: "POST", body: { user_id: "the clinical one" } });
  check("a non-numeric id is refused before it reaches a query", junk.status === 400, junk.data);

  const started = await owner("/api/auth/view-as", { method: "POST", body: { user_id: clinical.id } });
  check("the owner can view as a BCBA", started.status === 200, started.data);
  check("and is told it is read only", started.data.read_only === true, started.data);

  console.log("\n== What the session says now ==");
  const asThem = (await owner("/api/auth/me")).data.user;
  check("THE SESSION IS ANSWERED AS THEM, not as the owner with filtering",
    asThem.role === "clinical" && Number(asThem.id) === Number(clinical.id), { id: asThem.id, role: asThem.role });
  check("the banner has what it needs to say whose account this is",
    asThem.view_as && asThem.view_as.active === true && !!asThem.view_as.viewing_name, asThem.view_as);
  check("and who is really behind it",
    asThem.view_as.real_user_email === me.email, asThem.view_as);
  check("marked read only", asThem.view_as.read_only === true, asThem.view_as);
  check("the owner's own password hash is not in there",
    !("password_hash" in asThem) && !("password_salt" in asThem), Object.keys(asThem));

  console.log("\n== Reading works ==");
  const dash = await owner("/api/caseload/dashboard");
  check("the BCBA's own dashboard loads, which is the point of the feature",
    dash.status === 200, dash.status);
  check("and the owner's admin screens are now refused, because a BCBA cannot see them",
    (await owner("/api/admin/users")).status === 403);

  console.log("\n== Nothing can be written ==");
  const writes = [
    ["POST", "/api/clients", { child_name: "Zz Should Never Exist" }],
    ["PATCH", "/api/clients/1", { notes: "changed while viewing" }],
    ["DELETE", "/api/clients/1", null],
    ["POST", "/api/bcba/requirements", { payer_key: "aetna", list_key: "required_documents", op: "add", text: "nope" }],
    ["POST", "/api/drive-notes/import/preview", null],
    ["POST", "/api/nav-order", { order: ["dashboard"] }],
  ];
  for (const [method, path, body] of writes) {
    const r = await owner(path, { method, body: body || undefined });
    check(`${method} ${path} is refused`, r.status === 403, { status: r.status, err: r.data && r.data.error });
    if (r.status === 403) {
      check(`  and says why, so it is not mistaken for their permissions`,
        !!(r.data && r.data.view_as_read_only), r.data);
    }
  }
  check("NOT ONE OF THOSE WROTE ANYTHING",
    Number((await pool.query("SELECT COUNT(*)::int AS n FROM clients WHERE child_name = 'Zz Should Never Exist'")).rows[0].n) === 0);

  console.log("\n== The gate is above the add-ons, not below them ==");
  // THE ASSERTION THAT MATTERS MOST, and the one that was missing first.
  //
  // Viewing a BCBA, an add-on write is refused by the ADD-ON's own role check
  // -- so a read-only gate placed below the add-on dispatch looks like it is
  // working when it is doing nothing at all. Viewing an ADMIN, who genuinely
  // may write to those routes, is the only way to tell the two apart.
  await owner("/api/auth/view-as/stop", { method: "POST" });
  const adminId = (await idOf("scheduling@spectrumsquadlv.com")).id;
  const asAdmin = await owner("/api/auth/view-as", { method: "POST", body: { user_id: adminId } });
  check("the owner can view as an admin", asAdmin.status === 200, asAdmin.data);
  check("and is answered as that admin", (await owner("/api/auth/me")).data.user.role === "admin");

  for (const [method, path, body] of [
    ["POST", "/api/bcba/requirements", { payer_key: "aetna", list_key: "required_documents", op: "add", text: "written while viewing" }],
    ["PUT", "/api/bcba/payers/aetna/preauth", { required: "unknown" }],
    ["POST", "/api/drive-notes/import/preview", null],
  ]) {
    const r = await owner(path, { method, body: body || undefined });
    check(`${method} ${path} is refused even though this account MAY write to it`,
      r.status === 403 && !!(r.data && r.data.view_as_read_only), { status: r.status, err: r.data && r.data.error });
  }
  const leaked = (await pool.query(
    "SELECT COUNT(*)::int AS n FROM bcba_cheatsheet_edits WHERE text = 'written while viewing'")).rows[0];
  check("AND NOTHING REACHED THE ADD-ON'S OWN TABLE", Number(leaked.n) === 0, leaked);
  await owner("/api/auth/view-as/stop", { method: "POST" });
  await owner("/api/auth/view-as", { method: "POST", body: { user_id: clinical.id } });

  console.log("\n== It cannot be used to climb ==");
  const again = await owner("/api/auth/view-as", { method: "POST", body: { user_id: intake.id } });
  check("A VIEWING SESSION CANNOT START ANOTHER ONE -- no hopping account to account",
    again.status === 403, again.data);
  check("and cannot read the log from inside somebody else's account",
    (await owner("/api/auth/view-as/log")).status === 403);
  check("still the BCBA, not escalated by trying",
    (await owner("/api/auth/me")).data.user.role === "clinical");

  console.log("\n== The way out ==");
  const stopped = await owner("/api/auth/view-as/stop", { method: "POST" });
  check("STOPPING WORKS even though it is a POST", stopped.status === 200, stopped.data);
  const back = (await owner("/api/auth/me")).data.user;
  check("the owner is themselves again", back.role === "owner" && Number(back.id) === Number(me.id), back.role);
  check("and the banner is gone", !back.view_as, back.view_as);
  check("their own screens work again", (await owner("/api/admin/users")).status === 200);
  check("stopping when not viewing is harmless",
    (await owner("/api/auth/view-as/stop", { method: "POST" })).status === 200);

  console.log("\n== It is written down ==");
  const log = (await owner("/api/auth/view-as/log")).data.entries || [];
  const entry = log.find((e) => e.target_email === "clinical@spectrumsquadlv.com");
  check("the session is in the log", !!entry, log.slice(0, 3));
  check("naming who looked", !!entry && entry.owner_email === me.email, entry);
  check("and whose account they looked at", !!entry && entry.target_role === "clinical", entry);
  check("with a start and an end", !!entry && !!entry.started_at && !!entry.ended_at, entry);
  check("THE RECORD IS READABLE -- an audit trail nothing can read is not one",
    log.length >= 1, log.length);

  console.log("\n== Signing out from inside a view ==");
  await owner("/api/auth/view-as", { method: "POST", body: { user_id: intake.id } });
  check("viewing again works", (await owner("/api/auth/me")).data.user.role === "intake");
  check("SIGNING OUT IS ALLOWED, or somebody would be stuck",
    (await owner("/api/auth/logout", { method: "POST" })).status === 200);
  check("and the session really is gone",
    (await owner("/api/auth/me")).status === 401);
  const closed = (await pool.query(
    `SELECT ended_reason FROM admin_view_as_log WHERE target_email = 'intake@spectrumsquadlv.com'
     ORDER BY id DESC LIMIT 1`)).rows[0];
  check("that entry was closed too, rather than left open forever",
    !!closed && closed.ended_reason === "signed out", closed);

  replayFailures();
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
