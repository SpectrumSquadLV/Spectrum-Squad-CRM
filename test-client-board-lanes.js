// Twenty clients should not be twenty cards deep.
//
// Reported as: "the client section shows each client card going down, making
// the page longer -- is there a way we can double line each client so it's not
// just 20 clients one by one going down the page".
//
// THE OBVIOUS FIX IS THE WRONG ONE. Widening every column to fit two cards
// makes the board 2000px across whether or not there is anything in it, and
// four of the five phases hold a handful of clients at a time. A wide, mostly
// empty column is worse than a narrow full one, and the board already scrolls
// sideways -- pushing it wider is a cost paid on every screen to fix one.
//
// So a column earns lanes from what it is actually holding: a second past six
// cards, a third past fourteen, never more than three. The busy phase spreads
// sideways, the quiet ones are untouched, and the board grows only where there
// is something to put in the width.
//
// WHAT THIS SUITE HAS TO PROVE, and the reason each one is here:
//
//   * The cards are GENUINELY SIDE BY SIDE. A grid that reports three columns
//     while every card still renders on its own row would satisfy any check
//     that reads the CSS, so this reads the RECTANGLES.
//   * The column got SHORTER. Height is the entire complaint; lanes that do
//     not shorten anything have missed the point.
//   * A QUIET COLUMN IS UNCHANGED. This is the half that makes it worth doing
//     rather than a blanket widening.
//   * IT COLLAPSES ON A NARROW SCREEN. Two 120px cards side by side would be
//     worse than the scrolling this is meant to shorten, and the phone layout
//     was fixed in the same breath as this.
//   * CLICKING A CARD STILL OPENS THE CLIENT. The cards moved inside a new
//     wrapper element; every handler in both boards is delegated from an
//     ancestor, and that is exactly the kind of change that quietly breaks one.
"use strict";
const { chromium } = require("playwright");

const BASE = process.env.BASE || "http://localhost:3009";
const WIDE = { width: 1600, height: 1000 };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: WIDE });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("dialog", async (d) => { await d.accept(); });

  let pass = 0, fail = 0;
  const failures = [];
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else {
      const line = "  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : "");
      fail++; failures.push(line); console.log(line);
    }
  };

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForSelector('#login-form input[name="email"]', { timeout: 15000 });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', "TestOwner123!");
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(2200);

  // A caseload big enough to be the problem. New enrollments land in Intake &
  // Eligibility, so that is the column that fills; the other four stay as the
  // install seeded them, which is what makes the "quiet column" check real
  // rather than arranged.
  const TARGET = 16;
  const seeded = await page.evaluate(async (target) => {
    const board = await (await fetch("/api/dashboard/pipeline-v2", { credentials: "include" })).json();
    const inIntake = (board || []).filter((c) => c.milestone === 2).length;
    const made = [];
    for (let i = inIntake; i < target; i++) {
      const r = await fetch("/api/clients", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          child_name: "Lane Test " + String(i).padStart(2, "0"),
          parent_name: "Lane Parent " + i,
          parent_email: "lane." + i + "@example.invalid",
        }),
      });
      made.push(r.status);
    }
    const after = await (await fetch("/api/dashboard/pipeline-v2", { credentials: "include" })).json();
    const counts = {};
    (after || []).forEach((c) => { counts[c.milestone] = (counts[c.milestone] || 0) + 1; });
    return { created: made.length, counts };
  }, TARGET);
  console.log(`  seeded ${seeded.created} enrollments; per-milestone counts ${JSON.stringify(seeded.counts)}`);
  check("a phase busy enough to need lanes exists to test against",
    (seeded.counts[2] || 0) > 14, seeded.counts);

  // ---------------------------------------------------------------- board ---
  const openBoard = async () => {
    await page.evaluate(() => { location.hash = "#/dashboard"; });
    await page.waitForTimeout(800);
    await page.evaluate(() => { location.hash = "#/pipeline-v2"; });
    await page.waitForFunction(() => !!document.querySelector("[data-pv2-open]"), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(900);
  };
  await openBoard();

  // Rectangles, not stylesheets. A column "laid out in three lanes" that still
  // draws one card per row would pass any check that reads grid-template-columns.
  const geometry = () => page.evaluate(() => {
    const cols = [...document.querySelectorAll(".pv2-col")].map((col) => {
      const cards = [...col.querySelectorAll("[data-pv2-open]")].map((el) => {
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), top: Math.round(r.top), h: Math.round(r.height) };
      });
      const lefts = [...new Set(cards.map((c) => c.left))];
      const tops = [...new Set(cards.map((c) => c.top))];
      return {
        lanes: Number(col.dataset.pv2Lanes || 1),
        count: cards.length,
        // How many cards actually START at a different x. This is the number
        // that says "side by side" and nothing else does.
        distinctLefts: lefts.length,
        rows: tops.length,
        height: Math.round(col.getBoundingClientRect().height),
        width: Math.round(col.getBoundingClientRect().width),
        cardHeights: cards.reduce((a, c) => a + c.h, 0),
      };
    });
    return { cols, board: Math.round((document.querySelector(".pv2-board") || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width) };
  });

  console.log("\n== The busy phase ==");
  let g = await geometry();
  const busy = g.cols.slice().sort((a, b) => b.count - a.count)[0];
  const quiet = g.cols.filter((c) => c.count > 0 && c.count <= 6).sort((a, b) => a.count - b.count)[0];
  g.cols.forEach((c) => console.log(
    `  ${String(c.count).padStart(3)} cards  ${c.lanes} lane(s)  ${String(c.width).padStart(4)}px wide  ${String(c.height).padStart(5)}px tall  in ${c.rows} row(s)`));

  check("a phase past fourteen clients gets three lanes", busy.lanes === 3, busy);
  check("AND THE CARDS ARE GENUINELY SIDE BY SIDE, not three columns on paper",
    busy.distinctLefts === 3, busy);
  check("so the cards sit in rows of three", busy.rows === Math.ceil(busy.count / 3), busy);
  // The complaint was height. If the column is not meaningfully shorter than
  // the cards stacked, nothing has been fixed.
  check("AND THE COLUMN IS SHORTER THAN THE CARDS STACKED -- which is the whole point",
    busy.height < busy.cardHeights * 0.55,
    { columnHeight: busy.height, ifStacked: busy.cardHeights, count: busy.count });

  console.log("\n== The quiet phases are left alone ==");
  check("a phase with six or fewer clients exists to compare", !!quiet, g.cols.map((c) => c.count));
  if (quiet) {
    check("IT STAYS ONE LANE -- the board is not widened where there is nothing to put",
      quiet.lanes === 1, quiet);
    check("and every one of its cards starts at the same x", quiet.distinctLefts === 1, quiet);
    check("at the width it always was", quiet.width >= 320 && quiet.width <= 326, quiet);
  }

  console.log("\n== Clicking a card still opens the client ==");
  // The cards moved inside a new wrapper. Both boards delegate their handlers
  // from an ancestor, so this is the change that would break one silently.
  const firstId = await page.evaluate(() => {
    const el = document.querySelector("[data-pv2-open]");
    return el ? el.getAttribute("data-pv2-open") : null;
  });
  await page.click(`[data-pv2-open="${firstId}"]`);
  await page.waitForTimeout(1600);
  check("the card is still clickable through its new wrapper",
    page.url().includes("#/pipeline/" + firstId), { url: page.url(), firstId });

  console.log("\n== On a narrow screen the lanes collapse ==");
  await page.setViewportSize({ width: 900, height: 1000 });
  await openBoard();
  await page.waitForTimeout(600);
  const narrow = await geometry();
  const narrowBusy = narrow.cols.slice().sort((a, b) => b.count - a.count)[0];
  console.log(`  busy phase at 900px: ${narrowBusy.count} cards, ${narrowBusy.distinctLefts} distinct x, ${narrowBusy.width}px wide`);
  check("BELOW 1180px EVERY COLUMN IS ONE CARD WIDE -- two 120px cards would be worse than scrolling",
    narrowBusy.distinctLefts === 1, narrowBusy);
  check("and the column is back to its normal width", narrowBusy.width <= 330, narrowBusy);
  await page.setViewportSize(WIDE);

  // ------------------------------------------------------------- the other --
  // #/pipeline is the drag-and-drop board, still reachable and still what a
  // card click deep-links into. It had the identical problem and got the
  // identical rule; a fix applied to one of two boards is half a fix.
  console.log("\n== The drag-and-drop board got the same treatment ==");
  await page.evaluate(() => { location.hash = "#/pipeline"; });
  await page.waitForFunction(() => !!document.querySelector(".kanban-col"), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1400);
  const kan = await page.evaluate(() => [...document.querySelectorAll(".kanban-col")].map((col) => {
    const cards = [...col.querySelectorAll(".client-card")].map((el) => Math.round(el.getBoundingClientRect().left));
    return {
      phase: col.dataset.phase,
      lanes: Number(col.dataset.lanes || 1),
      count: cards.length,
      distinctLefts: [...new Set(cards)].length,
      height: Math.round(col.getBoundingClientRect().height),
      hasWrapper: !!col.querySelector(".kanban-cards"),
    };
  }));
  kan.forEach((c) => console.log(`  ${String(c.count).padStart(3)} cards  ${c.lanes} lane(s)  ${c.phase}`));
  const kBusy = kan.slice().sort((a, b) => b.count - a.count)[0];
  const kQuiet = kan.filter((c) => c.count > 0 && c.count <= 6)[0];
  check("its busy column has lanes too", kBusy.lanes > 1, kBusy);
  check("and its cards are side by side as well", kBusy.distinctLefts === kBusy.lanes, kBusy);
  check("the cards live in a wrapper the grid can lay out", kBusy.hasWrapper, kBusy);
  if (kQuiet) check("its quiet columns are unchanged", kQuiet.lanes === 1 && kQuiet.distinctLefts === 1, kQuiet);

  console.log("\n== And dragging still works ==");
  // The drop target is the column; the cards are now one level deeper inside
  // it. Drop events bubble, so this should hold -- and it is cheap to prove
  // rather than assume, because a board you cannot drag on is not this board.
  const dragged = await page.evaluate(async () => {
    const card = document.querySelector(".kanban-cards .client-card[data-client]");
    if (!card) return { ok: false, why: "no card" };
    const id = card.dataset.client;
    // Read the stage from the LIST. There is no single-client GET on this API;
    // asking for one returns something without a stage on it, and the first
    // version of this check compared undefined to undefined and reported a
    // failure while the drag had in fact worked.
    const stageOf = async (cid) => {
      const list = await (await fetch("/api/clients", { credentials: "include" })).json();
      const row = (Array.isArray(list) ? list : []).find((c) => String(c.id) === String(cid));
      return row ? row.stage : null;
    };
    const before = await stageOf(id);
    const target = [...document.querySelectorAll(".kanban-col")]
      .find((c) => c.dataset.phase && !c.contains(card));
    if (!target) return { ok: false, why: "no other column" };
    const dt = new DataTransfer();
    card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
    await new Promise((r) => setTimeout(r, 1800));
    const after = await stageOf(id);
    return { ok: true, id, before, after, to: target.dataset.phase };
  });
  check("A CARD CAN STILL BE DRAGGED TO ANOTHER PHASE from inside the new wrapper",
    dragged.ok && dragged.before !== dragged.after, dragged);

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  if (failures.length) { console.log("\n--- failures ---"); failures.forEach((f) => console.log(f)); }
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
