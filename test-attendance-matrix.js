// test-attendance-matrix.js -- the staff attendance points matrix.
//
// The CRM is now the system of record for attendance; the "Attendance Log -
// RBTs" sheet it replaces keyed occurrences to staff by TYPING THEIR NAME and
// warned that names "MUST be identical ... in order for the formula to work".
// They were not, and points went missing silently. The first section below is
// the regression test for that: occurrences are keyed to employee_id, so no
// spelling can drop one.
//
// Point values, ladders and bands are checked against the matrix as
// transcribed from the sheet (policy effective 6/1/2026).
//
//   DATABASE_URL=... node server.js
//   node test-attendance-matrix.js
"use strict";

const BASE = process.env.BASE || "http://localhost:3009";
const OWNER_PW = process.env.OWNER_PASSWORD || "TestOwner123!";
const STAFF_PW = process.env.STAFF_PASSWORD || "TestStaff123!";

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          -> " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : "")); }
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

// N days before today, as YYYY-MM-DD (UTC), matching how the module windows.
const daysAgo = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

(async () => {
  const owner = await login("admin@spectrumsquadlv.com", OWNER_PW);
  const clinical = await login("clinical@spectrumsquadlv.com", STAFF_PW);
  const stamp = Date.now().toString().slice(-6);

  // ============ the matrix is seeded ============
  section("The matrix from the policy is in the CRM");

  let r = await owner("/api/attendance/types");
  check("the matrix loads", r.status === 200, r.data);
  const types = Object.fromEntries((r.data.types || []).map((t) => [t.key, t]));
  check("it is dated to the policy", r.data.effective === "2026-06-01", r.data.effective);

  const expected = {
    late: 0.5, calloff_lt4_nonemergency: 2.0, calloff_lt4_emergency: 1.0, calloff_gt4: 1.0,
    timeoff_post_finalization: 0.5, missed_clock: 0.5, left_early: 2.0, ncns: 5.0, probation_absence: 1.0,
    perfect_30: -1.0, perfect_60: -2.0, picked_up_shift: -1.0, completed_aip: -1.0,
  };
  for (const [key, points] of Object.entries(expected)) {
    check(`${key} is worth ${points}`, types[key] && Number(types[key].points) === points, types[key] && types[key].points);
  }
  check("earn-backs are marked as such",
    ["perfect_30", "perfect_60", "picked_up_shift", "completed_aip"].every((k) => types[k].kind === "earnback"));

  // ============ the name-matching bug the sheet had ============
  section("Occurrences are keyed to the person, not their spelling");

  const emp = await owner("/api/hr/employees", {
    method: "POST",
    body: { name: "Nicolas Linares " + stamp, email: `nico.${stamp}@example.invalid`, role_title: "RBT", status: "active", hire_date: daysAgo(200) },
  });
  const empId = emp.data && (emp.data.id || (emp.data.employee && emp.data.employee.id));
  check("created a staff member", !!empId, emp.data);

  // The two occurrences the sheet lost because the log said "Lineras".
  r = await owner(`/api/attendance/employee/${empId}`, {
    method: "POST",
    body: { type_key: "calloff_lt4_nonemergency", incident_date: daysAgo(20), shift_start: "8:30 AM", time_notified: "5:30 AM", notes: "stomach hurts", notify: false },
  });
  check("a call-off under 4 hours logs", r.status === 201, r.data);
  check("it scored 2.0 from the matrix, not from the request", r.data.points === 2, r.data.points);

  r = await owner(`/api/attendance/employee/${empId}`, {
    method: "POST",
    body: { type_key: "timeoff_post_finalization", incident_date: daysAgo(16), notes: "orientation for other job", notify: false },
  });
  check("a late time-off request logs at 0.5", r.status === 201 && r.data.points === 0.5, r.data);

  r = await owner(`/api/attendance/employee/${empId}`);
  let score = r.data.score;
  check("both occurrences reached this person's total (the sheet showed 0.0)", score.points_30 === 2.5, score.points_30);
  check("the 90-day total agrees", score.points_90 === 2.5, score.points_90);
  check("2.5 in 30 days is an Attendance Improvement Plan", score.review_level === "Attendance Improvement Plan", score.review_level);
  check("2.5 in 90 days is still Good standing", score.discipline_level === "Good standing", score.discipline_level);
  check("notice hours were computed from the times", 
    (r.data.flags || []).some((f) => Number(f.notice_hours) === 3), (r.data.flags || []).map((f) => f.notice_hours));

  // ============ the ladders ============
  section("The disciplinary ladder and the review bands");

  const ladder = await owner("/api/hr/employees", {
    method: "POST", body: { name: "Ladder Test " + stamp, email: `ladder.${stamp}@example.invalid`, role_title: "RBT", status: "active", hire_date: daysAgo(400) },
  });
  const ladderId = ladder.data.id || (ladder.data.employee && ladder.data.employee.id);

  const logAt = async (type_key, day) =>
    owner(`/api/attendance/employee/${ladderId}`, { method: "POST", body: { type_key, incident_date: daysAgo(day), notify: false } });
  const scoreOf = async (id) => (await owner(`/api/attendance/employee/${id}`)).data.score;

  await logAt("left_early", 80);            // 2.0
  await logAt("calloff_gt4", 75);           // 1.0  -> 3.0
  score = await scoreOf(ladderId);
  check("3 points is a Verbal reminder", score.points_90 === 3 && score.discipline_level === "Verbal reminder", score);

  await logAt("left_early", 70);            // -> 5.0
  score = await scoreOf(ladderId);
  check("5 points is a Written warning", score.points_90 === 5 && score.discipline_level === "Written warning", score);
  check("and flags the caseload for review", score.caseload_risk === "Review caseload", score.caseload_risk);

  await logAt("left_early", 65);            // -> 7.0
  score = await scoreOf(ladderId);
  check("7 points is a Final warning or probation", score.discipline_level === "Final warning or probation", score.discipline_level);

  await logAt("left_early", 60);            // -> 9.0
  score = await scoreOf(ladderId);
  check("9 points is a Termination review", score.points_90 === 9 && score.discipline_level === "Termination review", score);

  // None of those fall inside 30 days, so the monthly review reads clean.
  check("none of it lands in the 30-day window", score.points_30 === 0, score.points_30);
  check("so the monthly review reads Exceeds Expectations", score.review_level === "Exceeds Expectations", score.review_level);

  // ============ earn-backs ============
  section("Earning points back");

  r = await owner(`/api/attendance/employee/${ladderId}`, {
    method: "POST", body: { type_key: "picked_up_shift", incident_date: daysAgo(55), notify: false },
  });
  check("picking up a last-minute shift is worth -1", r.data.points === -1, r.data.points);
  score = await scoreOf(ladderId);
  check("it comes off the 90-day total", score.points_90 === 8, score.points_90);
  check("which drops them back to Final warning", score.discipline_level === "Final warning or probation", score.discipline_level);

  // ============ the bonus cycle ============
  section("The 90-day, $50 attendance bonus");

  const clean = await owner("/api/hr/employees", {
    method: "POST", body: { name: "Clean Record " + stamp, email: `clean.${stamp}@example.invalid`, role_title: "RBT", status: "active", hire_date: daysAgo(200) },
  });
  const cleanId = clean.data.id || (clean.data.employee && clean.data.employee.id);
  score = await scoreOf(cleanId);
  check("a clean record past its first cycle is bonus eligible", score.bonus_eligible === true, score);
  check("and says so", /Eligible/i.test(score.bonus_status), score.bonus_status);
  check("with a next bonus date", /^\d{4}-\d{2}-\d{2}$/.test(score.next_bonus_date || ""), score.next_bonus_date);

  const newHire = await owner("/api/hr/employees", {
    method: "POST", body: { name: "New Hire " + stamp, email: `newhire.${stamp}@example.invalid`, role_title: "RBT", status: "active", hire_date: daysAgo(20) },
  });
  const newId = newHire.data.id || (newHire.data.employee && newHire.data.employee.id);
  score = await scoreOf(newId);
  check("someone inside their first 90 days is reported as in progress",
    /first 90-day cycle/i.test(score.bonus_status), score.bonus_status);

  score = await scoreOf(ladderId);
  check("a record with points is not bonus eligible", score.bonus_eligible === false, score);

  // ============ voiding ============
  section("Voiding an occurrence logged in error");

  const flags = (await owner(`/api/attendance/employee/${empId}`)).data.flags;
  const toVoid = flags[0].id;
  r = await owner(`/api/attendance/flag/${toVoid}/void`, { method: "POST", body: {} });
  check("voiding without a reason is refused", r.status === 400, r.data);
  r = await owner(`/api/attendance/flag/${toVoid}/void`, { method: "POST", body: { reason: "Logged against the wrong person" } });
  check("voiding with a reason works", r.status === 200, r.data);

  r = await owner(`/api/attendance/employee/${empId}`);
  const voided = (r.data.flags || []).find((f) => f.id === toVoid);
  check("the occurrence is still on the record", !!voided, "row gone");
  check("marked voided, with the reason", voided.voided === true && /wrong person/.test(voided.voided_reason || ""), voided);
  check("and it stops counting towards points", r.data.score.points_30 < 2.5, r.data.score.points_30);

  // ============ the roster ============
  section("The roster page");

  r = await owner("/api/attendance/roster");
  check("the roster loads", r.status === 200, r.data);
  const roster = Object.fromEntries((r.data.staff || []).map((s) => [s.employee_id, s]));
  check("it covers the staff we created", !!roster[empId] && !!roster[ladderId] && !!roster[cleanId]);
  check("it carries points, level and bonus for each",
    roster[ladderId].points_90 === 8 && roster[ladderId].discipline_level === "Final warning or probation" && roster[ladderId].bonus_eligible === false,
    roster[ladderId]);
  check("the totals count who needs action", typeof r.data.totals.needing_action === "number", r.data.totals);
  check("and who is on track for the bonus", r.data.totals.bonus_eligible >= 1, r.data.totals);

  // ============ permissions ============
  section("Permissions");

  r = await clinical("/api/attendance/roster");
  check("a clinical user cannot read the attendance roster", r.status === 403, r.data);
  r = await clinical("/api/attendance/types", { method: "PUT", body: { types: [{ key: "late", points: 0 }] } });
  check("a clinical user cannot rewrite the matrix", r.status === 403, r.data);

  const anon = await fetch(BASE + "/api/attendance/roster");
  check("signed out, the roster is refused", anon.status === 401, anon.status);

  r = await owner("/api/attendance/types", { method: "PUT", body: { types: [{ key: "late", points: 0.75 }] } });
  check("the owner can change a point value", r.status === 200, r.data);
  r = await owner("/api/attendance/types");
  check("the change stuck", Number((r.data.types.find((t) => t.key === "late") || {}).points) === 0.75);

  r = await owner(`/api/attendance/employee/${cleanId}`, { method: "POST", body: { type_key: "late", incident_date: daysAgo(2), notify: false } });
  check("a new occurrence uses the edited value", r.data.points === 0.75, r.data.points);
  r = await owner("/api/attendance/types", { method: "PUT", body: { types: [{ key: "late", points: 0.5 }] } });
  const after = await owner(`/api/attendance/employee/${cleanId}`);
  check("editing the matrix does not restate occurrences already logged",
    (after.data.flags || []).some((f) => Number(f.points) === 0.75), (after.data.flags || []).map((f) => f.points));

  r = await owner(`/api/attendance/employee/${cleanId}`, { method: "POST", body: { type_key: "not_a_real_type", notify: false } });
  check("an occurrence type outside the matrix is refused", r.status === 400, r.data);

  // ============ the monthly review ============
  section("The automated monthly review");

  await owner("/api/admin/settings", { method: "PATCH", body: { attendance_review_recipients: `hr.${stamp}@example.invalid` } });

  // Put points inside the current 30-day window so there is something to review.
  const reviewee = await owner("/api/hr/employees", {
    method: "POST", body: { name: "Review Me " + stamp, email: `review.${stamp}@example.invalid`, role_title: "RBT", status: "active", hire_date: daysAgo(300) },
  });
  const revId = reviewee.data.id || (reviewee.data.employee && reviewee.data.employee.id);
  await owner(`/api/attendance/employee/${revId}`, { method: "POST", body: { type_key: "left_early", incident_date: daysAgo(5), notify: false } });
  await owner(`/api/attendance/employee/${revId}`, { method: "POST", body: { type_key: "calloff_gt4", incident_date: daysAgo(3), notify: false } });

  score = await scoreOf(revId);
  check("the reviewee is at 3.0 for the period", score.points_30 === 3, score.points_30);
  check("which is an Attendance Improvement Plan", score.review_level === "Attendance Improvement Plan", score.review_level);

  const period = new Date().toISOString().slice(0, 7);
  r = await owner("/api/attendance/monthly-review", { method: "POST", body: { period } });
  check("the monthly review runs", r.status === 200 && r.data.ok, r.data);
  check("it reviewed the roster", r.data.reviewed >= 4, r.data.reviewed);
  check("it emailed staff who had points", r.data.emailed_staff >= 1, r.data);
  check("it emailed the management summary", r.data.emailed_managers === 1, r.data);
  check("a recipient was configured", r.data.no_recipients === false, r.data);

  r = await owner("/api/attendance/monthly-review", { method: "POST", body: { period } });
  check("running it again does not email anyone twice", r.data.emailed_staff === 0 && r.data.skipped_already_sent >= 4, r.data);

  // The staff email and the summary should both be in the outbox.
  const outbox = await owner("/api/notifications");
  const mails = Array.isArray(outbox.data) ? outbox.data : [];
  const staffMail = mails.filter((m) => m.type === "attendance_monthly_review");
  const summaryMail = mails.filter((m) => m.type === "attendance_monthly_summary");
  check("the staff review email is in the outbox", staffMail.length >= 1, mails.map((m) => m.type).slice(0, 8));
  check("it names their level", staffMail.length && /Attendance Improvement Plan/.test(staffMail[0].body || ""), (staffMail[0] || {}).subject);
  check("it explains how to earn points back", staffMail.length && /earned back/i.test(staffMail[0].body || ""));
  check("the management summary is in the outbox", summaryMail.length === 1, summaryMail.map((m) => m.subject));
  check("the summary lists the whole roster", summaryMail.length && /Review Me /.test(summaryMail[0].body || ""));

  r = await clinical("/api/attendance/monthly-review", { method: "POST", body: {} });
  check("a clinical user cannot fire the monthly review", r.status === 403, r.data);

  // ============ emailing on a flag ============
  section("Emailing the staff member when an occurrence is logged");

  r = await owner(`/api/attendance/employee/${revId}`, {
    method: "POST", body: { type_key: "late", incident_date: daysAgo(1), notes: "slept in" },
  });
  check("logging an occurrence emails the staff member", r.data.notified === true, r.data);
  const ob2 = await owner("/api/notifications");
  const occMail = (Array.isArray(ob2.data) ? ob2.data : []).filter((m) => m.type === "attendance_occurrence");
  check("the occurrence email is in the outbox", occMail.length >= 1, occMail.map((m) => m.subject));
  check("it states the points", occMail.length && /\+0\.5/.test(occMail[0].body || ""), (occMail[0] || {}).subject);
  check("and their running total", occMail.length && /rolling 90 days/i.test(occMail[0].body || ""));

  r = await owner(`/api/attendance/employee/${revId}`, {
    method: "POST", body: { type_key: "picked_up_shift", incident_date: daysAgo(1), notify: false },
  });
  check("an earn-back can be logged without emailing", r.data.notified === false, r.data);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\nFATAL:", e); process.exit(2); });
