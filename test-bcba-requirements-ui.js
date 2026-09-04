// Changing a payer's requirements, in a browser.
//
// The API suite proves the rules. This proves the two things that only exist
// once there is a page:
//
//   * THE EDIT CONTROLS ACTUALLY FIRE. The checklist items are <label>s wrapping
//     a checkbox, so a button placed inside one ticks the box instead of doing
//     what it says unless the click is stopped. That is invisible in any test
//     that does not click it.
//   * A CHANGED REQUIREMENT LOOKS CHANGED. A correction that renders
//     identically to the payer's own published wording is how somebody submits
//     against it without knowing it was edited here.
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
    await page.waitForTimeout(1600);
  };
  const openPayer = async (key) => {
    await page.goto(BASE + "/#/bcba-hub", { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    await page.click('[data-payer="' + key + '"]');
    await page.waitForTimeout(900);
  };

  await login("admin@spectrumsquadlv.com", "TestOwner123!");

  console.log("\n== The pre-authorization marker ==");
  await page.goto(BASE + "/#/bcba-hub", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  check("every payer card carries a marker",
    await page.locator(".bh-payer .bh-preauth").count() === await page.locator("[data-payer]").count(),
    { marks: await page.locator(".bh-payer .bh-preauth").count(), payers: await page.locator("[data-payer]").count() });

  await openPayer("aetna");
  let panel = await page.innerText(".bh");
  check("a payer that needs one says so", /Pre-auth required/i.test(panel), panel.slice(0, 300));
  check("AND SAYS THE PRACTICE SET IT, not that the cheat sheet did",
    /set at setup/i.test(panel), panel.slice(0, 400));

  await openPayer("molina");
  panel = await page.innerText(".bh");
  check("a payer the document answers says so instead",
    /No pre-auth for assessment/i.test(panel), panel.slice(0, 300));
  check("and attributes it to the cheat sheet",
    /from the cheat sheet/i.test(panel), panel.slice(0, 400));
  check("with the sentence it came from underneath",
    /97151/.test(panel), panel.slice(0, 500));

  console.log("\n== Changing the marker ==");
  await page.click('[data-preauth="molina"]');
  await page.waitForTimeout(400);
  check("a dialog opens", await page.locator(".bh-modal").count() === 1);
  check("it warns that saving marks this as the practice's own",
    /set by the practice|rather than quoted/i.test(await page.innerText(".bh-modal")),
    await page.innerText(".bh-modal"));
  await page.check('.bh-modal input[name="bh-pa"][value="required"]');
  await page.fill("#bh-pa-note", "Confirmed by Molina on the phone.");
  await page.click("#bh-pa-save");
  await page.waitForTimeout(1400);
  panel = await page.innerText(".bh");
  check("THE MARKER CHANGES ON THE PAGE", /Pre-auth required/i.test(panel), panel.slice(0, 300));
  check("the note is shown", /Confirmed by Molina/.test(panel), panel.slice(0, 400));
  check("and it now reads as set by the practice",
    /set by the practice/i.test(panel), panel.slice(0, 400));

  console.log("\n== Correcting a requirement ==");
  await openPayer("aetna");
  const firstDoc = page.locator(".bh-qr.c li").first();
  const originalText = (await firstDoc.innerText()).split("\n")[0].trim();
  check("an owner is offered Edit on a requirement",
    await page.locator('.bh-qr.c li [data-req-edit]').count() > 0);
  await page.locator('.bh-qr.c li [data-req-edit]').first().click();
  await page.waitForTimeout(400);
  check("the editor opens with the current wording in it",
    (await page.inputValue("#bh-rq-text")).includes(originalText.replace(/\s+Edit.*$/, "").trim().slice(0, 20)),
    { box: await page.inputValue("#bh-rq-text"), originalText });
  await page.fill("#bh-rq-text", "Aetna now also wants a signed consent");
  await page.click("#bh-rq-save");
  await page.waitForTimeout(1500);

  const docs = await page.innerText(".bh-qr.c");
  check("THE NEW WORDING IS WHAT THE PAGE SHOWS", /signed consent/.test(docs), docs.slice(0, 300));
  check("AND IT IS MARKED AS CHANGED, not passed off as the payer's own text",
    /Changed by/i.test(docs), docs.slice(0, 400));
  check("with the cheat sheet's wording still readable underneath",
    /The cheat sheet says/i.test(docs), docs.slice(0, 400));
  check("the changed line is marked visually too",
    await page.locator(".bh-qr.c li.bh-edited").count() === 1);

  console.log("\n== Putting it back ==");
  check("Revert is offered on a changed line",
    await page.locator('.bh-qr.c li [data-req-undo]').count() === 1);
  await page.locator('.bh-qr.c li [data-req-undo]').first().click();
  await page.waitForTimeout(1500);
  const reverted = await page.innerText(".bh-qr.c");
  check("the correction is gone", !/signed consent/.test(reverted), reverted.slice(0, 300));
  check("and nothing is left marked as changed",
    await page.locator(".bh-qr.c li.bh-edited").count() === 0);

  console.log("\n== Adding to a treatment plan section ==");
  // The checklist items are <label>s around a checkbox. A button inside one
  // that does not stop the click ticks the box instead.
  const addBtn = page.locator('.bh-sect [data-req-add]').first();
  check("sections offer a way to add a requirement", await addBtn.count() === 1);
  const checkedBefore = await page.locator(".bh-sect input[type=checkbox]:checked").count();
  await addBtn.click();
  await page.waitForTimeout(400);
  check("A CLICK ON THE ADD BUTTON OPENS THE EDITOR rather than ticking a box",
    await page.locator(".bh-modal").count() === 1);
  await page.fill("#bh-rq-text", "Baseline data for every replacement behavior");
  await page.click("#bh-rq-save");
  await page.waitForTimeout(1500);
  const sect = await page.innerText(".bh-sect");
  check("the added requirement is in the section", /Baseline data for every replacement/.test(sect), sect.slice(0, 300));
  check("marked as added rather than as the cheat sheet's own",
    /Not in the cheat sheet/i.test(sect), sect.slice(0, 400));
  check("and no checkbox was ticked by any of that",
    await page.locator(".bh-sect input[type=checkbox]:checked").count() === checkedBefore,
    { before: checkedBefore, after: await page.locator(".bh-sect input[type=checkbox]:checked").count() });

  console.log("\n== Editing a checklist item does not tick it ==");
  const itemEdit = page.locator('.bh-item [data-req-edit]').first();
  if (await itemEdit.count()) {
    const before2 = await page.locator(".bh-sect input[type=checkbox]:checked").count();
    await itemEdit.click();
    await page.waitForTimeout(400);
    check("the editor opens from inside the label", await page.locator(".bh-modal").count() === 1);
    check("and the checkbox beside it was not toggled",
      await page.locator(".bh-sect input[type=checkbox]:checked").count() === before2);
    await page.click("#bh-rq-cancel");
    await page.waitForTimeout(300);
  }

  console.log("\n== What a BCBA sees ==");
  await login("clinical@spectrumsquadlv.com", "TestStaff123!");
  await openPayer("aetna");
  const asBcba = await page.innerText(".bh");
  check("a BCBA sees the pre-auth marker", /Pre-auth required/i.test(asBcba), asBcba.slice(0, 300));
  check("and the practice's added requirement",
    /Baseline data for every replacement/.test(asBcba), asBcba.slice(0, 400));
  check("THEY ARE OFFERED NO EDIT CONTROLS", await page.locator("[data-req-edit]").count() === 0);
  check("nor Remove, nor Add", await page.locator("[data-req-remove], [data-req-add]").count() === 0);
  check("nor a way to change the pre-auth marker", await page.locator("[data-preauth]").count() === 0);
  const refused = await page.evaluate(async () => (await fetch("/api/bcba/requirements", {
    method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
    body: JSON.stringify({ payer_key: "aetna", list_key: "required_documents", op: "add", text: "nope" }),
  })).status);
  check("AND THE API REFUSES THEM, not just the menu", refused === 403, refused);

  console.log("\n== Presentation ==");
  const html = await page.innerHTML(".bh");
  const emoji = html.match(/[\u{1F300}-\u{1FAFF}]/gu) || [];
  check("no emoji", emoji.length === 0, emoji);
  await page.setViewportSize({ width: 480, height: 900 });
  await page.waitForTimeout(600);
  const of = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
  check("the markers do not push the page sideways on a phone", of.doc <= of.win + 1, of);

  check("no page errors", errors.length === 0, errors.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
