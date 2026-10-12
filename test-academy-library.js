// The training library, training hours, the reports, and the survey.
//
// FOUR CLAIMS, and the last one is the one that would do real damage if it
// were only half true:
//
//   * a document resource POINTS AT the policy library rather than copying
//     an SOP, so an amended SOP is not stale inside a training week
//   * training hours live where no billing, timecard or Rethink code reads
//     them -- the brief says separately, and separately is the requirement
//   * the reports count the things leadership acts on: overdue, review due,
//     competencies sent back, topics people keep saying they were never taught
//   * THE SURVEY IS ANONYMOUS BY STRUCTURE. There is no column to join on.
//     This file proves that by looking at the schema, not by trusting a flag,
//     and proves the two tables cannot be re-paired by timestamp.
//
//   DATABASE_URL=... BASE=http://127.0.0.1:3012 node test-academy-library.js
"use strict";
const { Pool } = require("pg");
const crypto = require("crypto");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const BASE = process.env.BASE || "http://localhost:3012";
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
    const ct = r.headers.get("content-type") || "";
    let d = null;
    if (ct.includes("json")) { try { d = await r.json(); } catch (e) {} }
    else { try { d = await r.text(); } catch (e) {} }
    return { status: r.status, data: d, headers: r.headers };
  };
}
const today = () => new Date().toISOString().slice(0, 10);

(async () => {
  const purge = async () => {
    const ids = "(SELECT id FROM hr_employees WHERE name LIKE 'AcadLib %')";
    const enr = `(SELECT id FROM academy_enrollments WHERE employee_id IN ${ids})`;
    await pool.query(`DELETE FROM academy_hours WHERE enrollment_id IN ${enr}`).catch(() => {});
    await pool.query(`DELETE FROM academy_survey_done WHERE enrollment_id IN ${enr}`).catch(() => {});
    for (const t of ["academy_dev_plans", "academy_progress", "academy_audit", "academy_checkins",
                     "academy_questions", "academy_gaps"]) {
      await pool.query(`DELETE FROM ${t} WHERE enrollment_id IN ${enr}`).catch(() => {});
    }
    await pool.query(`DELETE FROM academy_review_ratings WHERE review_id IN (SELECT id FROM academy_reviews WHERE enrollment_id IN ${enr})`).catch(() => {});
    await pool.query(`DELETE FROM academy_reviews WHERE enrollment_id IN ${enr}`).catch(() => {});
    await pool.query(`DELETE FROM academy_enrollments WHERE employee_id IN ${ids}`).catch(() => {});
    await pool.query("DELETE FROM hr_employees WHERE name LIKE 'AcadLib %'").catch(() => {});
    await pool.query("DELETE FROM users WHERE email LIKE 'acadlib-%'").catch(() => {});
    const progs = "(SELECT id FROM academy_programs WHERE key LIKE 'acadlib-%')";
    await pool.query(`DELETE FROM academy_survey_responses WHERE program_id IN ${progs}`).catch(() => {});
    await pool.query(`DELETE FROM academy_resources WHERE module_id IN (SELECT id FROM academy_modules WHERE program_id IN ${progs})`).catch(() => {});
    await pool.query(`DELETE FROM academy_resources WHERE item_id IN (SELECT i.id FROM academy_items i JOIN academy_modules m ON m.id = i.module_id WHERE m.program_id IN ${progs})`).catch(() => {});
    await pool.query(`DELETE FROM academy_items WHERE module_id IN (SELECT id FROM academy_modules WHERE program_id IN ${progs})`).catch(() => {});
    await pool.query(`DELETE FROM academy_modules WHERE program_id IN ${progs}`).catch(() => {});
    await pool.query(`DELETE FROM academy_enrollments WHERE program_id IN ${progs}`).catch(() => {});
    await pool.query(`DELETE FROM academy_programs WHERE key LIKE 'acadlib-%'`).catch(() => {});
    await pool.query("DELETE FROM crm_policies WHERE title LIKE 'AcadLib %'").catch(() => {});
  };

  try {
    await purge();
    const owner = session();
    const ol = await owner("/api/auth/login", {
      method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
    if (ol.status !== 200) throw new Error("owner login failed " + ol.status);

    // a programme of our own, so the BCBA one is untouched
    const mk = await owner("/api/academy/programs", { method: "POST", body: {
      name: `AcadLib Programme ${stamp}`, key: `acadlib-${stamp}`, weeks: 1, duration_days: 7,
      weekly_hours_target: 5 } });
    const prog = mk.data.program;
    const w1 = await owner(`/api/academy/programs/${prog.id}/modules`, { method: "POST", body: {
      week: 1, title: "Week 1" } });
    const mod = w1.data.module;
    const it1 = (await owner(`/api/academy/modules/${mod.id}/items`, { method: "POST", body: {
      title: "Read the attendance policy", kind: "reading" } })).data.item;
    const it2 = (await owner(`/api/academy/modules/${mod.id}/items`, { method: "POST", body: {
      title: "Run a session observed", kind: "competency" } })).data.item;

    const people = [];
    for (const label of ["one", "two", "three"]) {
      const email = `acadlib-${label}-${stamp}@example.invalid`;
      const p = hp("AcadLib123!");
      await pool.query(
        `INSERT INTO users (name, email, password_hash, password_salt, role, created_at)
         VALUES ($1,$2,$3,$4,'clinical', now())`, [`AcadLib ${label}`, email, p.hash, p.salt]);
      const id = (await pool.query(
        `INSERT INTO hr_employees (name, email, role_title, hr_hire_date, status)
         VALUES ($1,$2,'BCBA',$3,'active') RETURNING id`,
        [`AcadLib ${label}`, email, today()])).rows[0].id;
      const s = session();
      await s("/api/auth/login", { method: "POST", body: { email, password: "AcadLib123!" } });
      const er = await owner("/api/academy/enrollments", { method: "POST", body: {
        employee_id: id, program_key: prog.key } });
      people.push({ label, email, id, s, enr: er.data.enrollment });
    }
    check("three people are enrolled", people.every((x) => x.enr && x.enr.id), people.map((x) => !!x.enr));
    const me1 = people[0];

    // =====================================================================
    section("A DOCUMENT POINTS AT THE POLICY LIBRARY, IT DOES NOT COPY IT");
    const pol = (await pool.query(
      `INSERT INTO crm_policies (title, category, body, slug, published, created_at)
       VALUES ('AcadLib Attendance Policy','HR','Be on time.',$1,TRUE, now()::text) RETURNING id, slug`,
      [`acadlib-att-${stamp}`])).rows[0];
    const noPol = await owner("/api/academy/resources", { method: "POST", body: {
      item_id: it1.id, kind: "document", title: "Attendance" } });
    check("a document with no policy chosen is refused", noPol.status === 400, noPol);
    check("and points at the library", /from the library/i.test((noPol.data || {}).error || ""), noPol.data);
    const ghost = await owner("/api/academy/resources", { method: "POST", body: {
      item_id: it1.id, kind: "document", policy_id: 99999999 } });
    check("a policy that is not in the library is refused", ghost.status === 404, ghost);
    const doc = await owner("/api/academy/resources", { method: "POST", body: {
      item_id: it1.id, kind: "document", policy_id: pol.id } });
    check("a real policy attaches", doc.status === 200, doc.data);
    check("AND NO COPY OF ITS TEXT WAS STORED IN THE ACADEMY",
      !doc.data.resource.body, doc.data.resource.body);

    const seen1 = await me1.s("/api/academy/me");
    const readItem = (seen1.data.progress.items || []).find((i) => i.kind === "reading");
    check("the employee sees the attached document on the item",
      (readItem.resources || []).length === 1, readItem.resources);
    check("with the policy's own title", /Attendance Policy/.test(readItem.resources[0].title),
      readItem.resources[0]);
    check("and a link into the policy library", /^\/policies#/.test(readItem.resources[0].href),
      readItem.resources[0].href);

    // RENAME THE SOP. The training week must follow it, which is the whole
    // reason a document is a pointer.
    await pool.query("UPDATE crm_policies SET title = 'AcadLib Attendance Policy (2026 revision)' WHERE id = $1", [pol.id]);
    const seen2 = await me1.s("/api/academy/me");
    const readItem2 = (seen2.data.progress.items || []).find((i) => i.kind === "reading");
    check("RENAMING THE SOP UPDATES THE TRAINING WEEK, because nothing was copied",
      /2026 revision/.test(readItem2.resources[0].title), readItem2.resources[0].title);

    section("A VIDEO IS A LINK, AND A LINK HAS TO BE A WEB ADDRESS");
    const js = await owner("/api/academy/resources", { method: "POST", body: {
      module_id: mod.id, kind: "video", title: "Intro", url: "javascript:alert(document.cookie)" } });
    check("A JAVASCRIPT URL IS REFUSED — it would run on the reader's session",
      js.status === 400, js);
    check("and says what is acceptable", /http:\/\/ or https:\/\//.test((js.data || {}).error || ""), js.data);
    const vid = await owner("/api/academy/resources", { method: "POST", body: {
      module_id: mod.id, kind: "video", title: "Intro to our systems",
      url: "https://www.loom.com/share/abc123" } });
    check("an embedded video link attaches to the week", vid.status === 200, vid.data);
    const both = await owner("/api/academy/resources", { method: "POST", body: {
      module_id: mod.id, item_id: it1.id, kind: "link", title: "x", url: "https://example.com" } });
    check("attaching to a week AND an item at once is refused", both.status === 400, both);
    const neither = await owner("/api/academy/resources", { method: "POST", body: {
      kind: "link", title: "x", url: "https://example.com" } });
    check("attaching to nothing is refused", neither.status === 400, neither);
    const badKind = await owner("/api/academy/resources", { method: "POST", body: {
      module_id: mod.id, kind: "hologram", title: "x" } });
    check("an invented resource kind is refused", badKind.status === 400, badKind);

    const seen3 = await me1.s("/api/academy/me");
    check("the week carries the video",
      ((seen3.data.progress.weeks[0] || {}).resources || []).some((r) => r.kind === "video"),
      (seen3.data.progress.weeks[0] || {}).resources);

    section("ONLY LEADERSHIP CURATES IT");
    const f = await me1.s("/api/academy/resources", { method: "POST", body: {
      module_id: mod.id, kind: "link", title: "mine", url: "https://example.com" } });
    check("an employee cannot add training material", f.status === 403, f);
    const fd = await me1.s(`/api/academy/resources/${vid.data.resource.id}`, { method: "DELETE" });
    check("nor remove it", fd.status === 403, fd);

    section("ATTACHMENTS SURVIVE A CURRICULUM FORK");
    const forked = await owner(`/api/academy/modules/${mod.id}`, { method: "PATCH", body: {
      title: "Week 1 — revised" } });
    check("the edit forked", forked.data.forked === true, forked.data);
    check("AND CARRIED THE WEEK'S VIDEO ACROSS — a forked week that loses its"
      + " material looks complete and teaches nothing",
      forked.data.resources_carried >= 1, forked.data);
    const newMod = forked.data.module;
    const curNew = await owner(`/api/academy/curriculum?program=${prog.key}&version=${forked.data.version}`);
    const newItems = curNew.data.modules[0].items;
    check("and the items came too", newItems.length === 2, newItems.length);
    const freshRead = newItems.find((i) => i.kind === "reading");
    const resNew = (await pool.query(
      "SELECT * FROM academy_resources WHERE item_id = $1", [freshRead.id])).rows;
    check("INCLUDING THE DOCUMENT ATTACHED TO AN ITEM", resNew.length === 1, resNew);
    check("still as a pointer, not a copy", resNew[0] && Number(resNew[0].policy_id) === Number(pol.id), resNew[0]);

    // =====================================================================
    section("TRAINING HOURS, AND WHERE THEY ARE NOT");
    const H = `/api/academy/enrollments/${me1.enr.id}/hours`;
    const h1 = await me1.s(H, { method: "POST", body: {
      on_date: today(), hours: 2.5, activity: "Shadowed two sessions" } });
    check("somebody can log their own training time", h1.status === 200, h1.data);
    const hNoDate = await me1.s(H, { method: "POST", body: { hours: 1, activity: "x" } });
    check("with no date it is refused", hNoDate.status === 400, hNoDate);
    const hFuture = await me1.s(H, { method: "POST", body: {
      on_date: "2099-01-01", hours: 1, activity: "x" } });
    check("a day that has not happened is refused", hFuture.status === 400, hFuture);
    const hNoAct = await me1.s(H, { method: "POST", body: { on_date: today(), hours: 1 } });
    check("with no activity it is refused", hNoAct.status === 400, hNoAct);
    const hZero = await me1.s(H, { method: "POST", body: { on_date: today(), hours: 0, activity: "x" } });
    check("zero hours is refused", hZero.status === 400, hZero);
    const hHuge = await me1.s(H, { method: "POST", body: { on_date: today(), hours: 80, activity: "x" } });
    check("EIGHTY HOURS IN A DAY IS REFUSED — a fat finger in a report somebody"
      + " later has to explain", hHuge.status === 400, hHuge);
    const hOther = await people[1].s(H);
    check("another BCBA cannot read somebody's training log", hOther.status === 403, hOther);

    const hGet = await me1.s(H);
    check("the log reads back", hGet.data.total === 2.5, hGet.data);
    check("AND SAYS OUT LOUD THAT THESE ARE NOT BILLABLE",
      /not billable/i.test(hGet.data.note || ""), hGet.data.note);

    // THE STRUCTURAL CLAIM: no billing, timecard or Rethink code reads this
    // table. Checked against the source, because "separately" is the whole
    // requirement and a comment promising it is worth nothing.
    const fs = require("fs");
    const files = fs.readdirSync(".").filter((f) => f.endsWith(".js")
      && !f.startsWith("test-") && f !== "academy.js" && f !== "run-tests.js");
    const leaks = files.filter((f) => fs.readFileSync(f, "utf8").includes("academy_hours"));
    check("NO OTHER MODULE IN THE CRM READS academy_hours — not billing, not"
      + " the timecard, not the Rethink sync", leaks.length === 0, leaks);

    // =====================================================================
    section("THE REPORTS LEADERSHIP ACTS ON");
    const rDenied = await me1.s(`/api/academy/reports?program=${prog.key}`);
    check("an employee cannot read the reports", rDenied.status === 403, rDenied);

    // make one overdue, one completed, one competency sent back
    await pool.query("UPDATE academy_enrollments SET due_date = '2020-01-01' WHERE id = $1", [me1.enr.id]);
    await pool.query(
      "UPDATE academy_enrollments SET state = 'completed', completed_at = $1 WHERE id = $2",
      [today(), people[1].enr.id]);
    await pool.query(
      `INSERT INTO academy_progress (enrollment_id, item_id, status, updated_at)
       VALUES ($1,$2,'needs_training', now()::text)
       ON CONFLICT (enrollment_id, item_id) DO UPDATE SET status = 'needs_training'`,
      [people[2].enr.id, it2.id]);
    await people[2].s("/api/academy/gaps", { method: "POST", body: {
      topic: "Authorization units", description: "Nobody showed me." } });
    await people[0].s("/api/academy/gaps", { method: "POST", body: {
      topic: "authorization units", description: "Same here." } });

    const rep = await owner(`/api/academy/reports?program=${prog.key}`);
    check("the report comes back", rep.status === 200, rep.data);
    check("it counts everybody", rep.data.counts.total === 3, rep.data.counts);
    check("AND FLAGS THE OVERDUE ONE, which is the figure this exists for",
      rep.data.counts.overdue === 1, rep.data.counts);
    check("it counts the completion", rep.data.counts.completed === 1, rep.data.counts);
    check("and reports a median days-to-complete over finished ones only",
      rep.data.completed_counted === 1 && rep.data.median_days_to_complete !== null, {
        n: rep.data.completed_counted, median: rep.data.median_days_to_complete });
    check("competencies sent back are counted",
      rep.data.competencies.sent_back === 1, rep.data.competencies);
    check("RECURRING GAPS ARE GROUPED BY TOPIC REGARDLESS OF CAPITALISATION —"
      + " two people saying it is a programme problem, not a person problem",
      (rep.data.recurring_gaps || []).some((g) => /authorization units/i.test(g.topic) && g.n === 2),
      rep.data.recurring_gaps);
    check("training hours are in the report", rep.data.training_hours.total === 2.5, rep.data.training_hours);
    check("AND LABELLED AS NOT BILLABLE there too",
      /not billable/i.test(rep.data.training_hours.note || ""), rep.data.training_hours.note);
    check("each person carries the curriculum version they are on",
      (rep.data.people || []).every((p) => Number(p.curriculum_version) >= 1), rep.data.people);

    section("THE CSV EXPORT");
    const csvDenied = await me1.s(`/api/academy/reports.csv?program=${prog.key}`);
    check("an employee cannot export it", csvDenied.status === 403, csvDenied);
    const csv = await owner(`/api/academy/reports.csv?program=${prog.key}`);
    check("leadership can", csv.status === 200, csv.status);
    check("it is served as a csv attachment",
      /text\/csv/.test(csv.headers.get("content-type") || "")
        && /attachment/.test(csv.headers.get("content-disposition") || ""),
      { ct: csv.headers.get("content-type"), cd: csv.headers.get("content-disposition") });
    const rows = String(csv.data).trim().split("\r\n");
    check("with a header and a row per person", rows.length === 4, rows.length);
    check("and the training hours column", /2\.5/.test(String(csv.data)), rows[1]);

    // A name containing a comma must not shift every later column.
    await pool.query("UPDATE hr_employees SET name = 'AcadLib one, PhD' WHERE id = $1", [me1.id]);
    const csv2 = await owner(`/api/academy/reports.csv?program=${prog.key}`);
    const r2 = String(csv2.data).trim().split("\r\n");
    check("A NAME WITH A COMMA IS QUOTED, not allowed to shift the columns",
      r2.some((l) => l.includes('"AcadLib one, PhD"')), r2);
    check("so every row still has the same number of columns",
      new Set(r2.map((l) => (l.match(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/g) || []).length)).size === 1,
      r2.map((l) => (l.match(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/g) || []).length));
    await pool.query("UPDATE hr_employees SET name = 'AcadLib one' WHERE id = $1", [me1.id]);

    // =====================================================================
    section("THE SURVEY IS ANONYMOUS BY STRUCTURE");
    // Not by a flag, not by intention: by there being no column to join on.
    const cols = (await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'academy_survey_responses'`
    )).rows.map((r) => r.column_name);
    check("THE RESPONSE TABLE HAS NO EMPLOYEE COLUMN",
      !cols.some((c) => /employee/i.test(c)), cols);
    check("NO ENROLMENT COLUMN", !cols.some((c) => /enrollment|enrolment/i.test(c)), cols);
    check("NO NAME, EMAIL OR USER COLUMN",
      !cols.some((c) => /(^|_)(name|email|user|user_id|created_by|logged_by)($|_)/i.test(c)), cols);

    const info = await me1.s("/api/academy/survey");
    check("the form explains what is and is not stored", info.status === 200, info.status);
    check("it says the link is ABSENT rather than hidden",
      /not hidden, absent/i.test(info.data.promise || ""), info.data.promise);
    check("AND WARNS THAT FREE TEXT CAN STILL IDENTIFY THEM — the one thing"
      + " the CRM cannot take back",
      /own words could still identify you/i.test(info.data.promise || ""), info.data.promise);
    check("they can submit", info.data.can_submit === true, info.data);

    const bad = await me1.s("/api/academy/survey", { method: "POST", body: { prepared: 9 } });
    check("an out-of-range rating is refused", bad.status === 400, bad);
    const partial = await me1.s("/api/academy/survey", { method: "POST", body: { prepared: 4 } });
    check("a partly answered survey is refused", partial.status === 400, partial);

    const s1 = await me1.s("/api/academy/survey", { method: "POST", body: {
      prepared: 4, mentor_time: 3, set_up_to_do_job: 4,
      missing: "Nobody showed me the authorization screen.", change_what: "More shadowing." } });
    check("a complete one is accepted", s1.status === 200, s1.data);
    const again = await me1.s("/api/academy/survey", { method: "POST", body: {
      prepared: 1, mentor_time: 1, set_up_to_do_job: 1 } });
    check("submitting twice is refused", again.status === 400, again);
    const info2 = await me1.s("/api/academy/survey");
    check("and the form says so", info2.data.already === true && info2.data.can_submit === false, info2.data);

    section("AND THE TWO TABLES CANNOT BE RE-PAIRED BY TIME");
    const doneRow = (await pool.query(
      "SELECT * FROM academy_survey_done WHERE enrollment_id = $1", [me1.enr.id])).rows[0];
    const respRow = (await pool.query(
      "SELECT * FROM academy_survey_responses WHERE program_id = $1 ORDER BY id DESC LIMIT 1", [prog.id])).rows[0];
    check("the marker exists", !!doneRow, doneRow);
    check("the response exists", !!respRow, respRow);
    check("THE RESPONSE IS DATED TO THE DAY, NOT THE SECOND — matching"
      + " timestamps would hand back the identity the rest of this prevents",
      /^\d{4}-\d{2}-\d{2}$/.test(String(respRow.submitted_at)), respRow.submitted_at);
    check("while the marker keeps a full timestamp for the response rate",
      String(doneRow.submitted_at).length > 10, doneRow.submitted_at);

    section("NOBODY READS A SINGLE RESPONSE");
    const r1 = await owner(`/api/academy/survey/results?program=${prog.key}`);
    check("with one response in, the results are withheld", r1.data.withheld === true, r1.data);
    check("the count is shown, because a count is not a name", r1.data.responses === 1, r1.data);
    check("NO ANSWERS AND NO COMMENTS ARE RETURNED",
      !r1.data.comments && !r1.data.averages, r1.data);
    check("and it says what is needed to open it", /3 people have answered/i.test(r1.data.reason || ""), r1.data.reason);
    const rDen = await me1.s(`/api/academy/survey/results?program=${prog.key}`);
    check("an employee cannot read the results at all", rDen.status === 403, rDen);

    await people[1].s("/api/academy/survey", { method: "POST", body: {
      prepared: 5, mentor_time: 5, set_up_to_do_job: 5, missing: "Nothing." } });
    const r2b = await owner(`/api/academy/survey/results?program=${prog.key}`);
    check("two is still not enough", r2b.data.withheld === true, r2b.data);
    await people[2].s("/api/academy/survey", { method: "POST", body: {
      prepared: 3, mentor_time: 2, set_up_to_do_job: 3, change_what: "Give us a cheat sheet." } });
    const r3 = await owner(`/api/academy/survey/results?program=${prog.key}`);
    check("AT THREE, IT OPENS", r3.data.withheld === false, r3.data);
    check("with averages", r3.data.averages.prepared === 4, r3.data.averages);
    check("and the comments", (r3.data.comments || []).length === 4, r3.data.comments);
    check("the comments carry no author", (r3.data.comments || []).every(
      (c) => !Object.keys(c).some((k) => /name|email|employee|id/i.test(k))), r3.data.comments);

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
