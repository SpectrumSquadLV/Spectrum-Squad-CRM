// Entering a date of birth month-first, whatever the browser thinks.
//
// <input type="date"> renders in the BROWSER's locale, not the page's. On a
// day-first browser it asks for DD/MM/YYYY and nothing in the page can change
// that. For most fields that is a nuisance; for a DATE OF BIRTH it is a silent
// clinical error -- 03/04 and 04/03 are both real dates, so a transposed
// birthday saves cleanly, looks plausible on every screen afterwards, and is
// caught only by somebody who knows the child's actual birthday. It also
// travels: DOB goes to Rethink and onto authorizations.
//
// The field is therefore typed as text in an order this application decides,
// with the parsed date echoed back IN WORDS underneath -- a transposition is
// invisible in "03/04/2019" and obvious in "March 4, 2019".
//
// What is submitted is unchanged: a hidden input carries the same ISO string
// every existing reader already expects.
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3009";

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  // Deliberately a DAY-FIRST locale: this is the setup that produced the
  // report, and the whole point is that it no longer changes what is asked for.
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, locale: "en-GB" });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("dialog", async (d) => { await d.accept(); });

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + String(detail).slice(0, 300) : "")); }
  };

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', "TestOwner123!");
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(2500);

  // ---------------- the parser, directly ----------------
  const P = (expr) => page.evaluate(expr);
  check("a US date becomes an ISO date", await P(`usDateToISO("03/04/2019")`) === "2019-03-04");
  check("March 4 is not April 3 — the whole point",
    await P(`usDateToISO("03/04/2019")`) !== "2019-04-03");
  check("single-digit month and day are accepted", await P(`usDateToISO("3/4/2019")`) === "2019-03-04");
  check("a day that does not exist is refused, not rolled forward",
    await P(`usDateToISO("02/30/2019")`) === null, await P(`usDateToISO("02/30/2019")`));
  check("month 13 is refused", await P(`usDateToISO("13/01/2019")`) === null);
  check("a day-first date is refused rather than silently reinterpreted",
    await P(`usDateToISO("25/12/2019")`) === null);
  check("Feb 29 in a leap year is a real date", await P(`usDateToISO("02/29/2020")`) === "2020-02-29");
  check("Feb 29 in a non-leap year is refused", await P(`usDateToISO("02/29/2019")`) === null);
  check("a two-digit year is refused rather than guessed", await P(`usDateToISO("03/04/19")`) === null);
  check("empty is null, not a date", await P(`usDateToISO("")`) === null);
  check("ISO converts back for display", await P(`isoToUSDate("2019-03-04")`) === "03/04/2019");
  check("the echo spells the month out", await P(`usDateInWords("2019-03-04")`) === "March 4, 2019");

  // ---------------- the enrolment form ----------------
  // #/pipeline is the old kanban board's address. It now redirects to the
  // Clients board, which carries the same "+ New Enrollment" button -- so this
  // also proves an old bookmark still gets somebody to the enrolment form.
  await page.evaluate(() => { location.hash = "#/pipeline"; });
  await page.waitForTimeout(2000);
  await page.waitForSelector("#new-client-btn", { timeout: 20000 });
  await page.click("#new-client-btn");
  await page.waitForTimeout(600);

  const dobBox = page.locator('[data-usdate-for="nc-dob"]');
  check("the enrolment form has a month-first date box", await dobBox.count() === 1);
  check("it says the order it wants", await dobBox.getAttribute("placeholder") === "MM/DD/YYYY",
    await dobBox.getAttribute("placeholder"));
  // The native control is what took its order from the browser; it must be gone.
  check("there is no native date control left to disagree with it",
    await page.locator('#new-client-form input[type="date"]').count() === 0);

  await dobBox.click();
  await page.keyboard.type("03042019");
  await page.waitForTimeout(300);
  check("slashes are inserted as you type", await dobBox.inputValue() === "03/04/2019", await dobBox.inputValue());
  check("the hidden field carries the ISO date the server expects",
    await page.locator("#nc-dob").inputValue() === "2019-03-04", await page.locator("#nc-dob").inputValue());
  const echo = await page.locator('[data-usdate-echo="nc-dob"]').innerText();
  check("and it is echoed back in words, where a transposition is visible",
    /March 4, 2019/.test(echo), echo);

  // A birthday in the future is a mistyped year every time.
  await dobBox.fill("");
  await page.keyboard.type("03042099");
  await page.waitForTimeout(300);
  check("a future birthday is refused", await page.locator("#nc-dob").inputValue() === "",
    await page.locator("#nc-dob").inputValue());
  check("and says why", /future/i.test(await page.locator('[data-usdate-echo="nc-dob"]').innerText()));

  // ---------------- it actually saves the right day ----------------
  const stamp = String(await page.evaluate(() => Date.now())).slice(-6);
  await dobBox.fill("");
  await page.keyboard.type("03042019");
  await page.fill('#new-client-form input[name="child_name"]', "Dob Probe " + stamp);
  await page.fill('#new-client-form input[name="parent_name"]', "Parent " + stamp);
  await page.fill('#new-client-form input[name="parent_email"]', `dob.${stamp}@example.invalid`);
  await page.click('#new-client-form button[type="submit"]');
  await page.waitForTimeout(2500);

  const saved = await page.evaluate(async (nm) => {
    const rows = await (await fetch("/api/clients", { credentials: "include" })).json();
    const c = rows.find((r) => r.child_name === nm);
    return c ? String(c.dob || "").slice(0, 10) : null;
  }, "Dob Probe " + stamp);
  check("the date stored is the one that was meant — March 4, not April 3",
    saved === "2019-03-04", saved);

  check("no uncaught JavaScript errors", errors.length === 0, errors.join(" ;; "));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
