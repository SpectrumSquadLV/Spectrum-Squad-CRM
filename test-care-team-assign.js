// test-care-team-assign.js -- assigning a Student Analyst and a Squad Leader.
//
// WHY THIS EXISTS. Until now the only thing in the entire CRM that ever wrote
// assigned_student_analyst_name or squad_leader_name was the one-time
// assignment migration. The Care team card was read-only and said so: it told
// the reader to go and run a migration. So on any client enrolled after that
// cleanup, those two fields could not be filled in at all, and the BCBA
// dashboard's Student Analyst panel had nothing to show for them.
//
// The permission is deliberately NOT widened: the same owner/admin tier that
// could run the migration is the tier that can assign. A better tool for the
// same people.
"use strict";

const BASE = process.env.BASE || "http://localhost:3009";
const OWNER_PW = process.env.OWNER_PASSWORD || "TestOwner123!";

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else {
    fail++;
    const d = detail === undefined ? "" : "\n          -> " +
      String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400);
    console.log("  FAIL  " + name + d);
  }
};
const section = (t) => console.log("\n== " + t + " ==");

async function login(email, password) {
  const res = await fetch(BASE + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error("login failed for " + email + ": " + res.status);
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  return async (path, opts = {}) => {
    const r = await fetch(BASE + path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, data: ct.includes("json") ? await r.json().catch(() => ({})) : await r.text() };
  };
}

(async () => {
  const owner = await login("admin@spectrumsquadlv.com", OWNER_PW);
  const stamp = Date.now().toString().slice(-6);

  const c = await owner("/api/clients", {
    method: "POST",
    body: {
      child_name: `Care Team ${stamp}`, parent_name: "Parent CT",
      parent_email: `ct.${stamp}@example.invalid`, parent_phone: "7025550001",
    },
  });
  const id = c.data && (c.data.id || (c.data.client && c.data.client.id));
  check("a client to assign somebody to", !!id, c.data);
  if (!id) process.exit(1);

  section("A newly enrolled client starts with nobody on the case");

  let r = await owner(`/api/clients/${id}`);
  check("the record loads", r.status === 200, r.status);
  check("no Student Analyst yet", !r.data.client.assigned_student_analyst_name, r.data.client);
  check("no Squad Leader yet", !r.data.client.squad_leader_name, r.data.client);

  section("And both can now be assigned");

  const ANALYST = `Juniper Kade ${stamp}`;
  const SQUAD = `Marlow Quill ${stamp}`;
  r = await owner(`/api/clients/${id}/care-team`, {
    method: "PATCH",
    body: { assigned_student_analyst_name: ANALYST, squad_leader_name: SQUAD },
  });
  check("the assignment is accepted", r.status === 200, r.data);
  check("...and it reports the Student Analyst back", r.data.assigned_student_analyst_name === ANALYST, r.data);
  check("...and the Squad Leader", r.data.squad_leader_name === SQUAD, r.data);

  r = await owner(`/api/clients/${id}`);
  check("THE STUDENT ANALYST IS ON THE RECORD, which nothing but a migration could do before",
    r.data.client.assigned_student_analyst_name === ANALYST, r.data.client.assigned_student_analyst_name);
  check("...and so is the Squad Leader",
    r.data.client.squad_leader_name === SQUAD, r.data.client.squad_leader_name);

  section("The names already on file are offered, so a fourth spelling is not invented");

  r = await owner("/api/clients/care-team-names");
  check("the name list loads", r.status === 200, r.status);
  check("...and it now offers the analyst just assigned",
    (r.data.student_analyst || []).includes(ANALYST), (r.data.student_analyst || []).slice(0, 6));
  check("...and the squad leader",
    (r.data.squad_leader || []).includes(SQUAD), (r.data.squad_leader || []).slice(0, 6));

  section("Taking somebody off a case is as real as putting them on");

  r = await owner(`/api/clients/${id}/care-team`, {
    method: "PATCH", body: { squad_leader_name: "" } });
  check("a blank clears the assignment", r.status === 200 && r.data.squad_leader_name === null, r.data);
  r = await owner(`/api/clients/${id}`);
  check("...on the record too", !r.data.client.squad_leader_name, r.data.client.squad_leader_name);
  check("...and the analyst was not disturbed by it",
    r.data.client.assigned_student_analyst_name === ANALYST, r.data.client.assigned_student_analyst_name);

  section("The refusals");

  r = await owner(`/api/clients/${id}/care-team`, { method: "PATCH", body: { child_name: "Renamed" } });
  check("a field that is not a care-team field is refused", r.status === 400, r.data);
  r = await owner(`/api/clients/${id}`);
  check("...and the child's name is untouched",
    r.data.client.child_name === `Care Team ${stamp}`, r.data.client.child_name);
  r = await owner("/api/clients/99999999/care-team", {
    method: "PATCH", body: { squad_leader_name: "X" } });
  check("a client that does not exist is a 404", r.status === 404, r.status);

  section("Who may assign");

  const mkUser = async (label, role) => {
    const email = `ct.${label}.${stamp}@example.invalid`;
    const u = await owner("/api/admin/users", {
      method: "POST", body: { name: `CT ${label}`, email, password: "CareTeam123!", role },
    });
    if (u.status !== 201) throw new Error(`${label}: ${JSON.stringify(u.data)}`);
    return await login(email, "CareTeam123!");
  };

  // Clinical staff read client records and need to SEE who is on a case; they
  // do not decide it. This is the same tier that could run the migration.
  const clinical = await mkUser("clinical", "clinical");
  r = await clinical(`/api/clients/${id}/care-team`, {
    method: "PATCH", body: { assigned_student_analyst_name: "Someone Else" } });
  check("a clinical user cannot change the care team", r.status === 403, r.data);
  r = await clinical("/api/clients/care-team-names");
  check("...but can see the names, to know who is on a case", r.status === 200, r.status);

  const hrAdmin = await mkUser("hr", "hr_admin");
  r = await hrAdmin(`/api/clients/${id}/care-team`, {
    method: "PATCH", body: { assigned_student_analyst_name: "Someone Else" } });
  check("somebody with no client access cannot either", r.status === 403, r.data);

  r = await owner(`/api/clients/${id}`);
  check("and the assignment survived every refusal",
    r.data.client.assigned_student_analyst_name === ANALYST, r.data.client.assigned_student_analyst_name);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness error:", (e && e.stack) || e); process.exit(1); });
