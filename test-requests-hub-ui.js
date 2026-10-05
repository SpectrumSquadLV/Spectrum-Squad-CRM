// REQUESTS & REPORTS -- the front door to four systems that stay four systems.
//
// The spec is explicit that the records must not be combined into one list,
// and the two things worth testing are the two ways that could quietly stop
// being true:
//
//   * THE HUB MUST NOT BECOME AN INBOX. No record from any of the four may
//     appear on it. It routes; it does not list.
//   * REPORT A CONCERN MUST NOT CARRY A COUNT. The card is for everybody,
//     because raising a concern is a normal act -- but a number on it leaks
//     sideways in exactly the way the rest of that feature works to prevent.
//     "2 open" on a screen somebody reads over your shoulder says a concern
//     exists; a reviewer's count says how many.
"use strict";
const { chromium } = require("playwright");
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
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
    await page.evaluate(() => { location.hash = "#/requests"; });
    await page.waitForSelector(".reqhub-card", { timeout: 20000 });
    await page.waitForTimeout(1200);
  };
  const post = (path, body) => page.evaluate(async (a) => {
    const r = await fetch(a.path, { method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(a.body) });
    return r.json();
  }, { path, body });

  await login("admin@spectrumsquadlv.com", "TestOwner123!");

  // One record in each of the four, with a distinctive phrase, so "no records
  // on the hub" is a claim with something to be wrong about.
  await post("/api/supply/public/submit", {
    requester_name: "Quiana Blake", requester_email: "admin@spectrumsquadlv.com",
    item_name: `Laminator refill pouches ${stamp}`, quantity: "2 boxes", location: "Henderson" });
  await post("/api/maintenance/requests", {
    requester_name: "Quiana Blake", requester_email: "admin@spectrumsquadlv.com",
    location: "Henderson", category: "Doors/Locks", priority: "Safety Issue",
    description: `The side door lock is broken ${stamp}` });
  const pol = await post("/api/policies", { title: `Note Timeliness ${stamp}`, doc_kind: "policy",
    category: "Session Notes & Documentation", body: "Session notes are submitted within 24 hours." });
  await post("/api/policy-changes", { policy_id: pol.id, request_type: "modify",
    requested_change: `Allow 48 hours ${stamp}`, reason: "In-homes end after the portal closes." });
  await post("/api/concerns", { reporting_mode: "confidential", concern_type: "Client Safety",
    description: `A fire exit was blocked ${stamp}` });

  console.log("\n== The front door ==");
  check("there is a sidebar button for it", await page.locator("#reqhub-nav-btn").count() === 1);
  await open();
  check("FOUR CARDS, not three and not five", await page.locator(".reqhub-card").count() === 4);
  const text = (await page.innerText("#view-mount")).replace(/\s+/g, " ");
  check("it is called Requests & Reports", /Requests & Reports/.test(text), text.slice(0, 160));
  for (const t of ["Supply Requests", "Maintenance Requests", "Policy Change Requests", "Report a Concern"]) {
    check(`the ${t} card is there`, new RegExp(t).test(text), text.slice(0, 400));
  }

  // The spec's own employee-facing wording: somebody arrives with a problem,
  // not with the name of a system.
  check("each card names the question somebody actually arrives with",
    /I need supplies/i.test(text) && /Something is broken/i.test(text) &&
    /a policy should change/i.test(text) && /something concerning/i.test(text), text.slice(0, 700));

  console.log("\n== IT IS A ROUTER, NOT AN INBOX ==");
  check("NOT ONE RECORD FROM ANY OF THE FOUR IS ON IT",
    !new RegExp(stamp).test(text), text.slice(0, 900));
  check("no table of records at all", await page.locator("#view-mount table").count() === 0);

  console.log("\n== Counts, and the one card that must not have one ==");
  const countFor = async (key) => (await page.locator(`.reqhub-count[data-for="${key}"]`).innerText()).trim();
  check("the supply card carries a count", /\d/.test(await countFor("supply")), await countFor("supply"));
  check("the maintenance card carries a count", /\d/.test(await countFor("maintenance")), await countFor("maintenance"));
  check("A SAFETY ISSUE IS SURFACED ON THE CARD rather than a click away",
    /safety/i.test(await countFor("maintenance")), await countFor("maintenance"));
  check("the policy change card carries a count", /\d/.test(await countFor("policy_changes")), await countFor("policy_changes"));
  check("REPORT A CONCERN CARRIES NO COUNT AND NO STATUS",
    (await countFor("concerns")) === "", JSON.stringify(await countFor("concerns")));

  // Not just "the slot is empty" -- assert nothing was even asked for. A
  // request that 403s would also leave the slot empty, and that is a
  // different, fragile reason to be right.
  const asked = [];
  page.on("request", (r) => { if (/\/api\/concerns/.test(r.url())) asked.push(r.url()); });
  await open();
  check("AND THE HUB NEVER EVEN ASKS THE CONCERNS API FOR ONE", asked.length === 0, asked);

  console.log("\n== The cards go where they say ==");
  await page.click('.reqhub-card[data-key="maintenance"]');
  await page.waitForTimeout(1200);
  check("the maintenance card opens maintenance",
    await page.evaluate(() => location.hash) === "#/maintenance", await page.evaluate(() => location.hash));
  await open();
  await page.click('.reqhub-card[data-key="concerns"]');
  await page.waitForTimeout(1200);
  check("the concern card opens Report a Concern",
    await page.evaluate(() => location.hash) === "#/concerns", await page.evaluate(() => location.hash));

  console.log("\n== A BCBA gets the same four doors ==");
  await login("clinical@spectrumsquadlv.com", "TestStaff123!");
  await open();
  check("all four cards are there for staff too", await page.locator(".reqhub-card").count() === 4);
  const staffText = (await page.innerText("#view-mount")).replace(/\s+/g, " ");
  check("STILL NO RECORDS ON IT", !new RegExp(stamp).test(staffText), staffText.slice(0, 700));
  check("and still no count on the concern card",
    (await countFor("concerns")) === "", JSON.stringify(await countFor("concerns")));
  // A staffer cannot read the supply queue, so that card simply has no number
  // rather than an error.
  check("a card whose API refuses them fails quietly rather than breaking the page",
    await page.locator(".reqhub-card").count() === 4 && errors.length === 0, errors.slice(0, 2));

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  if (failures.length) { console.log("\n--- failures ---"); failures.forEach((f) => console.log(f)); }
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  await pool.end();
  process.exit(fail ? 1 : 0);
})();
