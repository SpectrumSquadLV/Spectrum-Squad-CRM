// Curriculum management, and the versioning that makes it safe.
//
// THE CLAIM THIS FILE EXISTS FOR: editing the curriculum does not rewrite
// what somebody has already finished.
//
// Until step 4 the enrolment recorded a program_version that nothing read --
// every screen rebuilt the curriculum from the current rows. Harmless while
// nothing could edit a curriculum. Curriculum management is exactly the thing
// that makes it live: rename a week, and the record of who completed what
// quietly becomes a record of something else. The brief says preserve the
// version each employee completed, so:
//
//   * an enrolment keeps reading its own version for ever
//   * editing a programme nobody is on edits it in place
//   * editing one somebody IS on forks to a new version
//   * a forked week carries its items across, rather than emptying itself
//   * a completed onboarding can never be moved to a newer curriculum
//
//   DATABASE_URL=... BASE=http://127.0.0.1:3011 node test-academy-curriculum.js
"use strict";
const { Pool } = require("pg");
const crypto = require("crypto");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const BASE = process.env.BASE || "http://localhost:3011";
const stamp = Date.now().toString(36);

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

const hp = (pw) => {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") };
};
function session() {
  let cookie = "";
  return async function (path, opts = {}) {
    const r = await fetch(BASE + path, {
      method: opts.method || "GET",
      headers: { ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      redirect: "manual",
    });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  };
}

(async () => {
  const purge = async () => {
    const ids = "(SELECT id FROM hr_employees WHERE name LIKE 'AcadCur %')";
    const enr = `(SELECT id FROM academy_enrollments WHERE employee_id IN ${ids})`;
    for (const t of ["academy_dev_plans", "academy_progress", "academy_audit", "academy_checkins",
                     "academy_questions", "academy_gaps"]) {
      await pool.query(`DELETE FROM ${t} WHERE enrollment_id IN ${enr}`).catch(() => {});
    }
    await pool.query(`DELETE FROM academy_review_ratings WHERE review_id IN (SELECT id FROM academy_reviews WHERE enrollment_id IN ${enr})`).catch(() => {});
    await pool.query(`DELETE FROM academy_reviews WHERE enrollment_id IN ${enr}`).catch(() => {});
    await pool.query(`DELETE FROM academy_enrollments WHERE employee_id IN ${ids}`).catch(() => {});
    await pool.query("DELETE FROM hr_employees WHERE name LIKE 'AcadCur %'").catch(() => {});
    await pool.query("DELETE FROM users WHERE email LIKE 'acadcur-%'").catch(() => {});
    // the test programmes
    const progs = "(SELECT id FROM academy_programs WHERE key LIKE 'acadcur-%')";
    await pool.query(`DELETE FROM academy_items WHERE module_id IN (SELECT id FROM academy_modules WHERE program_id IN ${progs})`).catch(() => {});
    await pool.query(`DELETE FROM academy_modules WHERE program_id IN ${progs}`).catch(() => {});
    await pool.query(`DELETE FROM academy_enrollments WHERE program_id IN ${progs}`).catch(() => {});
    await pool.query(`DELETE FROM academy_programs WHERE key LIKE 'acadcur-%'`).catch(() => {});
  };

  try {
    await purge();

    const owner = session();
    const ol = await owner("/api/auth/login", {
      method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
    if (ol.status !== 200) throw new Error("owner login failed: " + ol.status);

    const plain = session();
    const pe = `acadcur-plain-${stamp}@example.invalid`;
    const pp = hp("AcadCur123!");
    await pool.query(
      `INSERT INTO users (name, email, password_hash, password_salt, role, created_at)
       VALUES ('AcadCur Plain',$1,$2,$3,'clinical', now())`, [pe, pp.hash, pp.salt]);
    const plainEmp = (await pool.query(
      `INSERT INTO hr_employees (name, email, role_title, hr_hire_date, status)
       VALUES ('AcadCur Plain',$1,'BCBA',$2,'active') RETURNING id`,
      [pe, new Date().toISOString().slice(0, 10)])).rows[0].id;
    const pl = await plain("/api/auth/login", { method: "POST", body: { email: pe, password: "AcadCur123!" } });
    if (pl.status !== 200) throw new Error("plain login failed");

    // =====================================================================
    section("ONLY LEADERSHIP TOUCHES THE CURRICULUM");
    const f1 = await plain("/api/academy/programs");
    check("an ordinary BCBA cannot list programmes", f1.status === 403, f1);
    const f2 = await plain("/api/academy/programs", { method: "POST", body: { name: "My own programme" } });
    check("nor create one", f2.status === 403, f2);

    // =====================================================================
    section("A SECOND PROGRAMME, WHICH IS THE BRIEF'S LAST REQUIREMENT");
    // "the curriculum framework can eventually be reused for RBT onboarding,
    // Squad Leader development..." -- so this must not need a developer.
    const mk = await owner("/api/academy/programs", { method: "POST", body: {
      name: `AcadCur RBT Onboarding ${stamp}`, key: `acadcur-rbt-${stamp}`, weeks: 2, duration_days: 14 } });
    check("leadership can create an RBT programme without a developer", mk.status === 200, mk.data);
    const prog = mk.data.program;
    check("it starts at version 1", Number(prog.version) === 1, prog.version);
    check("it is usable straight away, so a pilot cohort can be enrolled by hand",
      prog.active === true, prog.active);
    // The sweep enrols people automatically onto programmes that have a
    // role_target. A new one has none, so saving a half-written curriculum
    // cannot sweep the whole clinical team onto it.
    check("AND IT HAS NO ROLE TARGET, so nobody is swept onto it by accident",
      !prog.role_target, prog.role_target);
    const sweptBefore = (await pool.query(
      "SELECT COUNT(*)::int AS n FROM academy_enrollments WHERE program_id = $1", [prog.id])).rows[0].n;
    const sweep = await owner("/api/academy/sweep", { method: "POST" });
    check("the sweep really ran, rather than 404ing and proving nothing",
      sweep.status === 200, sweep);
    const sweptAfter = (await pool.query(
      "SELECT COUNT(*)::int AS n FROM academy_enrollments WHERE program_id = $1", [prog.id])).rows[0].n;
    check("and it enrolled nobody onto the new programme", sweptBefore === sweptAfter, { sweptBefore, sweptAfter });
    const sweepDenied = await plain("/api/academy/sweep", { method: "POST" });
    check("an ordinary BCBA cannot run the sweep", sweepDenied.status === 403, sweepDenied);

    const dup = await owner("/api/academy/programs", { method: "POST", body: {
      name: "Another", key: `acadcur-rbt-${stamp}` } });
    check("a duplicate key is refused", dup.status === 400, dup);
    const noname = await owner("/api/academy/programs", { method: "POST", body: {} });
    check("a programme with no name is refused", noname.status === 400, noname);

    section("BUILDING IT OUT");
    const w1 = await owner(`/api/academy/programs/${prog.id}/modules`, { method: "POST", body: {
      week: 1, title: "Week 1 — The basics", focus: "Shadowing" } });
    check("a week can be added", w1.status === 200, w1.data);
    const mod1 = w1.data.module;
    const bad = await owner(`/api/academy/programs/${prog.id}/modules`, { method: "POST", body: {
      week: 9, title: "Week 9" } });
    check("a week beyond the programme's length is refused", bad.status === 400, bad);
    check("and says what the range is", /between 1 and 2/.test((bad.data || {}).error || ""), bad.data);

    const i1 = await owner(`/api/academy/modules/${mod1.id}/items`, { method: "POST", body: {
      title: "Read the RBT handbook", kind: "reading" } });
    check("an item can be added", i1.status === 200, i1.data);
    const i2 = await owner(`/api/academy/modules/${mod1.id}/items`, { method: "POST", body: {
      title: "Run a session observed", kind: "competency" } });
    check("so can a competency", i2.status === 200, i2.data);
    const badKind = await owner(`/api/academy/modules/${mod1.id}/items`, { method: "POST", body: {
      title: "Something", kind: "vibes" } });
    check("an invented item kind is refused", badKind.status === 400, badKind);
    check("and the message lists the real ones",
      /reading, a checklist item, a competency, or a quiz/.test((badKind.data || {}).error || ""), badKind.data);

    // =====================================================================
    section("NOBODY IS ON IT, SO EDITING EDITS IT");
    const v0 = (await owner(`/api/academy/programs`)).data.programs.find((x) => Number(x.id) === Number(prog.id));
    check("the programme reports nobody enrolled", v0.enrolled === 0, v0);
    const e1 = await owner(`/api/academy/modules/${mod1.id}`, { method: "PATCH", body: {
      title: "Week 1 — Getting started" } });
    check("editing a week works", e1.status === 200, e1.data);
    check("AND DOES NOT FORK, because nobody would be affected",
      e1.data.forked !== true, e1.data);
    check("the change is on the same row", Number(e1.data.module.id) === Number(mod1.id), e1.data.module);
    const cur0 = await owner(`/api/academy/curriculum?program=${prog.key}`);
    check("the curriculum reads back the new title",
      /Getting started/.test(JSON.stringify(cur0.data.modules)), cur0.data.modules);

    // =====================================================================
    section("NOW SOMEBODY IS ON IT");
    const er = await owner("/api/academy/enrollments", { method: "POST", body: {
      employee_id: plainEmp, program_key: prog.key } });
    check("they are enrolled", er.status === 200, er.data);
    const enr = er.data.enrollment;
    check("at the programme's current version", Number(enr.program_version) === Number(prog.version), {
      enrolled_at: enr.program_version, program: prog.version });

    const before = await plain("/api/academy/me");
    const titlesBefore = (before.data.progress.items || []).map((i) => i.title).sort();
    check("they can see both items", titlesBefore.length === 2, titlesBefore);
    // Complete one, so there is a completion record to protect.
    const firstItem = (before.data.progress.items || []).find((i) => i.kind === "reading");
    const tick = await plain(`/api/academy/items/${firstItem.item_id}`, { method: "POST", body: { status: "completed" } });
    check("and complete the reading", tick.status === 200, tick.data);
    check("their progress says 1 of 2", tick.data.progress.completed === 1, tick.data.progress);

    // =====================================================================
    section("EDITING NOW FORKS, AND THEIR RECORD DOES NOT MOVE");
    const e2 = await owner(`/api/academy/modules/${mod1.id}`, { method: "PATCH", body: {
      title: "Week 1 — COMPLETELY REWRITTEN" } });
    check("the edit succeeds", e2.status === 200, e2.data);
    check("AND IT FORKED, because somebody is enrolled", e2.data.forked === true, e2.data);
    check("to a new version", Number(e2.data.version) === Number(prog.version) + 1, e2.data);
    check("ON A NEW ROW, leaving the old one alone",
      Number(e2.data.module.id) !== Number(mod1.id), { old: mod1.id, new: e2.data.module.id });
    check("AND IT CARRIED THE ITEMS ACROSS — a week that emptied itself is the bug here",
      e2.data.carried === 2, e2.data.carried);

    const after = await plain("/api/academy/me");
    check("THE ENROLLED PERSON STILL SEES THE OLD WEEK TITLE",
      /Getting started/.test(JSON.stringify(after.data.progress.weeks)),
      after.data.progress.weeks);
    check("and NOT the rewrite",
      !/COMPLETELY REWRITTEN/.test(JSON.stringify(after.data.progress)),
      JSON.stringify(after.data.progress).slice(0, 300));
    check("THEIR COMPLETION SURVIVED THE EDIT", after.data.progress.completed === 1, after.data.progress);
    check("and the item count did not change under them", after.data.progress.total === 2, after.data.progress);
    const titlesAfter = (after.data.progress.items || []).map((i) => i.title).sort();
    check("they are reading exactly the same items as before",
      JSON.stringify(titlesAfter) === JSON.stringify(titlesBefore), { titlesBefore, titlesAfter });

    section("WHILE A NEW STARTER GETS THE REWRITE");
    const ne = `acadcur-new-${stamp}@example.invalid`;
    const np = hp("AcadCur123!");
    await pool.query(
      `INSERT INTO users (name, email, password_hash, password_salt, role, created_at)
       VALUES ('AcadCur Newer',$1,$2,$3,'clinical', now())`, [ne, np.hash, np.salt]);
    const newEmp = (await pool.query(
      `INSERT INTO hr_employees (name, email, role_title, hr_hire_date, status)
       VALUES ('AcadCur Newer',$1,'BCBA',$2,'active') RETURNING id`,
      [ne, new Date().toISOString().slice(0, 10)])).rows[0].id;
    const er2 = await owner("/api/academy/enrollments", { method: "POST", body: {
      employee_id: newEmp, program_key: prog.key } });
    check("the next person is enrolled", er2.status === 200, er2.data);
    check("at the NEW version", Number(er2.data.enrollment.program_version) === Number(prog.version) + 1,
      er2.data.enrollment.program_version);
    const newer = session();
    await newer("/api/auth/login", { method: "POST", body: { email: ne, password: "AcadCur123!" } });
    const nm = await newer("/api/academy/me");
    check("AND THEY SEE THE REWRITTEN WEEK",
      /COMPLETELY REWRITTEN/.test(JSON.stringify(nm.data.progress.weeks)), nm.data.progress.weeks);
    check("with both items still there, not an empty week", nm.data.progress.total === 2, nm.data.progress);

    section("THE CURRICULUM PAGE AGREES WITH WHOEVER IS READING IT");
    const curOld = await plain(`/api/academy/curriculum?program=${prog.key}`);
    check("the enrolled person's curriculum page shows THEIR version",
      /Getting started/.test(JSON.stringify(curOld.data.modules)), curOld.data.modules);
    check("and reports which version that is",
      Number(curOld.data.version) === Number(enr.program_version), curOld.data.version);
    const curNew = await newer(`/api/academy/curriculum?program=${prog.key}`);
    check("the new starter's shows theirs",
      /COMPLETELY REWRITTEN/.test(JSON.stringify(curNew.data.modules)), curNew.data.modules);

    // =====================================================================
    section("AN OLD VERSION IS READ-ONLY");
    const stale = await owner(`/api/academy/modules/${mod1.id}`, { method: "PATCH", body: { title: "Again" } });
    check("the superseded week cannot be edited", stale.status === 400, stale);
    check("and says why", /older version/i.test((stale.data || {}).error || ""), stale.data);

    section("REMOVING AN ITEM FROM A PROGRAMME IN USE");
    const liveMod = e2.data.module;
    const liveItems = await owner(`/api/academy/curriculum?program=${prog.key}&version=${e2.data.version}`);
    const liveItem = liveItems.data.modules[0].items[0];
    const del = await owner(`/api/academy/items/${liveItem.id}`, { method: "DELETE" });
    check("an item can be retired", del.status === 200, del.data);
    check("which forks again", del.data.forked === true, del.data);
    const stillOld = await plain("/api/academy/me");
    check("THE ENROLLED PERSON STILL HAS BOTH ITEMS", stillOld.data.progress.total === 2, stillOld.data.progress);
    check("and still one completed", stillOld.data.progress.completed === 1, stillOld.data.progress);

    // =====================================================================
    section("MOVING SOMEBODY FORWARD, DELIBERATELY");
    const moveBad = await plain(`/api/academy/enrollments/${enr.id}/curriculum-version`, { method: "POST", body: {} });
    check("an employee cannot move their own curriculum version", moveBad.status === 403, moveBad);
    const move = await owner(`/api/academy/enrollments/${enr.id}/curriculum-version`, { method: "POST", body: {
      note: "Typo fix, agreed with her" } });
    check("leadership can move them to the current version", move.status === 200, move.data);
    const moved = await plain("/api/academy/me");
    check("and now they see the rewrite",
      /COMPLETELY REWRITTEN/.test(JSON.stringify(moved.data.progress.weeks)), moved.data.progress.weeks);
    const again = await owner(`/api/academy/enrollments/${enr.id}/curriculum-version`, { method: "POST", body: {} });
    check("moving them twice is refused", again.status === 400, again);
    const aud = (await pool.query(
      "SELECT * FROM academy_audit WHERE enrollment_id = $1 AND action = 'curriculum_version'", [enr.id])).rows;
    check("THE MOVE IS ON THE AUDIT TRAIL, with the note", aud.length === 1 && /Typo fix/.test(aud[0].note || ""), aud);

    section("A FINISHED ONBOARDING IS A RECORD, NOT A WORK ITEM");
    await pool.query("UPDATE academy_enrollments SET state = 'completed' WHERE id = $1", [er2.data.enrollment.id]);
    await pool.query("UPDATE academy_programs SET version = version + 1 WHERE id = $1", [prog.id]);
    const frozen = await owner(`/api/academy/enrollments/${er2.data.enrollment.id}/curriculum-version`,
      { method: "POST", body: {} });
    check("A COMPLETED ONBOARDING CANNOT BE MOVED TO A NEWER CURRICULUM", frozen.status === 400, frozen);
    check("because its version is part of what was signed off",
      /part of the record/i.test((frozen.data || {}).error || ""), frozen.data);

    await purge();
  } catch (e) {
    fail++;
    console.log("  FAIL  the suite threw  -> " + e.message + "\n" + (e.stack || "").split("\n").slice(1, 4).join("\n"));
    await purge().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})();
