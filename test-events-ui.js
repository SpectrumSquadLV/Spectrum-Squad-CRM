// The Events screen, and proof the rest of the CRM still works.
//
// Two jobs, and the second matters more:
//
//   1. Events opens, the Halloween Palooza is there as an ordinary row, and the
//      tabs and forms actually work.
//   2. NOTHING ELSE BROKE. A new nav item and a new script tag are cheap ways
//      to take down a page that has nothing to do with the change, so every
//      primary area is loaded and checked for a page error.
//
// It also checks the thing the whole architecture rests on: the permanent
// navigation item says "Events", not the name of one event.
//
//   BASE=http://127.0.0.1:3011 node test-events-ui.js
"use strict";
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3011";

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("dialog", async (d) => { await d.accept(); });

  let pass = 0, fail = 0;
  // Failures are collected as well as printed. run-tests.js shows only the tail
  // of a suite's output, so a failure early in a long browser run scrolls off
  // and the summary is all anybody sees -- which makes it unfixable without
  // re-running by hand.
  const failures = [];
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else {
      fail++;
      const line = "  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : "");
      failures.push(line);
      console.log(line);
    }
  };
  const section = (t) => console.log("\n== " + t + " ==");

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', "TestOwner123!");
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(2500);

  // Setting location.hash to the value it already holds fires no hashchange, so
  // the router never re-runs and the screen silently shows stale data. Going
  // via a different hash first makes every navigation real.
  // Navigation here avoids two traps. Polling for "any content" returns the
  // PREVIOUS page's text immediately, so it waits for the text to CHANGE.
  // And setting location.hash twice in one tick (a trick to force a
  // hashchange when the target equals the current hash) races: two renders
  // start and the intermediate one can finish last. So there is no
  // intermediate -- a revisit re-renders explicitly instead.
  const mainText = () => page.$eval(".main", (m) => m.innerText).catch(() => "");
  const settle = async (before) => {
    for (let i = 0; i < 60; i++) {
      const t = await mainText();
      if (t && t.trim().length > 40 && t !== before) return t;
      await page.waitForTimeout(250);
    }
    return mainText();
  };
  // Waiting for "the text changed" is not enough either: `before` gets captured
  // while the PREVIOUS page is still rendering, so the change it detects is
  // that page finishing, and every assertion reads one page behind. Waiting for
  // the target page's OWN marker is immune to that.
  const go = async (hash, expect) => {
    await page.evaluate((h) => { if (window.location.hash !== h) window.location.hash = h; }, hash);
    for (let i = 0; i < 60; i++) {
      const t = await mainText();
      if (t && t.trim().length > 40 && (!expect || expect.test(t))) return t;
      await page.waitForTimeout(250);
    }
    return mainText();
  };
  // Re-render the Events screen in place, for when we are already on it.
  const reRenderEvents = async () => {
    const before = await mainText();
    await page.evaluate(() => window.__renderEvents(document.querySelector(".main")));
    return settle(before);
  };
  // Back to the event LIST, whichever view we are on. reRenderEvents() refreshes
  // whatever is currently open, so in the detail view it redraws the detail and
  // leaves no cards to click.
  const backToList = async () => {
    const before = await mainText();
    const clicked = await page.evaluate(() => {
      const b = document.querySelector("#ev-back");
      if (b) { b.click(); return true; }
      return false;
    });
    if (!clicked) return reRenderEvents();
    return settle(before);
  };
  const openEventCard = async (id) => {
    await backToList();
    const before = await mainText();
    await page.evaluate((eid) => {
      const el = Array.from(document.querySelectorAll("[data-open-event]"))
        .find((c) => Number(c.dataset.openEvent) === eid);
      if (el) el.click();
    }, id);
    return settle(before);
  };

  section("Every existing area still loads");
  // Each one is checked for real content, not just "no throw" -- a blank page
  // does not throw either.
  for (const [hash, label, expect] of [
    ["#/dashboard", "Dashboard", /dashboard|pipeline|client/i],
    ["#/pipeline-v2", "Clients", /pipeline|stage|client|waitlist/i],
    ["#/tasks", "Tasks & Alerts", /task/i],
    ["#/staff", "Staff", /staff|employee|name/i],
    ["#/leads", "Lead Management", /lead/i],
    ["#/policies", "Policies & SOPs", /polic/i],
    ["#/hr", "HR & Recruiting", /hr|recruit|candidate|applicant/i],
    ["#/attendance", "Staff Attendance", /attendance|bonus|hire/i],
    ["#/admin", "Admin Settings", /admin|setting/i],
  ]) {
    const text = await go(hash, expect);
    check(`${label} loads with content`, text.length > 40 && expect.test(text), text.slice(0, 120));
  }
  check("no page errors from any existing area", errors.length === 0, errors.join(" | "));

  section("The permanent nav item is generic");
  // If this ever says "Halloween Palooza", the architecture has leaked into the
  // product and next year's event needs a code change.
  // The entry is asked for by KEY, not by visible text: the sidebar is grouped
  // now and Events sits inside a collapsed group, so innerText does not contain
  // it even though it is there.
  const eventsEntry = await page.locator('.sidebar nav [data-nav="events"]').count();
  check('the sidebar has an "Events" item', eventsEntry === 1, eventsEntry);
  // The label check stays on the RENDERED MARKUP rather than visible text, so a
  // collapsed group cannot hide a leak. This is the assertion that matters --
  // if it ever says "Halloween Palooza", the architecture has leaked into the
  // product and next year's event needs a code change.
  const navHtml = await page.$eval(".sidebar nav", (s) => s.innerHTML).catch(() => "");
  check("and does NOT name one event in the navigation",
    !/halloween/i.test(navHtml), navHtml.slice(0, 400));

  section("Events opens, with the Palooza as one row among others");
  let text = await go("#/events", /New event/);
  check("the Events screen loads", /Events/.test(text) && text.length > 60, text.slice(0, 200));
  check("Halloween Palooza 2026 appears as an event",
    /Halloween Palooza 2026/i.test(text), text.slice(0, 400));
  check("it is presented as a normal event card, not as the whole screen",
    /New event/i.test(text), text.slice(0, 300));

  section("A second event proves the screen is not Halloween-shaped");
  const secondId = await page.evaluate(async () => {
    const r = await fetch("/api/events", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "EVUI Open House 2027", event_date: "2027-03-01", status: "PLANNING" }),
    });
    return (await r.json()).id;
  });
  check("a second event can be created", !!secondId, secondId);
  text = await reRenderEvents();
  check("both events are listed side by side",
    /Halloween Palooza 2026/i.test(text) && /Open House 2027/i.test(text), text.slice(0, 400));

  section("Opening an event shows the tabs");
  await page.evaluate((id) => {
    const cards = Array.from(document.querySelectorAll("[data-open-event]"));
    const el = cards.find((c) => Number(c.dataset.openEvent) === id);
    if (el) el.click();
  }, secondId);
  await page.waitForTimeout(1500);
  text = await page.$eval(".main", (m) => m.innerText);
  const tabLabels = await page.$$eval("[data-tab]", (bs) => bs.map((b) => b.textContent.trim()));
  for (const tab of ["Overview", "Prospects", "Sponsors", "Donations", "Vendors", "Community Partners", "Settings"]) {
    check(`the ${tab} tab is there`, tabLabels.includes(tab), tabLabels);
  }
  check("the open event is the one that was clicked", /Open House 2027/i.test(text), text.slice(0, 200));

  section("A prospect can be added from the screen");
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("[data-tab]")).find((x) => x.dataset.tab === "prospects");
    if (b) b.click();
  });
  await page.waitForTimeout(700);
  await page.click("#ev-add-prospect");
  await page.waitForTimeout(500);
  await page.fill("#p-name", "EVUI Corner Bakery");
  await page.fill("#p-email", "hello@evui-bakery.invalid");
  await page.click("#ev-save");
  await page.waitForTimeout(1600);
  text = await page.$eval(".main", (m) => m.innerText);
  check("the prospect appears in the table", /EVUI Corner Bakery/.test(text), text.slice(0, 400));

  section("Event settings save from the screen and persist");
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("[data-tab]")).find((x) => x.dataset.tab === "settings");
    if (b) b.click();
  });
  await page.waitForTimeout(700);
  await page.fill("#e-venue", "EVUI Community Hall");
  await page.click("#e-save");
  await page.waitForTimeout(1800);
  const saved = await page.evaluate(async (id) =>
    (await (await fetch("/api/events/" + id, { credentials: "include" })).json()).event.venue_name, secondId);
  check("the venue persisted to the server", saved === "EVUI Community Hall", saved);

  section("The dashboard renders, with goals, a funnel and a work queue");
  // Seeded through the API so there is something real to draw; the point is the
  // rendering, which the data-layer suites cannot check.
  await page.evaluate(async (id) => {
    const post = (p, b) => fetch(p, { method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    await fetch("/api/events/" + id, { method: "PATCH", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sponsorship_goal: 5000, vendor_goal: 6, event_date: "2027-03-01" }) });
    const pr = await (await post("/api/events/" + id + "/prospects",
      { business_name: "EVUI Sponsor Bank", status: "COMMITTED" })).json();
    await post("/api/events/" + id + "/prospects", { business_name: "EVUI Ready Co", status: "READY_FOR_OUTREACH" });
    await post("/api/events/" + id + "/prospects", { business_name: "EVUI Chased Co", status: "CONTACTED", next_follow_up: "2020-01-01" });
    await post("/api/events/" + id + "/sponsorships",
      { prospect_id: pr.id, amount_committed: 3000, amount_paid: 1500, payment_status: "PARTIAL", banner_placement: true });
    await post("/api/events/" + id + "/vendors",
      { vendor_name: "EVUI Taco Truck", status: "CONFIRMED", insurance_required: true, electricity_needed: true });
    await post("/api/events/" + id + "/donations",
      { donor_name: "EVUI Party Store", item_or_service: "Bounce house", received: true });
  }, secondId);

  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("[data-tab]")).find((x) => x.dataset.tab === "overview");
    if (b) b.click();
  });
  for (let i = 0; i < 40 && !/Needs attention/.test(await mainText()); i++) await page.waitForTimeout(250);
  text = await mainText();
  check("the goals section renders", /goals/i.test(text), text.slice(0, 200));
  // A goal for something the CRM cannot measure must not render as 0 of N.
  await page.evaluate(async (id) => {
    await fetch("/api/events/" + id, { method: "PATCH", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ registration_goal: 400 }) });
  }, secondId);
  await page.evaluate(() => window.__renderEvents(document.querySelector(".main")));
  for (let i = 0; i < 40 && !/Needs attention/.test(await mainText()); i++) await page.waitForTimeout(250);
  text = await mainText();
  check("a registration goal shows the goal without claiming a count",
    /goal 400/i.test(text) && !/0 of 400/.test(text), (text.match(/Registrations[\s\S]{0,120}/i) || [""])[0]);
  check("and says where that number actually lives",
    /eventbrite/i.test(text), (text.match(/Registrations[\s\S]{0,160}/i) || [""])[0]);
  check("a goal shows progress against its target", /of \$5,000\.00|of 6/.test(text), text.slice(0, 600));
  check("the countdown renders", /day|Today/.test(text), text.slice(0, 300));
  check("the prospect pipeline renders", /Prospect pipeline/.test(text), text.slice(0, 300));
  check("the funnel names its stages", /Ready for outreach/i.test(text), text.slice(0, 900));
  check("the work queue renders", /Needs attention/.test(text), text.slice(0, 300));
  check("and carries real items", /insurance|thank-you|not fully paid/i.test(text), text.slice(0, 1200));
  // Money separated, and said so in words rather than left to the reader.
  check("cash and in-kind are shown separately",
    /in-kind \(estimated\)/i.test(text) && /sponsorship paid/i.test(text), text.slice(0, 1200));
  // The seeded donation has no value recorded. Printing $0.00 against it would
  // say the donated bounce house was worth nothing -- which is a claim, not a
  // blank. The data layer keeps valued and unvalued apart; the tile has to as
  // well, and only a rendered screen can catch it getting that wrong.
  check("an unvalued donation is never rendered as $0.00",
    /not valued yet/i.test(text) && !/in-kind \(estimated\)\s*\$0\.00/i.test(text),
    (text.match(/IN-KIND[\s\S]{0,90}/i) || [""])[0]);
  check("and the screen says plainly why they are not added together",
    /kept apart|estimate/i.test(text), text.slice(0, 1400));

  section("A goal nobody set says so rather than drawing an empty bar");
  const noGoal = await page.evaluate(async () => {
    const r = await fetch("/api/events", { method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "EVUI No Goals" }) });
    return (await r.json()).id;
  });
  await openEventCard(noGoal);
  for (let i = 0; i < 40 && !/Needs attention/.test(await mainText()); i++) await page.waitForTimeout(250);
  text = await mainText();
  check("it says no goals are set", /No goals set yet|No goal set/.test(text), text.slice(0, 500));
  check("and shows no percentage against a goal that does not exist",
    !/0% of goal/.test(text), text.slice(0, 600));
  check("nothing needs chasing on an empty event",
    /Nothing needs chasing/.test(text), text.slice(0, 700));
  await page.evaluate(async (id) => {
    await fetch("/api/events/" + id, { method: "DELETE", credentials: "include" });
  }, noGoal);

  section("Public vendor sign-ups are closed until somebody opens them");
  // A public write endpoint that is live the moment an event exists is the
  // thing this panel has to make impossible to switch on by accident.
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("[data-tab]")).find((x) => x.dataset.tab === "vendors");
    if (b) b.click();
  });
  for (let i = 0; i < 40 && !/Public vendor sign-up/.test(await mainText()); i++) await page.waitForTimeout(250);
  text = await mainText();
  check("the sign-up panel renders", /Public vendor sign-up/.test(text), text.slice(0, 400));
  check("it starts closed", /closed/i.test(text), (text.match(/Public vendor sign-up[\s\S]{0,220}/) || [""])[0]);
  check("and says nobody can apply yet",
    /nobody can apply/i.test(text), (text.match(/Public vendor sign-up[\s\S]{0,260}/) || [""])[0]);
  check("no public link is shown while it is closed", !(await page.$("#v-signup-link")));
  check("but the control to open it is there", !!(await page.$("#v-signup-toggle")));

  section("The Outreach screen refuses before it offers");
  // The thing to prove on screen: a person arriving at the outreach tab is told
  // it cannot send, and the send control is not available to press.
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("[data-tab]")).find((x) => x.dataset.tab === "outreach");
    if (b) b.click();
  });
  for (let i = 0; i < 40 && !/Review queue/.test(await mainText()); i++) await page.waitForTimeout(250);
  text = await mainText();
  check("the outreach tab renders", /Review queue/.test(text), text.slice(0, 300));
  check("it says plainly that nothing can send yet", /nothing can send yet/i.test(text), text.slice(0, 600));
  check("and lists what is missing, including the postal address",
    /postal address/i.test(text), text.slice(0, 800));
  check("the send button is disabled while it cannot send",
    (await page.$eval("#o-send-pass", (b) => b.disabled)) === true);
  check("the queue states that approval gates sending",
    /nothing sends until a person approves it/i.test(text), text.slice(0, 900));
  check("the sending controls say they apply to every event",
    /every.{0,20}event/i.test(text), text.slice(0, 900));

  // Phase 4. The claim that matters on screen is that the scheduler drafts
  // rather than sends -- a person reading this panel must not think it will
  // email businesses on its own overnight.
  check("the follow-up panel renders", /Follow-ups/.test(text), text.slice(0, 1200));
  check("and says plainly that it drafts and cannot send",
    /drafts.{0,60}cannot send|cannot send/i.test(text), (text.match(/Follow-ups[\s\S]{0,320}/) || [""])[0]);
  check("and that a person still approves each one",
    /approve each one/i.test(text), (text.match(/Follow-ups[\s\S]{0,320}/) || [""])[0]);
  check("the due-preview control is offered", !!(await page.$("#o-fu-preview")));

  section("Screenshot for a human to eyeball");
  await openEventCard(secondId);
  for (let i = 0; i < 40 && !/Needs attention/.test(await mainText()); i++) await page.waitForTimeout(250);
  const shot = process.env.EVENTS_SHOT;
  if (shot) { await page.screenshot({ path: shot, fullPage: true }); console.log("  (screenshot: " + shot + ")"); }

  section("The Palooza still has its own separate data");
  // The isolation check, from the screen rather than the API.
  const paloozaId = await page.evaluate(async () => {
    const d = await (await fetch("/api/events", { credentials: "include" })).json();
    return (d.events.find((e) => /Halloween Palooza/i.test(e.name)) || {}).id;
  });
  const pal = await page.evaluate(async (id) =>
    await (await fetch("/api/events/" + id, { credentials: "include" })).json(), paloozaId);
  check("the Palooza has no prospects from the other event",
    (pal.prospects || []).every((p) => !/EVUI/.test(p.business_name)), pal.prospects);
  check("and still has its own five sponsorship levels",
    (pal.sponsorship_levels || []).length === 5, (pal.sponsorship_levels || []).length);
  check("its venue is untouched by the other event's save",
    pal.event.venue_name !== "EVUI Community Hall", pal.event.venue_name);

  section("Nothing threw while doing any of that");
  check("no page errors", errors.length === 0, errors.join(" | "));

  // The temporary second event is removed: the spec asks for it as a proof, not
  // as seed data somebody has to tidy up later.
  await page.evaluate(async (id) => {
    await fetch("/api/events/" + id, { method: "DELETE", credentials: "include" });
  }, secondId);
  const gone = await page.evaluate(async (id) =>
    (await fetch("/api/events/" + id, { credentials: "include" })).status, secondId);
  check("the temporary test event was cleaned up", gone === 404, gone);

  if (failures.length) console.log("\n  --- failures ---\n" + failures.join("\n"));
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
