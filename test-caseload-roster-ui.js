// The panel that told somebody there was no problem.
//
// Reported as: "it says nothing is duplicated" — while two Marissas sat on the
// caseload board with her clients split between them.
//
// THE PANEL WAS A DEAD END. It recognised exactly two shapes: a name that is
// another one SHORTENED ("Marissa" inside "Marissa Gaut"), and the same name
// spaced or capitalised differently. Everything else — a surname typed two
// ways, a middle initial, an initialled surname, a slip in the spelling — read
// as two separate people. And when it matched nothing it SAID SO, in as many
// words, which is worse than saying nothing: it tells a person looking straight
// at the duplicate that there is nothing to fix.
//
// The fix is not a cleverer matcher. A matcher confident enough to merge
// "Marissa Gaut" into "Marissa Gauthier" is a matcher that will one day move an
// entire caseload onto the wrong clinician, silently, leaving a screen that
// looks completely normal afterwards. So the guessing stays conservative and
// the PANEL stops depending on it: every name on file is listed with its
// count — two rows that look identical on screen are two different strings, and
// seeing them together is usually the whole diagnosis — and an admin merges the
// pair themselves.
"use strict";
const { chromium } = require("playwright");
const { Pool } = require("pg");

const BASE = process.env.BASE || "http://localhost:3009";

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("dialog", async (d) => { await d.accept(); });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

  let pass = 0, fail = 0;
  const failures = [];
  const check = (n, c, d) => {
    if (c) { pass++; console.log("  PASS  " + n); }
    else {
      const line = "  FAIL  " + n + (d !== undefined ? "  -> " + (typeof d === "string" ? d : JSON.stringify(d)).slice(0, 400) : "");
      fail++; failures.push(line); console.log(line);
    }
  };

  // Exactly the reported shape: one clinician, two spellings of the surname,
  // which the matcher does not and should not recognise on its own.
  const add = (child, bcba) => pool.query(
    `INSERT INTO clients (child_name, stage, submitted_at, assigned_bcba_name)
     VALUES ($1,'active',now()::text,$2)`, [child, bcba]);
  await add("Roster Kid One", "Marissa Gaut");
  await add("Roster Kid Two", "Marissa Gaut");
  await add("Roster Kid Three", "Marissa Gauthier");

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForSelector('#login-form input[name="email"]', { timeout: 15000 });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', "TestOwner123!");
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(2000);

  const open = async () => {
    await page.evaluate(() => { location.hash = "#/dashboard"; });
    await page.waitForTimeout(700);
    await page.evaluate(() => { location.hash = "#/bcba-migration"; });
    await page.waitForFunction(() => {
      const b = document.getElementById("mig-dupes");
      return b && b.textContent.trim().length > 0;
    }, null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(900);
  };
  await open();

  console.log("\n== The caseload board really does show her twice ==");
  // The premise, proved rather than assumed: if this passes, the panel saying
  // "nothing looks duplicated" was wrong about something real.
  const board = await page.evaluate(async () => {
    const r = await fetch("/api/caseload/bcbas", { credentials: "include" });
    return (await r.json()).bcbas.filter((b) => /^Marissa/.test(b.name));
  });
  check("TWO ENTRIES, ONE PERSON, CLIENTS SPLIT BETWEEN THEM",
    board.length === 2 && board.every((b) => b.clients > 0), board);

  console.log("\n== The panel no longer says there is nothing wrong ==");
  const text = await page.innerText("#mig-dupes");
  check("it does not claim everything is spelled one way",
    !/Every BCBA, Student Analyst and Squad Leader is spelled one way/.test(text), text.slice(0, 300));
  // The never-a-dead-end property, and the one that actually matters: whatever
  // the matcher did or did not spot, what is on file is on the screen.
  check("EVERY NAME ON FILE IS LISTED, independently of what matched",
    /every name on file/i.test(text), text.slice(0, 400));

  console.log("\n== Both spellings are on the screen, with their counts ==");
  check("the spelling used twice is listed", /Marissa Gaut\b/.test(text), text.slice(0, 600));
  check("AND SO IS THE ONE THE MATCHER MISSED", /Marissa Gauthier/.test(text), text.slice(0, 600));
  check("with the caseload counts that make the split obvious",
    /Marissa Gaut\s*2/.test(text) || /Marissa Gauthier\s*1/.test(text), text.slice(0, 800));
  check("and the group is raised as a question a person has to settle",
    /share the first name/i.test(text), text.slice(0, 800));

  console.log("\n== An admin can merge the pair themselves ==");
  const sel = '[data-mm-from="assigned_bcba_name"]';
  check("there is a picker for the wrong spelling", await page.locator(sel).count() === 1);
  check("and one for the right spelling", await page.locator('[data-mm-to="assigned_bcba_name"]').count() === 1);
  await page.selectOption(sel, "Marissa Gauthier");
  await page.selectOption('[data-mm-to="assigned_bcba_name"]', "Marissa Gaut");
  await page.click('[data-manual-merge="assigned_bcba_name"]');
  await page.waitForFunction(() => {
    const m = document.querySelector('[data-mm-msg="assigned_bcba_name"]');
    return m && m.textContent.trim().length > 0;
  }, null, { timeout: 15000 }).catch(() => {});
  const msg = await page.innerText('[data-mm-msg="assigned_bcba_name"]');
  check("it reports what moved", /Moved 1 client onto Marissa Gaut/.test(msg), msg);

  const after = await page.evaluate(async () => {
    const r = await fetch("/api/caseload/bcbas", { credentials: "include" });
    return (await r.json()).bcbas.filter((b) => /^Marissa/.test(b.name));
  });
  check("SHE IS ONE ENTRY ON THE BOARD NOW", after.length === 1, after);
  check("carrying all three clients", after[0] && after[0].clients === 3, after);
  const row = (await pool.query(
    "SELECT COUNT(*)::int AS n FROM clients WHERE TRIM(assigned_bcba_name) = 'Marissa Gauthier'")).rows[0];
  check("and nothing is left on the old spelling", row.n === 0, row);

  console.log("\n== Merging into itself is refused at the screen, not the server ==");
  await open();
  await page.selectOption('[data-mm-from="assigned_bcba_name"]', "Marissa Gaut");
  await page.selectOption('[data-mm-to="assigned_bcba_name"]', "Marissa Gaut");
  await page.click('[data-manual-merge="assigned_bcba_name"]');
  await page.waitForTimeout(700);
  check("it says so plainly rather than making a pointless round trip",
    /same name/i.test(await page.innerText('[data-mm-msg="assigned_bcba_name"]')),
    await page.innerText('[data-mm-msg="assigned_bcba_name"]'));

  console.log("\n== And once there is nothing left to match, it still shows the roster ==");
  // The exact state that produced the report. Before this change the panel went
  // to a single sentence saying everything was spelled one way; now it names
  // what it looked for, says that finding nothing is not proof of nothing, and
  // still lists every name with its count.
  const settled = await page.innerText("#mig-dupes");
  check("the roster is still there when no suggestion is",
    /every name on file/i.test(settled), settled.slice(0, 400));
  check("and she reads as one person", /Marissa Gaut\b/.test(settled) && !/Marissa Gauthier/.test(settled),
    settled.slice(0, 500));

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  if (failures.length) { console.log("\n--- failures ---"); failures.forEach((f) => console.log(f)); }
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
