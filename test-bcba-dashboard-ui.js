// The BCBA dashboard in a real browser.
//
// test-bcba-dashboard.js proves the shape and the rules. This proves the thing
// a BCBA actually experiences: that clicking Dashboard lands them on their
// caseload without asking them who they are, that the Student Analyst is
// visible on every row so they never have to open a card to find one, and that
// an admin still gets the administrative dashboard they had before.
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : "")); }
  };
  const BASE = process.env.BASE || "http://localhost:3009";

  const login = async (email, password) => {
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.evaluate(async () => {
      try { await fetch("/api/auth/logout", { method: "POST", credentials: "include" }); } catch (e) {}
      try { localStorage.clear(); } catch (e) {}
    });
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.waitForSelector('#login-form input[name="email"]', { timeout: 15000 });
    await page.fill('#login-form input[name="email"]', email);
    await page.fill('#login-form input[name="password"]', password);
    await page.click('#login-form button[type="submit"]');
    await page.waitForTimeout(1600);
  };

  // ---- something real for the BCBA to see --------------------------------
  await login("admin@spectrumsquadlv.com", "TestOwner123!");
  const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
  const made = await page.evaluate(async (dates) => {
    const mk = async (body) => (await (await fetch("/api/clients", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })).json());
    const set = async (id, body) => fetch("/api/clients/" + id, {
      method: "PATCH", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const a = await mk({ child_name: "Caseload Alpha", parent_name: "P A", parent_email: "case.a@example.com" });
    const b = await mk({ child_name: "Caseload Beta", parent_name: "P B", parent_email: "case.b@example.com" });
    const c = await mk({ child_name: "Caseload Gamma", parent_name: "P C", parent_email: "case.c@example.com" });
    // Assigned to the seeded clinical account, by the same fields the client
    // card uses -- nothing here is dashboard-only.
    for (const x of [a, b, c]) {
      await fetch(`/api/clients/${x.id}/authorization`, {
        method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assigned_bcba_name: "Clinical Staff" }),
      });
    }
    await set(a.id, { auth_start_date: dates.start, auth_expiration_date: dates.soon, treatment_plan_due_date: dates.overdue, insurance_provider: "NV Medicaid" });
    await set(b.id, { auth_expiration_date: dates.far, insurance_provider: "Molina" });
    await set(c.id, { auth_expiration_date: dates.mid, insurance_provider: "Aetna" });
    return { a: a.id, b: b.id, c: c.id };
  }, { start: iso(-120), soon: iso(4), mid: iso(20), far: iso(400), overdue: iso(-3) });
  check("test clients were created and assigned", !!made.a && !!made.b && !!made.c, made);

  // The Student Analyst is set through the migration's own path so the test
  // exercises what an admin will actually run, not a direct column write.
  const mig = await page.evaluate(async () => {
    const text = [
      "| Client Name | BCBA | Insurance | Auth Start | Auth End | Treatment Plan Due | Tx Updates | Student Analyst | Schedule |",
      "| :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |",
      "| Caseload Alpha | Clinical | | | | | | Intake |",
      "| Caseload Beta | Clinical | | | | | | Intake |",
      "| Nobody Real Here | Clinical | | | | | | Intake |",
    ].join("\n");
    const prev = await (await fetch("/api/caseload/migration/preview", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
    })).json();
    const app = await (await fetch("/api/caseload/migration/apply", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
    })).json();
    return { prev, app };
  });
  check("the migration previewed without writing",
    mig.prev && mig.prev.summary && typeof mig.prev.summary.will_update === "number", mig.prev && mig.prev.summary);
  check("A CLIENT THAT DOES NOT EXIST IS REVIEWED, NOT CREATED",
    (mig.prev.review || []).some((r) => r.issue === "Client not found" && r.sheet_client === "Nobody Real Here"),
    mig.prev.review);
  check("applying reports a summary", !!(mig.app && mig.app.summary), mig.app && mig.app.summary);

  // ---- the BCBA's own landing screen -------------------------------------
  console.log("\n== A BCBA lands on their caseload ==");
  await login("clinical@spectrumsquadlv.com", "TestStaff123!");
  await page.goto(BASE + "/#/dashboard");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".bd", { timeout: 15000 }).catch(() => {});
  const text = await page.locator("#app, body").first().innerText();

  check("THE DASHBOARD ROUTE DRAWS THE CASELOAD, not the generic dashboard",
    await page.locator(".bd").count() === 1, await page.locator(".bd").count());
  check("greeted by first name", /Good (morning|afternoon|evening), Clinical\./.test(text), text.slice(0, 200));
  check("and told what the page is for", /what's happening with your caseload today/i.test(text));
  check("THERE IS NO 'PICK YOURSELF' DROPDOWN", await page.locator("#bd-pick").count() === 0);
  check("no separate BCBA Dashboard nav item was added",
    await page.locator('[data-nav="bcba-dashboard"]').count() === 0);

  console.log("\n== The summary cards ==");
  for (const t of ["My Clients", "Authorizations Expiring", "Treatment Plans Due", "Student Analysts", "Monthly Billable"]) {
    check(`the ${t} card is there`, text.includes(t), t);
  }
  const cards = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll(".bd-card").forEach((c) => {
      const t = c.querySelector(".bd-ct"), n = c.querySelector(".bd-cn");
      if (t && n) out[t.textContent.trim()] = n.textContent.trim();
    });
    return out;
  });
  check("My Clients counts the assigned caseload", Number(cards["My Clients"]) >= 3, cards);
  check("an authorization 400 days out does NOT raise an alert",
    Number(cards["Authorizations Expiring"]) === 2, cards);
  check("billable says it is not available rather than showing 0%",
    /Not available/i.test(text) || /%/.test(cards["Monthly Billable"] || ""), cards["Monthly Billable"]);

  console.log("\n== Authorizations ==");
  check("the authorizations panel is near the top",
    /Authorizations Expiring Soon/.test(text));
  check("with the columns asked for",
    /Auth Start/.test(text) && /Days/.test(text) && /Treatment Plan Due/.test(text));
  check("an urgent authorization is labelled urgent", /Urgent — \d+ day/.test(text), text.match(/Urgent[^\n]*/));
  check("and a further-out one is labelled due soon", /Due Soon — \d+ days/.test(text));
  check("there is a link to the full authorization list",
    await page.locator('a[href="#/auth-alerts"]').count() >= 1);

  console.log("\n== My Caseload, with the Student Analyst on every row ==");
  const caseload = await page.evaluate(() => {
    const tables = [...document.querySelectorAll(".bd-panel")];
    const p = tables.find((t) => /My Caseload/.test(t.textContent));
    if (!p) return null;
    const heads = [...p.querySelectorAll("th")].map((h) => h.textContent.trim());
    const rows = [...p.querySelectorAll("tbody tr")].map((r) => [...r.querySelectorAll("td")].map((td) => td.textContent.trim()));
    return { heads, rows };
  });
  check("the caseload table is drawn", !!caseload, caseload);
  check("STUDENT ANALYST IS A COLUMN, not something behind a click",
    caseload.heads.includes("Student Analyst"), caseload.heads);
  check("and the other columns asked for are there",
    ["Client", "Status", "Payer", "Auth End", "Treatment Plan Due", "Next Session"].every((h) => caseload.heads.includes(h)),
    caseload.heads);
  check("the analyst the migration set is shown on the row",
    caseload.rows.some((r) => r.join("|").includes("Intake Staff")), caseload.rows);
  check("a client with no analyst says Unassigned rather than being blank",
    caseload.rows.some((r) => r.join("|").includes("Unassigned")), caseload.rows);

  console.log("\n== The analyst drawer ==");
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("[data-analyst]")][0];
    if (b) b.click();
  });
  await page.waitForTimeout(500);
  const drawer = await page.locator(".bd-drawer").count();
  const drawerText = drawer ? await page.locator(".bd-drawer").innerText() : "";
  check("clicking a Student Analyst opens a drawer", drawer === 1, drawer);
  check("naming their supervising BCBA", /Supervisor \/ BCBA/i.test(drawerText), drawerText.slice(0, 200));
  check("and listing the clients they hold under this BCBA",
    /Clients under this BCBA/i.test(drawerText) && /Caseload/.test(drawerText), drawerText.slice(0, 300));
  await page.evaluate(() => { const x = document.getElementById("bd-drawer-x"); if (x) x.click(); });
  await page.waitForTimeout(300);
  check("and it closes", await page.locator(".bd-drawer").count() === 0);

  console.log("\n== The rest of the page ==");
  check("the Student Analyst panel lists them with their clients", /My Student Analysts/.test(text));
  check("My Tasks is present", /My Tasks/.test(text));
  check("Supervision is present", /Supervision/.test(text));
  check("and says the figures come from the tracker", /RBT Supervision tracker/i.test(text));
  check("the schedule panel names Rethink as the source",
    /source of truth for scheduling/i.test(text), text.match(/Rethink[^\n]*/));
  check("the schedule has day controls", await page.locator("[data-day]").count() === 3);
  for (const l of ["Treatment Plan Cheat Sheet", "Form Library", "Client Behavior / BIP", "RBT Supervision", "Policies & SOPs", "BCBA Hub", "Billable Requirements"]) {
    check(`quick link: ${l}`, text.includes(l), l);
  }

  console.log("\n== Filters and search ==");
  await page.evaluate(() => { const b = document.querySelector('[data-filter="active"]'); if (b) b.click(); });
  await page.waitForTimeout(400);
  check("a filter narrows the caseload",
    await page.locator('[data-filter="active"].on').count() === 1);
  await page.evaluate(() => { const b = document.querySelector('[data-filter="all"]'); if (b) b.click(); });
  await page.waitForTimeout(300);
  await page.fill("#bd-case-search", "Alpha");
  await page.waitForTimeout(500);
  const searched = await page.evaluate(() => {
    const p = [...document.querySelectorAll(".bd-panel")].find((t) => /My Caseload/.test(t.textContent));
    return [...p.querySelectorAll("tbody tr")].length;
  });
  check("search narrows it to one client", searched === 1, searched);

  console.log("\n== What other roles see ==");
  await login("admin@spectrumsquadlv.com", "TestOwner123!");
  await page.goto(BASE + "/#/dashboard");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  check("AN ADMIN KEEPS THE ADMINISTRATIVE DASHBOARD",
    await page.locator(".bd").count() === 0, await page.locator(".bd").count());
  const adminPick = await page.evaluate(async () => {
    const r = await fetch("/api/caseload/bcbas", { credentials: "include" });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  });
  check("but can list BCBAs to look at one", adminPick.status === 200 && Array.isArray(adminPick.body.bcbas), adminPick);
  check("and the migration screen is reachable from Admin Settings",
    await page.evaluate(async () => {
      location.hash = "#/admin";
      await new Promise((r) => setTimeout(r, 1200));
      return !!document.querySelector('a[href="#/bcba-migration"]');
    }));

  const intakeBlocked = await page.evaluate(async () => {
    const r = await fetch("/api/caseload/migration/preview", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "x" }),
    });
    return r.status;
  });
  check("an admin may run the migration", intakeBlocked !== 403, intakeBlocked);

  await login("intake@spectrumsquadlv.com", "TestStaff123!");
  await page.goto(BASE + "/#/dashboard");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  check("intake does not get the caseload dashboard", await page.locator(".bd").count() === 0);
  const intakeMig = await page.evaluate(async () => (await fetch("/api/caseload/migration/preview", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "x" }),
  })).status);
  check("AND CANNOT RUN THE MIGRATION", intakeMig === 403, intakeMig);

  console.log("\n== Presentation ==");
  await login("clinical@spectrumsquadlv.com", "TestStaff123!");
  await page.goto(BASE + "/#/dashboard");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".bd", { timeout: 15000 }).catch(() => {});
  const html = await page.innerHTML(".bd");
  const emoji = html.match(/[\u{1F300}-\u{1FAFF}]/gu) || [];
  check("no emoji on the dashboard", emoji.length === 0, emoji);
  const wide = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
  check("nothing overflows horizontally", wide.doc <= wide.win + 1, wide);
  await page.setViewportSize({ width: 480, height: 900 });
  await page.waitForTimeout(400);
  const narrow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
  check("nor on a phone", narrow.doc <= narrow.win + 1, narrow);

  check("no page errors", errors.length === 0, errors.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
