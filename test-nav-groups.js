// The grouped sidebar.
//
// About twenty-five top-level entries became a handful of collapsible groups.
// The thing worth testing is not that they fold -- it is that FOLDING CHANGED
// NOTHING ELSE. Grouping is presentational: membership is a list of keys
// applied over a list that role checks have already filtered, so a heading can
// never put a page in front of somebody who could not reach it before, and a
// group whose members are all hidden is not drawn at all.
//
// The rest is what a person actually does with it: open a group, land on a page
// and find its group already open, and reorder within a group without being
// able to drag a page out of one.
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : "")); }
  };
  const BASE = process.env.BASE || "http://localhost:3009";

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
    await page.waitForTimeout(1500);
  };

  // The whole sidebar as a structure: top-level rows in order, and what each
  // group holds.
  const sidebar = () => page.evaluate(() => {
    const nav = document.getElementById("nav-list");
    if (!nav) return null;
    const rows = [];
    Array.from(nav.children).forEach((el) => {
      if (el.dataset && el.dataset.navGroup) {
        const sub = document.getElementById("nav-sub-" + el.dataset.navGroup);
        rows.push({
          type: "group",
          key: el.dataset.navGroup,
          label: el.textContent.replace(/[▾▸⣿]/g, "").trim(),
          open: !!sub && !sub.hasAttribute("hidden"),
          members: sub ? Array.from(sub.querySelectorAll("[data-nav]")).map((b) => ({
            key: b.dataset.nav, label: b.textContent.trim(),
          })) : [],
        });
      } else if (el.dataset && el.dataset.nav) {
        rows.push({ type: "item", key: el.dataset.nav, label: el.textContent.trim() });
      }
    });
    return rows;
  });

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

  console.log("\n== The sidebar is grouped ==");
  let bar = await sidebar();
  check("the sidebar renders", Array.isArray(bar) && bar.length > 0, bar);
  const groups = bar.filter((r) => r.type === "group");
  const loose = bar.filter((r) => r.type === "item");
  check("there are collapsible groups", groups.length >= 3, groups.map((g) => g.label));
  check("THE TOP LEVEL IS SHORT NOW, not twenty-five rows",
    bar.length <= 10, `${bar.length} top-level rows`);
  check("Dashboard stays loose, because it is where everyone starts",
    loose.some((r) => r.key === "dashboard"), loose.map((r) => r.key));

  console.log("\n== The two renamed entries ==");
  const clients = groups.find((g) => g.key === "grp-clients");
  check("there is a Clients group", !!clients, groups.map((g) => g.key));
  check("THE PIPELINE ENTRY READS 'Clients'",
    !!clients && clients.members.some((m) => m.key === "pipeline" && m.label === "Clients"),
    clients && clients.members);
  check("AND CLIENT BEHAVIOR READS 'Programming'",
    !!clients && clients.members.some((m) => m.key === "client-behavior" && m.label === "Programming"),
    clients && clients.members);
  check("neither old label is left in the sidebar",
    !JSON.stringify(bar).includes("Client Pipeline") && !JSON.stringify(bar).includes("Client Behavior"), bar);
  check("the two sit together, which is the point",
    Math.abs(clients.members.findIndex((m) => m.key === "pipeline")
           - clients.members.findIndex((m) => m.key === "client-behavior")) === 1,
    clients.members.map((m) => m.key));
  check("their routes are untouched",
    await page.locator('[data-nav="pipeline"]').first().getAttribute("data-nav-hash") === "#/pipeline-v2" &&
    await page.locator('[data-nav="client-behavior"]').first().getAttribute("data-nav-hash") === "#/client-behavior");

  console.log("\n== Map stays where you can see it ==");
  // Grouping put Map inside Practice, which renders collapsed -- and from the
  // outside a page behind a closed heading is indistinguishable from a page
  // that has been removed. It was reported as "the map feature disappeared",
  // twice, which is the only evidence that matters about whether a menu works.
  const mapRow = bar.find((r) => r.key === "map");
  check("MAP IS A TOP-LEVEL ENTRY, not folded into a group",
    !!mapRow && mapRow.type === "item", bar.map((r) => r.key));
  check("and it is not also inside one, which would show it twice",
    !groups.some((g) => g.members.some((m) => m.key === "map")),
    groups.map((g) => [g.key, g.members.map((m) => m.key)]));
  check("it is visible without expanding anything",
    await page.locator('#nav-list > [data-nav="map"]').count() === 1);
  check("its route still works",
    await page.locator('[data-nav="map"]').first().getAttribute("data-nav-hash") === null ||
    await page.locator('[data-nav="map"]').first().getAttribute("data-nav-hash") === "#/map");

  console.log("\n== Opening and closing ==");
  check("Clients starts open, so the sidebar is not four blank headings",
    clients.open === true, clients);
  const staff = groups.find((g) => g.key === "grp-staff");
  check("the others start closed, which is the point of grouping", staff.open === false, staff);

  const hashBefore = await page.evaluate(() => location.hash);
  await page.click('[data-nav-group="grp-staff"]');
  await page.waitForTimeout(350);
  check("A HEADING EXPANDS RATHER THAN NAVIGATING",
    (await page.evaluate(() => location.hash)) === hashBefore,
    await page.evaluate(() => location.hash));
  bar = await sidebar();
  check("and the group is open", bar.find((g) => g.key === "grp-staff").open === true);
  check("its aria-expanded says so",
    (await page.getAttribute('[data-nav-group="grp-staff"]', "aria-expanded")) === "true");
  await page.click('[data-nav-group="grp-staff"]');
  await page.waitForTimeout(350);
  bar = await sidebar();
  check("clicking again closes it", bar.find((g) => g.key === "grp-staff").open === false);

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  bar = await sidebar();
  check("the open/closed state survives a reload",
    bar.find((g) => g.key === "grp-staff").open === false, bar.find((g) => g.key === "grp-staff"));

  console.log("\n== Landing on a page inside a closed group ==");
  await page.goto(BASE + "/#/supervision");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1600);
  bar = await sidebar();
  const staffNow = bar.find((g) => g.key === "grp-staff");
  check("THE GROUP HOLDING THE CURRENT PAGE OPENS ITSELF",
    staffNow.open === true, staffNow);
  check("and the page is marked active inside it",
    await page.locator('#nav-sub-grp-staff [data-nav="supervision"].active').count() === 1);

  console.log("\n== Grouping cannot reveal anything ==");
  const ownerKeys = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#nav-list [data-nav]")).map((b) => b.dataset.nav));
  await login("intake@spectrumsquadlv.com", "TestStaff123!");
  const intake = await sidebar();
  const intakeKeys = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#nav-list [data-nav]")).map((b) => b.dataset.nav));
  check("intake still gets a usable sidebar", intake.length > 1, intake.map((r) => r.key));
  check("A GROUP DOES NOT PUT A FORBIDDEN PAGE IN FRONT OF THEM",
    !intakeKeys.includes("financial-center") && !intakeKeys.includes("hr") && !intakeKeys.includes("admin"),
    intakeKeys);
  check("and they see fewer entries than an owner, exactly as before",
    intakeKeys.length < ownerKeys.length, `${intakeKeys.length} vs ${ownerKeys.length}`);
  check("A GROUP WITH NOTHING IN IT IS NOT DRAWN",
    !intake.some((r) => r.type === "group" && r.members.length === 0), intake);
  check("intake gets no Admin group at all",
    !intake.some((r) => r.key === "grp-admin"), intake.map((r) => r.key));
  check("but does get their client pages",
    intakeKeys.includes("pipeline"), intakeKeys);

  console.log("\n== Reordering with groups ==");
  await login("admin@spectrumsquadlv.com", "TestOwner123!");
  await startReorder();
  const reorder = await page.evaluate(() => ({
    // Every group is expanded while reordering, or its members could not be
    // reached to drag.
    allOpen: Array.from(document.querySelectorAll(".nav-sub")).every((s) => !s.hasAttribute("hidden")),
    headingsDraggable: Array.from(document.querySelectorAll("[data-nav-group]")).every((h) => h.getAttribute("draggable") === "true"),
    membersDraggable: Array.from(document.querySelectorAll(".nav-sub > [data-nav]")).every((m) => m.getAttribute("draggable") === "true"),
  }));
  check("every group is expanded while reordering", reorder.allOpen === true, reorder);
  check("headings can be dragged as units", reorder.headingsDraggable === true, reorder);
  check("and members can be dragged within their group", reorder.membersDraggable === true, reorder);

  // Move Programming above Clients inside the group, and save.
  await page.evaluate(() => {
    const sub = document.getElementById("nav-sub-grp-clients");
    const first = sub.querySelector("[data-nav]");
    const prog = sub.querySelector('[data-nav="client-behavior"]');
    sub.insertBefore(prog, first);
  });
  await page.click("#nav-reorder-save");
  await page.waitForTimeout(1600);
  bar = await sidebar();
  let cg = bar.find((g) => g.key === "grp-clients");
  check("an order set inside a group is applied",
    cg.members[0].key === "client-behavior", cg.members.map((m) => m.key));

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1700);
  bar = await sidebar();
  cg = bar.find((g) => g.key === "grp-clients");
  check("AND IT SURVIVES A RELOAD, so it is stored not just local",
    cg.members[0].key === "client-behavior", cg.members.map((m) => m.key));
  check("no member escaped its group",
    cg.members.every((m) => ["pipeline", "client-behavior", "auth-alerts", "outbox", "leads"].includes(m.key)),
    cg.members.map((m) => m.key));
  check("and nothing was lost",
    cg.members.length >= 2 && bar.filter((r) => r.type === "group").length >= 3, bar.map((r) => r.key));

  const stored = await page.evaluate(async () =>
    ((await (await fetch("/api/nav-order", { credentials: "include" })).json()).order || []));
  check("the saved order is keys only, with no labels or routes in it",
    stored.every((k) => typeof k === "string" && /^[a-z0-9-]+$/i.test(k)), stored.slice(0, 8));
  check("and it records group headings alongside pages",
    stored.some((k) => k.startsWith("grp-")), stored.slice(0, 8));

  console.log("\n== Presentation ==");
  const navHtml = await page.innerHTML("#nav-list");
  const emoji = navHtml.match(/[\u{1F300}-\u{1FAFF}]/gu) || [];
  check("no emoji in the sidebar", emoji.length === 0, emoji);
  const overflow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
  check("nothing overflows horizontally", overflow.doc <= overflow.win + 1, overflow);

  check("no page errors", errors.length === 0, errors.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
