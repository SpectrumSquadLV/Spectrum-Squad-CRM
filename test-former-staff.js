// Somebody who has left is not on the team.
//
// Reported as "terminated employees should no longer show". The assign-to
// picker was fixed first; this is the other half, and the bigger one: the
// Staff directory listed EVERY record that had ever existed, so people who
// left months ago sat among the current team indefinitely.
//
// THE WHOLE DIFFICULTY HERE IS THAT "NO LONGER SHOW" CANNOT MEAN "GONE".
//
//   * HR needs the record. Documents, certifications, timecards, termination
//     reason and date all hang off it, and the turnover report is COMPUTED
//     from terminated rows -- filtering them out of the API would empty it.
//   * The directory is where a status is SET. Marking somebody terminated by
//     mistake and having them vanish from the only screen that can undo it is
//     a worse bug than the one being fixed. That exact mistake was made on the
//     billable report earlier in this session, in the query, and CI caught it.
//
// So the rule is: hidden from the everyday list, counted so nobody wonders
// where they went, one click away, and untouched underneath.
const { chromium } = require("playwright");
const { Pool } = require("pg");

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  let pass = 0, fail = 0;
  const failures = [];
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else {
      const line = "  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : "");
      fail++; failures.push(line); console.log(line);
    }
  };
  const BASE = process.env.BASE || "http://localhost:3009";
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

  const HERE = "Zz Still Here";
  const GONE = "Zz Has Left";
  await pool.query(
    `INSERT INTO hr_employees (name, email, role_title, status) VALUES
       ($1, 'zz.here@example.invalid', 'RBT', 'active'),
       ($2, 'zz.left@example.invalid', 'RBT', 'terminated')`, [HERE, GONE]);

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForSelector('#login-form input[name="email"]', { timeout: 15000 });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', "TestOwner123!");
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(1800);

  const openStaff = async () => {
    await page.goto(BASE + "/#/staff", { waitUntil: "networkidle" });
    await page.waitForTimeout(1800);
    return page.innerText("#view-mount");
  };

  console.log("\n== The directory is the current team ==");
  let text = await openStaff();
  check("somebody still employed is listed", text.includes(HERE), text.slice(0, 400));
  check("SOMEBODY WHO HAS LEFT IS NOT", !text.includes(GONE), text.slice(0, 600));
  check("and the page says how many are hidden, rather than losing them quietly",
    /Show \d+ former staff member/.test(text), text.slice(0, 500));

  console.log("\n== They are one click away, not gone ==");
  await page.check("#staff-show-former");
  await page.waitForTimeout(1600);
  text = await page.innerText("#view-mount");
  check("ticking the box brings them back", text.includes(GONE), text.slice(0, 500));
  check("with their status on the row, so it is obvious why they were hidden",
    /terminated/i.test(text), text.slice(0, 600));
  check("and the current team is still there beside them", text.includes(HERE));

  console.log("\n== The record itself is untouched ==");
  // The failure this guards against is the one made on the billable report
  // earlier today: filtering in the QUERY also removes the row from every
  // other thing that reads it.
  const api = await page.evaluate(async () => {
    const r = await fetch("/api/hr/employees", { credentials: "include" });
    return (await r.json()).map((e) => ({ name: e.name, status: e.status }));
  });
  check("THE API STILL RETURNS THEM -- the filter is on the screen, not the data",
    api.some((e) => e.name === "Zz Has Left" && e.status === "terminated"), api.filter((e) => /^Zz /.test(e.name)));
  const row = (await pool.query(
    "SELECT status FROM hr_employees WHERE name = $1", [GONE])).rows[0];
  check("and the row is exactly as it was", !!row && row.status === "terminated", row);

  console.log("\n== Turnover still counts them, which is the point of keeping them ==");
  const turnover = await page.evaluate(async () => {
    const r = await fetch("/api/hr/turnover", { credentials: "include" });
    return { status: r.status, data: await r.json().catch(() => null) };
  });
  check("the turnover report loads", turnover.status === 200, turnover.status);
  check("A REPORT COMPUTED FROM LEAVERS IS NOT EMPTIED BY HIDING THEM",
    !!turnover.data && typeof turnover.data === "object", turnover.data);

  console.log("\n== And they cannot be handed work ==");
  const pickable = await page.evaluate(async () => {
    const r = await fetch("/api/staff", { credentials: "include" });
    return (await r.json()).map((s) => s.name);
  });
  check("a leaver is not in the assign-to picker", !pickable.includes(GONE), pickable.filter((n) => /^Zz /.test(n)));
  check("somebody still here is", pickable.includes(HERE), pickable.filter((n) => /^Zz /.test(n)));

  check("no page errors", errors.length === 0, errors.join(" | "));
  if (failures.length) { console.log("\n--- failures ---"); failures.forEach((f) => console.log(f)); }
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
