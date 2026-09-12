// test-attendance-raise-category.js -- Attendance as a live raise category.
//
// Attendance is measured in POINTS, where fewer is better, and the policy
// describes outcomes as named bands rather than scores. Wiring it into a raise
// therefore had one dangerous shortcut available: invent a points-to-
// percentage curve. Nobody would have chosen that curve, and it would decide
// what people are paid.
//
// What it does instead is count the SHARE OF MONTHS in the review period that
// came in at a band the policy already calls acceptable -- the same shape as
// Supervision Compliance, which counts months meeting the BACB minimum. This
// suite exists to hold that rule down, and in particular the three judgements
// inside it that are easy to get quietly wrong:
//
//   1. A month with no infractions is a GOOD month, not a missing one. Zero
//      points is Exceeds Expectations, which is a fact about somebody's
//      attendance rather than an absence of data.
//   2. A month somebody was not employed for is not theirs. Months before the
//      hire date and after the leaving date are left out of both halves of
//      the fraction, not counted as failures.
//   3. Nothing to judge is null, never zero. "We have no attendance data" and
//      "their attendance is 0%" are different statements about a person and
//      only one of them would be true.
//
//   DATABASE_URL=... PORT=3011 node server.js
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-attendance-raise-category.js
"use strict";
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const OWNER_PW = process.env.OWNER_PASSWORD || "TestOwner123!";

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else {
    fail++;
    const d = detail === undefined ? "" : "\n          -> " +
      String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400);
    console.log("  FAIL  " + name + d);
  }
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

// A fixed window in the past, so the figures in this file do not move with the
// calendar. Twelve whole months.
const START = "2025-01-01";
const END = "2025-12-31";
const stamp = Date.now();

(async () => {
  const owner = client();
  check("owner signs in",
    (await owner("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: OWNER_PW } })).status === 200);

  async function staff(name, hireDate, terminationDate) {
    const r = await owner("/api/hr/employees", {
      method: "POST",
      body: { name, email: `${name.replace(/\W+/g, "").toLowerCase()}@example.com`, role_title: "RBT", hire_date: hireDate },
    });
    const id = r.data.id;
    await owner(`/api/fidelity/employee/${id}/pay`, { method: "PUT", body: { hourly_rate: 22 } });
    if (terminationDate) {
      await pool.query("UPDATE hr_employees SET termination_date = $1 WHERE id = $2", [terminationDate, id]);
    }
    return id;
  }
  // "late" is worth 0.5 on the matrix; two in a month clears the 1.5 threshold
  // for Coaching Conversation only when paired with something heavier, so the
  // bad months here use a no-call/no-show, which is unambiguous.
  const flag = (id, date, typeKey) => owner(`/api/attendance/employee/${id}`, {
    method: "POST", body: { type_key: typeKey, incident_date: date, notes: "seeded by test" },
  });

  const raiseFor = (id) => owner(`/api/fidelity/raise/${id}?period_start=${START}&period_end=${END}`);
  // The route spreads the computed raise across the top level of the response.
  const attendanceOf = (r) => (r.data && (r.data.components || []).find((p) => p.key === "attendance")) || null;
  const missingOf = (r) => (r.data && r.data.missing_components) || [];

  // Attendance carries the whole score, so the percentage under test is the
  // performance score and nothing else can mask it.
  const weighted = await owner("/api/fidelity/settings", { method: "PUT", body: { weights: { attendance: 100 } } });
  check("Attendance can be weighted at all — it used to be refused as not available",
    weighted.status === 200, weighted.data);
  const settings = await owner("/api/fidelity/settings");
  const cat = (settings.data.categories || []).find((c) => c.key === "attendance");
  check("the settings screen now offers it as a live category", cat && cat.live === true, cat);
  check("...and says where the number comes from",
    cat && /share of months/i.test(cat.source || ""), cat && cat.source);

  // =========================================================================
  section("Ten good months out of twelve");
  const a = await staff(`ZzAtt Steady ${stamp}`, "2024-06-01");
  await flag(a, "2025-03-11", "ncns");    // March: a no-call/no-show
  await flag(a, "2025-08-14", "ncns");    // August: another
  const ra = await raiseFor(a);
  check("the raise loads", ra.status === 200, ra.data);
  const pa = attendanceOf(ra);
  check("Attendance is scored from the months, not from the points",
    pa && pa.value === 83.3, pa);
  check("...as ten of twelve months at an acceptable band",
    pa && /10 of 12 month/.test(pa.detail || ""), pa && pa.detail);
  check("...naming the bands the policy calls acceptable, rather than a number nobody chose",
    pa && /Meets Expectations or Exceeds Expectations/.test(pa.detail || ""), pa && pa.detail);
  check("the performance score is the attendance figure, since it carries all the weight",
    ra.data.performance_score === 83.3, ra.data.performance_score);
  check("83.3% lands in the 80–84.99% band, which is a 2% raise",
    ra.data.recommended_percent === 2, ra.data);
  check("2% of $22.00 is $0.44 an hour", ra.data.recommended_increase === 0.44, ra.data.recommended_increase);

  // =========================================================================
  section("A quiet month is a good month, not a missing one");
  const b = await staff(`ZzAtt Spotless ${stamp}`, "2024-06-01");
  const rb = await raiseFor(b);
  const pb = attendanceOf(rb);
  check("somebody with no infractions at all scores 100%", pb && pb.value === 100, pb);
  check("...counted across all twelve months rather than none of them",
    pb && /12 of 12 month/.test(pb.detail || ""), pb && pb.detail);
  check("...and is not reported as missing data", !missingOf(rb).some((m) => m.key === "attendance"), missingOf(rb));

  // =========================================================================
  section("Months somebody was not employed for are not theirs");
  const c = await staff(`ZzAtt Midyear ${stamp}`, "2025-07-01");
  await flag(c, "2025-09-09", "ncns");    // one bad month out of the six they were here
  const rc = await raiseFor(c);
  const pc = attendanceOf(rc);
  check("a mid-year hire is judged on the months they were here",
    pc && /5 of 6 month/.test(pc.detail || ""), pc && pc.detail);
  check("...which is 83.3%, not 41.7% — the six months before they arrived are not failures",
    pc && pc.value === 83.3, pc);
  check("...and the excluded months are said out loud",
    pc && /6 further months were left out because they were not employed/.test(pc.detail || ""), pc && pc.detail);

  const d = await staff(`ZzAtt Leaver ${stamp}`, "2024-06-01", "2025-04-30");
  await flag(d, "2025-02-02", "ncns");
  const rd = await raiseFor(d);
  const pd = attendanceOf(rd);
  check("somebody who left part way through is judged on the months up to then",
    pd && /3 of 4 month/.test(pd.detail || ""), pd && pd.detail);

  // =========================================================================
  section("Nothing to judge is nothing, not zero");
  const e = await staff(`ZzAtt Newcomer ${stamp}`, "2026-03-01");
  const re = await raiseFor(e);
  check("somebody hired after the review period has no attendance figure",
    attendanceOf(re) === null, attendanceOf(re));
  check("...and is reported as missing rather than scored 0%",
    missingOf(re).some((m) => m.key === "attendance"), missingOf(re));
  check("...so the raise does not recommend a figure built on a fabricated zero",
    re.data.performance_score === null, re.data.performance_score);

  // =========================================================================
  section("The threshold is the policy's, and it is not read twice");
  const f = await staff(`ZzAtt Coaching ${stamp}`, "2024-06-01");
  // 1.5 points in one month is EXACTLY Coaching Conversation: the first band
  // the policy does not call acceptable. Three late arrivals at 0.5 each land
  // on that line precisely, which is the point -- a bad month built out of a
  // no-call/no-show would sail past the line and would not notice if the line
  // moved.
  await flag(f, "2025-05-05", "late");
  await flag(f, "2025-05-12", "late");
  await flag(f, "2025-05-19", "late");           // 1.5 -> Coaching Conversation, exactly
  const g = await staff(`ZzAtt Borderline ${stamp}`, "2024-06-01");
  await flag(g, "2025-05-05", "late");           // 0.5 -> Meets Expectations
  const pf = attendanceOf(await raiseFor(f));
  const pg = attendanceOf(await raiseFor(g));
  check("a month that reaches Coaching Conversation does not count as acceptable",
    pf && /11 of 12 month/.test(pf.detail || ""), pf && pf.detail);
  // The roster's own band is a rolling 30-day figure as of today, so it cannot
  // answer a question about May last year. What it can confirm is the points,
  // and 1.5 is the Coaching Conversation line exactly -- which is what makes
  // the check above a test of the line rather than of a month miles past it.
  const mayPoints = (await owner(`/api/attendance/employee/${f}`)).data.flags
    .filter((x) => String(x.incident_date || "").slice(0, 7) === "2025-05")
    .reduce((a, x) => a + Number(x.points), 0);
  check("...and that month sits exactly on the line, not miles past it", mayPoints === 1.5, mayPoints);
  check("a month that stays at Meets Expectations does",
    pg && /12 of 12 month/.test(pg.detail || ""), pg && pg.detail);

  const types = await owner("/api/attendance/types");
  const late = (types.data.types || []).find((t) => t.key === "late");
  check("and the points those bands are judged on still come from the matrix, not this test",
    late && Number(late.points) === 0.5, late);

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end().catch(() => {});
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
