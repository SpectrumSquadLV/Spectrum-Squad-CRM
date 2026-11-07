// The lesson screen in a real browser: an employee opens HIPAA from My
// Training, sees the video and transcript, fails the quiz, then passes it --
// and the course turns complete. Also the owner's preview from the library.
//
//   DATABASE_URL=... node run-tests.js test-compliance-lessons-ui.js
"use strict";
const { chromium } = require("playwright");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
const BASE = process.env.BASE || "http://localhost:3009";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1300, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("dialog", async (d) => { await d.accept(); });
  let pass = 0, fail = 0;
  const failures = [];
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; failures.push(name); console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 300) : "")); }
  };
  const section = (t) => console.log("\n== " + t + " ==");
  const login = async (email, password) => {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.evaluate(async () => { try { await fetch("/api/auth/logout", { method: "POST", credentials: "include" }); } catch (e) {} });
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.fill('#login-form input[name="email"]', email);
    await page.fill('#login-form input[name="password"]', password);
    await page.click('#login-form button[type="submit"]');
    await page.waitForTimeout(2200);
  };
  const api = (p, o) => page.evaluate(async ({ p, o }) => {
    const r = await fetch(p, { method: (o && o.method) || "GET", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: o && o.body ? JSON.stringify(o.body) : undefined });
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  }, { p, o: o || null });
  const go = async (hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(1500); };
  const content = JSON.parse(fs.readFileSync(path.join(__dirname, "compliance-content", "hipaa.json"), "utf8"));
  const answer = async (picks) => {
    for (let i = 0; i < picks.length; i++) await page.check(`.cmpl-q[data-q="${i}"] input[value="${picks[i]}"]`);
    await page.click("#cmpl-submit");
    await page.waitForSelector(".cmpl-result", { timeout: 8000 });
  };

  await login("admin@spectrumsquadlv.com", "TestOwner123!");
  const lib = (await api("/api/compliance/courses")).data;
  const hipaa = lib.courses.find((c) => c.key === "hipaa");

  section("The owner previews it from the library");
  await go("#/compliance");
  await page.waitForSelector(`#cmp-rows tr[data-course="${hipaa.id}"]`, { timeout: 10000 });
  await page.click(`#cmp-rows tr[data-course="${hipaa.id}"]`);
  await page.waitForSelector("#cmp-preview", { timeout: 8000 }).catch(() => {});
  check("the course panel offers a preview", !!(await page.$("#cmp-preview")));
  if (await page.$("#cmp-preview")) {
    await page.click("#cmp-preview");
    await page.waitForSelector(".cmpl-q", { timeout: 8000 }).catch(() => {});
    check("the preview opens with the quiz", (await page.$$(".cmpl-q")).length === content.quiz.length);
    check("...and says nothing will be recorded", /Preview/.test(await page.textContent("#view-mount")));
  }

  section("An employee takes it");
  const stamp = Math.random().toString(36).slice(2, 8);
  const email = `zz.lessonui.${stamp}@example.test`;
  await api(`/api/compliance/courses/${hipaa.id}/rules`, { method: "PUT",
    body: { rules: [{ scope: "all", due_days: 30, effective_from: "2026-01-01" }] } });
  const made = await api("/api/admin/users", { method: "POST",
    body: { name: `Zz LessonUi ${stamp}`, email, password: "LessonUi123!", role: "employee" } });
  await pool.query(
    `INSERT INTO hr_employees (user_id, name, email, role_title, hire_date, status, created_at)
     VALUES ($1,$2,$3,'Registered Behavior Technician','2026-01-01','active',$4)`,
    [made.data && made.data.id, `Zz LessonUi ${stamp}`, email, new Date().toISOString()]);
  await login(email, "LessonUi123!");
  await go("#/my-training");
  await page.waitForSelector(".mytr-lesson", { timeout: 10000 }).catch(() => {});
  const btn = await page.$(`.mytr-lesson[data-c="${hipaa.id}"]`);
  check("My Training offers 'Start the training'", !!btn, (await page.textContent("#view-mount")).slice(0, 300));
  if (btn) {
    await btn.click();
    await page.waitForSelector(".cmpl-q", { timeout: 8000 }).catch(() => {});
    if (fs.existsSync(path.join(__dirname, "compliance-videos", "hipaa.mp4"))) {
      check("the video player is there", !!(await page.$("video.cmpl-video")));
    }
    check("the transcript lists every slide", (await page.$$(".cmpl-tr details")).length === content.slides.length);

    await page.click("#cmpl-submit");
    await page.waitForTimeout(300);
    check("submitting with blanks is stopped", /Answer every question first/.test(await page.textContent("#cmpl-quiz")));

    await answer(content.quiz.map((q) => (q.answer + 1) % 4));
    const failText = await page.textContent(".cmpl-result");
    check("a wrong sheet shows Not passed", /Not passed yet/.test(failText), failText);
    check("...and marks the misses", (await page.$$(".cmpl-q.wrong")).length === content.quiz.length);

    await answer(content.quiz.map((q) => q.answer));
    await page.waitForFunction(() => /Passed/.test((document.querySelector(".cmpl-result") || {}).textContent || "")
      && !/Not passed/.test(document.querySelector(".cmpl-result").textContent), null, { timeout: 8000 }).catch(() => {});
    const passText = await page.textContent(".cmpl-result");
    check("the right sheet shows Passed", /100% — Passed/.test(passText), passText);
    check("...with the explanations", (await page.$$(".cmpl-exp")).length === content.quiz.length);

    await page.click(".cmpl-back");
    await page.waitForTimeout(1500);
    const card = await page.textContent(`.mytr-card[data-course="${hipaa.id}"]`);
    check("back on My Training it reads Complete", /Complete/.test(card), card.slice(0, 200));
    check("...and offers a review instead", /Review the training/.test(card));
  }

  section("Phone width");
  await page.setViewportSize({ width: 390, height: 860 });
  if (btn) {
    await page.click(`.mytr-lesson[data-c="${hipaa.id}"]`);
    await page.waitForSelector(".cmpl-q", { timeout: 8000 }).catch(() => {});
    await page.screenshot({ path: process.env.LESSON_SHOT || "/dev/null", fullPage: false }).catch(() => {});
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("no sideways scrolling on a phone", overflow <= 2, overflow);

  check("no page errors", errors.length === 0, errors);
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("\nFailures:"); failures.forEach((f) => console.log("  - " + f)); }
  await browser.close();
  await pool.end();
  process.exit(fail ? 1 : 0);
})();
