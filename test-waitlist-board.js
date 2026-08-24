// Two things you should be able to tell from the board without opening anyone:
// who is on the waitlist, and nothing about money.
//
// The waitlist badge matters more than it looks. A waitlisted family is waiting
// on purpose -- nothing is being chased, by design. Without a marker on the
// card, that client is indistinguishable from one that has quietly stalled, and
// the whole board reads as a pile of neglect.
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3009";

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
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

  const setWaitlist = (id, on) => page.evaluate(async ({ id, on }) => {
    await fetch(`/api/clients/${id}/waitlist`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(on ? { waitlisted: true, reason: "Board visibility test" } : { waitlisted: false }),
    });
  }, { id, on });

  const live = await page.evaluate(async () => {
    const list = await (await fetch("/api/clients", { credentials: "include" })).json();
    return (Array.isArray(list) ? list : [])
      .filter((c) => !["discharged", "not_moving_forward"].includes(c.stage))
      .map((c) => ({ id: c.id, name: c.child_name }));
  });
  check("at least two live clients to compare", live.length >= 2, JSON.stringify(live));
  if (live.length < 2) { await browser.close(); process.exit(1); }

  const waited = live[0], notWaited = live[1];
  await setWaitlist(waited.id, true);
  await setWaitlist(notWaited.id, false);

  // ---------------- 1. the API carries it ----------------
  const api = await page.evaluate(async () => (await fetch("/api/dashboard/pipeline-v2", { credentials: "include" })).json());
  const wRow = (api || []).find((c) => c.id === waited.id);
  const nRow = (api || []).find((c) => c.id === notWaited.id);
  check("the board's data says who is waitlisted", wRow && wRow.waitlisted === true, JSON.stringify(wRow && { id: wRow.id, w: wRow.waitlisted }));
  check("and who is not", nRow && nRow.waitlisted === false, JSON.stringify(nRow && { id: nRow.id, w: nRow.waitlisted }));
  check("it carries the reason for the tooltip", wRow && /Board visibility test/.test(wRow.waitlist_reason || ""), wRow && wRow.waitlist_reason);

  // ---------------- 2. the badge is on the card ----------------
  const openBoard = async () => {
    await page.evaluate(() => { location.hash = "#/dashboard"; });
    await page.waitForTimeout(900);
    await page.evaluate(() => { location.hash = "#/pipeline-v2"; });
    await page.waitForFunction(() => !!document.querySelector("[data-pv2-open]"), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(700);
  };
  await openBoard();

  const cardText = (id) => page.evaluate((cid) => {
    const el = document.querySelector(`[data-pv2-open="${cid}"]`);
    return el ? el.innerText : null;
  }, id);

  const wText = await cardText(waited.id);
  const nText = await cardText(notWaited.id);
  check("the waitlisted client's card is on the board", wText != null, String(wText));
  check("their card says WAITLIST without opening it", /WAITLIST/i.test(wText || ""), wText);
  check("a client who isn't waitlisted has no badge", !/WAITLIST/i.test(nText || ""), nText);

  const tip = await page.evaluate((cid) => {
    const el = document.querySelector(`[data-pv2-open="${cid}"] span[title]`);
    return el ? el.getAttribute("title") : null;
  }, waited.id);
  check("hovering the badge explains it", /waitlist/i.test(tip || "") && /reminders/i.test(tip || ""), tip);

  // ---------------- 3. the filter isolates them ----------------
  const sel = page.locator("#pv2-f-waitlist");
  check("the board has a waitlist filter", await sel.count() > 0);
  if (await sel.count()) {
    await sel.selectOption("only");
    await page.waitForTimeout(900);
    let shown = await page.evaluate(() => [...document.querySelectorAll("[data-pv2-open]")].map((el) => Number(el.dataset.pv2Open)));
    check("'on the waitlist only' shows the waitlisted one", shown.includes(waited.id), JSON.stringify(shown));
    check("'on the waitlist only' hides the rest", !shown.includes(notWaited.id), JSON.stringify(shown));

    await sel.selectOption("hide");
    await page.waitForTimeout(900);
    shown = await page.evaluate(() => [...document.querySelectorAll("[data-pv2-open]")].map((el) => Number(el.dataset.pv2Open)));
    check("'hide waitlisted' drops them", !shown.includes(waited.id), JSON.stringify(shown));
    check("'hide waitlisted' keeps everyone else", shown.includes(notWaited.id), JSON.stringify(shown));

    await sel.selectOption("");
    await page.waitForTimeout(900);
    shown = await page.evaluate(() => [...document.querySelectorAll("[data-pv2-open]")].map((el) => Number(el.dataset.pv2Open)));
    check("clearing the filter shows both again", shown.includes(waited.id) && shown.includes(notWaited.id), JSON.stringify(shown));
  }

  // ---------------- 4. no money on any client surface ----------------
  const MONEY = /\$\s?[\d,]|Est\.? monthly revenue|Owner Financial|Lifetime value|revenue per hour/i;
  const boardText = await page.locator("#view-mount").innerText();
  check("no money on the milestone board", !MONEY.test(boardText), (boardText.match(MONEY) || [""])[0] + " …");

  const scriptGone = await page.evaluate(() => !document.querySelector('script[src*="owner-financials"]'));
  check("the financial snapshot script is not loaded", scriptGone);

  await page.evaluate((cid) => openClientModal(cid), waited.id);
  await page.waitForTimeout(2600);
  const modalText = await page.locator(".modal-backdrop").last().innerText().catch(() => "");
  check("the client card opened", modalText.length > 50);
  check("no money on the client card", !MONEY.test(modalText), (modalText.match(MONEY) || [""])[0] + " …");
  check("no Owner Financial Snapshot on the card", !/financial snapshot/i.test(modalText));
  // What should still be there.
  check("the card still shows the waitlist section", /Waitlist/i.test(modalText));
  check("the card still shows authorizations", /authoriz/i.test(modalText));

  // ---------------- 5. the old board shows it too ----------------
  await page.evaluate(() => { document.querySelectorAll(".modal-backdrop").forEach((b) => b.remove()); });
  await page.evaluate(() => { location.hash = "#/pipeline"; });
  await page.waitForTimeout(2500);
  const oldBoard = await page.locator("#view-mount").innerText();
  check("the stage board marks the waitlisted client", /Waitlist/i.test(oldBoard), oldBoard.slice(0, 300));
  check("no money on the stage board", !MONEY.test(oldBoard), (oldBoard.match(MONEY) || [""])[0] + " …");

  // ---- every filter has to be reachable ----------------------------------
  // Reported as "I can't find the waitlisted clients". They were on the board
  // the whole time; the waitlist filter is the LAST control in the filter row
  // and it had scrolled off the right edge of the window, along with "Clear
  // filters". The cause was .main being a flex child with the default
  // min-width:auto, so the wide board pushed the page wider than the window
  // instead of scrolling inside its own container -- and anything past the
  // fold became unreachable.
  //
  // Asserted on geometry rather than on the CSS rule, because the next way this
  // breaks will not be that rule.
  await page.evaluate(() => { location.hash = "#/pipeline-v2"; });
  await page.waitForTimeout(2200);

  const layout = await page.evaluate(() => {
    const off = [];
    document.querySelectorAll("#view-mount select, #view-mount button").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;         // genuinely hidden
      if (r.right > window.innerWidth + 1 || r.left < -1) {
        off.push((el.id || el.tagName) + " @" + Math.round(r.left) + "-" + Math.round(r.right));
      }
    });
    return {
      offScreen: off,
      pageScrollsSideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      waitlistFilter: !!document.querySelector("#pv2-f-waitlist"),
    };
  });
  check("the board has a waitlist filter at all", layout.waitlistFilter === true);
  check("no control is pushed off the side of the window",
    layout.offScreen.length === 0, layout.offScreen);
  check("and the page itself does not scroll sideways",
    layout.pageScrollsSideways === false,
    "the board should scroll inside its own container, not widen the page");

  await setWaitlist(waited.id, false);
  check("no uncaught JavaScript errors", errors.length === 0, errors.join(" ;; "));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
