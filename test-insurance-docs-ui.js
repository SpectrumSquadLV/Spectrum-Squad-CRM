// test-insurance-docs-ui.js -- the client card's side of it: the eligibility
// button cannot be pressed with no card on file and says why, uploads can be
// marked as the card, and the parent document request can be sent, tracked and
// completed from the parent's own page.
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3009";
const OWNER_PW = process.env.OWNER_PASSWORD || "TestOwner123!";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail ? "\n          -> " + String(detail).slice(0, 400) : "")); }
  };
  const section = (t) => console.log("\n== " + t + " ==");

  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('#login-form input[name="email"]', { timeout: 20000 });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', OWNER_PW);
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(2800);
  check("owner signs in", await page.locator(".sidebar").isVisible().catch(() => false));

  const api = (p, o) => page.evaluate(async ({ p, o }) => {
    const r = await fetch(p, {
      method: (o && o.method) || "GET", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: o && o.body ? JSON.stringify(o.body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { p, o });

  const stamp = Date.now().toString().slice(-6);
  await api("/api/admin/settings", { method: "PATCH", body: { eligibility_check_email: `billing.ui.${stamp}@example.invalid` } });
  const made = await api("/api/clients", {
    method: "POST",
    body: { child_name: "UI Docs " + stamp, parent_name: "UI Parent", parent_email: `uidocs.${stamp}@example.invalid`, dob: "2018-06-01" },
  });
  const clientId = made.body && made.body.id;
  check("created a client", !!clientId, made);

  const openCard = async () => {
    await page.evaluate(() => { document.querySelectorAll(".modal-backdrop").forEach((b) => b.remove()); location.hash = "#/dashboard"; });
    await page.waitForTimeout(700);
    await page.evaluate((id) => { location.hash = "#/pipeline/" + id; }, clientId);
    await page.waitForTimeout(2600);
    return page.locator(".modal-backdrop").last();
  };

  // ---------------- eligibility button ----------------
  section("The eligibility button with no card on file");

  let card = await openCard();
  const eligBtn = card.locator("#send-eligibility-btn");
  check("the eligibility button is on the card", (await eligBtn.count()) === 1);
  check("it is disabled with no card on file", await eligBtn.isDisabled(), "enabled");
  let text = await card.innerText();
  check("the card explains why it can't be sent", /No insurance card is on file/i.test(text), text.slice(0, 200));
  check("and points at the document request", /Request documents from parent/i.test(text));

  // ---------------- document request ----------------
  section("Requesting documents from the parent");

  const reqSection = card.locator("#doc-request-section");
  check("the client card has a document-request section", (await reqSection.count()) === 1);
  await page.waitForTimeout(1200);
  let reqText = await reqSection.innerText();
  check("it lists the official autism diagnosis", /Official autism diagnosis/i.test(reqText), reqText.slice(0, 300));
  check("it lists both sides of the insurance card",
    /Insurance card — front/i.test(reqText) && /Insurance card — back/i.test(reqText), reqText.slice(0, 300));
  check("all three start as not received", (reqText.match(/Not received yet/g) || []).length === 3, reqText.slice(0, 400));

  await reqSection.locator("#doc-req-send").click();
  await page.waitForTimeout(3000);
  card = page.locator(".modal-backdrop").last();
  reqText = await card.locator("#doc-request-section").innerText();
  check("sending reports who it went to", /Sent to uidocs\./i.test(reqText) || /outstanding/i.test(reqText), reqText.slice(0, 300));

  const status = await api(`/api/client-forms/documents/${clientId}`);
  check("the request is recorded against the client", status.body.requested === true, status.body);
  const parentLink = status.body.link;
  check("there is a parent link to hand out", !!parentLink && parentLink.includes("/client-documents/"), parentLink);

  // ---------------- the parent's page ----------------
  section("The parent's upload page");

  const parent = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const parentErrors = [];
  parent.on("pageerror", (e) => parentErrors.push("pageerror: " + e.message));
  await parent.goto(parentLink, { waitUntil: "domcontentloaded" });
  await parent.waitForTimeout(2000);
  let ptext = await parent.locator("body").innerText();
  check("the parent page loads with no login", /Documents for UI Docs/i.test(ptext), ptext.slice(0, 250));
  check("it greets the parent by name", /UI Parent/.test(ptext), ptext.slice(0, 250));
  check("it shows three upload slots", (await parent.locator("[data-pick]").count()) === 3);
  check("each slot has a tap target", /Choose or take a photo/i.test(ptext));

  // Upload through the page's own input elements, exactly as a parent would.
  const upload = async (slot, name, type, b64) => {
    await parent.setInputFiles(`#f-${slot}`, { name, mimeType: type, buffer: Buffer.from(b64, "base64") });
    await parent.waitForTimeout(2600);
  };
  await upload("diagnosis", "dx-report.pdf", "application/pdf", Buffer.from("diagnosis").toString("base64"));
  ptext = await parent.locator("body").innerText();
  check("the diagnosis slot turns received", /Received — thank you/i.test(ptext), ptext.slice(0, 300));
  check("the other two are still asked for", (await parent.locator("[data-pick]").count()) === 2);

  let elig = await api(`/api/clients/${clientId}`);
  check("the diagnosis is on the client record",
    (elig.body.documents || []).some((d) => d.label === "Official Autism Diagnosis"),
    (elig.body.documents || []).map((d) => d.label));
  check("no benefits check yet — no card", (elig.body.notifications || []).filter((n) => n.type === "eligibility_check").length === 0);

  await upload("card_front", "front.png", "image/png", PNG_1PX);
  await upload("card_back", "back.png", "image/png", PNG_1PX);
  ptext = await parent.locator("body").innerText();
  check("the parent sees the all-done screen", /All done — thank you/i.test(ptext), ptext.slice(0, 250));

  elig = await api(`/api/clients/${clientId}`);
  const eligMails = (elig.body.notifications || []).filter((n) => n.type === "eligibility_check");
  check("the benefits check went to billing once the card arrived", eligMails.length === 1, eligMails.map((n) => n.subject));
  check("it was sent with the card attached", eligMails[0] && /attached to this email/i.test(eligMails[0].body || ""));
  check("all three documents are filed on the record",
    ["Official Autism Diagnosis", "Insurance Card (front)", "Insurance Card (back)"]
      .every((l) => (elig.body.documents || []).some((d) => d.label === l)),
    (elig.body.documents || []).map((d) => d.label));

  // ---------------- back on the client card ----------------
  section("What staff see afterwards");

  card = await openCard();
  await page.waitForTimeout(1500);
  reqText = await card.locator("#doc-request-section").innerText();
  check("staff see the request as complete", /All documents received/i.test(reqText), reqText.slice(0, 400));
  check("staff see when each arrived", (reqText.match(/Received /g) || []).length >= 3, reqText.slice(0, 500));

  check("the eligibility button is now enabled", !(await card.locator("#send-eligibility-btn").isDisabled()));
  text = await card.innerText();
  check("the card confirms the check was sent", /✓ Sent/.test(text), text.slice(0, 400));
  check("the no-card warning is gone", !/No insurance card is on file/i.test(text));

  // The upload row's insurance-card checkbox.
  check("the upload row offers an 'is the insurance card' box", (await card.locator("#doc-is-card").count()) === 1);

  section("no broken pages");
  check("no uncaught JavaScript errors in the CRM", errors.length === 0, errors.join(" | "));
  check("no uncaught JavaScript errors on the parent page", parentErrors.length === 0, parentErrors.join(" | "));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\nFATAL:", e); process.exit(2); });
