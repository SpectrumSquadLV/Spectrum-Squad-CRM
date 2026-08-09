// Browser test: Scheduling is gone from the app, and the Financial Obligation
// Form is gone from the client card -- without breaking anything around them.
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  const errDetail = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text() + " @ " + JSON.stringify(m.location())); });
  page.on("requestfailed", (r) => errDetail.push("reqfail " + r.url() + " " + (r.failure()||{}).errorText));
  page.on("response", (r) => { if (r.status() >= 400) errDetail.push(r.status() + " " + r.url()); });
  const req404 = [];
  page.on("response", (r) => { if (r.status() === 404) req404.push(r.url()); });

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + String(detail).slice(0, 300) : "")); }
  };

  await page.goto("http://localhost:3009/", { waitUntil: "networkidle" });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', "TestOwner123!");
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(2500);
  check("signed in as owner", await page.locator(".sidebar, nav").first().isVisible().catch(() => false));

  // ---- 1. No scheduling anywhere in the sidebar ----
  const navText = await page.locator(".sidebar, nav").first().innerText();
  check("no 'Scheduling' nav item", !/schedul/i.test(navText), navText.replace(/\n/g, " | "));

  // ---- 2. Old bookmarks land on the dashboard, not a blank screen ----
  await page.evaluate(() => { location.hash = "#/schedule"; });
  await page.waitForTimeout(1800);
  check("#/schedule redirects to dashboard", (await page.evaluate(() => location.hash)) === "#/dashboard");
  const mountText1 = await page.locator("#view-mount").innerText();
  check("dashboard actually rendered after redirect", mountText1.trim().length > 40, mountText1.slice(0, 120));

  await page.evaluate(() => { location.hash = "#/schedule-center"; });
  await page.waitForTimeout(1500);
  check("#/schedule-center redirects too", (await page.evaluate(() => location.hash)) === "#/dashboard");

  // ---- 3. Scheduling frontend script is not loaded at all ----
  const schedGlobals = await page.evaluate(() => ({
    script: !!document.querySelector('script[src*="scheduling-frontend"]'),
    global: typeof window.SchedulingCenter !== "undefined",
  }));
  check("scheduling-frontend.js not in the page", !schedGlobals.script);
  check("window.SchedulingCenter not defined", !schedGlobals.global);

  // ---- 4. Module catalog in Admin no longer offers Scheduling ----
  await page.evaluate(() => { location.hash = "#/admin"; });
  await page.waitForTimeout(2500);
  const catalogHasSchedule = await page.evaluate(() =>
    typeof MODULE_CATALOG === "undefined" ? null : Object.keys(MODULE_CATALOG).includes("schedule")
  );
  check("MODULE_CATALOG has no 'schedule' key", catalogHasSchedule === false, "value=" + catalogHasSchedule);
  const adminText = await page.locator("#view-mount").innerText();
  check("admin page still renders", adminText.length > 200, adminText.slice(0, 120));

  // ---- 5. Client card: no Financial Obligation Form ----
  await page.evaluate(() => { location.hash = "#/pipeline"; });
  await page.waitForTimeout(3000);
  let clientId = await page.evaluate(() => (window.state && state.clients && state.clients[0] ? state.clients[0].id : null));
  if (clientId == null) {
    clientId = await page.evaluate(async () => {
      const r = await fetch("/api/clients", { credentials: "include" });
      const list = await r.json();
      if (window.state) state.clients = list;
      return Array.isArray(list) && list[0] ? list[0].id : null;
    });
  }
  check("found a client to open", clientId != null);

  if (clientId != null) {
    await page.evaluate((id) => openClientModal(id), clientId);
    await page.waitForTimeout(2600);
    const modal = page.locator(".modal-backdrop").last();
    check("client card opened", await modal.isVisible().catch(() => false));
    const modalText = await modal.innerText().catch(() => "");
    check("no 'Financial Obligation' heading on the card", !/financial obligation/i.test(modalText));
    check("no co-pay fields on the card", !/co-pay|out-of-pocket/i.test(modalText));
    const ffSection = await page.evaluate(() => !!document.querySelector("#financial-form-section"));
    check("#financial-form-section not in the DOM", !ffSection);

    // The rest of the card must still work -- these sit either side of what was removed.
    check("authorizations section still there", /authoriz/i.test(modalText), modalText.slice(0, 200));
    check("case notes still there", /case note/i.test(modalText));
    check("schedule request (parent availability form) still there", /schedule request|schedule form/i.test(modalText));
  }

  // ---- 6. Nothing threw, nothing 404'd ----
  // Three known-environmental noises, none caused by these removals:
  //  - Google Fonts is blocked by the sandbox proxy (it loads fine in production)
  //  - /api/auth/me 401s once before sign-in, which is how the app detects "logged out"
  //  - /api/owner-financial-settings is owner-only and the test account is an admin
  const IGNORE = /favicon|fonts\.googleapis|ERR_TUNNEL_CONNECTION_FAILED|401/i;
  const badErrors = errors.filter((e) => !IGNORE.test(e));
  check("no page errors", badErrors.length === 0, badErrors.join(" ;; "));
  const bad404 = req404.filter((u) => !/favicon/i.test(u));
  check("no 404s", bad404.length === 0, bad404.join(" ;; "));

  console.log("\n  --- network detail ---\n  " + errDetail.join("\n  "));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
