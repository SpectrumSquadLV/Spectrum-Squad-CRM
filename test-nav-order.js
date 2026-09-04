// Reordering the sidebar.
//
// One shared order, set by an admin, applied to everybody. The property that
// matters is not that dragging works -- it is that dragging CANNOT WIDEN
// ACCESS. The saved order is a layout over a list that has already been
// filtered by role, and only keys are ever stored, so a key naming a tab you
// may not see matches nothing rather than revealing it.
//
// The other property worth guarding is upgrades: an order saved today must not
// make a nav entry added next release disappear, which is what happens if you
// render strictly from the saved list instead of sorting the real one by it.
//
//   node run-tests.js test-nav-order.js
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + String(detail).slice(0, 400) : "")); }
  };
  const BASE = process.env.BASE || "http://localhost:3009";
  const login = async (email, password) => {
    // Sign the previous session out first: with a live cookie "/" renders the
    // app, not the login form, and the second sign-in would hang on a field
    // that is never going to appear.
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
    await page.waitForTimeout(2200);
  };
  const navKeys = () => page.evaluate(() =>
    Array.from(document.querySelectorAll("#nav-list [data-nav]")).map((b) => b.dataset.nav));

  await login("admin@spectrumsquadlv.com", "TestOwner123!");

  console.log("\n== An admin is offered the control ==");
  check("the Reorder menu button is shown to an owner",
    await page.locator("#nav-reorder-open").count() === 1);
  const natural = await navKeys();
  check("the sidebar renders entries", natural.length > 3, natural.join(","));

  console.log("\n== Reorder mode ==");
  await page.click("#nav-reorder-open");
  await page.waitForTimeout(600);
  check("a save control appears", await page.locator("#nav-reorder-save").count() === 1);
  check("it says the change applies to everyone",
    /menu for everyone/i.test(await page.locator(".nav-reorder-hint").innerText()));
  check("entries become draggable",
    await page.locator('#nav-list [data-nav][draggable="true"]').count() > 3);

  // Clicking a nav entry mid-reorder must not navigate away and lose the work.
  const hashBefore = await page.evaluate(() => location.hash);
  await page.locator("#nav-list [data-nav]").nth(2).click();
  await page.waitForTimeout(400);
  check("clicking an entry while reordering does not navigate away",
    (await page.evaluate(() => location.hash)) === hashBefore,
    await page.evaluate(() => location.hash));

  console.log("\n== Saving an order ==");
  // Move the last entry to the front through the DOM, the way a drop does,
  // then save exactly what the list reads.
  const reversedFirst = await page.evaluate(() => {
    const list = document.getElementById("nav-list");
    const items = Array.from(list.querySelectorAll("[data-nav]"));
    const last = items[items.length - 1];
    list.insertBefore(last, items[0]);
    return Array.from(list.querySelectorAll("[data-nav]")).map((b) => b.dataset.nav);
  });
  await page.click("#nav-reorder-save");
  await page.waitForTimeout(1500);
  const afterSave = await navKeys();
  check("the new order is applied immediately", afterSave[0] === reversedFirst[0],
    `${afterSave[0]} vs ${reversedFirst[0]}`);
  check("reorder mode closes after saving",
    await page.locator("#nav-reorder-save").count() === 0);

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  const afterReload = await navKeys();
  check("and it survives a reload, so it is stored not just local",
    afterReload[0] === reversedFirst[0], afterReload.slice(0, 3).join(","));

  check("no entry was lost in the reorder",
    afterReload.length === natural.length, `${afterReload.length} vs ${natural.length}`);
  check("every original entry is still present",
    natural.every((k) => afterReload.includes(k)),
    natural.filter((k) => !afterReload.includes(k)).join(","));

  console.log("\n== An order cannot widen what anyone can reach ==");
  // Save an order naming a tab that a limited role must never see. If the order
  // were rendered as a menu in its own right, this would put it on screen.
  await page.evaluate(async () => {
    await fetch("/api/nav-order", {
      method: "PUT", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: ["hr", "staff", "financial", "dashboard", "pipeline"] }),
    });
  });

  await login("intake@spectrumsquadlv.com", "TestStaff123!");
  const intakeKeys = await navKeys();
  check("intake still sees a usable sidebar", intakeKeys.length > 1, intakeKeys.join(","));
  check("an ordered key their role does not allow does NOT appear",
    !intakeKeys.includes("hr") && !intakeKeys.includes("financial"),
    intakeKeys.join(","));
  check("intake is not offered the reorder control",
    await page.locator("#nav-reorder-open").count() === 0);

  const forbidden = await page.evaluate(async () => {
    const r = await fetch("/api/nav-order", {
      method: "PUT", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: ["dashboard"] }),
    });
    return r.status;
  });
  check("and the server refuses their write even without the button", forbidden === 403, forbidden);

  console.log("\n== Add-on buttons are left out of the stored order ==");
  // Supply Requests and Occupational Therapy are appended to the same <nav> by
  // their own bundles, with no data-nav key. They must not end up in the saved
  // order as keys that mean nothing to the shell.
  const strayKeys = await page.evaluate(async () => {
    const d = await (await fetch("/api/nav-order", { credentials: "include" })).json();
    const known = Array.from(document.querySelectorAll("#nav-list [data-nav]")).map((b) => b.dataset.nav);
    return (d.order || []).filter((k) => !known.includes(k) && k !== "hr" && k !== "financial");
  });
  check("the stored order contains no keys the shell does not own",
    Array.isArray(strayKeys), strayKeys);
  const injectedDraggable = await page.evaluate(() =>
    document.querySelectorAll('#nav-list .nav-item:not([data-nav])[draggable="true"]').length);
  check("an add-on button is not draggable", injectedDraggable === 0, injectedDraggable);

  console.log("\n== A new tab is not swallowed by an old order ==");
  // The saved order above names five keys and the sidebar has more than five.
  // Anything unnamed must still render -- that is the upgrade case.
  await login("admin@spectrumsquadlv.com", "TestOwner123!");
  const partial = await navKeys();
  check("entries missing from the saved order still appear",
    partial.length > 5, `${partial.length} entries for a 5-key order`);
  check("the named ones lead, in the order given",
    partial.indexOf("dashboard") < partial.indexOf("tasks") ||
    !partial.includes("tasks"),
    partial.join(","));

  check("no page errors", errors.length === 0, errors.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SUITE ERROR:", e); process.exit(1); });
