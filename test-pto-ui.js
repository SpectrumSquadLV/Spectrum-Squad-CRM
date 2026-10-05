// The PTO admin audit view.
//
// The policy asks for an administrator to be able to see, per employee, the
// hire date, the 90-day date, the accrual start, billable and non-billable
// hours since eligibility, the total, gross earned, used, adjustments and the
// balance -- and then to open one person and see the transactions underneath.
//
// Two things here are not cosmetic:
//
//   * THE RECALCULATION MUST BE SHOWN BEFORE IT RUNS. The screen previews and
//     writes nothing until a second, deliberate click against a list of who
//     moves and by how much.
//   * A LEDGER THAT WAS NEVER BUILT MUST NOT READ AS A BALANCE OF ZERO. Those
//     are different facts and an administrator acting on the wrong one would
//     tell somebody they have no leave when nobody has calculated it yet.
"use strict";
const { chromium } = require("playwright");
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3011";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
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

  await pool.query("DELETE FROM hr_employees WHERE name LIKE 'PTOUI %'").catch(() => {});
  const emp = (await pool.query(
    `INSERT INTO hr_employees (name, email, role_title, hr_hire_date, status)
     VALUES ('PTOUI Ada Reyes', 'ptoui.ada@example.invalid', 'BCBA', '2025-11-01', 'active') RETURNING id`)).rows[0].id;
  const newHire = (await pool.query(
    `INSERT INTO hr_employees (name, email, role_title, hr_hire_date, status)
     VALUES ('PTOUI New Starter', 'ptoui.new@example.invalid', 'RBT', $1, 'active') RETURNING id`,
    [new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10)])).rows[0].id;
  for (const [d, b, nb] of [["2026-06-01", 30, 10], ["2026-06-02", 25, 5]]) {
    await pool.query(
      `INSERT INTO rethink_provider_day (rethink_staff_id, day, month, employee_id, billable_hours, nonbillable_hours, computed_at)
       VALUES ($1, $2, $3, $4, $5, $6, now()::text) ON CONFLICT (rethink_staff_id, day) DO NOTHING`,
      [`ptoui-${emp}`, d, d.slice(0, 7), emp, b, nb]);
  }

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForSelector('#login-form input[name="email"]', { timeout: 15000 });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', "TestOwner123!");
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(1800);
  await page.evaluate(() => { location.hash = "#/pto"; });
  await page.waitForSelector("table", { timeout: 20000 });
  await page.waitForTimeout(1200);

  const view = (await page.innerText("#view-mount")).replace(/\s+/g, " ");
  // innerText, deliberately, not innerHTML: it returns what is RENDERED. A
  // column clipped off the edge by an overflow:hidden container is in the
  // markup and invisible to the administrator, and this suite caught exactly
  // that when the table grew to eight columns.

  console.log("\n== The columns the policy names ==");
  // Read as a LIST OF COLUMNS rather than as a regex over the page text.
  // Concatenated cell text has no separators -- "Gross earned" + "Used"
  // reads as "earnedUsed" -- so a word-boundary match silently fails on a
  // column that is plainly there. Asserting the headings themselves is both
  // immune to that and a truer statement of what is being claimed.
  const headers = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#view-mount thead th")).map((t) => t.textContent.trim()));
  for (const want of ["Hired / +90 days", "Accrual starts", "Eligible hours worked",
                      "Gross earned", "Used", "Adjustments", "Balance"]) {
    check(`the table has a "${want}" column`, headers.includes(want), headers);
  }
  check("and they are in a readable order, identity first and the balance last",
    headers[0] === "Staff" && headers[headers.length - 1] === "Balance", headers);

  console.log("\n== And the figures behind them ==");
  check("the hire date is on the row", /2025-11-01/.test(view), view.slice(0, 900));
  check("THE ACCRUAL START IS 1 MARCH 2026, not the hire date and not hire+90",
    /2026-03-01/.test(view), view.slice(0, 900));
  check("and the row says why in words", /policy began/i.test(view), view.slice(0, 900));
  check("BILLABLE AND NON-BILLABLE ARE BROKEN OUT, not just a total",
    /billable/i.test(view) && /non-billable/i.test(view), view.slice(0, 900));
  check("somebody inside their first 90 days is shown as not yet accruing, not as an error",
    /Not yet accruing/i.test(view), view.slice(0, 1200));

  console.log("\n== The working behind one balance ==");
  check("every row offers a way to see it", await page.locator(".pto-audit").count() >= 1);
  await page.click(`.pto-audit[data-id="${emp}"]`);
  await page.waitForSelector(".modal-backdrop", { timeout: 10000 });
  await page.waitForTimeout(600);
  let modal = (await page.innerText(".modal-backdrop")).replace(/\s+/g, " ");
  check("A LEDGER THAT WAS NEVER BUILT SAYS SO — it does not read as a balance of zero",
    /not a balance of zero/i.test(modal), modal.slice(0, 500));
  await page.evaluate(() => { const b = document.querySelector(".modal-backdrop .close-btn"); if (b) b.click(); });
  await page.waitForTimeout(400);

  console.log("\n== Recalculating: shown before it runs ==");
  check("there is a recalculate button", await page.locator("#pto-preview").count() === 1);
  await page.click("#pto-preview");
  await page.waitForSelector("#pto-apply", { timeout: 20000 });
  const prev = (await page.innerText(".modal-backdrop")).replace(/\s+/g, " ");
  check("IT SAYS NOTHING HAS CHANGED YET", /Nothing has changed yet/i.test(prev), prev.slice(0, 400));
  check("and shows what each balance would become", /Becomes/i.test(prev) && /Change/i.test(prev), prev.slice(0, 500));
  check("naming the accrual start it would use", /2026-03-01/.test(prev), prev.slice(0, 700));

  const beforeRows = (await pool.query("SELECT COUNT(*)::int AS n FROM pto_ledger WHERE employee_id = $1", [emp])).rows[0].n;
  check("THE PREVIEW WROTE NOTHING TO THE LEDGER", beforeRows === 0, beforeRows);

  await page.click("#pto-apply");
  await page.waitForFunction(() => /Done\.|Could not/.test(document.querySelector("#pto-apply-res").textContent),
    null, { timeout: 30000 });
  const applied = (await page.innerText("#pto-apply-res")).replace(/\s+/g, " ");
  check("applying reports a batch id to quote for an undo", /Done\./.test(applied) && /batch-/.test(applied), applied);
  const afterRows = (await pool.query("SELECT COUNT(*)::int AS n FROM pto_ledger WHERE employee_id = $1", [emp])).rows[0].n;
  check("and the ledger now has rows", afterRows >= 1, afterRows);
  await page.evaluate(() => { const b = document.querySelector(".modal-backdrop .close-btn"); if (b) b.click(); });
  await page.waitForTimeout(1500);

  console.log("\n== Now the working reads back ==");
  await page.click(`.pto-audit[data-id="${emp}"]`);
  await page.waitForSelector(".modal-backdrop table", { timeout: 10000 });
  modal = (await page.innerText(".modal-backdrop")).replace(/\s+/g, " ");
  check("the transactions are listed", /ACCRUAL/i.test(modal), modal.slice(0, 500));
  check("with the eligible hours that produced them", /70 h|70h/.test(modal.replace(/\s/g, " ")), modal.slice(0, 700));
  check("the rate applied", /0\.038/.test(modal), modal.slice(0, 700));
  check("a running balance", /Balance/i.test(modal));
  check("AND WHERE THE HOURS CAME FROM, so the figure can be traced to its source",
    /rethink_provider_day/.test(modal), modal.slice(0, 900));
  check("the header repeats the eligibility rule rather than making it be remembered",
    /accrual starts/i.test(modal) && /2026-03-01/.test(modal), modal.slice(0, 400));

  // The balance column is the one anybody opens this screen for, so its
  // visibility gets asserted on its own rather than only as one of seven.
  const balBox = await page.evaluate(() => {
    const ths = Array.from(document.querySelectorAll("#view-mount th"));
    const th = ths.filter((t) => t.textContent.trim() === "Balance")[0];
    if (!th) return null;
    const r = th.getBoundingClientRect();
    const host = th.closest("div");
    const hr = host ? host.getBoundingClientRect() : null;
    return { right: Math.round(r.right), width: Math.round(r.width), hostRight: hr ? Math.round(hr.right) : null,
             scrollable: host ? host.scrollWidth > host.clientWidth + 1 : false };
  });
  check("the balance column is on the screen at desk width", !!balBox && balBox.width > 0, balBox);

  // THE CASE THAT ACTUALLY BREAKS. At 1600px an eight-column table fits, so a
  // clipping container is indistinguishable from a scrolling one. The bug only
  // appears on a narrower window -- which is most windows -- so the assertion
  // has to go there. With overflow:hidden the right-hand columns are cut off
  // with no scrollbar to bring them back, and Balance is the first to go.
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForTimeout(500);
  const narrow = await page.evaluate(() => {
    const ths = Array.from(document.querySelectorAll("#view-mount thead th"));
    const th = ths.filter((t) => t.textContent.trim() === "Balance")[0];
    if (!th) return null;
    const host = th.closest("div");
    const cs = host ? getComputedStyle(host) : null;
    return {
      overflowX: cs ? cs.overflowX : null,
      tableWider: host ? host.scrollWidth > host.clientWidth + 1 : false,
      reachable: cs ? ["auto", "scroll"].includes(cs.overflowX) : false,
    };
  });
  check("ON A NARROW WINDOW THE TABLE IS WIDER THAN ITS BOX, as the audit view must be",
    !!narrow && narrow.tableWider, narrow);
  check("SO THE BOX SCROLLS RATHER THAN CLIPPING THE BALANCE AWAY",
    !!narrow && narrow.reachable, narrow);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForTimeout(400);

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await pool.query("DELETE FROM pto_ledger WHERE employee_id = ANY($1::int[])", [[emp, newHire]]).catch(() => {});
  await pool.query("DELETE FROM hr_employees WHERE name LIKE 'PTOUI %'").catch(() => {});
  if (failures.length) { console.log("\n--- failures ---"); failures.forEach((f) => console.log(f)); }
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  await pool.end();
  process.exit(fail ? 1 : 0);
})();
