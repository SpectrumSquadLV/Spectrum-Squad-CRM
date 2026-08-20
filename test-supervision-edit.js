// Editing and deleting supervision sessions -- including after a month has
// been signed off.
//
// Two things are being proved. First, that a session can be changed or removed
// without hunting for a control that scrolled off the edge of the screen.
// Second, and more important, that correcting a signed month is possible but
// never silent: a signed PDF and two emails already exist saying what the
// record was, so a change has to withdraw the signature and say who changed
// what and why.
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3009";

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + String(detail).slice(0, 300) : "")); }
  };

  // prompt()/confirm() answers, queued per interaction.
  let dialogAnswer = { accept: true, text: "" };
  const dialogsSeen = [];
  page.on("dialog", async (dlg) => {
    dialogsSeen.push({ type: dlg.type(), message: dlg.message() });
    if (dialogAnswer.accept) await dlg.accept(dialogAnswer.text);
    else await dlg.dismiss();
  });

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', "TestOwner123!");
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(2500);

  const month = await page.evaluate(() => {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  });

  // An employee to hang the log off. Any one will do.
  const empId = await page.evaluate(async () => {
    const r = await fetch("/api/hr/employees", { credentials: "include" });
    const list = await r.json().catch(() => null);
    const arr = Array.isArray(list) ? list : (list && list.employees) || [];
    return arr.length ? arr[0].id : null;
  });
  check("found an employee", empId != null, String(empId));
  if (empId == null) { console.log("\n  cannot continue"); await browser.close(); process.exit(1); }

  // Seeding has to start from an unsigned month. A previous run leaves this one
  // signed off, and re-posting identical entries is not a change, so it would
  // not clear the signature -- the fixture would then be fighting the very
  // guard these tests exist to prove. Post an empty month first, which always
  // differs and therefore always withdraws the signature, then post the real
  // fixture into the now-unsigned month.
  const seed = async (entries, signedOff) => {
    await page.evaluate(async ({ empId, month, entries }) => {
      const post = (body) => fetch("/api/supervision/employee/" + empId, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ month, hours_worked: 100, change_reason: "test fixture reset" }, body)),
      });
      await post({ entries: [] });
      await post({ entries });
    }, { empId, month, entries });
    if (signedOff) {
      await page.evaluate(async ({ empId, month }) => {
        await fetch("/api/supervision/employee/" + empId + "/sign-off", {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ month, supervisor_name: "Test BCBA" }),
        });
      }, { empId, month });
    }
  };

  const openEditor = async () => {
    await page.evaluate(() => { document.querySelectorAll(".modal-backdrop").forEach((b) => b.remove()); });
    await page.evaluate(({ empId, month }) => window.HRSupervision.openEditor(empId, month), { empId, month });
    await page.waitForTimeout(1600);
    return page.locator(".modal-backdrop").last();
  };

  const TWO = [
    { date: month + "-05", activity: "Obs — client A", time_in: "9:00a", time_out: "10:00a", duration: 1, face_to_face: true, supervisor: "Test BCBA", observed: true, group: "Individual", notes: "First note" },
    { date: month + "-12", activity: "Obs — client B", time_in: "1:00p", time_out: "2:00p", duration: 1, face_to_face: true, supervisor: "Test BCBA", observed: false, group: "Group", notes: "Second note" },
  ];

  // ============ 1. edit and delete are visible without scrolling sideways ============
  await seed(TWO, false);
  let modal = await openEditor();
  check("two sessions rendered as cards", (await modal.locator(".sup-session").count()) === 2);

  const delBtn = modal.locator("[data-del]").first();
  check("delete is a labelled button, not a bare glyph", (await delBtn.innerText()).trim().toLowerCase() === "delete");
  const fitsHorizontally = await page.evaluate(() => {
    const b = [...document.querySelectorAll("[data-del]")][0];
    const modalEl = b.closest(".modal");
    const br = b.getBoundingClientRect(), mr = modalEl.getBoundingClientRect();
    return br.right <= mr.right + 1 && br.left >= mr.left - 1 && modalEl.scrollWidth <= modalEl.clientWidth + 1;
  });
  check("delete sits inside the modal with no sideways scroll", fitsHorizontally);

  const notesBox = modal.locator("textarea[data-f='notes']").first();
  check("notes is a real textarea", await notesBox.count() > 0);
  await notesBox.fill("Edited note text that is comfortably longer than the old 120px slot allowed.");
  await modal.locator("#sup-save").click();
  await page.waitForTimeout(1200);
  let saved = await page.evaluate(async ({ empId, month }) => {
    const r = await fetch(`/api/supervision/employee/${empId}?month=${month}`, { credentials: "include" });
    return r.json();
  }, { empId, month });
  check("edited note was saved", /comfortably longer/.test(saved.entries[0].notes), saved.entries[0].notes);

  // delete, with the confirm accepted
  dialogAnswer = { accept: true, text: "" };
  modal = await openEditor();
  await modal.locator("[data-del]").first().click();
  await page.waitForTimeout(400);
  check("deleting asks first", dialogsSeen.some((d) => d.type === "confirm" && /Delete/i.test(d.message)), JSON.stringify(dialogsSeen));
  check("one session left in the editor", (await modal.locator(".sup-session").count()) === 1);
  await modal.locator("#sup-save").click();
  await page.waitForTimeout(1200);
  saved = await page.evaluate(async ({ empId, month }) => {
    const r = await fetch(`/api/supervision/employee/${empId}?month=${month}`, { credentials: "include" });
    return r.json();
  }, { empId, month });
  check("delete persisted", saved.entries.length === 1, JSON.stringify(saved.entries.map((e) => e.activity)));

  // a cancelled delete changes nothing
  dialogAnswer = { accept: false, text: "" };
  modal = await openEditor();
  const before = await modal.locator(".sup-session").count();
  await modal.locator("[data-del]").first().click();
  await page.waitForTimeout(400);
  check("cancelling the confirm keeps the session", (await modal.locator(".sup-session").count()) === before);

  // ============ 2. a signed month can be corrected, but not silently ============
  await seed(TWO, true);
  dialogAnswer = { accept: true, text: "" };
  modal = await openEditor();
  const banner = await modal.innerText();
  check("signed month says it is signed", /Signed off by Test BCBA/i.test(banner), banner.slice(0, 200));
  check("signed month says it can still be corrected", /still correct this month/i.test(banner));

  // Saving with nothing changed must not demand a reason.
  dialogsSeen.length = 0;
  await modal.locator("#sup-save").click();
  await page.waitForTimeout(1200);
  check("no-op save on a signed month asks nothing", dialogsSeen.length === 0, JSON.stringify(dialogsSeen));
  let after = await page.evaluate(async ({ empId, month }) => {
    const r = await fetch(`/api/supervision/employee/${empId}?month=${month}`, { credentials: "include" });
    return r.json();
  }, { empId, month });
  check("no-op save leaves the signature in place", after.signed_off === true);

  // A real change must ask, record, and withdraw the signature.
  dialogsSeen.length = 0;
  dialogAnswer = { accept: true, text: "Session on the 12th was logged twice" };
  modal = await openEditor();
  await modal.locator("[data-del]").last().click();   // confirm
  await page.waitForTimeout(300);
  await modal.locator("#sup-save").click();           // prompt for the reason
  await page.waitForTimeout(1500);
  check("correcting a signed month asks what changed",
    dialogsSeen.some((x) => x.type === "prompt" && /What are you correcting/i.test(x.message)), JSON.stringify(dialogsSeen));

  after = await page.evaluate(async ({ empId, month }) => {
    const r = await fetch(`/api/supervision/employee/${empId}?month=${month}`, { credentials: "include" });
    return r.json();
  }, { empId, month });
  check("the correction was applied", after.entries.length === 1, JSON.stringify(after.entries.map((e) => e.activity)));
  check("the signature was withdrawn", after.signed_off === false, "signed_off=" + after.signed_off);
  check("the stale signed PDF is no longer offered", after.has_pdf === false, "has_pdf=" + after.has_pdf);
  check("the reason was recorded", (after.amendments || []).some((a) => /logged twice/i.test(a.reason)), JSON.stringify(after.amendments));
  check("who changed it was recorded", (after.amendments || [])[0] && !!after.amendments[0].changed_by, JSON.stringify(after.amendments));
  check("what it was signed as is remembered", (after.amendments || [])[0] && after.amendments[0].previous_signed_by === "Test BCBA", JSON.stringify(after.amendments));

  // Declining to give a reason must leave the signed record untouched.
  await seed(TWO, true);
  dialogsSeen.length = 0;
  dialogAnswer = { accept: true, text: "" };  // confirm the delete...
  modal = await openEditor();
  await modal.locator("[data-del]").last().click();
  await page.waitForTimeout(300);
  dialogAnswer = { accept: false, text: "" }; // ...then cancel the reason prompt
  await modal.locator("#sup-save").click();
  await page.waitForTimeout(1400);
  after = await page.evaluate(async ({ empId, month }) => {
    const r = await fetch(`/api/supervision/employee/${empId}?month=${month}`, { credentials: "include" });
    return r.json();
  }, { empId, month });
  check("refusing to give a reason saves nothing", after.entries.length === 2, JSON.stringify(after.entries.map((e) => e.activity)));
  check("refusing to give a reason keeps the signature", after.signed_off === true);

  // ============ 3. the server refuses even if the page doesn't ask ============
  const direct = await page.evaluate(async ({ empId, month }) => {
    const r = await fetch("/api/supervision/employee/" + empId, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ month, entries: [], hours_worked: 100 }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { empId, month });
  check("a reasonless change to a signed month is refused server-side", direct.status === 400, JSON.stringify(direct));
  check("the refusal explains itself in English", /signed off/i.test(direct.body.error || ""), direct.body.error);

  check("no uncaught JavaScript errors", errors.length === 0, errors.join(" ;; "));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
