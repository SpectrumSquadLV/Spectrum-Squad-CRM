// Shared Playwright helpers for the client card.
//
// Named card-test-helpers.js, not test-card-helpers.js: run-tests.js treats
// every test-*.js file as a suite to execute, and this one has nothing to run.
//
// The card's sections fold (see the .cs accordion in index.html), and a closed
// <details> is genuinely not rendered: innerText skips it and clicks time out.
// That is the feature working. But it means every suite that reaches into a
// section has to open it first, and five of them do -- so the helper lives
// here rather than being copied five times and drifting.
"use strict";

// Open one section of the currently-open client card, by its data-cs key.
// Dispatches the toggle event so the "remember what I left open" handler sees
// it, exactly as a real click would.
async function openCardSection(page, key) {
  await page.evaluate((k) => {
    const d = document.querySelector(`.modal-backdrop details.cs[data-cs="${k}"]`);
    if (d && !d.open) { d.open = true; d.dispatchEvent(new Event("toggle")); }
  }, key);
  await page.waitForTimeout(350);
}

// Open every section. For suites that just want to read the whole card.
async function openAllCardSections(page) {
  await page.evaluate(() => {
    document.querySelectorAll(".modal-backdrop details.cs").forEach((d) => {
      if (!d.open) { d.open = true; d.dispatchEvent(new Event("toggle")); }
    });
  });
  await page.waitForTimeout(600);
}

// The explanations that used to be paragraphs now live on hover icons, so a
// suite checking "the card explains X" reads the titles, not the body text.
async function cardHintText(page) {
  return (await page.$$eval(".modal-backdrop .hint-badge", (hs) => hs.map((h) => h.getAttribute("title") || "")))
    .join("\n");
}

module.exports = { openCardSection, openAllCardSections, cardHintText };
