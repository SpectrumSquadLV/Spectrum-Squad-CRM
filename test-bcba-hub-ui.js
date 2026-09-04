// The BCBA Hub in a real browser.
//
// test-bcba-hub.js proves the data and the API. This proves the thing a BCBA
// actually experiences, and in particular the two claims that would be
// invisible to a source check:
//
//   * SELECTING A PAYER SHOWS THAT PAYER AND ONLY THAT PAYER. The failure this
//     guards against is not a crash, it is a page that looks completely
//     plausible while showing CareSource's requirements under Molina's name.
//   * The readiness figure is driven by the boxes that are actually on screen,
//     so it means "this plan is ready" rather than being decoration.
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    // JSON, not String(): a failure whose detail is an object printed as
    // "[object Object]" tells you nothing, which is the one moment it matters.
    else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : "")); }
  };
  const BASE = process.env.BASE || "http://localhost:3009";

  const login = async (email, password) => {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.evaluate(async () => {
      try { await fetch("/api/auth/logout", { method: "POST", credentials: "include" }); } catch (e) {}
    });
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.waitForSelector('#login-form input[name="email"]', { timeout: 15000 });
    await page.fill('#login-form input[name="email"]', email);
    await page.fill('#login-form input[name="password"]', password);
    await page.click('#login-form button[type="submit"]');
    await page.waitForTimeout(1600);
  };
  const openHub = async () => {
    await page.goto(BASE + "/#/bcba-hub");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".bh-payers", { timeout: 15000 });
    await page.waitForTimeout(300);
  };
  const pickPayer = async (name) => {
    await page.evaluate((n) => {
      const b = Array.from(document.querySelectorAll("[data-payer]")).find((x) => x.textContent.includes(n));
      if (b) b.click();
    }, name);
    await page.waitForTimeout(300);
  };
  const panelText = () => page.evaluate(() => {
    const el = document.querySelector(".bh");
    return el ? el.innerText : "";
  });

  await login("admin@spectrumsquadlv.com", "TestOwner123!");

  console.log("\n== The section exists and opens ==");
  check("a BCBA Hub nav entry is rendered",
    await page.locator('[data-nav="bcba-hub"]').count() > 0);
  check("and it routes to #/bcba-hub",
    (await page.locator('[data-nav="bcba-hub"]').first().getAttribute("data-nav-hash")) === "#/bcba-hub");

  await openHub();
  const shell = await panelText();
  check("the hub renders its heading", /BCBA Hub/.test(shell));
  check("the two working areas are tabs", /Treatment Plan Cheat Sheet/.test(shell) && /Form Library/.test(shell));
  check("the two future areas are shown as placeholders",
    /Clinical Resources/.test(shell) && /Student Analyst/.test(shell) && /Coming soon/i.test(shell));
  const disabled = await page.locator(".bh-tab[disabled]").count();
  check("and the placeholders are not clickable", disabled === 2, disabled);

  console.log("\n== One payer at a time ==");
  const payerCount = await page.locator("[data-payer]").count();
  check("every payer in the cheat sheet has a card", payerCount === 7, payerCount);

  await pickPayer("Aetna");
  const aetna = await panelText();
  check("choosing Aetna shows Aetna's sections",
    /Member Information/.test(aetna) && /Standardized Assessments/.test(aetna), aetna.slice(0, 300));
  check("and its quick reference reads off the cheat sheet",
    /25 Units/.test(aetna), aetna.slice(0, 600));
  // CareSource's "Biopsychosocial History" and TRICARE's "Reason for Referral"
  // exist in no other payer's plan. Seeing either here would be the exact
  // failure this feature must not have.
  check("NO OTHER PAYER'S SECTIONS APPEAR ON IT",
    !/Biopsychosocial History/.test(aetna) && !/Reason for Referral/.test(aetna), aetna.slice(0, 400));

  await pickPayer("CareSource");
  const care = await panelText();
  check("switching to CareSource swaps the requirements over",
    /Biopsychosocial History/.test(care) && !/Reason for Referral/.test(care));
  check("and its own units are shown, not the previous payer's",
    /16 Units/.test(care) && !/25 Units/.test(care));

  // The one the whole "do not invent requirements" rule turns on.
  await pickPayer("Molina");
  const molina = await panelText();
  check("MOLINA SAYS THE CHEAT SHEET LISTS NO COMPONENTS",
    /does not list treatment plan components/i.test(molina), molina.slice(0, 600));
  check("and shows nobody else's list instead",
    !/Member Information/.test(molina) && !/Biopsychosocial History/.test(molina));
  check("while still showing what the cheat sheet DOES give Molina",
    /16 Units/.test(molina));

  console.log("\n== Initial vs reauthorization ==");
  await pickPayer("CareSource");
  const initial = await panelText();
  check("the initial view leaves the reauthorization section out",
    !/Reauthorization Requirements/.test(initial), initial.slice(0, 300));
  await page.click('[data-mode="reauth"]');
  await page.waitForTimeout(300);
  const reauth = await panelText();
  check("switching to reauthorization brings it in",
    /Reauthorization Requirements/.test(reauth));
  check("and keeps the plan requirements, because a reauth is still a plan",
    /Biopsychosocial History/.test(reauth));
  check("the page explains that, rather than leaving it to be guessed",
    /everything an initial plan needs/i.test(reauth));
  await page.click('[data-mode="initial"]');
  await page.waitForTimeout(300);

  console.log("\n== The readiness checklist ==");
  const before = await page.evaluate(() => {
    const el = document.querySelector(".bh-pct");
    return { pct: el ? el.textContent : null, boxes: document.querySelectorAll("[data-check]").length };
  });
  check("a readiness figure is shown", before.pct !== null, before);
  check("it starts at zero for an untouched payer", before.pct === "0%", before.pct);
  check("there is a checkbox per requirement", before.boxes > 20, before.boxes);

  await page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll("[data-check]"));
    boxes.slice(0, Math.ceil(boxes.length / 2)).forEach((b) => { b.checked = true; b.dispatchEvent(new Event("change", { bubbles: true })); });
  });
  await page.waitForTimeout(350);
  const mid = await page.evaluate(() => ({
    pct: document.querySelector(".bh-pct").textContent,
    pill: (document.querySelector(".bh-pill") || {}).textContent || "",
  }));
  check("TICKING REQUIREMENTS MOVES THE READINESS FIGURE",
    mid.pct !== "0%" && parseInt(mid.pct, 10) >= 45 && parseInt(mid.pct, 10) <= 60, mid);
  check("and the status pill reads as needing attention rather than complete",
    /Needs attention/i.test(mid.pill), mid.pill);

  // The ticks are this reviewer's own working state, not a client record.
  const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.indexOf("ss-bcba-check") === 0));
  check("the ticks are kept in this browser, not sent to the server", stored.length > 0, stored);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".bh-payers", { timeout: 15000 });
  await page.waitForTimeout(350);
  const afterReload = await page.evaluate(() => ({
    pct: (document.querySelector(".bh-pct") || {}).textContent,
    // The ticks persisting is only useful if the reload comes back to the
    // payer they belong to. Landing on a different payer shows 0% and reads
    // as the review having been lost.
    payer: (document.querySelector("[data-payer].on") || {}).textContent || "",
  }));
  check("and survive a reload, so a review can be picked back up",
    afterReload.pct === mid.pct, afterReload.pct + " vs " + mid.pct);
  check("because the reload comes back to the payer being reviewed",
    /CareSource/.test(afterReload.payer), afterReload.payer);

  await page.click("#bh-reset");
  await page.waitForTimeout(300);
  check("Reset checklist clears them",
    (await page.evaluate(() => document.querySelector(".bh-pct").textContent)) === "0%");

  console.log("\n== Comparing two payers ==");
  await page.click("#bh-compare");
  await page.waitForTimeout(350);
  const cmp = await page.evaluate(() => {
    const t = document.querySelector(".bh-cmp");
    return t ? { text: t.innerText, cols: t.querySelectorAll("thead th").length, rows: t.querySelectorAll("tbody tr").length } : null;
  });
  check("a side-by-side comparison opens", !!cmp, cmp);
  check("with a column per payer", cmp && cmp.cols === 3, cmp && cmp.cols);
  check("and the five things worth comparing", cmp && cmp.rows === 5, cmp && cmp.rows);
  check("including assessment units and reauthorization",
    cmp && /Assessment units/i.test(cmp.text) && /Reauthorization/i.test(cmp.text));
  await page.click("#bh-cmp-close");
  await page.waitForTimeout(300);
  check("and it closes again", await page.locator(".bh-cmp").count() === 0);

  console.log("\n== The Form Library ==");
  await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll("[data-tab]")).find((b) => b.dataset.tab === "forms");
    if (t) t.click();
  });
  await page.waitForTimeout(350);
  const lib = await panelText();
  check("the Form Library has a search box", await page.locator("#bh-form-q").count() === 1);
  check("and category filters", /All/.test(lib) && /Assessments/.test(lib) && /Insurance\/Payer/.test(lib));
  check("an owner is offered Add Form", await page.locator("#bh-add-form").count() === 1);

  // Upload through the real dialog, since that is the path an admin uses.
  await page.click("#bh-add-form");
  await page.waitForSelector(".bh-modal", { timeout: 8000 });
  await page.fill("#bh-fd-name", "FA-11E Authorization Request");
  await page.fill("#bh-fd-desc", "Nevada ABA authorization request form.");
  await page.selectOption("#bh-fd-cat", "payer");
  await page.fill("#bh-fd-code", "FA-11E");
  await page.setInputFiles("#bh-fd-file", {
    name: "fa11e.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nform bytes\n"),
  });
  await page.click("#bh-fd-save");
  await page.waitForTimeout(1400);
  const afterAdd = await panelText();
  check("ADDING A FORM PUTS IT IN THE LIBRARY", /FA-11E Authorization Request/.test(afterAdd), afterAdd.slice(0, 400));
  check("with the actions that apply to it",
    /Download/.test(afterAdd) && /Print/.test(afterAdd));

  await page.fill("#bh-form-q", "nothing matches this");
  await page.waitForTimeout(300);
  check("search narrows the library",
    /No forms match/.test(await panelText()));
  await page.fill("#bh-form-q", "FA-11E");
  await page.waitForTimeout(300);
  check("and finds a form by its code", /FA-11E Authorization Request/.test(await panelText()));

  // The link back: the cheat sheet must now offer that form where NV Medicaid
  // requires it, from the library rather than a copy.
  await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll("[data-tab]")).find((b) => b.dataset.tab === "cheatsheet");
    if (t) t.click();
  });
  await page.waitForTimeout(300);
  await pickPayer("NV Medicaid");
  const linkHref = await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll(".bh-qr a")).find((x) => /Download/.test(x.textContent));
    return a ? a.getAttribute("href") : null;
  });
  // Note what is NOT done between uploading the form and this check: no page
  // reload. Adding a form has to make it reachable from the requirement that
  // names it straight away, or an admin uploads a form, looks at the payer
  // page, sees no download and uploads it a second time.
  check("A REQUIRED FORM IS DOWNLOADABLE FROM THE PAYER'S REQUIREMENTS",
    !!linkHref && /^\/api\/bcba\/forms\/\d+\/file$/.test(linkHref), linkHref);

  // Presentation, checked here rather than after the role tour: it needs an
  // admin session and this one is already open. A browser suite that runs to
  // the runner's limit starts failing for reasons that are not the code's.
  console.log("\n== Presentation ==");
  const html = await page.innerHTML(".bh");
  const emoji = html.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || [];
  check("no emoji anywhere in the hub", emoji.length === 0, emoji);
  const overflow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
  check("nothing overflows the page horizontally", overflow.doc <= overflow.win + 1, overflow);
  await page.setViewportSize({ width: 480, height: 900 });
  await page.waitForTimeout(300);
  const narrow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
  check("nor on a phone", narrow.doc <= narrow.win + 1, narrow);
  await page.setViewportSize({ width: 1400, height: 1000 });

  console.log("\n== What other roles see ==");
  await login("clinical@spectrumsquadlv.com", "TestStaff123!");
  check("a BCBA gets the hub", await page.locator('[data-nav="bcba-hub"]').count() > 0);
  await openHub();
  check("and can use the cheat sheet", /Treatment Plan Cheat Sheet/.test(await panelText()));
  check("but is not offered Add Form", await page.locator("#bh-add-form").count() === 0);
  await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll("[data-tab]")).find((b) => b.dataset.tab === "forms");
    if (t) t.click();
  });
  await page.waitForTimeout(350);
  check("nor any form management control",
    await page.locator("[data-archive-form], [data-delete-form], [data-edit-form]").count() === 0);
  check("but can download a form, which is the point",
    /Download/.test(await panelText()));

  await login("intake@spectrumsquadlv.com", "TestStaff123!");
  check("intake does not see the hub at all", await page.locator('[data-nav="bcba-hub"]').count() === 0);

  check("no page errors", errors.length === 0, errors.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
