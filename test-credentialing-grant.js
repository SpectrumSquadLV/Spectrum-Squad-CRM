// Credentialing has its own entry in the Access editor, and granting it works.
//
// REPORTED AS: "the credentialing menu navigation needs to be added in access."
//
// Two things were wrong. Credentialing had NO entry in the Access editor at
// all -- MODULE_CATALOG in index.html is what that editor is built from, and
// the key was missing -- so there was no way to give one person the new-hire
// credentialing view, or to take it away from somebody whose role carried it.
//
// And server-side the API rode on the "dashboard" access key, so the only
// lever that existed switched Credentialing off by switching off their whole
// dashboard. It now has its own key on both sides.
//
// What a grant must NOT do is hand over HR's edits or the owner's settings.
// A grant opens the read-only view; signing off a milestone stays with HR and
// the payer rules, deadlines and daily email stay with the owner. This suite
// proves that line holds in both directions.
//
//   DATABASE_URL=... node run-tests.js test-credentialing-grant.js
"use strict";

const BASE = process.env.BASE || "http://localhost:3009";

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else {
    fail++; failures.push(name);
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

const DASH = "/api/credentialing";          // the ordinary tier: the read-only view
const CONFIG = "/api/credentialing/config"; // payer rules and the daily email: the owner's
const NAV = "/api/nav-order";               // what decides the sidebar entry

(async () => {
  const owner = await login("admin@spectrumsquadlv.com", "TestOwner123!");
  // A billing role: not HR, not owner, and not designated Clinical Director,
  // so credentialing is closed to them by role alone.
  let billing = await login("billing@spectrumsquadlv.com", "TestStaff123!");

  section("Before the grant");
  {
    const r = await billing(DASH);
    check("a billing role cannot see credentialing by role alone", r.status === 403, r);
    const nav = await billing(NAV);
    check("...and gets no sidebar entry", nav.body && nav.body.credentialing_access === false, nav.body && nav.body.credentialing_access);
  }

  const users = await owner("/api/admin/users");
  const rows = Array.isArray(users.body) ? users.body : (users.body && (users.body.users || users.body.data)) || [];
  const them = rows.find((u) => String(u.email).startsWith("billing"));
  check("their account is visible to the owner", !!them, users.body);

  section("The owner grants Credentialing in Admin Settings");
  {
    const g = await owner("/api/admin/users/" + them.id, {
      method: "PATCH", body: { module_access: { credentialing: true } },
    });
    check("the grant saves", g.status === 200, g);

    // The grant rides on the session's user row, so sign in again.
    billing = await login("billing@spectrumsquadlv.com", "TestStaff123!");
    const r = await billing(DASH);
    check("the granted account can now open credentialing", r.status === 200, r);
    const nav = await billing(NAV);
    check("...and the sidebar entry appears", nav.body && nav.body.credentialing_access === true, nav.body && nav.body.credentialing_access);
  }

  section("A grant is the read-only view, not HR's job and not the owner's");
  {
    const d = await billing(DASH);
    check("the payload says they cannot edit", d.body && d.body.can_edit === false, d.body && d.body.can_edit);
    check("...and cannot configure", d.body && d.body.can_configure === false, d.body && d.body.can_configure);
    const cfgRead = await billing(CONFIG);
    check("they can read the config screen's payer list", cfgRead.status === 200, cfgRead.status);
    check("...but the daily email settings are withheld", cfgRead.body && cfgRead.body.email === undefined, cfgRead.body && cfgRead.body.email);
    const cfgWrite = await billing(CONFIG, { method: "PUT", body: { payers: [{ payer: "Aetna", requires_linking: true }] } });
    check("they cannot change the payer rules", cfgWrite.status === 403, cfgWrite);
    const emailAdmin = await billing("/api/credentialing/email/log");
    check("they cannot touch the daily email", emailAdmin.status === 403, emailAdmin);
    const track = await billing("/api/credentialing/track", { method: "POST", body: { employee_id: 1 } });
    check("they cannot put somebody on the tracker", track.status === 403, track);
  }

  section("An explicit Off closes it, even for a role that would have it");
  {
    const off = await owner("/api/admin/users/" + them.id, {
      method: "PATCH", body: { module_access: { credentialing: false } },
    });
    check("the owner can switch it back off", off.status === 200, off);
    const back = await login("billing@spectrumsquadlv.com", "TestStaff123!");
    const r = await back(DASH);
    check("an explicit off closes it again", r.status === 403, r);
    const nav = await back(NAV);
    check("...and the sidebar entry goes with it", nav.body && nav.body.credentialing_access === false, nav.body && nav.body.credentialing_access);

    // The point of a separate key: blocking credentialing must not take their
    // dashboard with it, which is the only lever that existed before.
    const dash = await back("/api/dashboard");
    check("their dashboard is untouched by a credentialing block", dash.status !== 403, dash.status);
  }

  section("Off means off for an HR account too, not just hidden in the sidebar");
  {
    await owner("/api/admin/users/" + them.id, { method: "PATCH", body: { module_access: {} } });
    const hrUser = rows.find((u) => String(u.email).startsWith("intake"));
    check("the intake account is visible", !!hrUser, rows.map((u) => u.email));
    await owner("/api/admin/users/" + hrUser.id, { method: "PATCH", body: { role: "hr_admin" } });
    const hr = await login("intake@spectrumsquadlv.com", "TestStaff123!");
    check("an HR admin has it by role", (await hr(DASH)).status === 200);
    await owner("/api/admin/users/" + hrUser.id, { method: "PATCH", body: { module_access: { credentialing: false } } });
    const hrOff = await login("intake@spectrumsquadlv.com", "TestStaff123!");
    check("switching it off refuses the API, not just the button", (await hrOff(DASH)).status === 403);
    const nav = await hrOff(NAV);
    check("...and the nav flag tells the truth rather than relying on the sidebar",
      nav.body && nav.body.credentialing_access === false, nav.body && nav.body.credentialing_access);
    await owner("/api/admin/users/" + hrUser.id, { method: "PATCH", body: { module_access: {} } });
  }

  section("The people who always had it still do");
  {
    const r = await owner(DASH);
    check("the owner never needed a grant", r.status === 200, r);
    check("...and still configures", r.body && r.body.can_configure === true, r.body && r.body.can_configure);
  }

  section("The wiring that makes it possible");
  {
    const fs = require("fs"), path = require("path");
    const SRV = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const SP = fs.readFileSync(path.join(__dirname, "staff-progression.js"), "utf8");
    const IDX = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    check("the Access editor has a Credentialing entry to show",
      /^\s*credentialing: \{ label: "Credentialing",/m.test(IDX));
    check("server.js hands the module moduleGranted and moduleDenied",
      /require\("\.\/staff-progression"\)\(\{[\s\S]{0,900}moduleGranted, moduleDenied/.test(SRV));
    check("the API has its own access key, not the dashboard's",
      /pathname\.startsWith\("\/api\/credentialing"\) \? "credentialing"/.test(SRV));
    check("the progression WIDGET still follows the dashboard",
      /pathname\.startsWith\("\/api\/staff-progression"\) \? "dashboard"/.test(SRV));
    check("canSee consults the deny and the grant",
      /async function canSee[\s\S]{0,400}denied\(user, "credentialing"\)[\s\S]{0,300}granted\(user, "credentialing"\)/.test(SP));
    check("editing deliberately does NOT follow the grant",
      /out\.can_edit = hrCanManage\(user\);/.test(SP));
    check("configuring deliberately stays with the owner",
      /const canConfigure = ctx\.canConfigure \|\| \(\(u\) => !!u && u\.role === "owner"\);/.test(SP));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("\nFailures:"); failures.forEach((f) => console.log("  - " + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
