// The CRM updates & fixes round, in a real browser.
//
// The API suite (test-crm-updates.js) proves the rules. This one proves the
// screens, because several of these requests are only about what a person
// actually sees:
//
//   * the client's address is on their card, not just in the database
//   * the client card carries no decorative emoji any more, and did not lose
//     a section in the process
//   * the dashboard shows BCBA caseloads and staff turnover, and shows
//     turnover to nobody who should not have it
//   * the First Day of ABA date can be entered at all -- there was no field
//     for it anywhere in the app before this
//   * options that were stacked one per line now sit across the row, and still
//     wrap cleanly on a phone
//   * RBT Supervision no longer opens with the Rethink integration panel
//   * the Squad Leader QR flow: the printed code carries nothing, and the page
//     it opens is a PIN prompt
//
//   node test-crm-updates-ui.js
"use strict";
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3009";

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + JSON.stringify(detail).slice(0, 400) : "")); }
  };
  const section = (t) => console.log("\n== " + t + " ==");

  // External CDNs (Leaflet, Google Fonts) are not reachable from CI, and a
  // blocked stylesheet is not an application error.
  const NETWORK_NOISE = /ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_BLOCKED|Failed to load resource/;

  async function signIn(email, password) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("dialog", async (d) => { await d.accept(); });
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.fill('#login-form input[name="email"]', email);
    await page.fill('#login-form input[name="password"]', password);
    await page.click('#login-form button[type="submit"]');
    await page.waitForTimeout(2500);
    return { page, errors };
  }

  const owner = await signIn("admin@spectrumsquadlv.com", "TestOwner123!");
  const { page } = owner;

  // A client with an address and a BCBA, so the card and the dashboard have
  // something real to show.
  const clientId = await page.evaluate(async () => {
    const mk = await fetch("/api/clients", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        child_name: "UI Address Child", parent_name: "UI Parent",
        parent_email: "ui.address@example.com",
        address: "742 Evergreen Terrace, Las Vegas, NV 89101",
        service_location: "In Home",
      }),
    });
    const c = await mk.json();
    await fetch(`/api/clients/${c.id}/authorization`, {
      method: "PATCH", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assigned_bcba_name: "Dr. UI Caseload" }),
    });
    return c.id;
  });

  // ---------------------------------------------------------------- dashboard
  section("Dashboard: BCBA caseloads and staff turnover");
  // An explicit reload, and it has to be reload() rather than goto(). The
  // dashboard was already rendered at sign-in, before the client above
  // existed; navigating to "/#/dashboard" from "/" is a same-document
  // navigation, so the browser does not reload and -- because the app was
  // already on the dashboard -- no hashchange fires either. The assertion then
  // reads the render from before the client was created, which is how this
  // quietly passed against a database left over from a previous run and failed
  // against a fresh one.
  await page.goto(BASE + "/#/dashboard");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  const dash = await page.textContent("#view-mount");
  check("the BCBA Caseloads section is on the dashboard", /BCBA Caseloads/.test(dash));
  check("a BCBA is listed with their case count", /Dr\. UI Caseload/.test(dash), dash.slice(0, 200));
  check("the count is described as active cases", /active case/i.test(dash));
  check("the Staff Turnover section is on the dashboard", /Staff Turnover/.test(dash));
  check("the turnover window is stated rather than left ambiguous", /last 12 months/i.test(dash));
  check("how the rate is calculated is stated on the card",
    /divided by average headcount/i.test(dash), dash.slice(-400));

  section("Dashboard: the expiry tiles say when a count moved because work got done");
  await page.evaluate(async () => {
    const exp = new Date(Date.now() + 25 * 86400000).toISOString().slice(0, 10);
    const c = await (await fetch("/api/clients", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ child_name: "Tile UI Child", parent_name: "P", parent_email: "tile.ui@example.com" }),
    })).json();
    await fetch(`/api/clients/${c.id}/authorization`, {
      method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorization_status: "Approved", auth_expiration_date: exp, insurance_payer: "Tile Payer" }),
    });
    await fetch("/api/admin/check-auth-expirations", { method: "POST", credentials: "include" });
    const alerts = await (await fetch("/api/auth-alerts", { credentials: "include" })).json();
    for (const a of alerts.filter((x) => x.client_id === c.id)) {
      await fetch(`/api/auth-alerts/${a.id}/status`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "completed" }),
      });
    }
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  const tileCard = await page.textContent("#view-mount");
  check("the Authorization Alerts card is still rendered", /Authorization Alerts/.test(tileCard));
  // A tile that quietly shrinks is indistinguishable from a broken one, so the
  // reason has to be on the card.
  check("a handled authorization is explained rather than silently dropped",
    /no longer counted above/.test(tileCard), tileCard.slice(0, 300));
  check("and the card says it returns at the next milestone",
    /comes? back the moment the next milestone/.test(tileCard));
  check("with a link into the alert history",
    !!(await page.$('a[href="#/auth-alerts/history"]')));

  // -------------------------------------------------------------- client card
  section("Client card: address, no emoji, nothing lost");
  await page.evaluate((id) => openClientModal(id), clientId);
  await page.waitForSelector(".modal-backdrop details.cs", { timeout: 10000 });
  await page.waitForTimeout(900);

  const address = await page.evaluate(() => {
    const f = [...document.querySelectorAll(".modal-backdrop .field")]
      .find((x) => x.querySelector("label") && x.querySelector("label").textContent.trim() === "Address");
    return f ? (f.querySelector("div") || {}).textContent : null;
  });
  check("the client's full address is displayed in Client Information",
    address && address.includes("742 Evergreen Terrace"), address);

  const html = await page.innerHTML(".modal-backdrop");
  const emoji = html.match(/[\u{1F300}-\u{1FAFF}]/gu) || [];
  check("no decorative emoji anywhere on the client card", emoji.length === 0, emoji);
  check("the section headers still have their accent marker",
    (await page.$$(".modal-backdrop .cs-ico")).length > 10);
  check("the sections themselves survived the emoji removal",
    (await page.$$(".modal-backdrop details.cs")).length >= 15);
  const closeBtn = await page.$(".modal-backdrop .close-btn");
  check("functional controls (the close button) are untouched", !!closeBtn);

  section("Client card: the first day of ABA can be entered");
  const fdInput = await page.$(".modal-backdrop #firstday-date");
  check("there is a field for the first day of ABA", !!fdInput);
  const fdText = await page.evaluate(() => {
    const d = [...document.querySelectorAll(".modal-backdrop details.cs")].find((x) => x.dataset.cs === "firstday");
    if (d) d.open = true;
    return d ? d.textContent : "";
  });
  check("it says who the assigned BCBA is", /Assigned BCBA/.test(fdText), fdText.slice(0, 200));
  check("it warns that nothing sends until a BCBA is assigned, or reports the BCBA",
    /BCBA/.test(fdText), fdText.slice(0, 200));

  section("Client card: option groups are laid out across the row");
  const layout = await page.evaluate(() => {
    const g = document.querySelector(".modal-backdrop #doc-request-section .opt-grid");
    if (!g) return null;
    const r = [...g.children].map((c) => c.getBoundingClientRect());
    return {
      count: r.length,
      perRow: r.filter((x) => Math.abs(x.top - r[0].top) < 4).length,
      overflows: g.scrollWidth > g.clientWidth + 2,
    };
  });
  check("the parent document options sit side by side, not stacked",
    layout && layout.perRow > 1, layout);
  check("and nothing overflows the container", layout && !layout.overflows, layout);

  await page.evaluate(() => document.querySelectorAll(".modal-backdrop").forEach((b) => b.remove()));

  section("Option groups still wrap cleanly on a phone");
  const probe = async (w) => {
    await page.setViewportSize({ width: w, height: 900 });
    return page.evaluate(() => {
      const el = document.createElement("div");
      el.className = "opt-grid";
      el.innerHTML = '<label class="opt-card"><input type="checkbox"/><span><strong>An option</strong></span></label>'.repeat(6);
      document.body.appendChild(el);
      const r = [...el.children].map((c) => c.getBoundingClientRect());
      const out = {
        perRow: r.filter((x) => Math.abs(x.top - r[0].top) < 4).length,
        overflows: el.scrollWidth > el.clientWidth + 2,
      };
      el.remove();
      return out;
    });
  };
  const wide = await probe(1400);
  check("on a wide screen several options share a row", wide.perRow > 1, wide);
  check("nothing overflows horizontally on a wide screen", !wide.overflows, wide);
  const narrow = await probe(420);
  check("on a phone they wrap to one per row instead of squashing", narrow.perRow === 1, narrow);
  check("nothing overflows horizontally on a phone", !narrow.overflows, narrow);
  await page.setViewportSize({ width: 1400, height: 1000 });

  // ------------------------------------------------------- RBT supervision
  section("RBT Supervision: the Rethink panel is out of the normal interface");
  const clinical = await signIn("clinical@spectrumsquadlv.com", "TestStaff123!");
  await clinical.page.evaluate(() => { location.hash = "#/supervision"; });
  await clinical.page.waitForTimeout(2800);
  const clinView = await clinical.page.textContent("#view-mount");
  const clinPanel = await clinical.page.evaluate(() => (document.querySelector("#rethink-panel") || {}).innerHTML || "");
  check("a clinical user still reaches RBT Supervision", /RBT Supervision/.test(clinView), clinView.slice(0, 120));
  check("the Rethink Integration section is not rendered for them", clinPanel.trim() === "", clinPanel.slice(0, 200));
  check("no integration plumbing is on their page", !/Rethink integration/i.test(clinView));
  check("the supervision tracker itself is untouched", /worked hours|Supervision/i.test(clinView));

  await page.evaluate(() => { location.hash = "#/supervision"; });
  await page.waitForTimeout(3000);
  const ownerPanel = await page.evaluate(() => (document.querySelector("#rethink-panel") || {}).innerHTML || "");
  check("an owner can still get at the integration status", /Rethink integration/i.test(ownerPanel), ownerPanel.slice(0, 140));
  check("but it is collapsed behind a disclosure, not open at the top",
    await page.evaluate(() => !!document.querySelector("#rethink-panel details")));

  // ------------------------------------------------------ squad leader QR
  section("Squad Leader reporting: the printed QR code");
  await page.evaluate(() => { location.hash = "#/attendance"; });
  await page.waitForTimeout(2500);
  check("the Squad Leaders manager is reachable from Attendance", !!(await page.$("#att-squads-btn")));
  await page.click("#att-squads-btn");
  await page.waitForTimeout(1800);
  const mgr = await page.textContent(".modal-backdrop");
  check("the manager opens", /Squad Leaders/.test(mgr), mgr.slice(0, 140));
  check("there is a printable QR code", /Printable QR code/.test(mgr));
  const encoded = await page.evaluate(() => {
    const i = document.querySelector('.modal-backdrop img[alt="Attendance reporting QR code"]');
    if (!i) return null;
    const q = (i.src.split("data=")[1] || "");
    return decodeURIComponent(q);
  });
  check("the QR encodes the bare reporting address and nothing else",
    !!encoded && /\/squad-report$/.test(encoded), encoded);
  check("the QR carries no employee id, token, name or PIN",
    !!encoded && !/employee|token|pin|[?&]id=/i.test(encoded), encoded);
  await page.evaluate(() => document.querySelectorAll(".modal-backdrop").forEach((b) => b.remove()));

  section("Squad Leader reporting: what scanning it actually opens");
  const scan = await browser.newPage();
  await scan.goto(BASE + "/squad-report", { waitUntil: "networkidle" });
  await scan.waitForTimeout(1200);
  const scanned = await scan.textContent("body");
  check("scanning lands on a PIN prompt", /Your work email/.test(scanned) && /Your PIN/.test(scanned), scanned.slice(0, 200));
  check("it says the page is for Squad Leaders", /Squad Leaders only/i.test(scanned));
  check("no employee name is on the page", !/Tester|Reyes|Okafor|Diaz/.test(scanned));
  check("the PIN is entered in a password field",
    (await scan.$$eval("input", (els) => els.map((e) => e.type))).includes("password"));
  check("no staff list can be pulled without signing in",
    (await scan.evaluate(async () => (await fetch("/api/squad/public/form", { credentials: "same-origin" })).status)) === 401);

  // ------------------------------------------- signing in and reporting
  // test-crm-updates.js proves the API lets a leader report themselves. This
  // proves the thing a leader actually touches: that their own name is in the
  // picker, says it is them, and files when chosen. The form is a string built
  // inside squad-attendance.js, so a mistake in it breaks the page silently
  // rather than failing a route test.
  section("Squad Leader reporting: a leader reporting themselves, in the browser");
  const SQ = Date.now().toString().slice(-6);
  const setup = await page.evaluate(async (sq) => {
    const post = async (p, body) => {
      const r = await fetch(p, {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "same-origin", body: JSON.stringify(body),
      });
      return { status: r.status, data: await r.json().catch(() => ({})) };
    };
    const lead = await post("/api/hr/employees", {
      name: `ZzUi Lead ${sq}`, email: `zzuilead.${sq}@spectrumsquadlv.com`,
      role_title: "RBT - Squad Leader", hire_date: "2024-01-08",
    });
    const mate = await post("/api/hr/employees", {
      name: `ZzUi Mate ${sq}`, email: `zzuimate.${sq}@spectrumsquadlv.com`,
      role_title: "RBT", hire_date: "2024-02-08",
    });
    const leaderId = lead.data.id, mateId = mate.data.id;
    const made = await post("/api/squad/admin/squads", { name: `ZzUi Squad ${sq}`, leader_employee_id: leaderId });
    const squad = (made.data.squads || []).find((x) => x.name === `ZzUi Squad ${sq}`);
    await post("/api/squad/admin/members", { squad_id: squad.id, employee_ids: [mateId] });
    await post("/api/squad/admin/pin", { employee_id: leaderId, pin: "846213" });
    return { leaderId, mateId, squadId: squad.id };
  }, SQ);
  check("a squad and a leader with a PIN can be set up", !!setup.leaderId && !!setup.squadId, setup);

  await scan.fill('input[type="email"], input[name="email"], #sq-email', `zzuilead.${SQ}@spectrumsquadlv.com`);
  await scan.fill('input[type="password"]', "846213");
  await scan.click("button");
  await scan.waitForTimeout(1800);
  const options = await scan.evaluate(() =>
    [].slice.call(document.querySelectorAll("#sq-emp option")).map((o) => o.textContent.trim()));
  check("the leader's own name is in the picker", options.some((o) => o.indexOf(`ZzUi Lead ${SQ}`) === 0), options);
  check("...marked as them", options.some((o) => /\(you\)/.test(o) && o.indexOf(`ZzUi Lead ${SQ}`) === 0), options);
  check("...and first, under the placeholder", (options[1] || "").indexOf(`ZzUi Lead ${SQ}`) === 0, options);
  check("their squad mate is still there too", options.some((o) => o.indexOf(`ZzUi Mate ${SQ}`) === 0), options);

  await scan.selectOption("#sq-emp", String(setup.leaderId));
  await scan.selectOption("#sq-type", "late");
  await scan.fill("#sq-date", "2026-08-22");
  await scan.click("#sq-submit");
  await scan.waitForTimeout(2000);
  const after = await scan.textContent(".card");
  check("submitting their own lateness is accepted", /Report submitted/i.test(after), after.slice(0, 220));
  check("...and the confirmation speaks to them, not about them",
    /for yourself/i.test(after) && /on your staff file/i.test(after), after.slice(0, 220));
  const landed = await page.evaluate(async (id) => {
    const r = await fetch(`/api/attendance/employee/${id}`, { credentials: "same-origin" });
    const d = await r.json().catch(() => ({}));
    return (d.flags || []).some((f) => f.incident_date === "2026-08-22" && f.type_key === "late");
  }, setup.leaderId);
  check("...and it is on their own staff file", landed === true, landed);

  section("Errors");
  const real = [...owner.errors, ...clinical.errors].filter((e) => !NETWORK_NOISE.test(e));
  check("no uncaught JavaScript errors anywhere in this run", real.length === 0, real);

  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("SUITE ERROR:", e);
  process.exit(1);
});
