// The Staff Progression widget and the payer section of the staff card, in a
// real browser. The API suite proves the derivation; this proves what the
// Clinical Director actually SEES, and that she sees no way to change it.
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
  else { fail++; failures.push(name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 300) : "")); console.log("  FAIL  " + name); }
};
const section = (t) => console.log("\n== " + t + " ==");
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

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
  const cdEmp = await mk({ name: `Dana Director ${stamp}`, email: "clinical@spectrumsquadlv.com", role_title: "Clinical Director" });
  const bcba = await mk({ name: `Bea BCBA ${stamp}`, role_title: "BCBA" }, { status: "onboarding", hr_hire_date: day(6) });
  const rbt = await mk({ name: `Ray RBT ${stamp}`, role_title: "RBT" }, { status: "active" });
  await o("/api/payer-enrollments", { method: "POST", body: { employee_id: rbt, payer: "Nevada Medicaid", kind: "group_link", status: "effective", effective_date: day(-5) } });
  await o("/api/payer-enrollments", { method: "POST", body: { employee_id: rbt, payer: "SilverSummit", kind: "credentialing", status: "pending", submitted_date: day(-50), notes: "HR-ONLY-" + stamp } });
  await mk({ name: `Sam Student ${stamp}`, role_title: "Student Analyst" }, { status: "onboarding", hr_hire_date: day(30) });

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
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
  const dashboard = async () => {
    await page.goto(BASE + "/#/dashboard");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1800);
  };
  const shot = async (n) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: false }); };

  // ------------------------------------------------------------------
  section("An ordinary BCBA does not get the widget");
  await login("clinical@spectrumsquadlv.com", "TestStaff123!");
  await dashboard();
  check("the BCBA dashboard draws", !!(await page.$(".bd")));
  check("no Staff Progression panel for a non-leader", !(await page.$("#spw-panel")));

  // ------------------------------------------------------------------
  section("The Clinical Director sees it");
  await o(`/api/academy/leadership/${cdEmp}`, { method: "PUT", body: { leadership: "clinical_director" } });
  await dashboard();
  await page.waitForSelector("#spw-panel", { timeout: 8000 }).catch(() => {});
  check("the panel is on her dashboard", !!(await page.$("#spw-panel")));
  const title = await page.$eval("#spw-panel .bd-pt", (e) => e.textContent).catch(() => "");
  check("it is called Incoming Staff Progression", /Incoming Staff Progression/.test(title), title);
  const names = await page.$$eval("[data-spw-row] .spw-name", (e) => e.map((x) => x.textContent));
  check("the incoming BCBA, RBT and student are listed",
    [`Bea BCBA ${stamp}`, `Ray RBT ${stamp}`, `Sam Student ${stamp}`].every((n) => names.includes(n)), names);
  check("the Clinical Director herself is not (she is not incoming)", !names.includes(`Dana Director ${stamp}`));
  const rayRow = `[data-spw-row="emp-${rbt}"]`;
  check("the RBT pending 50 days is highlighted as delayed", await page.$eval(rayRow, (e) => e.classList.contains("delayed")).catch(() => false));
  check("the BCBA starting in 6 days is highlighted as starting soon",
    await page.$eval(`[data-spw-row="emp-${bcba}"]`, (e) => e.classList.contains("soon")).catch(() => false));
  check("every row says Internal or External on its next action",
    await page.$$eval("[data-spw-row] .spw-c-next", (e) => e.every((x) => /Internal|External|Nothing outstanding/.test(x.textContent))));
  await shot("01-widget");

  section("Filters");
  await page.click('[data-spw-role="rbt"]');
  let shown = await page.$$eval("[data-spw-row] .spw-name", (e) => e.map((x) => x.textContent));
  check("RBTs filter shows only the RBT", shown.length >= 1 && shown.every((n) => !/BCBA|Student/.test(n)), shown);
  await page.click('[data-spw-role="student_analyst"]');
  shown = await page.$$eval("[data-spw-row] .spw-name", (e) => e.map((x) => x.textContent));
  check("Student Analysts filter shows only the student", shown.length === 1 && /Student/.test(shown[0]), shown);
  await page.click('[data-spw-role="all"]');
  await page.click('[data-spw-attn="delayed"]');
  shown = await page.$$eval("[data-spw-row] .spw-name", (e) => e.map((x) => x.textContent));
  check("Delayed filter shows the delayed RBT", shown.includes(`Ray RBT ${stamp}`) && !shown.includes(`Sam Student ${stamp}`), shown);
  await page.click('[data-spw-attn="delayed"]');
  await page.click('[data-spw-phase="partial_clearance"]');
  shown = await page.$$eval("[data-spw-row] .spw-name", (e) => e.map((x) => x.textContent));
  check("the Partial payer clearance phase tile filters to that phase", shown.length === 1 && shown[0] === `Ray RBT ${stamp}`, shown);
  await page.click('[data-spw-phase="partial_clearance"]');

  section("Expanding a profile, without leaving the dashboard");
  const before = page.url();
  await page.click(rayRow);
  await page.waitForTimeout(250);
  check("the detail opens inline", !!(await page.$(`[data-spw-detail="emp-${rbt}"]`)));
  check("the URL did not change", page.url() === before);
  const detail = await page.$eval(`[data-spw-detail="emp-${rbt}"]`, (e) => e.textContent).catch(() => "");
  check("payer group linking and credentialing are shown with their status",
    /Nevada Medicaid/.test(detail) && /Group linking/.test(detail) && /SilverSummit/.test(detail) && /Pending with payer/.test(detail), detail.slice(0, 300));
  check("the delay reason is spelled out", /pending 50 days/.test(detail));
  check("HR's payer notes are not on the dashboard", !detail.includes("HR-ONLY-"));
  check("she is offered no way to edit", !(await page.$("[data-spw-edit]")));
  await shot("02-expanded");
  await page.click(rayRow);
  check("and it closes again", !(await page.$(`[data-spw-detail="emp-${rbt}"]`)));

  // Mobile: the grid must stack rather than scroll sideways.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => {
    const p = document.getElementById("spw-panel");
    return p ? p.scrollWidth - p.clientWidth : 0;
  });
  check("no sideways scroll on a phone", overflow <= 2, overflow);
  await page.evaluate(() => document.getElementById("spw-panel").scrollIntoView());
  await shot("03-mobile");
  await page.setViewportSize({ width: 1440, height: 1100 });

  // ------------------------------------------------------------------
  section("The owner's main dashboard is unchanged");
  await login("admin@spectrumsquadlv.com", "TestOwner123!");
  await dashboard();
  check("the main dashboard draws", !!(await page.$(".stat-grid")));
  check("no Staff Progression panel on it for the owner", !(await page.$("#spw-panel")));

  section("HR edits payer enrollment on the staff card");
  await page.goto(BASE + "/#/staff");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.evaluate((id) => openStaffModal(String(id), document.createElement("div")), bcba);
  await page.waitForSelector("#staff-payers .spw-pe-add", { timeout: 8000 }).catch(() => {});
  check("the staff card has the payer enrollment section", !!(await page.$("#staff-payers .spw-pe-add")));
  await page.fill('#staff-payers [data-pe-new="payer"]', "Anthem BCBS");
  await page.selectOption('#staff-payers [data-pe-new="kind"]', "credentialing");
  await page.selectOption('#staff-payers [data-pe-new="status"]', "submitted");
  await page.click("#staff-payers [data-pe-add]");
  await page.waitForTimeout(800);
  const rowsNow = await page.$$eval("#staff-payers [data-pe-row]", (e) => e.map((x) => x.textContent));
  check("the new enrollment appears on the card", rowsNow.some((t) => /Anthem BCBS/.test(t)), rowsNow);
  const sel = '#staff-payers [data-pe-row] [data-pe="status"]';
  await page.selectOption(sel, "approved");
  const approvedDate = await page.$eval('#staff-payers [data-pe-row] [data-pe="approved_date"]', (e) => e.value);
  check("choosing Approved fills today's date VISIBLY for HR to confirm", approvedDate === new Date().toISOString().slice(0, 10), approvedDate);
  await shot("04-staff-card");
  await page.click("#staff-payers [data-pe-save]");
  await page.waitForTimeout(800);
  const wd = await o("/api/staff-progression");
  const bea = wd.data.people.find((p) => p.key === "emp-" + bcba);
  check("the widget reads what HR just saved", bea && bea.payers.some((p) => p.payer === "Anthem BCBS" && p.status === "approved"), bea && bea.payers);

  // ------------------------------------------------------------------
  section("A Clinical Director whose login is not the clinical role");
  // If her account is an administrative one she lands on the main dashboard,
  // not the BCBA one. The widget has to be there for her -- and only her.
  const sched = await mk({ name: `Dee Director ${stamp}`, email: "scheduling@spectrumsquadlv.com", role_title: "Clinical Director" });
  await o(`/api/academy/leadership/${sched}`, { method: "PUT", body: { leadership: "clinical_director" } });
  await login("scheduling@spectrumsquadlv.com", "TestOwner123!");
  await dashboard();
  await page.waitForSelector("#spw-panel", { timeout: 8000 }).catch(() => {});
  check("she gets the widget on the main dashboard", !!(await page.$("#spw-panel")));
  check("it sits in the main dashboard, not the BCBA one", !(await page.$(".bd")) && !!(await page.$(".stat-grid")));
  const w = await page.$eval("#spw-panel", (e) => e.getBoundingClientRect().width).catch(() => 0);
  check("it lays out at full width there", w > 800, w);
  await shot("05-main-dashboard");

  check("no page errors", errors.length === 0, errors);
  await browser.close();
  if (failures.length) console.log("\nFAILURES:\n  " + failures.join("\n  "));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
