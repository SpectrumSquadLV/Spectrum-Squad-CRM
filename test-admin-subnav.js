// Admin Settings and its four tools under one collapsible sidebar group.
//
// The point of the change is tidiness, so the test is mostly about the things
// tidiness must not break: every page still reachable, still the same page,
// and still hidden from whoever could not see it before.
//
//   DATABASE_URL=... PORT=3011 node server.js
//   BASE=http://127.0.0.1:3011 node test-admin-subnav.js
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3011";

const CHILDREN = ["admin", "rethink-clients", "signnow-import", "email-templates", "failed-emails"];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + String(detail).slice(0, 300) : "")); }
  };
  const section = (t) => console.log("\n== " + t + " ==");

  async function login(email, password) {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.evaluate(async () => { await fetch("/api/auth/logout", { method: "POST" }); });
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.fill('#login-form input[name="email"]', email);
    await page.fill('#login-form input[name="password"]', password);
    await page.click('#login-form button[type="submit"]');
    await page.waitForTimeout(2000);
  }

  // ------------------------------------------------------------- the owner
  section("The group exists and holds all five");
  await login("admin@spectrumsquadlv.com", "TestOwner123!");

  check("an Admin parent button is in the sidebar", await page.locator('[data-nav-group="grp-admin"]').count() === 1);
  check("it is not itself a destination (no data-nav)",
    await page.locator('[data-nav-group="grp-admin"][data-nav]').count() === 0);

  for (const key of CHILDREN) {
    check(`${key} lives inside the group`,
      await page.locator(`#nav-sub-grp-admin [data-nav="${key}"]`).count() === 1);
    // The whole point: it is no longer a top-level entry.
    check(`${key} is no longer a direct child of nav`,
      await page.evaluate((k) => {
        const btn = document.querySelector(`.sidebar nav [data-nav="${k}"]`);
        return !!btn && btn.parentElement.id === "nav-sub-grp-admin";
      }, key));
  }

  // ---------------------------------------------------------- open / close
  section("Opening and closing");
  const subHidden = () => page.evaluate(() => {
    const el = document.getElementById("nav-sub-grp-admin");
    return el ? el.hasAttribute("hidden") : null;
  });

  // Land somewhere outside the group so its state is the remembered one.
  await page.evaluate(() => { location.hash = "#/dashboard"; });
  await page.waitForTimeout(900);
  const before = await subHidden();
  await page.click('[data-nav-group="grp-admin"]');
  await page.waitForTimeout(300);
  check("clicking the parent toggles the group", (await subHidden()) !== before);
  check("and says so for screen readers",
    (await page.getAttribute('[data-nav-group="grp-admin"]', "aria-expanded")) === ((await subHidden()) ? "false" : "true"));
  check("clicking the parent did not navigate away", (await page.evaluate(() => location.hash)) === "#/dashboard");

  // ------------------------------------------------------- still reachable
  section("Every page still opens, and is still itself");
  const OPENS = [
    ["admin", "#/admin", /Admin|Settings/i],
    ["rethink-clients", "#/rethink-clients", /Rethink/i],
    ["signnow-import", "#/signnow-import", /SignNow/i],
    ["email-templates", "#/email-templates", /Template/i],
    ["failed-emails", "#/failed-emails", /Failed|Email/i],
  ];
  for (const [key, hash, expect] of OPENS) {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await page.waitForTimeout(1600);
    const text = await page.locator("#view-mount").innerText().catch(() => "");
    check(`${hash} renders its own page`, expect.test(text), text.slice(0, 160));
    // Being on a child page opens the group and marks the child.
    check(`${key} is marked active while you are on it`,
      await page.locator(`#nav-sub-grp-admin [data-nav="${key}"].active`).count() === 1);
    check(`the group is open while you are on ${key}`, (await subHidden()) === false);
  }

  // Admin Settings is the one that must not have changed at all.
  await page.evaluate(() => { location.hash = "#/admin"; });
  await page.waitForTimeout(1800);
  const adminText = await page.locator("#view-mount").innerText().catch(() => "");
  check("Admin Settings still lists its settings", adminText.length > 200, adminText.length);

  // ------------------------------------------------------------ permissions
  section("Nobody gains access from the regrouping");
  await login("clinical@spectrumsquadlv.com", "TestStaff123!");
  check("a clinical user gets no Admin group", await page.locator('[data-nav-group="grp-admin"]').count() === 0);
  for (const key of CHILDREN) {
    check(`and no ${key} button anywhere in the sidebar`,
      await page.locator(`.sidebar nav [data-nav="${key}"]`).count() === 0);
  }
  await page.evaluate(() => { location.hash = "#/email-templates"; });
  await page.waitForTimeout(1600);
  const clinicalText = await page.locator("#view-mount").innerText().catch(() => "");
  check("typing the URL does not give them the editor either", !/Email Templates/i.test(clinicalText),
    clinicalText.slice(0, 160));

  section("no broken pages");
  check("no uncaught JavaScript errors", errors.length === 0, errors.join(" | "));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
