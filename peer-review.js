// Peer Performance Consensus Report.
//
// Every member of staff rates their coworkers once a review cycle, and each
// person gets back ONE report: what their coworkers, taken together, think of
// their work. Not 25 reports from 25 people -- one consolidated picture.
//
// The survey it digitises has three sections, and everybody is rated in
// exactly one of them:
//
//   RBT            7 competencies
//   Squad Leader   4 competencies
//   Administration 5 competencies
//
// ONE SECTION PER PERSON, ENFORCED BY THE SCHEMA. Somebody who is both an RBT
// and a Squad Leader on paper is rated as a Squad Leader here, because a score
// that blends "keeps the client schedule" with "gives clear clinical guidance"
// means neither. The assignment table has a unique (cycle, employee) key, so a
// second section for the same person cannot be written at all.
//
// WHAT THE EMPLOYEE NEVER SEES, and why each is refused at the API rather than
// hidden on a screen:
//
//   * WHO RATED THEM, OR WHAT ANY ONE PERSON GAVE THEM. Individual ratings are
//     kept for audit and never leave this module. Only averages do.
//   * A COMPETENCY RATED BY FEWER THAN THREE PEOPLE. With two raters, an
//     average and your own guess about who worked with you is enough to work
//     out what each of them said. Below the floor the employee is shown "Not
//     enough responses" and the number is left out of their overall too.
//   * A COMMENT LEADERSHIP HAS NOT APPROVED. Written feedback can name a shift,
//     a client or an incident that gives its author away. Every comment waits
//     for a person to approve it, optionally edited, before anyone sees it.
//   * The reviewer count and the spread of ratings. Leadership sees both, so it
//     can tell "everyone agrees" from "half say 5 and half say 1" -- an average
//     of 3 means very different things in those two cases.
//
// NOTHING IS SUMMARISED BY AI. Each approved comment is shown as its own line,
// so one person's opinion is never presented as the group's.
//
// LEADERSHIP ARE ALSO STAFF. The owner and the administrators are rated like
// everyone else, so whoever runs the cycle may be reading a page about
// themselves. Their own results and the comments about them are withheld from
// them on the leadership screen, and they cannot approve their own report --
// somebody else must. They receive it the same way everybody does.
//
// THE CYCLE, end to end:
//   draft    -> leadership puts each person in one section
//   open     -> every assigned person with an email gets a private survey link
//   closed   -> scores are calculated and stored, once
//   approve  -> per employee, after their comments are reviewed
//   send     -> one results email per employee per cycle, never two
"use strict";

module.exports = function initPeerReview(ctx) {
  const { dbGet, dbAll, dbRun, sendEmail, nowISO, crypto, APP_BASE_URL, readBody, json } = ctx;
  const granted = (u, k) => !!(ctx.moduleGranted && ctx.moduleGranted(u, k));
  const denied = (u, k) => !!(ctx.moduleDenied && ctx.moduleDenied(u, k));
  const role = (u) => (u && u.role) || "";
  const clean = (s) => String(s == null ? "" : s).trim();
  const num = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
  const parseJson = (s, f) => { try { return s ? JSON.parse(s) : f; } catch (e) { return f; } };
  const esc = (v) => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const newToken = () => crypto.randomBytes(24).toString("base64url");
  const round2 = (n) => Math.round(n * 100) / 100;

  // ======================= THE SURVEY =======================
  // Keys are stored; labels are shown. The keys never change once a cycle has
  // used them, because stored ratings point at them.
  const SECTIONS = {
    rbt: { label: "RBT", competencies: [
      { key: "tone_staff", label: "Friendliness & Tone to Staff" },
      { key: "tone_clients", label: "Friendliness & Tone to Clients" },
      { key: "client_schedule", label: "Maintains Client Schedule" },
      { key: "cleanliness", label: "Cleanliness" },
      { key: "attentiveness", label: "Attentiveness (stays with client)" },
      { key: "punctuality", label: "Punctuality" },
      { key: "remains_professional", label: "Remains Professional" },
    ] },
    squad_leader: { label: "Squad Leader", competencies: [
      { key: "clinical_guidance", label: "Provides Clear and Accurate Clinical Guidance" },
      { key: "open_feedback", label: "Maintains Open and Positive Feedback" },
      { key: "approachable", label: "Is Approachable" },
      { key: "accountability_ownership", label: "Shows Accountability and Ownership" },
    ] },
    admin: { label: "Administration", competencies: [
      { key: "leads_by_example", label: "Leads by Example" },
      { key: "problem_solves", label: "Problem Solves Effectively" },
      { key: "demonstrates_professionalism", label: "Demonstrates Professionalism" },
      { key: "approachability_accountability", label: "Approachability & Accountability" },
      { key: "professionalism_tone", label: "Professionalism & Tone" },
    ] },
  };
  const SECTION_KEYS = Object.keys(SECTIONS);
  const RATING_LABELS = { 1: "Needs Significant Improvement", 2: "Needs Improvement",
    3: "Meets Expectations", 4: "Exceeds Expectations", 5: "Exceptional" };

  // Below this many ratings a competency is withheld from the employee.
  const MIN_RATINGS = 3;
  // A spread this wide is flagged to leadership as divided rather than agreed.
  const DIVIDED_SPREAD = 3;

  // How each kind of written feedback is filed in the report.
  const COMMENT_KINDS = {
    below3: "Opportunities for Improvement",
    shoutout: "Strengths & Positive Recognition",
    additional: "Additional Feedback",
  };

  // ======================= WHO MAY DO WHAT =======================
  // Running the cycle is a NAMED grant, like RBT Fidelity: peer scores are
  // performance information about identifiable people, and an admin title is
  // not a reason to read them. Owner and super admin hold it by default; an
  // explicit Off takes it away from anyone, including them.
  const canManage = (u) => !!u && !denied(u, "peer-review") &&
    (["owner", "super_admin"].includes(role(u)) || granted(u, "peer-review"));

  // Which hr_employees rows ARE this signed-in person. By account link first,
  // and by email for staff added to the HR Hub before they had a login.
  async function selfIds(u) {
    if (!u) return [];
    const rows = await dbAll(
      `SELECT id FROM hr_employees WHERE user_id = ? OR (? <> '' AND lower(trim(coalesce(email,''))) = ?)`,
      [u.id, clean(u.email).toLowerCase(), clean(u.email).toLowerCase()]).catch(() => []);
    return rows.map((r) => r.id);
  }

  // May this person approve this employee's report?
  //   * never their own;
  //   * whoever leadership named as its approver;
  //   * otherwise the owner or a super admin;
  //   * and, outside the Administration section, anyone running the cycle.
  // Administration reports default to the owner because the people running
  // the cycle are mostly the people in that section.
  function canApprove(u, assignment, mine) {
    if (!u || !assignment) return false;
    if (mine.includes(assignment.employee_id)) return false;
    if (assignment.approver_user_id) return assignment.approver_user_id === u.id;
    if (["owner", "super_admin"].includes(role(u)) && canManage(u)) return true;
    return assignment.section !== "admin" && canManage(u);
  }

  // ======================= SCHEMA =======================
  async function initTables() {
    await dbRun(`CREATE TABLE IF NOT EXISTS peer_review_cycles (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',   -- draft | open | closed
      closes_on TEXT,                         -- the date staff are told; closing is still a person's decision
      opened_at TEXT, closed_at TEXT,
      created_by INTEGER, created_at TEXT
    )`);
    // ONE ROW PER PERSON PER CYCLE is the "rated in exactly one section" rule.
    await dbRun(`CREATE TABLE IF NOT EXISTS peer_review_assignments (
      id SERIAL PRIMARY KEY,
      cycle_id INTEGER NOT NULL,
      employee_id INTEGER NOT NULL,
      section TEXT NOT NULL,
      approver_user_id INTEGER,
      UNIQUE (cycle_id, employee_id)
    )`);
    // Each reviewer's private link. The token is who they are on the survey
    // page; there is no login there, because most RBTs do not have one.
    await dbRun(`CREATE TABLE IF NOT EXISTS peer_review_reviewers (
      id SERIAL PRIMARY KEY,
      cycle_id INTEGER NOT NULL,
      employee_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      invited_at TEXT, reminded_at TEXT, submitted_at TEXT,
      UNIQUE (cycle_id, employee_id)
    )`);
    // The individual ratings. KEPT FOR AUDIT AND NEVER RETURNED by any route --
    // nothing below selects a row of this table for display.
    await dbRun(`CREATE TABLE IF NOT EXISTS peer_review_ratings (
      id SERIAL PRIMARY KEY,
      cycle_id INTEGER NOT NULL,
      reviewer_employee_id INTEGER NOT NULL,
      subject_employee_id INTEGER NOT NULL,
      competency TEXT NOT NULL,
      rating INTEGER NOT NULL,                -- 1..5. N/A is the absence of a row.
      submitted_at TEXT,
      UNIQUE (cycle_id, reviewer_employee_id, subject_employee_id, competency)
    )`);
    // Written feedback. subject_employee_id NULL means "general -- for
    // leadership only": it never reaches anybody's report.
    await dbRun(`CREATE TABLE IF NOT EXISTS peer_review_comments (
      id SERIAL PRIMARY KEY,
      cycle_id INTEGER NOT NULL,
      reviewer_employee_id INTEGER NOT NULL,
      subject_employee_id INTEGER,
      kind TEXT NOT NULL,                     -- below3 | shoutout | additional
      competency TEXT,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
      approved_body TEXT,                     -- what the employee sees, if leadership edited it
      reviewed_by INTEGER, reviewed_at TEXT,
      created_at TEXT
    )`);
    // THE FINALIZED RECORD: one per employee per cycle, which is also what
    // makes a second results email impossible -- see sendReports().
    await dbRun(`CREATE TABLE IF NOT EXISTS peer_review_results (
      id SERIAL PRIMARY KEY,
      cycle_id INTEGER NOT NULL,
      employee_id INTEGER NOT NULL,
      section TEXT NOT NULL,
      competencies TEXT NOT NULL,             -- JSON: [{key,label,avg,n,min,max,withheld,divided}]
      overall REAL,                           -- what the employee sees (competencies at or above the floor)
      overall_all REAL,                       -- leadership's figure, every competency with a rating
      reviewer_count INTEGER NOT NULL DEFAULT 0,
      report_token TEXT UNIQUE NOT NULL,
      computed_at TEXT,
      approved_at TEXT, approved_by INTEGER,
      emailed_at TEXT, resend_count INTEGER NOT NULL DEFAULT 0, last_resent_at TEXT,
      UNIQUE (cycle_id, employee_id)
    )`);
    await dbRun(`CREATE TABLE IF NOT EXISTS peer_review_audit (
      id SERIAL PRIMARY KEY,
      cycle_id INTEGER, action TEXT NOT NULL, detail TEXT,
      actor_id INTEGER, actor_name TEXT, at TEXT
    )`);
  }

  async function audit(cycleId, action, detail, u) {
    await dbRun(`INSERT INTO peer_review_audit (cycle_id, action, detail, actor_id, actor_name, at)
      VALUES (?, ?, ?, ?, ?, ?)`, [cycleId || null, action, detail || null, u ? u.id : null,
      u ? (u.name || u.email || null) : "system", nowISO()]).catch(() => {});
  }

  // ======================= SCORING =======================
  // Pure, so the test can hold it to the worked example in the spec.
  //   per competency: the mean of every numeric rating (N/A is simply absent)
  //   overall:        the mean of the competency means, equally weighted
  function score(section, ratings) {
    const def = SECTIONS[section];
    const competencies = def.competencies.map((c) => {
      const vals = ratings.filter((r) => r.competency === c.key).map((r) => Number(r.rating))
        .filter((v) => v >= 1 && v <= 5);
      const n = vals.length;
      const avg = n ? round2(vals.reduce((a, b) => a + b, 0) / n) : null;
      const min = n ? Math.min(...vals) : null;
      const max = n ? Math.max(...vals) : null;
      return { key: c.key, label: c.label, avg, n, min, max,
        withheld: n < MIN_RATINGS, divided: n >= 2 && (max - min) >= DIVIDED_SPREAD };
    });
    const mean = (list) => list.length ? round2(list.reduce((a, c) => a + c.avg, 0) / list.length) : null;
    return {
      competencies,
      overall: mean(competencies.filter((c) => !c.withheld && c.avg != null)),
      overall_all: mean(competencies.filter((c) => c.avg != null)),
    };
  }

  // ======================= READS =======================
  async function cycleById(id) { return dbGet("SELECT * FROM peer_review_cycles WHERE id = ?", [id]); }

  // Active staff, which is who can be put in a section.
  async function activeStaff() {
    return dbAll(`SELECT id, name, email, role_title, status FROM hr_employees
      WHERE coalesce(status,'active') NOT IN ('terminated') ORDER BY lower(name)`).catch(() => []);
  }

  // A starting guess from the job title, which leadership confirms. Nobody is
  // put in a section silently: a guess is shown as a guess until saved.
  function suggestSection(title) {
    const t = clean(title);
    if (/squad\s*lead/i.test(t)) return "squad_leader";
    if (/\brbt\b|registered behavior|behavior tech|behavior therapist|behavioral tech/i.test(t)) return "rbt";
    if (/admin|director|manager|coordinator|office|front desk|scheduler|billing|intake|owner|ceo|coo|hr\b|human resources/i.test(t)) return "admin";
    return null;
  }

  async function assignmentsFor(cycleId) {
    return dbAll(`SELECT a.*, e.name, e.email, e.role_title FROM peer_review_assignments a
      JOIN hr_employees e ON e.id = a.employee_id WHERE a.cycle_id = ? ORDER BY lower(e.name)`, [cycleId]).catch(() => []);
  }

  function shapeCycle(c) {
    return { id: c.id, name: c.name, status: c.status, closes_on: c.closes_on,
      opened_at: c.opened_at, closed_at: c.closed_at, created_at: c.created_at };
  }

  // What leadership sees for one person. Never the reviewers, never a single
  // rating -- the count and spread are aggregate by construction.
  function shapeResultForLeadership(r) {
    if (!r) return null;
    return { id: r.id, section: r.section, competencies: parseJson(r.competencies, []),
      overall: r.overall, overall_all: r.overall_all, reviewer_count: r.reviewer_count,
      approved_at: r.approved_at, emailed_at: r.emailed_at, resend_count: r.resend_count };
  }

  // What the employee sees: no count, no spread, nothing under the floor.
  function shapeResultForEmployee(r) {
    return { section: r.section, section_label: SECTIONS[r.section].label, overall: r.overall,
      competencies: parseJson(r.competencies, []).map((c) => ({
        key: c.key, label: c.label, avg: c.withheld ? null : c.avg, withheld: !!c.withheld })) };
  }

  // Their consolidated score in every cycle that has been approved, oldest
  // first. One record per cycle, so this IS the history.
  async function historyFor(employeeId) {
    return dbAll(`SELECT r.overall, r.approved_at, c.name, c.closed_at, c.id AS cycle_id
      FROM peer_review_results r JOIN peer_review_cycles c ON c.id = r.cycle_id
      WHERE r.employee_id = ? AND r.approved_at IS NOT NULL
      ORDER BY coalesce(c.closed_at, r.approved_at), c.id`, [employeeId]).catch(() => []);
  }

  async function approvedFeedback(cycleId, employeeId) {
    const rows = await dbAll(`SELECT kind, coalesce(approved_body, body) AS text FROM peer_review_comments
      WHERE cycle_id = ? AND subject_employee_id = ? AND status = 'approved' ORDER BY id`,
      [cycleId, employeeId]).catch(() => []);
    const out = {};
    Object.keys(COMMENT_KINDS).forEach((k) => { out[k] = []; });
    rows.forEach((r) => { if (out[r.kind]) out[r.kind].push(r.text); });
    return Object.keys(COMMENT_KINDS).map((k) => ({ kind: k, title: COMMENT_KINDS[k], items: out[k] }));
  }

  // The whole report as the employee reads it, from a finalized result row.
  async function employeeReport(result) {
    const cycle = await cycleById(result.cycle_id);
    const emp = await dbGet("SELECT id, name FROM hr_employees WHERE id = ?", [result.employee_id]);
    const hist = await historyFor(result.employee_id);
    const idx = hist.findIndex((h) => h.cycle_id === result.cycle_id);
    const prev = idx > 0 ? hist[idx - 1] : null;
    const change = prev && prev.overall != null && result.overall != null ? round2(result.overall - prev.overall) : null;
    return {
      employee_name: emp ? emp.name : "",
      cycle: { name: cycle ? cycle.name : "", closed_at: cycle ? cycle.closed_at : null },
      ...shapeResultForEmployee(result),
      previous: prev ? { cycle_name: prev.name, overall: prev.overall } : null,
      change,
      history: hist.slice(0, idx >= 0 ? idx + 1 : hist.length).map((h) => ({ cycle_name: h.name, overall: h.overall })),
      feedback: await approvedFeedback(result.cycle_id, result.employee_id),
      min_ratings: MIN_RATINGS,
    };
  }

  // ======================= THE SURVEY PAGE (by token) =======================
  async function reviewerByToken(token) {
    const t = clean(token);
    if (!t || t.length < 20) return null;
    return dbGet("SELECT * FROM peer_review_reviewers WHERE token = ?", [t]);
  }

  async function surveyFor(rv) {
    const cycle = await cycleById(rv.cycle_id);
    const me = await dbGet("SELECT id, name FROM hr_employees WHERE id = ?", [rv.employee_id]);
    const people = (await assignmentsFor(rv.cycle_id)).filter((a) => a.employee_id !== rv.employee_id);
    const ratings = await dbAll(`SELECT subject_employee_id, competency, rating FROM peer_review_ratings
      WHERE cycle_id = ? AND reviewer_employee_id = ?`, [rv.cycle_id, rv.employee_id]).catch(() => []);
    const comments = await dbAll(`SELECT subject_employee_id, kind, competency, body FROM peer_review_comments
      WHERE cycle_id = ? AND reviewer_employee_id = ? ORDER BY id`, [rv.cycle_id, rv.employee_id]).catch(() => []);
    return {
      cycle: { name: cycle.name, status: cycle.status, closes_on: cycle.closes_on },
      reviewer_name: me ? me.name : "",
      submitted_at: rv.submitted_at,
      editable: cycle.status === "open",
      ratings_scale: RATING_LABELS,
      sections: SECTION_KEYS.map((k) => ({
        key: k, label: SECTIONS[k].label, competencies: SECTIONS[k].competencies,
        people: people.filter((p) => p.section === k).map((p) => ({ id: p.employee_id, name: p.name })),
      })),
      // Their own answers, so they can come back and change them until close.
      answers: { ratings, comments },
    };
  }

  // Replaces this reviewer's whole submission. Validated as a unit so a
  // half-saved survey cannot exist.
  async function saveSurvey(rv, b) {
    const cycle = await cycleById(rv.cycle_id);
    if (!cycle || cycle.status !== "open") {
      return { ok: false, status: 409, error: "This review cycle is closed, so answers can no longer be changed." };
    }
    const assigns = await assignmentsFor(rv.cycle_id);
    const sectionOf = new Map(assigns.map((a) => [a.employee_id, a.section]));

    const ratings = [];
    const seen = new Set();
    for (const r of Array.isArray(b.ratings) ? b.ratings : []) {
      const subject = num(r && r.subject_employee_id);
      const comp = clean(r && r.competency);
      // N/A is sent as null or simply left out. Either way it is not a rating.
      if (r == null || r.rating == null || r.rating === "" || String(r.rating).toUpperCase() === "N/A") continue;
      const rating = Number(r.rating);
      if (!subject || !sectionOf.has(subject)) return { ok: false, status: 400, error: "One of the people rated is not part of this review." };
      if (subject === rv.employee_id) return { ok: false, status: 400, error: "You cannot rate yourself." };
      if (!SECTIONS[sectionOf.get(subject)].competencies.some((c) => c.key === comp)) {
        return { ok: false, status: 400, error: "A rating was given for a question that is not in that person's section." };
      }
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { ok: false, status: 400, error: "Ratings run from 1 to 5, or N/A." };
      const k = subject + ":" + comp;
      if (seen.has(k)) continue;
      seen.add(k);
      ratings.push({ subject, comp, rating });
    }

    const comments = [];
    for (const c of Array.isArray(b.comments) ? b.comments : []) {
      const body = clean(c && c.body).slice(0, 4000);
      if (!body) continue;
      const kind = clean(c.kind);
      if (!COMMENT_KINDS[kind]) continue;
      const subject = c.subject_employee_id == null || c.subject_employee_id === "" ? null : num(c.subject_employee_id);
      if (subject !== null && !sectionOf.has(subject)) return { ok: false, status: 400, error: "A comment names somebody who is not part of this review." };
      if (subject === rv.employee_id) return { ok: false, status: 400, error: "Comments are about your coworkers, not yourself." };
      comments.push({ subject, kind, comp: clean(c.competency) || null, body });
    }

    // The paper form's rule, kept: below 3 needs a reason. Checked per person
    // and question, so the reason lands next to the score it explains.
    for (const r of ratings.filter((x) => x.rating < 3)) {
      const has = comments.some((c) => c.kind === "below3" && c.subject === r.subject && (!c.comp || c.comp === r.comp));
      if (!has) {
        const who = assigns.find((a) => a.employee_id === r.subject);
        const q = SECTIONS[sectionOf.get(r.subject)].competencies.find((x) => x.key === r.comp);
        return { ok: false, status: 400, error: `Please add a reason for the rating below 3 you gave ${who ? who.name : "a coworker"} on "${q ? q.label : r.comp}".` };
      }
    }

    const now = nowISO();
    await dbRun("DELETE FROM peer_review_ratings WHERE cycle_id = ? AND reviewer_employee_id = ?", [rv.cycle_id, rv.employee_id]);
    // A resubmission replaces the reviewer's comments too, and the new ones
    // wait for leadership like any other. Comments are reviewed after close,
    // when nothing can change underneath the reviewer any more.
    await dbRun("DELETE FROM peer_review_comments WHERE cycle_id = ? AND reviewer_employee_id = ?", [rv.cycle_id, rv.employee_id]);
    for (const r of ratings) {
      await dbRun(`INSERT INTO peer_review_ratings (cycle_id, reviewer_employee_id, subject_employee_id, competency, rating, submitted_at)
        VALUES (?, ?, ?, ?, ?, ?)`, [rv.cycle_id, rv.employee_id, r.subject, r.comp, r.rating, now]);
    }
    for (const c of comments) {
      await dbRun(`INSERT INTO peer_review_comments (cycle_id, reviewer_employee_id, subject_employee_id, kind, competency, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [rv.cycle_id, rv.employee_id, c.subject, c.kind, c.comp, c.body, now]);
    }
    await dbRun("UPDATE peer_review_reviewers SET submitted_at = ? WHERE id = ?", [now, rv.id]);
    return { ok: true, saved: { ratings: ratings.length, comments: comments.length } };
  }

  // ======================= EMAIL =======================
  const surveyUrl = (token) => `${APP_BASE_URL}/peer-review/${token}`;
  const reportUrl = (token) => `${APP_BASE_URL}/peer-results/${token}`;
  const fmtDate = (s) => { if (!s) return ""; const d = new Date(s + (s.length === 10 ? "T12:00:00" : "")); return isNaN(d) ? s : d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }); };

  async function sendInvite(cycle, a, token, reminder) {
    const due = cycle.closes_on ? `<p>Please finish by <strong>${esc(fmtDate(cycle.closes_on))}</strong>.</p>` : "";
    const html = `<p>Hi ${esc(a.name)},</p>
      <p>${reminder ? "A reminder: the" : "The"} <strong>${esc(cycle.name)}</strong> peer review is open. You'll rate the coworkers you work with on a 1 to 5 scale. Choose N/A for anyone you haven't worked with.</p>
      ${due}
      <p><strong>Your answers are anonymous.</strong> Each person only sees combined averages from all their coworkers, never who said what.</p>
      <p><a href="${surveyUrl(token)}" style="display:inline-block;background:#e0a430;color:#1b2a6b;font-weight:700;padding:11px 22px;border-radius:999px;text-decoration:none;">Open my peer review</a></p>
      <p style="font-size:13px;color:#6b6a86;">This link is just for you. Please don't forward it.</p>`;
    return sendEmail({ to: a.email, subject: `${reminder ? "Reminder: " : ""}${cycle.name} peer review`, html,
      type: reminder ? "peer_review_reminder" : "peer_review_invite", refType: "peer_review_cycle", refId: cycle.id });
  }

  // Score cells carry data-peer-score so the Message Outbox can withhold them
  // from anyone reading the log -- see redactStoredBody in server.js.
  function resultsEmailHtml(rep, token) {
    const cell = (v) => `<td data-peer-score style="padding:6px 10px;text-align:right;font-weight:700;">${v}</td>`;
    const rows = rep.competencies.map((c) => `<tr><td style="padding:6px 10px;">${esc(c.label)}</td>${cell(c.withheld ? "Not enough responses" : c.avg.toFixed(2))}</tr>`).join("");
    const prev = rep.previous && rep.previous.overall != null ? `<tr><td style="padding:6px 10px;">Last review (${esc(rep.previous.cycle_name)})</td>${cell(rep.previous.overall.toFixed(2))}</tr>` : "";
    const chg = rep.change != null ? `<tr><td style="padding:6px 10px;">Change</td>${cell((rep.change > 0 ? "+" : "") + rep.change.toFixed(2) + (rep.change > 0 ? " improvement" : rep.change < 0 ? " decline" : " no change"))}</tr>` : "";
    return `<p>Hi ${esc(rep.employee_name)},</p>
      <p>Your <strong>${esc(rep.cycle.name)}</strong> Peer Performance Consensus Report is ready. These scores combine the ratings from all of your coworkers.</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px;margin:10px 0;">
        <tr style="background:#f5f4fb;"><td style="padding:8px 10px;font-weight:700;">Overall peer review score</td>${cell(rep.overall != null ? rep.overall.toFixed(2) + " / 5.00" : "Not enough responses")}</tr>
        ${prev}${chg}
        ${rows}
      </table>
      <p><a href="${reportUrl(token)}" style="display:inline-block;background:#e0a430;color:#1b2a6b;font-weight:700;padding:11px 22px;border-radius:999px;text-decoration:none;">View my full report</a></p>
      <p style="font-size:13px;color:#6b6a86;">Your full report includes your written feedback and how your score has changed over time. This link is just for you.</p>`;
  }

  // ONE EMAIL PER EMPLOYEE PER CYCLE. The row is claimed before the send, in
  // one statement that only succeeds while emailed_at is still empty -- so two
  // clicks, two tabs or two servers cannot both send it.
  async function sendReport(r) {
    const claim = await dbGet(`UPDATE peer_review_results SET emailed_at = ? WHERE id = ? AND emailed_at IS NULL
      AND approved_at IS NOT NULL RETURNING id`, [nowISO(), r.id]);
    if (!claim) return { sent: false, reason: "already sent" };
    return deliverReport(r);
  }

  async function deliverReport(r) {
    const emp = await dbGet("SELECT email FROM hr_employees WHERE id = ?", [r.employee_id]);
    const to = clean(emp && emp.email);
    if (!to) return { sent: false, reason: "no email on file" };
    const rep = await employeeReport(r);
    const out = await sendEmail({ to, subject: `Your ${rep.cycle.name} Peer Performance Consensus Report`,
      html: resultsEmailHtml(rep, r.report_token), type: "peer_review_results", refType: "peer_review_result", refId: r.id });
    return { sent: !!(out && out.delivered !== false), reason: out && out.errorMsg ? out.errorMsg : null };
  }

  // ======================= LEADERSHIP ACTIONS =======================
  async function closeAndScore(cycle, u) {
    const assigns = await assignmentsFor(cycle.id);
    for (const a of assigns) {
      const ratings = await dbAll(`SELECT reviewer_employee_id, competency, rating FROM peer_review_ratings
        WHERE cycle_id = ? AND subject_employee_id = ?`, [cycle.id, a.employee_id]);
      const s = score(a.section, ratings);
      const reviewers = new Set(ratings.map((r) => r.reviewer_employee_id)).size;
      // Written once. If this ran twice, the second does nothing: the scores of
      // a closed cycle do not move.
      await dbRun(`INSERT INTO peer_review_results
        (cycle_id, employee_id, section, competencies, overall, overall_all, reviewer_count, report_token, computed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (cycle_id, employee_id) DO NOTHING`,
        [cycle.id, a.employee_id, a.section, JSON.stringify(s.competencies), s.overall, s.overall_all,
         reviewers, newToken(), nowISO()]);
    }
    await dbRun("UPDATE peer_review_cycles SET status = 'closed', closed_at = ? WHERE id = ?", [nowISO(), cycle.id]);
    await audit(cycle.id, "closed", `${assigns.length} reports calculated`, u);
  }

  async function cycleDetail(cycle, u) {
    const mine = await selfIds(u);
    const assigns = await assignmentsFor(cycle.id);
    const reviewers = await dbAll("SELECT employee_id, invited_at, reminded_at, submitted_at FROM peer_review_reviewers WHERE cycle_id = ?", [cycle.id]).catch(() => []);
    const rvBy = new Map(reviewers.map((r) => [r.employee_id, r]));
    const results = await dbAll("SELECT * FROM peer_review_results WHERE cycle_id = ?", [cycle.id]).catch(() => []);
    const resBy = new Map(results.map((r) => [r.employee_id, r]));
    const comments = await dbAll(`SELECT id, subject_employee_id, kind, competency, body, status, approved_body, reviewed_at
      FROM peer_review_comments WHERE cycle_id = ? ORDER BY id`, [cycle.id]).catch(() => []);
    const users = await dbAll("SELECT id, name, email FROM users").catch(() => []);
    const userName = new Map(users.map((x) => [x.id, x.name || x.email]));
    const compLabel = (sec, key) => { const c = SECTIONS[sec] && SECTIONS[sec].competencies.find((x) => x.key === key); return c ? c.label : null; };

    const people = assigns.map((a) => {
      const self = mine.includes(a.employee_id);
      const rv = rvBy.get(a.employee_id);
      const res = resBy.get(a.employee_id);
      const theirs = comments.filter((c) => c.subject_employee_id === a.employee_id);
      return {
        employee_id: a.employee_id, name: a.name, email: a.email || null, role_title: a.role_title,
        section: a.section, section_label: SECTIONS[a.section].label,
        approver_user_id: a.approver_user_id || null,
        approver_name: a.approver_user_id ? (userName.get(a.approver_user_id) || "Unknown") : null,
        invited_at: rv ? rv.invited_at : null, submitted_at: rv ? rv.submitted_at : null,
        is_self: self,
        can_approve: !!res && cycle.status === "closed" && canApprove(u, a, mine),
        // Your own report is not yours to read before it is sent to you.
        result: self ? (res ? { id: res.id, approved_at: res.approved_at, emailed_at: res.emailed_at, withheld_from_you: true } : null)
          : shapeResultForLeadership(res),
        comments: self ? [] : theirs.map((c) => ({ id: c.id, kind: c.kind, kind_label: COMMENT_KINDS[c.kind],
          competency_label: compLabel(a.section, c.competency), body: c.body, approved_body: c.approved_body,
          status: c.status, reviewed_at: c.reviewed_at })),
        pending_comments: theirs.filter((c) => c.status === "pending").length,
      };
    });
    const general = comments.filter((c) => c.subject_employee_id == null).map((c) => ({
      id: c.id, kind: c.kind, kind_label: COMMENT_KINDS[c.kind], body: c.body, status: c.status }));
    return {
      cycle: shapeCycle(cycle),
      people,
      general_comments: general,
      progress: { assigned: assigns.length, invited: reviewers.filter((r) => r.invited_at).length,
        submitted: reviewers.filter((r) => r.submitted_at).length },
      min_ratings: MIN_RATINGS,
    };
  }

  // ======================= ROUTES =======================
  async function handleApi(req, res, pathname, method, query, user) {
    if (!pathname.startsWith("/api/peer-review")) return false;

    // ---- the survey and the report, by private link, no login ----
    if (pathname === "/api/peer-review/public/survey") {
      const token = method === "GET" ? query.token : null;
      if (method === "GET") {
        const rv = await reviewerByToken(token);
        if (!rv) { json(res, 404, { error: "This link isn't valid. Please use the link from your most recent email." }); return true; }
        json(res, 200, await surveyFor(rv));
        return true;
      }
      if (method === "POST") {
        const b = await readBody(req);
        const rv = await reviewerByToken(b.token);
        if (!rv) { json(res, 404, { error: "This link isn't valid. Please use the link from your most recent email." }); return true; }
        const r = await saveSurvey(rv, b);
        json(res, r.ok ? 200 : (r.status || 400), r.ok ? r : { error: r.error });
        return true;
      }
    }
    if (pathname === "/api/peer-review/public/report" && method === "GET") {
      const t = clean(query.token);
      const r = t.length >= 20 ? await dbGet("SELECT * FROM peer_review_results WHERE report_token = ? AND approved_at IS NOT NULL", [t]) : null;
      if (!r) { json(res, 404, { error: "This report isn't available. Please use the link from your results email." }); return true; }
      json(res, 200, await employeeReport(r));
      return true;
    }

    if (!user) { json(res, 401, { error: "Please sign in." }); return true; }
    if (!canManage(user)) { json(res, 403, { error: "Peer reviews are run by leadership. Ask the owner for access." }); return true; }

    if (pathname === "/api/peer-review/options" && method === "GET") {
      json(res, 200, { can_manage: true, sections: SECTIONS, ratings_scale: RATING_LABELS,
        min_ratings: MIN_RATINGS, comment_kinds: COMMENT_KINDS });
      return true;
    }

    if (pathname === "/api/peer-review/cycles" && method === "GET") {
      const rows = await dbAll("SELECT * FROM peer_review_cycles ORDER BY id DESC").catch(() => []);
      const out = [];
      for (const c of rows) {
        const p = await dbGet(`SELECT
            (SELECT count(*) FROM peer_review_assignments WHERE cycle_id = ?) AS assigned,
            (SELECT count(*) FROM peer_review_reviewers WHERE cycle_id = ? AND submitted_at IS NOT NULL) AS submitted,
            (SELECT count(*) FROM peer_review_results WHERE cycle_id = ? AND emailed_at IS NOT NULL) AS sent`, [c.id, c.id, c.id]);
        out.push({ ...shapeCycle(c), assigned: Number(p.assigned), submitted: Number(p.submitted), sent: Number(p.sent) });
      }
      json(res, 200, { cycles: out });
      return true;
    }

    if (pathname === "/api/peer-review/cycles" && method === "POST") {
      const b = await readBody(req);
      const name = clean(b.name);
      if (!name) { json(res, 400, { error: "Give the review cycle a name, like \"Q4 2026\"." }); return true; }
      const closes = /^\d{4}-\d{2}-\d{2}$/.test(clean(b.closes_on)) ? clean(b.closes_on) : null;
      const c = await dbGet(`INSERT INTO peer_review_cycles (name, status, closes_on, created_by, created_at)
        VALUES (?, 'draft', ?, ?, ?) RETURNING *`, [name, closes, user.id, nowISO()]);
      await audit(c.id, "created", name, user);
      json(res, 201, shapeCycle(c));
      return true;
    }

    // Users who could be named as somebody's approver.
    if (pathname === "/api/peer-review/approvers" && method === "GET") {
      const rows = await dbAll("SELECT id, name, email, role, module_access FROM users ORDER BY lower(name)").catch(() => []);
      json(res, 200, { approvers: rows.filter((x) => canManage(x)).map((x) => ({ id: x.id, name: x.name || x.email })) });
      return true;
    }

    const cm = pathname.match(/^\/api\/peer-review\/cycles\/(\d+)(?:\/([a-z-]+))?$/);
    if (cm) {
      const cycle = await cycleById(Number(cm[1]));
      if (!cycle) { json(res, 404, { error: "That review cycle no longer exists." }); return true; }
      const action = cm[2] || "";

      if (!action && method === "GET") { json(res, 200, await cycleDetail(cycle, user)); return true; }

      if (!action && method === "PATCH") {
        const b = await readBody(req);
        const name = b.name !== undefined ? clean(b.name) : cycle.name;
        if (!name) { json(res, 400, { error: "The cycle needs a name." }); return true; }
        const closes = b.closes_on !== undefined ? (/^\d{4}-\d{2}-\d{2}$/.test(clean(b.closes_on)) ? clean(b.closes_on) : null) : cycle.closes_on;
        await dbRun("UPDATE peer_review_cycles SET name = ?, closes_on = ? WHERE id = ?", [name, closes, cycle.id]);
        json(res, 200, shapeCycle(await cycleById(cycle.id)));
        return true;
      }

      // Everyone who could be put in a section, with their current section or
      // a suggestion from their job title.
      if (action === "roster" && method === "GET") {
        const staff = await activeStaff();
        const assigned = new Map((await assignmentsFor(cycle.id)).map((a) => [a.employee_id, a.section]));
        json(res, 200, { roster: staff.map((s) => ({ employee_id: s.id, name: s.name, email: s.email || null,
          role_title: s.role_title, section: assigned.get(s.id) || null,
          suggested: assigned.has(s.id) ? null : suggestSection(s.role_title) })) });
        return true;
      }

      // Set who is in which section. Each person gets one section or none.
      // Sections are fixed once the survey is open; people can still be added.
      if (action === "assignments" && method === "PUT") {
        if (cycle.status === "closed") { json(res, 409, { error: "This cycle is closed." }); return true; }
        const b = await readBody(req);
        const list = Array.isArray(b.assignments) ? b.assignments : [];
        const ids = new Set();
        for (const x of list) {
          const id = num(x && x.employee_id);
          if (!id) { json(res, 400, { error: "Each row needs an employee." }); return true; }
          if (ids.has(id)) { json(res, 400, { error: "Each person can be in only one section." }); return true; }
          ids.add(id);
          const sec = x.section == null || x.section === "" ? null : clean(x.section);
          if (sec !== null && !SECTIONS[sec]) { json(res, 400, { error: "Unknown section." }); return true; }
        }
        const current = new Map((await assignmentsFor(cycle.id)).map((a) => [a.employee_id, a.section]));
        for (const x of list) {
          const id = num(x.employee_id);
          const sec = x.section == null || x.section === "" ? null : clean(x.section);
          const had = current.get(id) || null;
          if (sec === had) continue;
          if (cycle.status === "open" && had) {
            json(res, 409, { error: "Once the survey is open, people already in it can't be moved or removed. You can still add people." });
            return true;
          }
          if (sec === null) {
            await dbRun("DELETE FROM peer_review_assignments WHERE cycle_id = ? AND employee_id = ?", [cycle.id, id]);
          } else {
            await dbRun(`INSERT INTO peer_review_assignments (cycle_id, employee_id, section) VALUES (?, ?, ?)
              ON CONFLICT (cycle_id, employee_id) DO UPDATE SET section = EXCLUDED.section`, [cycle.id, id, sec]);
          }
        }
        await audit(cycle.id, "assignments", `${list.length} rows saved`, user);
        json(res, 200, { ok: true, roster_count: (await assignmentsFor(cycle.id)).length });
        return true;
      }

      if (action === "approver" && method === "PUT") {
        const b = await readBody(req);
        const emp = num(b.employee_id);
        const a = (await assignmentsFor(cycle.id)).find((x) => x.employee_id === emp);
        if (!a) { json(res, 404, { error: "That person isn't in this review." }); return true; }
        const approver = b.approver_user_id == null || b.approver_user_id === "" ? null : num(b.approver_user_id);
        if (approver) {
          const u2 = await dbGet("SELECT id, name, email, role, module_access FROM users WHERE id = ?", [approver]);
          if (!u2 || !canManage(u2)) { json(res, 400, { error: "The approver needs access to Peer Reviews." }); return true; }
          if ((await selfIds(u2)).includes(emp)) { json(res, 400, { error: "Nobody can approve their own report." }); return true; }
        }
        await dbRun("UPDATE peer_review_assignments SET approver_user_id = ? WHERE id = ?", [approver, a.id]);
        await audit(cycle.id, "approver", `employee ${emp} -> ${approver || "default"}`, user);
        json(res, 200, { ok: true });
        return true;
      }

      // Open the survey and send each person their private link. Safe to press
      // again: only people who have not been invited yet are emailed.
      if ((action === "open" || action === "invite") && method === "POST") {
        if (cycle.status === "closed") { json(res, 409, { error: "This cycle is closed." }); return true; }
        const assigns = await assignmentsFor(cycle.id);
        if (assigns.length < 2) { json(res, 400, { error: "Put at least two people in a section first." }); return true; }
        if (cycle.status === "draft") {
          await dbRun("UPDATE peer_review_cycles SET status = 'open', opened_at = ? WHERE id = ?", [nowISO(), cycle.id]);
          cycle.status = "open";
          await audit(cycle.id, "opened", null, user);
        }
        let sent = 0; const missing = [];
        for (const a of assigns) {
          let rv = await dbGet("SELECT * FROM peer_review_reviewers WHERE cycle_id = ? AND employee_id = ?", [cycle.id, a.employee_id]);
          if (!rv) {
            rv = await dbGet(`INSERT INTO peer_review_reviewers (cycle_id, employee_id, token) VALUES (?, ?, ?)
              ON CONFLICT (cycle_id, employee_id) DO NOTHING RETURNING *`, [cycle.id, a.employee_id, newToken()])
              || await dbGet("SELECT * FROM peer_review_reviewers WHERE cycle_id = ? AND employee_id = ?", [cycle.id, a.employee_id]);
          }
          if (rv.invited_at) continue;
          if (!clean(a.email)) { missing.push(a.name); continue; }
          const claim = await dbGet("UPDATE peer_review_reviewers SET invited_at = ? WHERE id = ? AND invited_at IS NULL RETURNING id", [nowISO(), rv.id]);
          if (!claim) continue;
          await sendInvite(cycle, a, rv.token, false).catch(() => {});
          sent++;
        }
        json(res, 200, { ok: true, status: cycle.status, invited: sent, missing_email: missing });
        return true;
      }

      if (action === "remind" && method === "POST") {
        if (cycle.status !== "open") { json(res, 409, { error: "Reminders go out only while the survey is open." }); return true; }
        const rows = await dbAll(`SELECT r.*, e.name, e.email FROM peer_review_reviewers r JOIN hr_employees e ON e.id = r.employee_id
          WHERE r.cycle_id = ? AND r.submitted_at IS NULL AND r.invited_at IS NOT NULL`, [cycle.id]);
        let sent = 0;
        for (const r of rows) {
          if (!clean(r.email)) continue;
          await sendInvite(cycle, r, r.token, true).catch(() => {});
          await dbRun("UPDATE peer_review_reviewers SET reminded_at = ? WHERE id = ?", [nowISO(), r.id]);
          sent++;
        }
        await audit(cycle.id, "reminded", `${sent} reminders`, user);
        json(res, 200, { ok: true, reminded: sent });
        return true;
      }

      if (action === "close" && method === "POST") {
        if (cycle.status !== "open") { json(res, 409, { error: "Only an open cycle can be closed." }); return true; }
        await closeAndScore(cycle, user);
        json(res, 200, await cycleDetail(await cycleById(cycle.id), user));
        return true;
      }

      // Email every approved report that has not been sent. Pressing it twice
      // sends nothing new: see sendReport().
      if (action === "send" && method === "POST") {
        if (cycle.status !== "closed") { json(res, 409, { error: "Close the cycle and approve reports first." }); return true; }
        const rows = await dbAll(`SELECT * FROM peer_review_results WHERE cycle_id = ? AND approved_at IS NOT NULL AND emailed_at IS NULL`, [cycle.id]);
        let sent = 0; const problems = [];
        for (const r of rows) {
          const out = await sendReport(r);
          if (out.sent) sent++;
          else if (out.reason !== "already sent") {
            const e = await dbGet("SELECT name FROM hr_employees WHERE id = ?", [r.employee_id]);
            problems.push(`${e ? e.name : "Someone"}: ${out.reason}`);
            // Not sent means not sent: free the claim so it can be sent later.
            await dbRun("UPDATE peer_review_results SET emailed_at = NULL WHERE id = ?", [r.id]);
          }
        }
        await audit(cycle.id, "reports_sent", `${sent} sent`, user);
        json(res, 200, { ok: true, sent, problems });
        return true;
      }
    }

    // Approve or reject one comment, optionally editing what the employee sees.
    const cmt = pathname.match(/^\/api\/peer-review\/comments\/(\d+)$/);
    if (cmt && method === "POST") {
      const c = await dbGet("SELECT * FROM peer_review_comments WHERE id = ?", [Number(cmt[1])]);
      if (!c) { json(res, 404, { error: "That comment no longer exists." }); return true; }
      const cc = await cycleById(c.cycle_id);
      if (!cc || cc.status !== "closed") { json(res, 409, { error: "Comments are reviewed after the cycle closes." }); return true; }
      const mine = await selfIds(user);
      if (c.subject_employee_id && mine.includes(c.subject_employee_id)) {
        json(res, 403, { error: "Feedback about you is reviewed by someone else." }); return true;
      }
      const r = c.subject_employee_id ? await dbGet("SELECT approved_at FROM peer_review_results WHERE cycle_id = ? AND employee_id = ?", [c.cycle_id, c.subject_employee_id]) : null;
      if (r && r.approved_at) { json(res, 409, { error: "This report is already approved, so its comments are final." }); return true; }
      const b = await readBody(req);
      const decision = clean(b.decision);
      if (!["approve", "reject", "pending"].includes(decision)) { json(res, 400, { error: "Choose approve or reject." }); return true; }
      const edited = clean(b.body);
      const status = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "pending";
      await dbRun(`UPDATE peer_review_comments SET status = ?, approved_body = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?`,
        [status, decision === "approve" && edited && edited !== c.body ? edited : null, user.id, nowISO(), c.id]);
      await audit(c.cycle_id, "comment_" + status, `comment ${c.id}`, user);
      json(res, 200, { ok: true, status });
      return true;
    }

    const rm = pathname.match(/^\/api\/peer-review\/results\/(\d+)\/(approve|resend)$/);
    if (rm && method === "POST") {
      const r = await dbGet("SELECT * FROM peer_review_results WHERE id = ?", [Number(rm[1])]);
      if (!r) { json(res, 404, { error: "That report no longer exists." }); return true; }
      const a = await dbGet("SELECT * FROM peer_review_assignments WHERE cycle_id = ? AND employee_id = ?", [r.cycle_id, r.employee_id]);
      const mine = await selfIds(user);

      if (rm[2] === "approve") {
        if (!canApprove(user, a, mine)) {
          json(res, 403, { error: mine.includes(r.employee_id) ? "Nobody can approve their own report. Assign someone else as the approver."
            : a && a.section === "admin" && !a.approver_user_id ? "Administration reports are approved by the owner unless someone else is assigned."
            : "You aren't the approver for this report." });
          return true;
        }
        if (r.approved_at) { json(res, 200, { ok: true, already: true }); return true; }
        const pend = await dbGet("SELECT count(*) AS n FROM peer_review_comments WHERE cycle_id = ? AND subject_employee_id = ? AND status = 'pending'", [r.cycle_id, r.employee_id]);
        if (Number(pend.n) > 0) { json(res, 409, { error: "Review every comment about this person (approve or reject) before approving the report." }); return true; }
        await dbRun("UPDATE peer_review_results SET approved_at = ?, approved_by = ? WHERE id = ? AND approved_at IS NULL", [nowISO(), user.id, r.id]);
        await audit(r.cycle_id, "approved", `employee ${r.employee_id}`, user);
        json(res, 200, { ok: true });
        return true;
      }

      // Resend: the same report, same scores, same link. Nothing recalculated.
      if (!r.emailed_at) { json(res, 409, { error: "This report hasn't been sent yet. Use Send reports." }); return true; }
      if (mine.includes(r.employee_id)) { json(res, 403, { error: "Ask someone else to resend your own report." }); return true; }
      const out = await deliverReport(r);
      if (!out.sent) { json(res, 400, { error: "Couldn't resend: " + (out.reason || "delivery failed") }); return true; }
      await dbRun("UPDATE peer_review_results SET resend_count = resend_count + 1, last_resent_at = ? WHERE id = ?", [nowISO(), r.id]);
      await audit(r.cycle_id, "resent", `employee ${r.employee_id}`, user);
      json(res, 200, { ok: true });
      return true;
    }

    json(res, 404, { error: "Not found." });
    return true;
  }

  // ======================= PAGES =======================
  const fs = require("fs");
  const path = require("path");
  function servePage(req, res, pathname) {
    const file = pathname.startsWith("/peer-review/") ? "peer-review-survey.html"
      : pathname.startsWith("/peer-results/") ? "peer-review-report.html" : null;
    if (!file) return false;
    const f = path.join(__dirname, file);
    if (!fs.existsSync(f)) return false;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" });
    res.end(fs.readFileSync(f, "utf8"));
    return true;
  }

  return { initTables, handleApi, servePage, canManage,
    _internal: { SECTIONS, MIN_RATINGS, DIVIDED_SPREAD, score, suggestSection, COMMENT_KINDS } };
};
