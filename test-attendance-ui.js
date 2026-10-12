// test-attendance-ui.js -- the Staff Attendance page and the staff-card section.
//
// The scoring is covered by test-attendance-matrix.js. This covers the half
// that was actually missing before: a way in. Attendance had no nav entry at
// all, so the only way to see it was to open staff cards one at a time.
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3009";
const OWNER_PW = process.env.OWNER_PASSWORD || "TestOwner123!";
const STAFF_PW = process.env.STAFF_PASSWORD || "TestStaff123!";

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail ? "\n          -> " + String(detail).slice(0, 400) : "")); }
  };
  const section = (t) => console.log("\n== " + t + " ==");

  async function signIn(email, password) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector('#login-form input[name="email"]', { timeout: 20000 });
    await page.fill('#login-form input[name="email"]', email);
    await page.fill('#login-form input[name="password"]', password);
    await page.click('#login-form button[type="submit"]');
    await page.waitForTimeout(2800);
    return { page, errors };
  }
  const api = (page, p, o) => page.evaluate(async ({ p, o }) => {
    const r = await fetch(p, {
      method: (o && o.method) || "GET", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: o && o.body ? JSON.stringify(o.body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { p, o });

  const { page: owner, errors: ownerErrors } = await signIn("admin@spectrumsquadlv.com", OWNER_PW);
  check("owner signs in", await owner.locator(".sidebar").isVisible().catch(() => false));

  const stamp = Date.now().toString().slice(-6);
  const daysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

  const emp = await api(owner, "/api/hr/employees", {
    method: "POST",
    body: { name: "UI Attend " + stamp, email: `uiatt.${stamp}@example.invalid`, role_title: "RBT", status: "active", hire_date: daysAgo(300) },
  });
  const empId = emp.body.id || (emp.body.employee && emp.body.employee.id);
  check("created a staff member", !!empId, emp.body);
  await api(owner, `/api/attendance/employee/${empId}`, { method: "POST", body: { type_key: "left_early", incident_date: daysAgo(4), notify: false } });
  await api(owner, `/api/attendance/employee/${empId}`, { method: "POST", body: { type_key: "calloff_gt4", incident_date: daysAgo(2), notify: false } });
  // 2.0 + 1.0 + 1.0 = 4.0, which is exactly the coaching line under the policy
  // as it stands. It was 3.0 against the old ladder; keeping it at 3.0 would
  // have left this screen tested only against a good month, and the roster
  // tile and the points chip both exist for the other kind.
  //
  // 4.0 rather than 5.0 on purpose: the 90-day discipline ladder is a
  // separate thing this policy change did not touch, and 5.0 would have
  // pushed this person from Verbal reminder to Written warning and broken an
  // assertion that is not about the monthly matrix at all.
  await api(owner, `/api/attendance/employee/${empId}`, { method: "POST", body: { type_key: "calloff_gt4", incident_date: daysAgo(6), notify: false } });

  // ---------------- the nav ----------------
  section("A way in");

  // Asked of the DOM, not of the visible text. The sidebar is grouped now, so
  // Staff Attendance sits inside a collapsed group and innerText does not
  // include it -- and the permission check further down was the real casualty:
  // reading visible text, it would have started passing because the entry was
  // HIDDEN rather than because it was absent, which is a permission test that
  // no longer tests the permission.
  const navEntry = await owner.locator('.sidebar nav [data-nav="attendance"]').count();
  check("there is a Staff Attendance nav entry (there was none at all before)", navEntry === 1, navEntry);

  await owner.evaluate(() => { location.hash = "#/attendance"; });
  await owner.waitForTimeout(3000);
  let page = await owner.locator("#view-mount").innerText();
  check("the page renders", /Staff Attendance/i.test(page), page.slice(0, 200));
  check("it explains the two windows", /rolling 90 days/i.test(page) && /30 days/i.test(page), page.slice(0, 400));

  // ---------------- the roster ----------------
  section("The roster");

  check("our staff member is on it", new RegExp("UI Attend " + stamp).test(page), page.slice(0, 600));
  check("with their 30-day points", /\b4\b/.test(page));
  check("and a monthly review level", /Coaching Conversation/i.test(page), page.slice(0, 800));
  check("and a standing", /Good standing/i.test(page), page.slice(0, 800));
  check("the tiles summarise the roster", /Staff tracked/i.test(page) && /On track for the bonus/i.test(page));
  check("unsigned acknowledgments are surfaced", /Unsigned acknowledgments/i.test(page));

  const rowCount = await owner.locator(".att-row").count();
  check("every active staff member has a row", rowCount >= 1, rowCount);

  // ---------------- the matrix editor ----------------
  section("The attendance matrix");

  await owner.locator("#att-matrix-btn").click();
  await owner.waitForTimeout(1500);
  const modal = owner.locator(".modal-backdrop").last();
  let mtext = await modal.innerText();
  check("the matrix opens", /Attendance matrix/i.test(mtext), mtext.slice(0, 200));
  check("it is dated to the policy", /2026-06-01/.test(mtext), mtext.slice(0, 300));
  check("it lists the occurrences", /No Call\/No Show/i.test(mtext) && /Leaving Early/i.test(mtext), mtext.slice(0, 700));
  check("and the earn-backs", /Perfect attendance \(30 days\)/i.test(mtext) && /last-minute shift/i.test(mtext));
  check("it warns that logged occurrences keep their points",
    /keep the points they were given/i.test(mtext), mtext.slice(0, 700));
  const inputs = await modal.locator("[data-mx]").count();
  check("every matrix line is editable", inputs === 13, inputs);
  await modal.locator(".close-btn").click();
  await owner.waitForTimeout(600);

  // ---------------- logging from the staff card ----------------
  section("Logging an occurrence from the staff card");

  await owner.evaluate(() => { document.querySelectorAll(".modal-backdrop").forEach((b) => b.remove()); location.hash = "#/staff"; });
  await owner.waitForTimeout(2600);
  await owner.evaluate((id) => openStaffModal(id), empId);
  await owner.waitForTimeout(2800);
  const card = owner.locator(".modal-backdrop").last();
  const att = card.locator("#staff-attendance");
  check("the staff card has an attendance section", (await att.count()) === 1);
  let atext = await att.innerText();
  check("it shows their points rather than a bare flag count", /30-day points/i.test(atext), atext.slice(0, 300));
  // This staff member is carrying 4.0 rolling points: a Coaching Conversation
  // on the monthly matrix and STILL GOOD STANDING on the 90-day ladder.
  //
  // That pairing is the point of moving the ladder. Before, 4.0 rolling was a
  // filed verbal reminder, so somebody could collect formal discipline in the
  // same breath as being told a conversation was needed. The conversation now
  // comes first, and this screen is where you would see it.
  check("and their standing", /Good standing/i.test(atext), atext.slice(0, 300));
  check("and their bonus position", /Bonus/i.test(atext), atext.slice(0, 300));
  // The points chip is amber for a month that needs a conversation and green
  // for one that does not, and the colour comes from the server's verdict
  // rather than being re-derived in the browser from a threshold somebody
  // would have to remember to update. At 4.0 this person is amber.
  const chipTone = await owner.evaluate(() => {
    const el = [...document.querySelectorAll(".tag")].find((t) => /30-day points/i.test(t.textContent));
    return el ? el.getAttribute("style") || "" : null;
  });
  check("AT 4 POINTS THE CHIP IS AMBER, from the server's own verdict",
    chipTone && /fef3c7/i.test(chipTone), chipTone);

  // AND THE CASE THAT SEPARATES THE TWO WAYS OF DECIDING IT.
  //
  // At 4.0 the server's verdict and the old hardcoded "points >= 1.5" agree,
  // so that assertion alone proves nothing about which one the screen is
  // using. Somebody at 2.0 is a good month under the policy as it now stands
  // and a warning under the old threshold -- so this is the person whose
  // chip colour says where the line is actually being read from.
  const okEmp = await api(owner, "/api/hr/employees", { method: "POST", body: {
    name: "UI Attend Fine " + stamp, email: `ui.fine.${stamp}@example.invalid`,
    role_title: "RBT", status: "active", hire_date: daysAgo(400) } });
  const okId = okEmp.body.id || (okEmp.body.employee && okEmp.body.employee.id);
  await api(owner, `/api/attendance/employee/${okId}`, { method: "POST", body: {
    type_key: "left_early", incident_date: daysAgo(5), notify: false } });
  await owner.evaluate(() => { document.querySelectorAll(".modal-backdrop").forEach((b) => b.remove()); });
  await owner.waitForTimeout(600);
  await owner.evaluate((id) => openStaffModal(id), okId);
  await owner.waitForTimeout(2800);
  const okCard = owner.locator(".modal-backdrop").last();
  const okText = await okCard.locator("#staff-attendance").innerText();
  check("they are carrying 2 points", /\b2\b/.test(okText), okText.slice(0, 200));
  check("which the policy calls Meets Expectations",
    /Meets Expectations/i.test(okText), okText.slice(0, 300));
  const okTone = await owner.evaluate(() => {
    const el = [...document.querySelectorAll(".tag")].find((t) => /30-day points/i.test(t.textContent));
    return el ? el.getAttribute("style") || "" : null;
  });
  check("AT 2 POINTS THE CHIP IS GREEN — under the old 1.5 line it would be"
    + " amber, so this is what proves the colour follows the policy",
    okTone && /dcfce7/i.test(okTone), okTone);
  await owner.evaluate(() => { document.querySelectorAll(".modal-backdrop").forEach((b) => b.remove()); });
  await owner.waitForTimeout(400);
  await owner.evaluate((id) => openStaffModal(id), empId);
  await owner.waitForTimeout(2600);
  check("each occurrence shows what it cost", /\+2 pts|\+2\.0 pts/.test(atext) || /pts/.test(atext), atext.slice(0, 500));

  await att.locator("#att-add-btn").click();
  await owner.waitForTimeout(900);
  atext = await att.innerText();
  check("the form offers matrix occurrence types", (await att.locator("#att-type option").count()) >= 13,
    await att.locator("#att-type option").count());
  check("it asks for shift start and time notified", (await att.locator("#att-shift").count()) === 1 && (await att.locator("#att-notified").count()) === 1);
  check("it offers emergency and documentation", (await att.locator("#att-emerg").count()) === 1 && (await att.locator("#att-doc").count()) === 1);
  check("and whether to email the staff member", (await att.locator("#att-notify").count()) === 1);

  await att.locator("#att-type").selectOption("late");
  await att.locator("#att-shift").fill("8:00 AM");
  await att.locator("#att-notified").fill("8:30 AM");
  await att.locator("#att-notify").uncheck();
  await att.locator("#att-notes").fill("slept in " + stamp);
  await att.locator("#att-save").click();
  await owner.waitForTimeout(2800);

  const after = await api(owner, `/api/attendance/employee/${empId}`);
  check("the occurrence saved", (after.body.flags || []).some((f) => (f.notes || "").includes("slept in " + stamp)), (after.body.flags || []).map((f) => f.notes));
  const late = (after.body.flags || []).find((f) => (f.notes || "").includes("slept in " + stamp));
  check("it took its points from the matrix", Number(late.points) === 0.5, late.points);
  check("notice hours were computed as negative (told us after the shift started)", Number(late.notice_hours) === -0.5, late.notice_hours);
  check("the running total went up", after.body.score.points_30 === 4.5, after.body.score.points_30);

  // ---- THE 90-DAY CHIP, both ways round -------------------------------
  //
  // It takes two cases to say where this colour comes from. At 4.5 rolling
  // this person is still Good standing, so the chip is GREEN -- under the old
  // hardcoded "points_90 >= 3" it would be red. And somebody actually on the
  // ladder has to come back RED, or a chip that is always green would pass
  // the first case on its own.
  const ninetyTone = await owner.evaluate(() => {
    const el = [...document.querySelectorAll(".tag")].find((t) => /90-day points/i.test(t.textContent));
    return el ? el.getAttribute("style") || "" : null;
  });
  check("AT 4.5 ROLLING THE 90-DAY CHIP IS GREEN — the ladder now starts above"
    + " the coaching line, and the colour follows it",
    ninetyTone && /dcfce7/i.test(ninetyTone), ninetyTone);

  const badEmp = await api(owner, "/api/hr/employees", { method: "POST", body: {
    name: "UI Attend Ladder " + stamp, email: `ui.ladder.${stamp}@example.invalid`,
    role_title: "RBT", status: "active", hire_date: daysAgo(400) } });
  const badId = badEmp.body.id || (badEmp.body.employee && badEmp.body.employee.id);
  // 2.0 x3 + 1.0 = 7.0, all outside the 30-day window so only the rolling
  // ladder is in play: a Written warning, and the caseload flagged.
  for (const d of [80, 75, 70]) {
    await api(owner, `/api/attendance/employee/${badId}`, { method: "POST", body: {
      type_key: "left_early", incident_date: daysAgo(d), notify: false } });
  }
  await api(owner, `/api/attendance/employee/${badId}`, { method: "POST", body: {
    type_key: "calloff_gt4", incident_date: daysAgo(65), notify: false } });
  await owner.evaluate(() => { document.querySelectorAll(".modal-backdrop").forEach((b) => b.remove()); });
  await owner.waitForTimeout(600);
  await owner.evaluate((id) => openStaffModal(id), badId);
  await owner.waitForTimeout(2800);
  const badText = await owner.locator(".modal-backdrop").last().locator("#staff-attendance").innerText();
  check("they are at 7 rolling points", /\b7\b/.test(badText), badText.slice(0, 200));
  check("which is a Written warning", /Written warning/i.test(badText), badText.slice(0, 300));
  const badTone = await owner.evaluate(() => {
    const el = [...document.querySelectorAll(".tag")].find((t) => /90-day points/i.test(t.textContent));
    return el ? el.getAttribute("style") || "" : null;
  });
  check("AND THEIR 90-DAY CHIP IS RED — a chip that is always green would have"
    + " passed the case above on its own",
    badTone && /fee2e2/i.test(badTone), badTone);

  // ---------------- permissions ----------------
  section("Who can see it");

  const { page: staff, errors: staffErrors } = await signIn("clinical@spectrumsquadlv.com", STAFF_PW);
  const staffNavEntry = await staff.locator('.sidebar nav [data-nav="attendance"]').count();
  check("a clinical user gets no Staff Attendance nav entry", staffNavEntry === 0, staffNavEntry);
  await staff.evaluate(() => { location.hash = "#/attendance"; });
  await staff.waitForTimeout(2600);
  const staffView = await staff.locator("#view-mount").innerText();
  check("and typing the URL does not show them the roster",
    !/Staff tracked/i.test(staffView), staffView.slice(0, 250));

  section("no broken pages");
  check("no uncaught JavaScript errors for the owner", ownerErrors.length === 0, ownerErrors.join(" | "));
  check("no uncaught JavaScript errors for staff", staffErrors.length === 0, staffErrors.join(" | "));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\nFATAL:", e); process.exit(2); });
