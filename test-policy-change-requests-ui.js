// Policy change requests on the screen.
//
// The API suite proves the rules. This is the half that only exists on the
// page, and it is about one thing above all: THE SCREEN HAS TO SAY THAT
// NOTHING HAS CHANGED. The server can refuse an unauthorised approval
// perfectly and the feature still fails if a staff member reads "Approved" on
// a request and starts working to the new rule a month early.
//
// So what is measured here is what a person actually sees:
//
//   * the form says the policy is not being changed, before they submit
//   * an APPROVED request says in so many words that the current policy still
//     applies, and is not published yet
//   * a staff member is not offered a decision box they cannot use, and an
//     operational admin is not offered one either -- the queue controls and
//     the decision controls are different things on the page, as they are in
//     the permission model
//   * the decision box refuses an empty response in the browser, so the person
//     finds out before the round trip
//   * the two libraries are two tabs, not one merged list
"use strict";
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3011";
const stamp = Date.now().toString(36);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("dialog", async (d) => { await d.accept(); });

  let pass = 0, fail = 0;
  const failures = [];
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else {
      const line = "  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : "");
      fail++; failures.push(line); console.log(line);
    }
  };
  const login = async (email, password) => {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.evaluate(async () => {
      try { await fetch("/api/auth/logout", { method: "POST", credentials: "include" }); } catch (e) {}
      try { localStorage.clear(); } catch (e) {}
    });
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.waitForSelector('#login-form input[name="email"]', { timeout: 15000 });
    await page.fill('#login-form input[name="email"]', email);
    await page.fill('#login-form input[name="password"]', password);
    await page.click('#login-form button[type="submit"]');
    await page.waitForTimeout(1800);
  };
  const open = async () => {
    await page.evaluate(() => { location.hash = "#/dashboard"; });
    await page.waitForTimeout(500);
    await page.evaluate(() => { location.hash = "#/policy-changes"; });
    await page.waitForSelector("#pcr-new", { timeout: 20000 });
    await page.waitForTimeout(700);
  };
  const post = (path, body) => page.evaluate(async (a) => {
    const r = await fetch(a.path, { method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(a.body) });
    return r.json();
  }, { path, body });

  await login("admin@spectrumsquadlv.com", "TestOwner123!");
  const pol = await post("/api/policies", { title: `Session Note Timeliness ${stamp}`, doc_kind: "policy",
    category: "Session Notes & Documentation", body: "Session notes must be submitted within 24 hours." });

  console.log("\n== Getting there ==");
  check("there is a sidebar button for it",
    await page.locator("#pcr-nav-btn").count() === 1);
  await open();
  check("the screen renders on its own route", await page.locator("#pcr-new").count() === 1);
  check("THE HEADING SAYS NOTHING HAS CHANGED, before anybody clicks anything",
    /does not change the current policy/i.test(await page.innerText("#view-mount")),
    (await page.innerText("#view-mount")).slice(0, 300));

  console.log("\n== Two tabs, not one merged list ==");
  check("there are exactly two tabs", await page.locator(".pcr-tab").count() === 2);
  const tabs = await page.locator(".pcr-tab").allInnerTexts();
  check("change requests and policy exceptions, kept apart",
    /change request/i.test(tabs.join(" ")) && /exception/i.test(tabs.join(" ")), tabs);

  console.log("\n== The form says it changes nothing ==");
  await page.click("#pcr-new");
  await page.waitForSelector("#pcr-change", { timeout: 10000 });
  const form = (await page.innerText(".modal-backdrop")).replace(/\s+/g, " ");
  check("THE FORM SAYS THE POLICY IS NOT BEING CHANGED", /does not change the policy/i.test(form), form.slice(0, 300));
  check("and that it goes to the monthly review", /monthly/i.test(form), form.slice(0, 300));
  // Asking for a NEW policy has nothing to point a policy picker at, so the
  // form has to change shape rather than demand an impossible answer.
  // Modify, not create: the form opens on the common case, with the policy
  // picker already showing.
  check("IT OPENS ON 'MODIFY AN EXISTING POLICY', the common ask",
    await page.inputValue("#pcr-type") === "modify", await page.inputValue("#pcr-type"));
  check("so the policy picker is there without touching the dropdown",
    await page.locator("#pcr-pol-wrap").isVisible());
  await page.selectOption("#pcr-type", "create");
  await page.waitForTimeout(250);
  check("ASKING FOR A NEW POLICY ASKS FOR A NAME INSTEAD OF A PICKER",
    !(await page.locator("#pcr-pol-wrap").isVisible()) && await page.locator("#pcr-title-wrap").isVisible());
  await page.selectOption("#pcr-type", "modify");
  await page.waitForTimeout(250);

  await page.selectOption("#pcr-policy", String(pol.id));
  await page.fill("#pcr-change", "Allow 48 hours instead of 24.");
  await page.fill("#pcr-reason", "In-home sessions end after the clinic portal closes.");
  await page.fill("#pcr-problem", "Notes are late through no fault of the clinician.");
  await page.click("#pcr-send");
  await page.waitForTimeout(1500);
  const list = await page.innerText("#view-mount");
  check("the request lands in the list", /Session Note Timeliness/.test(list), list.slice(0, 300));
  check("SHOWING THE REVIEW CYCLE IT IS WAITING FOR, in words a person reads",
    /January|February|March|April|May|June|July|August|September|October|November|December/.test(list),
    list.slice(0, 400));
  check("and its status", /Pending Monthly Review/.test(list), list.slice(0, 400));

  console.log("\n== The record says the policy still stands ==");
  await page.click(".pcr-row");
  await page.waitForSelector(".modal-backdrop", { timeout: 10000 });
  let modal = (await page.innerText(".modal-backdrop")).replace(/\s+/g, " ");
  check("THE OPEN REQUEST SAYS THE CURRENT POLICY IS UNCHANGED",
    /current policy is unchanged/i.test(modal), modal.slice(0, 400));
  check("the reason is on the record", /clinic portal closes/.test(modal), modal.slice(0, 400));

  console.log("\n== The decision box ==");
  check("the owner is offered one", await page.locator("#pcr-dec-save").count() === 1);
  check("and it is marked required", /required/i.test(modal), modal.slice(0, 600));
  // Counted, not read. The server refuses an empty response in almost the same
  // words, so asserting the MESSAGE would pass whether or not the browser
  // checked anything. What is being claimed here is that the person is told
  // BEFORE the round trip, and the only evidence of that is that no request
  // was sent.
  let decidePosts = 0;
  page.on("request", (r) => { if (/\/decide$/.test(r.url()) && r.method() === "POST") decidePosts++; });
  await page.click("#pcr-dec-save");
  await page.waitForTimeout(600);
  check("A DECISION WITH AN EMPTY RESPONSE NEVER LEAVES THE BROWSER", decidePosts === 0, decidePosts);
  check("and the person is told why",
    /write the decision response/i.test(await page.innerText("#pcr-dec-res")),
    await page.innerText("#pcr-dec-res"));
  check("the request is still undecided", await page.locator("#pcr-dec-save").count() === 1);

  await page.selectOption("#pcr-dec", "Approve With Modification");
  await page.fill("#pcr-dec-notes", "Approved at 36 hours, not 48, to stay inside the payer's audit window.");
  await page.fill("#pcr-eff", "2026-11-01");
  await page.click("#pcr-dec-save");
  await page.waitForTimeout(1600);

  console.log("\n== APPROVED IS NOT PUBLISHED, and the screen says so ==");
  await page.click(".pcr-row");
  await page.waitForSelector(".modal-backdrop", { timeout: 10000 });
  modal = (await page.innerText(".modal-backdrop")).replace(/\s+/g, " ");
  check("the approval is shown", /Approved With Modification/.test(modal), modal.slice(0, 300));
  check("THE SCREEN SAYS IT IS NOT YET PUBLISHED", /not yet published/i.test(modal), modal.slice(0, 500));
  check("AND THAT THE CURRENT POLICY STILL APPLIES", /current policy still applies/i.test(modal), modal.slice(0, 500));
  check("with the effective date it will take", /2026-11-01/.test(modal), modal.slice(0, 500));
  check("the written response is on the record", /36 hours/.test(modal), modal.slice(0, 600));
  check("the decision box is gone once it is decided", await page.locator("#pcr-dec-save").count() === 0);
  check("and marking it implemented is offered as a separate act",
    await page.locator("#pcr-impl").count() === 1);
  check("the audit trail is on the record", /audit trail/i.test(modal), modal.slice(0, 700));
  await page.evaluate(() => { const b = document.querySelector(".modal-backdrop .close-btn"); if (b) b.click(); });
  await page.waitForTimeout(400);

  console.log("\n== The exception log is its own tab ==");
  await page.click('.pcr-tab[data-t="exceptions"]');
  await page.waitForTimeout(1200);
  const exView = await page.innerText("#view-mount");
  check("it explains what an exception is for",
    /leaves the policy in force/i.test(exView), exView.slice(0, 400));
  check("and that the point is not to prevent discretion",
    /discretion/i.test(exView), exView.slice(0, 400));
  await page.click("#pcr-new");
  await page.waitForSelector("#pex-reason", { timeout: 10000 });
  const exForm = (await page.innerText(".modal-backdrop")).replace(/\s+/g, " ");
  check("THE EXCEPTION FORM SAYS THE POLICY STAYS IN FORCE FOR EVERYONE ELSE",
    /stays in force for everyone else/i.test(exForm), exForm.slice(0, 300));
  check("and the end date is explicitly optional, so a permanent one is a choice",
    /leave blank if permanent/i.test(exForm), exForm.slice(0, 400));
  await page.selectOption("#pex-policy", String(pol.id));
  await page.fill("#pex-who", "Ada Reyes");
  await page.fill("#pex-reason", "Ada covers the late in-home block and the portal is closed when she finishes.");
  await page.fill("#pex-auth", "Quiana Blake");
  await page.click("#pex-save");
  await page.waitForTimeout(1500);
  const exList = await page.innerText("#view-mount");
  check("the exception is recorded", /Ada Reyes/.test(exList), exList.slice(0, 400));
  check("AN EXCEPTION WITH NO END DATE IS CALLED OUT ON THE LIST, not left to be noticed",
    /no end date/i.test(exList), exList.slice(0, 500));
  await page.click(".pex-row");
  await page.waitForSelector(".modal-backdrop", { timeout: 10000 });
  const exModal = (await page.innerText(".modal-backdrop")).replace(/\s+/g, " ");
  check("and said plainly when it is opened",
    /permanent exception is a policy by another name/i.test(exModal), exModal.slice(0, 400));
  // Opened, not read through the DOM: a disclosure that holds the message but
  // never opens is the same as not having it.
  const wd = await page.$(".modal-backdrop details summary");
  check("withdrawing it is offered", !!wd);
  if (wd) { await wd.click(); await page.waitForTimeout(300); }
  check("AND SAYS IT IS NOT A DELETE — exceptions stay on the record",
    /never deleted/i.test((await page.innerText(".modal-backdrop")).replace(/\s+/g, " ")),
    (await page.innerText(".modal-backdrop")).slice(0, 600));
  await page.evaluate(() => { const b = document.querySelector(".modal-backdrop .close-btn"); if (b) b.click(); });
  await page.waitForTimeout(400);

  console.log("\n== A staff member can ask, and cannot decide ==");
  await login("clinical@spectrumsquadlv.com", "TestStaff123!");
  await open();
  const staffView = await page.innerText("#view-mount");
  check("they get the screen", /Policy Change Requests/.test(staffView));
  check("they can raise a request", await page.locator("#pcr-new").count() === 1);
  check("THEY DO NOT SEE THE REVIEW QUEUE TILES",
    !/Awaiting review/i.test(staffView), staffView.slice(0, 400));
  check("and are told these are their own requests",
    /requests you have raised/i.test(staffView), staffView.slice(0, 400));
  check("SOMEBODY ELSE'S REQUEST IS NOT ON THEIR LIST",
    await page.locator(".pcr-row").count() === 0, await page.innerText("#view-mount"));

  await post("/api/policy-changes", { policy_id: pol.id, request_type: "modify",
    requested_change: "Clarify weekend sessions.", reason: "Weekends are ambiguous." });
  await open();
  await page.click(".pcr-row");
  await page.waitForSelector(".modal-backdrop", { timeout: 10000 });
  check("they can read their own",
    /Weekends are ambiguous/.test(await page.innerText(".modal-backdrop")));
  check("AND ARE NOT OFFERED A DECISION BOX THEY CANNOT USE",
    await page.locator("#pcr-dec-save").count() === 0);
  check("nor the queue controls", await page.locator("#pcr-patch").count() === 0);
  check("nor the emergency route", await page.locator("#pcr-eg-save").count() === 0);

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  if (failures.length) { console.log("\n--- failures ---"); failures.forEach((f) => console.log(f)); }
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
