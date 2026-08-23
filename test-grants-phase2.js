// Grant Finder phase 2: the application workspace, the calendar, deadline
// alerts, tasks and the document library.
//
// Three properties this suite exists to hold down, all of them the kind of
// thing that is embarrassing rather than merely broken:
//
//   1. A deadline notice is never sent twice, and is recorded before it is
//      sent so a crash cannot turn into a duplicate blast. The sweep is run
//      repeatedly here and must stay quiet after the first pass.
//   2. Nobody is chased about a grant they cannot apply for. A nonprofit-only
//      grant closing tomorrow produces no notice at all.
//   3. Application tasks are ordinary staff tasks. They must land in the
//      staff_tasks table with the grant attached, not in a private list only
//      this module knows about.
//
//   DATABASE_URL=... PORT=3011 node server.js
//   BASE=http://127.0.0.1:3011 DATABASE_URL=... node test-grants-phase2.js
"use strict";
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 320) : "")); }
}
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
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

(async () => {
  const owner = client();
  check("owner signs in", (await owner("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } })).status === 200);

  // A grant we can apply for, closing inside the alert window, and one we
  // cannot, closing sooner.
  const good = (await owner("/api/grants/opportunities", {
    method: "POST",
    body: {
      name: "P2 Nevada Workforce Grant", funder: "Nevada DETR", opportunity_number: "P2-001",
      geographic_eligibility: "Nevada", for_profit_allowed: true, small_business_eligible: true,
      expected_award: 90000, deadline: inDays(10), sam_required: true, uei_required: true,
      tags: ["nevada", "rbt_training", "healthcare_workforce"],
    },
  })).data.grant;
  const blocked = (await owner("/api/grants/opportunities", {
    method: "POST",
    body: {
      name: "P2 Nonprofit Only Fund", funder: "P2 Foundation", opportunity_number: "P2-002",
      geographic_eligibility: "Nevada", nonprofit_required: true,
      expected_award: 300000, deadline: inDays(2), tags: ["autism", "nevada"],
    },
  })).data.grant;
  check("both grants stored", !!good && !!blocked);

  // ------------------------------------------------------------- workspace
  section("Opening a workspace");
  const opened = await owner("/api/grants/applications", { method: "POST", body: { grant_id: good.id } });
  check("a workspace opens", opened.status === 200 && !!opened.data.application, opened.data);
  const appId = opened.data.application.id;
  check("it inherits the grant's deadline", opened.data.application.submission_deadline === good.deadline);
  check("and the grant now reads as preparing",
    (await owner(`/api/grants/opportunities/${good.id}`)).data.grant.status === "Preparing Application");

  const again = await owner("/api/grants/applications", { method: "POST", body: { grant_id: good.id } });
  check("opening it twice returns the same workspace", again.data.application.id === appId);

  section("The checklist is built for this grant, not a generic one");
  const detail = (await owner(`/api/grants/applications/${appId}`)).data;
  const keys = detail.checklist.map((c) => c.key);
  check("it asks about SAM, because this grant requires it", keys.includes("sam"), keys);
  check("and about the UEI", keys.includes("uei"), keys);
  check("eligibility is the first thing on it", keys[0] === "eligibility", keys);
  check("it does not ask for matching funds this grant never mentioned", !keys.includes("match"), keys);
  check("submission and confirmation are on it", keys.includes("submitted") && keys.includes("confirmation"));

  const plain = (await owner("/api/grants/opportunities", {
    method: "POST", body: { name: "P2 Simple Grant", funder: "P2", deadline: inDays(45), for_profit_allowed: true },
  })).data.grant;
  const plainApp = (await owner("/api/grants/applications", { method: "POST", body: { grant_id: plain.id } })).data;
  check("a grant with no registration requirements gets no SAM line",
    !plainApp.detail.checklist.map((c) => c.key).includes("sam"),
    plainApp.detail.checklist.map((c) => c.key));

  section("Working through it");
  const ticked = await owner(`/api/grants/applications/${appId}/checklist/eligibility`, { method: "PATCH", body: { done: true } });
  check("an item can be ticked", ticked.data.checklist.find((c) => c.key === "eligibility").done === true);
  check("and records who did it", !!ticked.data.checklist.find((c) => c.key === "eligibility").done_by);
  check("progress reflects it", ticked.data.progress.done === 1, ticked.data.progress);

  await owner(`/api/grants/applications/${appId}/narrative/statement_of_need`, {
    method: "PUT", body: { content: "Southern Nevada has too few RBTs." },
  });
  const withNarr = (await owner(`/api/grants/applications/${appId}`)).data;
  check("a narrative section saves",
    withNarr.narratives.find((n) => n.key === "statement_of_need").content === "Southern Nevada has too few RBTs.");
  check("and the other sections stay empty rather than invented",
    withNarr.narratives.filter((n) => n.content).length === 1, withNarr.narratives.map((n) => n.key + ":" + n.content.length));
  const badSection = await owner(`/api/grants/applications/${appId}/narrative/not_a_section`, { method: "PUT", body: { content: "x" } });
  check("an unknown narrative section is refused", badSection.status === 400, badSection.data);

  const q = await owner(`/api/grants/applications/${appId}/questions`, {
    method: "POST", body: { question: "Describe your workforce programme." },
  });
  check("a question can be added", q.data.questions.length === 1, q.data.questions);
  const qid = q.data.questions[0].id;
  const answered = await owner(`/api/grants/applications/${appId}/questions/${qid}`, { method: "PATCH", body: { answer: "We train RBTs." } });
  check("and answered", answered.data.questions[0].answer === "We train RBTs.");

  // ------------------------------------------------------------------ tasks
  section("Tasks are the CRM's own tasks, not a second list");
  const withTask = await owner(`/api/grants/applications/${appId}/tasks`, {
    method: "POST", body: { title: "Confirm SAM registration", due_date: inDays(3) },
  });
  check("a task can be added", withTask.data.tasks.length === 1, withTask.data.tasks);
  const row = await pool.query("SELECT * FROM staff_tasks WHERE grant_id = $1", [good.id]);
  check("it really is a staff_task", row.rows.length === 1, row.rows.length);
  check("carrying the grant id", Number(row.rows[0].grant_id) === Number(good.id));
  check("with its due date", row.rows[0].due_date === inDays(3), row.rows[0].due_date);
  check("and open, so the normal reminders apply", row.rows[0].status === "open");

  // -------------------------------------------------------------- documents
  section("The document library");
  await owner("/api/grants/documents", {
    method: "POST", body: { name: "W-9 2026", category: "W-9", expires_at: inDays(400) },
  });
  await owner("/api/grants/documents", {
    method: "POST", body: { name: "Liability insurance", category: "Insurance certificate", expires_at: inDays(10) },
  });
  await owner("/api/grants/documents", {
    method: "POST", body: { name: "Expired business license", category: "Business license", expires_at: inDays(-5) },
  });
  const lib = (await owner("/api/grants/documents")).data;
  check("documents are stored", lib.documents.length === 3, lib.documents.length);
  const byName = Object.fromEntries(lib.documents.map((d) => [d.name, d]));
  check("a far-off expiry reads as fine", byName["W-9 2026"].status.key === "ok", byName["W-9 2026"].status);
  check("one inside 30 days is flagged expiring", byName["Liability insurance"].status.key === "expiring", byName["Liability insurance"].status);
  check("and a lapsed one is flagged expired", byName["Expired business license"].status.key === "expired", byName["Expired business license"].status);
  check("the expired one says how long ago", /Expired 5 days ago/.test(byName["Expired business license"].status.label), byName["Expired business license"].status.label);

  const attached = await owner(`/api/grants/applications/${appId}/documents`, {
    method: "POST", body: { document_id: byName["W-9 2026"].id },
  });
  check("a library document can be attached to an application", attached.data.documents.length === 1);
  const noted = await owner(`/api/grants/applications/${appId}/documents`, {
    method: "POST", body: { requirement: "Audited financials — we do not have these yet" },
  });
  check("and a requirement we cannot meet yet can be noted", noted.data.documents.length === 2);

  // --------------------------------------------------------------- calendar
  section("The calendar");
  await owner(`/api/grants/applications/${appId}`, {
    method: "PATCH", body: { loi_deadline: inDays(4), reporting_deadline: inDays(200), award_announcement_date: inDays(60) },
  });
  const cal = (await owner("/api/grants/calendar")).data;
  const forGood = cal.events.filter((e) => e.grant_id === good.id);
  const kinds = forGood.map((e) => e.kind);
  check("the deadline is on it", kinds.includes("deadline"), kinds);
  check("so is the letter of intent", kinds.includes("loi"), kinds);
  check("the award announcement", kinds.includes("award"), kinds);
  check("and the reporting date", kinds.includes("reporting"), kinds);
  check("events are sorted by date",
    cal.events.every((e, i) => i === 0 || String(cal.events[i - 1].date) <= String(e.date)));
  const loi = forGood.find((e) => e.kind === "loi");
  check("something four days out is marked urgent", loi.state === "urgent", loi);
  const reporting = forGood.find((e) => e.kind === "reporting");
  check("something far off is not", reporting.state === "upcoming", reporting);
  check("every event carries the eligibility verdict, so the calendar cannot mislead",
    cal.events.every((e) => !!e.eligibility_status));

  // ------------------------------------------------------- deadline alerts
  section("Deadline alerts");
  const dry = await owner("/api/grants/deadline-sweep", { method: "POST", body: { dry_run: true } });
  const dryNames = dry.data.sent.map((x) => x.name);
  check("the grant closing in 10 days is due a notice", dryNames.includes("P2 Nevada Workforce Grant"), dryNames);
  check("the nonprofit-only one closing in 2 days is NOT chased",
    !dryNames.includes("P2 Nonprofit Only Fund"), dryNames);
  check("nor is one 45 days out", !dryNames.includes("P2 Simple Grant"), dryNames);
  check("a dry run sends nothing",
    (await pool.query("SELECT COUNT(*) AS n FROM grant_deadline_notices")).rows[0].n === "0");

  const real = await owner("/api/grants/deadline-sweep", { method: "POST" });
  check("the real sweep sends it", real.data.sent.some((x) => x.name === "P2 Nevada Workforce Grant"), real.data.sent);
  check("at the 14-day stage, the most urgent one crossed",
    real.data.sent.find((x) => x.name === "P2 Nevada Workforce Grant").stage === "14", real.data.sent);
  const noticed = await pool.query("SELECT * FROM grant_deadline_notices");
  check("and records it before sending", noticed.rows.length === 1, noticed.rows.length);

  const secondRun = await owner("/api/grants/deadline-sweep", { method: "POST" });
  check("running it again sends nothing", secondRun.data.sent.length === 0, secondRun.data.sent);
  const thirdRun = await owner("/api/grants/deadline-sweep", { method: "POST" });
  check("and again", thirdRun.data.sent.length === 0, thirdRun.data.sent);
  check("still exactly one notice on record",
    (await pool.query("SELECT COUNT(*) AS n FROM grant_deadline_notices")).rows[0].n === "1");

  // ------------------------------------------------------------- submitting
  section("Submitting stops the chasing");
  const submitted = await owner(`/api/grants/applications/${appId}/submit`, {
    method: "POST", body: { confirmation_ref: "CONF-12345" },
  });
  check("the application is marked submitted", submitted.data.application.status === "Submitted");
  check("with who and when", !!submitted.data.application.submitted_at && !!submitted.data.application.submitted_by);
  check("the confirmation reference is kept", submitted.data.application.confirmation_ref === "CONF-12345");
  check("the submitted checklist line ticks itself",
    submitted.data.checklist.find((c) => c.key === "submitted").done === true);
  check("and the opportunity follows",
    (await owner(`/api/grants/opportunities/${good.id}`)).data.grant.status === "Submitted");

  // Move the deadline closer: a submitted application must still be left alone.
  await pool.query("DELETE FROM grant_deadline_notices");
  await owner(`/api/grants/opportunities/${good.id}`, { method: "PATCH", body: { deadline: inDays(1) } });
  const afterSubmit = await owner("/api/grants/deadline-sweep", { method: "POST", body: { dry_run: true } });
  check("a submitted grant is never chased again, even at one day out",
    !afterSubmit.data.sent.some((x) => x.name === "P2 Nevada Workforce Grant"), afterSubmit.data.sent);

  section("The applications list");
  const list = (await owner("/api/grants/applications")).data;
  check("lists the workspaces", list.applications.length === 2, list.applications.length);
  const one = list.applications.find((x) => x.id === appId);
  check("with checklist progress", one.progress.total > 0 && one.progress.done >= 2, one.progress);
  check("and days left", typeof one.days_left === "number", one.days_left);

  await pool.end();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
