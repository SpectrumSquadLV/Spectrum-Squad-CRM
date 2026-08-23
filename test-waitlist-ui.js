// The client card has to say out loud that reminders are paused. A silent
// pause is arguably worse than no pause: staff would assume the family is
// being chased and stop checking on them.
const { chromium } = require("playwright");
const { openCardSection, cardHintText } = require("./card-test-helpers");

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + String(detail).slice(0, 300) : "")); }
  };

  await page.goto((process.env.BASE || "http://localhost:3009") + "/", { waitUntil: "networkidle" });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', "TestOwner123!");
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(2500);

  const clientId = await page.evaluate(async () => {
    const list = await (await fetch("/api/clients", { credentials: "include" })).json();
    return Array.isArray(list) && list[0] ? list[0].id : null;
  });
  check("found a client", clientId != null);

  const openCard = async () => {
    await page.evaluate(() => { document.querySelectorAll(".modal-backdrop").forEach((b) => b.remove()); });
    await page.evaluate((id) => openClientModal(id), clientId);
    await page.waitForTimeout(2200);
    return page.locator(".modal-backdrop").last().innerText();
  };

  // --- not waitlisted: a quiet explanatory line, no alarm ---
  await page.evaluate(async (id) => {
    await fetch(`/api/clients/${id}/waitlist`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ waitlisted: false }),
    });
  }, clientId);
  let text = await openCard();
  // Off the waitlist this is background explanation, not state, so it sits on
  // the hover icon rather than taking a line on the card.
  check("off the waitlist: card explains what the waitlist does to reminders",
    /reminders to the family are paused/i.test(await cardHintText(page)));
  check("off the waitlist: no active-pause warning", !/Automated reminders to this family are paused/i.test(text));

  // --- on the waitlist: the pause is stated plainly ---
  await page.evaluate(async (id) => {
    await fetch(`/api/clients/${id}/waitlist`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ waitlisted: true, reason: "UI test" }),
    });
  }, clientId);
  text = await openCard();
  // An active pause is state staff must not miss, so the section opens itself
  // and says it in the card body -- not on a tooltip nobody hovers.
  check("on the waitlist: the waitlist section is open without being asked",
    await page.$eval('details.cs[data-cs="waitlist"]', (d) => d.open).catch(() => false));
  check("on the waitlist: says reminders are paused", /Automated reminders to this family are paused/i.test(text), text.slice(0, 300));
  check("on the waitlist: names the packet deadline", /7-day packet deadline is stopped/i.test(text));
  check("on the waitlist: says it resumes", /resumes?.*when you remove them/i.test(text));

  // --- put it back ---
  await page.evaluate(async (id) => {
    await fetch(`/api/clients/${id}/waitlist`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ waitlisted: false }),
    });
  }, clientId);

  check("no uncaught JavaScript errors", errors.length === 0, errors.join(" ;; "));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
