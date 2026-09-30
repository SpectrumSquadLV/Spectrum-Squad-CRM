// The Authorization Request settings screen, in a real browser.
//
// The feature's whole premise is that what a payer wants is CONFIGURATION, not
// code. That premise is only true if there is somewhere to configure it -- the
// BCBA's own screen tells them "an administrator can configure it in Settings",
// and for a while that sentence was a promise the software did not keep.
//
// The check that matters most here is not that a number saves. It is that
// saving a number does not take anything else with it: the PUT upserts a WHOLE
// row, so a screen that sent back only the field it edited would silently blank
// every payer's document list. That is the kind of data loss nobody notices
// until a request goes out missing its paperwork.
//
//   DATABASE_URL=... PORT=3011 node server.js
//   BASE=http://127.0.0.1:3011 node test-authorization-settings-ui.js
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3011";

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 300) : "")); }
  };
  const section = (t) => console.log("\n== " + t + " ==");

  const login = async (email, password) => {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.evaluate(async () => { try { await fetch("/api/auth/logout", { method: "POST", credentials: "include" }); } catch (e) {} });
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.waitForSelector('#login-form input[name="email"]', { timeout: 15000 });
    await page.fill('#login-form input[name="email"]', email);
    await page.fill('#login-form input[name="password"]', password);
    await page.click('#login-form button[type="submit"]');
    await page.waitForTimeout(1800);
  };
  const openAdmin = async () => {
    await page.goto(BASE + "/#/admin");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(2200);
  };

  // ------------------------------------------------------------------
  section("There is somewhere to configure it");
  await login("admin@spectrumsquadlv.com", "TestOwner123!");
  await openAdmin();
  check("the owner gets an Authorization Request section in Settings", !!(await page.$("#authreq-card")));
  const rowCount = await page.$$eval("[data-ar-days]", (e) => e.length).catch(() => 0);
  check("EVERY PAYER AND REQUEST TYPE IS EDITABLE, not just the seeded favourite", rowCount >= 8, rowCount);
  check("the destination address is editable here too", !!(await page.$("#authreq-email")));

  // Captured BEFORE anything is saved. A baseline read after the first save is
  // worthless: if that save is the thing that blanks the lists, the comparison
  // is 0 against 0 and passes while the data is already gone.
  const docsFor = async () => page.$$eval("#authreq-payers td:last-child", (els) =>
    els.map((e) => (e.textContent || "").trim()).filter((t) => t && t !== "none"));
  const docsAtStart = await docsFor();
  check("payers carry required documents before any of this runs", docsAtStart.length > 0, docsAtStart.length);

  // ------------------------------------------------------------------
  section("A turnaround saves, and stays saved");
  const before = await page.$eval('[data-ar-days="0"]', (e) => e.value);
  await page.fill('[data-ar-days="0"]', "27");
  await page.selectOption('[data-ar-basis="0"]', "calendar");
  await page.click("#save-authreq-payers");
  await page.waitForTimeout(1500);
  await openAdmin();
  check("the turnaround survives a reload", (await page.$eval('[data-ar-days="0"]', (e) => e.value)) === "27",
    { before, after: await page.$eval('[data-ar-days="0"]', (e) => e.value) });
  check("...and so does how it is counted", (await page.$eval('[data-ar-basis="0"]', (e) => e.value)) === "calendar");

  // ------------------------------------------------------------------
  section("Saving a number takes nothing else with it");
  {
    await page.fill('[data-ar-days="1"]', "19");
    await page.click("#save-authreq-payers");
    await page.waitForTimeout(1500);
    await openAdmin();
    const docsAfter = await docsFor();
    // Compared against the START baseline, and required to be non-empty in its
    // own right, so this cannot pass by everything having been blanked already.
    check("SAVING A TURNAROUND DOES NOT BLANK THE DOCUMENT LISTS",
      docsAfter.length > 0 && docsAfter.join("|") === docsAtStart.join("|"),
      { atStart: docsAtStart.length, after: docsAfter.length });
    // The parent-signature flag lives on the same row and is just as easy to lose.
    const sigCount = await page.$$eval("[data-ar-sig]", (els) => els.filter((e) => e.checked).length);
    check("...nor the payers that ask for a parent signature", sigCount > 0, sigCount);
  }

  // ------------------------------------------------------------------
  section("Who may change it");
  await login("clinical@spectrumsquadlv.com", "TestStaff123!");
  await openAdmin();
  check("A CLINICAL USER IS NOT SHOWN THE SETTINGS", !(await page.$("#authreq-card")));
  const forbidden = await page.evaluate(async () => {
    const r = await fetch("/api/authorization-requests/config", {
      method: "PUT", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payers: [{ payer: "Tricare", request_type: "aba_services", turnaround_days: 1 }] }),
    });
    return r.status;
  });
  check("...and the API refuses them even when asked directly", forbidden === 403, forbidden);

  check("no page errors anywhere in this run", errors.length === 0, errors.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
