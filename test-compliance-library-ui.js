// The Compliance Training library on screen.
//
// The failure mode of compliance software is believing training is assigned
// when it is not. A screen that lists course titles looks identical whether
// HIPAA is required of everybody or of nobody, so these tests are mostly
// about what the page SAYS rather than what it contains.
//
//   DATABASE_URL=... node run-tests.js test-compliance-library-ui.js
"use strict";

const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3009";

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
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
  const api = (path, opts) => page.evaluate(async ({ p, o }) => {
    const r = await fetch(p, { method: (o && o.method) || "GET", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: o && o.body ? JSON.stringify(o.body) : undefined });
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  }, { p: path, o: opts || null });
  const go = async (hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(1500); };
  const text = () => page.textContent("#view-mount");

  await login("admin@spectrumsquadlv.com", "TestOwner123!");

  // ------------------------------------------------------------------
  section("Getting there");
  check("the owner has a Compliance Training entry in the sidebar",
    !!(await page.$('#nav-list [data-nav="compliance"]')));
  await go("#/compliance");
  await page.waitForSelector("#cmp-rows tr[data-course]", { timeout: 10000 }).catch(() => {});
  const t0 = await text();
  check("the library loads", !!(await page.$("#cmp-rows tr[data-course]")), t0.slice(0, 200));
  check("the seven courses the brief names are listed",
    ["HIPAA", "Sexual Harassment Prevention", "Nevada Mandatory Reporter", "Workplace Ethics",
     "Client Rights", "Infection Control", "Emergency Preparedness"].every((n) => t0.includes(n)),
    t0.slice(0, 400));

  // ------------------------------------------------------------------
  section("It says, out loud, that nothing is assigned yet");
  check("every course reads as required of nobody",
    (await page.$$eval("#cmp-rows tr[data-course]", (rows) => rows.map((r) => r.children[1].textContent.trim())))
      .every((s) => /Nobody yet/.test(s)),
    await page.$$eval("#cmp-rows tr[data-course]", (rows) => rows.map((r) => r.children[1].textContent.trim())));
  check("...and the page says so at the top rather than leaving it to be noticed",
    /required of nobody yet/i.test(t0) && /assigns nothing until somebody says who it is for/i.test(t0));
  check("no renewal interval is shown for any of them",
    (await page.$$eval("#cmp-rows tr[data-course]", (rows) => rows.map((r) => r.children[2].textContent.trim())))
      .every((s) => s === "—"));

  // ------------------------------------------------------------------
  section("Saying who a course is for");
  await page.click('#cmp-rows tr[data-course]');
  await page.waitForSelector("#cmp-drawer #cmp-rules", { timeout: 8000 }).catch(() => {});
  check("a course opens", !!(await page.$("#cmp-drawer [data-f='title']")));
  check("...explaining that nothing is assumed", /Nothing is assumed/i.test(await page.textContent("#cmp-drawer")));
  check("...and starts with no rules at all", (await page.$$("#cmp-drawer #cmp-rules [data-rule]")).length === 0);

  await page.click("#cmp-drawer #cmp-rule-add");
  await page.waitForTimeout(250);
  check("a rule can be added", (await page.$$("#cmp-drawer #cmp-rules [data-rule]")).length === 1);
  check("...offering all four ways a course can be required",
    (await page.$$eval('#cmp-drawer [data-r="scope"] option', (o) => o.map((x) => x.value))).join() === "all,position,department,optional");
  check("...and the renewal box is empty, not pre-filled with a guess",
    (await page.inputValue('#cmp-drawer [data-r="renewal_months"]')) === "");

  await page.selectOption('#cmp-drawer [data-r="scope"]', "all");
  await page.fill('#cmp-drawer [data-r="renewal_months"]', "12");
  await page.fill('#cmp-drawer [data-r="due_days"]', "30");
  await page.click("#cmp-drawer #cmp-rules-save");
  await page.waitForTimeout(1600);
  const t1 = await text();
  check("saving records who it is for", /Everybody/.test(t1), t1.slice(0, 300));
  // THE COLOUR HAS TO DIFFER, not just the words. A row saying "Nobody yet"
  // in the same tone as one saying "Everybody" is a wall of identical pills,
  // and the whole point of the column is that one of them is a warning.
  const tones = await page.$$eval("#cmp-rows tr[data-course]", (rows) => rows.map((r) => ({
    who: r.children[1].textContent.trim(),
    cls: (r.children[1].querySelector(".cmp-pill") || {}).className || "",
  })));
  const assigned = tones.filter((x) => /Everybody/.test(x.who));
  const unassignedRows = tones.filter((x) => /Nobody yet/.test(x.who));
  check("the assigned course is marked as settled", assigned.length === 1 && /cmp-set/.test(assigned[0].cls), assigned);
  check("...and the ones required of nobody are marked as a warning, not the same colour",
    unassignedRows.length === 6 && unassignedRows.every((x) => /cmp-none/.test(x.cls)), unassignedRows.slice(0, 2));
  check("...and that it renews yearly", /Every 12 months/.test(t1));
  check("...and the top-of-page warning drops by one",
    /6 courses are required of nobody yet/.test(t1), (t1.match(/\d+ courses? (?:is|are) required of nobody yet/) || [])[0]);

  // ------------------------------------------------------------------
  section("Removing the rule puts it back to required of nobody");
  await page.click('#cmp-rows tr[data-course]');
  await page.waitForSelector("#cmp-drawer #cmp-rules [data-rule]", { timeout: 8000 }).catch(() => {});
  const openTitle = await page.inputValue("#cmp-drawer [data-f='title']");
  await page.click("#cmp-drawer [data-rule-del]");
  await page.click("#cmp-drawer #cmp-rules-save");
  await page.waitForTimeout(1600);
  check("it says plainly that the course is now required of nobody",
    /required of nobody/i.test(await page.textContent("#cmp-drawer")) || /Nobody yet/.test(await text()),
    await page.textContent("#cmp-drawer"));
  check("...and the course is still in the library", (await text()).includes(openTitle));

  // ------------------------------------------------------------------
  section("A filter for the thing that actually matters");
  await page.selectOption("#cmp-scope", "unassigned");
  await page.waitForTimeout(600);
  check("you can list only the courses nobody has been assigned",
    (await page.$$("#cmp-rows tr[data-course]")).length === 7,
    (await page.$$("#cmp-rows tr[data-course]")).length);
  await page.selectOption("#cmp-scope", "");
  await page.waitForTimeout(500);

  // ------------------------------------------------------------------
  section("A version is forked only when completing it would mean something else");
  await page.click('#cmp-rows tr[data-course]');
  await page.waitForSelector("#cmp-drawer [data-f='title']", { timeout: 8000 }).catch(() => {});
  const vBefore = (await page.textContent("#cmp-drawer")).match(/version (\d+)/i);
  await page.fill("#cmp-drawer [data-f='title']", "HIPAA Privacy & Security (2026)");
  await page.click("#cmp-drawer #cmp-save");
  await page.waitForTimeout(1600);
  check("renaming a course just saves", /Saved\.$/.test((await page.textContent("#cmp-drawer #cmp-msg")) || "x") || /^Saved\./.test((await page.textContent("#cmp-drawer #cmp-msg")) || ""),
    await page.textContent("#cmp-drawer #cmp-msg").catch(() => ""));
  await page.fill("#cmp-drawer [data-f='passing_score']", "80");
  await page.click("#cmp-drawer #cmp-save");
  await page.waitForTimeout(1600);
  check("adding a pass mark explains that it forked a version, and that earned records keep theirs",
    /version 2/.test(await page.textContent("#cmp-drawer #cmp-msg")) && /records already earned keep/i.test(await page.textContent("#cmp-drawer #cmp-msg")),
    await page.textContent("#cmp-drawer #cmp-msg"));
  check("the change is on the course's history", /what completing the course means/i.test(await page.textContent("#cmp-drawer #cmp-history")));

  // ------------------------------------------------------------------
  section("Read-only for the Clinical Director");
  const cdEmp = (await api("/api/hr/employees", { method: "POST", body: { name: "Dana Director", email: "clinical@spectrumsquadlv.com", role_title: "Clinical Director" } })).data.id;
  await api(`/api/academy/leadership/${cdEmp}`, { method: "PUT", body: { leadership: "clinical_director" } });
  await login("clinical@spectrumsquadlv.com", "TestStaff123!");
  check("she gets the sidebar entry", !!(await page.$('#nav-list [data-nav="compliance"]')));
  await go("#/compliance");
  await page.waitForSelector("#cmp-rows tr[data-course]", { timeout: 10000 }).catch(() => {});
  const cdText = await text();
  check("she can read the library", !!(await page.$("#cmp-rows tr[data-course]")));
  check("...with no Add button", !(await page.$("#cmp-add")));
  check("...and is told whose job it is", /set by the owner, an admin or HR/i.test(cdText), cdText.slice(0, 300));
  await page.click('#cmp-rows tr[data-course]');
  await page.waitForSelector("#cmp-drawer [data-f='title']", { timeout: 8000 }).catch(() => {});
  check("...and the fields are not editable", await page.$eval("#cmp-drawer [data-f='title']", (e) => e.disabled) === true);
  check("...with no save buttons", !(await page.$("#cmp-drawer #cmp-save")) && !(await page.$("#cmp-drawer #cmp-rules-save")));

  // ------------------------------------------------------------------
  section("Phone width");
  await page.setViewportSize({ width: 390, height: 860 });
  await login("admin@spectrumsquadlv.com", "TestOwner123!");
  await go("#/compliance");
  await page.waitForSelector("#cmp-rows tr[data-course]", { timeout: 10000 }).catch(() => {});
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("no sideways scrolling on a phone", overflow <= 2, overflow);
  check("the table becomes cards", (await page.$eval("#cmp-rows tr", (e) => getComputedStyle(e).display)) === "grid");

  check("no page errors", errors.length === 0, errors);
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("\nFailures:"); failures.forEach((f) => console.log("  - " + f)); }
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
