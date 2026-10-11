// The Onboarding Academy in a real browser.
//
// test-academy.js proves the server refuses what it should. This proves the
// screen never OFFERS what the server would refuse -- a different failure and
// a worse one to live with. A button that produces an error message every
// time somebody presses it is a promise the CRM then breaks, and the person
// pressing it is a week into a new job and already unsure.
//
// So the claims here are about absence as much as presence:
//
//   * no control anywhere completes a competency for its own subject
//   * the week they are on is the one that opens, without being chosen
//   * a mentor is told they have none, rather than shown an empty space
//   * the roster appears for leadership and not for an ordinary new starter
//
//   BASE=http://127.0.0.1:3009 DATABASE_URL=... node test-academy-ui.js
"use strict";
const { chromium } = require("playwright");
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const stamp = Date.now().toString(36);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : "")); }
  };
  const section = (t) => console.log("\n== " + t + " ==");
  const BASE = process.env.BASE || "http://localhost:3009";

  const crypto = require("crypto");
  const hp = (pw) => {
    const salt = crypto.randomBytes(16).toString("hex");
    return { salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") };
  };

  const login = async (email, password) => {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.evaluate(async () => {
      try { await fetch("/api/auth/logout", { method: "POST", credentials: "include" }); } catch (e) {}
    });
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.waitForSelector('#login-form input[name="email"]', { timeout: 15000 });
    await page.fill('#login-form input[name="email"]', email);
    await page.fill('#login-form input[name="password"]', password);
    await page.click('#login-form button[type="submit"]');
    await page.waitForTimeout(1600);
  };
  const openAcademy = async () => {
    await page.goto(BASE + "/#/bcba-hub");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".bh-tabs", { timeout: 15000 });
    await page.click('.bh-tab[data-tab="academy"]');
    await page.waitForSelector(".ac-wrap", { timeout: 15000 });
    await page.waitForTimeout(700);
  };

  try {
    // ---- fixtures -------------------------------------------------------
    const purge = async () => {
      const ids = "(SELECT id FROM hr_employees WHERE name LIKE 'AcadUI %')";
      const enrSel = `(SELECT id FROM academy_enrollments WHERE employee_id IN ${ids})`;
      await pool.query(`DELETE FROM academy_dev_plans WHERE enrollment_id IN ${enrSel}`).catch(() => {});
      await pool.query(`DELETE FROM academy_review_ratings WHERE review_id IN (SELECT id FROM academy_reviews WHERE enrollment_id IN ${enrSel})`).catch(() => {});
      await pool.query(`DELETE FROM academy_reviews WHERE enrollment_id IN ${enrSel}`).catch(() => {});
      await pool.query(`DELETE FROM academy_progress WHERE enrollment_id IN (SELECT id FROM academy_enrollments WHERE employee_id IN ${ids})`).catch(() => {});
      await pool.query(`DELETE FROM academy_audit WHERE enrollment_id IN (SELECT id FROM academy_enrollments WHERE employee_id IN ${ids})`).catch(() => {});
      await pool.query(`DELETE FROM academy_enrollments WHERE employee_id IN ${ids}`).catch(() => {});
      await pool.query("DELETE FROM hr_employees WHERE name LIKE 'AcadUI %'").catch(() => {});
      await pool.query("DELETE FROM users WHERE email LIKE 'acadui-%'").catch(() => {});
    };
    await purge();

    const newEmail = `acadui-new-${stamp}@example.invalid`;
    const p1 = hp("AcadPass123!");
    await pool.query(
      `INSERT INTO users (name, email, password_hash, password_salt, role, created_at)
       VALUES ('AcadUI Newbie',$1,$2,$3,'clinical', now())`, [newEmail, p1.hash, p1.salt]);
    const today = new Date().toISOString().slice(0, 10);
    const empId = (await pool.query(
      `INSERT INTO hr_employees (name, email, role_title, hr_hire_date, status)
       VALUES ('AcadUI Newbie',$1,'BCBA',$2,'active') RETURNING id`, [newEmail, today])).rows[0].id;

    // ENROLLED THROUGH THE REAL ROUTE, not with an INSERT. Enrolling does
    // more than write one row -- it schedules the four check-ins -- and a
    // fixture that writes the row directly tests a state the product never
    // produces. The first version of this file did exactly that and the
    // check-ins were simply absent.
    let apiCookie = "";
    const asOwner = async (path, opts = {}) => {
      const r = await fetch(BASE + path, {
        method: opts.method || "GET",
        headers: { ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(apiCookie ? { Cookie: apiCookie } : {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const sc = r.headers.get("set-cookie"); if (sc) apiCookie = sc.split(";")[0];
      let d = null; try { d = await r.json(); } catch (e) {}
      return { status: r.status, data: d };
    };
    await asOwner("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
    const enrolRes = await asOwner("/api/academy/enrollments", { method: "POST", body: { employee_id: empId } });
    check("the fixture enrols through the real route", enrolRes.status === 200, enrolRes.data);
    const enr = { id: enrolRes.data.enrollment.id };

    // ==================================================================
    section("THE NEW BCBA'S OWN SCREEN");
    await login(newEmail, "AcadPass123!");
    await openAcademy();

    const hero = await page.textContent(".ac-wrap");
    check("the Academy opens inside the BCBA Hub", /Welcome to the Squad/.test(hero), hero.slice(0, 160));
    check("it shows a percentage", /\d+%/.test(await page.textContent(".ac-big")), await page.textContent(".ac-big"));
    check("and a progress bar", await page.locator(".ac-bar > div").count() > 0);
    check("with four weekly milestones", await page.locator(".ac-week").count() === 4,
      await page.locator(".ac-week").count());
    check("the week they are actually on is open, without choosing it",
      /Week 1 —/.test(await page.textContent(".ac-wrap")), (await page.textContent(".ac-wrap")).slice(0, 300));
    check("they are told no mentor is assigned yet, rather than shown a blank",
      /No mentor has been assigned/.test(await page.textContent(".ac-wrap")));

    section("WHAT THE SCREEN WILL NOT OFFER");
    // The one claim worth having in a browser: there is no control that
    // completes a competency for the person it is about. Not disabled --
    // absent.
    const compBlocks = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll(".ac-item").forEach((el) => {
        const strong = el.querySelector('div[style*="font-weight:700"]');
        if (!strong) return;
        out.push({
          title: strong.textContent.trim().slice(0, 40),
          buttons: [...el.querySelectorAll("button")].map((b) => ({
            text: b.textContent.trim(),
            tick: b.hasAttribute("data-tick"),
            ready: b.hasAttribute("data-ready"),
          })),
        });
      });
      return out;
    });
    check("the week's competency is on the page", compBlocks.length >= 1, compBlocks);
    check("IT HAS NO 'MARK DONE' CONTROL AT ALL",
      compBlocks.every((c) => c.buttons.every((b) => !b.tick)), compBlocks);
    check("only a 'ready for review' one",
      compBlocks.some((c) => c.buttons.some((b) => b.ready)), compBlocks);

    section("TICKING A TOPIC MOVES THE BAR");
    const before = await page.textContent(".ac-big");
    await page.click("[data-tick]");
    await page.waitForTimeout(900);
    const after = await page.textContent(".ac-big");
    check("completing a checklist topic raises the percentage",
      parseInt(after, 10) > parseInt(before, 10), { before, after });
    check("and the item now reads Completed",
      /Completed/.test(await page.textContent(".ac-wrap")));

    section("ASKING FOR A COMPETENCY REVIEW");
    await page.click("[data-ready]");
    await page.waitForTimeout(900);
    const txt = await page.textContent(".ac-wrap");
    check("it goes to Awaiting Supervisor Review", /Awaiting Supervisor Review/.test(txt), txt.slice(0, 200));
    check("and says who it is waiting on", /waiting on your supervisor/i.test(txt));
    // The percentage must NOT move: ready is not done, and a bar that moved
    // here would tell somebody they had finished something they had not.
    const afterReady = await page.textContent(".ac-big");
    check("READY IS NOT DONE — the percentage does not move for it",
      afterReady === after, { after, afterReady });

    section("ASKING FOR HELP IS THE EASIEST THING ON THE PAGE");
    // Somebody who has to hunt for this, or who reads it as an admission
    // about themselves, does not press it -- and the whole value is in the
    // pressing. So it is checked for prominence and for wording, not just
    // for existing.
    check("there is an 'I wasn't trained on this' control",
      await page.locator("#ac-gap").count() === 1, await page.locator("#ac-gap").count());
    check("and an 'ask my mentor' one beside it",
      await page.locator("#ac-ask").count() === 1);
    check("the page says nobody expects them to work it out alone",
      /work our systems out on your own/i.test(await page.textContent(".ac-wrap")));

    await page.click("#ac-gap");
    await page.waitForTimeout(300);
    const gapForm = await page.textContent(".ac-wrap");
    check("the gap form says where it goes",
      /mentor and to clinical leadership/i.test(gapForm), gapForm.slice(0, 200));
    check("AND THAT IT IS NOT A MARK AGAINST THEM — the wording is the feature",
      /not a mark against you/i.test(gapForm), gapForm.slice(0, 200));

    await page.fill("#ac-g-topic", "Authorization unit tracking");
    await page.fill("#ac-g-desc", "Nobody showed me where remaining units are.");
    await page.click("#ac-g-send");
    await page.waitForTimeout(1200);
    check("filing one is confirmed on screen",
      /Not trained on:|You will hear back/i.test(await page.textContent(".ac-wrap")),
      (await page.textContent(".ac-wrap")).slice(0, 300));

    section("CHECK-INS APPEAR WITHOUT ANYBODY SCHEDULING THEM");
    const ci = await page.textContent(".ac-wrap");
    check("all four are listed", /Day 7/.test(ci) && /Day 14/.test(ci) && /Day 21/.test(ci) && /Day 30/.test(ci),
      ci.slice(0, 300));
    check("and it says both sides fill one in",
      /it is a conversation, not a form/i.test(ci));

    section("A NEW STARTER IS NOT SHOWN THE ROSTER");
    check("there is no 'everyone onboarding' view for them",
      await page.locator('[data-view="roster"]').count() === 0,
      await page.locator('[data-view="roster"]').count());

    section("CLINICAL LEADERSHIP SEES EVERYBODY");
    await login("admin@spectrumsquadlv.com", "TestOwner123!");
    await openAcademy();
    check("the owner gets the roster tab", await page.locator('[data-view="roster"]').count() === 1);
    await page.click('[data-view="roster"]');
    await page.waitForTimeout(500);
    const roster = await page.textContent(".ac-wrap");
    check("the new starter is on it", /AcadUI Newbie/.test(roster), roster.slice(0, 300));
    check("with a day number and a percentage to act on",
      /week \d/.test(roster) && /%/.test(roster), roster.slice(0, 300));
    check("and the missing mentor is called out",
      /none assigned/i.test(roster), roster.slice(0, 400));

    // ==================================================================
    // THE 30-DAY REVIEW PANEL
    //
    // The claim, same as everywhere else in this file: the screen does not
    // offer what the server would refuse. An approve button that always
    // errors is worse than no approve button, and the person it would lie to
    // is signing off somebody's probation.
    //
    // The first version of this section proved none of that. It checked the
    // employee's own screen for rating controls -- but a draft review stops
    // at "not finished yet" before it reaches them, so deleting the
    // permission check in the view changed nothing and the test still
    // passed. The cases below are the ones where the permission is the thing
    // that actually decides: a MENTOR on a draft (rates, cannot approve) and
    // the SUBJECT on a signed review (sees everything, touches nothing).
    section("A MENTOR IS GIVEN THE RATINGS AND NOT THE SIGN-OFF");
    const mentorEmail = `acadui-mentor-${stamp}@example.invalid`;
    const p2 = hp("AcadPass123!");
    await pool.query(
      `INSERT INTO users (name, email, password_hash, password_salt, role, created_at)
       VALUES ('AcadUI Mentor',$1,$2,$3,'clinical', now())`, [mentorEmail, p2.hash, p2.salt]);
    const mentorId = (await pool.query(
      `INSERT INTO hr_employees (name, email, role_title, hr_hire_date, status)
       VALUES ('AcadUI Mentor',$1,'BCBA',$2,'active') RETURNING id`, [mentorEmail, today])).rows[0].id;
    const pa = await asOwner(`/api/academy/enrollments/${enr.id}`, { method: "PATCH", body: { mentor_id: mentorId } });
    check("a mentor is assigned", pa.status === 200, pa.data);

    await login(mentorEmail, "AcadPass123!");
    await openAcademy();
    await page.click('[data-view="roster"]');
    await page.waitForTimeout(600);
    await page.click('[data-rv-open="' + enr.id + '"]');
    await page.waitForTimeout(900);
    const mv = await page.textContent(".ac-wrap");
    check("the mentor can open the review", /30-day review/i.test(mv), mv.slice(0, 160));
    check("all ten areas are listed",
      await page.locator("[data-domain]").count() === 10, await page.locator("[data-domain]").count());
    check("the mentor IS given the rating controls",
      await page.locator("[data-rsave]").count() === 10, await page.locator("[data-rsave]").count());
    check("THE MENTOR IS NOT GIVEN AN APPROVE BUTTON",
      await page.locator("#ac-rv-approve").count() === 0, await page.locator("#ac-rv-approve").count());
    check("and is told who does sign it off, rather than left to guess",
      /Clinical Director or an Assistant Clinical Director signs off/i.test(mv), mv.slice(0, 900));
    check("it says plainly there is no score", /no score and no pass mark/i.test(mv), mv.slice(0, 600));

    section("RATING SOMETHING BELOW INDEPENDENT ASKS FOR A PLAN ON THE SPOT");
    await page.selectOption('[data-rate="supervision"]', "needs_support");
    await page.fill('[data-rnote="supervision"]', "Has not yet run a supervision session alone.");
    await page.click('[data-rsave="supervision"]');
    await page.waitForTimeout(1100);
    const afterRate = await page.textContent(".ac-wrap");
    check("the rating is saved and shown back", /Requires Additional Support/.test(afterRate), afterRate.slice(0, 300));
    check("A DEVELOPMENT PLAN FORM APPEARS UNDER IT, unasked",
      await page.locator('[data-padd="supervision"]').count() === 1,
      await page.locator('[data-padd="supervision"]').count());
    check("asking for a deadline and a reassessment date, both",
      await page.locator('[data-pd="supervision"]').count() === 1
        && await page.locator('[data-pr="supervision"]').count() === 1);
    check("and saying why a plan with no date is worthless",
      /needing support.{0,12}in March/i.test(afterRate), afterRate.slice(0, 1200));

    section("THE BLOCKERS ARE NAMED, NOT HIDDEN BEHIND A GREYED-OUT BUTTON");
    // The mentor cannot approve, so the blocker list is not on their screen;
    // it belongs to whoever is signing. Checked as the owner below.
    await page.fill('[data-pa="supervision"]', "Run three supervision sessions with the mentor observing");
    await page.fill('[data-pd="supervision"]', "2026-11-15");
    await page.fill('[data-pr="supervision"]', "2026-11-22");
    await page.click('[data-padd="supervision"]');
    await page.waitForTimeout(1100);
    const planned = await page.textContent(".ac-wrap");
    check("the plan is saved with both its dates on show",
      /Due 2026-11-15/.test(planned) && /reassessed 2026-11-22/.test(planned), planned.slice(0, 600));

    section("THE SUBJECT, WHILE IT IS STILL A DRAFT");
    await login(newEmail, "AcadPass123!");
    await openAcademy();
    const own = await page.textContent(".ac-wrap");
    check("they are told when they will see it", /once it is signed/i.test(own), own.slice(-500));
    await page.click('[data-rv-open="' + enr.id + '"]');
    await page.waitForTimeout(900);
    const ownRv = await page.textContent(".ac-wrap");
    check("THEY CANNOT READ THE DRAFT RATING WRITTEN ABOUT THEM",
      !/Requires Additional Support/.test(ownRv), ownRv.slice(0, 400));
    check("they are told it is unfinished rather than shown an empty page",
      /not finished/i.test(ownRv), ownRv.slice(0, 400));

    section("THE OWNER SIGNS IT OFF, AND IS REFUSED UNTIL IT IS COMPLETE");
    // Earlier in this journey the new BCBA pressed "ready for review" on a
    // competency, and the approval gate quite rightly refuses to sign off an
    // onboarding with a review request nobody has answered. So answer it,
    // the way a supervisor would, before going anywhere near the approval.
    const pend = (await pool.query(
      "SELECT item_id FROM academy_progress WHERE enrollment_id = $1 AND status = 'awaiting_review'",
      [enr.id])).rows;
    check("one competency really is waiting on a supervisor", pend.length === 1, pend);
    // THE BLOCKERS ARE NAMED, NOT HIDDEN BEHIND A GREYED-OUT BUTTON.
    // Checked here, with nine areas still unrated, because that is the only
    // moment anything is blocking -- and a sign-off screen that will not say
    // what is wrong is the most frustrating object in software.
    await login("admin@spectrumsquadlv.com", "TestOwner123!");
    await openAcademy();
    await page.click('[data-view="roster"]');
    await page.waitForTimeout(600);
    await page.click('[data-rv-open="' + enr.id + '"]');
    await page.waitForTimeout(900);
    section("A GATE COMES WITH THE MEANS OF GETTING THROUGH IT");
    // The approval refuses to sign off while a competency review request is
    // unanswered. Before this card existed the only control that answered
    // one was rendered for nobody and wired to nothing, so the blocker could
    // not be cleared from the screen at all.
    const wait0 = await page.textContent(".ac-wrap");
    check("the panel shows what is waiting on them", /Waiting on you/i.test(wait0), wait0.slice(0, 500));
    check("naming the competency the new BCBA said they were ready for",
      await page.locator("[data-vok]").count() === 1, await page.locator("[data-vok]").count());
    check("the blockers name it too",
      /competency review request/i.test(await page.textContent(".ac-block")),
      await page.textContent(".ac-block"));
    check("sending it back needs a reason, and the field is there to type one in",
      await page.locator("[data-vn]").count() === 1);
    await page.click("[data-vok]");
    await page.waitForTimeout(1200);
    check("signing it off clears the card", await page.locator("[data-vok]").count() === 0,
      await page.locator("[data-vok]").count());
    check("AND CLEARS THAT BLOCKER, from the screen it was raised on",
      !/competency review request/i.test(await page.textContent(".ac-block")),
      await page.textContent(".ac-block"));

    check("the owner is told it is not ready to approve yet",
      await page.locator(".ac-block").count() === 1, await page.locator(".ac-block").count());
    const blk = await page.textContent(".ac-block");
    check("AND WHICH AREAS ARE STILL UNRATED, by name", /Still unrated/i.test(blk), blk);
    check("naming one of them", /Clinical documentation/i.test(blk), blk);
    check("the approve button is offered anyway, rather than mysteriously greyed out",
      await page.locator("#ac-rv-approve").count() === 1);

    for (const d of ["systems", "documentation", "authorizations", "compliance",
                     "caseload", "communication", "professionalism", "leadership", "policy"]) {
      await asOwner(`/api/academy/enrollments/${enr.id}/review`,
        { method: "POST", body: { domain: d, rating: "independent" } });
    }
    await page.click("#ac-rv-back");
    await page.waitForTimeout(400);
    await page.click('[data-rv-open="' + enr.id + '"]');
    await page.waitForTimeout(900);
    check("the owner IS given the approve button",
      await page.locator("#ac-rv-approve").count() === 1, await page.locator("#ac-rv-approve").count());
    check("and the CRM says it will not approve on elapsed time or a full checklist",
      /will not.{0,60}approve anybody because thirty days have passed/i.test(await page.textContent(".ac-wrap")),
      (await page.textContent(".ac-wrap")).slice(0, 1200));
    check("with every area rated and the gap planned, nothing is blocking it",
      await page.locator(".ac-block").count() === 0, await page.locator(".ac-block").count());

    // An approval with no words is refused, and the refusal has to land ON
    // THE SCREEN -- an error that only exists in a network tab is an error
    // nobody acts on.
    await page.click("#ac-rv-approve");
    await page.waitForTimeout(1100);
    check("A BLANK SUMMARY IS REFUSED, in words, on the page",
      /summary/i.test(await page.textContent("#ac-rv-msg")), await page.textContent("#ac-rv-msg"));
    check("and the review is not approved behind the refusal",
      await page.locator("#ac-rv-approve").count() === 1);

    await page.fill("#ac-rv-summary", "Strong on documentation and systems. Supervision needs three observed sessions.");
    await page.click("#ac-rv-approve");
    await page.waitForTimeout(1400);
    const signed = await page.textContent(".ac-wrap");
    check("with a summary written, it goes through", /Approved/.test(signed), signed.slice(0, 400));
    check("AND IS SHOWN AS APPROVED WITH A DEVELOPMENT PLAN, not plain approved",
      /Approved, with a development plan/i.test(signed), signed.slice(0, 400));
    check("naming who signed it", /Signed off by/i.test(signed), signed.slice(0, 500));

    section("THE SUBJECT, ONCE IT IS SIGNED");
    await login(newEmail, "AcadPass123!");
    await openAcademy();
    await page.click('[data-rv-open="' + enr.id + '"]');
    await page.waitForTimeout(1000);
    const final = await page.textContent(".ac-wrap");
    check("NOW they see every rating, including the hard one",
      /Requires Additional Support/.test(final), final.slice(0, 600));
    check("and the note behind it", /supervision session alone/i.test(final), final.slice(0, 900));
    check("and their development plan, with its dates",
      /Due 2026-11-15/.test(final) && /reassessed 2026-11-22/.test(final), final.slice(0, 900));
    check("and the summary they were given", /three observed sessions/.test(final), final.slice(0, 900));
    check("THERE IS NO RATING CONTROL ANYWHERE ON A SIGNED REVIEW",
      await page.locator("[data-rsave]").count() === 0, await page.locator("[data-rsave]").count());
    check("NO APPROVE BUTTON ON THEIR OWN REVIEW",
      await page.locator("#ac-rv-approve").count() === 0, await page.locator("#ac-rv-approve").count());
    check("no form to add themselves a development plan",
      await page.locator("[data-padd]").count() === 0, await page.locator("[data-padd]").count());
    check("and no control to close the one they have",
      await page.locator("[data-pl-close]").count() === 0, await page.locator("[data-pl-close]").count());

    section("Nothing threw");
    check("no page errors anywhere in that journey", errors.length === 0, errors.slice(0, 3));

    await pool.query("DELETE FROM academy_progress WHERE enrollment_id = $1", [enr.id]).catch(() => {});
    await purge();
  } catch (e) {
    fail++;
    console.log("  FAIL  the suite threw  -> " + e.message);
  }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})();
