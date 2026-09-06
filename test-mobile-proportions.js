// Every screen, at phone width.
//
//   DATABASE_URL=... node server.js
//   DATABASE_URL=... BASE=http://127.0.0.1:3009 node test-mobile-proportions.js
//
// Reported as "when the crm is accessed from a phone the view isn't
// proportional", and it was true of every page, for one reason.
//
// THE CAUSE WAS A SINGLE MISPLACED SEMICOLON'S WORTH OF CSS. index.html closed
// its :root block and then left one declaration outside it:
//
//     }--font-header: "Outfit", ... sans-serif;
//
//     * { box-sizing: border-box; }
//
// A declaration cannot live outside a block, so the parser reads everything
// from there to the next brace as ONE SELECTOR -- "--font-header: ... ; *" --
// which is invalid, and DROPS THE RULE ATTACHED TO IT. The universal
// border-box rule the author wrote never applied. Every width in the
// application was content-box, so padding and borders added on top of every
// declared size: .sidebar written 240px rendered 272px, and on a 390px phone
// the navigation took most of the screen with the content squeezed beside it.
//
// It is invisible in the source. The rule is right there, it looks right, and
// it is dead.
//
// WHAT THIS SUITE DOES is walk every page the owner can reach at phone width
// and measure. It prints the table on every run, whether or not it passes,
// because "proportional" is not a boolean and the numbers are the point.
//
// A page FAILS when the document is wider than the screen -- which is the
// thing a person feels as sideways scrolling and shrunken text. Content that
// scrolls inside its own box (a wide table in an overflow-x container) is not
// counted: that is a deliberate design and the page around it still fits.
"use strict";
const { chromium } = require("playwright");

const BASE = process.env.BASE || "http://localhost:3009";
// An iPhone 13/14/15 in portrait. Narrow enough to be honest, and the width
// most of this practice's phones actually report.
const PHONE = { width: 390, height: 844 };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  let pass = 0, fail = 0;
  const failures = [];
  const check = (n, c, d) => {
    if (c) { pass++; console.log("  PASS  " + n); }
    else {
      const line = "  FAIL  " + n + (d !== undefined ? "  -> " + (typeof d === "string" ? d : JSON.stringify(d)).slice(0, 300) : "");
      fail++; failures.push(line); console.log(line);
    }
  };

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('#login-form input[name="email"]', { timeout: 15000 });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', "TestOwner123!");
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(2000);

  console.log("\n== The shell itself ==");
  const shell = await page.evaluate(() => {
    const side = document.querySelector(".sidebar");
    const cs = side ? getComputedStyle(side) : null;
    return {
      declared: cs ? cs.width : null,
      rendered: side ? Math.round(side.getBoundingClientRect().width) : null,
      boxSizing: cs ? cs.boxSizing : null,
      viewport: window.innerWidth,
    };
  });
  console.log(`  sidebar: ${shell.rendered}px rendered, box-sizing: ${shell.boxSizing}, viewport ${shell.viewport}px`);
  check("THE UNIVERSAL border-box RULE ACTUALLY APPLIES",
    shell.boxSizing === "border-box",
    `.sidebar computes box-sizing: ${shell.boxSizing}. If this is content-box, the rule in index.html is being dropped by the parser -- check for a declaration sitting outside a block just above it.`);
  // Under 900px the sidebar is a DRAWER: fixed, translated off screen, taking
  // no layout space at all. Measuring its width here would report 260px and
  // mean nothing, so what is checked is that it is out of the way and that the
  // content column got the room.
  const drawer = await page.evaluate(() => {
    const side = document.querySelector(".sidebar");
    const cs = side ? getComputedStyle(side) : null;
    const main = document.querySelector(".main");
    return {
      position: cs ? cs.position : null,
      offCanvas: !!side && side.getBoundingClientRect().right <= 1,
      toggleShown: !!document.getElementById("nav-toggle")
        && getComputedStyle(document.getElementById("nav-toggle")).display !== "none",
      mainWidth: main ? Math.round(main.getBoundingClientRect().width) : null,
      win: window.innerWidth,
    };
  });
  check("ON A PHONE THE NAVIGATION IS A DRAWER, not a column stealing half the screen",
    drawer.position === "fixed" && drawer.offCanvas, drawer);
  check("with a button to open it", drawer.toggleShown, drawer);
  check("and the content column gets the whole width",
    drawer.mainWidth !== null && drawer.mainWidth >= drawer.win - 1, drawer);

  // Every page this account can reach, taken from its own sidebar rather than
  // a list here -- a page added next month is scanned without being added.
  const routes = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("[data-nav]").forEach((el) => {
      if (el.hasAttribute("data-nav-external")) return;   // leaves the CRM
      out.push({ key: el.dataset.nav, hash: el.dataset.navHash || "#/" + el.dataset.nav });
    });
    return out;
  });
  console.log(`\n== ${routes.length} pages at ${PHONE.width}x${PHONE.height} ==\n`);

  // MEASURED AGAINST THE DEVICE, not against window.innerWidth, and the
  // difference is the whole bug. The viewport meta is correct
  // (width=device-width, initial-scale=1) but with no maximum-scale Chrome on
  // a phone WIDENS THE LAYOUT VIEWPORT to fit content that overflows -- it
  // zooms the page out rather than letting it scroll sideways. So innerWidth
  // grows to whatever the content demanded, document width always equals it,
  // and a naive doc-vs-innerWidth check passes on every page while the person
  // holding the phone is looking at 2x-shrunken text.
  //
  // innerWidth larger than the device width IS the symptom.
  const measure = async () => page.evaluate((device) => {
    const win = window.innerWidth;
    const doc = document.documentElement.scrollWidth;
    const zoom = +(win / device).toFixed(2);
    // The widest thing sticking out that ISN'T already clipped by a scrolling
    // ancestor. A wide table inside overflow-x:auto is meant to scroll in its
    // own box; reporting it hides whatever is actually pushing the page.
    let worst = null;
    const clipped = (el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (o === "auto" || o === "scroll" || o === "hidden") return true;
      }
      return false;
    };
    document.querySelectorAll("body *").forEach((el) => {
      const r = el.getBoundingClientRect();
      // AGAINST THE DEVICE, not against innerWidth. innerWidth has already
      // grown to fit whatever overflowed, so comparing to it finds nothing --
      // every element fits the viewport the overflow created.
      if (r.width === 0 || r.right <= device + 1) return;
      if (clipped(el)) return;
      if (!worst || r.width > worst.width) {
        worst = {
          right: Math.round(r.right),
          width: Math.round(r.width),
          // Enough to find it in the source. A bare "div" is not actionable,
          // and most of the wide things in this app are inline-styled, so the
          // style and the ancestry are what identify them.
          sel: el.tagName.toLowerCase()
            + (el.id ? "#" + el.id : "")
            + (el.className && typeof el.className === "string" && el.className.trim()
                ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""),
          style: (el.getAttribute("style") || "").slice(0, 110),
          within: (() => {
            const trail = [];
            for (let q = el.parentElement; q && trail.length < 3; q = q.parentElement) {
              trail.push(q.tagName.toLowerCase() + (q.id ? "#" + q.id : "")
                + (q.className && typeof q.className === "string" && q.className.trim()
                    ? "." + q.className.trim().split(/\s+/)[0] : ""));
            }
            return trail.join(" < ");
          })(),
          text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 45),
        };
      }
    });
    return { win, doc, zoom, over: Math.max(0, win - device), worst };
  }, 390);

  const rows = [];
  for (const r of routes) {
    await page.goto(BASE + "/" + r.hash, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1400);
    const m = await measure();
    rows.push({ key: r.key, ...m });
    const flag = m.over > 1
      ? `  <-- zoomed out ${m.zoom}x` + (m.worst ? `, widest: ${m.worst.sel}` : "")
      : "";
    console.log(`  ${r.key.padEnd(20)} laid out at ${String(m.win).padStart(5)}px on a ${PHONE.width}px screen${flag}`);
  }

  console.log("\n== The verdict ==");
  const over = rows.filter((r) => r.over > 1);
  const worst = rows.slice().sort((a, b) => b.win - a.win)[0];
  console.log(`  widest page: ${worst.key} at ${worst.win}px (${worst.zoom}x zoom-out)`);
  // Printed as its own block rather than only inside the failure detail: the
  // runner keeps just the tail of a failing suite, so the per-page table above
  // scrolls away and this is what a person actually reads.
  if (over.length) {
    console.log("\n  what is pushing each one:");
    over.forEach((r) => console.log(
      `    ${r.key.padEnd(16)} ${String(r.win).padStart(4)}px  ${r.worst
        ? r.worst.sel + " " + r.worst.width + "px\n        in: " + r.worst.within
          + (r.worst.style ? "\n        style: " + r.worst.style : "")
          + (r.worst.text ? '\n        text: "' + r.worst.text + '"' : "")
        : "nothing unclipped found -- likely fixed/absolute"}`));
    console.log("");
  }
  check(`NO PAGE FORCES THE PHONE TO ZOOM OUT (${rows.length} scanned)`,
    over.length === 0,
    over.map((r) => `${r.key} ${r.win}px/${r.zoom}x${r.worst ? " (" + r.worst.sel + ")" : ""}`).join(", "));

  // A page that fits but only because everything on it is crushed is not a
  // pass either. The content column has to be usable.
  await page.goto(BASE + "/#/dashboard", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1400);
  const main = await page.evaluate(() => {
    const m = document.querySelector(".main");
    return m ? Math.round(m.getBoundingClientRect().width) : null;
  });
  console.log(`  content column: ${main}px of ${PHONE.width}px`);
  check("THE CONTENT COLUMN GETS MOST OF THE SCREEN, not the navigation",
    main !== null && main >= PHONE.width * 0.55, `${main}px of ${PHONE.width}px`);

  check("no page errors while scanning", errors.length === 0, errors.slice(0, 3).join(" | "));
  if (failures.length) { console.log("\n--- failures ---"); failures.forEach((f) => console.log(f)); }
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
