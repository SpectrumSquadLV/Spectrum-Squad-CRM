// The lockdown, and the send button, on the screen.
//
// The API suite proves the rules. This is the half that decides whether
// somebody is offered a button that will 403 at them -- and whether the send
// path, which had an endpoint and no button for its whole life, now has one
// that names the people it is about to email.
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
  const openPolicies = async () => {
    await page.evaluate(() => { location.hash = "#/dashboard"; });
    await page.waitForTimeout(500);
    await page.evaluate(() => { location.hash = "#/policies"; });
    await page.waitForSelector("#pol-ask", { timeout: 20000 });
    await page.waitForTimeout(700);
    const door = await page.$('[data-pol-kind="policy"]');
    if (door) { await door.click(); await page.waitForTimeout(900); }
  };

  await pool.query("UPDATE users SET role = 'admin' WHERE email = 'scheduling@spectrumsquadlv.com'");
  await pool.query(
    `INSERT INTO hr_employees (name, email, role_title, employment_type, hire_date, status)
     VALUES ($1, $2, 'RBT', 'full_time', '2025-01-06', 'active'),
            ($3, NULL,  'RBT', 'full_time', '2025-01-06', 'active')`,
    [`Sendable Person ${stamp}`, `sendable.${stamp}@spectrumsquadlv.com`, `Unreachable Person ${stamp}`]);

  await login("admin@spectrumsquadlv.com", "TestOwner123!");
  const pol = await page.evaluate(async (t) => {
    const r = await fetch("/api/policies", { method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: t, doc_kind: "policy", category: "Billing",
        body: "Mileage is reimbursed at the federal rate, submitted monthly." }) });
    return r.json();
  }, `Mileage Reimbursement ${stamp}`);

  console.log("\n== The owner gets everything ==");
  await openPolicies();
  check("she can start a new policy", await page.locator("#pol-add").count() === 1);
  check("and upload a source document", await page.locator("#pol-doc-upload").count() === 1);
  check("and read the acknowledgment report", await page.locator("#pol-acks").count() === 1);
  await page.click(`[data-pol-open="${pol.id}"]`);
  await page.waitForSelector(".pol-read", { timeout: 10000 });
  check("she can edit it", await page.locator("#pol-r-edit").count() === 1);
  check("and write an amendment memo", await page.locator("#pol-r-amend").count() === 1);
  check("AND THERE IS NOW A BUTTON TO SEND IT TO STAFF", await page.locator("#pol-r-send").count() === 1);

  console.log("\n== Sending it ==");
  await page.click("#pol-r-send");
  await page.waitForSelector("#pol-send-go", { timeout: 10000 });
  const modal = (await page.innerText(".modal-backdrop")).replace(/\s+/g, " ");
  check("IT NAMES THE PEOPLE IT WILL EMAIL, rather than only counting them",
    new RegExp(`Sendable Person ${stamp}`).test(modal), modal.slice(0, 400));
  check("showing the address it will use",
    new RegExp(`sendable\\.${stamp}@spectrumsquadlv\\.com`).test(modal), modal.slice(0, 400));
  check("AND WARNS ABOUT THE PEOPLE IT CANNOT REACH",
    new RegExp(`no email address on file`, "i").test(modal) && new RegExp(`Unreachable Person ${stamp}`).test(modal),
    modal.slice(0, 600));
  check("everybody is ticked to start with, since sending to all is the common case",
    (await page.locator(".pol-send-who:checked").count()) === (await page.locator(".pol-send-who").count()) &&
    (await page.locator(".pol-send-who").count()) > 0);
  check("there is somewhere to add a note", await page.locator("#pol-send-note").count() === 1);

  // Send to one person only, so the assertion is about the mechanism rather
  // than about how many fixtures happen to exist.
  await page.click("#pol-send-none");
  await page.waitForTimeout(200);
  check("and a way to choose a subset instead", await page.locator(".pol-send-who:checked").count() === 0);
  await page.click("#pol-send-go");
  await page.waitForTimeout(500);
  check("SENDING TO NOBODY IS REFUSED rather than reported as a successful send of zero",
    /pick at least one/i.test(await page.innerText("#pol-send-res")), await page.innerText("#pol-send-res"));

  const sendBox = await page.$(`.pol-send-who[value]`);
  await page.evaluate((em) => {
    const labels = Array.from(document.querySelectorAll(".modal-backdrop label"));
    const mine = labels.filter((l) => l.textContent.includes(em))[0];
    if (mine) mine.querySelector("input").checked = true;
  }, `sendable.${stamp}@spectrumsquadlv.com`);
  await page.click("#pol-send-go");
  await page.waitForFunction(() => /Sent to|Did not reach|Could not/.test(document.querySelector("#pol-send-res").textContent), null, { timeout: 20000 });
  check("a real send reports what actually went out",
    /Sent to 1 of 1/.test(await page.innerText("#pol-send-res")), await page.innerText("#pol-send-res"));

  await page.evaluate(() => { const b = document.querySelector(".modal-backdrop .close-btn"); if (b) b.click(); });
  await page.waitForTimeout(400);
  await openPolicies();
  await page.click(`[data-pol-open="${pol.id}"]`);
  await page.waitForSelector(".pol-read", { timeout: 10000 });
  await page.click("#pol-r-send");
  await page.waitForSelector("#pol-send-go", { timeout: 10000 });
  check("and the next time it says when it last went out, so a repeat is a choice",
    /last sent/i.test((await page.innerText(".modal-backdrop")).replace(/\s+/g, " ")),
    (await page.innerText(".modal-backdrop")).slice(0, 300));
  await page.evaluate(() => { const b = document.querySelector(".modal-backdrop .close-btn"); if (b) b.click(); });
  await page.waitForTimeout(400);

  console.log("\n== An operational admin runs the library and cannot change a rule ==");
  await login("scheduling@spectrumsquadlv.com", "TestOwner123!");
  await openPolicies();
  check("THEY ARE NOT OFFERED A NEW-POLICY BUTTON", await page.locator("#pol-add").count() === 0);
  check("nor an upload button", await page.locator("#pol-doc-upload").count() === 0);
  check("nor an import button", await page.locator("#pol-import").count() === 0);
  check("BUT THEY KEEP THE ACKNOWLEDGMENT REPORT, which is their job",
    await page.locator("#pol-acks").count() === 1);
  await page.click(`[data-pol-open="${pol.id}"]`);
  await page.waitForSelector(".pol-read", { timeout: 10000 });
  check("they can read the policy", /Mileage is reimbursed/.test(await page.innerText(".modal-backdrop")));
  check("THEY ARE NOT OFFERED AN EDIT BUTTON", await page.locator("#pol-r-edit").count() === 0);
  check("NOR AN AMENDMENT MEMO -- the fastest way to change the rule in force",
    await page.locator("#pol-r-amend").count() === 0);
  check("nor a link button", await page.locator("#pol-r-link").count() === 0);
  check("but they can still announce an active policy to staff",
    await page.locator("#pol-r-send").count() === 1);

  console.log("\n== A BCBA reads, and is offered nothing else ==");
  await login("clinical@spectrumsquadlv.com", "TestStaff123!");
  await openPolicies();
  check("no new-policy button", await page.locator("#pol-add").count() === 0);
  check("no acknowledgment report", await page.locator("#pol-acks").count() === 0);
  await page.click(`[data-pol-open="${pol.id}"]`);
  await page.waitForSelector(".pol-read", { timeout: 10000 });
  check("no edit", await page.locator("#pol-r-edit").count() === 0);
  check("no memo", await page.locator("#pol-r-amend").count() === 0);
  check("AND NO WAY TO MAIL THE WHOLE COMPANY", await page.locator("#pol-r-send").count() === 0);

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  if (failures.length) { console.log("\n--- failures ---"); failures.forEach((f) => console.log(f)); }
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  await pool.end();
  process.exit(fail ? 1 : 0);
})();
