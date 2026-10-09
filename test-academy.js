// The Onboarding Academy.
//
// The checklist is the easy half. What this suite is really about is the one
// rule the whole module exists to hold:
//
//   OPENING A DOCUMENT IS NOT EVIDENCE OF COMPETENCE.
//
// An employee can tick a reading, and they can say they are ready for a
// competency review. They cannot sign off their own competency, they cannot
// be their own mentor, and they cannot undo a supervisor's sign-off. If any
// of those became possible, the programme would certify people who had done
// nothing but click, and a certificate nobody can trust is worse than no
// certificate at all.
//
// Everything else here -- the designation, the cross-programme item id, the
// reason required when sending work back -- is about the same thing from a
// different angle: a record of competence that means what it says.
//
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-academy.js
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
// Same scheme server.js uses: scrypt, 64 bytes, hex salt.
const hp = (pw) => {
  const crypto = require("crypto");
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") };
};

(async () => {
  const owner = client();
  const newbie = client();   // the BCBA being onboarded
  const mentor = client();   // their assigned mentor
  const lead = client();     // the Assistant Clinical Director

  check("owner signs in", (await owner("/api/auth/login", {
    method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);

  // ---- fixtures ---------------------------------------------------------
  const purge = async () => {
    const ids = "(SELECT id FROM hr_employees WHERE name LIKE 'Acad %')";
    await pool.query(`DELETE FROM academy_progress WHERE enrollment_id IN (SELECT id FROM academy_enrollments WHERE employee_id IN ${ids})`).catch(() => {});
    await pool.query(`DELETE FROM academy_audit WHERE enrollment_id IN (SELECT id FROM academy_enrollments WHERE employee_id IN ${ids})`).catch(() => {});
    await pool.query(`DELETE FROM academy_enrollments WHERE employee_id IN ${ids}`).catch(() => {});
    await pool.query("DELETE FROM hr_employees WHERE name LIKE 'Acad %'").catch(() => {});
    await pool.query("DELETE FROM users WHERE email LIKE 'acad-%'").catch(() => {});
  };
  await purge();

  const mkUser = async (email, role) => {
    const p = hp("AcadPass123!");
    await pool.query(
      `INSERT INTO users (name, email, password_hash, password_salt, role, created_at)
       VALUES ($1,$2,$3,$4,$5, now()) ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash, password_salt = EXCLUDED.password_salt, role = EXCLUDED.role`,
      [email, email, p.hash, p.salt, role]);
  };
  const mkEmp = async (name, email, title, hire) => (await pool.query(
    `INSERT INTO hr_employees (name, email, role_title, hr_hire_date, status)
     VALUES ($1,$2,$3,$4,'active') RETURNING id`, [name, email, title, hire])).rows[0].id;

  const newbieEmail = `acad-new-${stamp}@example.invalid`;
  const mentorEmail = `acad-mentor-${stamp}@example.invalid`;
  const leadEmail = `acad-lead-${stamp}@example.invalid`;
  await mkUser(newbieEmail, "clinical");
  await mkUser(mentorEmail, "clinical");
  await mkUser(leadEmail, "clinical");
  const today = new Date().toISOString().slice(0, 10);
  const newbieId = await mkEmp("Acad Newbie", newbieEmail, "BCBA", today);
  const mentorId = await mkEmp("Acad Mentor", mentorEmail, "BCBA", "2024-01-05");
  const leadId = await mkEmp("Acad Lead", leadEmail, "BCBA", "2023-03-01");

  check("the new BCBA signs in", (await newbie("/api/auth/login", { method: "POST", body: { email: newbieEmail, password: "AcadPass123!" } })).status === 200);
  check("the mentor signs in", (await mentor("/api/auth/login", { method: "POST", body: { email: mentorEmail, password: "AcadPass123!" } })).status === 200);
  check("the clinical lead signs in", (await lead("/api/auth/login", { method: "POST", body: { email: leadEmail, password: "AcadPass123!" } })).status === 200);

  // ==================================================================
  section("1. THE CURRICULUM IS DATA, AND IT IS SEEDED");
  const cur = await owner("/api/academy/curriculum");
  check("the BCBA programme exists", cur.status === 200 && cur.data.program, cur.data);
  check("with four weeks", (cur.data.modules || []).length === 4, (cur.data.modules || []).length);
  const everyWeekHasCompetency = (cur.data.modules || []).every((m) =>
    (m.items || []).some((i) => i.kind === "competency"));
  check("and EVERY week ends in a competency, not just a tick list", everyWeekHasCompetency,
    (cur.data.modules || []).map((m) => (m.items || []).map((i) => i.kind).join(",")));
  check("week 1 is Welcome to the Squad",
    (cur.data.modules || [])[0] && /Welcome to the Squad/.test(cur.data.modules[0].title),
    (cur.data.modules || [])[0]);

  // ==================================================================
  section("2. NAMING CLINICAL LEADERSHIP IS AN OWNER ACT");
  // It hands somebody the power to sign off competencies, which is not a
  // thing a clinical lead should be able to grant themselves.
  const selfPromote = await lead(`/api/academy/leadership/${leadId}`, {
    method: "PUT", body: { leadership: "clinical_director" } });
  check("A CLINICAL ACCOUNT CANNOT NAME ITSELF CLINICAL DIRECTOR", selfPromote.status === 403, selfPromote);
  const named = await owner(`/api/academy/leadership/${leadId}`, {
    method: "PUT", body: { leadership: "assistant_clinical_director" } });
  check("the owner can name an Assistant Clinical Director", named.status === 200, named.data);

  // One director, so "the Clinical Director approved it" is never ambiguous.
  await owner(`/api/academy/leadership/${mentorId}`, { method: "PUT", body: { leadership: "clinical_director" } });
  await owner(`/api/academy/leadership/${newbieId}`, { method: "PUT", body: { leadership: "clinical_director" } });
  const after = await owner("/api/academy/leadership");
  const directors = (await pool.query(
    "SELECT COUNT(*) AS n FROM hr_employees WHERE academy_leadership = 'clinical_director'")).rows[0];
  check("NAMING A SECOND DIRECTOR REPLACES THE FIRST — there is only ever one",
    Number(directors.n) === 1, directors);
  // Put it back somewhere sensible for the rest of the suite.
  await owner(`/api/academy/leadership/${newbieId}`, { method: "PUT", body: { leadership: "" } });
  await owner(`/api/academy/leadership/${mentorId}`, { method: "PUT", body: { leadership: "" } });

  // ==================================================================
  section("3. ENROLMENT");
  const notLead = await newbie("/api/academy/enrollments", { method: "POST", body: { employee_id: newbieId } });
  check("an ordinary BCBA cannot start an onboarding", notLead.status === 403, notLead);
  const enrolled = await lead("/api/academy/enrollments", { method: "POST", body: { employee_id: newbieId } });
  check("clinical leadership can", enrolled.status === 200 && enrolled.data.ok, enrolled.data);
  const enrId = enrolled.data.enrollment.id;
  check("the start date comes from their hire date, not from today's typing",
    enrolled.data.enrollment.start_date === today, enrolled.data.enrollment);

  // "Do not overwrite onboarding records for existing employees."
  const again = await lead("/api/academy/enrollments", { method: "POST", body: { employee_id: newbieId } });
  check("ENROLLING TWICE DOES NOT OVERWRITE — it returns the record that exists",
    again.status === 200 && again.data.already === true && again.data.enrollment.id === enrId, again.data);
  const count = (await pool.query("SELECT COUNT(*) AS n FROM academy_enrollments WHERE employee_id = $1", [newbieId])).rows[0];
  check("and there is still exactly one record", Number(count.n) === 1, count);

  // ==================================================================
  section("4. THE EMPLOYEE WORKS THROUGH THEIR OWN ITEMS");
  const mine = await newbie("/api/academy/me");
  check("they can see their own academy", mine.status === 200 && mine.data.enrolled, mine.data);
  check("it starts at zero per cent", mine.data.progress.percent === 0, mine.data.progress.percent);
  const items = mine.data.progress.items;
  const checklistItem = items.find((i) => i.kind === "checklist");
  const competencyItem = items.find((i) => i.kind === "competency");
  check("there are checklist items and competency items", !!checklistItem && !!competencyItem,
    items.map((i) => i.kind).slice(0, 5));

  const ticked = await newbie(`/api/academy/items/${checklistItem.item_id}`, { method: "POST", body: { status: "completed" } });
  check("they can complete a checklist item themselves", ticked.status === 200, ticked.data);
  check("and the percentage moves", ticked.data.progress.percent > 0, ticked.data.progress.percent);

  // ==================================================================
  section("5. THE RULE THE MODULE EXISTS FOR");
  const selfSign = await newbie(`/api/academy/items/${competencyItem.item_id}`, { method: "POST", body: { status: "completed" } });
  check("AN EMPLOYEE CANNOT SIGN OFF THEIR OWN COMPETENCY", selfSign.status === 400, selfSign);
  check("and the refusal explains who does", /supervisor/i.test(String(selfSign.data.error || "")), selfSign.data);
  const stillOpen = (await pool.query(
    "SELECT status FROM academy_progress WHERE enrollment_id = $1 AND item_id = $2", [enrId, competencyItem.item_id])).rows[0];
  check("nothing was written by the attempt", !stillOpen || stillOpen.status !== "completed", stillOpen);

  const ready = await newbie(`/api/academy/items/${competencyItem.item_id}`, { method: "POST", body: { status: "awaiting_review" } });
  check("they CAN say they are ready for review", ready.status === 200, ready.data);
  check("which is a status of its own, not a completion",
    ready.data.progress.items.find((i) => i.item_id === competencyItem.item_id).status === "awaiting_review",
    ready.data.progress.items.find((i) => i.item_id === competencyItem.item_id));
  check("and it does not count toward the percentage",
    ready.data.progress.completed === 1, ready.data.progress);

  // ==================================================================
  section("6. WHO MAY REVIEW IT");
  const reviewSelf = await newbie(`/api/academy/enrollments/${enrId}/items/${competencyItem.item_id}`, {
    method: "POST", body: { status: "completed" } });
  check("THE EMPLOYEE CANNOT REVIEW THEMSELVES THROUGH THE REVIEW ROUTE EITHER",
    reviewSelf.status === 403, reviewSelf);

  const strangerReview = await mentor(`/api/academy/enrollments/${enrId}/items/${competencyItem.item_id}`, {
    method: "POST", body: { status: "completed" } });
  check("a BCBA who is not the mentor and not leadership cannot review",
    strangerReview.status === 403, strangerReview);

  const selfMentor = await lead(`/api/academy/enrollments/${enrId}`, { method: "PATCH", body: { mentor_id: newbieId } });
  check("SOMEBODY CANNOT BE SET AS THEIR OWN MENTOR", selfMentor.status === 400, selfMentor);

  const assign = await lead(`/api/academy/enrollments/${enrId}`, { method: "PATCH", body: { mentor_id: mentorId } });
  check("a real mentor can be assigned", assign.status === 200, assign.data);

  const noReason = await mentor(`/api/academy/enrollments/${enrId}/items/${competencyItem.item_id}`, {
    method: "POST", body: { status: "needs_training" } });
  check("sending work back REQUIRES a reason", noReason.status === 400, noReason);

  const sentBack = await mentor(`/api/academy/enrollments/${enrId}/items/${competencyItem.item_id}`, {
    method: "POST", body: { status: "needs_training", note: "Run through authorisation tracking again with me." } });
  check("with a reason it goes back", sentBack.status === 200, sentBack.data);
  check("and the reason reaches the employee's own view",
    /authorisation tracking/i.test(String((await newbie("/api/academy/me")).data.progress.items
      .find((i) => i.item_id === competencyItem.item_id).reviewer_note || "")), "the note is missing");

  const signed = await mentor(`/api/academy/enrollments/${enrId}/items/${competencyItem.item_id}`, {
    method: "POST", body: { status: "completed", note: "Demonstrated on 3 files." } });
  check("the mentor signs it off", signed.status === 200, signed.data);
  const row = (await pool.query(
    "SELECT * FROM academy_progress WHERE enrollment_id = $1 AND item_id = $2", [enrId, competencyItem.item_id])).rows[0];
  check("AND THE RECORD NAMES WHO SIGNED IT", !!row.verified_by, row);
  check("with a timestamp", !!row.verified_at, row);

  // ==================================================================
  section("7. A SIGN-OFF IS NOT UNDONE BY THE PERSON IT WAS ABOUT");
  const undo = await newbie(`/api/academy/items/${competencyItem.item_id}`, { method: "POST", body: { status: "in_progress" } });
  check("the employee cannot reopen a verified competency", undo.status === 400, undo);
  const stillSigned = (await pool.query(
    "SELECT status, verified_by FROM academy_progress WHERE enrollment_id = $1 AND item_id = $2",
    [enrId, competencyItem.item_id])).rows[0];
  check("and it is still signed off", stillSigned.status === "completed" && !!stillSigned.verified_by, stillSigned);

  // ==================================================================
  section("8. AN ITEM FROM ANOTHER PROGRAMME IS NOT THEIR WORK");
  const foreign = await newbie("/api/academy/items/99999999", { method: "POST", body: { status: "completed" } });
  check("an item id that is not in their programme is refused", foreign.status === 404, foreign);

  // ==================================================================
  section("9. THE AUDIT TRAIL");
  const detail = await lead(`/api/academy/enrollments/${enrId}`);
  check("leadership can open the record", detail.status === 200, detail.status);
  const trail = detail.data.audit || [];
  check("every decision is on it", trail.length >= 4, trail.length);
  check("including who signed the competency off",
    trail.some((a) => a.action === "review" && a.to_status === "completed" && a.actor), trail.slice(0, 3));
  check("and the attempt to self-sign left no completion in it",
    !trail.some((a) => a.action === "employee_status" && a.to_status === "completed" && a.item_id === competencyItem.item_id),
    trail.filter((a) => a.action === "employee_status").slice(0, 3));

  // ==================================================================
  section("10. THE DASHBOARD SHOWS THE RIGHT PEOPLE TO THE RIGHT PEOPLE");
  const leadList = await lead("/api/academy/enrollments");
  check("leadership sees the enrolment", leadList.status === 200
    && (leadList.data.enrollments || []).some((e) => e.id === enrId), (leadList.data.enrollments || []).length);
  check("with a percentage and a day number to act on",
    (leadList.data.enrollments || []).some((e) => e.id === enrId && typeof e.percent === "number" && e.day >= 1),
    (leadList.data.enrollments || []).find((e) => e.id === enrId));
  const mentorList = await mentor("/api/academy/enrollments");
  check("a mentor sees their own mentee", (mentorList.data.enrollments || []).some((e) => e.id === enrId),
    (mentorList.data.enrollments || []).length);
  check("but is not told they can manage the programme",
    mentorList.data.can_manage === false, mentorList.data.can_manage);

  await purge();
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
