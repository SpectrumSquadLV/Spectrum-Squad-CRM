// Pausing a family's intake reminders, from the screen.
//
// The API for this is covered by test-intake-hold.js. What that suite cannot
// tell you is whether anybody can actually reach it, and the two failure modes
// here are both about visibility rather than logic:
//
//   1. The button does nothing. A missing binding or a thrown error looks
//      identical to a working button until somebody checks the family is still
//      being emailed a week later.
//   2. The hold is invisible. Every section of this card folds, and a hold
//      hiding inside a folded section is permanent silence on a family with
//      nothing on screen to say so. So the notice must be visible on a freshly
//      opened card with nothing unfolded, and the board must carry it too.
//
//   BASE=http://127.0.0.1:3011 node test-intake-hold-ui.js
"use strict";
const { chromium } = require("playwright");
const { openCardSection } = require("./card-test-helpers");
const BASE = process.env.BASE || "http://localhost:3011";

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("dialog", async (d) => { await d.accept(); });

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : "")); }
  };
  const section = (t) => console.log("\n== " + t + " ==");

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', "TestOwner123!");
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(2500);

  // Its own client, so this suite never holds a family another suite is using.
  // No cleanup afterwards: run-tests.js hands every suite its own database.
  const clientId = await page.evaluate(async () => {
    const r = await fetch("/api/clients", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        child_name: "HOLDUI Child", parent_name: "HOLDUI Parent",
        parent_email: "holdui@example.invalid",
      }),
    });
    const d = await r.json();
    return d.id || (d.client && d.client.id);
  });
  check("a client to work with", !!clientId, clientId);

  const openCard = async () => {
    await page.evaluate((id) => { window.location.hash = "#/pipeline/" + id; }, clientId);
    await page.waitForSelector(".modal-backdrop .modal", { timeout: 10000 });
    await page.waitForTimeout(800);
  };
  const cardText = () => page.$eval(".modal-backdrop .modal", (m) => m.innerText);
  const closeCard = async () => {
    await page.evaluate(() => {
      const b = document.querySelector(".modal-backdrop .close-btn");
      if (b) b.click();
    });
    await page.waitForTimeout(400);
  };

  section("The control is where somebody would look for it");
  await openCard();
  // Beside the packet: the moment you need this is the moment you are staring
  // at a packet that has not come back.
  await openCardSection(page, "packet");
  check("a Pause reminders button sits with the enrollment packet",
    !!(await page.$(".modal-backdrop #chasing-hold-btn")));
  check("and the card does not claim a hold that is not there",
    !/on hold/i.test(await cardText()));

  section("Pausing works from the screen");
  await page.click(".modal-backdrop #chasing-hold-btn");
  await page.waitForTimeout(400);
  // askReason() puts up its own modal before the native confirm.
  await page.fill("#reason-input", "SignNow never delivered the packet");
  await page.click("#reason-confirm");
  await page.waitForTimeout(1800);

  // The card stays open on the family you just acted on, showing the notice you
  // just created. Dropping back to the board here would leave somebody unsure
  // whether the click landed -- which is how a hold gets applied twice.
  check("the card stays open on that family",
    (await page.$$(".modal-backdrop .modal")).length === 1,
    (await page.$$(".modal-backdrop .modal")).length);
  check("and shows the hold straight away", /on hold/i.test(await cardText()));

  const held = await page.evaluate(async (id) =>
    (await (await fetch("/api/clients/" + id, { credentials: "include" })).json()).intakeChasing, clientId);
  check("the family really is on hold now", held && held.on_hold === true, held);
  check("with the reason that was typed into the box",
    /never delivered/i.test((held && held.reason) || ""), held && held.reason);

  section("A hold is visible without unfolding anything");
  // The point of the whole check: reopen the card fresh, touch nothing, and the
  // hold has to be on screen. Sections remember whether they were left open, so
  // a notice that lives inside one is a notice that can be folded away forever.
  await closeCard();
  await openCard();
  const fresh = await cardText();
  check("the notice is on the card as it opens", /on hold/i.test(fresh), fresh.slice(0, 400));
  check("it says what is actually stopped -- the emails and the deadline",
    /deadline/i.test(fresh) && /(emailed|reminders)/i.test(fresh), fresh.slice(0, 500));
  check("and it says who held them, so the hold has an owner",
    /admin@spectrumsquadlv\.com/.test(fresh), fresh.slice(0, 500));
  check("the header badges it too", !!(await page.$(".modal-backdrop .modal-header .badge")) && /on hold/i.test(fresh));
  check("and a Resume button is offered right there",
    !!(await page.$(".modal-backdrop #chasing-resume-btn")));
  check("the Pause button is gone, so it cannot be pressed twice",
    !(await page.$(".modal-backdrop #chasing-hold-btn")));

  section("And it is visible from the board, not only from the card");
  // Otherwise finding who is on hold means opening every client in turn, which
  // means nobody does it.
  await closeCard();
  await page.evaluate(() => { window.location.hash = "#/pipeline"; });
  await page.waitForTimeout(1800);
  const boardText = await page.$eval(".main", (m) => m.innerText);
  check("the family's card on the board is marked", /on hold/i.test(boardText),
    boardText.slice(0, 300));

  section("Resuming works too");
  await openCard();
  await page.click(".modal-backdrop #chasing-resume-btn");
  await page.waitForTimeout(1800);
  const after = await page.evaluate(async (id) =>
    (await (await fetch("/api/clients/" + id, { credentials: "include" })).json()).intakeChasing, clientId);
  check("the hold is lifted", after && after.on_hold === false, after);
  check("and the card stops saying it is held", !/on hold/i.test(await cardText()));
  await openCardSection(page, "packet");
  check("the Pause button is back", !!(await page.$(".modal-backdrop #chasing-hold-btn")));

  section("Nothing threw while doing any of that");
  check("no page errors", errors.length === 0, errors.join(" | "));

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
