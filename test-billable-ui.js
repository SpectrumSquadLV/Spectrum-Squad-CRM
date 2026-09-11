// test-billable-ui.js -- the Billable Requirements screen, from the browser.
//
// Reported as "I keep putting in 30 hours for Marissa and it's not
// populating". The number saved every time; the screen could not display it.
//
// /api/billable/summary was rewritten from a monthly requirement to a weekly
// one, and the row it returns changed shape with it -- `target_hours` became
// `weekly_target_hours`, `variance` went away (a weekly requirement has no one
// monthly variance), and `appointments` moved onto each week. This screen was
// never re-read against that, so it was still asking for the old names and
// getting `undefined`: an empty box, and a result chip reading "NaN h under".
//
// test-billable.js covers the arithmetic and the refusals over HTTP and passed
// throughout, because every one of those assertions reads the API directly.
// The only place the mismatch was visible was a browser, which is why this
// file exists rather than more cases in that one.
//
//   DATABASE_URL=... node server.js
//   BASE=http://127.0.0.1:3009 node test-billable-ui.js
"use strict";

const { chromium } = require("playwright");
const { Pool } = require("pg");
const BASE = process.env.BASE || "http://localhost:3009";
const OWNER_PW = process.env.OWNER_PASSWORD || "TestOwner123!";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const PERIOD = "2026-05";

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "\n          -> " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : "")); }
  };
  const section = (t) => console.log("\n== " + t + " ==");

  // ---------------------------------------------------------------- fixtures
  const stamp = Date.now().toString().slice(-6);
  const NAME_SET = `ZzBill Sets ${stamp}`;       // the reported case: type a figure, see it stay
  const NAME_MET = `ZzBill Met ${stamp}`;        // clears the weekly figure every week
  const NAME_UNDER = `ZzBill Under ${stamp}`;    // misses it every week
  const NAME_LEGACY = `ZzBill Legacy ${stamp}`;  // only the retired monthly figure

  const mkEmp = async (name, weekly, monthly) => (await pool.query(
    `INSERT INTO hr_employees (name, email, role_title, weekly_billable_target, monthly_billable_target, status, created_at)
     VALUES ($1, $2, 'BCBA', $3, $4, 'active', $5) RETURNING id`,
    [name, `${name.replace(/\s+/g, ".").toLowerCase()}@example.invalid`, weekly, monthly, new Date().toISOString()]
  )).rows[0].id;

  // Monday-based week starts overlapping the period, the same way the server
  // works them out — the boundary weeks are the point of storing days.
  const weekStartsFor = (month) => {
    const [y, m] = month.split("-").map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const startOf = (d) => { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x; };
    const out = [];
    let cur = startOf(new Date(Date.UTC(y, m - 1, 1)));
    const end = new Date(Date.UTC(y, m - 1, lastDay));
    while (cur <= end) { out.push(cur.toISOString().slice(0, 10)); const n = new Date(cur.getTime()); n.setUTCDate(n.getUTCDate() + 7); cur = n; }
    return out;
  };
  const WEEKS = weekStartsFor(PERIOD);

  const giveWeeks = async (empId, perWeek) => {
    for (const ws of WEEKS) {
      await pool.query(
        `INSERT INTO rethink_provider_day
           (rethink_staff_id, day, month, employee_id, billable_hours, nonbillable_hours, unclassified_hours, billable_appointments, computed_at)
         VALUES ($1, $2, $3, $4, $5, 0, 0, 4, now()::text)
         ON CONFLICT (rethink_staff_id, day) DO UPDATE SET billable_hours = EXCLUDED.billable_hours`,
        [`rtui-${empId}`, ws, PERIOD, empId, perWeek]
      );
    }
    await pool.query(
      `INSERT INTO rethink_provider_month (rethink_staff_id, month, employee_id, staff_name_hint, verified_hours, appointment_count, provisional, computed_at)
       VALUES ($1, $2, $3, 'ZzBill hint', $4, 20, FALSE, now()::text)
       ON CONFLICT (rethink_staff_id, month) DO UPDATE SET verified_hours = EXCLUDED.verified_hours`,
      [`rtui-${empId}`, PERIOD, empId, perWeek * WEEKS.length]
    );
  };

  const idSet = await mkEmp(NAME_SET, null, null);
  const idMet = await mkEmp(NAME_MET, 20, null);
  const idUnder = await mkEmp(NAME_UNDER, 25, null);
  const idLegacy = await mkEmp(NAME_LEGACY, null, 100);
  await giveWeeks(idMet, 25);
  await giveWeeks(idUnder, 12);
  await pool.query(
    `INSERT INTO rethink_sync_log (kind, month, status, finished_at) VALUES ('supervision_hours', $1, 'success', now()::text)`,
    [PERIOD]
  );

  // ---------------------------------------------------------------- sign in
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('#login-form input[name="email"]', { timeout: 20000 });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', OWNER_PW);
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(2500);

  const openBillable = async () => {
    await page.goto(`${BASE}/#/billable`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    const monthEl = await page.$("#bill-month");
    if (monthEl) {
      await page.evaluate((m) => {
        const el = document.querySelector("#bill-month");
        el.value = m;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, PERIOD);
      await page.waitForTimeout(1500);
    }
    // Ticked through the DOM rather than with .check(): the handler re-renders
    // the whole table, so Playwright's post-click verification looks for an
    // element that has already been replaced.
    await page.evaluate(() => {
      const el = document.querySelector("#bill-show-all");
      if (el && !el.checked) { el.checked = true; el.dispatchEvent(new Event("change", { bubbles: true })); }
    });
    await page.waitForTimeout(600);
  };
  const boxFor = async (id) => page.$(`[data-target-for="${id}"]`);
  const rowTextFor = async (id) => page.evaluate((eid) => {
    const input = document.querySelector(`[data-target-for="${eid}"]`);
    return input ? input.closest("tr").innerText : null;
  }, id);

  await openBillable();

  // ================================================================
  section("The requirement you type is the requirement you see");

  const setBox = await boxFor(idSet);
  check("the screen renders a box to put a requirement in", !!setBox);
  check("and it starts empty for somebody who has none", (await setBox.inputValue()) === "");

  await setBox.fill("30");
  await setBox.dispatchEvent("change");
  await page.waitForTimeout(1800);

  const savedServerSide = (await pool.query(
    "SELECT weekly_billable_target FROM hr_employees WHERE id = $1", [idSet])).rows[0].weekly_billable_target;
  check("30 reaches the staff record", Number(savedServerSide) === 30, savedServerSide);

  // THE REPORTED BUG. The value above was saved before this fix too; the box
  // came back empty because the screen was reading a field name the API had
  // stopped sending, so it read as though nothing had been entered.
  const afterSave = await boxFor(idSet);
  check("and the box still shows 30 after the screen reloads itself",
    afterSave && (await afterSave.inputValue()) === "30",
    afterSave ? await afterSave.inputValue() : "the row disappeared");

  await openBillable();
  const afterReopen = await boxFor(idSet);
  check("it is still there when the page is opened again",
    afterReopen && (await afterReopen.inputValue()) === "30",
    afterReopen ? await afterReopen.inputValue() : "the row disappeared");

  const metBox = await boxFor(idMet);
  check("somebody who already had a requirement shows it too",
    metBox && (await metBox.inputValue()) === "20", metBox ? await metBox.inputValue() : "missing");

  // ================================================================
  section("The screen says the requirement is weekly");

  const pageText = await page.innerText("#view-mount");
  check("the column asks for a weekly requirement", /weekly requirement/i.test(pageText), pageText.slice(0, 300));
  check("and the box is labelled in hours a week", /hours a week/i.test(pageText));
  // Scoped to the screen's own description of the requirement, not the whole
  // page: one row deliberately says "monthly requirement" — the note telling
  // you that record is still on the retired figure, which is checked below.
  const chrome = await page.evaluate(() => {
    const intro = document.querySelector("#view-mount p");
    const head = document.querySelector("#view-mount thead");
    return ((intro && intro.innerText) || "") + " " + ((head && head.innerText) || "");
  });
  check("the screen itself no longer describes the requirement as monthly",
    !/monthly/i.test(chrome), (chrome.match(/.{0,60}monthly.{0,60}/i) || [])[0]);

  // ================================================================
  section("The result reads as weeks, not as a number that was never sent");

  const metRow = await rowTextFor(idMet);
  const underRow = await rowTextFor(idUnder);
  check("somebody who cleared it every week is marked met",
    /met all \d+ weeks?/i.test(metRow || ""), metRow);
  check("somebody who missed it is told how many weeks they met",
    /met 0 of \d+ weeks?/i.test(underRow || ""), underRow);
  check("no result reads NaN or undefined — the old fields are gone",
    !/NaN|undefined/.test(pageText), (pageText.match(/.{0,60}(NaN|undefined).{0,60}/) || [])[0]);
  check("the hours delivered are still shown", /\bh\b/.test(metRow || ""), metRow);

  // ================================================================
  section("A record left on the retired monthly figure says so");

  const legacyRow = await rowTextFor(idLegacy);
  check("it is not silently shown as having no requirement at all",
    /monthly requirement of 100/i.test(legacyRow || ""), legacyRow);
  check("and it says what to do about it",
    /weekly/i.test(legacyRow || ""), legacyRow);

  // ================================================================
  check("no page errors", errors.length === 0, errors.join(" | "));

  await pool.query("DELETE FROM rethink_provider_day WHERE rethink_staff_id LIKE 'rtui-%'").catch(() => {});
  await pool.query("DELETE FROM rethink_provider_month WHERE rethink_staff_id LIKE 'rtui-%'").catch(() => {});
  await pool.query("DELETE FROM hr_employees WHERE name LIKE 'ZzBill %'").catch(() => {});

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("SUITE ERROR:", e);
  await pool.end().catch(() => {});
  process.exit(1);
});
