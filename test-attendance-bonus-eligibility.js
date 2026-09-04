// Who the $50 attendance bonus is for.
//
//   DATABASE_URL=... node server.js
//   DATABASE_URL=... BASE=http://127.0.0.1:3009 node test-attendance-bonus-eligibility.js
//
// BCBAs and administrative staff are not in the scheme. The rule is small; the
// ways it goes wrong are not, and every one of them is silent:
//
//   * EXCLUDING SOMEBODY WHO SHOULD BE PAID. A withheld bonus produces no
//     error, no email and nothing on the employee's own screen. The first
//     anyone hears is a person asking where their $50 went, months later. So
//     the rule has to be narrow, and "BCaBA" in particular must not be caught
//     by a pattern meant for "BCBA".
//   * EXCLUDING SOMEBODY FROM THE POLICY ITSELF. Being outside the bonus is not
//     being outside the attendance policy: points, standing and the discipline
//     ladder still apply to a BCBA. Only the payout does not.
//   * SAYING THE WRONG THING TO THEM. "Not eligible this cycle" reads as though
//     they failed something. "Next bonus date 12 Nov" is a promise the policy
//     does not make. Neither belongs on the row of somebody the scheme does not
//     cover.
"use strict";
const { Pool } = require("pg");

const BASE = process.env.BASE || "http://localhost:3009";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (d !== undefined ? "  -> " + JSON.stringify(d).slice(0, 300) : "")); }
};

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

// Hired well over a cycle ago and with a clean record, so every one of these
// people WOULD be on track for the bonus if nothing excluded them. That is what
// makes the assertions below about the rule rather than about the points.
const HIRE = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);

async function addEmployee(name, roleTitle, crmEmail) {
  let userId = null;
  if (crmEmail) {
    const u = (await pool.query("SELECT id FROM users WHERE lower(email) = lower($1)", [crmEmail])).rows[0];
    userId = u ? u.id : null;
  }
  const row = (await pool.query(
    `INSERT INTO hr_employees (name, role_title, hire_date, status, user_id, created_at)
     VALUES ($1,$2,$3,'active',$4,now()::text) RETURNING id`,
    [name, roleTitle, HIRE, userId]
  )).rows[0];
  return row.id;
}

(async () => {
  const owner = client();
  const r = await owner("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
  check("owner signs in", r.status === 200, r.data);

  const people = {
    rbt:        await addEmployee("Zz Test RBT", "Registered Behavior Technician", null),
    bcabaTitle: await addEmployee("Zz Test BCaBA", "BCaBA", null),
    bcbaTitle:  await addEmployee("Zz Test BCBA Title", "BCBA", null),
    bcbaSpelt:  await addEmployee("Zz Test Analyst", "Board Certified Behavior Analyst", null),
    director:   await addEmployee("Zz Test Director", "Clinical Director", null),
    bcbaLogin:  await addEmployee("Zz Test BCBA Login", "Behavior Specialist", "clinical@spectrumsquadlv.com"),
    adminLogin: await addEmployee("Zz Test Admin Login", "Operations", "admin@spectrumsquadlv.com"),
    noTitle:    await addEmployee("Zz Test Untitled", "", null),
    manager:    await addEmployee("Zz Test Office Manager", "Office Manager", null),
  };

  const roster = await owner("/api/attendance/roster");
  check("the roster loads", roster.status === 200, roster.data && roster.data.error);
  const byId = Object.fromEntries((roster.data.staff || []).map((s) => [s.employee_id, s]));
  const who = (k) => byId[people[k]];

  console.log("\n== Who is in the scheme ==");
  check("AN RBT IS STILL PAID", who("rbt").bonus_eligible === true && who("rbt").bonus_excluded !== true, who("rbt"));
  check("somebody with no job title recorded is still paid, rather than excluded on a blank",
    who("noTitle").bonus_eligible === true, who("noTitle"));
  check("AN OFFICE MANAGER IS STILL PAID -- 'administrative-sounding' is not the rule",
    who("manager").bonus_eligible === true, who("manager"));
  check("A BCaBA IS STILL PAID, and is not caught by the BCBA pattern",
    who("bcabaTitle").bonus_eligible === true && who("bcabaTitle").bonus_excluded !== true, who("bcabaTitle"));

  console.log("\n== Who is not ==");
  check("a BCBA by job title is excluded", who("bcbaTitle").bonus_excluded === true, who("bcbaTitle"));
  check("and by the title spelled out in full", who("bcbaSpelt").bonus_excluded === true, who("bcbaSpelt"));
  check("a Clinical Director is excluded", who("director").bonus_excluded === true, who("director"));
  check("A BCBA IS FOUND BY THEIR CRM ROLE even when the job title says nothing",
    who("bcbaLogin").bonus_excluded === true && who("bcbaLogin").bonus_exclusion_source === "crm_role",
    who("bcbaLogin"));
  check("and so is an admin", who("adminLogin").bonus_excluded === true, who("adminLogin"));
  check("none of them is reported as eligible",
    ["bcbaTitle", "bcbaSpelt", "director", "bcbaLogin", "adminLogin"].every((k) => who(k).bonus_eligible === false),
    ["bcbaTitle", "bcbaSpelt", "director", "bcbaLogin", "adminLogin"].map((k) => [k, who(k).bonus_eligible]));

  console.log("\n== What their row says ==");
  const bcba = who("bcbaLogin");
  check("it says WHY, in words, rather than just going quiet",
    /not in the attendance bonus/i.test(bcba.bonus_status || ""), bcba.bonus_status);
  check("it does not read as though they failed a cycle",
    !/not eligible this cycle/i.test(bcba.bonus_status || ""), bcba.bonus_status);
  check("AND IT PROMISES NO PAYOUT DATE", bcba.next_bonus_date === null, bcba.next_bonus_date);

  console.log("\n== They are still under the attendance policy ==");
  // Being outside the bonus is not being outside the policy. Log an occurrence
  // against the excluded BCBA and check the ladder still moves.
  const logged = await owner("/api/attendance/employee/" + people.bcbaLogin, {
    method: "POST",
    body: { type_key: "ncns", incident_date: new Date().toISOString().slice(0, 10), notify: false },
  });
  const detail = await owner("/api/attendance/employee/" + people.bcbaLogin);
  const score = detail.data && detail.data.score;
  check("an occurrence can be logged against them", logged.status === 201 || logged.status === 200, logged.data);
  check("THEIR POINTS ARE STILL COUNTED", score && score.points_90 > 0, score && score.points_90);
  check("and their standing moves to match -- a no-call/no-show is 5 points",
    score && score.points_90 === 5 && /termination|final|written/i.test(score.discipline_level || ""),
    score && { points: score.points_90, level: score.discipline_level });
  check("their monthly review level moves too",
    score && /leadership|improvement|coaching/i.test(score.review_level || ""),
    score && score.review_level);
  check("they are still excluded from the bonus, not re-included by having points",
    score && score.bonus_excluded === true, score && score.bonus_status);

  console.log("\n== The roster totals reconcile ==");
  const t = (await owner("/api/attendance/roster")).data.totals;
  check("the excluded are counted", t.bonus_excluded >= 5, t);
  check("and the in-scheme figure is the rest of the roster",
    t.bonus_in_scheme + t.bonus_excluded === t.people, t);
  check("nobody on track is also excluded", t.bonus_eligible <= t.bonus_in_scheme, t);

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
