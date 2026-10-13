// WHO HAS TO DO WHAT, AND WHAT COUNTS AS HAVING DONE IT.
//
// Step 3 of the Compliance & Certification Hub: the assignment engine and the
// page an employee sees. These tests defend the properties the brief states in
// its own words, because every one of them is a thing that goes quietly wrong.
//
// 1. NO DUPLICATE TRAINING RECORDS. "Avoid creating duplicate training records
//    when a course is required by multiple onboarding programs", and nobody
//    should "repeat the same current training simply because it appears in
//    multiple onboarding programs". Requirements are COMPUTED from the rules,
//    so two rules catching one person is ONE requirement -- and where the
//    rules disagree the stricter number wins rather than both applying.
//
// 2. A CLAIM IS NOT A COMPLETION. Certificates come "only after verified
//    completion", and nothing is approved "based solely on elapsed time or
//    checklist completion". So a self-report sits as submitted until a human
//    checks it, and the employee who filed it cannot be the one who checks it.
//
// 3. A POLICY ACKNOWLEDGMENT IS THE COMPLETION, read from the acknowledgment
//    already on file. No second record is written anywhere -- that would be
//    exactly the duplicate the brief rules out.
//
// 4. THE DEADLINE CLOCK STARTS AT THE LATER of the person's hire date and the
//    day the rule took effect, so writing a rule this morning does not make a
//    five-year employee retroactively overdue.
//
// 5. PERMISSIONS ARE ENFORCED ON THE BACKEND. The training-only role can read
//    its OWN training and nothing else -- not the library, not anybody else's
//    record, and it cannot verify its own claim.
//
//   DATABASE_URL=... node run-tests.js test-compliance-assignment.js
"use strict";

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
  return async (path, opts = {}) => {
    const r = await fetch(BASE + path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", ...(jar ? { Cookie: jar } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      redirect: "manual",
    });
    const setC = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (setC && setC.length) jar = setC.map((c) => c.split(";")[0]).join("; ");
    let data = null; try { data = await r.json(); } catch (e) {}
    return { status: r.status, data };
  };
}
const login = async (email, password) => {
  const c = client();
  const r = await c("/api/auth/login", { method: "POST", body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status}`);
  return c;
};

const iso = (d) => d.toISOString().slice(0, 10);
const TODAY = iso(new Date());
const daysAgo = (n) => iso(new Date(Date.now() - n * 86400000));
const daysAhead = (n) => iso(new Date(Date.now() + n * 86400000));
const monthsAgo = (n) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - n); return iso(d); };
const stamp = Math.random().toString(36).slice(2, 8);

(async () => {
  const owner = await login("admin@spectrumsquadlv.com", "TestOwner123!");

  const mkCourse = async (body) => {
    const r = await owner("/api/compliance/courses", { method: "POST", body });
    if (r.status !== 201) throw new Error(`course create failed: ${r.status} ${JSON.stringify(r.data)}`);
    return r.data.id;
  };
  const setRules = (id, rules) => owner(`/api/compliance/courses/${id}/rules`, { method: "PUT", body: { rules } });

  // An employee record with no login: enough for the engine, and it keeps the
  // engine tests clear of anything to do with roles.
  const mkEmp = async ({ name, title, dept = null, hire = daysAgo(400), userId = null }) => {
    const r = await q(
      `INSERT INTO hr_employees (user_id, name, email, role_title, department_key, hire_date, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7) RETURNING id`,
      [userId, name, `${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}.${stamp}@example.test`,
       title, dept, hire, new Date().toISOString()]);
    return r.rows[0].id;
  };
  const trainingOf = async (empId, c) => (await (c || owner)(`/api/compliance/employees/${empId}/training`)).data;
  const rowFor = (rec, courseId) => (rec.required || []).concat(rec.optional || []).find((r) => r.course_id === courseId);

  // ==================================================================
  section("A course with no rule is required of nobody");
  const rbt = await mkEmp({ name: `Rbt Probe ${stamp}`, title: "Registered Behavior Technician", dept: "rbt" });
  const bcba = await mkEmp({ name: `Bcba Probe ${stamp}`, title: "Board Certified Behavior Analyst", dept: "clinical" });

  const unruled = await mkCourse({ title: `Unruled ${stamp}`, delivery: "internal" });
  check("it does not appear in anybody's training", !rowFor(await trainingOf(rbt), unruled));

  // ==================================================================
  section("Required of everybody means everybody");
  const everyone = await mkCourse({ title: `Everyone ${stamp}`, delivery: "internal" });
  await setRules(everyone, [{ scope: "all", due_days: 30, effective_from: daysAgo(500) }]);
  check("the RBT has it", !!rowFor(await trainingOf(rbt), everyone));
  check("the BCBA has it too", !!rowFor(await trainingOf(bcba), everyone));
  check("and it says why they have it",
    /everybody/i.test(rowFor(await trainingOf(rbt), everyone).required_because),
    rowFor(await trainingOf(rbt), everyone).required_because);

  // ==================================================================
  section("A position rule catches that position and no other");
  const rbtOnly = await mkCourse({ title: `Rbt Only ${stamp}`, delivery: "internal" });
  await setRules(rbtOnly, [{ scope: "position", position_group: "rbt", due_days: 14, effective_from: daysAgo(500) }]);
  check("the RBT has it", !!rowFor(await trainingOf(rbt), rbtOnly));
  check("THE BCBA DOES NOT", !rowFor(await trainingOf(bcba), rbtOnly));

  section("A department rule catches that department and no other");
  const clinicalOnly = await mkCourse({ title: `Clinical Only ${stamp}`, delivery: "internal" });
  await setRules(clinicalOnly, [{ scope: "department", department_key: "clinical", due_days: 14, effective_from: daysAgo(500) }]);
  check("the clinical BCBA has it", !!rowFor(await trainingOf(bcba), clinicalOnly));
  check("THE RBT DOES NOT", !rowFor(await trainingOf(rbt), clinicalOnly));

  // ==================================================================
  section("TWO RULES CATCHING ONE PERSON IS ONE REQUIREMENT");
  const twice = await mkCourse({ title: `Required Twice ${stamp}`, delivery: "internal" });
  await setRules(twice, [
    { scope: "all", due_days: 30, renewal_months: 24, effective_from: daysAgo(500) },
    { scope: "position", position_group: "rbt", due_days: 7, renewal_months: 12, effective_from: daysAgo(500) },
  ]);
  const recTwice = await trainingOf(rbt);
  const hits = (recTwice.required || []).filter((r) => r.course_id === twice);
  check("IT APPEARS EXACTLY ONCE, not once per rule", hits.length === 1, hits.length);
  check("the STRICTER deadline wins (7 days, not 30)", hits[0].due_days === 7, hits[0].due_days);
  check("the STRICTER renewal wins (12 months, not 24)", hits[0].renewal_months === 12, hits[0].renewal_months);
  check("and it names both reasons it is required", /everybody/i.test(hits[0].required_because)
    && /RBT|Behavior Tech/i.test(hits[0].required_because), hits[0].required_because);

  // ==================================================================
  section("THE DEADLINE CLOCK STARTS AT THE LATER OF HIRE DATE AND RULE DATE");
  // A rule written today must not land on a long-standing employee as overdue.
  const newRule = await mkCourse({ title: `New Rule ${stamp}`, delivery: "internal" });
  await setRules(newRule, [{ scope: "position", position_group: "rbt", due_days: 7, effective_from: TODAY }]);
  const oldHand = rowFor(await trainingOf(rbt), newRule);
  check("a 400-day employee is NOT overdue on a rule written today", oldHand.state === "due", oldHand.state);
  check("...and the deadline is seven days from the rule, not from their hire date",
    oldHand.due_on === daysAhead(7), [oldHand.due_on, daysAhead(7)]);

  // The mirror case, so the test bites if the code used effective_from alone.
  const fresh = await mkEmp({ name: `Fresh Probe ${stamp}`, title: "Registered Behavior Technician", dept: "rbt", hire: daysAgo(3) });
  const oldRule = await mkCourse({ title: `Old Rule ${stamp}`, delivery: "internal" });
  await setRules(oldRule, [{ scope: "position", position_group: "rbt", due_days: 7, effective_from: daysAgo(365) }]);
  const newHire = rowFor(await trainingOf(fresh), oldRule);
  check("a 3-day hire is NOT overdue on a year-old rule", newHire.state === "due", newHire.state);
  check("...and their deadline runs from their hire date",
    newHire.due_on === daysAhead(4), [newHire.due_on, daysAhead(4)]);

  section("Past the deadline is overdue, and says how long");
  const late = await mkCourse({ title: `Late ${stamp}`, delivery: "internal" });
  await setRules(late, [{ scope: "all", due_days: 10, effective_from: daysAgo(100) }]);
  const lateRow = rowFor(await trainingOf(rbt), late);
  check("it is overdue", lateRow.state === "overdue", lateRow.state);
  check("and the days are negative rather than absent", lateRow.days_left < 0, lateRow.days_left);

  section("No deadline set reads as exactly that, not as urgent");
  const noDue = await mkCourse({ title: `No Deadline ${stamp}`, delivery: "internal" });
  await setRules(noDue, [{ scope: "all", effective_from: daysAgo(100) }]);
  const noDueRow = rowFor(await trainingOf(rbt), noDue);
  check("the state is no_deadline", noDueRow.state === "no_deadline", noDueRow.state);
  check("and no date was invented for it", noDueRow.due_on === null, noDueRow.due_on);

  // ==================================================================
  section("A CLAIM IS NOT A COMPLETION");
  const PW = "TrainPw123!";
  const selfEmail = `zz.training.${stamp}@example.test`;
  const made = await owner("/api/admin/users", {
    method: "POST", body: { name: `Zz Training ${stamp}`, email: selfEmail, password: PW, role: "employee" } });
  check("an employee-role login was created for the self-report tests", !!(made.data && made.data.id),
    [made.status, made.data]);
  const selfEmp = await mkEmp({ name: `Zz Training ${stamp}`, title: "Registered Behavior Technician",
    dept: "rbt", hire: daysAgo(30), userId: made.data.id });
  const emp = await login(selfEmail, PW);

  const claimed = await mkCourse({ title: `Claimed ${stamp}`, delivery: "external_link",
    external_url: "https://example.com/course" });
  await setRules(claimed, [{ scope: "all", due_days: 30, effective_from: daysAgo(10) }]);

  const mine0 = (await emp("/api/compliance/my-training")).data;
  check("the employee can read their own training", !!mine0 && mine0.linked === true, mine0 && mine0.linked);
  check("...and the course they must do is on it", !!rowFor(mine0, claimed));

  const report = await emp(`/api/compliance/my-training/${claimed}/report`,
    { method: "POST", body: { completed_on: TODAY, hours: 1.5, evidence_note: "Took it online" } });
  check("they can report having done it", report.status === 201, [report.status, report.data]);
  check("THE REPORT IS NOT VERIFIED", report.data && report.data.verified === false, report.data);

  const mine1 = (await emp("/api/compliance/my-training")).data;
  const claimRow = rowFor(mine1, claimed);
  check("IT READS AS SUBMITTED, NOT COMPLETE", claimRow.state === "submitted", claimRow.state);
  check("so it is not counted as complete", mine1.summary.complete === 0 || !rowFor(mine1, claimed).completed_on,
    [mine1.summary, claimRow.completed_on]);
  check("the unverified hours are NOT counted as training hours yet",
    mine1.summary.training_hours === 0, mine1.summary.training_hours);
  const dbRow = await q("SELECT verified_at, verified_by, source, hours FROM compliance_completions WHERE employee_id = $1 AND course_id = $2",
    [selfEmp, claimed]);
  check("the stored row carries no verification", dbRow.rows.length === 1 && dbRow.rows[0].verified_at === null,
    dbRow.rows);
  check("and it is marked as self-reported", dbRow.rows[0].source === "self_report", dbRow.rows[0].source);

  section("THE PERSON WHO CLAIMED IT CANNOT BE THE ONE WHO CHECKS IT");
  const compId = (await q("SELECT id FROM compliance_completions WHERE employee_id = $1 AND course_id = $2",
    [selfEmp, claimed])).rows[0].id;
  const selfVerify = await emp(`/api/compliance/completions/${compId}/verify`, { method: "POST", body: { verified: true } });
  check("the employee cannot verify their own claim", selfVerify.status === 403, selfVerify.status);
  check("...and it is still not verified in the database",
    (await q("SELECT verified_at FROM compliance_completions WHERE id = $1", [compId])).rows[0].verified_at === null);

  section("VERIFYING IT IS WHAT MAKES IT COMPLETE");
  const ver = await owner(`/api/compliance/completions/${compId}/verify`, { method: "POST", body: { verified: true } });
  check("the owner can verify it", ver.status === 200, [ver.status, ver.data]);
  const mine2 = (await emp("/api/compliance/my-training")).data;
  check("NOW it is complete", rowFor(mine2, claimed).state === "complete", rowFor(mine2, claimed).state);
  check("...and the completion date is the one they gave", rowFor(mine2, claimed).completed_on === TODAY);
  check("...and the hours now count as training hours",
    mine2.summary.training_hours === 1.5, mine2.summary.training_hours);
  check("verification is on the record with a name",
    /verified/i.test(((await owner(`/api/compliance/courses/${claimed}/history`)).data.history || [])
      .map((h) => h.change).join(" ")));

  section("Verification can be withdrawn, and that is not a deletion");
  const un = await owner(`/api/compliance/completions/${compId}/verify`, { method: "POST", body: { verified: false, note: "wrong person" } });
  check("it can be withdrawn", un.status === 200, un.status);
  check("the row is still there", (await q("SELECT id FROM compliance_completions WHERE id = $1", [compId])).rows.length === 1);
  check("and the course is back to submitted",
    rowFor((await emp("/api/compliance/my-training")).data, claimed).state === "submitted");
  await owner(`/api/compliance/completions/${compId}/verify`, { method: "POST", body: { verified: true } });

  // ==================================================================
  section("RENEWALS");
  const renew12 = await mkCourse({ title: `Renew 12 ${stamp}`, delivery: "internal" });
  await setRules(renew12, [{ scope: "all", renewal_months: 12, effective_from: daysAgo(900) }]);
  const renew24 = await mkCourse({ title: `Renew 24 ${stamp}`, delivery: "internal" });
  await setRules(renew24, [{ scope: "all", renewal_months: 24, effective_from: daysAgo(900) }]);
  const renewNone = await mkCourse({ title: `Renew Never ${stamp}`, delivery: "internal" });
  await setRules(renewNone, [{ scope: "all", effective_from: daysAgo(900) }]);

  const thirteen = monthsAgo(13);
  for (const cid of [renew12, renew24, renewNone]) {
    await q(`INSERT INTO compliance_completions
      (employee_id, course_id, course_version, completed_on, source, hours, verified_by, verified_at, recorded_by, recorded_at)
      VALUES ($1,$2,1,$3,'recorded',2,'HR',$4,'HR',$4)`, [rbt, cid, thirteen, new Date().toISOString()]);
  }
  const rec13 = await trainingOf(rbt);
  check("a 13-month-old completion on a 12-month renewal is OVERDUE",
    rowFor(rec13, renew12).state === "overdue", rowFor(rec13, renew12).state);
  check("...and the renewal date is the completion plus twelve months",
    rowFor(rec13, renew12).due_on === (() => { const d = new Date(`${thirteen}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 12); return iso(d); })(),
    rowFor(rec13, renew12).due_on);
  check("THE SAME completion on a 24-month renewal is COMPLETE",
    rowFor(rec13, renew24).state === "complete", rowFor(rec13, renew24).state);
  check("with no renewal interval set it simply stays complete",
    rowFor(rec13, renewNone).state === "complete" && rowFor(rec13, renewNone).due_on === null,
    [rowFor(rec13, renewNone).state, rowFor(rec13, renewNone).due_on]);
  check("a completion still shows even when the renewal has lapsed",
    rowFor(rec13, renew12).completed_on === thirteen, rowFor(rec13, renew12).completed_on);

  // ==================================================================
  section("A POLICY ACKNOWLEDGMENT IS THE COMPLETION, AND WRITES NO SECOND RECORD");
  const pol = await q(
    `INSERT INTO crm_policies (title, category, body, slug, published, status, version, requires_acknowledgment, created_at, updated_at)
     VALUES ($1,'Compliance','Body text for the probe policy.',$2,TRUE,'Active','1',TRUE,$3,$3) RETURNING id`,
    [`Probe Policy ${stamp}`, `probe-policy-${stamp}`, new Date().toISOString()]);
  const polId = pol.rows[0].id;
  const ackCourse = await mkCourse({ title: `Ack Course ${stamp}`, delivery: "policy_ack", policy_id: polId });
  await setRules(ackCourse, [{ scope: "all", due_days: 14, effective_from: daysAgo(5) }]);

  const beforeAck = rowFor((await emp("/api/compliance/my-training")).data, ackCourse);
  check("before acknowledging, it is outstanding", beforeAck && beforeAck.state === "due", beforeAck && beforeAck.state);
  check("and it cannot be self-reported -- it points at Policies instead",
    (await emp(`/api/compliance/my-training/${ackCourse}/report`, { method: "POST", body: { completed_on: TODAY } })).status === 400);
  check("...with a message that says where to go",
    /polic/i.test(((await emp(`/api/compliance/my-training/${ackCourse}/report`,
      { method: "POST", body: { completed_on: TODAY } })).data || {}).error || ""));

  const ack = await emp(`/api/policies/${polId}/acknowledge`, { method: "POST", body: {} });
  check("the employee can acknowledge the policy", ack.status === 200, [ack.status, ack.data]);
  const afterAck = rowFor((await emp("/api/compliance/my-training")).data, ackCourse);
  check("ACKNOWLEDGING IT COMPLETES THE COURSE", afterAck.state === "complete", afterAck.state);
  check("NOT ONE ROW WAS WRITTEN TO THE COMPLETIONS TABLE FOR IT",
    (await q("SELECT id FROM compliance_completions WHERE course_id = $1", [ackCourse])).rows.length === 0);
  check("and it says the system recorded it rather than borrowing a name",
    /automatic/i.test(afterAck.verified_by || ""), afterAck.verified_by);

  section("A NEW VERSION OF THE POLICY IS NOT ALREADY ACKNOWLEDGED");
  await q("UPDATE crm_policies SET version = '2' WHERE id = $1", [polId]);
  const v2 = rowFor((await emp("/api/compliance/my-training")).data, ackCourse);
  check("the course is outstanding again", v2.state !== "complete", v2.state);
  check("and it says which version they signed", v2.policy && v2.policy.acknowledged_version === "1",
    v2.policy);
  check("an employee with no login shows as not acknowledged, not as complete",
    rowFor(await trainingOf(rbt), ackCourse).state !== "complete",
    rowFor(await trainingOf(rbt), ackCourse).state);

  // ==================================================================
  section("Recording the same sitting twice is refused; a renewal is not");
  const dup = await mkCourse({ title: `Dup ${stamp}`, delivery: "internal" });
  await setRules(dup, [{ scope: "all", renewal_months: 12, effective_from: daysAgo(500) }]);
  check("the first report is accepted",
    (await emp(`/api/compliance/my-training/${dup}/report`, { method: "POST", body: { completed_on: daysAgo(5) } })).status === 201);
  const again = await emp(`/api/compliance/my-training/${dup}/report`, { method: "POST", body: { completed_on: daysAgo(5) } });
  check("THE SAME DATE AGAIN IS REFUSED", again.status === 409, [again.status, again.data]);
  check("a DIFFERENT date is accepted, because that is a renewal",
    (await emp(`/api/compliance/my-training/${dup}/report`, { method: "POST", body: { completed_on: daysAgo(1) } })).status === 201);
  check("both sittings are kept",
    (await q("SELECT id FROM compliance_completions WHERE employee_id = $1 AND course_id = $2", [selfEmp, dup])).rows.length === 2);

  section("Nonsense is refused");
  check("training cannot be completed in the future",
    (await emp(`/api/compliance/my-training/${dup}/report`, { method: "POST", body: { completed_on: daysAhead(3) } })).status === 400);
  check("hours have to be a sane number",
    (await emp(`/api/compliance/my-training/${dup}/report`, { method: "POST", body: { completed_on: daysAgo(9), hours: 9000 } })).status === 400);
  const notMine = await mkCourse({ title: `Not Theirs ${stamp}`, delivery: "internal" });
  await setRules(notMine, [{ scope: "position", position_group: "bcba", due_days: 10, effective_from: daysAgo(10) }]);
  check("A COURSE NEVER REQUIRED OF THEM CANNOT BE REPORTED AGAINST",
    (await emp(`/api/compliance/my-training/${notMine}/report`, { method: "POST", body: { completed_on: TODAY } })).status === 400);

  // ==================================================================
  section("Optional professional development is offered, not demanded");
  const opt = await mkCourse({ title: `Optional ${stamp}`, delivery: "external_link", external_url: "https://example.com/opt" });
  await setRules(opt, [{ scope: "optional" }]);
  const withOpt = await trainingOf(rbt);
  check("it is listed as optional", (withOpt.optional || []).some((r) => r.course_id === opt));
  check("IT IS NOT IN THE REQUIRED LIST", !(withOpt.required || []).some((r) => r.course_id === opt));
  check("and it does not inflate the count of what is required of them",
    withOpt.summary.total === (withOpt.required || []).length, [withOpt.summary.total, withOpt.required.length]);

  section("A retired course stops being required");
  const gone = await mkCourse({ title: `Retired ${stamp}`, delivery: "internal" });
  await setRules(gone, [{ scope: "all", due_days: 5, effective_from: daysAgo(50) }]);
  check("it is required while it is live", !!rowFor(await trainingOf(rbt), gone));
  await owner(`/api/compliance/courses/${gone}/retire`, { method: "POST", body: { retire: true } });
  check("retiring it drops it out of everybody's training", !rowFor(await trainingOf(rbt), gone));

  section("Completing an older version still counts, and says so");
  const forked = await mkCourse({ title: `Forked ${stamp}`, delivery: "internal" });
  await setRules(forked, [{ scope: "all", effective_from: daysAgo(100) }]);
  await q(`INSERT INTO compliance_completions
    (employee_id, course_id, course_version, completed_on, source, verified_by, verified_at, recorded_by, recorded_at)
    VALUES ($1,$2,1,$3,'recorded','HR',$4,'HR',$4)`, [rbt, forked, daysAgo(20), new Date().toISOString()]);
  await owner(`/api/compliance/courses/${forked}`, { method: "PATCH", body: { delivery: "external_link", external_url: "https://example.com/new" } });
  const forkRow = rowFor(await trainingOf(rbt), forked);
  check("it is still complete after the course forked a version", forkRow.state === "complete", forkRow.state);
  check("BUT IT IS FLAGGED as earned against the earlier version", forkRow.superseded === true,
    [forkRow.earned_version, forkRow.version]);

  // ==================================================================
  section("PERMISSIONS, ENFORCED ON THE BACKEND");
  check("the training-only role CANNOT read the course library",
    (await emp("/api/compliance/courses")).status === 403, (await emp("/api/compliance/courses")).status);
  check("...CANNOT read anybody else's training record",
    (await emp(`/api/compliance/employees/${rbt}/training`)).status === 403);
  check("...CANNOT record training against another employee",
    (await emp(`/api/compliance/employees/${rbt}/completions`, { method: "POST", body: { course_id: everyone, completed_on: TODAY } })).status === 403);
  check("the owner CAN read somebody else's training record",
    (await owner(`/api/compliance/employees/${rbt}/training`)).status === 200);

  const clinical = await login("clinical@spectrumsquadlv.com", "TestStaff123!");
  const clinVerify = await clinical(`/api/compliance/completions/${compId}/verify`, { method: "POST", body: { verified: true } });
  check("CLINICAL LEADERSHIP READS THE PICTURE BUT VERIFIES NOTHING", clinVerify.status === 403, clinVerify.status);

  section("HR can record training it has evidence of, and that is verified in the same step");
  const hrRec = await owner(`/api/compliance/employees/${rbt}/completions`,
    { method: "POST", body: { course_id: everyone, completed_on: daysAgo(2), hours: 3 } });
  check("it is accepted", hrRec.status === 201, [hrRec.status, hrRec.data]);
  check("and it counts immediately, because HR did the checking",
    rowFor(await trainingOf(rbt), everyone).state === "complete");
  check("with HR named on it",
    (await q("SELECT verified_by FROM compliance_completions WHERE employee_id = $1 AND course_id = $2", [rbt, everyone])).rows[0].verified_by !== null);

  section("A login with no employee record is told so, rather than shown an empty list");
  const strayEmail = `zz.stray.${stamp}@example.test`;
  await owner("/api/admin/users", { method: "POST", body: { name: `Zz Stray ${stamp}`, email: strayEmail, password: PW, role: "employee" } });
  const stray = await login(strayEmail, PW);
  const strayRec = (await stray("/api/compliance/my-training")).data;
  check("it says the login is not linked", strayRec.linked === false, strayRec);
  check("...and explains it in words rather than showing nothing",
    /not linked|employee record/i.test(strayRec.message || ""), strayRec.message);

  section("Training hours are NOT billable hours");
  const billable = await q(
    "SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_name = 'billable_entries'").catch(() => ({ rows: [{ n: 0 }] }));
  if (billable.rows[0].n) {
    const touched = await q("SELECT COUNT(*)::int AS n FROM billable_entries WHERE notes ILIKE $1", [`%${stamp}%`]).catch(() => ({ rows: [{ n: 0 }] }));
    check("no billable entry was created by any of this", touched.rows[0].n === 0, touched.rows[0].n);
  } else {
    check("no billable entry was created by any of this (no such table in this build)", true);
  }
  const hoursRec = await trainingOf(rbt);
  check("training hours are reported on their own", typeof hoursRec.summary.training_hours === "number",
    hoursRec.summary.training_hours);

  if (failures.length) { console.log("\n--- failures ---"); failures.forEach((f) => console.log("  " + f)); }
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("Crashed:", e);
  try { await pool.end(); } catch (x) {}
  process.exit(1);
});
