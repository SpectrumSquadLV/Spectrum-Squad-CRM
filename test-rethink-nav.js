// The Rethink shortcut in the sidebar.
//
// It is a LINK OUT OF THE CRM and nothing else -- no page, no frame, no
// reimplementation of anything Rethink does. Which sounds like it needs no
// test, and is exactly why it does: every way this goes wrong is a way of
// quietly becoming something other than a shortcut.
//
//   * OPENING OVER THE TOP of the page somebody is working on. The whole point
//     is jumping out mid-task and coming back; a nav button that replaces the
//     current view loses whatever they had open.
//   * OPENING IN A FRAME. Same symptom, worse: a logged-in third-party
//     application rendered inside this one, on this origin.
//   * target="_blank" WITH NO rel="noopener". The opened page gets a live
//     handle back to the CRM tab and can navigate it wherever it likes.
//   * A DEAD ADDRESS. The one thing worse than no shortcut is a shortcut the
//     whole practice clicks that goes nowhere, so the URL is a setting and
//     this suite proves an admin can change it and a blank one draws nothing.
//   * BEING BURIED. It sits at the top level. A shortcut you have to expand a
//     collapsed heading to reach is not a shortcut -- which is how Map came to
//     be reported as missing, twice.
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
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
  const setUrl = async (url) => {
    const r = await page.evaluate(async (u) => {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rethink_app_url: u }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }, url);
    // A FULL RELOAD, not a hash change. The sidebar reads this setting once on
    // boot, so goto() to a URL differing only by its fragment is a same-document
    // navigation and would leave the old value on screen -- which is what an
    // admin sees too: change the setting, refresh, done.
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1600);
    return r;
  };

  await login("admin@spectrumsquadlv.com", "TestOwner123!");

  console.log("\n== The address it ships pointing at ==");
  // PINNED, because the first value here was a guess and the guess was wrong.
  // https://app.rethinkbehavioralhealth.com looked right beside the id. and
  // dwh. hosts this CRM talks to, and has no DNS record at all -- the entry
  // pointed the whole practice at a hostname that does not exist. The value
  // below is the one the practice signs in at. Changing it should take a
  // deliberate edit here as well, by somebody who has checked.
  const serverSrc = require("fs").readFileSync(require("path").join(__dirname, "server.js"), "utf8");
  const shipped = /rethink_app_url:\s*"([^"]*)"/.exec(serverSrc);
  check("the default is the practice's real sign-in address",
    !!shipped && shipped[1] === "https://webapp.rethinkbehavioralhealth.com/Healthcare#/Login",
    shipped && shipped[1]);
  check("AND NOT THE HOST THAT DOES NOT EXIST",
    !!shipped && !/\/\/app\.rethinkbehavioralhealth\.com/.test(shipped[1]), shipped && shipped[1]);

  console.log("\n== It is there, and it is a link ==");
  const item = page.locator('[data-nav="rethink"]');
  check("the sidebar has a Rethink entry", await item.count() === 1, await item.count());
  check("labelled Rethink", (await item.innerText()).trim().startsWith("Rethink"), await item.innerText());
  check("IT IS AN ANCHOR, not a button -- that is what makes ctrl-click and middle-click work",
    await item.evaluate((el) => el.tagName) === "A", await item.evaluate((el) => el.tagName));
  check("pointing at the configured address",
    /^https:\/\//.test(await item.getAttribute("href") || ""), await item.getAttribute("href"));

  console.log("\n== It opens a new tab, and does not hand it the CRM ==");
  check("target is a new tab", await item.getAttribute("target") === "_blank",
    await item.getAttribute("target"));
  const rel = (await item.getAttribute("rel")) || "";
  check("REL CARRIES noopener -- without it the opened page can navigate this one",
    /\bnoopener\b/.test(rel), rel);
  check("and noreferrer", /\bnoreferrer\b/.test(rel), rel);

  console.log("\n== The marker ==");
  check("an external-link mark sits on the entry",
    await item.locator(".nav-ext").count() === 1);
  check("it is hidden from screen readers, which get words instead",
    await item.locator(".nav-ext").getAttribute("aria-hidden") === "true");
  check("and those words say a new tab opens",
    /opens in a new tab/i.test(await item.innerText()), await item.innerText());
  check("it is styled as a nav row like the others, not as a raw link",
    await item.evaluate((el) => el.classList.contains("nav-item")));
  check("with no underline, matching the sidebar",
    await item.evaluate((el) => getComputedStyle(el).textDecorationLine) === "none");

  console.log("\n== Where it sits ==");
  check("AT THE TOP LEVEL, not inside a collapsed group",
    await page.evaluate(() => {
      const el = document.querySelector('[data-nav="rethink"]');
      return !!el && el.parentElement && el.parentElement.id === "nav-list";
    }));
  check("and reachable without expanding anything", await item.isVisible());
  const order = await page.evaluate(() => Array.from(document.querySelectorAll("#nav-list > [data-nav], #nav-list > [data-nav-group]"))
    .map((el) => el.dataset.nav || el.dataset.navGroup));
  check("beside BCBA Hub, with the other clinical day-to-day entries",
    order.indexOf("rethink") === order.indexOf("bcba-hub") + 1, order.join(","));

  console.log("\n== Clicking it leaves the CRM alone ==");
  const before = page.url();
  const [popup] = await Promise.all([
    context.waitForEvent("page", { timeout: 8000 }).catch(() => null),
    item.click(),
  ]);
  check("A NEW TAB OPENS", !!popup, popup ? await popup.url() : "no popup");
  check("THE CRM PAGE IS UNCHANGED -- it did not navigate away",
    page.url() === before, { before, after: page.url() });
  check("and the dashboard is still rendered under it",
    await page.locator("#view-mount").count() === 1);
  if (popup) await popup.close().catch(() => {});

  console.log("\n== Nothing is framed ==");
  check("THE CRM LOADS NO IFRAME FOR IT",
    await page.locator("iframe").count() === 0, await page.locator("iframe").count());
  check("and there is no #/rethink route pretending to be Rethink",
    await page.evaluate(async () => {
      location.hash = "#/rethink";
      await new Promise((r) => setTimeout(r, 900));
      return document.querySelectorAll("iframe").length === 0;
    }));
  await page.goto(BASE + "/#/dashboard", { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  console.log("\n== The address is the practice's to set ==");
  const moved = await setUrl("https://rethink.example.invalid/app");
  check("an owner can change it", moved.status === 200, moved.body);
  check("AND THE SIDEBAR FOLLOWS IT",
    await page.locator('[data-nav="rethink"]').getAttribute("href") === "https://rethink.example.invalid/app",
    await page.locator('[data-nav="rethink"]').getAttribute("href"));
  const bad = await setUrl("javascript:alert(1)");
  check("A NON-https ADDRESS IS REFUSED -- this lands in an href on every screen",
    bad.status === 400, bad.body);
  check("and the entry still points at the last good one",
    await page.locator('[data-nav="rethink"]').getAttribute("href") === "https://rethink.example.invalid/app");
  const blank = await setUrl("");
  check("clearing it is allowed", blank.status === 200, blank.body);
  check("AND DRAWS NO ENTRY AT ALL, rather than a dead link",
    await page.locator('[data-nav="rethink"]').count() === 0);
  await setUrl("https://app.rethinkbehavioralhealth.com");
  check("putting it back brings the entry back",
    await page.locator('[data-nav="rethink"]').count() === 1);

  console.log("\n== Who gets it ==");
  await login("clinical@spectrumsquadlv.com", "TestStaff123!");
  await page.waitForTimeout(1000);
  check("a BCBA has it, which is the point of the feature",
    await page.locator('[data-nav="rethink"]').count() === 1);
  check("as an anchor for them too",
    await page.locator('[data-nav="rethink"]').evaluate((el) => el.tagName) === "A");
  check("and they cannot change where it points",
    (await page.evaluate(async () => (await fetch("/api/admin/settings", {
      method: "PATCH", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rethink_app_url: "https://evil.example.invalid" }),
    })).status)) === 403);

  console.log("\n== Presentation ==");
  await login("admin@spectrumsquadlv.com", "TestOwner123!");
  await page.waitForTimeout(1200);
  const html = await page.innerHTML("#nav-list");
  const emoji = html.match(/[\u{1F300}-\u{1FAFF}]/gu) || [];
  check("no emoji in the sidebar", emoji.length === 0, emoji);
  await page.setViewportSize({ width: 480, height: 900 });
  await page.waitForTimeout(600);
  // MEASURED AGAINST THE SIDEBAR, not the viewport, and deliberately so. The
  // document is wider than a 480px screen on every page of this application
  // for a reason that predates this entry: the global border-box rule never
  // applies (a stray declaration makes the parser swallow it), so .sidebar is
  // written 240px and renders 272px. Asserting the viewport here would either
  // fail forever or quietly make this suite the owner of an app-wide layout
  // bug. What this change controls is whether ITS row fits the column it was
  // given, so that is what is checked -- and the shell number is printed on
  // every run so it stays visible rather than buried.
  const fit = await page.evaluate(() => {
    const el = document.querySelector('[data-nav="rethink"]');
    const side = document.querySelector(".sidebar");
    return {
      row: el ? el.getBoundingClientRect().width : 0,
      sidebar: side ? side.getBoundingClientRect().width : 0,
      scroll: el ? el.scrollWidth : 0,
      doc: document.documentElement.scrollWidth,
      win: window.innerWidth,
    };
  });
  console.log(`  (shell: sidebar ${fit.sidebar}px, document ${fit.doc}px against a ${fit.win}px viewport -- pre-existing, see the comment above)`);
  check("the Rethink row fits the sidebar it is in", fit.row <= fit.sidebar + 1, fit);
  check("and its own content does not spill out of the row",
    fit.scroll <= Math.ceil(fit.row) + 1, fit);

  check("no page errors", errors.length === 0, errors.join(" | "));
  if (failures.length) { console.log("\n--- failures ---"); failures.forEach((f) => console.log(f)); }
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
