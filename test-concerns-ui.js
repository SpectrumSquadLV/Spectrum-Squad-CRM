// Report a Concern, on the screen.
//
// Two things only the page can get wrong, and both of them matter more than
// the usual "is the button there":
//
//   * THE PAGE MUST NOT PROMISE ANONYMITY IT CANNOT KEEP. Inside the CRM the
//     request carries a session. So the in-app form offers "with my name" and
//     "confidential" and says, in words, why the third option lives somewhere
//     else. A form with an "Anonymous" radio on it would be a lie told to
//     somebody taking a risk.
//
//   * A NAMED REVIEWER MUST NOT BE SHOWN A ROW THEY CANNOT OPEN. The API
//     refuses them, but a greyed-out row would still tell them a concern
//     about them exists. It is simply not in the list, and the screen says
//     only that something is withheld.
//
// The public page gets its own pass, because it is the one that actually
// carries the anonymity.
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
    await page.evaluate(() => { location.hash = "#/concerns"; });
    await page.waitForSelector("#view-mount h1", { timeout: 20000 });
    await page.waitForTimeout(900);
  };

  await pool.query("UPDATE users SET role = 'admin' WHERE email = 'scheduling@spectrumsquadlv.com'");
  await pool.query(
    "UPDATE users SET module_access = '{\"concern_review\":true}' WHERE email = 'scheduling@spectrumsquadlv.com'");
  const emp = (await pool.query(
    `INSERT INTO hr_employees (name, email, role_title, employment_type, hire_date, status)
     VALUES ($1, 'scheduling@spectrumsquadlv.com', 'Clinical Director', 'full_time', '2024-01-08', 'active') RETURNING id`,
    [`Named Manager ${stamp}`])).rows[0];

  // ==================================================================
  console.log("\n== The public page is where anonymity lives ==");
  await page.goto(BASE + "/report-concern", { waitUntil: "networkidle" });
  await page.waitForSelector("#modes .mode", { timeout: 15000 });
  const pubText = (await page.innerText("body")).replace(/\s+/g, " ");
  check("IT IS CALLED REPORT A CONCERN, not a complaint form",
    /Report a Concern/.test(pubText) && !/complaint/i.test(pubText), pubText.slice(0, 200));
  check("it carries the words about what may be raised",
    /inconsistent with Spectrum Squad policies/i.test(pubText), pubText.slice(0, 400));
  check("THE NON-RETALIATION NOTICE IS ON IT",
    /Retaliation against an employee for raising a good faith concern/i.test(pubText), pubText.slice(0, 600));
  check("and it says submitting does not mean wrongdoing occurred",
    /does not mean wrongdoing has occurred/i.test(pubText), pubText.slice(0, 600));
  check("all three ways to send it are offered here", await page.locator("#modes .mode").count() === 3);
  check("including anonymously", /Submit anonymously/i.test(pubText));
  check("and the anonymous option is explicit that nothing identifying is recorded",
    /Nothing identifying you is recorded at all/i.test(pubText), pubText.slice(0, 800));

  // Submitted anonymously while NOT signed in. The API suite proves the same
  // thing with a session attached; this proves the page itself works.
  await page.click('.mode[data-m="anonymous"]');
  await page.waitForTimeout(200);
  check("choosing anonymous hides the name fields",
    !(await page.locator("#named-fields").isVisible()));
  await page.selectOption("#ctype", "Employee Safety");
  await page.fill("#cdesc", `The side door lock has been broken for two weeks ${stamp}.`);
  await page.selectOption("#pstaff", String(emp.id));
  await page.waitForTimeout(200);
  check("the staff picker adds a chip rather than free text",
    await page.locator("#pchips .chip").count() === 1);
  await page.click("#send");
  await page.waitForSelector("#done", { state: "visible", timeout: 20000 });
  const done = (await page.innerText("#done")).replace(/\s+/g, " ");
  check("the confirmation says nothing identifying was recorded",
    /Nothing identifying you was recorded/i.test(done), done.slice(0, 300));
  const code = (await page.innerText("#done-code")).trim();
  check("A REFERENCE CODE IS SHOWN", /^SQ-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(code), code);
  check("and it says the code cannot be re-issued, because nobody knows it was you",
    /cannot be re-issued/i.test(done), done.slice(0, 500));
  check("the non-retaliation notice is repeated on the confirmation",
    /Retaliation against an employee/i.test(done), done.slice(0, 600));

  const row = (await pool.query("SELECT * FROM concern_reports WHERE reference_code = $1", [code])).rows[0];
  check("the report really is anonymous in the database",
    !!row && row.reporter_user_id === null && row.reporter_name === null && row.reporter_email === null, row);

  // ==================================================================
  console.log("\n== In the CRM, the form is honest about what it can offer ==");
  await login("clinical@spectrumsquadlv.com", "TestStaff123!");
  check("there is a sidebar button", await page.locator("#concern-nav-btn").count() === 1);
  await open();
  const form = (await page.innerText("#view-mount")).replace(/\s+/g, " ");
  check("a BCBA gets the form", await page.locator("#cn-send").count() === 1);
  check("AND NOT THE REVIEW DASHBOARD", await page.locator(".cn-tab").count() === 0);
  check("the non-retaliation notice is on it",
    /Retaliation against an employee for raising a good faith concern/i.test(form), form.slice(0, 500));
  check("and that submitting does not mean wrongdoing occurred",
    /does not mean wrongdoing has occurred/i.test(form), form.slice(0, 600));

  const radios = await page.locator('input[name="cn-mode"]').evaluateAll((els) => els.map((e) => e.value));
  check("THERE IS NO 'ANONYMOUS' OPTION INSIDE THE CRM",
    !radios.includes("anonymous"), radios);
  check("only with-my-name and confidential",
    radios.includes("named") && radios.includes("confidential") && radios.length === 2, radios);
  check("AND THE PAGE SAYS WHY, rather than leaving it a mystery",
    /session identifies you to the server/i.test(form), form.slice(0, 900));
  check("pointing at the open page that can do it",
    await page.locator("#cn-anon-link").count() === 1);
  check("the staff picker explains that it is what keeps the report away from them",
    /cannot be matched to an account/i.test(form), form.slice(0, 1200));

  await page.selectOption("#cn-type", "Leadership or Supervisor Concern");
  await page.selectOption("#cn-staff", String(emp.id));
  await page.waitForTimeout(200);
  await page.fill("#cn-desc", `Overtime was approved for one RBT and refused for another ${stamp}.`);
  await page.check('input[name="cn-mode"][value="confidential"]');
  await page.click("#cn-send");
  await page.waitForSelector(".modal-backdrop", { timeout: 20000 });
  const conf = (await page.innerText(".modal-backdrop")).replace(/\s+/g, " ");
  check("the confirmation says what confidential means",
    /visible only to the people who review concerns/i.test(conf), conf.slice(0, 400));
  await page.evaluate(() => { const b = document.querySelector(".modal-backdrop .close-btn"); if (b) b.click(); });
  await page.waitForTimeout(400);

  const reportId = (await pool.query(
    "SELECT id FROM concern_reports WHERE description LIKE $1", [`%Overtime was approved%${stamp}%`])).rows[0].id;

  // ==================================================================
  console.log("\n== The named manager, who IS a reviewer ==");
  await login("scheduling@spectrumsquadlv.com", "TestOwner123!");
  await open();
  const mgr = (await page.innerText("#view-mount")).replace(/\s+/g, " ");
  check("they get the review dashboard", await page.locator(".cn-tab").count() === 2);
  check("THE CONCERN ABOUT THEM IS NOT A ROW ON IT",
    await page.locator(`.cn-row[data-id="${reportId}"]`).count() === 0);
  check("but they are told something is withheld",
    /not shown to you/i.test(mgr), mgr.slice(0, 600));
  check("AND THE WITHHOLDING NOTICE CARRIES NO CONTENT — no type, no reporter, no text",
    !/Leadership or Supervisor|Overtime was approved|Clinical Staff/.test(mgr), mgr.slice(0, 900));

  // ==================================================================
  console.log("\n== The owner, who is not named, handles it ==");
  await login("admin@spectrumsquadlv.com", "TestOwner123!");
  await open();
  check("the dashboard lists it", await page.locator(`.cn-row[data-id="${reportId}"]`).count() === 1);
  await page.click(`.cn-row[data-id="${reportId}"]`);
  await page.waitForSelector("#cn-review-save", { timeout: 15000 });
  const detail = (await page.innerText(".modal-backdrop")).replace(/\s+/g, " ");
  check("the report opens", /Overtime was approved/.test(detail), detail.slice(0, 300));
  check("it is marked confidential, with instruction not to disclose the reporter",
    /do not disclose the reporter/i.test(detail), detail.slice(0, 500));
  check("the named person is shown", new RegExp(`Named Manager ${stamp}`).test(detail), detail.slice(0, 600));
  check("THE AUDIT TRAIL IS ON THE SCREEN, open by default rather than hidden",
    /audit trail/i.test(detail) && /accessed/i.test(detail), detail.slice(0, 900));

  await page.waitForTimeout(800);
  const pickers = await page.locator("#cn-assign option").allInnerTexts();
  check("THE REVIEWER PICKER DOES NOT LIST THE PERSON THE CONCERN IS ABOUT",
    !pickers.some((t) => /Scheduling Staff/.test(t)), pickers);
  check("but does list somebody who can take it", pickers.length >= 2, pickers);

  // Closing without a resolution is refused by the server; the screen has to
  // surface that rather than silently doing nothing.
  await page.selectOption("#cn-status", "Closed");
  await page.click("#cn-status-save");
  await page.waitForTimeout(900);
  check("CLOSING WITH NO RESOLUTION IS REFUSED, and the screen says so",
    /resolution/i.test(await page.innerText("#cn-status-res")), await page.innerText("#cn-status-res"));

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  if (failures.length) { console.log("\n--- failures ---"); failures.forEach((f) => console.log(f)); }
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  await pool.end();
  process.exit(fail ? 1 : 0);
})();
