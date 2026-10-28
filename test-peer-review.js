// Peer Performance Consensus Report: everyone rates their coworkers, and each
// person gets back one combined report, once.
//
// What is held to account here:
//
//   * THE ARITHMETIC. The spec's worked example -- five competency averages
//     giving 4.36 overall -- comes out exactly, N/A is not a rating, and a
//     competency rated by fewer than three people is withheld from the
//     employee and left out of their overall.
//   * ONE SECTION PER PERSON. The schema refuses a second one.
//   * NOBODY RATES THEMSELVES, and a rating below 3 needs a reason.
//   * NOTHING IDENTIFYING LEAVES THE MODULE: no route returns a single rating
//     or says who wrote a comment, and a comment is shown to its subject only
//     after a person approves it.
//   * LEADERSHIP ARE STAFF TOO. Whoever runs the cycle cannot read or approve
//     their own report.
//   * ONE EMAIL PER EMPLOYEE PER CYCLE, however many times Send is pressed; a
//     resend is the same report, not a new score.
//   * The Message Outbox does not show anyone's scores or private links.
//
//   DATABASE_URL=... PORT=3011 node server.js
//   BASE=http://127.0.0.1:3011 node test-peer-review.js
"use strict";
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");

function client() {
  let cookie = "";
  return async (p, { method = "GET", body } = {}) => {
    const r = await fetch(BASE + p, { method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  };
}
const anon = client();
const q1 = async (sql, args) => (await pool.query(sql, args)).rows[0];

(async () => {
  // ==================================================================
  section("The arithmetic, against the spec's worked example");
  const { _internal } = require("./peer-review")({ dbGet: () => {}, dbAll: () => {}, dbRun: () => {}, crypto: require("crypto") });
  // Twenty ratings per competency, built to land on the example's averages.
  const make = (key, avg) => {
    const total = Math.round(avg * 20);
    const out = [];
    for (let i = 0; i < 20; i++) out.push({ competency: key, rating: i < total - 80 ? 5 : 4 });
    return out;
  };
  const ex = _internal.score("admin", [
    ...make("leads_by_example", 4.40), ...make("problem_solves", 4.20),
    ...make("demonstrates_professionalism", 4.60), ...make("approachability_accountability", 4.10),
    ...make("professionalism_tone", 4.50),
  ]);
  check("the five competency averages come out as in the example",
    JSON.stringify(ex.competencies.map((c) => c.avg)) === JSON.stringify([4.4, 4.2, 4.6, 4.1, 4.5]), ex.competencies.map((c) => c.avg));
  check("OVERALL IS THE MEAN OF THE COMPETENCY MEANS: 4.36", ex.overall === 4.36, ex.overall);

  const thin = _internal.score("squad_leader", [
    { competency: "clinical_guidance", rating: 5 }, { competency: "clinical_guidance", rating: 1 },
    { competency: "open_feedback", rating: 4 }, { competency: "open_feedback", rating: 4 }, { competency: "open_feedback", rating: 5 },
  ]);
  const cg = thin.competencies.find((c) => c.key === "clinical_guidance");
  check("a competency rated by two people is WITHHELD from the employee", cg.withheld === true && cg.n === 2, cg);
  check("...and left out of the overall the employee sees", thin.overall === 4.33, thin.overall);
  check("...while leadership's figure still counts it", thin.overall_all === 3.67, thin.overall_all);
  check("a 5 and a 1 on the same question is flagged DIVIDED", cg.divided === true, cg);
  check("a competency nobody rated has no average, not zero",
    thin.competencies.find((c) => c.key === "approachable").avg === null);
  check("the three sections have 7, 4 and 5 questions, as on the paper survey",
    [_internal.SECTIONS.rbt, _internal.SECTIONS.squad_leader, _internal.SECTIONS.admin].map((s) => s.competencies.length).join() === "7,4,5");
  check("BCBAs who are not administration have their own section of 6 questions",
    _internal.SECTIONS.bcba && _internal.SECTIONS.bcba.label === "BCBA" && _internal.SECTIONS.bcba.competencies.length === 6);
  check("...and every competency key is unique across sections, since ratings are stored by key",
    (() => { const ks = Object.values(_internal.SECTIONS).flatMap((s) => s.competencies.map((c) => c.key)); return new Set(ks).size === ks.length; })());
  check("a BCBA job title suggests the BCBA section",
    _internal.suggestSection("BCBA") === "bcba" && _internal.suggestSection("Board Certified Behavior Analyst") === "bcba");
  check("...but a Clinical Director who is a BCBA stays Administration",
    _internal.suggestSection("Clinical Director, BCBA") === "admin");
  check("...and an RBT is still an RBT", _internal.suggestSection("RBT") === "rbt");
  check("Administration asks about Professionalism & Tone, not Teamwork",
    _internal.SECTIONS.admin.competencies.some((c) => c.label === "Professionalism & Tone") &&
    !_internal.SECTIONS.admin.competencies.some((c) => /teamwork/i.test(c.label)));

  // ==================================================================
  section("Setting up");
  const owner = client(), lead = client(), other = client();
  check("owner signs in", (await owner("/api/auth/login", { method: "POST",
    body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);
  await lead("/api/auth/login", { method: "POST", body: { email: "clinical@spectrumsquadlv.com", password: "TestStaff123!" } });
  await other("/api/auth/login", { method: "POST", body: { email: "billing@spectrumsquadlv.com", password: "TestStaff123!" } });

  const ownerUser = await q1("SELECT id FROM users WHERE email = 'admin@spectrumsquadlv.com'");
  const leadUser = await q1("SELECT id FROM users WHERE email = 'clinical@spectrumsquadlv.com'");
  // The staff roster, in the HR Hub. The owner is on it too.
  const mk = async (name, title, email, userId) => (await q1(
    `INSERT INTO hr_employees (name, role_title, email, user_id, status, created_at) VALUES ($1, $2, $3, $4, 'active', now()::text) RETURNING id`,
    [name, title, email, userId || null])).id;
  const E = {
    quiana: await mk("Quiana Owner", "Owner", "admin@spectrumsquadlv.com", ownerUser.id),
    marissa: await mk("Marissa Admin", "Office Manager", "marissa@example.com"),
    stephanie: await mk("Stephanie Lead", "Squad Leader", "stephanie@example.com"),
    martha: await mk("Martha RBT", "RBT", "martha@example.com"),
    mark: await mk("Mark RBT", "Registered Behavior Technician", "mark@example.com"),
    lana: await mk("Lana RBT", "RBT", "lana@example.com"),
    eugene: await mk("Eugene RBT", "RBT", null),
  };

  check("PEER REVIEWS ARE A NAMED GRANT: an admin-tier account without it is refused",
    (await other("/api/peer-review/cycles")).status === 403);
  check("...and so is the clinical account, before it is granted", (await lead("/api/peer-review/cycles")).status === 403);
  check("nobody signed out gets in", (await anon("/api/peer-review/cycles")).status === 401);

  const cyc = await owner("/api/peer-review/cycles", { method: "POST", body: { name: "Q3 2026", closes_on: "2026-11-15" } });
  check("the owner can start a cycle", cyc.status === 201 && cyc.data.status === "draft", cyc.data);
  const C = cyc.data.id;

  const roster = await owner(`/api/peer-review/cycles/${C}/roster`);
  const sug = (id) => roster.data.roster.find((r) => r.employee_id === id).suggested;
  check("job titles suggest a section: Squad Leader, RBT, Administration",
    sug(E.stephanie) === "squad_leader" && sug(E.mark) === "rbt" && sug(E.marissa) === "admin", roster.data.roster);

  check("THE SAME PERSON TWICE IN ONE SAVE IS REFUSED",
    (await owner(`/api/peer-review/cycles/${C}/assignments`, { method: "PUT", body: { assignments: [
      { employee_id: E.mark, section: "rbt" }, { employee_id: E.mark, section: "squad_leader" }] } })).status === 400);
  check("an unknown section is refused",
    (await owner(`/api/peer-review/cycles/${C}/assignments`, { method: "PUT", body: { assignments: [{ employee_id: E.mark, section: "not_a_section" }] } })).status === 400);
  check("someone can be put in the BCBA section",
    (await owner(`/api/peer-review/cycles/${C}/assignments`, { method: "PUT", body: { assignments: [{ employee_id: E.mark, section: "bcba" }] } })).status === 200);

  const assign = await owner(`/api/peer-review/cycles/${C}/assignments`, { method: "PUT", body: { assignments: [
    { employee_id: E.quiana, section: "admin" }, { employee_id: E.marissa, section: "admin" },
    { employee_id: E.stephanie, section: "rbt" }, { employee_id: E.martha, section: "rbt" },
    { employee_id: E.mark, section: "rbt" }, { employee_id: E.lana, section: "rbt" }, { employee_id: E.eugene, section: "rbt" }] } });
  check("sections are saved", assign.status === 200 && assign.data.roster_count === 7, assign.data);
  await owner(`/api/peer-review/cycles/${C}/assignments`, { method: "PUT", body: { assignments: [{ employee_id: E.stephanie, section: "squad_leader" }] } });
  const st = await q1("SELECT count(*) AS n, max(section) AS s FROM peer_review_assignments WHERE cycle_id = $1 AND employee_id = $2", [C, E.stephanie]);
  check("MOVING SOMEONE REPLACES THEIR SECTION -- still one row, now Squad Leader", Number(st.n) === 1 && st.s === "squad_leader", st);
  let dup = null;
  try { await pool.query("INSERT INTO peer_review_assignments (cycle_id, employee_id, section) VALUES ($1, $2, 'admin')", [C, E.stephanie]); }
  catch (e) { dup = e.code; }
  check("the database itself refuses a second section for the same person", dup === "23505", dup);

  // ==================================================================
  section("Opening the survey");
  const op = await owner(`/api/peer-review/cycles/${C}/open`, { method: "POST" });
  check("opening sends a link to everyone with an email", op.status === 200 && op.data.invited === 6, op.data);
  check("...and names who has no email", JSON.stringify(op.data.missing_email) === JSON.stringify(["Eugene RBT"]), op.data.missing_email);
  const again = await owner(`/api/peer-review/cycles/${C}/invite`, { method: "POST" });
  check("pressing it again emails nobody twice", again.data.invited === 0, again.data);
  check("once open, an existing person's section can't be changed",
    (await owner(`/api/peer-review/cycles/${C}/assignments`, { method: "PUT", body: { assignments: [{ employee_id: E.mark, section: "admin" }] } })).status === 409);

  const tok = async (id) => (await q1("SELECT token FROM peer_review_reviewers WHERE cycle_id = $1 AND employee_id = $2", [C, id])).token;
  const T = {};
  for (const k of Object.keys(E)) T[k] = await tok(E[k]);
  const invite = await q1("SELECT body FROM notifications_log WHERE type = 'peer_review_invite' AND recipient = 'mark@example.com'");
  check("the invite carries Mark's own private link", invite && invite.body.includes("/peer-review/" + T.mark));

  const survey = await anon("/api/peer-review/public/survey?token=" + encodeURIComponent(T.mark));
  check("the survey opens from the link, with no login", survey.status === 200, survey.data);
  const shown = survey.data.sections.flatMap((s) => s.people.map((p) => p.id));
  check("NOBODY IS SHOWN THEMSELVES to rate", !shown.includes(E.mark) && shown.length === 6, shown);
  check("each person appears in their one section",
    survey.data.sections.find((s) => s.key === "squad_leader").people.map((p) => p.id).join() === String(E.stephanie));
  check("a made-up link opens nothing", (await anon("/api/peer-review/public/survey?token=nottherealtokenatall0000")).status === 404);

  const submit = (who, ratings, comments) => anon("/api/peer-review/public/survey", { method: "POST",
    body: { token: T[who], ratings, comments: comments || [] } });
  const R = (subject, competency, rating) => ({ subject_employee_id: E[subject], competency, rating });

  check("rating yourself is refused", (await submit("mark", [R("mark", "punctuality", 5)])).status === 400);
  check("a question from the wrong section is refused", (await submit("mark", [R("marissa", "punctuality", 5)])).status === 400);
  check("a rating of 6 is refused", (await submit("mark", [R("martha", "punctuality", 6)])).status === 400);
  const noWhy = await submit("mark", [R("martha", "punctuality", 2)]);
  check("A RATING BELOW 3 WITHOUT A REASON IS REFUSED, and says whose and which", noWhy.status === 400 && /Martha RBT/.test(noWhy.data.error) && /Punctuality/.test(noWhy.data.error), noWhy.data);

  // ==================================================================
  section("Everyone fills it in");
  // Marissa: rated by five people, so all five Administration questions show.
  const adminSet = (l, p, d, a, t) => [R("marissa", "leads_by_example", l), R("marissa", "problem_solves", p),
    R("marissa", "demonstrates_professionalism", d), R("marissa", "approachability_accountability", a), R("marissa", "professionalism_tone", t)];
  const okMark = await submit("mark", [...adminSet(5, 4, 5, 4, 5), R("martha", "punctuality", 2), R("stephanie", "clinical_guidance", 5)],
    [{ subject_employee_id: E.martha, kind: "below3", competency: "punctuality", body: "Late to three sessions in September at the Henderson clinic." },
     { subject_employee_id: E.marissa, kind: "shoutout", body: "Marissa sorted my schedule out in a day." },
     { subject_employee_id: null, kind: "additional", body: "The break room needs a second fridge." }]);
  check("a complete survey is accepted", okMark.status === 200, okMark.data);
  await submit("martha", [...adminSet(4, 4, 5, 4, 4), R("stephanie", "clinical_guidance", 4)],
    [{ subject_employee_id: E.marissa, kind: "additional", body: "Could reply to texts faster." }]);
  await submit("lana", [...adminSet(5, 5, 5, 4, 4), R("stephanie", "clinical_guidance", 1)],
    [{ subject_employee_id: E.stephanie, kind: "below3", competency: "clinical_guidance", body: "Gave conflicting instructions." }]);
  await submit("stephanie", adminSet(4, 4, 4, 5, 5));
  await submit("quiana", [...adminSet(4, 4, 4, 4, 5), R("mark", "punctuality", 5), R("mark", "cleanliness", 4), R("mark", "remains_professional", 5)]);
  // Marissa rates the owner, so there is something about the owner to withhold.
  await submit("marissa", [R("quiana", "leads_by_example", 5)],
    [{ subject_employee_id: E.quiana, kind: "shoutout", body: "Always there when it counts." }]);

  const resub = await submit("mark", [...adminSet(5, 4, 5, 4, 5), R("martha", "punctuality", 2), R("stephanie", "clinical_guidance", 5)],
    [{ subject_employee_id: E.martha, kind: "below3", competency: "punctuality", body: "Late to three sessions in September at the Henderson clinic." },
     { subject_employee_id: E.marissa, kind: "shoutout", body: "Marissa sorted my schedule out in a day." },
     { subject_employee_id: null, kind: "additional", body: "The break room needs a second fridge." }]);
  check("submitting again REPLACES the earlier answers rather than adding to them", resub.status === 200 &&
    Number((await q1("SELECT count(*) AS n FROM peer_review_ratings WHERE cycle_id = $1 AND reviewer_employee_id = $2", [C, E.mark])).n) === 7);
  const back = await anon("/api/peer-review/public/survey?token=" + encodeURIComponent(T.mark));
  check("coming back to the link shows your own answers to edit", back.data.answers.ratings.length === 7 && !!back.data.submitted_at);

  const live = await owner(`/api/peer-review/cycles/${C}`);
  check("leadership can see who has and hasn't submitted", live.data.progress.submitted === 6 && live.data.progress.assigned === 7, live.data.progress);
  const firstComment = await q1("SELECT id FROM peer_review_comments WHERE cycle_id = $1 LIMIT 1", [C]);
  check("comments can't be approved while the survey is still open",
    (await owner(`/api/peer-review/comments/${firstComment.id}`, { method: "POST", body: { decision: "approve" } })).status === 409);

  const rem = await owner(`/api/peer-review/cycles/${C}/remind`, { method: "POST" });
  check("a reminder goes only to people with a link who haven't submitted", rem.data.reminded === 0, rem.data);

  // ==================================================================
  section("Closing and scoring");
  const closed = await owner(`/api/peer-review/cycles/${C}/close`, { method: "POST" });
  check("closing calculates a report for every person", closed.status === 200 &&
    Number((await q1("SELECT count(*) AS n FROM peer_review_results WHERE cycle_id = $1", [C])).n) === 7, closed.data);
  check("after close the survey can't be changed",
    (await submit("lana", adminSet(1, 1, 1, 1, 1))).status === 409);

  const mar = closed.data.people.find((p) => p.employee_id === E.marissa);
  const lp = mar.result.competencies.find((c) => c.key === "leads_by_example");
  check("Marissa's Leads by Example combines all five ratings: 4.40", lp.avg === 4.4 && lp.n === 5, lp);
  check("her overall is the mean of her five competency means: 4.40", mar.result.overall === 4.4, mar.result.overall);
  check("leadership sees how many people rated her", mar.result.reviewer_count === 5, mar.result.reviewer_count);
  check("leadership sees the spread", lp.min === 4 && lp.max === 5, lp);

  const steph = closed.data.people.find((p) => p.employee_id === E.stephanie);
  const sg = steph.result.competencies.find((c) => c.key === "clinical_guidance");
  check("Stephanie's 5, 4 and 1 are flagged as DIVIDED for leadership", sg.divided === true && sg.n === 3, sg);
  const mk2 = closed.data.people.find((p) => p.employee_id === E.mark);
  check("Mark, rated on each question by one person, has every score withheld from him",
    mk2.result.competencies.every((c) => c.withheld) && mk2.result.overall === null, mk2.result);

  const blob = JSON.stringify(closed.data);
  check("NO SINGLE RATING AND NO REVIEWER IS IN ANYTHING LEADERSHIP IS SENT",
    !/reviewer_employee_id/.test(blob) && !/"rating"/.test(blob), blob.slice(0, 200));
  check("general comments go to leadership and to nobody's report",
    closed.data.general_comments.length === 1 && /fridge/.test(closed.data.general_comments[0].body));

  // ==================================================================
  section("Leadership are staff too");
  const me = closed.data.people.find((p) => p.employee_id === E.quiana);
  check("THE OWNER'S OWN SCORES ARE WITHHELD FROM HER on this screen",
    me.is_self && me.result.withheld_from_you && !me.result.competencies && me.comments.length === 0, me);
  const myRes = await q1("SELECT id FROM peer_review_results WHERE cycle_id = $1 AND employee_id = $2", [C, E.quiana]);
  check("...and she cannot approve her own report", (await owner(`/api/peer-review/results/${myRes.id}/approve`, { method: "POST" })).status === 403);
  const aboutMe = await q1("SELECT id FROM peer_review_comments WHERE cycle_id = $1 AND subject_employee_id = $2", [C, E.quiana]);
  check("...nor review the comments about her", (await owner(`/api/peer-review/comments/${aboutMe.id}`, { method: "POST", body: { decision: "approve" } })).status === 403);

  check("an approver must have access to Peer Reviews",
    (await owner(`/api/peer-review/cycles/${C}/approver`, { method: "PUT", body: { employee_id: E.quiana, approver_user_id: leadUser.id } })).status === 400);
  await pool.query(`UPDATE users SET module_access = '{"peer-review":true}' WHERE id = $1`, [leadUser.id]);
  check("once granted, the clinical account can open Peer Reviews", (await lead("/api/peer-review/cycles")).status === 200);
  check("the owner names someone else to approve her report",
    (await owner(`/api/peer-review/cycles/${C}/approver`, { method: "PUT", body: { employee_id: E.quiana, approver_user_id: leadUser.id } })).status === 200);

  const asLead = await lead(`/api/peer-review/cycles/${C}`);
  const marForLead = asLead.data.people.find((p) => p.employee_id === E.marissa);
  check("ADMINISTRATION REPORTS DEFAULT TO THE OWNER: a granted manager can't approve Marissa's", marForLead.can_approve === false);
  const sForLead = asLead.data.people.find((p) => p.employee_id === E.stephanie);
  check("...but can approve a Squad Leader's", sForLead.can_approve === true);

  // ==================================================================
  section("Reviewing comments and approving");
  const marRes = mar.result.id;
  const blocked = await owner(`/api/peer-review/results/${marRes}/approve`, { method: "POST" });
  check("A REPORT WITH UNREVIEWED COMMENTS CAN'T BE APPROVED", blocked.status === 409, blocked.data);
  const shout = mar.comments.find((c) => c.kind === "shoutout");
  const slow = mar.comments.find((c) => c.kind === "additional");
  check("a comment is labelled by kind, not by who wrote it", shout.kind_label === "Strengths & Positive Recognition" && !("reviewer" in shout));
  await owner(`/api/peer-review/comments/${shout.id}`, { method: "POST", body: { decision: "approve", body: "Sorted out a schedule problem in a day." } });
  await owner(`/api/peer-review/comments/${slow.id}`, { method: "POST", body: { decision: "reject" } });
  check("approved once every comment is reviewed", (await owner(`/api/peer-review/results/${marRes}/approve`, { method: "POST" })).status === 200);
  const sComment = steph.comments[0];
  await lead(`/api/peer-review/comments/${sComment.id}`, { method: "POST", body: { decision: "approve" } });
  check("the granted manager approves Stephanie's report", (await lead(`/api/peer-review/results/${steph.result.id}/approve`, { method: "POST" })).status === 200);
  await lead(`/api/peer-review/comments/${aboutMe.id}`, { method: "POST", body: { decision: "approve" } });
  check("...and the owner's, as her named approver", (await lead(`/api/peer-review/results/${myRes.id}/approve`, { method: "POST" })).status === 200);
  check("comments on an approved report are final",
    (await owner(`/api/peer-review/comments/${shout.id}`, { method: "POST", body: { decision: "reject" } })).status === 409);

  const marTok = (await q1("SELECT report_token FROM peer_review_results WHERE id = $1", [marRes])).report_token;
  const marthaRes = await q1("SELECT id, report_token FROM peer_review_results WHERE cycle_id = $1 AND employee_id = $2", [C, E.martha]);
  check("AN UNAPPROVED REPORT CAN'T BE OPENED, even with its link",
    (await anon("/api/peer-review/public/report?token=" + encodeURIComponent(marthaRes.report_token))).status === 404);

  // ==================================================================
  section("One email per person");
  const sent = await owner(`/api/peer-review/cycles/${C}/send`, { method: "POST" });
  check("Send emails every approved report", sent.status === 200 && sent.data.sent === 3, sent.data);
  const sent2 = await owner(`/api/peer-review/cycles/${C}/send`, { method: "POST" });
  check("PRESSING SEND AGAIN SENDS NOTHING", sent2.data.sent === 0, sent2.data);
  const mails = await pool.query("SELECT body FROM notifications_log WHERE type = 'peer_review_results' AND recipient = 'marissa@example.com'");
  check("Marissa has exactly one results email", mails.rows.length === 1, mails.rows.length);
  check("it has her overall, and her full-report link", /4\.40 \/ 5\.00/.test(mails.rows[0].body) && mails.rows[0].body.includes("/peer-results/" + marTok));

  const rs = await owner(`/api/peer-review/results/${marRes}/resend`, { method: "POST" });
  check("a resend goes out", rs.status === 200, rs.data);
  const after = await q1("SELECT overall, report_token, resend_count FROM peer_review_results WHERE id = $1", [marRes]);
  check("...WITH THE SAME SCORE AND THE SAME LINK, nothing recalculated",
    after.overall === 4.4 && after.report_token === marTok && after.resend_count === 1, after);
  check("the owner can't resend her own report", (await owner(`/api/peer-review/results/${myRes.id}/resend`, { method: "POST" })).status === 403);

  // ==================================================================
  section("What Marissa sees");
  const rep = await anon("/api/peer-review/public/report?token=" + encodeURIComponent(marTok));
  check("her report opens from the link, with no login", rep.status === 200, rep.data);
  check("one overall and five competency averages", rep.data.overall === 4.4 && rep.data.competencies.length === 5);
  check("NO REVIEWER COUNT AND NO SPREAD", !JSON.stringify(rep.data).match(/reviewer_count|"min"|"max"|"n":/));
  const strengths = rep.data.feedback.find((f) => f.kind === "shoutout").items;
  check("she sees the comment as leadership edited it", JSON.stringify(strengths) === JSON.stringify(["Sorted out a schedule problem in a day."]), strengths);
  check("the comment leadership chose not to show is not there", !JSON.stringify(rep.data).includes("texts faster"));
  check("the general comment is not in her report", !JSON.stringify(rep.data).includes("fridge"));
  check("first review: no previous score yet", rep.data.previous === null && rep.data.history.length === 1);

  // ==================================================================
  section("The Message Outbox does not show what anyone scored");
  const outbox = await owner("/api/notifications");
  const shownMail = outbox.data.find((n) => n.type === "peer_review_results" && n.recipient === "marissa@example.com");
  check("the results email's scores are withheld in the outbox", shownMail && !/4\.40 \//.test(shownMail.body) && /\[withheld\]/.test(shownMail.body), shownMail && shownMail.body.slice(0, 300));
  check("...and so is her private report link", shownMail && !shownMail.body.includes(marTok) && /peer-results\/\[link removed\]/.test(shownMail.body));
  const inv = outbox.data.find((n) => n.type === "peer_review_invite");
  check("survey links are removed from the outbox too", inv && /peer-review\/\[link removed\]/.test(inv.body));

  // ==================================================================
  section("The next cycle shows the trend");
  const c2 = (await owner("/api/peer-review/cycles", { method: "POST", body: { name: "Q4 2026" } })).data.id;
  await owner(`/api/peer-review/cycles/${c2}/assignments`, { method: "PUT", body: { assignments: [
    { employee_id: E.marissa, section: "admin" }, { employee_id: E.mark, section: "rbt" }, { employee_id: E.martha, section: "rbt" }, { employee_id: E.lana, section: "rbt" }] } });
  await owner(`/api/peer-review/cycles/${c2}/open`, { method: "POST" });
  for (const who of ["mark", "martha", "lana"]) {
    const t = (await q1("SELECT token FROM peer_review_reviewers WHERE cycle_id = $1 AND employee_id = $2", [c2, E[who]])).token;
    await anon("/api/peer-review/public/survey", { method: "POST", body: { token: t, ratings: [
      R("marissa", "leads_by_example", 5), R("marissa", "problem_solves", 5), R("marissa", "demonstrates_professionalism", 5),
      R("marissa", "approachability_accountability", 5), R("marissa", "professionalism_tone", 4)] } });
  }
  await owner(`/api/peer-review/cycles/${c2}/close`, { method: "POST" });
  const r2 = await q1("SELECT id, report_token FROM peer_review_results WHERE cycle_id = $1 AND employee_id = $2", [c2, E.marissa]);
  await owner(`/api/peer-review/results/${r2.id}/approve`, { method: "POST" });
  const rep2 = await anon("/api/peer-review/public/report?token=" + encodeURIComponent(r2.report_token));
  check("the new report names her previous score", rep2.data.previous && rep2.data.previous.overall === 4.4, rep2.data.previous);
  check("...and the change: +0.40", rep2.data.change === 0.4, rep2.data.change);
  check("her history has one score per cycle", JSON.stringify(rep2.data.history.map((h) => h.overall)) === JSON.stringify([4.4, 4.8]), rep2.data.history);
  const old = await anon("/api/peer-review/public/report?token=" + encodeURIComponent(marTok));
  check("last cycle's report still shows last cycle's history, not the future", old.data.history.length === 1);

  // ==================================================================
  section("The pages");
  const page = await fetch(BASE + "/peer-review/" + T.lana);
  check("the survey page is served from the link", page.status === 200 && /Peer Review/.test(await page.text()));
  const rpage = await fetch(BASE + "/peer-results/" + marTok);
  check("the report page is served from the link", rpage.status === 200 && /Consensus Report/.test(await rpage.text()));
  check("...and is never cached", /no-store/.test(rpage.headers.get("cache-control") || ""));

  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
