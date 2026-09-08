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

  check("no uncaught JavaScript errors", errors.length === 0, errors.join(" ;; "));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness error:", (e && e.stack) || e); process.exit(1); });
