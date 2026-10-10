// The 30-day review, its approval gate, and development plans.
//
// This file exists for one claim: THE CRM WILL NOT SIGN SOMEBODY OFF ON
// ARITHMETIC. The brief is explicit -- no approving on elapsed time, no
// approving on a full checklist, a named human approves -- and every one of
// those is a thing that is easy to build by accident, because the data is
// right there and it looks like evidence.
//
// So the tests here are mostly about refusal:
//
//   * thirty days passing approves nothing
//   * a 100% complete checklist approves nothing
//   * an unrated domain is an unasked question, not a pass
//   * "needs support" with no dated plan cannot be signed off
//   * a mentor rates; only clinical leadership approves
//   * nobody rates or approves their own review, designation or not
//   * an employee cannot read their own ratings while they are still a draft
//
//   DATABASE_URL=... BASE=http://127.0.0.1:3010 node test-academy-review.js
"use strict";
const { Pool } = require("pg");
const crypto = require("crypto");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const BASE = process.env.BASE || "http://localhost:3010";
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

// A session per person, so "who is asking" is never ambiguous.
function session() {
  let cookie = "";
  return async function (path, opts = {}) {
    const r = await fetch(BASE + path, {
      method: opts.method || "GET",
      headers: {
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      redirect: "manual",
    });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  };
}

const DOMAINS = ["systems", "documentation", "authorizations", "compliance", "supervision",
                 "caseload", "communication", "professionalism", "leadership", "policy"];

(async () => {
  const mk = async (label, role, leadership) => {
    const email = `acadrv-${label}-${stamp}@example.invalid`;
    const p = hp("AcadRv123!");
    await pool.query(
      `INSERT INTO users (name, email, password_hash, password_salt, role, created_at)
       VALUES ($1,$2,$3,$4,$5, now())`, [`AcadRv ${label}`, email, p.hash, p.salt, role]);
    const id = (await pool.query(
      `INSERT INTO hr_employees (name, email, role_title, hr_hire_date, status, academy_leadership)
       VALUES ($1,$2,'BCBA',$3,'active',$4) RETURNING id`,
      [`AcadRv ${label}`, email, new Date().toISOString().slice(0, 10), leadership || null])).rows[0].id;
    const s = session();
    const lr = await s("/api/auth/login", { method: "POST", body: { email, password: "AcadRv123!" } });
    if (lr.status !== 200) throw new Error(`login failed for ${label}: ${lr.status} ${JSON.stringify(lr.data)}`);
    return { email, id, s, label };
  };

  const purge = async () => {
    const ids = "(SELECT id FROM hr_employees WHERE name LIKE 'AcadRv %')";
    const enr = `(SELECT id FROM academy_enrollments WHERE employee_id IN ${ids})`;
    for (const t of ["academy_dev_plans", "academy_review_ratings"]) {
      await pool.query(`DELETE FROM ${t} WHERE enrollment_id IN ${enr}`).catch(() => {});
    }
    await pool.query(`DELETE FROM academy_review_ratings WHERE review_id IN (SELECT id FROM academy_reviews WHERE enrollment_id IN ${enr})`).catch(() => {});
    await pool.query(`DELETE FROM academy_dev_plans WHERE enrollment_id IN ${enr}`).catch(() => {});
    await pool.query(`DELETE FROM academy_reviews WHERE enrollment_id IN ${enr}`).catch(() => {});
    for (const t of ["academy_progress", "academy_audit", "academy_checkins", "academy_questions", "academy_gaps"]) {
      await pool.query(`DELETE FROM ${t} WHERE enrollment_id IN ${enr}`).catch(() => {});
    }
    await pool.query(`DELETE FROM academy_enrollments WHERE employee_id IN ${ids}`).catch(() => {});
    await pool.query("DELETE FROM hr_employees WHERE name LIKE 'AcadRv %'").catch(() => {});
    await pool.query("DELETE FROM users WHERE email LIKE 'acadrv-%'").catch(() => {});
  };

  try {
    await purge();

    const owner = session();
    const ol = await owner("/api/auth/login", {
      method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
    if (ol.status !== 200) throw new Error("owner login failed: " + ol.status);

    const newbie = await mk("newbie", "clinical", null);
    const mentor = await mk("mentor", "clinical", null);
    const director = await mk("director", "clinical", "clinical_director");
    const stranger = await mk("stranger", "clinical", null);

    const er = await owner("/api/academy/enrollments", { method: "POST", body: {
      employee_id: newbie.id, mentor_id: mentor.id } });
    check("the new BCBA is enrolled, with a mentor", er.status === 200, er.data);
    const enr = er.data.enrollment.id;
    const R = `/api/academy/enrollments/${enr}/review`;

    // =====================================================================
    section("BEFORE ANYBODY HAS RATED ANYTHING");
    const g0 = await mentor.s(R);
    check("the mentor can open the review", g0.status === 200, g0.data);
    check("there is no review yet, rather than an empty one", g0.data.review === null, g0.data.review);
    check("all ten domains are offered", (g0.data.domains || []).length === 10, g0.data.domains);
    check("the mentor may rate", g0.data.can_rate === true, g0.data);
    check("BUT THE MENTOR MAY NOT APPROVE", g0.data.can_approve === false, g0.data);

    const a0 = await mentor.s(R + "/approve", { method: "POST", body: { summary: "Looks fine to me." } });
    check("a mentor approving is refused outright", a0.status === 403, a0);
    check("and told who does sign it off",
      /Clinical Director/i.test((a0.data || {}).error || ""), a0.data);

    section("WHO CANNOT EVEN LOOK");
    const s0 = await stranger.s(R);
    check("an unrelated BCBA cannot read somebody else's review", s0.status === 403, s0);
    const s1 = await stranger.s(R, { method: "POST", body: { domain: "systems", rating: "independent" } });
    check("nor rate it", s1.status === 403, s1);

    section("THE SUBJECT'S OWN HANDS ARE TIED");
    const m0 = await newbie.s(R, { method: "POST", body: { domain: "systems", rating: "independent" } });
    check("THE SUBJECT CANNOT RATE THEIR OWN DOMAINS", m0.status === 403, m0);
    check("and is told so in those words", /cannot rate your own/i.test((m0.data || {}).error || ""), m0.data);
    const m1 = await newbie.s(R + "/approve", { method: "POST", body: { summary: "I am ready." } });
    check("nor approve their own onboarding", m1.status === 403, m1);

    // =====================================================================
    section("RATING IS A JUDGEMENT THAT HAS TO SAY WHY");
    const bad1 = await mentor.s(R, { method: "POST", body: { domain: "nonsense", rating: "independent" } });
    check("an unknown domain is refused", bad1.status === 400, bad1);
    const bad2 = await mentor.s(R, { method: "POST", body: { domain: "systems", rating: "pretty good" } });
    check("an invented rating is refused", bad2.status === 400, bad2);
    const bad3 = await mentor.s(R, { method: "POST", body: { domain: "systems", rating: "needs_support" } });
    check("A RATING BELOW INDEPENDENT WITH NO REASON IS REFUSED", bad3.status === 400, bad3);
    check("because the development plan has to be written from something",
      /what is missing/i.test((bad3.data || {}).error || ""), bad3.data);
    const ok1 = await mentor.s(R, { method: "POST", body: { domain: "systems", rating: "independent" } });
    check("Independent needs no justification", ok1.status === 200, ok1);
    check("the review exists now, started by the first rating",
      ok1.data.review && ok1.data.review.state === "draft", ok1.data.review);

    section("WHAT THE EMPLOYEE CAN SEE WHILE IT IS A DRAFT");
    const mine = await newbie.s(R);
    check("they can open it", mine.status === 200, mine);
    check("THEY CANNOT READ THE DRAFT RATINGS",
      ((mine.data.review || {}).ratings || []).length === 0, mine.data.review);
    check("the screen says it is unfinished rather than showing nothing",
      (mine.data.review || {}).draft_in_progress === true, mine.data.review);
    check("and they are flagged as the subject", mine.data.is_subject === true, mine.data);

    // =====================================================================
    section("ELAPSED TIME APPROVES NOTHING");
    // Thirty-one days of service, nine domains unrated.
    await pool.query(
      "UPDATE academy_enrollments SET start_date = $1 WHERE id = $2",
      [new Date(Date.now() - 31 * 864e5).toISOString().slice(0, 10), enr]);
    const t1 = await director.s(R + "/approve", { method: "POST", body: { summary: "Thirty days is up." } });
    check("DAY 31 WITH NINE DOMAINS UNRATED IS STILL REFUSED", t1.status === 400, t1);
    check("and names every domain nobody has rated",
      (t1.data.unrated || []).length === 9, t1.data);

    section("A FULL CHECKLIST APPROVES NOTHING EITHER");
    const pr = await owner(`/api/academy/me`);  // warm; the real work is below
    // Tick every checklist item and sign off every competency, so progress
    // reads 100%, and then try to approve on the strength of it.
    const items = (await pool.query(
      `SELECT i.id, i.kind FROM academy_items i
        JOIN academy_modules mo ON mo.id = i.module_id
        JOIN academy_enrollments a ON a.program_id = mo.program_id
       WHERE a.id = $1`, [enr])).rows;
    for (const it of items) {
      await pool.query(
        `INSERT INTO academy_progress (enrollment_id, item_id, status, verified_by, verified_at, updated_at)
         VALUES ($1,$2,'completed','AcadRv mentor', now()::text, now()::text)
         ON CONFLICT (enrollment_id, item_id) DO UPDATE SET status = 'completed'`, [enr, it.id]);
    }
    const rosterNow = await director.s("/api/academy/enrollments");
    const row = (rosterNow.data.enrollments || []).find((e) => Number(e.id) === Number(enr));
    check("the roster now shows this person at 100%", row && row.percent === 100, row && row.percent);
    const t2 = await director.s(R + "/approve", { method: "POST", body: { summary: "Everything is ticked." } });
    check("100% COMPLETE AND DAY 31 IS *STILL* REFUSED", t2.status === 400, t2);
    check("because the unrated domains are what is missing",
      (t2.data.unrated || []).length === 9, t2.data);
    check("and the roster flags the review as due", row && row.review_due === true, row);

    // =====================================================================
    section("RATING THE REST, WITH ONE GAP");
    for (const d of DOMAINS.slice(1)) {
      const body = d === "supervision"
        ? { domain: d, rating: "needs_support", note: "Has not yet run an RBT supervision session alone." }
        : { domain: d, rating: "independent" };
      const r = await mentor.s(R, { method: "POST", body });
      if (r.status !== 200) check("rating " + d, false, r);
    }
    const full = await director.s(R);
    check("every domain is rated now", full.data.review.complete === true, full.data.review.unrated);
    check("and the one gap is listed", (full.data.review.gaps || []).length === 1, full.data.review.gaps);

    const t3 = await director.s(R + "/approve", { method: "POST", body: { summary: "Ready, with support." } });
    check("A GAP WITH NO DEVELOPMENT PLAN BLOCKS THE APPROVAL", t3.status === 400, t3);
    check("and names the area needing one",
      /RBT supervision/i.test((t3.data || {}).error || ""), t3.data);

    section("A PLAN IS NOT A PLAN WITHOUT DATES");
    const P = R + "/plans";
    const p1 = await mentor.s(P, { method: "POST", body: { domain: "supervision", action: "Shadow two sessions" } });
    check("no dates at all is refused", p1.status === 400, p1);
    // Each date tested with the OTHER one supplied. Sending neither proves
    // only that one of the two checks fired, which is how a missing-deadline
    // check could be deleted without a single test noticing.
    const p1b = await mentor.s(P, { method: "POST", body: {
      domain: "supervision", action: "Shadow two sessions", reassess_on: "2026-11-22" } });
    check("A REASSESSMENT DATE WITH NO DEADLINE IS REFUSED", p1b.status === 400, p1b);
    check("and says which one is missing", /deadline/i.test((p1b.data || {}).error || ""), p1b.data);
    const p2 = await mentor.s(P, { method: "POST", body: {
      domain: "supervision", action: "Shadow two sessions", due_date: "2026-11-15" } });
    check("A DEADLINE WITH NO REASSESSMENT DATE IS REFUSED", p2.status === 400, p2);
    check("and says why", /reassessed on/i.test((p2.data || {}).error || ""), p2.data);
    const p3 = await mentor.s(P, { method: "POST", body: {
      domain: "supervision", action: "Shadow two sessions", due_date: "2026-11-15", reassess_on: "2026-11-01" } });
    check("reassessing before the deadline is refused", p3.status === 400, p3);
    const p4 = await mentor.s(P, { method: "POST", body: {
      domain: "supervision", action: "Run two supervision sessions with the mentor observing",
      due_date: "2026-11-15", reassess_on: "2026-11-22" } });
    check("a plan with both dates is accepted", p4.status === 200, p4);
    check("and it is attached to the right domain",
      (p4.data.review.plans || []).some((x) => x.domain === "supervision"), p4.data.review.plans);

    const sp = await newbie.s(P, { method: "POST", body: {
      domain: "policy", action: "I will read them", due_date: "2026-11-15", reassess_on: "2026-11-22" } });
    check("the subject cannot write their own development plan", sp.status === 403, sp);

    // =====================================================================
    section("AN UNANSWERED COMPETENCY REQUEST BLOCKS IT TOO");
    const comp = (await pool.query(
      `SELECT i.id FROM academy_items i
        JOIN academy_modules mo ON mo.id = i.module_id
        JOIN academy_enrollments a ON a.program_id = mo.program_id
       WHERE a.id = $1 AND i.kind = 'competency' LIMIT 1`, [enr])).rows[0];
    await pool.query(
      "UPDATE academy_progress SET status = 'awaiting_review' WHERE enrollment_id = $1 AND item_id = $2",
      [enr, comp.id]);
    const t4 = await director.s(R + "/approve", { method: "POST", body: { summary: "Ready." } });
    check("A COMPETENCY STILL WAITING ON A SUPERVISOR BLOCKS THE APPROVAL", t4.status === 400, t4);
    check("and says how many are unanswered", t4.data.awaiting_review === 1, t4.data);
    await pool.query(
      "UPDATE academy_progress SET status = 'completed' WHERE enrollment_id = $1 AND item_id = $2",
      [enr, comp.id]);

    section("AND AN APPROVAL WITH NO WORDS");
    const t5 = await director.s(R + "/approve", { method: "POST", body: {} });
    check("a blank summary is refused", t5.status === 400, t5);
    check("because somebody's probation is ending on it",
      /summary/i.test((t5.data || {}).error || ""), t5.data);

    // =====================================================================
    section("THE CLINICAL DIRECTOR SIGNS IT OFF");
    const done = await director.s(R + "/approve", { method: "POST", body: {
      summary: "Strong on documentation and systems. Supervision needs two observed sessions; plan is in place." } });
    check("with every domain rated, the gap planned and a summary written, it goes through",
      done.status === 200, done);
    check("AND IT IS RECORDED AS APPROVED-WITH-A-PLAN, not plain approved",
      done.data.state === "development_plan", done.data);
    const er2 = (await pool.query("SELECT * FROM academy_enrollments WHERE id = $1", [enr])).rows[0];
    check("the enrolment is completed", er2.state === "completed", er2.state);
    check("and carries who approved it", /director/i.test(er2.approved_by || ""), er2.approved_by);

    section("WHAT THE EMPLOYEE SEES NOW");
    const mine2 = await newbie.s(R);
    check("NOW they see every rating", (mine2.data.review.ratings || []).length === 10,
      (mine2.data.review.ratings || []).length);
    check("including the note on the one they need support with",
      (mine2.data.review.ratings || []).some((x) => /supervision session alone/i.test(x.note || "")),
      mine2.data.review.ratings);
    check("and their development plan with its dates",
      (mine2.data.review.plans || []).some((p) => p.due_date === "2026-11-15" && p.reassess_on === "2026-11-22"),
      mine2.data.review.plans);
    check("and the summary they were sent", /observed sessions/.test(mine2.data.review.summary || ""),
      mine2.data.review.summary);

    section("AN APPROVED REVIEW IS CLOSED");
    const re = await mentor.s(R, { method: "POST", body: { domain: "systems", rating: "not_demonstrated", note: "Changed my mind." } });
    check("a rating cannot be changed after sign-off", re.status === 400, re);
    const again = await director.s(R + "/approve", { method: "POST", body: { summary: "Again." } });
    check("and it cannot be approved twice", again.status === 400, again);

    section("CLOSING A DEVELOPMENT PLAN");
    const plan = (await pool.query("SELECT * FROM academy_dev_plans WHERE enrollment_id = $1", [enr])).rows[0];
    const c1 = await mentor.s(`/api/academy/plans/${plan.id}`, { method: "PATCH", body: {} });
    check("closing one with no outcome is refused", c1.status === 400, c1);
    const c2 = await newbie.s(`/api/academy/plans/${plan.id}`, { method: "PATCH", body: { outcome: "Done it." } });
    check("THE SUBJECT CANNOT CLOSE THEIR OWN PLAN", c2.status === 403, c2);
    const c3 = await mentor.s(`/api/academy/plans/${plan.id}`, { method: "PATCH", body: {
      outcome: "Ran both sessions on 20 Nov, observed, independent now." } });
    check("the mentor can close it with what the reassessment found", c3.status === 200, c3);
    const closed = (await pool.query("SELECT * FROM academy_dev_plans WHERE id = $1", [plan.id])).rows[0];
    check("and the outcome is kept, not just the closure",
      /observed, independent/.test(closed.outcome || ""), closed.outcome);

    // =====================================================================
    section("A CLINICAL DIRECTOR GOING THROUGH THE ACADEMY HERSELF");
    // The case the is_subject flag exists for: somebody who holds the
    // designation that approves, being the person under review. Every other
    // refusal in this file would also refuse an ordinary BCBA, so none of
    // them prove the subject check does anything. This one does.
    const bossNewbie = await mk("boss-newbie", "clinical", "assistant_clinical_director");
    const er3 = await owner("/api/academy/enrollments", { method: "POST", body: { employee_id: bossNewbie.id } });
    check("she is enrolled", er3.status === 200, er3.data);
    const R2 = `/api/academy/enrollments/${er3.data.enrollment.id}/review`;
    const own = await bossNewbie.s(R2);
    check("she can open her own record", own.status === 200, own);
    check("BUT SHE IS NOT OFFERED THE RATING CONTROLS, despite her designation",
      own.data.can_rate === false, own.data);
    check("NOR THE APPROVAL, despite holding the designation that approves",
      own.data.can_approve === false, own.data);
    const or1 = await bossNewbie.s(R2, { method: "POST", body: { domain: "systems", rating: "independent" } });
    check("AND THE SERVER REFUSES HER RATING HERSELF INDEPENDENT", or1.status === 403, or1);
    const or2 = await bossNewbie.s(R2 + "/approve", { method: "POST", body: { summary: "I am good." } });
    check("AND REFUSES HER SIGNING HER OWN COMPLETION", or2.status === 403, or2);
    // ...while the same person is perfectly able to do it for somebody else.
    const other = await mk("other", "clinical", null);
    const er4 = await owner("/api/academy/enrollments", { method: "POST", body: { employee_id: other.id } });
    const R3 = `/api/academy/enrollments/${er4.data.enrollment.id}/review`;
    const el = await bossNewbie.s(R3);
    check("the very same person CAN rate and approve somebody else",
      el.data.can_rate === true && el.data.can_approve === true, el.data);

    // AND SHE CANNOT WRITE OR CLOSE HER OWN DEVELOPMENT PLAN EITHER.
    // The earlier plan checks used an ordinary new BCBA, who is refused for
    // not being a mentor or leadership -- so they would have passed with the
    // subject rule deleted. She is leadership, so only the subject rule
    // stands between her and her own plan.
    const op = await bossNewbie.s(R2 + "/plans", { method: "POST", body: {
      domain: "supervision", action: "I will sort this out myself",
      due_date: "2026-12-01", reassess_on: "2026-12-15" } });
    check("SHE CANNOT WRITE A PLAN ON HER OWN REVIEW, designation and all", op.status === 403, op);

    // Somebody else -- the Clinical Director -- rates her and plans for her.
    await director.s(R2, { method: "POST", body: {
      domain: "supervision", rating: "needs_support", note: "New to supervising at this site." } });
    const dp = await director.s(R2 + "/plans", { method: "POST", body: {
      domain: "supervision", action: "Co-run three supervision sessions",
      due_date: "2026-12-01", reassess_on: "2026-12-15" } });
    check("the Clinical Director can plan for her", dp.status === 200, dp);
    const herPlan = (dp.data.review.plans || [])[0];
    const oc = await bossNewbie.s(`/api/academy/plans/${herPlan.id}`, { method: "PATCH", body: {
      outcome: "I think I am fine now." } });
    check("AND SHE CANNOT CLOSE HER OWN PLAN, designation and all", oc.status === 403, oc);
    const oc2 = await director.s(`/api/academy/plans/${herPlan.id}`, { method: "PATCH", body: {
      outcome: "Co-ran all three; independent." } });
    check("the Clinical Director can close it", oc2.status === 200, oc2);

    section("THE AUDIT TRAIL");
    const aud = (await pool.query(
      "SELECT * FROM academy_audit WHERE enrollment_id = $1 ORDER BY id", [enr])).rows;
    check("the ratings are on the record",
      aud.filter((a) => a.action === "review_rating").length >= 10,
      aud.filter((a) => a.action === "review_rating").length);
    check("so is the development plan", aud.some((a) => a.action === "dev_plan"), aud.map((a) => a.action));
    check("so is the approval, with who did it",
      aud.some((a) => a.action === "onboarding_approved" && /director/i.test(a.actor || "")),
      aud.filter((a) => a.action === "onboarding_approved"));
    check("and closing the plan", aud.some((a) => a.action === "dev_plan_closed"), aud.map((a) => a.action));

    section("IT REPORTS TO THE DAILY DIGEST");
    const comp2 = (await pool.query(
      "SELECT * FROM completions WHERE event_key = 'academy_approved' AND dedupe_key = $1",
      ["academy_approved:" + enr])).rows[0];
    check("the approval is recorded as a completion", !!comp2, comp2);
    check("WITH THE PERSON'S NAME ON IT, not a blank line in the digest",
      comp2 && /AcadRv newbie/.test(comp2.subject || ""), comp2 && comp2.subject);
    check("and says it came with a development plan",
      comp2 && /development plan/i.test(comp2.detail || ""), comp2 && comp2.detail);

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
