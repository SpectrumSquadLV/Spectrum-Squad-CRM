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
  // Every entry anywhere in the sidebar -- used for "can this role reach it".
  const navKeys = () => page.evaluate(() =>
    Array.from(document.querySelectorAll("#nav-list [data-nav]")).map((b) => b.dataset.nav));
  // The top-level units in order -- used for "where did it end up".
  const navUnits = () => page.evaluate(() =>
    Array.from(document.getElementById("nav-list").children)
      .filter((el) => el.hasAttribute("data-nav") || el.hasAttribute("data-nav-group"))
      .map((el) => el.dataset.nav || el.dataset.navGroup));

  // "Reorder menu" is started from Admin Settings now, not from a button under
  // the navigation. The drag bar still appears in the sidebar once it is on,
  // because the sidebar is the thing being dragged.
  const startReorder = async () => {
    await page.goto(BASE + "/#/admin", { waitUntil: "networkidle" });
    await page.waitForSelector("#admin-nav-reorder", { timeout: 15000 });
    await page.click("#admin-nav-reorder");
    await page.waitForTimeout(800);
  };
  await login("admin@spectrumsquadlv.com", "TestOwner123!");

  console.log("\n== An admin is offered the control ==");
  // IT IS NO LONGER UNDER THE NAVIGATION. It sat there on every admin's screen,
  // every day, for something used about twice a year.
  check("THE SIDEBAR DOES NOT CARRY A REORDER BUTTON",
    await page.locator("#nav-reorder-open").count() === 0);
  await page.goto(BASE + "/#/admin", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  check("but an owner can still start it, from Admin Settings",
    await page.locator("#admin-nav-reorder").count() === 1);
  await page.goto(BASE + "/#/dashboard", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const natural = await navKeys();
  check("the sidebar renders entries", natural.length > 3, natural.join(","));

  console.log("\n== Reorder mode ==");
  await startReorder();
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
  // Move the last TOP-LEVEL UNIT to the front, the way a drop does. Direct
  // children only: a group's members live inside its .nav-sub, and dragging one
  // out of its group is refused because membership is structural.
  const reversedFirst = await page.evaluate(() => {
    const list = document.getElementById("nav-list");
    const units = Array.from(list.children).filter(
      (el) => el.hasAttribute("data-nav") || el.hasAttribute("data-nav-group"));
    const last = units[units.length - 1], first = units[0];
    const key = (el) => el.dataset.nav || el.dataset.navGroup;
    // A heading and its sub-list travel together.
    list.insertBefore(last, first);
    if (last.dataset.navGroup) {
      const sub = document.getElementById("nav-sub-" + last.dataset.navGroup);
      if (sub) list.insertBefore(sub, first);
    }
    return Array.from(list.children)
      .filter((el) => el.hasAttribute("data-nav") || el.hasAttribute("data-nav-group"))
      .map(key);
  });
  await page.click("#nav-reorder-save");
  await page.waitForTimeout(1500);
  const afterSave = await navUnits();
  check("the new order is applied immediately", afterSave[0] === reversedFirst[0],
    `${afterSave[0]} vs ${reversedFirst[0]}`);
  check("reorder mode closes after saving",
    await page.locator("#nav-reorder-save").count() === 0);

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  const afterReload = await navUnits();
  check("and it survives a reload, so it is stored not just local",
    afterReload[0] === reversedFirst[0], afterReload.slice(0, 3).join(","));

  // Positions are compared as UNITS; losses are compared as ENTRIES. Mixing the
  // two reads as "19 tabs vanished" when all that happened is that they moved
  // inside a group.
  const afterReloadAll = await navKeys();
  check("no entry was lost in the reorder",
    afterReloadAll.length === natural.length, `${afterReloadAll.length} vs ${natural.length}`);
  check("every original entry is still present",
    natural.every((k) => afterReloadAll.includes(k)),
    natural.filter((k) => !afterReloadAll.includes(k)).join(","));

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
    await page.locator("#nav-reorder-open, #admin-nav-reorder").count() === 0);

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
  const addonPresent = await page.evaluate(() => {
    const at = (id) => {
      const b = document.getElementById(id);
      if (!b) return null;
      const sub = b.closest(".nav-sub");
      return { key: b.dataset.nav, group: sub ? sub.dataset.navSub : null };
    };
    return {
      supply: at("supply-nav-btn"), ot: at("ot-nav-btn"),
      keys: Array.from(document.querySelectorAll("#nav-list [data-nav]")).map((b) => b.dataset.nav),
    };
  });
  check("the add-on buttons are on the sidebar for an admin",
    !!addonPresent.supply && !!addonPresent.ot, addonPresent);
  check("and they carry a key the shell can order",
    addonPresent.keys.includes("supply") && addonPresent.keys.includes("ot"),
    addonPresent.keys.join(","));
  // They used to sit loose below every heading. Being placed in a group is the
  // whole point: an add-on's page is a practice page like any other.
  check("AND THEY ARE PLACED IN A GROUP RATHER THAN LEFT LOOSE AT THE END",
    addonPresent.supply.group === "grp-practice" && addonPresent.ot.group === "grp-practice",
    addonPresent);

  await startReorder();
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

  // Drag Supply Requests to the front OF ITS OWN GROUP and save. Dragging it to
  // the top level is refused now, and rightly: membership is structural, so a
  // drop that appeared to work and then reverted on the next render would read
  // as a bug rather than as a rule.
  await page.evaluate(() => {
    const sub = document.getElementById("nav-sub-grp-practice");
    const first = sub.querySelector("[data-nav]");
    sub.insertBefore(document.getElementById("supply-nav-btn"), first);
  });
  await page.click("#nav-reorder-save");
  await page.waitForTimeout(1500);
  const storedOrder = await page.evaluate(async () =>
    ((await (await fetch("/api/nav-order", { credentials: "include" })).json()).order || []));
  check("the saved order records the add-on where it was dropped",
    storedOrder.indexOf("supply") < storedOrder.indexOf("events"),
    storedOrder.filter((k) => ["supply", "ot", "events", "policies"].includes(k)).join(","));

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(2200);
  const placed = await page.evaluate(() => {
    const sub = document.getElementById("nav-sub-grp-practice");
    const members = sub ? Array.from(sub.querySelectorAll("[data-nav]")).map((b) => b.dataset.nav) : [];
    const list = document.getElementById("nav-list");
    const units = Array.from(list.children)
      .filter((el) => el.hasAttribute("data-nav") || el.hasAttribute("data-nav-group"))
      .map((el) => el.dataset.nav || el.dataset.navGroup);
    return { members, units, adminLast: units[units.length - 1] === "grp-admin" };
  });
  check("AND THE ADD-ON BUTTON COMES BACK IN THAT POSITION AFTER A RELOAD",
    placed.members[0] === "supply", placed.members.join(","));
  check("the Admin group is still last", placed.adminLast === true, placed.units.join(","));
  check("nothing was lost placing it", placed.units.length >= 5, placed.units.join(","));

  check("no page errors", errors.length === 0, errors.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SUITE ERROR:", e); process.exit(1); });
