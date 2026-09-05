// A personal task list is personal, and a leaver is off the roster.
//
//   DATABASE_URL=... node server.js
//   DATABASE_URL=... BASE=http://127.0.0.1:3009 node test-task-privacy.js
//
// TWO REPORTS, both about somebody appearing where they should not.
//
// 1. "MARISSA CAN SEE MY TASK." She could. Not through a hole -- through a
//    rule. A staffer sees tasks assigned to them, tasks they created, and
//    tasks on a client they are assigned to, and that third one had no regard
//    for whether the task already belonged to somebody. The owner's own to-do,
//    sitting on a client whose BCBA is Marissa, was on Marissa's screen: not
//    assigned to her, not created by her, and nothing she could act on.
//
//    The caseload rule is still right for what it was written for -- an
//    UNASSIGNED task on a client is work nobody has picked up, and the
//    clinician on that client is exactly who should see it. So the fix is
//    narrow: the caseload branch reaches unassigned tasks only.
//
//    THE FAILURE TO GUARD AGAINST IS THE OPPOSITE ONE. Narrowing this too far
//    hides work from the person who has to do it, and a task nobody can see is
//    a task nobody does. So this suite checks just as hard that the assignee
//    still sees theirs, that the creator still sees what they raised, that
//    supervisors still see everything, and that unassigned client work still
//    reaches the caseload.
//
// 2. "TERMINATED EMPLOYEES SHOULD NO LONGER SHOW." The staff picker built
//    itself from two places -- HR records and CRM logins -- and filtered
//    leavers out of the first but not the second. Anybody who left holding a
//    login stayed in "Assign to" indefinitely.
//
//    Their RECORDS ARE NOT TOUCHED. This is one picker of people you can hand
//    work to today; what they already did stays where it is, under their name.
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
const replay = () => { if (failures.length) { console.log("\n--- failures ---"); failures.forEach((f) => console.log(f)); } };

function client() {
  let jar = "";
  const send = async (path, { method = "GET", body } = {}) => {
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
  send.login = (email, password) => send("/api/auth/login", { method: "POST", body: { email, password } });
  return send;
}

const titles = async (who, qs) => ((await who("/api/staff-tasks" + (qs || ""))).data || []).map((t) => t.title);
const sees = async (who, title, qs) => (await titles(who, qs)).includes(title);

(async () => {
  const owner = client(), bcba = client(), other = client();
  check("owner signs in", (await owner.login("admin@spectrumsquadlv.com", "TestOwner123!")).status === 200);
  check("a BCBA signs in", (await bcba.login("clinical@spectrumsquadlv.com", "TestStaff123!")).status === 200);
  check("a second staffer signs in", (await other.login("billing@spectrumsquadlv.com", "TestStaff123!")).status === 200);

  const me = (await owner("/api/auth/me")).data.user;
  const them = (await bcba("/api/auth/me")).data.user;

  // A client on the BCBA's caseload -- the thing that made the leak.
  const clientId = (await pool.query(
    `INSERT INTO clients (child_name, stage, submitted_at, assigned_bcba_name, assigned_bcba_email)
     VALUES ('Zz Task Privacy Child','active',now()::text,$1,$2) RETURNING id`,
    [them.name, them.email])).rows[0].id;

  const mk = async (title, extra) => (await owner("/api/staff-tasks", {
    method: "POST", body: { title, client_id: clientId, ...extra },
  })).data;

  console.log("\n== The report: the owner's own task, on the BCBA's client ==");
  const OWN = "Zz Owner personal to-do";
  await mk(OWN, { assigned_user_id: me.id, assigned_name: me.name, assigned_email: me.email });
  check("the owner sees their own task", await sees(owner, OWN));
  check("THE BCBA DOES NOT, even though it sits on their client",
    !(await sees(bcba, OWN)), await titles(bcba));
  check("nor in their personal Task Center", !(await sees(bcba, OWN, "?scope=mine")));
  check("and neither does an unrelated staffer", !(await sees(other, OWN)));

  console.log("\n== A task assigned TO the BCBA still reaches them ==");
  const HERS = "Zz Assigned to the BCBA";
  await mk(HERS, { assigned_user_id: them.id, assigned_name: them.name, assigned_email: them.email });
  check("THE ASSIGNEE SEES IT -- the failure nobody would report is work going missing",
    await sees(bcba, HERS), await titles(bcba));
  check("and it is in their Task Center", await sees(bcba, HERS, "?scope=mine"));
  check("the owner sees it too, as a supervisor", await sees(owner, HERS));
  check("but the unrelated staffer does not", !(await sees(other, HERS)));

  console.log("\n== Unassigned work on their client still reaches them ==");
  // The reason the caseload rule exists. Narrowing it away entirely would hide
  // work nobody has picked up from the one person who would pick it up.
  //
  // Written straight to the table on purpose. POST /api/staff-tasks treats a
  // blank assignee as "myself" and fills in the creator, so THE API CANNOT
  // PRODUCE ONE -- the unassigned rows that exist come from HR's automatic
  // tasks and onboarding. Those carry no client, so in practice this branch is
  // dormant today; it is kept, and tested, because the rule it encodes is the
  // right one the moment an unassigned client task does appear.
  const LOOSE = "Zz Nobody has picked this up";
  await pool.query(
    `INSERT INTO staff_tasks (title, assigned_user_id, assigned_name, assigned_email, client_id, status, created_by, created_at)
     VALUES ($1, NULL, NULL, NULL, $2, 'open', 'system', now()::text)`, [LOOSE, clientId]);
  const loose = ((await owner("/api/staff-tasks")).data || []).find((t) => t.title === LOOSE);
  check("it really was stored with no assignee",
    !!loose && !loose.assigned_user_id && !loose.assigned_name, loose);
  check("THE CLINICIAN ON THAT CLIENT SEES IT", await sees(bcba, LOOSE), await titles(bcba));
  check("and a staffer with no connection to the client does not",
    !(await sees(other, LOOSE)), await titles(other));

  console.log("\n== What a person raised themselves ==");
  const RAISED = "Zz Raised by the BCBA for somebody else";
  const raised = await bcba("/api/staff-tasks", {
    method: "POST", body: { title: RAISED, assigned_user_id: me.id, assigned_name: me.name, assigned_email: me.email },
  });
  check("a BCBA can hand work to a colleague", raised.status === 201 || raised.status === 200, raised.status);
  check("AND STILL SEES WHAT THEY RAISED -- handing it over is not losing sight of it",
    await sees(bcba, RAISED), await titles(bcba));
  check("the person it was given to sees it", await sees(owner, RAISED));

  console.log("\n== It cannot be widened by asking ==");
  const wide = await bcba("/api/staff-tasks?scope=all");
  check("an unknown scope does not lift the filter",
    !((wide.data || []).some((t) => t.title === OWN)), (wide.data || []).map((t) => t.title));
  check("nor does asking for done ones",
    !(await sees(bcba, OWN, "?status=done")) && !(await sees(bcba, OWN, "?status=open")));

  console.log("\n== Somebody who has left ==");
  const GONE = "zz.leaver@spectrumsquadlv.com";
  await pool.query("DELETE FROM users WHERE lower(email) = lower($1)", [GONE]);
  await pool.query(
    `INSERT INTO hr_employees (name, email, status) VALUES ('Zz Departed Person', $1, 'terminated')`, [GONE]);
  const staffNow = (await owner("/api/staff")).data || [];
  check("a terminated employee is not in the staff picker",
    !staffNow.some((s) => (s.email || "").toLowerCase() === GONE), staffNow.filter((s) => /zz/i.test(s.name || "")));

  // The one that was actually broken: a leaver who still holds a CRM login.
  await pool.query(
    `INSERT INTO users (name, email, role, password_hash, password_salt)
     VALUES ('Zz Departed Person', $1, 'clinical', 'x', 'y')`, [GONE]);
  const staffAfter = (await owner("/api/staff")).data || [];
  check("A LEAVER WHO STILL HAS A LOGIN IS NOT IN IT EITHER",
    !staffAfter.some((s) => (s.email || "").toLowerCase() === GONE),
    staffAfter.filter((s) => /zz departed/i.test(s.name || "")));
  check("and the people who are still here are all still offered",
    staffAfter.some((s) => (s.email || "").toLowerCase() === "clinical@spectrumsquadlv.com") &&
    staffAfter.some((s) => (s.email || "").toLowerCase() === "admin@spectrumsquadlv.com"),
    staffAfter.length);

  // Hiding somebody from a picker must not touch what they did.
  const stillThere = await pool.query(
    "SELECT COUNT(*)::int AS n FROM users WHERE lower(email) = lower($1)", [GONE]);
  check("THEIR ACCOUNT AND RECORDS ARE UNTOUCHED -- this hides a picker, it does not delete a person",
    Number(stillThere.rows[0].n) === 1, stillThere.rows[0]);
  const empStill = await pool.query(
    "SELECT status FROM hr_employees WHERE lower(email) = lower($1)", [GONE]);
  check("and their staff record is exactly as it was",
    empStill.rows[0] && empStill.rows[0].status === "terminated", empStill.rows[0]);

  replay();
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
