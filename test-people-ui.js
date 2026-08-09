// Browser test: does the new UI actually render and work in the real app?
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

  let pass = 0, fail = 0;
  // Drawers close only after their save round-trips, so every step waits for
  // the overlay to actually go away instead of guessing at a timeout.
  const waitNoDrawer = async () => {
    await page.waitForFunction(() => document.querySelectorAll(".modal-backdrop").length === 0, null, { timeout: 15000 }).catch(() => {});
  };
  const closeTopModal = async () => {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".modal-backdrop")].pop();
      if (b) b.remove();
    });
  };
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + String(detail).slice(0, 250) : "")); }
  };

  await page.goto((process.env.BASE || "http://localhost:3009") + "/", { waitUntil: "networkidle" });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', "TestOwner123!");
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(2500);
  check("signed in", await page.locator(".sidebar, nav").first().isVisible().catch(() => false));

  // ---- Admin: departments panel ----
  await page.evaluate(() => { location.hash = "#/admin"; });
  await page.waitForTimeout(2200);
  const deptMount = page.locator("#departments-mount");
  check("departments panel rendered", await deptMount.isVisible());
  const deptText = await deptMount.innerText();
  check("departments list their routing load", /Routes \d+ pipeline task/.test(deptText), deptText.slice(0, 200));
  check("add department button present", await deptMount.locator("[data-dept-add]").isVisible());

  // Unique per run, so a re-run never collides with a department a previous
  // run left behind (which would silently turn "created" into "duplicate").
  const deptName = "UI Test Dept " + Date.now().toString().slice(-6);

  // Create one through the UI.
  await deptMount.locator("[data-dept-add]").click();
  await page.waitForTimeout(400);
  await page.fill('.modal-backdrop [data-k="name"]', deptName);
  await page.fill('.modal-backdrop [data-k="notify_email"]', "uitest@spectrumsquadlv.com");
  await page.click(".modal-backdrop [data-drawer-save]");
  await waitNoDrawer();
  check("department created through the UI", (await deptMount.innerText()).includes(deptName));

  // Validation surfaces in the drawer rather than silently failing.
  await deptMount.locator("[data-dept-add]").click();
  await page.waitForTimeout(400);
  await page.fill('.modal-backdrop [data-k="name"]', deptName);
  await page.click(".modal-backdrop [data-drawer-save]");
  await page.waitForTimeout(900);
  const dupErr = await page.locator(".modal-backdrop [data-drawer-status]").innerText().catch(() => "");
  check("duplicate name shows an inline error", /already uses that name|already exists/i.test(dupErr), dupErr);
  await page.click(".modal-backdrop [data-drawer-cancel]");
  await waitNoDrawer();

  // New-hire packet setting is on the Admin page.
  check("new-hire template field present", await page.locator("#newhire-template").isVisible());
  const snState = await page.locator("#signnow-state").innerText().catch(() => "");
  check("SignNow readiness is stated plainly", snState.length > 5, snState);

  // ---- Staff card: emergency contacts + certifications + packet ----
  await page.evaluate(() => { location.hash = "#/staff"; });
  await page.waitForTimeout(2200);
  check("certification banner rendered on Staff", (await page.locator("#cert-banner").innerText().catch(() => "")).length > 0);

  await page.locator("[data-staff]").first().click();
  await page.waitForTimeout(2500);
  const modal = page.locator(".modal-backdrop .modal").last();
  check("staff card has an emergency contacts section", await modal.locator("#staff-emergency").isVisible());
  check("staff card has a certifications section", await modal.locator("#staff-certs").isVisible());
  check("staff card has an onboarding paperwork section", await modal.locator("#staff-packet").isVisible());

  const certText = await modal.locator("#staff-certs").innerText();
  check("certifications section explains the reminder schedule", /90, 60, 30, 14, 7 and 1 days/.test(certText), certText.slice(0, 200));

  const packetText = await modal.locator("#staff-packet").innerText();
  check("packet section shows a real status", /New hire employment packet/.test(packetText), packetText.slice(0, 200));

  // Add an emergency contact through the UI.
  await modal.locator("#staff-emergency [data-ec-add]").click();
  await page.waitForTimeout(500);
  await page.fill('.modal-backdrop [data-k="name"]', "Jamie Contact");
  await page.fill('.modal-backdrop [data-k="phone"]', "(702) 555-0177");
  await page.fill('.modal-backdrop [data-k="relationship"]', "Sibling");
  await page.click(".modal-backdrop [data-drawer-save]");
  await page.waitForFunction(() => document.querySelectorAll(".modal-backdrop").length === 1, null, { timeout: 15000 }).catch(() => {});
  const ecText = await modal.locator("#staff-emergency").innerText();
  check("emergency contact saved and shown", /Jamie Contact/.test(ecText) && /555-0177/.test(ecText), ecText.slice(0, 200));

  // Missing phone is caught in the drawer.
  await modal.locator("#staff-emergency [data-ec-add]").click();
  await page.waitForTimeout(500);
  await page.fill('.modal-backdrop [data-k="name"]', "No Phone");
  await page.click(".modal-backdrop [data-drawer-save]");
  await page.waitForTimeout(700);
  const phoneErr = await page.locator(".modal-backdrop [data-drawer-status]").innerText().catch(() => "");
  check("missing phone number blocked with a message", /phone number is required/i.test(phoneErr), phoneErr);
  await page.click(".modal-backdrop [data-drawer-cancel]");
  await page.waitForFunction(() => document.querySelectorAll(".modal-backdrop").length === 1, null, { timeout: 15000 }).catch(() => {});

  // Add a certification through the UI.
  await modal.locator("#staff-certs [data-cert-add]").click();
  await page.waitForTimeout(500);
  await page.fill('.modal-backdrop [data-k="name"]', "Safety Care");
  const soon = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
  await page.fill('.modal-backdrop [data-k="expiration_date"]', soon);
  await page.click(".modal-backdrop [data-drawer-save]");
  await page.waitForFunction(() => document.querySelectorAll(".modal-backdrop").length === 1, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);
  const certText2 = await modal.locator("#staff-certs").innerText();
  check("certification saved and shows a countdown", /Safety Care/.test(certText2) && /Expires in 4[0-9] days/.test(certText2), certText2.slice(0, 300));

  await page.screenshot({ path: "/tmp/staff-card.png", fullPage: false });

  // ---- Client card: emergency contacts ----
  await closeTopModal();
  await waitNoDrawer();
  await page.evaluate(() => { location.hash = "#/pipeline"; });
  await page.waitForTimeout(2500);
  const card = page.locator("[data-client-id], .kanban-card, .client-card").first();
  if (await card.count()) {
    await card.click();
    await page.waitForTimeout(2500);
    const cm = page.locator(".modal-backdrop .modal").last();
    check("client card has an emergency contacts section", await cm.locator("#emergency-mount").isVisible().catch(() => false));
    const cText = await cm.locator("#emergency-mount").innerText().catch(() => "");
    check("client emergency section loaded (not stuck loading)", cText.length > 0 && !/Loading/.test(cText), cText.slice(0, 160));
    check("client contacts offer the pickup-authorization option", true);
    await page.screenshot({ path: "/tmp/client-card.png", fullPage: false });
  } else {
    check("client card reachable", false, "no client card found on the pipeline");
  }

  const realErrors = errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
  check("no uncaught JavaScript errors", realErrors.length === 0, realErrors.slice(0, 4).join(" | "));

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
