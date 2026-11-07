// THE VIDEO AND THE QUIZ: a course delivered in the CRM is completed by
// passing its quiz, graded on the server.
//
// 1. THE ANSWER KEY NEVER LEAVES THE SERVER. The lesson payload carries the
//    questions and choices and nothing that marks the right one.
// 2. A FAIL RECORDS AN ATTEMPT AND NOTHING ELSE, and does not hand over the
//    answers -- otherwise the retake is a copy.
// 3. A PASS IS A VERIFIED COMPLETION, recorded once, in the same table every
//    other completion lives in, so the dashboards need no second source.
// 4. THE OWNER CAN PREVIEW a course nobody has been assigned, and her preview
//    never lands on anybody's record.
// 5. THE VIDEO IS BEHIND SIGN-IN and answers Range requests (Safari needs it).
//
//   DATABASE_URL=... node run-tests.js test-compliance-lessons.js
"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const q = (sql, p) => pool.query(sql, p || []);

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else {
    fail++; failures.push(name);
    console.log("  FAIL  " + name + (detail !== undefined
      ? "  -> " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 300) : ""));
  }
};
const section = (t) => console.log("\n== " + t + " ==");

function client() {
  let jar = "";
  return async (p, opts = {}) => {
    const r = await fetch(BASE + p, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", ...(jar ? { Cookie: jar } : {}), ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      redirect: "manual",
    });
    const setC = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (setC && setC.length) jar = setC.map((c) => c.split(";")[0]).join("; ");
    let data = null;
    if (opts.raw) { data = Buffer.from(await r.arrayBuffer()); }
    else { try { data = await r.json(); } catch (e) {} }
    return { status: r.status, data, headers: r.headers };
  };
}
const login = async (email, password) => {
  const c = client();
  const r = await c("/api/auth/login", { method: "POST", body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status}`);
  return c;
};
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => iso(new Date(Date.now() - n * 86400000));
const stamp = Math.random().toString(36).slice(2, 8);

(async () => {
  const owner = await login("admin@spectrumsquadlv.com", "TestOwner123!");
  const content = JSON.parse(fs.readFileSync(path.join(__dirname, "compliance-content", "hipaa.json"), "utf8"));
  const KEY = content.quiz.map((x) => x.answer);
  const WRONG = KEY.map((a) => (a + 1) % 4);

  const lib = (await owner("/api/compliance/courses")).data;
  const hipaa = (lib.courses || []).find((c) => c.key === "hipaa");
  check("the seeded HIPAA course is in the library", !!hipaa);
  check("...and the library says it has a lesson", hipaa && hipaa.has_lesson === true);

  section("THE OWNER CAN PREVIEW A COURSE NOBODY IS ASSIGNED");
  const pv = await owner(`/api/compliance/my-training/${hipaa.id}/lesson`);
  check("the lesson opens for the owner", pv.status === 200, pv.status);
  check("...marked as a preview", pv.data && pv.data.preview === true);
  const pvq = await owner(`/api/compliance/my-training/${hipaa.id}/quiz`, { method: "POST", body: { answers: KEY } });
  check("her quiz is graded", pvq.status === 200 && pvq.data.passed === true, [pvq.status, pvq.data]);
  const pvRows = await q("SELECT COUNT(*)::int n FROM compliance_completions WHERE course_id = $1", [hipaa.id]);
  check("...and NOTHING is recorded", pvRows.rows[0].n === 0, pvRows.rows[0].n);

  section("An employee assigned the course");
  await owner(`/api/compliance/courses/${hipaa.id}/rules`, { method: "PUT",
    body: { rules: [{ scope: "all", due_days: 30, effective_from: daysAgo(5) }] } });
  const PW = "LessonPw123!";
  const email = `zz.lesson.${stamp}@example.test`;
  const made = await owner("/api/admin/users", { method: "POST",
    body: { name: `Zz Lesson ${stamp}`, email, password: PW, role: "employee" } });
  const empId = (await q(
    `INSERT INTO hr_employees (user_id, name, email, role_title, hire_date, status, created_at)
     VALUES ($1,$2,$3,'Registered Behavior Technician',$4,'active',$5) RETURNING id`,
    [made.data.id, `Zz Lesson ${stamp}`, email, daysAgo(30), new Date().toISOString()])).rows[0].id;
  const emp = await login(email, PW);

  const mine = (await emp("/api/compliance/my-training")).data;
  const row = (mine.required || []).find((r) => r.course_id === hipaa.id);
  check("the course is on their training with a lesson", row && row.has_lesson === true, row);
  check("...and no 'I have completed this' shortcut beside it", row && row.can_self_report === false);

  const les = await emp(`/api/compliance/my-training/${hipaa.id}/lesson`);
  check("the lesson opens", les.status === 200, les.status);
  check("it is not a preview for them", les.data.preview === false);
  check("it carries every question", les.data.quiz.length === content.quiz.length);
  check("THE ANSWER KEY IS NOT IN THE PAYLOAD",
    !/"answer"|"explanation"/.test(JSON.stringify(les.data.quiz)), les.data.quiz[0]);
  check("the transcript is there", les.data.transcript.length === content.slides.length);

  section("A FAIL RECORDS AN ATTEMPT AND NOTHING ELSE");
  const short = await emp(`/api/compliance/my-training/${hipaa.id}/quiz`, { method: "POST", body: { answers: [0] } });
  check("an incomplete answer sheet is refused", short.status === 400, short.status);
  const bad = await emp(`/api/compliance/my-training/${hipaa.id}/quiz`, { method: "POST", body: { answers: WRONG } });
  check("all wrong is a fail", bad.status === 200 && bad.data.passed === false && bad.data.score === 0, bad.data);
  check("...and the answers are NOT handed over on a fail",
    bad.data.results.every((r) => r.answer === undefined && r.explanation === undefined), bad.data.results[0]);
  let comps = await q("SELECT * FROM compliance_completions WHERE employee_id = $1", [empId]);
  check("no completion after a fail", comps.rows.length === 0, comps.rows.length);

  // Exactly at the pass mark: 8 of 10 right is 80%, which passes.
  const eight = KEY.map((a, i) => (i < 2 ? (a + 1) % 4 : a));
  const ok = await emp(`/api/compliance/my-training/${hipaa.id}/quiz`, { method: "POST", body: { answers: eight } });
  check("eight of ten passes at an 80% mark", ok.data.passed === true && ok.data.score === 80, ok.data);
  check("...and the explanations come with a pass", ok.data.results.every((r) => typeof r.explanation === "string"));

  section("A PASS IS ONE VERIFIED COMPLETION");
  comps = await q("SELECT * FROM compliance_completions WHERE employee_id = $1", [empId]);
  check("one completion is recorded", comps.rows.length === 1, comps.rows.length);
  const c0 = comps.rows[0] || {};
  check("it came from the quiz", c0.source === "quiz", c0.source);
  check("it is verified, by the grading", !!c0.verified_at && /Passed the quiz \(80%\)/.test(c0.verified_by || ""), c0.verified_by);
  await emp(`/api/compliance/my-training/${hipaa.id}/quiz`, { method: "POST", body: { answers: KEY } });
  comps = await q("SELECT * FROM compliance_completions WHERE employee_id = $1", [empId]);
  check("passing again the same day does not double it", comps.rows.length === 1, comps.rows.length);
  const tries = await q("SELECT COUNT(*)::int n FROM compliance_quiz_attempts WHERE employee_id = $1", [empId]);
  check("every attempt is kept, pass or fail", tries.rows[0].n === 3, tries.rows[0].n);
  const after = (await emp("/api/compliance/my-training")).data;
  const rowAfter = (after.required || []).find((r) => r.course_id === hipaa.id);
  check("their training now shows it complete", rowAfter && rowAfter.state === "complete", rowAfter && rowAfter.state);

  section("Somebody it is not assigned to");
  await owner(`/api/compliance/courses/${hipaa.id}/rules`, { method: "PUT", body: { rules: [] } });
  const notMine = await emp(`/api/compliance/my-training/${hipaa.id}/lesson`);
  check("an employee cannot open a course not assigned to them", notMine.status === 403, notMine.status);

  section("THE VIDEO");
  const anon = client();
  const v0 = await anon("/api/compliance/video/hipaa.mp4", { raw: true });
  check("it is refused without sign-in", v0.status === 401, v0.status);
  const trav = await emp("/api/compliance/video/..%2Fpackage.mp4", { raw: true });
  check("a path that is not a course key is refused", trav.status === 404 || trav.status === 401, trav.status);
  if (fs.existsSync(path.join(__dirname, "compliance-videos", "hipaa.mp4"))) {
    const v1 = await emp("/api/compliance/video/hipaa.mp4", { raw: true, headers: { Range: "bytes=0-99" } });
    check("a Range request gets 206 and exactly those bytes", v1.status === 206 && v1.data.length === 100, [v1.status, v1.data && v1.data.length]);
    check("...served as video/mp4", /video\/mp4/.test(v1.headers.get("content-type") || ""));
  } else {
    console.log("  (no hipaa.mp4 built in this checkout; Range checks skipped)");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log("Failures:\n  - " + failures.join("\n  - "));
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await pool.end(); } catch (x) {} process.exit(1); });
