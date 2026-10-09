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
