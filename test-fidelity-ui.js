// test-fidelity-ui.js -- RBT Fidelity on the personnel record.
//
// The section lives on the staff card, where somebody looking at an employee
// already is. Three things make it worth its own suite:
//
//   1. It renders NOTHING unless it applies. A staff card must not grow an
//      empty "RBT Fidelity" heading for the office manager, and a viewer
//      without the permission must not be told a screen exists that they
//      cannot open.
//   2. Every "hidden" assertion here can pass for the wrong reason -- a card
//      that failed to load is also a card with no Fidelity section -- so each
//      one is paired with a positive control on the same page.
//   3. Nothing on it is calculated in the browser. The figures it shows are
//      compared against what the API returned.
//
//   DATABASE_URL=... node server.js
//   node test-fidelity-ui.js
"use strict";

const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3009";
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

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  const signIn = async (p, email, password) => {
    await p.goto(BASE + "/", { waitUntil: "networkidle" });
    await p.fill('#login-form input[name="email"]', email);
    await p.fill('#login-form input[name="password"]', password);
    await p.click('#login-form button[type="submit"]');
    await p.waitForTimeout(2500);
  };
  const api = (p, path, opts) => p.evaluate(async ({ path, opts }) => {
    const r = await fetch(path, {
      method: (opts && opts.method) || "GET", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { path, opts: opts || null });

  await signIn(page, "admin@spectrumsquadlv.com", OWNER_PW);

  const stamp = String(await page.evaluate(() => Date.now())).slice(-6);
  const dayShift = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  // ---------------------------------------------------------------- fixtures
  const rubric = (await api(page, "/api/fidelity/rubric")).body;
  const allItems = rubric.sections.flatMap((s) => s.items.map((i) => ({ ...i, section: s.key })));
  const CRITICAL = new Set(["dtt_10", "beh_2", "beh_5", "data_4"]);
  const scoresTotalling = (total, zero = []) => {
    const s = {};
    for (const k of zero) s[k] = 0;
    const order = [...allItems].sort((a, b) => (CRITICAL.has(a.key) ? 0 : 1) - (CRITICAL.has(b.key) ? 0 : 1));
    let left = total;
    for (const it of order) {
      if (s[it.key] !== undefined) continue;
      const give = Math.max(0, Math.min(2, left));
      s[it.key] = give; left -= give;
    }
    return s;
  };

  const mkEmp = async (label, roleTitle) => {
    const r = await api(page, "/api/hr/employees", {
      method: "POST",
      body: { name: `FidUI ${label} ${stamp}`, email: `fidui.${label}.${stamp}@example.invalid`,
              role_title: roleTitle, status: "active", hire_date: dayShift(-500) },
    });
    const id = r.body && (r.body.id || (r.body.employee && r.body.employee.id));
    if (!id) throw new Error("could not create " + label + ": " + JSON.stringify(r.body));
    return id;
  };
  const doCheck = async (empId, date, total, extra = {}) => {
    const c = await api(page, "/api/fidelity/check", { method: "POST", body: { employee_id: empId, assessment_date: date } });
    const id = c.body.id;
    await api(page, `/api/fidelity/check/${id}`, { method: "PATCH", body: { scores: scoresTotalling(total, extra.zero || []) } });
    const f = await api(page, `/api/fidelity/check/${id}/finalize`, {
      method: "POST",
      body: {
        bcba_signed_name: "Signing BCBA", critical_fail_detail: extra.criticalDetail || "Documented.",
        action_plan_narrative: extra.plan || "Retraining scheduled.",
        action_plan_options: extra.planTypes || ["Modeling"],
        ...(extra.body || {}),
      },
    });
    if (f.status !== 200) throw new Error("finalize failed: " + JSON.stringify(f.body));
    return id;
  };

  const empScored   = await mkEmp("Scored", "RBT");
  const empNever    = await mkEmp("Never", "RBT");
  const empOffice   = await mkEmp("Office", "Office Manager");
  const empCritical = await mkEmp("Critical", "Registered Behavior Technician");

  // Four, so that "three most recent" is a limit being applied rather than
  // simply all there is.
  await doCheck(empScored, dayShift(-300), 42);
  await doCheck(empScored, dayShift(-200), 48);
  await doCheck(empScored, dayShift(-100), 54);
  const newestScored = await doCheck(empScored, dayShift(-10), 57);
  await doCheck(empCritical, dayShift(-5), 58, { zero: ["beh_5"], criticalDetail: "Attention followed screaming." });

  const truth = (await api(page, `/api/fidelity/employee/${empScored}`)).body;

  const openCard = async (id) => {
    await page.evaluate(() => document.querySelectorAll(".modal-backdrop").forEach((m) => m.remove()));
    await page.evaluate((eid) => window.openStaffModal(eid), id);
    await page.waitForTimeout(2200);
  };
  const wrapVisible = () => page.locator("[data-fid-wrap]").isVisible().catch(() => false);
  const cardLoaded = async () => page.locator('.modal-backdrop input[data-f="name"]').isVisible().catch(() => false);

  // ================================================================
  section("An RBT with a history");

  await openCard(empScored);
  check("the staff card opened at all", await cardLoaded());
  check("the RBT Fidelity section is on it", await wrapVisible() === true);
  const text = await page.locator("#staff-fidelity").innerText();

  check("it shows the latest score out of 60",
    text.includes(`${truth.summary.current.score} / ${truth.summary.current.max}`), text.slice(0, 300));
  check("...and the percentage the server calculated",
    text.includes(truth.summary.current.percentage + "%"), { want: truth.summary.current.percentage, got: text.slice(0, 200) });
  check("...and the rating", text.includes(truth.summary.current.rating_label), text.slice(0, 200));
  check("...and the trend, so nobody compares two numbers",
    text.includes(truth.summary.trend.label), { want: truth.summary.trend.label, got: text.slice(0, 300) });
  check("...and the average over how many checks",
    text.includes(`Average ${truth.summary.average}%`) && /over 4 checks/.test(text),
    { want: truth.summary.average, got: text.slice(0, 300) });
  check("...and when they were last observed, and by whom",
    /Last observed/.test(text) && text.includes(truth.summary.last_evaluator),
    { want: truth.summary.last_evaluator, got: text.slice(0, 400) });
  // The date the section prints must be the one the SERVER worked out, not a
  // date the browser derived from the interval itself.
  const MON = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dayLabel = (d) => { const p = String(d || "").slice(0, 10).split("-"); return p.length === 3 ? `${MON[+p[1]]} ${+p[2]}, ${p[0]}` : ""; };
  check("...and when the next check is due, computed by the server",
    truth.overdue_check ? /Due now/.test(text) : text.includes(dayLabel(truth.next_due)),
    { next_due: truth.next_due, overdue: truth.overdue_check, got: text.slice(0, 400) });

  check("the recent checks are listed", /RECENT CHECKS/i.test(text), text.slice(0, 500));
  check("exactly three rows are shown, however long the history is",
    await page.locator("#staff-fidelity [data-fid-open]").count() === 3,
    await page.locator("#staff-fidelity [data-fid-open]").count());
  check("...and the personnel record says how many it is not showing",
    /1 earlier check not shown/.test(text), text.slice(0, 800));
  check("the newest is first", (await page.locator("#staff-fidelity [data-fid-open]").first().getAttribute("data-fid-open")) === String(newestScored));
  check("the trend graph is drawn once there is more than one point",
    await page.locator("#staff-fidelity svg").count() === 1);
  check("the graph is fixed to a 50–100 scale, not auto-scaled",
    /60%[\s\S]*80%[\s\S]*90%/.test(await page.locator("#staff-fidelity svg").innerHTML()));

  check("both actions are offered",
    await page.locator("#staff-fidelity [data-fid-new]").isVisible() &&
    await page.locator("#staff-fidelity [data-fid-full]").isVisible());

  // The row opens the assessment that was actually signed.
  await page.locator(`#staff-fidelity [data-fid-open="${newestScored}"]`).click();
  await page.waitForTimeout(1500);
  const ro = await page.locator(".modal-backdrop").last().innerText();
  check("clicking a recent check opens that assessment", /Fidelity Check/.test(ro), ro.slice(0, 200));
  check("...showing the score that was signed", ro.includes("57/60"), ro.slice(0, 300));
  check("...and who signed it", ro.includes("Signing BCBA"), ro.slice(0, 500));
  await page.evaluate(() => document.querySelectorAll(".modal-backdrop").forEach((m) => m.remove()));

  // ================================================================
  section("An RBT nobody has ever observed");

  await openCard(empNever);
  check("the staff card opened", await cardLoaded());
  check("the section still appears — this is the case it exists for", await wrapVisible() === true);
  const neverText = await page.locator("#staff-fidelity").innerText();
  check("it says no check has ever been completed",
    /No Fidelity Check has ever been completed/i.test(neverText), neverText.slice(0, 300));
  check("...and calls it a gap in the record rather than a good score",
    /gap in the record, not a good score/i.test(neverText), neverText.slice(0, 300));
  check("no graph is drawn from nothing", await page.locator("#staff-fidelity svg").count() === 0);
  check("but a check can be started from here",
    await page.locator("#staff-fidelity [data-fid-new]").isVisible());

  // ================================================================
  section("A critical concern is visible on the personnel record");

  await openCard(empCritical);
  const critText = await page.locator("#staff-fidelity").innerText();
  check("a 96.7% check is still shown as Exceptional",
    critText.includes("96.7%") && critText.includes("Exceptional"), critText.slice(0, 300));
  check("...and the critical concern is NOT buried by it",
    /critical fidelity concern/i.test(critText), critText.slice(0, 400));
  check("...and the open Action Plan it created is surfaced",
    /Action Plan/i.test(critText), critText.slice(0, 400));

  // ================================================================
  section("Somebody the module does not apply to");

  await openCard(empOffice);
  check("the office manager's card opened (the control for the next assertion)", await cardLoaded());
  check("...and has its ordinary sections", await page.locator("#staff-docs").count() === 1);
  check("no RBT Fidelity heading appears on it", await wrapVisible() === false);
  check("...not even an empty one",
    (await page.locator("#staff-fidelity").innerText().catch(() => "")).trim() === "");

  // ================================================================
  section("Somebody without the permission");

  const hrEmail = `fidui.hr.${stamp}@example.invalid`;
  const mk = await api(page, "/api/admin/users", {
    method: "POST", body: { name: "FidUI HR " + stamp, email: hrEmail, password: "FidelityTest123!", role: "hr_admin" },
  });
  check("an HR account was created for the check", mk.status === 201, mk.body);

  const page2 = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  page2.on("pageerror", (e) => errors.push("pageerror(hr): " + e.message));
  await signIn(page2, hrEmail, "FidelityTest123!");

  const denied = await api(page2, `/api/fidelity/employee/${empScored}`);
  check("the API refuses them the RBT's Fidelity history", denied.status === 403, denied);

  await page2.evaluate((eid) => window.openStaffModal(eid), empScored);
  await page2.waitForTimeout(2500);
  check("they can still open the staff card (the control)",
    await page2.locator('.modal-backdrop input[data-f="name"]').isVisible().catch(() => false));
  check("...and the same card they CAN see has its ordinary sections",
    await page2.locator("#staff-docs").count() === 1);
  check("the Fidelity section is absent for them",
    await page2.locator("[data-fid-wrap]").isVisible().catch(() => false) === false);
  check("...with no 'access denied' notice either — it simply is not there",
    !/fidelity/i.test(await page2.locator(".modal-backdrop").first().innerText()),
    (await page2.locator(".modal-backdrop").first().innerText()).slice(0, 400));
  await page2.close();

  // ================================================================
  section("Amending a signed check, from the personnel record");

  await openCard(empScored);
  await page.locator(`#staff-fidelity [data-fid-open="${newestScored}"]`).click();
  await page.waitForTimeout(1400);
  let ro2 = page.locator(".modal-backdrop").last();
  check("a signed check offers to be amended", await ro2.locator("[data-fid-amend]").isVisible());
  check("...and says the original is never edited",
    /never edited/i.test(await ro2.innerText()), (await ro2.innerText()).slice(-400));

  // The reason is asked for, and refusing to give one stops there.
  page.once("dialog", async (d) => { await d.dismiss(); });
  await ro2.locator("[data-fid-amend]").click();
  await page.waitForTimeout(900);
  check("cancelling the reason prompt starts nothing",
    await page.locator("#fid-scoring").count() === 0);

  page.once("dialog", async (d) => { await d.accept("Section totals transposed from the paper form."); });
  await page.locator(".modal-backdrop").last().locator("[data-fid-amend]").click();
  await page.waitForTimeout(2500);
  check("giving a reason opens the scoring screen on a corrected copy",
    await page.locator("#fid-scoring").count() === 1);
  const liveText = await page.locator("#fid-scoring #fid-live").innerText().catch(() => "");
  // Compared against what the ORIGINAL actually scored, read from the API,
  // rather than a number typed into this test.
  const origCheck = (await api(page, "/api/fidelity/check/" + newestScored)).body.check;
  check("...pre-filled with the original's scores rather than blank",
    liveText.includes(`${origCheck.total_score} / ${origCheck.max_score}`),
    { want: `${origCheck.total_score} / ${origCheck.max_score}`, got: liveText.slice(0, 300) });
  check("...and it is already complete, so the rating shows immediately",
    liveText.includes(origCheck.percentage + "%"), { want: origCheck.percentage, got: liveText.slice(0, 300) });

  // Sign the amendment through the API so the superseded state actually
  // exists. Without this the assertions below would be skipped rather than
  // run, and a skipped assertion looks exactly like a passing one.
  await page.evaluate(() => document.querySelectorAll(".modal-backdrop").forEach((m) => m.remove()));
  // Asking to amend again hands back the amendment already open rather than
  // forking the record, which is also how the test learns its id: an unsigned
  // check is not in the history, because the history is what was signed.
  const reopened = await api(page, `/api/fidelity/check/${newestScored}/amend`,
    { method: "POST", body: { reason: "Section totals transposed from the paper form." } });
  check("asking again returns the amendment already open, not a second one",
    reopened.status === 200 && reopened.body.already_open === true, reopened.body);
  const draftAmend = reopened.body.id;
  check("the amendment exists as an unsigned check", !!draftAmend, reopened.body);

  const signed = await api(page, `/api/fidelity/check/${draftAmend}/finalize`, {
    method: "POST", body: { bcba_signed_name: "Correcting BCBA" },
  });
  check("the amendment signs, and reports what it superseded",
    signed.status === 200 && signed.body.superseded_check_id === newestScored, signed.body);

  const afterUI = await api(page, "/api/fidelity/employee/" + empScored);
  const supersededRow = (afterUI.body.history || []).find((h) => h.superseded_by_check_id);
  check("the original is now marked superseded in the record", !!supersededRow, (afterUI.body.history || []).map((h) => h.id));

  await openCard(empScored);
  const sectionText = await page.locator("#staff-fidelity").innerText();
  check("the personnel record now shows the corrected score",
    sectionText.includes(`${signed.body.calc.total_score} / 60`), sectionText.slice(0, 200));

  await page.locator(`#staff-fidelity [data-fid-open="${supersededRow.id}"]`).first().click();
  await page.waitForTimeout(1500);
  const supModal = page.locator(".modal-backdrop").last();
  const supText = await supModal.innerText();
  check("a superseded check says so at the top",
    /This assessment was amended/i.test(supText), supText.slice(0, 400));
  check("...and still shows the score that was signed, unedited",
    supText.includes(`${supersededRow.total_score}/${supersededRow.max_score}`), supText.slice(0, 400));
  check("...and offers to open the correction",
    await supModal.locator("[data-fid-open-other]").count() >= 1);
  check("...and no longer offers to be amended again",
    await supModal.locator("[data-fid-amend]").count() === 0);
  await page.evaluate(() => document.querySelectorAll(".modal-backdrop").forEach((m) => m.remove()));

  // ================================================================
  section("Asking somebody to observe, and seeing what was asked of you");

  await page.evaluate(() => document.querySelectorAll(".modal-backdrop").forEach((m) => m.remove()));
  await page.evaluate(() => { location.hash = "#/fidelity"; });
  await page.waitForTimeout(2200);
  check("the page offers a way to ask somebody else",
    await page.locator("#fid-assign").isVisible());

  await page.locator("#fid-assign").click();
  await page.waitForTimeout(1600);
  const asModal = page.locator(".modal-backdrop").last();
  check("the assignment form opens", await asModal.locator("#fid-as-emp").isVisible());
  check("...and says the observation date is recorded later, not now",
    /observation date is recorded when they score it/i.test(await asModal.innerText()),
    (await asModal.innerText()).slice(0, 600));

  // Only people who could actually open the check are offered, and the server
  // is what decides that — the screen must not re-derive a permission rule.
  const evalList = (await api(page, "/api/fidelity/evaluators")).body.evaluators || [];
  const offered = await asModal.locator("#fid-as-user option").count();
  check("the module serves the list of people who can evaluate", evalList.length >= 1, evalList);
  check("only those people are offered", offered === evalList.length + 1,
    { offered: offered - 1, eligible: evalList.length });
  check("...and the HR account with no Fidelity access is not among them",
    !(await asModal.locator("#fid-as-user").innerText()).includes(`FidUI HR ${stamp}`),
    await asModal.locator("#fid-as-user").innerText());

  // Assign to the owner, who is the account this page is signed in as, so the
  // result is visible on the same screen.
  const me = evalList.find((u) => u.email === "admin@spectrumsquadlv.com");
  check("the signed-in owner is one of them", !!me, evalList);
  await asModal.locator("#fid-as-emp").selectOption(String(empNever));
  await asModal.locator("#fid-as-user").selectOption(String(me.id));
  await asModal.locator("#fid-as-note").fill("Focus on prompt fading.");
  page.once("dialog", async (d) => { await d.accept(); });
  await asModal.locator("#fid-as-go").click();
  await page.waitForTimeout(2600);

  const listed = (await api(page, "/api/fidelity/my-assignments")).body.assignments || [];
  check("the assignment exists for the person it was given to", listed.length >= 1, listed);

  // The dashboard has to show work in flight, or an assignment is only visible
  // to the person who was given it and invisible to whoever asked.
  const flight = (await api(page, "/api/fidelity/dashboard")).body.cards;
  check("the dashboard counts it as asked for and not done", flight.assigned_open >= 1, flight);

  await page.evaluate(() => { location.hash = "#/dashboard"; });
  await page.waitForTimeout(900);
  await page.evaluate(() => { location.hash = "#/fidelity"; });
  await page.waitForTimeout(2600);
  const fidText = await page.locator("#fid-body").innerText();
  check("what was asked of you leads the page, above the roster",
    /Asked of you/i.test(fidText), fidText.slice(0, 400));
  check("...naming the RBT to observe", fidText.includes(`FidUI Never ${stamp}`), fidText.slice(0, 500));
  check("...and the note that came with it", /prompt fading/i.test(fidText), fidText.slice(0, 600));
  check("...with a way to start it", await page.locator("#fid-body [data-fid-do]").count() >= 1);
  check("...and the page shows work in flight as a figure, not only as a row",
    /Assigned, not done|Assignments overdue/.test(fidText), fidText.slice(0, 700));

  check("...and a way to say it cannot be done, which the chase email tells them to use",
    await page.locator("#fid-body [data-fid-release]").count() >= 1);

  await page.locator("#fid-body [data-fid-do]").first().click();
  await page.waitForTimeout(2500);
  check("starting an assignment opens the scoring screen",
    await page.locator("#fid-scoring").count() === 1);
  check("...blank, because this observation has not been done",
    /0 of 30 scored|0 \/ 60/.test(await page.locator("#fid-scoring #fid-live").innerText()),
    await page.locator("#fid-scoring #fid-live").innerText());
  await page.evaluate(() => document.querySelectorAll(".modal-backdrop").forEach((m) => m.remove()));

  // Saying it cannot be done, from the screen rather than only over the API.
  const beforeRelease = ((await api(page, "/api/fidelity/my-assignments")).body.assignments || []).length;
  page.once("dialog", async (d) => { await d.accept("Out on leave."); });
  await page.locator("#fid-body [data-fid-release]").first().click();
  await page.waitForTimeout(2600);
  const afterRelease = ((await api(page, "/api/fidelity/my-assignments")).body.assignments || []).length;
  check("declining from the screen takes it off the list",
    afterRelease === beforeRelease - 1, { before: beforeRelease, after: afterRelease });
  check("...and the RBT is still shown as needing an observation",
    ((await api(page, "/api/fidelity/dashboard")).body.employees || [])
      .some((e) => e.employee_id === empNever && e.overdue_check === true),
    (await api(page, "/api/fidelity/dashboard")).body.cards);

  // ================================================================
  section("Training needs — the report the rubric was held as data for");

  // Three RBTs who each lose the SAME competency, so the report has a
  // team-wide weakness to find. Without this the two assertions below would
  // short-circuit to true and pass without testing anything.
  for (const label of ["Team1", "Team2", "Team3"]) {
    const id = await mkEmp(label, "RBT");
    const c = await api(page, "/api/fidelity/check", { method: "POST", body: { employee_id: id, assessment_date: dayShift(-3) } });
    const sc = scoresTotalling(60);
    sc.dtt_3 = 0;
    await api(page, `/api/fidelity/check/${c.body.id}`, { method: "PATCH", body: { scores: sc } });
    await api(page, `/api/fidelity/check/${c.body.id}/finalize`, { method: "POST", body: { bcba_signed_name: "Signing BCBA" } });
  }

  await page.evaluate(() => document.querySelectorAll(".modal-backdrop").forEach((m) => m.remove()));
  await page.evaluate(() => { location.hash = "#/fidelity"; });
  await page.waitForTimeout(2200);
  check("the Fidelity page offers the training-needs report",
    await page.locator("#fid-insights").isVisible());

  await page.locator("#fid-insights").click();
  await page.waitForTimeout(2000);
  const insModal = page.locator(".modal-backdrop").last();
  const insText = await insModal.innerText();
  const insData = (await api(page, "/api/fidelity/insights")).body;

  check("it says how much it read, so nobody reads it as more than it is",
    insText.includes(`${insData.checks} finalized check`), insText.slice(0, 300));
  check("...and states the threshold for calling something a pattern",
    insText.includes(`${insData.min_observations} observations`), insText.slice(0, 400));
  check("every competency is listed, not only the failing ones",
    await insModal.locator("table tbody tr").count() === 30,
    await insModal.locator("table tbody tr").count());
  check("the weakest are called out separately", /Where the team loses most points/i.test(insText), insText.slice(0, 500));
  check("...and each section gets a figure", /By section/i.test(insText), insText.slice(0, 900));

  // The distinction the report exists for.
  const teamWide = (insData.ranked || []).find((i) => i.enough_evidence && i.people_scoring_zero >= 3);
  const onePerson = (insData.concentrated || [])[0];
  check("there is a team-wide weakness in this data to check against", !!teamWide, (insData.ranked || []).slice(0, 3));
  check("a weakness several people share is marked as a training job",
    /TRAIN THE TEAM/.test(insText), insText.slice(0, 1400));
  check("...and named as a training session rather than a set of Action Plans",
    /a training session, not a set of Action Plans/i.test(insText), insText.slice(0, 1400));
  check("there is a single-person weakness in this data too", !!onePerson, insData.concentrated);
  check("a weakness only one person has is separated out by name",
    !!onePerson && insText.includes(String(onePerson.name)),
    { concentrated: insData.concentrated, sample: insText.slice(0, 1400) });
  check("...and described as a conversation rather than a training day",
    /conversation, not a training day/i.test(insText), insText.slice(0, 1400));

  await page.evaluate(() => document.querySelectorAll(".modal-backdrop").forEach((m) => m.remove()));

  // ================================================================
  section("The raise settings — a configurable matrix nobody could configure");

  await page.evaluate(() => document.querySelectorAll(".modal-backdrop").forEach((m) => m.remove()));
  await page.evaluate(() => { location.hash = "#/fidelity"; });
  await page.waitForTimeout(2200);
  check("the Fidelity page has a way in to the raise settings",
    await page.locator("#fid-settings").isVisible());

  await page.locator("#fid-settings").click();
  await page.waitForTimeout(1600);
  const setModal = page.locator(".modal-backdrop").last();
  const setText = await setModal.innerText();

  const cfg = (await api(page, "/api/fidelity/settings")).body;
  check("the matrix is shown as rows that can be edited",
    await setModal.locator("#fid-bands tr").count() === (cfg.bands || []).length,
    { rows: await setModal.locator("#fid-bands tr").count(), bands: (cfg.bands || []).length });
  check("every performance category is listed",
    await setModal.locator("[data-w]").count() === (cfg.categories || []).length,
    { inputs: await setModal.locator("[data-w]").count(), cats: (cfg.categories || []).length });
  // Attendance used to be the example of a dead category here. It is live now
  // -- scored as the share of months at a band the policy calls acceptable --
  // so the rule is asserted against one that is still genuinely unwired.
  check("a category with no source of data cannot be given a weight",
    await setModal.locator('[data-w="reliability"]').isDisabled());
  check("...and says why on the screen, not only in the API",
    /not available yet/i.test(setText), setText.slice(0, 900));
  check("a category that CAN produce a number is editable",
    !(await setModal.locator('[data-w="supervision_compliance"]').isDisabled()));
  check("...including Attendance, now that it has a source",
    !(await setModal.locator('[data-w="attendance"]').isDisabled()));

  check("the weights are totalled for the reader", /Total:/.test(setText), setText.slice(0, 600));
  const totalNow = await setModal.locator("#fid-weight-total").innerText();
  check("...and the total starts correct at 100%", totalNow.trim() === "100%", totalNow);

  // Break the total and confirm the screen says so BEFORE a save is attempted.
  await setModal.locator('[data-w="fidelity"]').fill("80");
  await page.waitForTimeout(400);
  const warn = await setModal.locator("#fid-weight-warn").innerText();
  check("changing a weight to leave the total short is called out immediately",
    /short/.test(warn), { warn, total: await setModal.locator("#fid-weight-total").innerText() });
  check("...saying how far off it is, so nobody adds the column up",
    /20 short/.test(warn), warn);

  // And the server refuses it too — the screen is a courtesy, not the rule.
  const badSave = await api(page, "/api/fidelity/settings", { method: "PUT", body: { weights: { fidelity: 80 } } });
  check("the server refuses a total that is not 100 regardless of the screen",
    badSave.status === 400, badSave.body);

  await setModal.locator('[data-w="fidelity"]').fill("100");
  await page.waitForTimeout(300);
  check("putting it back to 100 clears the warning",
    (await setModal.locator("#fid-weight-warn").innerText()).trim() === "");

  // A real edit, saved and read back.
  await setModal.locator("#fid-interval").fill("45");
  await setModal.locator("#fid-max").fill("6");
  await setModal.locator("#fid-method").selectOption("last3_average");
  await setModal.locator("#fid-set-save").click();
  await page.waitForTimeout(2200);
  check("the settings modal closes on save", await page.locator("#fid-bands").count() === 0);

  const saved = (await api(page, "/api/fidelity/settings")).body;
  check("the interval was saved", Number(saved.check_interval_days) === 45, saved.check_interval_days);
  check("the maximum raise was saved", Number(saved.max_raise_percent) === 6, saved.max_raise_percent);
  check("the Fidelity method was saved", saved.fidelity_method === "last3_average", saved.fidelity_method);
  check("the matrix survived the round trip intact",
    (saved.bands || []).length === (cfg.bands || []).length &&
    Number(saved.bands[0].min) === Number(cfg.bands[0].min), saved.bands);

  // Put it back so later runs and other suites read a default install.
  await api(page, "/api/fidelity/settings", { method: "PUT", body: {
    check_interval_days: 90, max_raise_percent: 10, fidelity_method: "review_period_average",
  }});

  // ================================================================
  section("The scoring screen — where evaluators actually spend their time");

  // The most-used screen in the module, and until now covered only by
  // accident: other sections opened it and checked one number. What an
  // evaluator does here is tap thirty scores and watch the total, so that is
  // what this checks. Reached the way a real one reaches it — an assignment
  // on their own page — rather than through a global invented for the test.
  await page.evaluate(() => document.querySelectorAll(".modal-backdrop").forEach((m) => m.remove()));
  const empScore = await mkEmp("Scoring", "RBT");
  const scoreAssign = await api(page, "/api/fidelity/assign", {
    method: "POST", body: { employee_id: empScore, evaluator_user_id: me.id },
  });
  check("a check to score is waiting on the page", scoreAssign.status === 201, scoreAssign.body);

  await page.evaluate(() => { location.hash = "#/dashboard"; });
  await page.waitForTimeout(700);
  await page.evaluate(() => { location.hash = "#/fidelity"; });
  await page.waitForTimeout(2600);
  await page.locator(`#fid-body [data-fid-do="${scoreAssign.body.id}"]`).first().click();
  await page.waitForTimeout(2600);
  check("the scoring screen is open", await page.locator("#fid-scoring").count() === 1);

  const rubricEl = page.locator("#fid-scoring #fid-rubric");
  check("all thirty competencies are on the form",
    await rubricEl.locator("[data-fid-score][data-v='2']").count() === 30,
    await rubricEl.locator("[data-fid-score][data-v='2']").count());
  check("each one offers 0, 1 and 2",
    await rubricEl.locator("[data-fid-score]").count() === 90,
    await rubricEl.locator("[data-fid-score]").count());

  // The claim in the PR description: critical items are marked ON THE FORM, so
  // an evaluator sees it before scoring rather than after.
  const rubricText = (await rubricEl.innerText()).replace(/\n/g, " ");
  check("the four critical competencies are marked before they are scored",
    (rubricText.match(/CRITICAL ITEM/g) || []).length === 4,
    (rubricText.match(/CRITICAL ITEM/g) || []).length);
  check("...against the right competency",
    /Does not reinforce maladaptive behavior\s*CRITICAL ITEM/i.test(rubricText),
    rubricText.slice(0, 400));

  const live = page.locator("#fid-scoring #fid-live");
  check("nothing is scored yet", /0 of 30 scored/.test(await live.innerText()), await live.innerText());
  check("...and no rating is shown, because the score is not knowable yet",
    !/EXCEPTIONAL|MEETS STANDARD|NEEDS IMPROVEMENT/i.test(await live.innerText()),
    await live.innerText());

  await rubricEl.locator("[data-fid-score='prep_1'][data-v='2']").click();
  await page.waitForTimeout(1000);
  check("tapping a score updates the running total straight away",
    /2 \/ 60/.test(await live.innerText()), await live.innerText());
  check("...and counts it", /1 of 30 scored/.test(await live.innerText()), await live.innerText());
  check("...and the section subtotal moves with it",
    /2 \/ 10/.test(await rubricEl.innerText()), (await rubricEl.innerText()).slice(0, 200));

  // A zero on a critical competency is called out while scoring, not at the end.
  await rubricEl.locator("[data-fid-score='beh_5'][data-v='0']").click();
  await page.waitForTimeout(1000);
  check("a zero on a critical competency is flagged immediately",
    /CRITICAL/i.test(await live.innerText()), await live.innerText());
  check("...naming what it was", /maladaptive behavior/i.test(await live.innerText()), await live.innerText());

  // Un-scoring the critical zero must take the box away again, or every clean
  // assessment would carry a demand to describe a concern that is not there.
  await rubricEl.locator("[data-fid-score='beh_5'][data-v='2']").click();
  await page.waitForTimeout(1000);
  check("clearing the critical zero hides the box again",
    !(await page.locator("#fid-scoring #fid-critical-detail-wrap").isVisible()));
  await rubricEl.locator("[data-fid-score='beh_5'][data-v='0']").click();
  await page.waitForTimeout(1000);

  const keys = await rubricEl.evaluate((el) =>
    [...new Set([...el.querySelectorAll("[data-fid-score]")].map((b) => b.dataset.fidScore))]);
  for (const k of keys) {
    if (k === "prep_1" || k === "beh_5") continue;
    await rubricEl.locator(`[data-fid-score='${k}'][data-v='2']`).click();
  }
  await page.waitForTimeout(1800);
  const liveDone = await live.innerText();
  check("with every item scored the rating appears", /EXCEPTIONAL/i.test(liveDone), liveDone);
  check("...at 58 out of 60", /58 \/ 60/.test(liveDone), liveDone);
  check("...and 96.7%", /96\.7%/.test(liveDone), liveDone);
  check("...while STILL showing the critical concern a high score would otherwise bury",
    /CRITICAL/i.test(liveDone), liveDone);

  // The screen never calculates: the server holds the same answer.
  const serverSide = (await api(page, `/api/fidelity/check/${scoreAssign.body.id}`)).body.check;
  check("the server holds the same total the screen showed",
    serverSide.calc.total_score === 58 && serverSide.calc.percentage === 96.7, serverSide.calc);
  check("...and the same critical verdict", serverSide.calc.critical_fail === true, serverSide.calc);

  // The field lives in the feedback block rather than the signature block —
  // it is a fact about the observation, not about who signed it.
  const scoringModal = page.locator("#fid-scoring");
  // The bug this found: the box to describe a critical concern was rendered
  // only when the modal opened, so discovering the concern BY SCORING left
  // finalize refusing and pointing at a field that was not on the screen.
  check("a critical result asks for it to be described before signing",
    await scoringModal.locator("#fid-critical-detail").count() === 1);
  check("...and the box is actually visible, having appeared as it was scored",
    await scoringModal.locator("#fid-critical-detail-wrap").isVisible());
  check("...and the Action Plan is marked required, for the same reason",
    await scoringModal.locator("#fid-plan-required").isVisible());
  check("...and unsafe practice is asked directly, since no score can carry it",
    await scoringModal.locator("#fid-unsafe").count() === 1);
  check("...and the sign button is live now every item is scored",
    await scoringModal.locator("#fid-finalize").isEnabled());
  await page.evaluate(() => document.querySelectorAll(".modal-backdrop").forEach((m) => m.remove()));

  check("no uncaught JavaScript errors", errors.length === 0, errors.join(" ;; "));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness error:", (e && e.stack) || e); process.exit(1); });
