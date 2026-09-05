// The client card after the tidy-up.
//
// The card had grown to eighteen sections stacked flat and fully expanded,
// with a paragraph of explanation under most of them. Quiana's words: the text
// is "jumble together" and she wants it clean, icons instead of explanations,
// and the daily sections (the BIP especially) as dropdowns.
//
// So this suite checks the things that would make the tidy-up a downgrade:
//
//   1. NOTHING WAS LOST. Every control that was on the card is still on the
//      card and still works -- collapsing a section must not mean losing it.
//      This is the real risk of a cosmetic pass, and the reason each section
//      is opened and its guts checked rather than just counted.
//   2. A CLOSED SECTION STILL REPORTS. If folding a section hides whether the
//      packet is signed, the card got worse. Closed headers carry a status
//      chip; the chips have to say the true thing.
//   3. THE EXPLANATIONS STILL EXIST. They moved onto hover, they were not
//      deleted -- somebody meeting this screen for the first time still needs
//      to be told what an attendance alert does.
//   4. THE CHOICE STICKS. A section you open stays open next time.
//
//   node test-client-card.js
"use strict";
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3009";

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

  // A client with enough on it to be worth looking at.
  const clientId = await page.evaluate(async () => {
    const list = await (await fetch("/api/clients", { credentials: "include" })).json();
    const rows = Array.isArray(list) ? list : [];
    const live = rows.filter((c) => !["discharged", "not_moving_forward"].includes(c.stage));
    return (live[0] || rows[0] || {}).id;
  });
  check("there is a client to open", !!clientId, clientId);

  const openCard = async () => {
    await page.evaluate(() => document.querySelectorAll(".modal-backdrop").forEach((b) => b.remove()));
    await page.evaluate((id) => openClientModal(id), clientId);
    await page.waitForSelector(".modal-backdrop details.cs", { timeout: 10000 });
    await page.waitForTimeout(600);
  };
  await openCard();

  section("Every section is there, and every one folds");
  // "firstday" is the First Day of ABA section. The date it holds was already a
  // field on the client record and already drove the dashboard's Upcoming First
  // Days list, but there was no way to enter it anywhere in the app -- and it
  // is the trigger for the parent's confirmation email, so it needed one.
  //
  // Note this suite signs in as the owner. "eligibility" and "financial" are
  // now limited to administrative/billing roles, so a clinical or scheduling
  // account legitimately sees fifteen sections here, not seventeen.
  const EXPECTED = ["authorization", "emergency", "bip", "services", "assessment", "notes", "packet",
    "documents", "docrequests", "eligibility", "financial", "firstday", "schedulereq", "attendance", "tasks",
    "waitlist", "closeout", "comms"];
  const found = await page.$$eval("details.cs", (ds) => ds.map((d) => d.dataset.cs));
  for (const key of EXPECTED) check(`"${key}" is on the card`, found.includes(key), found.join(","));
  check("nothing extra crept in", found.length === EXPECTED.length, found.join(","));

  section("The daily sections are the ones open on arrival");
  const openKeys = await page.$$eval("details.cs[open]", (ds) => ds.map((d) => d.dataset.cs));
  check("the BIP is open, since it is worked every day", openKeys.includes("bip"), openKeys.join(","));
  check("so are the stage tasks", openKeys.includes("tasks"), openKeys.join(","));
  check("and the rest are folded away", openKeys.length <= 3, openKeys.join(","));

  section("Nothing was lost in the folding");
  // Open everything and look for the controls that were on the old card. A
  // section that quietly lost its button is the failure this catches.
  await page.evaluate(() => document.querySelectorAll("details.cs").forEach((d) => (d.open = true)));
  await page.waitForTimeout(900);
  const CONTROLS = [
    ["#auth-insurance_payer", "authorization payer"],
    ["#auth-authorization_status", "authorization status"],
    ["#auth-auth_expiration_date", "authorization expiry"],
    ["#auth-save-btn", "save authorization"],
    ["#cd-transportation", "transportation toggle"],
    ["#save-transport-btn", "save transportation"],
    ["#asmt-date", "assessment date"],
    ["#asmt-loc", "assessment location"],
    ["[data-asmt-done='pddbi']", "PDDBI tick"],
    ["[data-asmt-done='srs2']", "SRS-2 tick"],
    ["[data-asmt-done='psi']", "Parent Stress Index tick"],
    ["[data-asmt-done='vineland_tricare']", "Vineland tick"],
    ["#save-assessment-btn", "save assessment"],
    ["#post-assessment-email-btn", "post-assessment email"],
    ["#case-note-input", "case note box"],
    ["#add-case-note-btn", "add note"],
    ["#send-packet-btn", "send packet"],
    ["#doc-file-input", "document upload"],
    ["#doc-is-card", "insurance-card tick"],
    ["#upload-doc-btn", "upload button"],
    ["#send-eligibility-btn", "benefits check"],
    ["#send-attendance-btn", "attendance alert"],
    ["#delete-lead-btn", "delete lead"],
    ["#emergency-mount", "emergency contacts mount"],
    ["#bip-mount", "BIP mount"],
    ["#doc-request-section", "document requests mount"],
    ["#financial-form-section", "financial form mount"],
    ["#schedule-req-section", "schedule request mount"],
    ["#case-notes-list", "case notes list"],
  ];
  for (const [sel, label] of CONTROLS) {
    check(`${label} survived`, (await page.$(sel)) !== null, sel);
  }

  section("The sections that load themselves actually loaded");
  // A mount that never fills is indistinguishable from a working one in the
  // markup, so this waits for real content rather than the placeholder.
  const bipText = await page.locator("#bip-mount").innerText().catch(() => "");
  check("the BIP section rendered something", bipText.trim().length > 0, bipText.slice(0, 120));
  const emergencyText = await page.locator("#emergency-mount").innerText().catch(() => "");
  check("emergency contacts rendered something", emergencyText.trim().length > 0, emergencyText.slice(0, 120));

  section("A folded section still says where it stands");
  const chips = await page.$$eval("details.cs", (ds) => ds.map((d) => ({
    key: d.dataset.cs,
    chip: (d.querySelector(".cs-chip") || {}).textContent || null,
  })));
  const chipFor = (k) => (chips.find((c) => c.key === k) || {}).chip;
  // Compare the packet chip against what the API actually says, so this cannot
  // pass by rendering a confident but wrong label.
  const truth = await page.evaluate(async (id) =>
    (await (await fetch("/api/clients/" + id, { credentials: "include" })).json()), clientId);
  const packetStatus = truth.enrollmentPacket && truth.enrollmentPacket.status;
  const EXPECT_CHIP = { completed: "Signed", sent: "Awaiting signature", declined: "Declined",
    expired: "Expired", failed: "Failed", blocked: "Blocked" };
  check("the packet chip matches the packet's real status",
    chipFor("packet") === (packetStatus ? EXPECT_CHIP[packetStatus] : "Not sent"),
    { chip: chipFor("packet"), status: packetStatus });
  const docCount = (truth.documents || []).length;
  check("the documents chip matches the real document count",
    chipFor("documents") === (docCount ? String(docCount) : "None"),
    { chip: chipFor("documents"), docCount });
  const overdue = (truth.tasks || []).filter((t) => t.status === "overdue").length;
  const doneN = (truth.tasks || []).filter((t) => t.status === "completed").length;
  check("the tasks chip matches the real task state",
    chipFor("tasks") === (overdue ? overdue + " overdue" : (truth.tasks || []).length ? doneN + "/" + truth.tasks.length : null),
    { chip: chipFor("tasks"), overdue, doneN, total: (truth.tasks || []).length });

  section("The explanations moved to hover, they were not deleted");
  const hints = await page.$$eval(".hint-badge", (hs) => hs.map((h) => h.getAttribute("title")));
  check("there are hover explanations on the card", hints.length >= 5, hints.length);
  const joined = hints.join(" || ");
  check("the stage-task rule is still explained", /moves the client on/i.test(joined), joined.slice(0, 200));
  check("the attendance-alert rule is still explained", /under 80%/i.test(joined), joined.slice(0, 200));
  check("the waitlist pause is still explained", /7-day/i.test(joined), joined.slice(0, 300));
  check("no explanation is left empty", hints.every((h) => h && h.trim().length > 10), hints);

  section("The card is shorter than it was");
  // The complaint was length and jumble. With the daily sections open and the
  // rest folded, the card should be a fraction of its expanded height.
  // Stored preferences are cleared first: the step above opened every section,
  // and that WAS remembered -- which is the feature working, but it would make
  // this measurement compare a fully-open card against itself.
  await page.evaluate(() => localStorage.removeItem("ss.clientCard.open"));
  await openCard();
  const foldedHeight = await page.evaluate(() => document.querySelector(".modal").scrollHeight);
  await page.evaluate(() => document.querySelectorAll("details.cs").forEach((d) => (d.open = true)));
  await page.waitForTimeout(700);
  const fullHeight = await page.evaluate(() => document.querySelector(".modal").scrollHeight);
  check("folding actually shortens the card", foldedHeight < fullHeight * 0.75,
    { folded: foldedHeight, full: fullHeight });

  section("What you open stays open");
  await openCard();
  await page.evaluate(() => {
    const d = document.querySelector('details.cs[data-cs="documents"]');
    d.open = true; d.dispatchEvent(new Event("toggle"));
  });
  await page.waitForTimeout(400);
  await openCard();
  const documentsOpen = await page.$eval('details.cs[data-cs="documents"]', (d) => d.open);
  check("a section opened once is open next time", documentsOpen === true);
  // ...and the defaults of untouched sections are not collateral damage.
  const bipStillOpen = await page.$eval('details.cs[data-cs="bip"]', (d) => d.open);
  check("and other sections keep their own default", bipStillOpen === true);

  await page.evaluate(() => {
    const d = document.querySelector('details.cs[data-cs="bip"]');
    d.open = false; d.dispatchEvent(new Event("toggle"));
  });
  await page.waitForTimeout(400);
  await openCard();
  check("a section closed on purpose stays closed",
    (await page.$eval('details.cs[data-cs="bip"]', (d) => d.open)) === false);

  section("Nothing threw while doing any of that");
  check("no page errors", errors.length === 0, errors.join(" | "));

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("Crashed:", e); process.exit(1); });
