// Granting Staff Attendance in the Access editor actually grants it.
//
// REPORTED AS: "in admin settings it's granted that Marissa has access to see
// staff attendance but for some reason it says she is not permitted."
//
// The Access editor's toggle was ONE-WAY for this section. Switching it OFF
// worked, because server.js enforces an explicit off by path prefix. Switching
// it ON did nothing: hr-attendance.js was the only module with a toggle that
// was never handed moduleGranted, so canManage() went on refusing anybody
// whose ROLE was not owner / super_admin / admin / hr_admin.
//
// The visible result was worse than a refusal. The grant put Staff Attendance
// in the sidebar -- the nav is built straight out of the granted keys -- so the
// person saw the button the owner had just given them, clicked it, and was told
// "Not permitted". That reads as a broken CRM, not a missing wire.
//
// What a grant must NOT do is hand over the policy. The points matrix, the
// attendance import and the monthly review decide discipline levels and who is
// owed a bonus; those stay role-gated, and this suite proves the line holds.
//
//   DATABASE_URL=... node run-tests.js test-attendance-grant.js
"use strict";

const BASE = process.env.BASE || "http://localhost:3009";

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else {
    fail++;
    console.log("  FAIL  " + name + (detail !== undefined
      ? "\n          -> " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : ""));
  }
};
const section = (t) => console.log("\n== " + t + " ==");

function client() {
  let jar = "";
  return async (path, opts = {}) => {
    const r = await fetch(BASE + path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", ...(jar ? { Cookie: jar } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      redirect: "manual",
    });
    const setC = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (setC && setC.length) jar = setC.map((c) => c.split(";")[0]).join("; ");
    let body = null;
    try { body = await r.json(); } catch (e) { body = null; }
    return { status: r.status, body };
  };
}
const login = async (email, password) => {
  const c = client();
  const r = await c("/api/auth/login", { method: "POST", body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status}`);
  return c;
};

// The roster is the ordinary tier: reading who is where on attendance.
const ROSTER = "/api/attendance/roster";
// The matrix is the policy the points and the bonus come from.
const MATRIX = "/api/attendance/types";

(async () => {
  const owner = await login("admin@spectrumsquadlv.com", "TestOwner123!");
  // Stands in for Marissa: a clinical role, which is not one of the four that
  // carry attendance access by role.
  let marissa = await login("clinical@spectrumsquadlv.com", "TestStaff123!");

  section("Before the grant");
  {
    const r = await marissa(ROSTER);
    check("a clinical role cannot see attendance by role alone", r.status === 403, r);
  }

  const users = await owner("/api/admin/users");
  const rows = Array.isArray(users.body) ? users.body : (users.body && (users.body.users || users.body.data)) || [];
  const her = rows.find((u) => String(u.email).startsWith("clinical"));
  check("her account is visible to the owner", !!her, users.body);

  section("The owner grants Staff Attendance in Admin Settings");
  {
    const g = await owner("/api/admin/users/" + her.id, {
      method: "PATCH", body: { module_access: { attendance: true } },
    });
    check("the grant saves", g.status === 200, g);

    // The grant rides on the session's user row, so sign in again.
    marissa = await login("clinical@spectrumsquadlv.com", "TestStaff123!");
    const r = await marissa(ROSTER);
    check("SHE CAN NOW SEE STAFF ATTENDANCE -- the bug that was reported",
      r.status === 200, r);
    const t = await marissa(MATRIX);
    check("...and read the attendance types the roster is scored against", t.status === 200, t);
  }

  section("What the grant does NOT hand over");
  {
    const m = await marissa(MATRIX, { method: "PUT", body: { types: [] } });
    check("the points matrix stays owner/admin only", m.status === 403, m);

    const imp = await marissa("/api/attendance/import/preview", { method: "POST", body: { csv: "" } });
    check("so does the attendance import", imp.status === 403, imp);

    const rev = await marissa("/api/attendance/monthly-review", { method: "POST", body: {} });
    check("and so does firing the monthly review", rev.status === 403, rev);
  }

  section("Switching it off again");
  {
    const off = await owner("/api/admin/users/" + her.id, {
      method: "PATCH", body: { module_access: { attendance: false } },
    });
    check("the owner can switch it back off", off.status === 200, off);

    const back = await login("clinical@spectrumsquadlv.com", "TestStaff123!");
    const r = await back(ROSTER);
    check("an explicit off closes it again", r.status === 403, r);
  }

  section("The people who always had it still do");
  {
    await owner("/api/admin/users/" + her.id, { method: "PATCH", body: { module_access: {} } });
    const r = await owner(ROSTER);
    check("the owner never needed a grant", r.status === 200, r);
  }

  section("The wiring that makes it possible");
  {
    const fs = require("fs"), path = require("path");
    const SRV = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const ATT = fs.readFileSync(path.join(__dirname, "hr-attendance.js"), "utf8");
    check("server.js hands the attendance module moduleGranted",
      /require\("\.\/hr-attendance"\)\(\{[\s\S]{0,700}moduleGranted/.test(SRV));
    check("canManage consults the grant", /function canManage[\s\S]{0,260}moduleGranted\(user, "attendance"\)/.test(ATT));
    check("canEditMatrix deliberately does NOT",
      /function canEditMatrix\(user\) \{\s*return \["owner", "super_admin", "admin"\]\.includes\(role\(user\)\);\s*\}/.test(ATT));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
