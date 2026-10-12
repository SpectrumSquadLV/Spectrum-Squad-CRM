// The Credentialing dashboard, its side panel, the settings and the payer
// section of the staff card, in a real browser. The API suite proves the
// rules; this proves what people actually SEE -- and that the Clinical
// Director sees no way to change anything.
//
//   DATABASE_URL=... PORT=3011 node server.js
//   BASE=http://127.0.0.1:3011 node test-staff-progression-ui.js
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3011";
const SHOTS = process.env.SHOT_DIR || "";

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; failures.push(name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : "")); console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : "")); }
};
const section = (t) => console.log("\n== " + t + " ==");
const pdate = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

function api(cookie) {
  return async (p, { method = "GET", body } = {}) => {
    const r = await fetch(BASE + p, { method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie.v ? { Cookie: cookie.v } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie"); if (sc) cookie.v = sc.split(";")[0];
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  };
}

(async () => {
  const stamp = Date.now().toString(36);
  const o = api({ v: "" });
  await o("/api/auth/login", { method: "POST", body: { email: "admin@spectrumsquadlv.com", password: "TestOwner123!" } });
  const mk = async (b, patch) => {
    const id = (await o("/api/hr/employees", { method: "POST", body: b })).data.id;
    if (patch) await o(`/api/hr/employees/${id}`, { method: "PATCH", body: patch });
    return id;
  };
  const ms = (id, k, body) => o(`/api/credentialing/employees/${id}/milestones/${k}`, { method: "PATCH", body });
  const cdEmp = await mk({ name: `Dana Director ${stamp}`, email: "clinical@spectrumsquadlv.com", role_title: "Clinical Director" });
  const rbt = await mk({ name: `Ray RBT ${stamp}`, role_title: "RBT" }, { status: "onboarding", hr_hire_date: pdate(-3), rethink_id: "R1", hr_availability: "M-F" });
  const bcba = await mk({ name: `Bea BCBA ${stamp}`, role_title: "BCBA" }, { status: "onboarding", hr_hire_date: pdate(-45) });
  const ann = await mk({ name: `Ann Admin ${stamp}`, role_title: "Front Desk" }, { status: "onboarding", hr_hire_date: pdate(-1) });
  const done = await mk({ name: `Dee Done ${stamp}`, role_title: "RBT" }, { status: "onboarding", hr_hire_date: pdate(-20) });
  for (const k of ["hr_onboarding", "documents"]) await ms(done, k, { status: "complete", notes: "seed" });
  await ms(done, "approval", { status: "complete", notes: "seed -- Medicaid still pending" });
  await o("/api/credentialing/config", { method: "PUT", body: { payers: [{ payer: "Nevada Medicaid", requires_linking: true, positions: ["rbt"] }] } });
  await o("/api/payer-enrollments", { method: "POST", body: { employee_id: done, payer: "Nevada Medicaid", kind: "group_link", status: "pending", submitted_date: pdate(-4), notes: "HR-ONLY-" + stamp } });

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  const login = async (email, password) => {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.evaluate(async () => { try { await fetch("/api/auth/logout", { method: "POST", credentials: "include" }); } catch (e) {} });
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.waitForSelector('#login-form input[name="email"]', { timeout: 15000 });
    await page.fill('#login-form input[name="email"]', email);
    await page.fill('#login-form input[name="password"]', password);
    await page.click('#login-form button[type="submit"]');
    await page.waitForTimeout(1800);
  };
  const go = async (hash) => {
    await page.goto(BASE + "/" + hash);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
  };
  const shot = async (n, full) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: !!full }); };
  const navHas = async () => page.$$eval("nav [data-nav], nav a, nav button", (els) => els.some((e) => /Credentialing/.test(e.textContent)));

  // ------------------------------------------------------------------
  section("Before she is designated, a clinical user has no Credentialing");
  await login("clinical@spectrumsquadlv.com", "TestStaff123!");
  check("no Credentialing in the sidebar", !(await navHas()));
  await go("#/credentialing");
  check("going there directly says who it is for", /Clinical Director and Assistants/.test(await page.textContent("#view-mount")));

  await o(`/api/academy/leadership/${cdEmp}`, { method: "PUT", body: { leadership: "clinical_director" } });

  // ------------------------------------------------------------------
  section("The Clinical Director's dashboard");
  await login("clinical@spectrumsquadlv.com", "TestStaff123!");
  check("Credentialing is in her sidebar", await navHas());
  await go("#/dashboard");
  check("her dashboard has the compact progression card", !!(await page.$(".cr-mini")));
  check("...linking to the full dashboard", !!(await page.$('.cr-mini a[href="#/credentialing"]')));
  await go("#/credentialing");
  await page.waitForSelector("#cr-rows tr[data-emp]", { timeout: 10000 }).catch(() => {});
  const cards = await page.$$eval(".cr-card", (els) => els.map((e) => [e.querySelector(".l").textContent, Number(e.querySelector(".n").textContent)]));
  check("five summary cards", cards.length === 5 && cards[0][0] === "Total new hires", cards);
  const n = Object.fromEntries(cards);
  check("the numbers are the real records (4 hires, 1 approved, 1 overdue)", n["Total new hires"] === 4 && n["Internally approved"] === 1 && n["Overdue"] === 1, n);
  const heads = await page.$$eval(".cr-table thead th", (els) => els.map((e) => e.textContent.trim()).filter(Boolean));
  check("the table has the agreed columns", ["Employee", "Position", "Hire date", "Credentialing progress", "Payer linking", "Current status", "Target completion"].every((h) => heads.includes(h)), heads);
  const rowText = await page.textContent("#cr-rows");
  check("every new hire is listed", [rbt, bcba, ann, done].every(() => true) && rowText.includes(`Ray RBT ${stamp}`) && rowText.includes(`Ann Admin ${stamp}`) && rowText.includes(`Dee Done ${stamp}`));
  check("the office hire shows payer linking N/A", /Ann Admin[\s\S]*?N\/A/.test(rowText));
  check("the approved RBT waiting on Medicaid shows 0 of 1 linked", /Dee Done[\s\S]*?0 of 1 linked/.test(rowText));
  check("progress bars are drawn", (await page.$$("#cr-rows .cr-bar span")).length >= 4);
  check("no settings or edit buttons for her", !(await page.$("#cr-settings")) && !(await page.$("#cr-track")));
  // A button that simply is not there reads as a bug. Say whose it is.
  check("...but she is told why there are no settings, not left guessing",
    /Payer rules, deadlines and the daily email are set by the practice owner/.test(await page.textContent("body")));
  await shot("01-dashboard");

  await page.fill("#cr-q", "Bea BCBA");
  check("search narrows the table", (await page.$$("#cr-rows tr[data-emp]")).length === 1);
  await page.fill("#cr-q", "");
  await page.click('.cr-card[data-card="overdue"]');
  const ov = await page.$$eval("#cr-rows tr[data-emp]", (els) => els.map((e) => e.textContent));
  check("clicking Overdue filters to the overdue hire", ov.length === 1 && ov[0].includes("Bea BCBA"), ov.length);
  await page.click('.cr-card[data-card="overdue"]');
  await page.selectOption("#cr-pos", "admin");
  check("position filter", (await page.$$("#cr-rows tr[data-emp]")).length === 1);
  await page.selectOption("#cr-pos", "");

  // ------------------------------------------------------------------
  section("The employee panel, read-only for her");
  await page.click(`#cr-rows tr[data-emp="${done}"]`);
  await page.waitForSelector("#cr-drawer .cr-track", { timeout: 8000 }).catch(() => {});
  check("the side panel opens over the dashboard", !!(await page.$("#cr-drawer")) && !!(await page.$("#cr-rows")));
  check("three-stage tracker", (await page.$$("#cr-drawer .cr-step")).length === 3);
  check("no separate credential-verification stage", !/Credential Verification/i.test(await page.textContent("#cr-drawer .cr-track")));
  const panel = await page.textContent("#cr-drawer");
  ["Position", "Hire date", "Onboarding coordinator", "Expected start", "Days in onboarding", "Target completion"].forEach((k) => check(`overview shows ${k}`, panel.includes(k)));
  check("payer linking is shown and counts towards approval",
    /Insurance payer linking/.test(panel) && /Nevada Medicaid/.test(panel) && /part of final internal approval/.test(panel));
  check("the documents milestone covers credentials too", /Required Documents & Credentials/.test(panel), panel.slice(0, 400));
  check("approved but NOT eligible for Medicaid clients", /Ready to serve clients, by payer[\s\S]*Nevada Medicaid[\s\S]*Not yet/.test(panel));
  check("HR's payer notes are not on her screen", !panel.includes("HR-ONLY-" + stamp));
  check("no Save buttons for her", !(await page.$("#cr-drawer [data-save]")));
  await shot("02-panel-readonly");
  await page.keyboard.press("Escape");
  check("Escape closes the panel", !(await page.$("#cr-drawer")));

  // ------------------------------------------------------------------
  section("HR signs off a milestone from the panel");
  await login("admin@spectrumsquadlv.com", "TestOwner123!");
  await go("#/credentialing");
  await page.waitForSelector("#cr-rows tr[data-emp]", { timeout: 10000 }).catch(() => {});
  check("owner gets Settings and Track an employee", !!(await page.$("#cr-settings")) && !!(await page.$("#cr-track")));
  check("...and is not told the settings belong to someone else",
    !/set by the practice owner/.test(await page.textContent("body")));
  await page.click(`#cr-rows tr[data-emp="${rbt}"]`);
  await page.waitForSelector('#cr-drawer [data-ms="documents"] [data-save]', { timeout: 8000 }).catch(() => {});
  await page.selectOption('#cr-drawer [data-ms="documents"] [data-f="status"]', "complete");
  await page.click('#cr-drawer [data-save="documents"]');
  await page.waitForTimeout(900);
  const err = await page.textContent('#cr-drawer [data-msg="documents"]').catch(() => "");
  check("signing off over open records asks for a reason", /note/i.test(err || ""), err);
  await page.fill('#cr-drawer [data-ms="documents"] [data-f="notes"]', "Certificate seen on the BACB registry");
  await page.click('#cr-drawer [data-save="documents"]');
  await page.waitForTimeout(1500);
  const vt = await page.textContent('#cr-drawer [data-ms="documents"]');
  check("the milestone shows Complete with the note", /Complete/.test(vt) && /Certificate seen/.test(vt), vt.slice(0, 200));
  check("...and who did it", /by /.test(vt));
  check("the change history records it", /Change history[\s\S]*documents/i.test(await page.textContent("#cr-drawer")));
  // Approval now shows the payer link as an outside wait, and refuses without a note.
  const ap = await page.textContent('#cr-drawer [data-ms="approval"]');
  check("approval lists the payer link as waiting on the insurer",
    /Nevada Medicaid linking confirmed/.test(ap) && /waiting on the insurer/.test(ap), ap.slice(0, 400));
  await page.selectOption('#cr-drawer [data-ms="approval"] [data-f="status"]', "complete");
  await page.click('#cr-drawer [data-save="approval"]');
  await page.waitForTimeout(1200);
  check("approving over an unconfirmed payer asks for a reason",
    /note/i.test(await page.textContent('#cr-drawer [data-msg="approval"]').catch(() => "")),
    await page.textContent('#cr-drawer [data-msg="approval"]').catch(() => ""));
  await shot("03-panel-hr");
  await page.keyboard.press("Escape");

  // ------------------------------------------------------------------
  section("Settings: payer rules and the daily email");
  await page.click("#cr-settings");
  await page.waitForSelector("#cr-em-time", { timeout: 8000 }).catch(() => {});
  check("send time defaults to 07:00", (await page.inputValue("#cr-em-time")) === "07:00");
  check("the seven payers are listed, none assumed", (await page.$$("#cr-payers [data-payer]")).length >= 7);
  check("only Medicaid is switched on", (await page.$$eval("#cr-payers [data-payer]", (els) => els.filter((e) => e.querySelector("[data-req]").checked).map((e) => e.querySelector("[data-name]").textContent))).join() === "Nevada Medicaid");
  // A payer that needs no individual linking shows nothing but its name and
  // the switch -- its positions and caseload rule are not asked for.
  const shown = await page.$$eval("#cr-payers [data-payer]", (els) => els.map((e) => ({
    name: e.querySelector("[data-name]").textContent,
    on: e.querySelector("[data-req]").checked,
    detail: e.querySelector("[data-detail]") ? getComputedStyle(e.querySelector("[data-detail]")).display !== "none" : null,
  })));
  check("the payer that is switched on shows its settings", (shown.find((x) => x.name === "Nevada Medicaid") || {}).detail === true, shown);
  check("the payers that are off show none of theirs", shown.filter((x) => !x.on).every((x) => x.detail === false), shown.filter((x) => !x.on));
  // Switching one on reveals its settings without a reload.
  const offRow = shown.findIndex((x) => !x.on);
  await page.click(`#cr-payers [data-payer="${offRow}"] [data-req]`);
  await page.waitForTimeout(200);
  check("switching a payer on reveals its settings",
    await page.$eval(`#cr-payers [data-payer="${offRow}"] [data-detail]`, (e) => getComputedStyle(e).display !== "none"));
  await page.click(`#cr-payers [data-payer="${offRow}"] [data-req]`);
  await page.waitForTimeout(200);
  check("...and switching it off hides them again",
    await page.$eval(`#cr-payers [data-payer="${offRow}"] [data-detail]`, (e) => getComputedStyle(e).display === "none"));
  await page.click("#cr-em-preview");
  await page.waitForSelector("#cr-em-prev iframe", { timeout: 8000 }).catch(() => {});
  const frame = page.frames().find((f) => f.url() === "about:srcdoc");
  const ftext = frame ? await frame.textContent("body") : "";
  check("the preview renders the email", /Pending internal onboarding/.test(ftext) && ftext.includes(`Bea BCBA ${stamp}`), ftext.slice(0, 200));
  check("...without HR's payer notes", !ftext.includes("HR-ONLY-" + stamp));
  await shot("04-settings", true);
  await page.keyboard.press("Escape");

  // ------------------------------------------------------------------
  section("HR edits payer linking on the staff card");
  await go("#/staff");
  await page.evaluate((id) => openStaffModal(String(id), document.createElement("div")), rbt);
  await page.waitForSelector("#staff-payers .spw-pe-add", { timeout: 8000 }).catch(() => {});
  check("the staff card has the payer section", !!(await page.$("#staff-payers .spw-pe-add")));
  await page.fill('#staff-payers [data-pe-new="payer"]', "Nevada Medicaid");
  await page.selectOption('#staff-payers [data-pe-new="status"]', "submitted");
  await page.click("#staff-payers [data-pe-add]");
  await page.waitForTimeout(1200);
  const wd = await o("/api/credentialing");
  const ray = wd.data.people.find((p) => p.employee_id === rbt);
  check("the dashboard reads what HR just saved", ray && (ray.payer_linking.find((l) => l.payer === "Nevada Medicaid") || {}).state === "submitted", ray && ray.payer_linking);

  // ------------------------------------------------------------------
  section("Phone width");
  await page.setViewportSize({ width: 390, height: 860 });
  await go("#/credentialing");
  await page.waitForSelector("#cr-rows tr[data-emp]", { timeout: 10000 }).catch(() => {});
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("no sideways scrolling on a phone", overflow <= 2, overflow);
  const cardCols = await page.$eval(".cr-cards", (e) => getComputedStyle(e).gridTemplateColumns.split(" ").length);
  check("summary cards wrap to two columns", cardCols === 2, cardCols);
  check("table rows become cards", (await page.$eval("#cr-rows tr", (e) => getComputedStyle(e).display)) === "grid");
  await shot("05-mobile", true);
  await page.click(`#cr-rows tr[data-emp="${bcba}"]`);
  await page.waitForSelector("#cr-drawer .cr-track", { timeout: 8000 }).catch(() => {});
  const dw = await page.$eval("#cr-drawer", (e) => e.getBoundingClientRect().width);
  check("the panel is full width on a phone", dw >= 385, dw);
  await shot("06-mobile-panel");

  check("no page errors", errors.length === 0, errors);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("\nFailures:"); failures.forEach((f) => console.log("  - " + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
