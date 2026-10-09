// The Academy's people half: asking, saying you were never taught, and the
// fortnightly conversation.
//
// Three features, one idea. A new clinician two weeks into a job is the
// person least able to afford looking foolish, and most in need of asking.
// Everything here is built so that asking costs nothing:
//
//   * A QUESTION goes to the mentor and nobody else. Copying a director into
//     "how do I find the schedule" is how people stop asking.
//   * A TRAINING GAP goes to the mentor AND leadership, because the second
//     audience is the point: one person saying it is a gap in their
//     training; four people saying it about the same topic is a gap in the
//     programme. The trend is only shown to the people who can act on it.
//   * A CHECK-IN needs BOTH halves. One side's answers alone is a diary
//     entry or a manager's note, not a conversation.
//
// The refusals are the substance: you cannot answer your own question, you
// cannot write the other side's half of your own check-in, and you cannot
// close a gap without saying what was done.
//
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-academy-people.js
"use strict";
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const stamp = Date.now().toString(36);

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 300) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

function client() {
  let cookie = "";
  return async (p, { method = "GET", body } = {}) => {
    const r = await fetch(BASE + p, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  };
}
const crypto = require("crypto");
const hp = (pw) => {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") };
};

(async () => {
  const owner = client();
  const newbie = client();
  const mentor = client();
  const bystander = client();   // another BCBA, no relationship to this enrolment

  check("owner signs in", (await owner("/api/auth/login", {
    method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);

  const purge = async () => {
    const ids = "(SELECT id FROM hr_employees WHERE name LIKE 'Ppl %')";
    const enrs = `(SELECT id FROM academy_enrollments WHERE employee_id IN ${ids})`;
    for (const t of ["academy_questions", "academy_gaps", "academy_checkins", "academy_progress", "academy_audit"]) {
      await pool.query(`DELETE FROM ${t} WHERE enrollment_id IN ${enrs}`).catch(() => {});
    }
    await pool.query(`DELETE FROM academy_enrollments WHERE employee_id IN ${ids}`).catch(() => {});
    await pool.query("DELETE FROM hr_employees WHERE name LIKE 'Ppl %'").catch(() => {});
    await pool.query("DELETE FROM users WHERE email LIKE 'ppl-%'").catch(() => {});
  };
  await purge();

  const mkUser = async (email) => {
    const p = hp("PplPass123!");
    await pool.query(
      `INSERT INTO users (name, email, password_hash, password_salt, role, created_at)
       VALUES ($1,$1,$2,$3,'clinical', now()) ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash, password_salt = EXCLUDED.password_salt`,
      [email, p.hash, p.salt]);
  };
  const mkEmp = async (name, email, hire) => (await pool.query(
    `INSERT INTO hr_employees (name, email, role_title, hr_hire_date, status)
     VALUES ($1,$2,'BCBA',$3,'active') RETURNING id`, [name, email, hire])).rows[0].id;

  const nEmail = `ppl-new-${stamp}@example.invalid`;
  const mEmail = `ppl-mentor-${stamp}@example.invalid`;
  const bEmail = `ppl-other-${stamp}@example.invalid`;
  for (const e of [nEmail, mEmail, bEmail]) await mkUser(e);
  const today = new Date().toISOString().slice(0, 10);
  const nId = await mkEmp("Ppl Newbie", nEmail, today);
  const mId = await mkEmp("Ppl Mentor", mEmail, "2024-02-01");
  await mkEmp("Ppl Bystander", bEmail, "2023-06-01");

  for (const [c, e] of [[newbie, nEmail], [mentor, mEmail], [bystander, bEmail]]) {
    await c("/api/auth/login", { method: "POST", body: { email: e, password: "PplPass123!" } });
  }

  const enrolled = await owner("/api/academy/enrollments", { method: "POST", body: { employee_id: nId } });
  check("the new BCBA is enrolled", enrolled.status === 200, enrolled.data);
  const enrId = enrolled.data.enrollment.id;
  await owner(`/api/academy/enrollments/${enrId}`, { method: "PATCH", body: { mentor_id: mId } });

  // ==================================================================
  section("1. CHECK-INS ARE SCHEDULED BY ENROLLING, not by remembering");
  const sched = await newbie(`/api/academy/enrollments/${enrId}/checkins`);
  check("four check-ins exist from the moment they are enrolled",
    (sched.data.checkins || []).length === 4, (sched.data.checkins || []).length);
  check("on days 7, 14, 21 and 30",
    (sched.data.checkins || []).map((c) => c.day).join(",") === "7,14,21,30",
    (sched.data.checkins || []).map((c) => c.day));
  check("each with a real due date counted from their start",
    (sched.data.checkins || []).every((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.due_date)),
    (sched.data.checkins || [])[0]);

  // ==================================================================
  section("2. ASK MY MENTOR");
  const asked = await newbie("/api/academy/questions", {
    method: "POST", body: { subject: "Where do I find the clinic door code?", body: "Not in the handbook I was given." } });
  check("the new BCBA can ask", asked.status === 200, asked.data);
  check("and the mentor is the one notified", asked.data.mentor_notified === true, asked.data);
  const qid = asked.data.question.id;

  const selfAnswer = await newbie(`/api/academy/questions/${qid}`, { method: "POST", body: { answer: "Found it myself." } });
  check("ANSWERING YOUR OWN QUESTION IS NOT AN ANSWER", selfAnswer.status === 403, selfAnswer);

  const strangerAnswer = await bystander(`/api/academy/questions/${qid}`, { method: "POST", body: { answer: "It's 4471." } });
  check("a BCBA with no relationship to the enrolment cannot answer",
    strangerAnswer.status === 403, strangerAnswer);

  const empty = await mentor(`/api/academy/questions/${qid}`, { method: "POST", body: { answer: "   " } });
  check("an empty answer is refused", empty.status === 400, empty);

  const answered = await mentor(`/api/academy/questions/${qid}`, {
    method: "POST", body: { answer: "It is on the laminated card by the kettle, and in the SOP library." } });
  check("the mentor answers it", answered.status === 200, answered.data);
  const mine = await newbie("/api/academy/questions");
  const got = (mine.data.questions || []).find((q) => q.id === qid);
  check("and the answer reaches the person who asked", got && /laminated card/.test(got.answer || ""), got);
  check("with the answerer named", got && !!got.answered_by, got);

  // ==================================================================
  section("3. I WASN'T TRAINED ON THIS");
  const gap = await newbie("/api/academy/gaps", {
    method: "POST", body: {
      topic: "Authorization unit tracking", description: "Nobody showed me where to see remaining units.",
      urgency: "blocking", needs_help_now: true } });
  check("a training gap can be filed", gap.status === 200, gap.data);
  const gid = gap.data.gap.id;
  check("it starts as Submitted", gap.data.gap.status === "submitted", gap.data.gap);

  // Routing is the difference between this and a question: leadership too.
  const leadSees = await owner("/api/academy/gaps");
  check("CLINICAL LEADERSHIP SEES IT — a gap is about the programme, not just the person",
    (leadSees.data.gaps || []).some((g) => g.id === gid), (leadSees.data.gaps || []).length);
  const mentorSees = await mentor("/api/academy/gaps");
  check("so does the mentor", (mentorSees.data.gaps || []).some((g) => g.id === gid), (mentorSees.data.gaps || []).length);
  const strangerSees = await bystander("/api/academy/gaps");
  check("AN UNRELATED BCBA DOES NOT", !(strangerSees.data.gaps || []).some((g) => g.id === gid),
    (strangerSees.data.gaps || []).length);

  const closeNoReason = await mentor(`/api/academy/gaps/${gid}`, { method: "PATCH", body: { status: "resolved" } });
  check("CLOSING A GAP WITHOUT SAYING WHAT WAS DONE IS REFUSED", closeNoReason.status === 400, closeNoReason);

  const scheduled = await mentor(`/api/academy/gaps/${gid}`, { method: "PATCH", body: { status: "training_scheduled" } });
  check("it can move to Training Scheduled", scheduled.status === 200, scheduled.data);
  const resolved = await mentor(`/api/academy/gaps/${gid}`, {
    method: "PATCH", body: { status: "resolved", resolution: "Walked through the authorizations screen on 3 clients." } });
  check("and closed with what was done", resolved.status === 200, resolved.data);
  const closed = (await pool.query("SELECT * FROM academy_gaps WHERE id = $1", [gid])).rows[0];
  check("the record names who closed it", !!closed.resolved_by, closed);
  check("and keeps what they did", /Walked through/.test(closed.resolution || ""), closed);

  const strangerEdit = await bystander(`/api/academy/gaps/${gid}`, {
    method: "PATCH", body: { status: "under_review" } });
  check("an unrelated BCBA cannot work on somebody's gap", strangerEdit.status === 403, strangerEdit);

  section("3b. THE TREND IS FOR THE PEOPLE WHO CAN FIX THE PROGRAMME");
  check("leadership is given the recurring-topic trend", leadSees.data.trend !== null && leadSees.data.trend !== undefined,
    leadSees.data.trend);
  const mentorTrend = await mentor("/api/academy/gaps");
  check("a mentor is not — it is a programme view, not a mentee view",
    mentorTrend.data.trend === null, mentorTrend.data.trend);

  // ==================================================================
  section("4. A CHECK-IN NEEDS BOTH HALVES");
  const half = await newbie(`/api/academy/enrollments/${enrId}/checkins/7`, {
    method: "POST", body: { learned: "Rethink navigation and the schedule.", still_unclear: "Authorization units." } });
  check("the employee answers their own questions", half.status === 200, half.data);
  const afterEmp = (half.data.checkins || []).find((c) => c.day === 7);
  check("and it is NOT complete yet", afterEmp.state === "awaiting_supervisor", afterEmp.state);

  const empty2 = await newbie(`/api/academy/enrollments/${enrId}/checkins/14`, { method: "POST", body: {} });
  check("an entirely empty check-in is refused", empty2.status === 400, empty2);

  // The employee writing the supervisor's half would turn a conversation
  // into one person's account of it.
  const wroteFeedback = await newbie(`/api/academy/enrollments/${enrId}/checkins/7`, {
    method: "POST", body: { mentor_feedback: "Doing great, sign me off." } });
  const row7 = (await pool.query(
    "SELECT * FROM academy_checkins WHERE enrollment_id = $1 AND day = 7", [enrId])).rows[0];
  check("THE EMPLOYEE CANNOT WRITE THE SUPERVISOR'S HALF",
    !row7.mentor_feedback && !row7.supervisor_done_at, row7);

  const noFeedback = await mentor(`/api/academy/enrollments/${enrId}/checkins/7`, { method: "POST", body: {} });
  check("the supervisor must actually write something", noFeedback.status === 400, noFeedback);

  const signed = await mentor(`/api/academy/enrollments/${enrId}/checkins/7`, {
    method: "POST", body: { mentor_feedback: "Strong start. Units to cover next week." } });
  check("the mentor adds their half", signed.status === 200, signed.data);
  const done = (signed.data.checkins || []).find((c) => c.day === 7);
  check("AND ONLY NOW IS IT COMPLETE", done.state === "complete", done.state);
  check("with the supervisor named", !!done.supervisor_by, done);

  const strangerCheckin = await bystander(`/api/academy/enrollments/${enrId}/checkins/14`, {
    method: "POST", body: { mentor_feedback: "Fine by me." } });
  check("an unrelated BCBA cannot sign somebody's check-in", strangerCheckin.status === 403, strangerCheckin);

  // ==================================================================
  section("5. SOMEBODY WHO IS BOTH LEADERSHIP AND THE SUBJECT");
  //
  // The case the earlier assertions could not reach. An ordinary new BCBA is
  // refused these things for a plain reason -- they are not a mentor and not
  // leadership -- so the guards that exist specifically to stop SELF-review
  // were never exercised by them. A new Assistant Clinical Director going
  // through the same academy is both, and is the person those guards are
  // actually for.
  const bossEmail = `ppl-boss-${stamp}@example.invalid`;
  await mkUser(bossEmail);
  const bossId = await mkEmp("Ppl Boss", bossEmail, today);
  await owner(`/api/academy/leadership/${bossId}`, { method: "PUT", body: { leadership: "assistant_clinical_director" } });
  const boss = client();
  check("the Assistant Clinical Director signs in", (await boss("/api/auth/login", {
    method: "POST", body: { email: bossEmail, password: "PplPass123!" } })).status === 200);

  const bossEnrol = await owner("/api/academy/enrollments", { method: "POST", body: { employee_id: bossId } });
  check("and is enrolled in the academy themselves", bossEnrol.status === 200, bossEnrol.data);
  const bossEnrId = bossEnrol.data.enrollment.id;

  const bossAsked = await boss("/api/academy/questions", {
    method: "POST", body: { subject: "Which payer needs the FA-11F?" } });
  check("they can ask a question like anybody else", bossAsked.status === 200, bossAsked.data);
  const bossSelfAnswer = await boss(`/api/academy/questions/${bossAsked.data.question.id}`, {
    method: "POST", body: { answer: "Never mind, found it." } });
  check("BUT THEY CANNOT ANSWER THEIR OWN QUESTION, even holding the authority to answer anybody else's",
    bossSelfAnswer.status === 403, bossSelfAnswer);
  const stillOpen = (await pool.query(
    "SELECT status, answer FROM academy_questions WHERE id = $1", [bossAsked.data.question.id])).rows[0];
  check("and the thread is still open", stillOpen.status === "open" && !stillOpen.answer, stillOpen);

  const bossHalf = await boss(`/api/academy/enrollments/${bossEnrId}/checkins/7`, {
    method: "POST", body: { learned: "The payer matrix.", mentor_feedback: "All fine, signing myself off." } });
  check("they can complete their own employee half", bossHalf.status === 200, bossHalf.data);
  const bossRow = (await pool.query(
    "SELECT * FROM academy_checkins WHERE enrollment_id = $1 AND day = 7", [bossEnrId])).rows[0];
  check("THE SUBJECT'S HALF IS WRITTEN FIRST AND THE SUPERVISOR'S IS NOT TOUCHED",
    !!bossRow.employee_done_at && !bossRow.mentor_feedback && !bossRow.supervisor_done_at, bossRow);
  const bossState = (bossHalf.data.checkins || []).find((c) => c.day === 7);
  check("so their own check-in is NOT complete — it still waits on somebody else",
    bossState.state === "awaiting_supervisor", bossState && bossState.state);

  await pool.query("UPDATE hr_employees SET academy_leadership = NULL WHERE id = $1", [bossId]).catch(() => {});

  await purge();
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
