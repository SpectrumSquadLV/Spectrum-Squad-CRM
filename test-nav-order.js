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
      body: JSON.stringify({ order: ["hr", "staff", "financial", "ot", "dashboard", "pipeline"] }),
    });
  });

  await login("intake@spectrumsquadlv.com", "TestStaff123!");
  const intakeKeys = await navKeys();
  check("intake still sees a usable sidebar", intakeKeys.length > 1, intakeKeys.join(","));
  check("an ordered key their role does not allow does NOT appear",
    !intakeKeys.includes("hr") && !intakeKeys.includes("financial"),
    intakeKeys.join(","));
  // The same question for an add-on button, which is the new part. Occupational
  // Therapy has a key in the saved order now, and its bundle is loaded on this
  // page -- but OT_ROLES does not include intake, so its own check must be the
  // thing that decides, not the order naming it.
  check("AN ORDERED ADD-ON KEY DOES NOT CONJURE ITS BUTTON EITHER",
    !intakeKeys.includes("ot"), intakeKeys.join(","));
  check("and no OT button was drawn by any other route",
    await page.locator("#ot-nav-btn").count() === 0);
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

  console.log("\n== A new tab is not swallowed by an old order ==");
  // The saved order above names six keys and the sidebar has more than five.
  // Anything unnamed must still render -- that is the upgrade case.
  await login("admin@spectrumsquadlv.com", "TestOwner123!");
  const partial = await navKeys();
  check("entries missing from the saved order still appear",
    partial.length > 5, `${partial.length} entries for a 6-key order`);
  check("the named ones lead, in the order given",
    partial.indexOf("dashboard") < partial.indexOf("tasks") ||
    !partial.includes("tasks"),
    partial.join(","));

  console.log("\n== Add-on buttons reorder like everything else ==");
  // Supply Requests and Occupational Therapy are appended to the same <nav> by
  // their own bundles, after the shell has drawn. They carry a data-nav key now
  // and take part in the order like any other entry.
  await login("admin@spectrumsquadlv.com", "TestOwner123!");
  await page.waitForTimeout(1200);
  const addonPresent = await page.evaluate(() => ({
    supply: !!document.getElementById("supply-nav-btn"),
    ot: !!document.getElementById("ot-nav-btn"),
    // Direct children only: the Admin group's entries live inside .nav-sub and
    // are not top-level rows, so they are neither draggable nor saved.
    keys: Array.from(document.getElementById("nav-list").children)
      .filter((el) => el.hasAttribute("data-nav")).map((b) => b.dataset.nav),
  }));
  check("the add-on buttons are on the sidebar for an admin",
    addonPresent.supply && addonPresent.ot, addonPresent);
  check("and they are entries the shell can order",
    addonPresent.keys.includes("supply") && addonPresent.keys.includes("ot"),
    addonPresent.keys.join(","));

  await page.click("#nav-reorder-open");
  await page.waitForTimeout(800);
  const addonDraggable = await page.evaluate(() => ({
    supply: document.getElementById("supply-nav-btn").getAttribute("draggable") === "true",
    ot: document.getElementById("ot-nav-btn").getAttribute("draggable") === "true",
    handles: !!document.getElementById("supply-nav-btn").querySelector(".nav-drag-handle"),
    // Nothing top-level may be left undraggable now, or it would be a row you
    // can see but cannot move.
    stuck: Array.from(document.getElementById("nav-list").children)
      .filter((el) => el.hasAttribute("data-nav") && el.getAttribute("draggable") !== "true").length,
  }));
  check("AN ADD-ON BUTTON IS DRAGGABLE", addonDraggable.supply && addonDraggable.ot, addonDraggable);
  check("and it gets a drag handle like the rest", addonDraggable.handles === true, addonDraggable);
  check("no top-level entry is left unmovable", addonDraggable.stuck === 0, addonDraggable.stuck);

  // Clicking one mid-reorder must not navigate either -- its click listener
  // belongs to the add-on, not to the shell, so the shell has to stop it.
  const hashPreClick = await page.evaluate(() => location.hash);
  await page.click("#supply-nav-btn");
  await page.waitForTimeout(400);
  check("clicking an add-on entry while reordering does not navigate away",
    (await page.evaluate(() => location.hash)) === hashPreClick,
    await page.evaluate(() => location.hash));

  // Drag Supply Requests to the very front and save it.
  await page.evaluate(() => {
    const list = document.getElementById("nav-list");
    const first = Array.from(list.children).find((el) => el.hasAttribute("data-nav"));
    list.insertBefore(document.getElementById("supply-nav-btn"), first);
  });
  await page.click("#nav-reorder-save");
  await page.waitForTimeout(1500);
  const storedOrder = await page.evaluate(async () =>
    ((await (await fetch("/api/nav-order", { credentials: "include" })).json()).order || []));
  check("the saved order records the add-on where it was dropped",
    storedOrder[0] === "supply", storedOrder.slice(0, 4).join(","));

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(2200);
  const placed = await page.evaluate(() => {
    const list = document.getElementById("nav-list");
    const entries = Array.from(list.children).filter((el) => el.hasAttribute("data-nav"));
    const admin = document.getElementById("nav-admin-toggle");
    return {
      first: entries.length ? entries[0].dataset.nav : null,
      // Admin Settings is a group, not a row, and stays at the end.
      adminLast: !admin || entries.every((e) => !!(e.compareDocumentPosition(admin) & Node.DOCUMENT_POSITION_FOLLOWING)),
      count: entries.length,
    };
  });
  check("AND THE ADD-ON BUTTON COMES BACK IN THAT POSITION AFTER A RELOAD",
    placed.first === "supply", placed);
  check("the Admin group is still last", placed.adminLast === true, placed);
  check("nothing was lost placing it", placed.count >= addonPresent.keys.length, placed);

  check("no page errors", errors.length === 0, errors.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SUITE ERROR:", e); process.exit(1); });
