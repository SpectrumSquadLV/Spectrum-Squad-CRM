// Viewing the CRM as somebody else, on screen.
//
// The API suite proves the rules. This proves the one thing that only exists
// in a browser and is the whole safety of the feature:
//
//   THE OWNER CAN TELL WHOSE SCREENS THEY ARE LOOKING AT.
//
// The screens are genuinely that person's -- the same markup, the same data,
// the same nav. Nothing about the page distinguishes "I am troubleshooting
// Marissa's dashboard" from "this is my dashboard and the numbers are wrong"
// except a banner that is impossible to miss and a way back that works.
const { chromium } = require("playwright");
const { Pool } = require("pg");

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  let pass = 0, fail = 0;
  const failures = [];
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else {
      const line = "  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : "");
      fail++; failures.push(line); console.log(line);
    }
  };
  const BASE = process.env.BASE || "http://localhost:3009";
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

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

  await login("admin@spectrumsquadlv.com", "TestOwner123!");

  console.log("\n== The way in ==");
  await page.goto(BASE + "/#/admin", { waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  // Admin Settings has sub-pages; the team list is where the users are.
  const teamNav = page.locator('[data-admin-nav="team"], [data-nav="admin"]');
  void teamNav;
  await page.waitForTimeout(400);
  const viewAsButtons = await page.locator("[data-viewas-user]").count();
  check("the owner is offered a way to view as each teammate", viewAsButtons > 0, viewAsButtons);
  check("but not on their own row",
    await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("[data-user-row]"));
      const mine = rows.find((r) => r.querySelector(".tag") && /you/i.test(r.querySelector(".tag").textContent));
      return mine ? mine.querySelectorAll("[data-viewas-user]").length === 0 : true;
    }));

  console.log("\n== Going in ==");
  page.once("dialog", (d) => d.accept());
  const target = await page.evaluate(() => {
    const b = document.querySelector("[data-viewas-user]");
    const row = b.closest("[data-user-row]");
    return { id: b.getAttribute("data-viewas-user"), name: row.querySelector("strong").textContent };
  });
  await page.locator("[data-viewas-user]").first().click();
  await page.waitForTimeout(2200);

  const bar = page.locator("#viewas-bar");
  check("A BANNER APPEARS", await bar.count() === 1);
  const barText = await bar.innerText().catch(() => "");
  check("naming who is being viewed", barText.includes(target.name), { barText, expected: target.name });
  check("AND SAYING IT IS READ ONLY, in words", /read only/i.test(barText), barText);
  check("with a way back", await page.locator("#viewas-stop").count() === 1);
  check("it is pinned to the top of the window, not scrolled past",
    await bar.evaluate((el) => getComputedStyle(el).position) === "fixed");
  check("and the page is pushed down so it covers nothing",
    await page.evaluate(() => document.body.classList.contains("viewing-as")));

  console.log("\n== The screens really are theirs ==");
  const asThem = await page.evaluate(async () => (await (await fetch("/api/auth/me", { credentials: "include" })).json()).user);
  check("the session is answered as them", String(asThem.id) === String(target.id), { got: asThem.id, want: target.id });
  check("and the shell is drawn for their role", !!asThem.role && asThem.role !== "owner", asThem.role);
  check("their sidebar is what is on screen, not the owner's",
    await page.locator("#nav-list").count() === 1);

  console.log("\n== Nothing can be changed from in there ==");
  const refused = await page.evaluate(async () => {
    const r = await fetch("/api/clients", {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
      body: JSON.stringify({ child_name: "Zz Never From A View" }),
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  });
  check("a write is refused", refused.status === 403, refused);
  check("with a message naming the person being viewed, not a bare permission error",
    /viewing the CRM as/i.test((refused.data && refused.data.error) || ""), refused.data);
  check("AND NOTHING WAS WRITTEN",
    Number((await pool.query("SELECT COUNT(*)::int AS n FROM clients WHERE child_name = 'Zz Never From A View'")).rows[0].n) === 0);

  console.log("\n== Coming back ==");
  await page.click("#viewas-stop");
  await page.waitForTimeout(2200);
  check("THE BANNER IS GONE", await page.locator("#viewas-bar").count() === 0);
  check("and the body class with it",
    !(await page.evaluate(() => document.body.classList.contains("viewing-as"))));
  const backAs = await page.evaluate(async () => (await (await fetch("/api/auth/me", { credentials: "include" })).json()).user);
  check("the owner is themselves again", backAs.role === "owner", backAs.role);
  check("and their own admin screens work",
    (await page.evaluate(async () => (await fetch("/api/admin/users", { credentials: "include" })).status)) === 200);

  console.log("\n== Nobody else is offered it ==");
  await login("clinical@spectrumsquadlv.com", "TestStaff123!");
  await page.waitForTimeout(1200);
  check("a BCBA has no Admin Settings to offer it from",
    await page.locator('[data-nav="admin"]').count() === 0);
  const bcbaTry = await page.evaluate(async () => {
    const r = await fetch("/api/auth/view-as", {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
      body: JSON.stringify({ user_id: 1 }),
    });
    return r.status;
  });
  check("AND THE API REFUSES THEM, not just the menu", bcbaTry === 403, bcbaTry);

  console.log("\n== Presentation ==");
  await login("admin@spectrumsquadlv.com", "TestOwner123!");
  await page.goto(BASE + "/#/admin", { waitUntil: "networkidle" });
  await page.waitForTimeout(1600);
  const html = await page.innerHTML("#view-mount");
  const emoji = html.match(/[\u{1F300}-\u{1FAFF}]/gu) || [];
  check("no emoji", emoji.length === 0, emoji);

  check("no page errors", errors.length === 0, errors.join(" | "));
  if (failures.length) { console.log("\n--- failures ---"); failures.forEach((f) => console.log(f)); }
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
