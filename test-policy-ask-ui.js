// The question box, and the memo, on the screen.
//
// test-policy-ask.js proves the retrieval and the amendment rules against the
// API. This is the half that only exists on the page, and it is not decoration:
//
//   * THE ANSWER HAS TO BE READABLE AS AN ANSWER. A passage with no indication
//     of why it came back is a wall of policy text. The words that matched are
//     marked, and that mark is the difference between "here is a paragraph"
//     and "here is your answer".
//   * THE MEMO HAS TO COME FIRST. Reading order is the whole safety property:
//     somebody who reads the top of the policy and stops must have read the
//     CURRENT rule, not the one it replaced. This measures the pixels, because
//     "it's in the markup above it" is not the same thing.
//   * A MEMO IS NOT AN EDIT. The original wording has to still be on the
//     screen, under the memo, labelled as the original.
//   * ONLY THE PEOPLE WHO SET POLICY GET THE BUTTON -- and the route refuses
//     everyone else regardless, which the API suite already proves. This is
//     about not offering a BCBA an action they cannot take.
"use strict";
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3009";

const SOP_BODY = [
  "Purpose. This procedure sets out how the clinical team prepares, reviews and submits treatment plans following an assessment.",
  "Turnaround. Following completion of the assessment, the assigned analyst must complete and submit the written treatment plan within 7 calendar days.",
  "Review. The clinical director reviews each submitted plan before it is sent to the funding source.",
].join("\n\n");
const MEMO_BODY = "Effective immediately, the assigned analyst has 14 calendar days from completion of the assessment to submit the written treatment plan. This replaces the 7 calendar day turnaround above.";
const QUESTION = "how long do BCBAs have to finish a treatment plan?";

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
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
    await page.waitForTimeout(1800);
  };
  const openPolicies = async () => {
    await page.evaluate(() => { location.hash = "#/dashboard"; });
    await page.waitForTimeout(600);
    await page.evaluate(() => { location.hash = "#/policies"; });
    await page.waitForSelector("#pol-ask", { timeout: 20000 });
    await page.waitForTimeout(700);
  };
  const askIt = async (q) => {
    await page.fill("#pol-ask", q);
    await page.click("#pol-ask-go");
    await page.waitForFunction(() => {
      const el = document.querySelector("#pol-ask-out");
      return el && !/Reading the policies/.test(el.textContent) && el.textContent.trim().length > 0;
    }, null, { timeout: 20000 });
    await page.waitForTimeout(400);
  };

  await login("admin@spectrumsquadlv.com", "TestOwner123!");
  const sop = await page.evaluate(async (body) => {
    const r = await fetch("/api/policies", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Treatment Plan Turnaround SOP", category: "Clinical", body }),
    });
    return r.json();
  }, SOP_BODY);

  console.log("\n== The question box is on the page ==");
  await openPolicies();
  check("there is somewhere to type a question", await page.locator("#pol-ask").count() === 1);
  check("and it invites one in plain words rather than keywords",
    /what do you want to know/i.test(await page.getAttribute("#pol-ask", "placeholder") || ""),
    await page.getAttribute("#pol-ask", "placeholder"));
  check("the keyword search is still there beside it, not replaced by it",
    await page.locator("#pol-q").count() === 1);

  console.log("\n== Asking it ==");
  await askIt(QUESTION);
  let out = await page.innerText("#pol-ask-out");
  check("an answer comes back", /Treatment Plan Turnaround SOP/.test(out), out.slice(0, 300));
  check("QUOTING THE PARAGRAPH THAT ANSWERS IT", /within 7 calendar days/.test(out), out.slice(0, 400));
  // Not the whole document: the passage is the section that answers, not the
  // preamble above it. (The short "Review" paragraph rides along with it --
  // a paragraph too short to stand as its own passage is folded into its
  // neighbour, which is the splitter working, not the whole file coming back.)
  check("and not the whole document", !/Purpose\. This procedure sets out/.test(out), out.slice(0, 400));
  const marks = await page.locator("#pol-ask-out mark").allInnerTexts();
  check("THE WORDS THAT MATCHED ARE MARKED, so it reads as an answer and not a wall of text",
    marks.length >= 2, marks);
  check("and they are words from the question", marks.some((m) => /plan|treatment|long|day/i.test(m)), marks);

  console.log("\n== Writing the memo, from the policy itself ==");
  await page.click(`[data-pol-open="${sop.id}"]`);
  await page.waitForSelector("#pol-r-amend", { timeout: 10000 });
  check("a policy someone can change offers a memo button", await page.locator("#pol-r-amend").count() === 1);
  await page.click("#pol-r-amend");
  await page.waitForSelector("#am-title", { timeout: 10000 });
  check("THE FORM SAYS WHAT A MEMO IS -- that the policy's own wording is not being changed",
    /wording is not\s+changed|not\s*changed/i.test((await page.innerText(".modal-backdrop")).replace(/\s+/g, " ")),
    (await page.innerText(".modal-backdrop")).slice(0, 400));
  await page.fill("#am-title", "Treatment plan turnaround extended to 14 days");
  await page.fill("#am-body", MEMO_BODY);
  await page.click("#am-save");
  await page.waitForSelector("#pol-ask", { timeout: 20000 });
  await page.waitForTimeout(1200);

  console.log("\n== The card says it has been amended ==");
  const cardText = await page.innerText(`[data-pol-open="${sop.id}"]`);
  check("the library card carries the mark", /amended/i.test(cardText), cardText);
  check("and the version moved", /v2/.test(cardText), cardText);

  console.log("\n== Now the question answers fourteen ==");
  await askIt(QUESTION);
  out = await page.innerText("#pol-ask-out");
  check("THE ANSWER IS THE MEMO", /14 calendar days/.test(out), out.slice(0, 400));
  check("it is labelled as coming from a memo, not passed off as the policy text",
    /from an amendment memo/i.test(out), out.slice(0, 400));
  check("the policy is flagged as amended on the answer", /has been amended/i.test(out), out.slice(0, 400));
  // Opened, not read through the DOM: a disclosure that holds the old wording
  // but never opens is the same as not having it.
  check("there is a way to see the wording it replaced",
    await page.locator("#pol-ask-out details summary").count() === 1);
  await page.click("#pol-ask-out details summary");
  await page.waitForTimeout(300);
  check("and opening it shows the original", /7 calendar days/.test(await page.innerText("#pol-ask-out details")),
    await page.innerText("#pol-ask-out details").catch(() => "no details element"));

  console.log("\n== Reading the policy: the memo comes first ==");
  await page.click(`[data-pol-open="${sop.id}"]`);
  await page.waitForSelector(".pol-read", { timeout: 10000 });
  const geo = await page.evaluate(() => {
    const memo = document.querySelector(".modal-backdrop .pol-memo");
    const body = document.querySelector(".modal-backdrop .pol-read");
    const orig = document.querySelector(".modal-backdrop .pol-orig-h");
    return {
      memoTop: memo ? Math.round(memo.getBoundingClientRect().top) : null,
      bodyTop: body ? Math.round(body.getBoundingClientRect().top) : null,
      memoText: memo ? memo.innerText : null,
      bodyText: body ? body.innerText : null,
      origLabel: orig ? orig.innerText : null,
    };
  });
  check("the memo is rendered in the reader", !!geo.memoText && /14 calendar days/.test(geo.memoText), geo.memoText);
  check("THE MEMO IS PHYSICALLY ABOVE THE POLICY TEXT -- read the top, read the current rule",
    geo.memoTop !== null && geo.bodyTop !== null && geo.memoTop < geo.bodyTop, geo);
  check("THE ORIGINAL WORDING IS STILL ON THE SCREEN, not replaced",
    /within 7 calendar days/.test(geo.bodyText || ""), (geo.bodyText || "").slice(0, 200));
  check("and it is labelled as the original, with the memo taking precedence",
    /original policy text/i.test(geo.origLabel || ""), geo.origLabel);
  await page.keyboard.press("Escape");
  await page.evaluate(() => { const b = document.querySelector(".modal-backdrop .close-btn"); if (b) b.click(); });
  await page.waitForTimeout(500);

  console.log("\n== A BCBA reads it and cannot change it ==");
  await login("clinical@spectrumsquadlv.com", "TestStaff123!");
  await openPolicies();
  await askIt(QUESTION);
  out = await page.innerText("#pol-ask-out");
  check("staff get the same answer", /14 calendar days/.test(out), out.slice(0, 300));
  await page.click(`[data-pol-open="${sop.id}"]`);
  await page.waitForSelector(".pol-read", { timeout: 10000 });
  const staffModal = await page.innerText(".modal-backdrop");
  check("they see the memo", /14 calendar days/.test(staffModal), staffModal.slice(0, 300));
  check("AND ARE NOT OFFERED A BUTTON THEY CANNOT USE",
    await page.locator("#pol-r-amend").count() === 0);
  check("nor an edit button", await page.locator("#pol-r-edit").count() === 0);

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  if (failures.length) { console.log("\n--- failures ---"); failures.forEach((f) => console.log(f)); }
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
