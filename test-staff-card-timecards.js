// The staff card's Timecards section folds.
//
// A person two years into the job has fifty-two pay periods on their card, all
// of them rendered flat and fully expanded. The sections BELOW timecards --
// supervision, RBT fidelity, attendance, submitted availability, the activity
// log -- were then several screens down, which in practice meant nobody
// reached them. So timecards became a <details>, closed by default, using the
// same collapsible-section pattern the client card already uses.
//
// Folding something away only works if the closed header still tells you
// whether it needs opening, so the header carries a chip: how many timecards
// there are, and whether any are unsigned or carry open flags. These tests
// pin BOTH sides of that chip -- a clean set of timecards and a flagged one --
// because a chip that is always the same colour tells you nothing.
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3009";

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("dialog", async (d) => { await d.accept(); });

  let pass = 0, fail = 0;
  const failures = [];
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; failures.push(name); console.log("  FAIL  " + name + (detail ? "  -> " + JSON.stringify(detail).slice(0, 300) : "")); }
  };
  const section = (t) => console.log("\n== " + t + " ==");

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', "TestOwner123!");
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(2500);

  const api = (path, opts) => page.evaluate(async ({ p, o }) => {
    const r = await fetch(p, {
      method: (o && o.method) || "GET", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: o && o.body ? JSON.stringify(o.body) : undefined,
    });
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  }, { p: path, o: opts || null });

  const stamp = Date.now().toString(36);
  const mk = async (name) => (await api("/api/hr/employees", { method: "POST", body: { name: `${name} ${stamp}`, role_title: "RBT", email: `${name.toLowerCase()}${stamp}@x.test` } })).data.id;
  const d = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  // Clean hours: in and out on both days, so nothing is flagged.
  const clean = [
    { date: d(-14), clock_in: "09:00", clock_out: "17:00" },
    { date: d(-13), clock_in: "09:00", clock_out: "17:00" },
  ];
  // A missing clock-out is what the importer flags.
  const broken = [{ date: d(-7), clock_in: "09:00" }];

  const tc = (emp, entries, start, end) => api("/api/hr/timecards/import", { method: "POST", body: {
    employee_id: emp, source: "manual", pay_period_start: start, pay_period_end: end, entries,
  } });

  // The staff card is not closed by Escape, so a leftover backdrop would sit
  // on top of the next one and every selector below would read the wrong
  // card. Clear them before opening.
  const closeCards = () => page.evaluate(() => document.querySelectorAll(".modal-backdrop").forEach((b) => b.remove()));
  const open = async (emp) => {
    await page.goto(BASE + "/#/staff", { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    await closeCards();
    await page.evaluate((id) => openStaffModal(String(id), document.createElement("div")), emp);
    // Attached, not visible: folded away is the whole point.
    await page.waitForSelector('details.cs[data-cs="staff-timecards"]', { state: "attached", timeout: 10000 });
  };
  const sect = () => page.$('details.cs[data-cs="staff-timecards"]');
  const chip = () => page.$eval('details.cs[data-cs="staff-timecards"] .cs-chip', (e) => ({ text: e.textContent, tone: e.className.replace("cs-chip", "").trim() })).catch(() => null);
  const esc = () => closeCards();

  // ------------------------------------------------------------------
  section("A staff member with no timecards");
  const none = await mk("Nora");
  await open(none);
  check("exactly one staff card is open", (await page.$$(".modal-backdrop")).length === 1);
  check("the timecards section is a fold, not a flat list", !!(await sect()));
  check("...and it starts closed", (await page.$eval('details.cs[data-cs="staff-timecards"]', (e) => e.open)) === false);
  const c0 = await chip();
  check("the closed header says there are none", c0 && /None/.test(c0.text), c0);
  check("...in the neutral tone, not a warning", c0 && c0.tone === "none", c0);
  check("the body is still in the card, just folded", !!(await page.$("#staff-timecards")));
  // A closed <details> still gives its hidden children a measurable box, so
  // the thing to assert is what the viewer gets: the list is not rendered,
  // and the section occupies a header and nothing more.
  check("the list is not rendered while closed",
    (await page.$eval("#staff-timecards", (e) => e.checkVisibility())) === false);
  const closedH = await page.$eval('details.cs[data-cs="staff-timecards"]', (e) => e.getBoundingClientRect().height);
  check("the whole section is a header's worth of space", closedH > 0 && closedH < 70, closedH);
  await esc();

  // ------------------------------------------------------------------
  section("A staff member whose timecards are all clean");
  const ok = await mk("Owen");
  const t1 = await tc(ok, clean, d(-14), d(-1));
  check("a clean timecard imports without flags", t1.status === 201 && Number(t1.data.flags) === 0, t1.data);
  await open(ok);
  const c1 = await chip();
  check("the header counts them", c1 && /1/.test(c1.text), c1);
  check("...and says they are unsigned, because an imported timecard is", c1 && /unsigned/.test(c1.text), c1);
  check("...in the warning tone", c1 && c1.tone === "warn", c1);
  await esc();

  // ------------------------------------------------------------------
  section("A staff member with an open flag");
  const bad = await mk("Pria");
  const t2 = await tc(bad, broken, d(-7), d(-1));
  check("a timecard with a missing clock-out is flagged", t2.status === 201 && Number(t2.data.flags) > 0, t2.data);
  await open(bad);
  const c2 = await chip();
  check("the header names the open flag, not just the count", c2 && /open flag/.test(c2.text), c2);
  check("...in the warning tone", c2 && c2.tone === "warn", c2);

  // ------------------------------------------------------------------
  section("Opening the fold");
  await page.click('details.cs[data-cs="staff-timecards"] > summary');
  await page.waitForTimeout(350);
  check("clicking the header opens it", (await page.$eval('details.cs[data-cs="staff-timecards"]', (e) => e.open)) === true);
  check("the timecard is now rendered",
    (await page.$eval("#staff-timecards", (e) => e.checkVisibility())) === true);
  const openH = await page.$eval('details.cs[data-cs="staff-timecards"]', (e) => e.getBoundingClientRect().height);
  check("...and the section grows to hold it", openH > closedH + 40, { closedH, openH });
  const openText = await page.textContent("#staff-timecards");
  check("it lists the pay period", /\w+ \d+/.test(openText), openText.slice(0, 160));
  check("...and still offers to request a signature", !!(await page.$("#staff-timecards [data-req-sig]")));

  // The choice is remembered, the way the client card's sections are.
  await esc();
  await open(bad);
  check("it is still open the next time the card is opened",
    (await page.$eval('details.cs[data-cs="staff-timecards"]', (e) => e.open)) === true);
  await page.click('details.cs[data-cs="staff-timecards"] > summary');
  await page.waitForTimeout(350);
  await esc();
  await open(bad);
  check("...and closing it is remembered too",
    (await page.$eval('details.cs[data-cs="staff-timecards"]', (e) => e.open)) === false);

  // ------------------------------------------------------------------
  section("The sections under it are reachable");
  const after = await page.evaluate(() => {
    const tcs = document.querySelector('details.cs[data-cs="staff-timecards"]');
    const names = ["staff-supervision", "staff-attendance", "staff-availability", "staff-activity"];
    const top = tcs.getBoundingClientRect().bottom;
    return names.map((n) => {
      const el = document.getElementById(n);
      return { n, present: !!el, below: el ? Math.round(el.getBoundingClientRect().top - top) : null };
    });
  });
  check("supervision, attendance, availability and the activity log are all still there",
    after.every((x) => x.present), after);
  check("...and the folded timecards do not push them a screenful away",
    after.every((x) => x.below != null && x.below < 1200), after);

  check("no page errors", errors.length === 0, errors);
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("\nFailures:"); failures.forEach((f) => console.log("  - " + f)); }
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
